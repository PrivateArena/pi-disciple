/**
 * The egress facts (plan step B): what a call can reach, and what a `network` rule means.
 *
 * Two properties carry the whole surface. First, **a rule cannot be spelled past**: `https://User:pw@Host:8443/x`,
 * `Host:8443` and `host/x` must all produce the same host string, or a domain rule matches some spellings
 * and not others. Second, **a host is not a path and a path is not a host**: `1e10`, `HEAD`, `/tmp/x` and
 * `data.csv` are arguments, and an over-eager parser would turn every shell call into an egress prompt —
 * which is how an egress surface gets clicked through without being read.
 */

import { describe, expect, it } from "vitest";
import {
	hostDomainMatches,
	isLoopbackHost,
	isMetadataEndpoint,
	looksLikeUrl,
	METADATA_ENDPOINTS,
	canonicalIpv4,
	networkTargets,
	NETWORK_SURFACE,
	parseNetworkTarget,
} from "../network.ts";

describe("looksLikeUrl", () => {
	it("recognises scheme:// tokens of any scheme", () => {
		for (const token of ["https://x.com/a", "http://x", "ftp://h/f", "s3://bucket/key", "ws://h/ws", "wss://h/ws"]) {
			expect(looksLikeUrl(token)).toBe(true);
		}
	});

	it("does not mistake a path, a word or a bare host for a URL", () => {
		// `mailto:` and `data:` carry a scheme but no `//`, so they are not URL-shaped tokens either.
		for (const token of ["/tmp/x", "src/a.ts", "example.com/x", "localhost:3000", "mailto:a@b.c", "data:,x"]) {
			expect(looksLikeUrl(token), token).toBe(false);
		}
	});
});

describe("parseNetworkTarget", () => {
	it("normalises a URL host: lowercase, no port, no userinfo, no brackets", () => {
		expect(parseNetworkTarget("https://OSS.AliyunCS.com/proxy_temp_file")).toEqual({
			host: "oss.aliyuncs.com",
			scheme: "https",
			raw: "https://OSS.AliyunCS.com/proxy_temp_file",
		});
		const target = parseNetworkTarget("https://user:pw@Host.Example.com:8443/a");
		expect(target?.host).toBe("host.example.com");
		expect(target?.port).toBe(8443);
		expect(parseNetworkTarget("http://[2001:db8::1]:8443/a")?.host).toBe("2001:db8::1");
	});

	it("reads the path-style form a URL parser refuses, and needs the path to believe a bare token", () => {
		// A metadata URL written without its scheme is still the metadata service: the trailing path is the
		// evidence, and a bare `word.word` has none — it is a version, a module or a file name.
		expect(parseNetworkTarget("169.254.169.254/latest/meta-data/iam/")?.host).toBe("169.254.169.254");
		expect(parseNetworkTarget("Host.Example.com/a")?.host).toBe("host.example.com");
		expect(parseNetworkTarget("//cdn.example.com/a.js")?.host).toBe("cdn.example.com");
		expect(parseNetworkTarget("Host.Example.com:8443")).toBeUndefined();
		expect(parseNetworkTarget("v1.2.3")).toBeUndefined();
		expect(parseNetworkTarget("http.server")).toBeUndefined();
	});

	it("reads an scp-style remote as a host, not as a path", () => {
		expect(parseNetworkTarget("bob@example.com:/tmp/a.txt")?.host).toBe("example.com");
		expect(parseNetworkTarget("git@github.com:acme/app.git")?.host).toBe("github.com");
		expect(parseNetworkTarget("rsync://host.example.net/mod")).toEqual({ host: "host.example.net", scheme: "rsync", raw: "rsync://host.example.net/mod" });
	});

	it("returns undefined when there is no host to name", () => {
		for (const token of ["", "  ", "-o", "/tmp/x", "./src/a.ts", "data.csv", "HEAD", "make", "1e10", "mailto:a@b.com", "data:,x", "file:///tmp/x", "2>/dev/null"]) {
			expect(parseNetworkTarget(token), token).toBeUndefined();
		}
	});

	it("never reads a filesystem path as a host", () => {
		// The mirror image of the URL-as-path bug step D removes: a path fact must not become an egress fact.
		expect(parseNetworkTarget("/home/me/.ssh/id_rsa")).toBeUndefined();
		expect(parseNetworkTarget("src/network/policy.ts")).toBeUndefined();
	});
});

describe("networkTargets", () => {
	it("finds the host of a curl, and does not treat the URL as a path", () => {
		expect(networkTargets("curl https://oss.aliyuncs.com/proxy_temp_file -o /tmp/x", "/repo")).toEqual(["oss.aliyuncs.com"]);
	});

	it("finds every host of a segment, once each, in order", () => {
		expect(networkTargets("curl https://a.com/x -o /tmp/x; wget http://b.io/y", "/repo")).toEqual(["a.com", "b.io"]);
		expect(networkTargets("curl https://a.com/x http://a.com/y", "/repo")).toEqual(["a.com"]);
	});

	it("reads a host out of an --option=value and skips a bare option", () => {
		expect(networkTargets("curl --url=https://oss.aliyuncs.com/x --max-time 5", "/repo")).toEqual(["oss.aliyuncs.com"]);
	});

	it("finds the host of a path-style metadata URL written without its scheme", () => {
		expect(networkTargets("curl 169.254.169.254/latest/meta-data/iam/", "/repo")).toEqual(["169.254.169.254"]);
	});

	it("skips loopback, because a call to localhost cannot leave the machine", () => {
		for (const seg of ["curl http://localhost:3000/x", "curl http://127.0.0.1/x", "curl http://[::1]/x", "nc 0.0.0.0 8080", "curl http://127.4.5.6/x"]) {
			expect(networkTargets(seg, "/repo"), seg).toEqual([]);
		}
	});

	it("skips arguments that only look like hosts", () => {
		for (const seg of ["head -n 5 data.csv", "python3 -m http.server", "ls src/network", "echo 1e10", "git status", "awk -F: '{print $1}' /etc/passwd", "echo v1.2.3", "nslookup foo.invalid"]) {
			expect(networkTargets(seg, "/repo"), seg).toEqual([]);
		}
	});

	it("does not turn a file redirect into an egress fact", () => {
		expect(networkTargets("echo hi > out/log.txt", "/repo")).toEqual([]);
	});
});

describe("isLoopbackHost", () => {
	it("covers the whole 127/8, not only .1", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.4.5.6")).toBe(true);
		expect(isLoopbackHost("LOCALHOST")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackHost("oss.aliyuncs.com")).toBe(false);
		expect(isLoopbackHost("169.254.169.254")).toBe(false);
	});
});

describe("isMetadataEndpoint", () => {
	it("names the cloud metadata services, including Alibaba's non-standard address", () => {
		expect(isMetadataEndpoint("169.254.169.254")).toBe(true);
		expect(isMetadataEndpoint("100.100.100.200")).toBe(true);
		expect(isMetadataEndpoint("metadata.google.internal")).toBe(true);
		expect(isMetadataEndpoint("metadata.goog")).toBe(true);
		expect(isMetadataEndpoint("instanceData")).toBe(true);
		expect(isMetadataEndpoint("INSTANCEdata")).toBe(true);
		expect(isMetadataEndpoint("fd00:ec2::254")).toBe(true);
		expect(isMetadataEndpoint("oss.aliyuncs.com")).toBe(false);
	});

	it("is exported as data so a config file and a test can read the same list", () => {
		expect(METADATA_ENDPOINTS.length).toBeGreaterThan(4);
		expect(METADATA_ENDPOINTS).toContain("100.100.100.200");
	});
});

describe("hostDomainMatches", () => {
	it("makes a bare domain cover its subdomains", () => {
		expect(hostDomainMatches("aliyuncs.com", "aliyuncs.com")).toBe(true);
		expect(hostDomainMatches("aliyuncs.com", "oss.aliyuncs.com")).toBe(true);
		expect(hostDomainMatches("aliyuncs.com", "a.b.aliyuncs.com")).toBe(true);
	});

	it("never crosses a label boundary — the mistake a hand-written domain rule cannot make", () => {
		expect(hostDomainMatches("aliyuncs.com", "evilaliyuncs.com")).toBe(false);
		expect(hostDomainMatches("aliyuncs.com", "notaliyuncs.com")).toBe(false);
		expect(hostDomainMatches("aliyuncs.com", "aliyuncs.com.evil.net")).toBe(false);
	});

	it("is case-insensitive on both sides", () => {
		expect(hostDomainMatches("AliyunCS.com", "OSS.aliyuncs.com")).toBe(true);
	});

	it("routes globs and re: patterns through the shared matcher", () => {
		expect(hostDomainMatches("*.aliyuncs.com", "oss.aliyuncs.com")).toBe(true);
		expect(hostDomainMatches("*.aliyuncs.com", "aliyuncs.com")).toBe(false); // a glob says what it means
		expect(hostDomainMatches("*aliyuncs*", "oss.aliyuncs.com")).toBe(true);
		expect(hostDomainMatches("re:.*aliyuncs.*", "oss.aliyuncs.com")).toBe(true);
		expect(hostDomainMatches("re:^aliyuncs\\.", "oss.aliyuncs.com")).toBe(false);
		expect(hostDomainMatches("*", "anything.example")).toBe(true);
	});

	it("does not read a single label as a domain", () => {
		// `localhost`-shaped names are never a domain; the subdomain rule is for `a.b` and deeper.
		expect(hostDomainMatches("metadata", "oss")).toBe(false);
	});
});

describe("NETWORK_SURFACE", () => {
	it("is the word the facts, the rules and the config all use", () => {
		expect(NETWORK_SURFACE).toBe("network");
	});
});

describe("the hosts a command can hide", () => {
	// The spelling an agent reaches for when the CLI is not enough: the URL lives inside a quoted code
	// string, where quote-stripping leaves it in pieces. A surface that only reads argv tokens misses it.
	it("finds a URL inside a quoted code string", () => {
		expect(networkTargets(`python3 -c "import urllib.request as u;u.urlopen('http://100.100.100.200/latest')"`, "/repo")).toContain("100.100.100.200");
		expect(networkTargets(`node -e "fetch('https://oss.aliyuncs.com/x')"`, "/repo")).toContain("oss.aliyuncs.com");
	});

	it("reads the address forms a rule must not be spelled past", () => {
		expect(networkTargets("curl http://[100.100.100.200]/x", "/repo")).toContain("100.100.100.200");
		expect(networkTargets("curl http://0x64646464/x", "/repo")).toContain("100.100.100.100");
		expect(networkTargets("curl http://0144.0144.0144.0144/x", "/repo")).toContain("100.100.100.100");
		// `curl --resolve` pins a name to an address: both are reached, so both are facts.
		expect(networkTargets("curl --resolve evil.example.com:443:100.100.100.200 https://evil.example.com/x", "/repo")).toEqual(
			expect.arrayContaining(["evil.example.com", "100.100.100.200"]),
		);
	});

	it("normalises the host, not the spelling", () => {
		expect(networkTargets("curl HTTPS://OSS.ALIYUNCS.COM/x", "/repo")).toContain("oss.aliyuncs.com");
		expect(networkTargets("curl http://aliyuncs.com./x", "/repo")).toContain("aliyuncs.com");
	});

	it("reports the metadata service's dot-less short names", () => {
		expect(networkTargets("curl http://metadata/computeMetadata/v1/", "/repo")).toContain("metadata");
	});

	it("does not turn a version, a file name or an IP fragment into a host", () => {
		for (const seg of ["echo v1.2.3.4", "cat data.csv", "echo 1.2.3", "tar xf a.tar.gz", "ls src/network"]) {
			expect(networkTargets(seg, "/repo"), seg).toEqual([]);
		}
	});

	it("canonicalIpv4 knows a real address and nothing else", () => {
		expect(canonicalIpv4("0x64646464")).toBe("100.100.100.100");
		expect(canonicalIpv4("0144.0144.0144.0144")).toBe("100.100.100.100");
		expect(canonicalIpv4("100.200")).toBe("100.0.0.200");
		expect(canonicalIpv4("1.2.3.4.5")).toBeUndefined();
		expect(canonicalIpv4("999.1.1.1")).toBeUndefined();
		// inet_aton fills from the left, exactly as `curl` and `getaddrinfo` do — an address is an address.
		expect(canonicalIpv4("1.2.3")).toBe("1.2.0.3");
		expect(canonicalIpv4("10")).toBe("0.0.0.10"); // a lone number is the host part, not the network
	});
});
