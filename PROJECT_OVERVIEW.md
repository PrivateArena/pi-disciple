<!-- codegraph-file-count: 114, last-commit: 707f6be52d5f0fcb453a101e793db1af442baad6 -->

# pi-disciple v1.10.1 — TypeScript (strict ESM) pi extensions

## Purpose

Two independent **pi** (coding-agent harness) extensions built to the plan in `.scratch/ARCHITECTURE_PLAN_pi-sub-gate.md`, shipped from one repo and loaded together by `package.json → pi.extensions`. `pi-gate/` is a multi-scope permission gate: it turns every `tool_call` into a policy `Decision` (path / command / network facts → layered rules → dialog) and additionally runs an *output guard* that catches a model writing a tool call as text instead of making it. `pi-subagent/` adds one blocking `subagent(role, task)` tool that runs a child `AgentSession` in-process with zero extensions, a role table, wall-clock/turn ceilings with a human "extend?" dialog, and a report spilled to a transcript file. Language stack: TypeScript only (112 `.ts`, strict, `noEmit`, run directly by pi), plus 7 hand-run `.mjs` live probes in `verification/` and one Python analysis helper.

## Architecture

```
pi harness events ──> pi-gate/index.ts ──> handle.ts ──> inspect(extract Facts) ──> fact-evaluation(evaluate)
turn_end ───────────> output-guard/turn-end-pipeline ──> detection ──> detectors/* ──> reminder message
grant accepted ─────> grants.ts (session array | file write, locked) ──> policy-loading re-read
pi.registerTool(subagent) ──> run.ts ──> child.ts (AgentSession + shims) ──> ceiling-clock ──> ceiling dialog
child tool call ────> shim.execute() ──> parent ExtensionToolContext.executeTool() ──> (back to tool_call above)
```

## File Tree

```
pi-disciple/
  package.json  tsconfig.json   pi.extensions = [pi-gate/index.ts, pi-subagent/index.ts]; ES2022/NodeNext, strict, noEmit, erasableSyntaxOnly
  config.json   the shipped default config both extensions seed from and document — one file at the repo root, because it carries both `gate` and `subagent`
  pi-gate/
    index.ts  handle.ts  inspect.ts  network.ts  prompt.ts  grants.ts  log.ts  config-file.ts  ordered-unique.ts
    schema.ts  match.ts  policy.ts  guard.ts        facades: re-export the sub-packages, no logic
    config-contract/        parsed config sections + shared vocabularies (7 files)
    pattern/                regex / glob / path / shell-segmentation primitives (8 files)
    policy-resolution/      Rule/Policy/Decision types, loading, evaluation, grant offers (6 files)
    output-guard/           turn_end malformed-call detection + detectors/ (12 files)
    render/text.ts          dialog/footer text
  pi-subagent/
    index.ts  run.ts  child.ts  child-request.ts  child-messages.ts  shims.ts  roles.ts  config-view.ts
    config-file.ts  ceiling.ts  render.ts  delegation.ts  tool-declaration.ts  prompt.ts  labels.ts  model-override.ts  sampling.ts
    report-budget.ts  run-guard.ts  run-exit.ts
    budget/  card/  transcript/  config-contract/                                (14 files)
  verification/  .scratch/     7 live .mjs RPC/TUI probes (not in `npm test`); plan doc + .py helper
```

Scopes: `pi-gate` 60 files (13 root, 34 subsystem, 13 tests), `pi-subagent` 45 (32 source, 13 tests), other 9. Both are ≤ 60, so neither gets its own overview file.

## Component Roles

### pi-gate (permission gate)

| File / Module | Role | LOC | Key Exports (with signatures) |
|---|---|---|---|
| pi-gate/index.ts | Extension entry: registers `--no-gate` flag, `/gatec`, the footer, and all five event handlers. | ~354 | `piGate(pi: ExtensionAPI)` |
| pi-gate/handle.ts | The permission pipeline for one `tool_call`: hard-deny → policy → allow-all → ask → apply grant → log. | ~338 | `handleToolCall(event, ctx, state: GateState, deps?: GateDeps): Promise<ToolCallEventResult \| undefined>`; `attachNote(event: ToolResultEvent, notes: PendingNotes): ToolResultEventResult \| undefined`; `observeSubagentCall(state, event): void`; `subagentOwner(state, parentToolCallId?): {role, task} \| undefined`; `setAllowAll(state, allowAll: AllowAll): void` |
| pi-gate/inspect.ts | Turns a tool call into `Facts` (surfaces, path spellings, shell segments, hosts) via per-surface extractors. | ~256 | `extract(toolName, input: Record<string,unknown> \| undefined, cwd, call: {callId, parentCallId?}): Facts`; `shellSegments(facts): string[]`; `isShellTool(toolName): boolean`; `segmentEnvPrefix(seg): string[]`; `redirectTargets(seg): string[]` |
| pi-gate/network.ts | Egress facts: parse a host out of any token spelling, decide loopback/metadata, match domain rules. | ~390 | `parseNetworkTarget(token): NetworkTarget \| undefined`; `networkTargets(seg, cwd): string[]`; `hostDomainMatches(pattern, host): boolean`; `canonicalIpv4(value): string \| undefined`; `isMetadataEndpoint(host): boolean` |
| pi-gate/prompt.ts | The human half: dialog title/options, grant summary text, block reasons, and `ask()`. | ~177 | `ask(ctx, decision: Decision, options: {cwd, signal?, timeoutMs?, sub?, io?, note?}): Promise<AskResult>`; `blockReason(decision, kind: "policy_deny"\|"hard_deny"\|"user_abort"\|"no_ui", instruction?): string`; `neededOffers(decision): GrantOffer[]`; `ruleLine(decision): string` |
| pi-gate/grants.ts | Session-scoped grants array + persisted grant files under an in-process file lock. | ~182 | `createSessionGrants(): GrantRule[]`; `appendSession(grants, offer): GrantRule[]`; `appendPersisted(offer, scope: "global"\|"project", cwd): Promise<WriteResult>`; `resetPersisted(kind, cwd): Promise<WriteResult>`; `hasSessionGrant(grants, surface, value): GrantRule \| undefined` |
| pi-gate/config-file.ts | Read/seed `<scope>/extensions/pi-disciple/config.json` (slug `EXTENSION_CONFIG_SLUG`) with JSONC tolerance and mtime probe. | ~124 | `readConfigFile(file): ConfigFileRead`; `getGlobalConfigFile(agentDir?): string`; `getProjectConfigFile(cwd): string`; `writeDefaultConfig(file, text): {created, error?}`; `stripJsonComments(text): string` |
| pi-gate/log.ts | Redacted JSONL review + guard logs under `extensions/pi-disciple/logs/`. | ~89 | `reviewLog(path, entry: LogEntry): Promise<void>`; `guardLog(path, entry: GuardLogEntry): Promise<void>`; `redact(text): string`; `defaultLogPath(): string` |
| pi-gate/ordered-unique.ts | First-seen-order dedupe list the fact collectors share (a `Set` would lose the order). | ~15 | `pushUnique<T>(list: T[], value: T): boolean` |
| pi-gate/schema.ts | Facade over `config-contract/` — the **only** module pi-subagent may import (type-only). | ~19 | no exports declared; `export * from "./config-contract/*"` |
| pi-gate/policy.ts | Facade over `policy-resolution/`, keeps module-level re-exports. | ~32 | no exports declared; `export * from "./policy-resolution/*"` |
| pi-gate/match.ts | Facade over `pattern/` + `render/`. | ~22 | no exports declared; `export * from "./pattern/*"` |
| pi-gate/guard.ts | Facade over `output-guard/`; doc-only prose explaining the guard. | ~38 | no exports declared; `export * from "./output-guard/*"` |
| pi-gate/policy-resolution/call-decision.ts | The decision vocabulary: every interface the pipeline passes around. | ~170 | `interface Rule extends PermissionEntry`; `interface Policy`; `interface FactCheck`; `interface GrantOffer`; `interface Decision`; `type Stage = "command"\|"location"\|"network"`; `isLocationSurface(surface): boolean`; `isNetworkSurface(surface): boolean` |
| pi-gate/policy-resolution/fact-evaluation.ts | Core evaluator: facts → per-fact rule match → stage decisions → one call action. | ~301 | `evaluate(facts: Facts, policy: Policy): Decision`; `evaluateCall(toolName, input, cwd, call, policy): Decision`; `decideCall(stages, policy): {action, matched?}`; `isFullyDenied(toolName, policy): boolean`; `hiddenTools(toolNames, policy): string[]`; `recomputeActive(toolNames, policy): string[]` |
| pi-gate/policy-resolution/policy-loading.ts | Build a `Policy` from builtin + global + project + grants layers, cached by file mtime. | ~203 | `loadPolicy(cwd, trusted, agentDir): Policy`; `buildPolicy({cwd, trusted, agentDir, globalFile, projectFile}): Policy`; `withSessionGrants(policy, grants: readonly GrantRule[]): Policy`; `resolveConfigPaths(cwd, trusted, agentDir?): {globalFile, projectFile}`; `clearPolicyCache(): void` |
| pi-gate/policy-resolution/grant-offers.ts | Derive the rule a "allow next time" choice should write, per surface class. | ~131 | `offerGrant(facts, policy?): GrantOffer \| undefined`; `offerLocationGrant(facts, policy, checks): GrantOffer \| undefined`; `offerNetworkGrant(facts, policy, checks): GrantOffer \| undefined` |
| pi-gate/policy-resolution/surface-matching.ts | One rule lookup for one (surface, value) pair across the precedence ladder. | ~50 | `patternMatches(surface, pattern, value, segments?): boolean`; `matchRule(surface, value, policy, isToolSurface, segments?): Rule \| undefined`; `matchFact(...): {rule?, specificity}` |
| pi-gate/policy-resolution/override-mode.ts | The layer above the ladder: hard-deny list and timed "allow all" window. | ~67 | `matchHardDeny(facts, policy): {rule: HardDenyRule, value} \| undefined`; `allowAllActive(allowAll: AllowAll \| undefined, now: number): boolean` |
| pi-gate/pattern/shell-segmentation.ts | Bash-aware split: segments, heredocs, `$(…)`, env prefixes, quoting. | ~185 | `segmentCommands(command): string[]`; `tokenize(seg): string[]`; `peelEnvPrefix(seg): {command, stripped}`; `hasUnparsedExpansion(seg): boolean` |
| pi-gate/pattern/shell-commands.ts | Command identity: wrappers, interpreters, destructive heads, pattern suggestions. | ~151 | `normaliseCommand(seg): string`; `suggestBashPattern(seg): string`; `commandName(seg): string`; `isWrappedSegment(seg, inPipeline?): boolean`; `isDestructiveHead(seg): boolean` |
| pi-gate/pattern/regex-dialect.ts | The `re:` pattern dialect, with ReDoS shape rejection and a per-round match budget. | ~145 | `isRegexPattern(pattern): boolean`; `compileRegexPattern(pattern): RegExp \| undefined`; `regexPatternError(pattern): string \| undefined`; `beginRegexRound(): void` |
| pi-gate/pattern/path-spellings.ts | Every spelling of a path a rule could name (relative, absolute, realpath). | ~93 | `pathSpellings(p, cwd): string[]`; `pathPatternMatches(pattern, spelling): boolean`; `directoryPattern(spelling): string`; `realpathNearest(p): string \| undefined` |
| pi-gate/pattern/protected-locations.ts | The always-ask floors: protected config/paths, and writes outside the cwd. | ~55 | `protectedPathGlobs(cwd, agentDir): string[]`; `isProtectedPath(spellings, globs): boolean`; `isExternalPath(spellings, cwd): boolean` |
| pi-gate/pattern/glob.ts | `*`/`**` matching plus `~` expansion; the leaf every matcher bottoms out in. | ~66 | `wildcardMatch(pattern, value): boolean`; `expandHome(p): string` |
| pi-gate/pattern/compound-patterns.ts | Chained (`&&`, `;`) patterns matched segment by segment. | ~45 | `compoundPatternParts(pattern): string[] \| undefined`; `matchesSegmentPattern(patternSegments, segments): boolean` |
| pi-gate/pattern/rule-shape.ts | What a rule's text says about it (exact vs. scoped). | ~25 | `isExactRule(rule: {pattern}, value): boolean`; `isScopedRule(rule?: {surface, pattern}): boolean` |
| pi-gate/config-contract/action-vocabulary.ts | The 3-value action alphabet shared by both extensions. | ~76 | `type Action = "allow"\|"ask"\|"deny"`; `type Scope`; `interface PermissionEntry`, `GrantRule`, `HardDenyRule`; `mostRestrictive(a, b): Action`; `isRecord(v): v is Record<string,unknown>` |
| pi-gate/config-contract/gate-section.ts | Parse/flatten the `gate` section: permission, hardDeny, grants. | ~226 | `parseGateConfig(raw, where): ParsedGateConfig`; `flattenPermission(permission): PermissionEntry[]`; `parseHardDenyList(raw, where, errors): HardDenyRule[]`; `parseGrantList(raw, where, errors): GrantRule[]` |
| pi-gate/config-contract/guard-section.ts | Parse/deep-merge the `gate.guard` section. | ~215 | `parseGuardConfig(raw, where, errors): Partial<GuardConfig>`; `mergeGuardConfigs(files): GuardConfig`; `type GuardAction = "off"\|"notify"\|"remind"` |
| pi-gate/config-contract/subagent-section.ts | Parse the `subagent` section: limits, model pin, role table, tool declaration text. | ~330 | `parseSubagentConfig(raw, where?): ParsedSubagentConfig`; `parseRolesConfig(raw, where, errors): RoleConfigMap \| undefined`; `parseToolPromptConfig(raw, where, errors): SubagentToolPrompt \| undefined`; `parseModelValue(value): ModelValue`; `SUBAGENT_TOOL_PROMPT_TOKENS` |
| pi-gate/config-contract/role-vocabulary.ts | Role names/ids, thinking-level words, the `RoleConfig` shape. | ~80 | `type SubagentRoleName = "explore"\|"general-purpose"\|"review"`; `interface RoleConfig`; `type RoleConfigMap`; `isThinkingLevelWord(v): v is ThinkingLevelWord`; `foldRoleId(value): string` |
| pi-gate/config-contract/sampling-vocabulary.ts | Tolerant parse of `.sampling` / `.samplingByThinkingLevel` bags. | ~102 | `type SamplingValue`; `parseRoleSampling(value, id, where, errors): Pick<RoleConfig,"sampling"\|"samplingByThinkingLevel"\|"thinkingLevel">`; `parseSamplingBlock(value, where, errors): SamplingConfig \| undefined` |
| pi-gate/config-contract/tolerant-parse.ts | The typed-read probes every parser shares; a bad key is an error, not a throw. | ~46 | `readBoolean(doc, key, label, errors): boolean \| undefined`; `readNumber(doc, key, label, min, errors): number \| undefined`; `checkedPattern(pattern, label, errors): string \| undefined` |
| pi-gate/output-guard/turn-end-pipeline.ts | The `turn_end` handler: detect, budget, notify or inject a reminder. | ~139 | `guardTurnEnd(event: TurnEndEvent, ctx, state: GuardTurnState, deps?: GuardTurnDeps): TurnEndEventResult \| undefined`; `effectiveGuardAction(config, budget): GuardAction` |
| pi-gate/output-guard/detection.ts | Rule dispatch: run the active detectors in order, return the first hit. | ~83 | `detectMalformedCall(input: GuardInput): GuardHit \| undefined`; `activeRuleIds(config, sessionDisabled?): string[]` |
| pi-gate/output-guard/detectors/tag-rules.ts | XML dialect: `<tool_call>`, `<invoke name=>`, `<parameter>` fragments. | ~92 | `callTags(scan: Scan): Tag[]`; `isCallNamePrefix(name): boolean`; `isToolNamePrefix(name, scan): boolean` |
| pi-gate/output-guard/detectors/json-rules.ts | JSON dialect: call-shaped objects and truncated call tails. | ~152 | `isCallShapedJson(value, depth?): boolean`; `jsonCandidates(text): {source, end}[]`; `isTruncatedCall(text): boolean` |
| pi-gate/output-guard/detectors/protocol-tokens.ts | Literal protocol-token rules (the `<tool_call>`-style markers). | ~29 | no exports (rules register through `rule-registry.ts`) |
| pi-gate/output-guard/message-scan.ts | Pre-scan a message once: strip code fences, collect tags, resolve tool names. | ~41 | `buildScan(text, toolNames: ReadonlySet<string>, config): Scan`; `stripCode(text): string` |
| pi-gate/output-guard/tag-shapes.ts | Tag lexer shared by the tag rules. | ~72 | `scanTags(text): Tag[]`; `normaliseTagName(name): string`; `hasArgumentShape(tag): boolean` |
| pi-gate/output-guard/rule-registry.ts | id → rule table, and the user's own patterns grafted onto it. | ~41 | `builtinRuleIds(): string[]`; `matchConfiguredPattern(pattern, text): string \| undefined` |
| pi-gate/output-guard/session-budget.ts | Per-session reminder/notice budget with refill. | ~46 | `createGuardBudget(): GuardBudget`; `refillGuardBudget(budget): void`; `resetGuardSession(budget): void`; `resetGuardCounters(budget): void` |
| pi-gate/output-guard/guard-rule.ts | The `Rule` / `GuardHit` contracts one detector implements. | ~22 | `interface Rule`; `interface GuardHit` |
| pi-gate/output-guard/guard-limits.ts | Tuning constants and the guarded message type id. | ~28 | `GUARD_MESSAGE_TYPE`, `REMINDABLE_STOP_REASONS`, `THINKING_TAIL_CHARS`, `JSON_CANDIDATE_LIMIT`, `THINKING_RULE_ID` |
| pi-gate/output-guard/reminder-copy.ts | The reminder/notice text a detected call produces. | ~25 | `reminderText(hit: GuardHit, truncated: boolean): string`; `guardNotice(hit, action: GuardAction): string` |
| pi-gate/render/text.ts | Markdown-safe text for dialogs and footer. | ~41 | `codeSpan(value): string`; `shorten(value, maxChars): string`; `displaySnippet(value, maxChars): string` |
| pi-gate/__tests__/ (13 files) | Vitest suites: unit + `wiring.test.ts` boots the real extension against a fake `ExtensionAPI`; `stages.test.ts` asserts stage behaviour. | ~2.6k | n/a |

### pi-subagent (delegation tool)

| File / Module | Role | LOC | Key Exports (with signatures) |
|---|---|---|---|
| pi-subagent/index.ts | Extension entry: `subagent` tool (TypeBox params), `/subagentc`, `before_agent_start` delegation section. | ~359 | `piSubagent(pi: ExtensionAPI)`; `applyDelegationSection(options: PromptSectionsLike, limits, roles?): string`; `prepareRoleArgs(args): ToolArgs` |
| pi-subagent/run.ts | Turns a `ChildResult` into the tool result the parent model reads, with the byte budget applied. | ~106 | `composeResult(result: ChildResult, role: RoleId, maxResultBytes, elapsedMs, extra?: Partial<SubagentDetails>): AgentToolResult<SubagentDetails>` |
| pi-subagent/child.ts | Build and run the child `AgentSession` (no extensions, shim tools, ceiling clock, transcript dir). | ~297 | `runChild(input: ChildRunInput): Promise<ChildResult>`; `interface ChildResult`; `interface RunProgress`; `makeNullLoader(systemPrompt, contextFiles?): ResourceLoader`; `settleAbort(session, signal): Promise<void>` |
| pi-subagent/child-request.ts | Resolve the child's model + thinking level + sampling from the role, honouring `inherit` pins. | ~102 | `resolveChildRequest({role, sessionModel, overridden, sessionThinkingLevel, onWarning}): ChildRequest`; `resolveModelPin(pin, registry, sessionModel, onWarning): ChildModelPin` |
| pi-subagent/child-messages.ts | Read the child transcript back: final text, usage totals, context pressure. | ~91 | `lastAssistantText(messages): string`; `totalUsage(messages): Usage \| undefined`; `lastAssistantError(messages): string \| undefined`; `contextTokens(message): number` |
| pi-subagent/shims.ts | Re-wrap parent tools for the child; `execute()` forwards into the parent pipeline, one at a time. | ~99 | `buildShims(tools: readonly AgentTool[], role: Role, host: ShimHost, limits?): ToolDefinition[]`; `isAllowedForRole(name, role): boolean`; `isDeniedByLimit(name, limits?): boolean`; `createQueue(): <T>(fn: () => Promise<T>) => Promise<T>` |
| pi-subagent/roles.ts | The role table: built-ins plus config-applied roles, tool sanitisation, per-role ceilings. | ~320 | `resolveCallRole(input, fallback: RoleId, roles?): {role?: Role, roleDefaulted}`; `applyRoleConfig(config: RoleConfigMap \| undefined): AppliedRoleConfig`; `effectiveBudget(role, limits): {turns, minutes}`; `sanitiseTools(tools): {keep, dropped}`; `canonicalRole(input): RoleName \| undefined`; `mergeSamplingByLevel(base, override)` |
| pi-subagent/config-file.ts | Read the `subagent` section of the shared config (deliberate copy of `pi-gate/config-file.ts`). | ~242 | `loadSubagentLimits(cwd, trusted, agentDir?): LoadedLimits`; `readSubagentSection(file, errors): Record<string,unknown> \| undefined` |
| pi-subagent/config-view.ts | The `(all)\|model\|limits\|roles\|status\|models` text `/subagentc` prints; the highest fan-out module. | ~308 | `buildConfigView(input: ConfigViewInput, section?: ConfigSection): string`; `buildModelCatalog(models, opts?): string`; `formatRunning(running: RunGuard \| undefined, now?): string`; `describeParentTools(tools): string` |
| pi-subagent/ceiling.ts | The "budget ran out" dialog broker: title, options, answer mapping. | ~141 | `createCeilingBroker(host: CeilingBrokerHost): CeilingAskHandler`; `ceilingTitle(ask): string`; `ceilingAnswerFor(picked): CeilingAnswer`; `ceilingLabels(): string[]` |
| pi-subagent/budget/ceiling-clock.ts | Wall-clock + turn counter with grant extensions, abort wiring, overflow detection. | ~282 | `createCeilingClock(host: CeilingClockHost): CeilingClock`; `interface CeilingClock`; `interface CeilingCounters` |
| pi-subagent/budget/ceiling-vocabulary.ts | Ceiling ask/grant/outcome types (no runtime imports). | ~61 | `type CeilingReason = "maxTurns"\|"timeout"`; `interface CeilingAsk`, `CeilingGrant`, `CeilingAnswer`, `CeilingReport`; `type CeilingAskHandler = (ask) => Promise<CeilingAnswer>` |
| pi-subagent/model-override.ts | Resolve a human-written `provider/model` pin, incl. fuzzy `:`-less splits. | ~116 | `resolveChildModel(reference, registry, parent?): ChildModelResolution`; `parseModelRef(input, isProvider): ModelRef \| undefined`; `childThinkingLevel(model, requested): ThinkingLevel`; `childThinkingLabel(model, asked, effective, roleNamedLevel): string \| undefined` |
| pi-subagent/sampling.ts | Fold the role's sampling bag for the child's effective thinking level onto the request. | ~147 | `applyRoleSampling(model, role, thinkingLevel): AppliedRoleSampling`; `isSamplingCapable(model): boolean`; `roleThinkingLevel(role, inherited): ThinkingLevel`; `samplingLabel(applied): string` |
| pi-subagent/delegation.ts | The system-prompt section that teaches the model when to delegate, generated from the live role table. | ~67 | `buildDelegationSection({defaultRole, roles?}): string`; `roleLines(defaultRole, roles): string[]`; `delegationSectionWords(section): number` |
| pi-subagent/tool-declaration.ts | The tool's model-facing text — description, snippet, rules bullets — built from the live role table and `subagent.tool`, whose shipped values the config file also spells out. | ~120 | `buildToolDeclaration({roles, defaultRole}, overrides?): ToolDeclaration`; `expandToolTokens(text, tokens): string`; `DEFAULT_TOOL_PROMPT`; `DEFAULT_ROLE_PARAMETER_DESCRIPTION` |
| pi-subagent/render.ts | Tool-call / tool-result renderers for the TUI card. | ~198 | `renderSubagentCall(args, theme, context?): Text`; `renderSubagentResult(result, options, theme): Text`; `formatStatusLine(details: SubagentDetails, usage, theme): string`; `formatRunStats(details, usage): string` |
| pi-subagent/card/details.ts | The `SubagentDetails` payload the card and the report both read. | ~143 | `interface SubagentDetails extends SubagentCardFields`; `cardFields(host, run): SubagentCardFields`; `pendantHeader(host): {pendant}`; `previewOf(report, maxChars?): string` |
| pi-subagent/card/progress.ts | Live progress → card fields while the child runs. | ~61 | `formatProgress(progress: RunProgress, toolCount): string`; `progressDetails(progress, host: ProgressContext): SubagentDetails` |
| pi-subagent/card/ui-status.ts | Map the run exit onto the card's status word. | ~35 | `uiStatus(exit: Exit): SubagentUiStatus` |
| pi-subagent/labels.ts | Small display formatters shared by card and config view. | ~85 | `formatCeiling(report?: CeilingReport): string`; `formatDuration(ms): string`; `roleDisplayName(role?): string`; `taskLabel(task?): string` |
| pi-subagent/transcript/paths.ts | Where a child's session file and spilled report live. | ~20 | `childSessionDir(parentSessionDir): string`; `reportFileFor(transcriptFile): string` |
| pi-subagent/transcript/report-spill.ts | Write the long report out of the context and leave a path behind. | ~27 | `writeReport(transcriptFile: string \| undefined, report): string \| undefined` |
| pi-subagent/transcript/retention.ts | Keep the last N child transcripts. | ~52 | `pruneTranscripts(dir, keep): Promise<number>` |
| pi-subagent/run-guard.ts | GlobalThis-registered mutex: one child run at a time, claimable/releasable. | ~47 | `claimGuard(guard: RunGuard): void`; `currentGuard(): RunGuard \| undefined`; `releaseGuard(callId: string): void` |
| pi-subagent/run-exit.ts | The terminal reason of a run, in severity order. | ~21 | `type Exit = "done"\|"aborted"\|"timeout"\|"maxTurns"\|"callLimit"\|"overflow"\|"error"`; `pickEarlier(a, b): Exit` |
| pi-subagent/report-budget.ts | Byte-exact truncation of the report handed to the parent. | ~35 | `reportHead(report, maxBytes): {head, truncated, totalBytes}`; `sliceBytes(text, maxBytes): string` |
| pi-subagent/prompt.ts | Assemble the child's system prompt (role text + cwd). | ~20 | `buildChildSystemPrompt(role: Role, cwd): string` |
| pi-subagent/config-contract/ (6 files) | pi-subagent's own mirror of the config readers it needs (`readRoles`, `readRoleSampling`, `readModelValue`, `readToolPrompt`, `isRoleId`) so it never imports gate logic. | ~290 | `readRoles(raw, file, errors): RoleConfigMap \| undefined`; `readToolPrompt(raw, where, errors): SubagentToolPrompt \| undefined`; `readRoleSampling(value, id, file, errors)`; `readModelValue(value): {model?, error?}`; `TOOL_PROMPT_TOKENS` |
| pi-subagent/__tests__/ (13 files) | Vitest suites; `config-parity.test.ts` asserts the two mirrored parsers still agree. | ~1.8k | n/a |

### root / verification

| File / Module | Role | LOC | Key Exports |
|---|---|---|---|
| package.json | Workspace root: `pi.extensions`, peer deps on the pi runtime, vitest/tsc scripts; ships the root `config.json`. | 33 | n/a |
| config.json | The shipped default document (both `gate` and `subagent` sections), seeded to `<agentDir>/extensions/pi-disciple/config.json` on a clean install by `pi-gate/index.ts`. | ~173 | n/a |
| tsconfig.json | strict, `noEmit`, `verbatimModuleSyntax`, `erasableSyntaxOnly` — type-only cross-extension imports are provably erased. | 20 | n/a |
| verification/rpc-gate-dialog.mjs | Drive `pi --mode rpc` with pi-gate loaded; assert the real dialog and its answers. | ~98 | script |
| verification/rpc-subagent-gate.mjs | Assert a child's tool call raises the gate dialog **in the parent**. | ~60 | script |
| verification/rpc-ceiling-dialog.mjs | Assert the ceiling dialog appears and grants extend the run. | ~115 | script |
| verification/guard-turn-end.mjs | Live check that `gate.guard` keeps a run alive after a text-form tool call. | ~141 | script |
| verification/role-sampling-wire.mjs | Live check that a role's `sampling` reaches the child's HTTP request body. | ~213 | script |
| verification/tui-card.mjs, probe-subagent-render.mjs | What pi's terminal component actually draws for a subagent call. | ~74 / ~131 | script |

## Cross-References

| File | Called by / calls | Why it's central |
|---|---|---|
| pi-gate/policy-resolution/policy-loading.ts | ← `handle.ts`, `index.ts`, `fact-evaluation.ts` and 5 test files; → `config-contract/*`, `grants.ts` | Every decision reads the `Policy` this builds; the mtime cache and the layer order live here |
| pi-gate/policy-resolution/fact-evaluation.ts | ← `handle.ts`, `policy.test.ts`, `stages.test.ts`; → `inspect.ts`, `surface-matching.ts`, `grant-offers.ts`, `protected-locations.ts`, `rule-shape.ts` | The single place where rules, stages and actions meet |
| pi-gate/inspect.ts | ← `fact-evaluation.ts`, `grant-offers.ts`, `override-mode.ts`; → `network.ts`, `shell-segmentation.ts`, `path-spellings.ts`, `render/text.ts` | Converts arbitrary tool inputs into the typed `Facts` the whole gate consumes |
| pi-gate/handle.ts | ← `index.ts`; → `grants.ts`, `log.ts`, `prompt.ts`, `override-mode.ts`, `policy-loading.ts`, `render/text.ts` | The one orchestrator: policy, dialog, grant write and log all in one function |
| pi-subagent/child.ts | ← `index.ts` (via `run.ts`); → `budget/ceiling-clock.ts`, `child-messages.ts`, `prompt.ts`, `run-exit.ts`, `transcript/paths.ts` | Composes the child session: model, shims, ceiling, transcript |
| pi-subagent/config-view.ts | ← `index.ts`, `config-view.test.ts`; → `model-override.ts`, `roles.ts`, `sampling.ts`, `transcript/paths.ts` | Reads every subsystem's effective state; highest reference count in the repo |

## Data Flow

```
pi event                pi-gate handler                            result
  tool_call        ──>  handleToolCall ── extract ── evaluate ──>  {allow | deny(blockReason) | ask}
                            ask ── ctx.ui.select ── choice ──>    grants.ts (session | appendPersisted, locked)
                            done ──>  reviewLog(JSONL, redacted)
  tool_result      ──>  attachNote ──>  notes pending for the next call
  turn_end         ──>  guardTurnEnd ── detect ──> GuardHit ──>   notify message | injected reminder (keeps run alive)

pi-subagent                direction
  model ── tool "subagent(role, task)" ──> runChild ── child AgentSession (0 extensions)
     child tool call ── shim.execute ──> parent executeTool ──> parent tool_call event  (gate sees it, same dialog)
     ceiling-clock ── ctx.ui.select (parent UI) ── grant/extend ──> clock reset
     child report ──> report-spill file ──> composeResult (byte budget) ──> parent tool_result
```

## Key Architectural Patterns

1. **Facade modules**: `schema.ts`, `match.ts`, `policy.ts`, `guard.ts` contain no logic, only `export *` of their sub-package. Tests and `pi-subagent` keep importing the old paths; nothing in a sub-package imports its facade, so there is no cycle.
2. **Type-only cross-extension coupling**: `pi-subagent` imports `../pi-gate/schema.ts` with `import type` only. `verbatimModuleSyntax` + `erasableSyntaxOnly` make the erasure verifiable, so deleting `pi-gate` leaves `subagent` running with defaults.
3. **Mirrored, not shared, parsers**: `pi-subagent/config-contract/*` is a deliberate copy of the gate's readers, kept honest by `pi-subagent/__tests__/config-parity.test.ts` — ownership boundary over DRY.
4. **Facts → stages → one action**: `extract()` produces surface-tagged facts; `buildStages` groups them into `command` / `location` / `network` questions; `decideCall` takes the most restrictive stage. Rules are ordered so "last match wins" always resolves towards the human.
5. **Shim forwarding instead of IPC**: child tools are `ToolDefinition` wrappers whose `execute()` calls the parent's `ExtensionToolContext.executeTool()`, so nested calls are gated by the parent's policy with no second config or permission channel.
6. **Injectable I/O seams**: `prompt.ts::AskIO`, `ceiling.ts::CeilingIO`, `turn-end-pipeline.ts::GuardTurnDeps`, `child.ts`'s `ResourceLoader` and `handle.ts::GateDeps` are all defaulted parameter objects, so no test needs a TTY or a live session.
7. **Ordered-unique collection**: `pushUnique` arrays everywhere instead of `Set`, because the order facts were spelled in is what the dialog and the grant offer show.
8. **mtime-keyed caches + file lock**: `policy-loading` caches the parsed policy by file mtime; `grants.ts` serialises grant-file writes through `withFileLock` so concurrent sessions cannot lose an append.

## Read Triggers

| If you need to... | Open these files |
|---|---|
| Add a new tool surface the gate must judge (e.g. a new MCP tool) | pi-gate/inspect.ts (extractors, `looksLikePath`), pi-gate/policy-resolution/call-decision.ts (`Stage`, surface taxonomy), pi-gate/policy-resolution/surface-matching.ts |
| Change how a rule pattern is matched (glob/regex/path) | pi-gate/pattern/glob.ts, pi-gate/pattern/regex-dialect.ts, pi-gate/pattern/path-spellings.ts, pi-gate/policy-resolution/surface-matching.ts |
| Add a config key, or change precedence / defaults | pi-gate/policy-resolution/policy-loading.ts (`buildPolicy`, `orderRules`, `fallbackRulesFor`), config-contract/gate-section.ts, pi-gate/config-contract/tolerant-parse.ts, mirror pi-subagent/config-contract/* |
| Change the permission dialog (options, wording, timeouts) | pi-gate/prompt.ts (`optionLabels`, `ask`, `blockReason`), pi-gate/handle.ts (`handleToolCall`), pi-gate/render/text.ts |
| Add a new output-guard detector | pi-gate/output-guard/guard-rule.ts (interface), pi-gate/output-guard/detectors/*.ts as a template, pi-gate/output-guard/rule-registry.ts, pi-gate/config-contract/guard-section.ts (rule id list) |
| Add or change a subagent role / its ceiling / sampling | pi-subagent/roles.ts, pi-gate/config-contract/role-vocabulary.ts, pi-subagent/sampling.ts, pi-subagent/child-request.ts |
| Reword what the model is told about the subagent tool | `subagent.tool` in config.json (placeholders in `==tool.tokens`), pi-subagent/tool-declaration.ts, pi-subagent/index.ts (`prepareLoadout`, `applyToolPromptDeclaration`) |
| Change what the child is allowed to call | pi-subagent/shims.ts (`FORBIDDEN_CHILD_TOOLS`, `isAllowedForRole`), pi-subagent/roles.ts (`sanitiseTools`) |
| Change budget/timeout behaviour or the extend dialog | pi-subagent/budget/ceiling-clock.ts, pi-subagent/ceiling.ts, pi-subagent/budget/ceiling-vocabulary.ts |
| Change the TUI card, the report text, or what `/subagentc` prints | pi-subagent/render.ts, pi-subagent/card/details.ts, pi-subagent/card/progress.ts, pi-subagent/run.ts (`composeResult`), pi-subagent/report-budget.ts, pi-subagent/config-view.ts |
| Change what `/gatec` prints or logs | pi-gate/index.ts (`registerCommand`), pi-gate/log.ts, pi-gate/prompt.ts |

## Dependencies

### Runtime host (peerDependencies, `*` — provided by the pi install, never bundled)
| Package / Module | Role |
|---|---|
| @earendil-works/pi-coding-agent | `ExtensionAPI`, `ExtensionContext`, `AgentSession`, `ToolDefinition`, event types |
| @earendil-works/pi-ai | `Model<Api>`, `ModelRegistry`, `ThinkingLevel`, `Usage` |
| @earendil-works/pi-tui | `Text`, `Theme` for the call/result renderers |
| typebox | TypeBox schema for the `subagent` tool parameters |
| Node builtins (`node:fs`, `node:path`, `node:os`, `node:readline`) | config read, grant file locking, transcripts, logging |

### Dev toolchain
| Package / Module | Role | Version |
|---|---|---|
| typescript | `tsc --noEmit` typecheck (no emit step; pi loads `.ts` directly) | ^5.9.3 |
| vitest | unit + wiring suites under `__tests__/` | ^3.2.4 |

## Build & Run

| Command | Purpose |
|---|---|
| `npm test` | Full vitest suite (`vitest run`) |
| `npx vitest run pi-gate/__tests__/stages.test.ts` | One suite while iterating |
| `npm run typecheck` | `tsc --noEmit` over `pi-gate/**`, `pi-subagent/**` |
| `node verification/rpc-gate-dialog.mjs` | Live `pi --mode rpc` probe of the real dialog |
| `pi` with this repo on the extension path | Load both extensions (`pi.extensions` in package.json) |
