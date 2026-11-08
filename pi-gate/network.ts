/**
 * The `network` surface: which host a tool call can reach (plan step B, the egress question).
 *
 * This is its own module because it is its own *question*. `match.ts` answers "is this string the
 * command or path a rule named", and a host is neither: `https://oss.aliyuncs.com/x` is one argv token
 * that is not a path at all, and a rule about a domain is not a glob about a spelling — a human who
 * writes `aliyuncs.com` means that domain and everything under it, and would be surprised to find the
 * same text also matching `evilaliyuncs.com`. Pure functions, no I/O, no config reading: the facts come
 * from {@link networkTargets}, the verdict from `policy.ts`.
 */

import { wildcardMatch } from "./pattern/glob.ts";
import { tokenize } from "./pattern/shell-segmentation.ts";
import { pushUnique } from "./ordered-unique.ts";

/**
 * The surface name the egress facts are written on. Spelled here, in the module that produces those
 * facts, so `inspect.ts` (which emits them), `policy.ts` (which rules on them) and a config file (which
 * names them) cannot drift into three different words for one question.
 */
export const NETWORK_SURFACE = "network";

/**
 * `scheme://` — the portable test for "this token names a remote thing".
 *
 * Syntactic rather than `new URL()` for the *shape* test, because a URL parser fixes the scheme list it
 * cares about and the gate must treat an `s3://` bucket exactly like an `https://` one.
 */
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** scp / rsync-style remote: `[user@]host:path`. The userinfo colon is excluded so a URL is never read as one. */
const SCP_TARGET_RE = /^(?:[^/@:]+(?::[^@/]*)?)@(?<host>[A-Za-z0-9._~\-]+|\[[0-9A-Fa-f:.]+\]):(?<tail>[^\s]*)$/;

/** `host` or `host:port` (IPv6 bracketed), with any userinfo stripped off the front. */
const AUTHORITY_RE = /^(?:[^@/]*@)?(?<host>[A-Za-z0-9._~\-]+|\[[0-9A-Fa-f:.]+\])(?::(?<port>\d{1,5}))?(?:[/\\]|$)/;

/**
 * A bare `host[:port]` argv token — the form a connection string, a Redis argument or a path-style
 * metadata URL (`169.254.169.254/latest/meta-data/`) actually takes. The trailing `/` is what keeps
 * `1e10`, `data.csv`, `v1.2.3` and `2>/dev/null` from being read as hosts: a **path** is the evidence
 * this form needs: a bare `word.word` is indistinguishable from a version or a file name, while a `/`
 * anywhere in the token is a URL path and nothing else. (`host:port` with no path is deliberately not
 * read as a host — `nc host 4444` spells the port as a separate token, and `1.2.3` is a version far more
 * often than a host. The `scheme://host:port` and scp forms are both still read, so nothing real is lost.)
 */
const HOST_PORT_ARG_RE = /^(?:[^@/\s]*@)?(?<host>[A-Za-z0-9._~\-]+|\[[0-9A-Fa-f:.]+\])(?::(?<port>\d{1,5}))?(?=[/\\])/;

/**
 * A dotted host, as opposed to a dotted *file name*.
 *
 * This is the judgement the whole surface turns on: `169.254.169.254/x` is egress and `data.csv` is not,
 * and no amount of pattern cleverness separates them — only knowing what a top-level label looks like
 * does. Unknown-suffix hosts are still reported (a private DNS name with a novel TLD is a real host, and
 * under-reporting is unguarded egress); a known document suffix is not.
 */
const FILE_SUFFIXES: readonly string[] = [
	"zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar",
	"txt", "md", "rst", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "toml", "ini", "cfg", "conf",
	"html", "htm", "css", "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "sh", "bash", "ps1",
	"c", "h", "cpp", "cc", "cs", "php", "pl", "lua", "sql", "lock", "sum", "am",
	"png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"so", "a", "o", "dll", "exe", "msi", "deb", "rpm", "whl", "jar", "class", "wasm", "bin", "dat", "bak", "tmp",
	// Words that appear as the suffix of a *module path* (`http.server`, `xml.etree`, `os.path`) far more
	// often than as a domain suffix, and that no registry hands out.
	"http", "https", "ftp", "file", "server", "client", "debug", "info", "path", "core", "main", "util",
	// Reserved by RFC 6761/6762 or by the registries themselves: nothing resolves under them, so a token
	// ending in one is a placeholder or a local name, never an internet host. `internal.corp` and
	// `foo.internal` are still reported — real private names, and under-reporting is unguarded egress.
	"invalid", "local", "localhost", "test", "onion", "i2p", "example",
];

/** A single label that is a protocol word, not a machine: `HEAD`, `GET`, `PUT`. */
const NON_HOST_LABELS: ReadonlySet<string> = new Set(["head", "get", "put", "post", "delete", "options", "patch", "trace", "connect"]);

/** An IPv6 literal — the one host with no dot in it, and the only thing allowed to carry a colon here. */
const IPV6_LITERALS = /^[0-9A-Fa-f:.]+$/;

/**
 * A dotted host, as opposed to a dotted *file name*.
 *
 * This is the judgement the whole surface turns on: `169.254.169.254/x` is egress and `data.csv` is not,
 * and no amount of pattern cleverness separates them — only knowing what a top-level label looks like
 * does. An unknown suffix is still reported (a private DNS name with a novel TLD is a real host, and
 * under-reporting is unguarded egress); a known document or module suffix is not.
 *
 */
function looksLikeDottedHost(host: string): boolean {
	const labels = host.split(".");
	if (labels.length < 2 || labels.some((label) => !label)) return false;
	const tld = labels[labels.length - 1]!;
	// An all-numeric last label is an IP literal (`169.254.169.254`), which is a host by any definition.
	if (/^\d+$/.test(tld)) return true;
	if (FILE_SUFFIXES.includes(tld)) return false;
	return /^[a-z][a-z0-9-]{0,62}$/.test(tld) && !NON_HOST_LABELS.has(tld);
}

/**
 * Characters a hostname or IP literal can contain (IDN hosts arrive already punycoded).
 *
 * A colon is allowed only in a bracketed IPv6 literal, which {@link hostOf} has already stripped — the
 * bare `scheme://` form never reaches here, so `http.server` cannot sneak through as "a host with a port".
 */
const HOST_CHARS_RE = /^[A-Za-z0-9._~:\-\u0080-\uFFFF]+$/;

export interface NetworkTarget {
	/** Lowercased, port stripped, IPv6 brackets stripped, userinfo stripped. */
	host: string;
	port?: number;
	/** Lowercased scheme without the colon (`https`), when the token carried one. */
	scheme?: string;
	/** The token exactly as the call spelled it. */
	raw: string;
}

/** True for `scheme://…` tokens — `https://`, `http://`, `ftp://`, `s3://`, `ws://`, `wss://` and friends. */
export function looksLikeUrl(token: string): boolean {
	return URL_SCHEME_RE.test(token);
}

/**
 * The host a token names, or `undefined` when it names none.
 *
 * Tolerant of userinfo, ports and IPv6 brackets on purpose: the human writes these tokens, and a rule is
 * only worth having if `https://user:pw@Host.Example.com:8443/x` cannot be spelled past it. Everything
 * the matcher does not need is stripped, so both sides of a rule meet on one canonical spelling.
 */
export function parseNetworkTarget(token: string): NetworkTarget | undefined {
	const raw = token.trim();
	if (!raw || raw.startsWith("-")) return undefined;

	// `//host/path` is the protocol-relative form npm and pip write; `URL` cannot parse it, and the
	// scheme-less branch below would read `//cdn.example.com` as an empty host, so it is handled first.
	if (raw.startsWith("//")) return fromAuthority(raw.slice(2), raw);

	if (looksLikeUrl(raw)) {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			// A URL the platform parser rejects is still a host the shell will resolve — `http://[100.100.100.200]/`
			// is the example that matters, because that is the metadata address in the one spelling WHATWG
			// refuses, and a gate that cannot read it is a gate that lets `curl` read it. Fall back to reading
			// the authority by hand rather than reporting nothing.
			const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/)[0] ?? "";
			return fromAuthority(authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority, raw);
		}
		// `file:` is a local path wearing a scheme; `mailto:` and `data:` name no host at all.
		if (!parsed.hostname) return undefined;
		const scheme = parsed.protocol.slice(0, -1).toLowerCase();
		const host = hostOf(parsed.hostname);
		if (!host) return undefined;
		const port = parsed.port ? Number(parsed.port) : undefined;
		return { host, ...(port !== undefined && Number.isFinite(port) ? { port } : {}), ...(scheme ? { scheme } : {}), raw };
	}

	const scp = SCP_TARGET_RE.exec(raw)?.groups;
	if (scp) {
		// `bob@example.com:/tmp/a.txt` is a file *on another machine*: the host is the fact, the path is not ours.
		const host = hostOf(scp.host ?? "");
		return host ? { host, raw } : undefined;
	}
	// The bare `host[:port][/path]` form (`--server host:1234`, `169.254.169.254/latest/meta-data/`, a Redis
	// string). A port or a path is network evidence, so the reserved-name rule is relaxed for it.
	const hostPort = HOST_PORT_ARG_RE.exec(raw);
	// The userinfo the regex skipped must not contain a colon of its own: in `mailto:a@b.com` the first
	// colon is the *scheme* separator, so the token names no host and the match is refused.
	const userinfo = hostPort ? raw.slice(0, hostPort.index + (hostPort[0].includes("@") ? hostPort[0].lastIndexOf("@") + 1 : 0)) : "";
	if (hostPort?.groups && !userinfo.includes(":")) {
		const host = hostOf(hostPort.groups.host ?? "");
		if (!host) return undefined;
		const port = hostPort.groups.port ? Number(hostPort.groups.port) : undefined;
		return { host, ...(port !== undefined && Number.isFinite(port) ? { port } : {}), raw };
	}
	return undefined;
}

/** Parse a scheme-less `host[:port][/…]` (the protocol-relative form). */
function fromAuthority(text: string, raw: string): NetworkTarget | undefined {
	const match = AUTHORITY_RE.exec(text);
	const groups = match?.groups;
	if (!groups) return undefined;
	const host = hostOf(groups.host ?? "");
	if (!host) return undefined;
	const port = groups.port ? Number(groups.port) : undefined;
	return { host, ...(port !== undefined && Number.isFinite(port) ? { port } : {}), raw };
}

/** A token that reads as an IPv4 literal in some shell-legal spelling. */
const IPISH_RE = /^(?:0[xX]?[0-9A-Fa-f]+|\d+)(?:\.(?:0[xX]?[0-9A-Fa-f]+|\d+)){0,3}$/;

function hostOf(value: string): string | undefined {
	const host = stripBrackets(value).trim().toLowerCase().replace(/\.$/, "");
	// A "host" holding a slash or a backslash is a filesystem path, not a machine: turning `/tmp/x` into
	// an egress fact would be the mirror image of the URL-as-path bug this step removes (`D`).
	if (!host || host.includes("/") || host.includes("\\") || /^[A-Za-z]:/.test(host)) return undefined;
	if (!HOST_CHARS_RE.test(host)) return undefined;
	// The one host without a dot is a bracketed IPv6 literal (`[fd00:ec2::254]`), already unwrapped; a colon
	// in anything else means the token was `scheme:rest`, i.e. not a host at all (`mailto:a@b.com`).
	if (host.includes(":")) return IPV6_LITERALS.test(host) ? host : undefined;
	// An address is an address in whatever spelling the shell took: canonicalised to the dotted quad the
	// rules are written against, so `0x64646464` cannot spell past a rule about `100.100.100.200`. A token
	// that looks numeric but is not a valid address (`1.2.3.4.5`, `999.1.1.1`) names no host at all.
	if (IPISH_RE.test(host)) return canonicalIpv4(host);
	// `metadata`, `instanceData` — the short names a cloud metadata service answers — are hosts with no dot,
	// and they are on {@link METADATA_ENDPOINTS} precisely because a human cannot be expected to write the IP.
	if (!host.includes(".") && METADATA_ENDPOINTS.some((endpoint) => endpoint.toLowerCase() === host)) return host;
	// `HEAD`, `make`, `v1` are arguments — a host has a dot, and the dot has to be a domain suffix.
	return looksLikeDottedHost(host) ? host : undefined;
}

function stripBrackets(value: string): string {
	return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

/**
 * Loopback is not egress.
 *
 * A call to `localhost` cannot leave the machine, so prompting for it would interrupt the dev server, the
 * local test database and the session's own MCP servers — noise that trains a human to click through an
 * egress prompt, which costs more safety than it buys. It is not a trust decision either: a local
 * listener can forward anywhere, and the process doing that forwarding is itself gated.
 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

export function isLoopbackHost(host: string): boolean {
	const clean = stripBrackets(host.trim().toLowerCase()).replace(/\.$/, "");
	if (LOOPBACK_HOSTS.includes(clean)) return true;
	// The whole of 127/8 is loopback, not only .1, and v4-mapped v6 says the same thing.
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean) || clean.startsWith("::ffff:127.");
}

/**
 * The cloud metadata services: endpoints whose *answer* is credentials, reachable only from the machine
 * itself, and the most-stolen address in agent history.
 *
 * Listed as data so a config file can name them and a test can pin them. The URL path is irrelevant —
 * EC2's `latest/meta-data` and Alibaba's look like any other download — so the host is the only thing a
 * rule can match, which is the whole reason this surface exists.
 */
export const METADATA_ENDPOINTS: readonly string[] = [
	"169.254.169.254", // AWS / GCP / Azure / OpenStack IMDS (link-local)
	"100.100.100.200", // Alibaba Cloud metadata — their link-local address is not 169.254
	"fd00:ec2::254", // AWS IMDSv2 over IPv6
	"metadata", // GCP short name
	"metadata.google.internal",
	"metadata.goog",
	"instanceData", // Windows IMDS host name (EC2 and Alibaba both answer it)
];

export function isMetadataEndpoint(host: string): boolean {
	const clean = stripBrackets(host.trim().toLowerCase()).replace(/\.$/, "");
	return METADATA_ENDPOINTS.some((endpoint) => clean === endpoint.toLowerCase() || clean.endsWith(`.${endpoint.toLowerCase()}`));
}

/**
 * The host facts of one shell segment: every argv token that names a remote machine.
 *
 * Tokenised rather than regex-scanned, so a URL inside quotes is still found: the gate cannot tell a URL
 * a command *fetches* from one it merely prints, and over-reporting costs a prompt while under-reporting
 * is unguarded egress. Options are skipped (`--url` is not a host) except in their `--opt=value` form,
 * loopback is skipped (see {@link LOOPBACK_HOSTS}), and a host that is really a path is skipped.
 */
export function networkTargets(seg: string, cwd: string): string[] {
	// `cwd` is part of the contract every extractor shares; a host never depends on it, and keeping the
	// parameter makes the call site read like the path extractors instead of like a special case.
	void cwd;
	const out: string[] = [];
	const add = (token: string): void => {
		const target = parseNetworkTarget(token);
		if (!target || isLoopbackHost(target.host)) return;
		pushUnique(out, target.host);
	};
	for (const token of tokenize(seg)) {
		if (token === "--") continue;
		// A *file* redirect target is a write, not an egress fact — and `>https://x` is not how a human
		// sends data out, so it stays out of this surface rather than being argued about here.
		if (/^\d*&?[<>]{1,2}/.test(token) || token === "|") continue;
		// `--url=https://x` carries the host inside the option; a bare `-x` does not.
		if (token.startsWith("-")) {
			const eq = token.indexOf("=");
			if (eq > 0) add(token.slice(eq + 1));
			continue;
		}
		add(token);
	}
	// The belt: every host the raw text names, whether or not the tokeniser kept it in one piece.
	for (const host of rawHostLiterals(seg)) {
		// Already an authority, so it goes through `hostOf` (via a host-only token) rather than
		// {@link parseNetworkTarget}, which demands the path or port evidence a bare host does not carry.
		const target = parseNetworkTarget(`http://${host}`);
		if (!target || isLoopbackHost(target.host)) continue;
		pushUnique(out, target.host);
	}
	return out;
}

/**
 * Hosts named anywhere in the raw segment text, found without tokenising.
 *
 * The tokeniser is the right tool for argv and the wrong tool for a URL, because a shell command
 * routinely carries a URL inside a quoted code string — `python3 -c "…urlopen('http://100.100.100.200/…')"`
 * — where quote-stripping and whitespace-splitting leave the URL in pieces and the host never appears as
 * one token. That is not an exotic spelling; it is how an agent fetches a URL when the CLI is not enough.
 * Over-reporting here costs a prompt on a call the human can read; missing it costs the whole surface, so
 * the scan is deliberately greedy: scheme-prefixed authorities, protocol-relative authorities, and every
 * IP-shaped token including the obfuscated spellings.
 */
const RAW_URL_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^\s"'`)\]},;<>|]+)/g;
const RAW_IP_RE = /\b(?:0[xX][0-9A-Fa-f]+|0\d+|\d{1,3})(?:\.(?:0[xX][0-9A-Fa-f]+|0\d+|\d{1,3})){0,3}\b/g;

function rawHostLiterals(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(RAW_URL_RE)) {
		const authority = (match[1] ?? "").split(/[/?#]/)[0] ?? "";
		const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
		if (host) found.push(host);
	}
	for (const match of text.matchAll(RAW_IP_RE)) {
		// Only a *complete* dotted quad (or its obfuscated equivalents) is an IP; `1.2` and `v1.2.3.4` are
		// version numbers, and a version is a far more common argv token than a short-form address.
		if ((match[0].match(/\./g) ?? []).length < 3 && !/^0[xX]/.test(match[0])) continue;
		const dotted = canonicalIpv4(match[0]);
		if (dotted) found.push(dotted);
	}
	return found;
}

/**
 * The dotted-quad an IPv4 literal really means.
 *
 * `http://0x64646464/` is `100.100.100.100`, and `curl` accepts it; a rule about the dotted form would
 * otherwise be spelled past by the hex form, the octal form (`0144.0144.0144.0144`) or the short forms
 * (`100.200` is `100.0.0.200`). Node's URL parser is *not* trusted here — it hands back a truncated host
 * for some of these shapes, which is worse than no host at all, because a wrong fact matches a rule about
 * a machine nobody contacted. Returns `undefined` for anything that is not an address.
 */
export function canonicalIpv4(value: string): string | undefined {
	const parts = value.trim().split(".");
	if (parts.length === 1) {
		const single = numberPart(parts[0]!);
		if (single === undefined || single > 0xffffffff) return undefined;
		return [(single >>> 24) & 255, (single >>> 16) & 255, (single >>> 8) & 255, single & 255].join(".");
	}
	if (parts.length > 4) return undefined;
	const bytes: number[] = [];
	for (let i = 0; i < parts.length; i++) {
		const n = numberPart(parts[i]!);
		if (n === undefined) return undefined;
		// inet_aton semantics: every leading part is one byte, and the **last** part fills whatever is left,
		// which is why `100.200` is `100.0.0.200` and `1.2.3` is `1.2.0.3` to a shell and to `curl`.
		const last = i === parts.length - 1;
		const width = last ? 5 - parts.length : 1;
		if (n > (width === 4 ? 0xffffffff : (1 << (8 * width)) - 1)) return undefined;
		for (let b = width; b > 0; b--) bytes.push((n >>> (8 * (b - 1))) & 255);
	}
	return bytes.length === 4 ? bytes.join(".") : undefined;
}

/** `0x…` / `0…` (octal) / decimal, as a shell would take it. No `+`, no empty, no `1e3`. */
function numberPart(part: string): number | undefined {
	if (!part) return undefined;
	let n: number;
	if (/^0[xX][0-9A-Fa-f]+$/.test(part)) n = parseInt(part, 16);
	else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
	else if (/^\d+$/.test(part)) n = Number(part);
	else return undefined;
	return Number.isFinite(n) ? n : undefined;
}

/**
 * The matcher for the `network` surface.
 *
 * Globs behave as everywhere else (`*aliyuncs*`, `*.aliyuncs.com` and `re:…` all go through
 * {@link wildcardMatch}), and a bare domain additionally covers its subdomains, because "block
 * aliyuncs.com" is a statement about the domain and `oss.aliyuncs.com` is that domain. The subdomain
 * step is anchored at a label boundary, so `aliyuncs.com` never matches `evilaliyuncs.com` — the one
 * mistake a hand-written domain rule must not make. Case-insensitive on both sides.
 */
export function hostDomainMatches(pattern: string, host: string): boolean {
	if (wildcardMatch(pattern, host)) return true;
	const needle = host.trim().toLowerCase();
	if (!needle) return false;
	const domain = pattern.trim().toLowerCase();
	// The subdomain reading is for literal domains only: a glob has already said exactly what it means,
	// and `*.aliyuncs.com` must not silently become `aliyuncs.com`.
	if (!domain || domain === "*" || domain.startsWith("re:")) return false;
	if (/[*?[\]]/.test(domain)) return false;
	if (!domain.includes(".")) return false;
	return needle === domain || needle.endsWith(`.${domain}`);
}
