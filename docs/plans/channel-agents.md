# Plan: channel-bound agents driven by `@herdr` mentions

Status: revised after simplicity + feasibility review (see "Review log" at the end).
Scope: the approved concept core only. Nothing in "Out of scope" is built.

## 0. Decisions already taken by this plan

| # | Decision | Why |
|---|---|---|
| D1 | Bindings keep the existing `config.channelBindings: Record<channel, string>` shape in memory. Value = `encodeHerdRef(herdId, workspaceId, localHerdId)` (bare `workspaceId` for the local herd). `stateDir(instance)/bindings.json` is authoritative: at first boot (file absent) it is seeded from the config-file `channelBindings`; afterwards it replaces them. Later edits to the config-file `channelBindings` are ignored. | Reuses `guards.ts` with the D8 DM-card exception and `encodeHerdRef`/`decodeHerdRef` (herd-registry.ts:133-143) unchanged. No new config write path, so keychain tokens never hit disk. |
| D2 | `@herdr new` cannot open a modal directly. An `app_mention` event carries no `trigger_id`; only a `block_actions` payload does. So `new` posts an ephemeral with one **New agent** button; the click opens the modal. | Slack platform constraint. Approved flow; no text-form alternative. |
| D3 | The new flow runs with `creOnly=false`. `creOnly` mode stays as it is today. The rule "channelBindings requires creOnly=true" (config.ts:226) is deleted. The old card-sync into bound channels (`#scheduleChannel` and friends) is gated on `creOnly`. | `creOnly` blocks launches and gates every surface through `isEligibleCreRoot` (cre-roots.ts:11-12 returns true for any agent pane when `creOnly=false`), so without the gate every bound channel would receive session cards. |
| D4 | Agent **name** = herdr's `AgentInfo.name` (on the wire; reviewer confirmed via `herdr api schema --json`). `State` keeps a `terminal_id → name` map from `snapshot.agents`. A `cre` started by typing has no name until `agent.rename {target, name}`, so the launcher renames it right after detection. No tab-label fallback. | One source of truth for `@herdr <name>` and `agents`. Rename makes the name deterministic the moment the launch returns. |
| D5 | A settled channel-driven turn posts one message to the turn's **origin** (`{channel, threadTs?}`) and records `{channel, ts}` on the session record, where `ts = origin.threadTs ?? posted.ts`. The existing card-thread post stays for sessions that have a card. | Reuses `announceReply`, `claimTurnNotification`, `responseSections`, `redact`. Recording the thread root is what makes a user's thread reply resolvable (its `thread_ts` is the root, not the child). |
| D6 | Busy agent = steer. The prompt goes out immediately; the active turn keeps its id and takes the new origin. No new turn. | Reply goes to the origin of the most recent prompt, as approved. |
| D7 | New config field: `contextMessages` (default 50, max 999). New catalog field: `AgentEntry.command?: string`, set only on the seeded `cre` entry (`command: "cre"`); not parsed from `agents.toml`. Interrupt key and clear prompt are two constants in `session-controller.ts`: `INTERRUPT_KEYS = ["esc"]`, `CLEAR_PROMPT = "/clear"`. | `agent.start` has no command override (`AgentStartParams = {name, kind, pane_id, args?, timeout_ms?}`), so `cre` must be typed into the shell; the catalog needs to say so. Per-kind stop/clear fields were speculative. |
| D8 | `bind`/`unbind` work in `C`/`G` channels and bot DMs (`D`). A bound DM accepts agent commands and posts their settled replies in that DM. Scope workspace matching to mention/text command resolution; in `authorizeAction`, skip the existing card-button workspace check when `ctx.channel.startsWith("D")`, but keep it for bound `C`/`G` channels in the old attach mode. The foreign-action refusal at surfaces.ts:821 also applies only to bound `C`/`G` channels. | `authorizeAction` (guards.ts:138-141) otherwise denies a bound DM's card buttons for agents outside its workspace. The DM exception preserves the existing C/G guard and its legacy tests; T6 resolves command names inside the bound workspace. |
| D9 | One guard chain per mention: `#markMessageSeen` (dedupe) first, then `checkInbound` once, then `requireHerdr`, then name → terminal resolution with inline live + workspace checks. `authorizeAction` is not called for mentions. | `authorizeAction` calls `checkInbound` again (guards.ts:128), so one mention would cost two throttle hits (guards.ts:97). Dedupe first, so the duplicate `message`/`app_mention` event costs no throttle. |

## 1. Phase 1 — spike (T0). Biggest risk; runs first and alone.

**Goal:** prove herdr can start `cre` by typing into a fresh pane, reports its status, accepts `agent.rename`, and that `extractAgentResponse` yields a usable reply from the cre/Pi TUI.
**Owner:** one worker with a live herdr and the `cre` binary. **Writes:** only the "Spike results" section of this file, plus one fixture in `app/test/slack/response.test.ts`.

Steps (each with its check):
1. `herdr api schema --json > /tmp/schema.json` → record the exact method name and params for typing text into a bare shell pane (`pane.send_text` or `pane.send_input`; the reviewer saw both names) and the `agent.rename` params (`{target, name}`). Record the `agent.send_keys` key name for interrupt: `esc` (canonical; `escape` accepted).
2. Confirm `name` is present on `agents[]` in the `session.snapshot` delivered on `events.subscribe` (not only in `agent.list`). Record yes/no. If no, D4 changes to "`State` refreshes names from `agent.list` on reconcile" — report to supervisor.
3. Start cre through herdr: `tab.create` → wait for shell → type `cre⏎` via the step-1 method → confirm `pane_agent_detected` with `agent:"pi"` arrives (run `herdr-slack daemon --dry-run` and read `daemon.log`). Then `agent.rename {target:<pane_id>, name:"spike"}` → `agent.list` shows `name:"spike"`.
4. Send `agent.prompt` with a trivial task → confirm `agent_status` goes `working` → `idle|done` in `daemon.log` transitions.
5. `pane.read {source:"recent_unwrapped", strip_ansi:true, lines:120}` before and after → feed both into `extractAgentResponse(after, before)` in a vitest fixture → the result is the assistant reply, not TUI chrome. Add chrome patterns to `response.ts` `CHROME_TEXT` only if the fixture fails.
6. Confirm `agent.send_keys {keys:["esc"]}` interrupts a working cre turn. Confirm `agent.prompt "/clear"` runs the slash command (herdr may deliver prompts in paste mode, which can defeat slash commands); if it does not, record what does (`pane.send_text "/clear\n"` or `agent.send_keys`), and T6 step 8 uses that.
7. Observation only (not load-bearing since B2's fix): does `app_mention` fire in the bot DM? Record yes/no.
8. Live smoke only (R8 is settled by Slack docs): with the bot token, call `conversations.replies` on a thread in a private channel the bot is in. Record ok or the error. A failure goes to the supervisor before T3.

**Done:** "Spike results" filled with: typing method + params, snapshot `name` yes/no, rename ok, interrupt key, `/clear` delivery method, fixture passing (`npx vitest run app/test/slack/response.test.ts` → 0 failed). A "no" in step 2, 3 or 6 goes to the supervisor before T5/T6 start; a failure in step 8 goes to the supervisor before T3.

## 2. Tasks

Each task: goal · files · steps · tests · done check. Tests mirror `app/test/`. `npm run check` is the gate (lint + typecheck + coverage; `guards.ts` must stay 100%).

### T1 — mention command parser (pure)
**Goal:** one function turns mention text into a command.
**Files:** new `app/src/slack/commands.ts`; new `app/test/slack/commands.test.ts`.
**Steps:**
1. `export const RESERVED = ["bind","unbind","agents","new","help"] as const`.
2. `parseMention(text, botUserId)` → strips a leading `<@BOT>` when present (absent is fine: bare DM text goes through the same function), returns one of `{kind:"bind"|"unbind"|"agents"|"new"|"help"}`, `{kind:"agent", name, verb:"prompt"|"context"|"stop"|"clear", text}`, or `{kind:"unknown"}`. Reserved words win over agent names. `name` must match herdr's `[a-z][a-z0-9_-]{0,31}`.
**Tests:** every command; reserved precedence (`@herdr help me` → help); `@herdr build context fix it` → `{agent, build, context, "fix it"}`; `@herdr build stop`; `@herdr build` with no text → unknown; text without tag parses; `what needs my attention` → `{agent, what, prompt, "needs my attention"}` (T6 step 9(c) decides it is not an agent); bad name → unknown.
**Done:** `npx vitest run app/test/slack/commands.test.ts` → all pass.

### T2 — bindings store, guard relaxation, config
**Goal:** bindings made from Slack survive restarts; `@herdr bind` works in an unbound channel or bot DM; config accepts the new mode.
**Files:** new `app/src/registry/bindings.ts`; `app/src/slack/guards.ts:84-98, 138-141`; `app/src/config/config.ts:30-60, 70-85, 211-228`; `app/src/daemon/run.ts:184-195`; tests `app/test/registry/bindings.test.ts`, `app/test/slack/guards.test.ts`, `app/test/slack/channel-bindings.test.ts`, `app/test/config/config.test.ts`.
**Steps:**
1. `bindings.ts`: `loadBindings(instance): Record<string,string> | undefined` (undefined = file absent; corrupt file → `{}`) and `saveBindings(instance, map)` → `stateDir(instance)/bindings.json`, mode 0600, parent 0700 (same pattern as `registry.ts:97-103`).
2. `run.ts`: after `resolveInstance`/`withCredentials` and before `new Surfaces`: `const saved = loadBindings(instance); if (saved) config.channelBindings = saved; else saveBindings(instance, config.channelBindings ?? {});` (D1).
3. `guards.ts` `checkInbound`: remove the line `if (ctx.surface === "mention" && !bound) return deny("channel_not_permitted")` (guards.ts:91). Binding is enforced per command in T6 (bind/unbind/help need none). The `conversation`/`dmOnly` check (guards.ts:92-94) stays; a `mention` surface is not subject to it, which lets `@herdr bind` and its select (B1) through in an unbound channel. In `authorizeAction`, skip the workspace comparison at guards.ts:138-141 only when `ctx.channel.startsWith("D")`; keep the C/G check for existing bound-channel cards. Never use a DM binding to gate card buttons.
4. `config.ts`: add `contextMessages?: number` to `InstanceConfig`, default 50 in `defaultInstance`; `validateInstance` rejects values < 1 or > 999 (Slack `conversations.history` max `limit`). Delete the rule at config.ts:226. Keep the `^[CG]` regex and one-workspace-per-channel rules for config-file entries. Slack-made bindings accept `C`/`G`/`D` and may share a workspace; load them after config-file validation.
**Tests:** load/save round trip with `D` and corrupt file; absent file → seeded from config; config-backed binding unbound then restart → stays unbound; `checkInbound` for a mention in an unbound channel is allowed, wrong team/not allowed/throttled still deny, `conversation` in an unbound `C` channel under `dmOnly` still denies (keep 100%); bound DM card action targeting another workspace is allowed, dead terminal/wrong team/offline still deny; bound C/G card targeting another workspace still denies (`channel-bindings.test.ts`); config test for the deleted rule and `contextMessages` bounds (0 and 1000 rejected, 999 accepted).
**Done:** `npx vitest run app/test/slack/guards.test.ts app/test/slack/channel-bindings.test.ts app/test/registry/bindings.test.ts app/test/config/config.test.ts` → pass; coverage for `guards.ts` 100% in `npm run check`.

### T3 — Slack history read + manifest
**Goal:** the daemon can read recent channel/thread messages; the manifest asks for the scopes and events.
**Files:** `app/src/slack/transport.ts` (interface, after `openModal` at transport.ts:46; `EphemeralInput` at transport.ts:62-67; `parseActionPayload` at transport.ts:228-241), `app/src/slack/socket-transport.ts`, `app/src/slack/web-api-transport.ts`, `app/src/slack/dry-run-transport.ts`, `app/test/helpers/fake-transport.ts`, `app/src/slack/manifest.ts:9-24, 139-146`, `app/test/slack/manifest.test.ts`, `app/test/slack/action-payload.test.ts`.
**Steps:**
1. `SlackTransport.history(channel, opts: { threadTs?: string; limit: number }): Promise<HistoryMessage[]>` where `HistoryMessage = { user?: string; text: string; ts: string; botId?: string; subtype?: string }`. Socket/WebApi: `conversations.replies` when `threadTs` else `conversations.history`, one call, `limit` as given (≤ 999), map fields with the `str` guard. A Slack `not_in_channel` error is thrown as `Error("not_in_channel")`. Dry-run returns `[]`. Fake gets `historyMessages: HistoryMessage[] = []` and `historyError?: string`; its `history()` throws `Error(historyError)` when set, else returns the messages.
1a. `EphemeralInput.blocks?: unknown[]` (F1). Socket (socket-transport.ts:273) and WebApi (web-api-transport.ts:91) pass `blocks` when present; dry-run records them; fake `ephemerals` entries keep them.
1b. `parseActionPayload` (F2): `value = str(action.value) || str(action.selected_option?.value)` via `asRecord`, so a `static_select` click yields the chosen option.
2. `manifest.ts`: add scopes `channels:history`, `groups:history`; events `message.channels`, `message.groups`; `SCOPE_REASON` entries. Update `manifest.test.ts` expectations.
3. Note in the task result: the user must re-install the Slack app after a scope change (manual step; `doctor` already reports `missing_scope`).
**Tests:** manifest lists the new scopes/events; fake transport returns its seeded `historyMessages`; `action-payload.test.ts` parses a real `static_select` `block_actions` payload (`selected_option.value`, no `value`) and a button payload unchanged.
**Done:** `npx vitest run app/test/slack/manifest.test.ts` → pass; `npm run typecheck` clean (all transports implement the method).

### T4 — turn origin and origin-routed reply
**Goal:** a settled turn posts its reply where the prompt came from, once, and remembers the thread it can be answered in.
**Files:** `app/src/registry/registry.ts:7-27, 29-70, 206-230`; `app/src/slack/session-controller.ts:250-336`; `app/src/slack/surfaces.ts:244-270, 325-335`; tests `app/test/registry/registry.test.ts`, `app/test/slack/session-controller.test.ts`.
**Steps:**
1. `SessionTurn.origin?: { channel: string; threadTs?: string }`. `SessionRecord.replyPosts?: { channel: string; ts: string }[]` (cap 20, newest last, no duplicates). `startTurn(..., origin?)`; `updateTurn` Pick gains `origin`, and its settled-turn rebuild (registry.ts:206-216) keeps `origin` like `notifiedAt`. Add `terminalForReplyPost(channel, ts)` scan (same style as `terminalForThread`, surfaces.ts:933-939) and `addReplyPost(terminalId, channel, ts)`.
2. `announceReply`: if `turn.origin` → post to `origin.channel` with `threadTs: origin.threadTs` (top-level when absent), text `replyNotice(...)`, blocks `responseSections(turn.response, "*Replied*")`; then `addReplyPost(terminalId, origin.channel, origin.threadTs ?? posted.ts)`; `registry.save()`. Else keep today's card-thread post. Guard `record.ended` stays; drop the `!record.slackThreadTs` requirement when `turn.origin` exists.
3. `refreshResponse` (session-controller.ts:258) and `#onTransition` (surfaces.ts:252) and `#scheduleCursorIdlePost` (surfaces.ts:329-331): proceed when the record has a card **or** an active turn with `origin`. `updateCard` already no-ops without a card.
**Tests:** `updateTurn(id, {status:"done", response, completedAt})` keeps `origin`; turn with origin → one post to origin channel (top-level), `replyPosts` has the posted ts, second settle does not re-post (claim); origin with threadTs → threaded post and `replyPosts` holds the thread root, not the child ts; turn without origin → unchanged card-thread behaviour (existing tests stay green); `terminalForReplyPost` miss → undefined.
**Done:** `npx vitest run app/test/registry app/test/slack/session-controller.test.ts` → pass.

### T5 — `cre` kind, typed launch, rename, reserved names (after T0)
**Goal:** `cre` launchable from Slack by typing into a fresh pane; the agent gets the requested name; reserved names refused.
**Files:** `app/src/agents/catalog.ts:36-50, 80-110, 115-127`; `app/src/agents/launcher.ts:12-30, 101-150`; `app/src/herdr/types.ts:105-120` (`AgentInfo.name?: string`); `app/src/herdr/state.ts:93-115` (name map); tests `app/test/agents/catalog.test.ts`, `app/test/agents/launcher.test.ts`, `app/test/herdr/state.test.ts`.
**Steps:**
1. `AgentEntry.command?: string`. `SEED_CATALOG` += `{ kind:"cre", label:"CRE", modes:[DEFAULT_MODE], command:"cre" }`. `loadCatalog` (catalog.ts:115-127) appends seed entries that carry `command` and are not in `AGENT_KINDS`, so `cre` survives. `readUserCatalog` unchanged (no TOML parsing for `command`).
2. `launcher.ts`: `LaunchRequest.command?: string`. When set: skip `agent.start`; after `waitForShell`, send `${command}\n` to the pane with the method T0 step 1 recorded; `waitForAgentReady`; then `agent.rename {target: paneId, name}` through `startWithFreeName` (so a taken name walks to `-2` as today). Everything after (`waitForInputReady`, `promptWithRetry`) is shared with the `agent.start` path. Callers (`#launchFromModal`, `#runLaunch`) pass `command: entry?.command`.
3. `state.ts`: `applySnapshot` records `agents[].name` by `terminal_id`; `nameOf(terminalId): string | undefined`; cleared on `#removeTerminal`. (Names refresh on every reconcile, 30 s, and on `tail.reconcile()` which T6 calls right after a launch.)
4. `launchAgent` refuses `request.name` in `RESERVED` (import from T1) with `{ ok:false, message:"<name> is a command word; pick another name." }` before `tab.create`. `sanitizeAgentName` unchanged.
**Tests:** `cre` survives `loadCatalog`; launcher with `command` sends the typed text and `agent.rename` and never `agent.start` (FakeHerdr records requests); rename on a taken name walks to `name-2`; reserved name refused before `tab.create`; `state.nameOf` after a snapshot.
**Done:** `npx vitest run app/test/agents app/test/herdr` → pass.

### T6 — Surfaces wiring (the feature)
**Goal:** all mention commands, reply-to-agent, origin routing, trust chain.
**Files:** `app/src/slack/surfaces.ts` (replace `#mention`/`#mentionCommand` 1102-1208; `onMessage` 155-182; `#onAction` chrome branch 802-810 and the foreign refusal at 821; `#onViewSubmit` 395-402; `#launchFromModal` 555-620; `#openNewAgentModal`/`#renderNewAgentModal` 416-450; `#submitTurn` 1076-1100; `#scheduleChannel` 1209); `app/src/slack/modals.ts:130-260, 389-440` (locked workspace + JSON private_metadata); `app/src/slack/session-controller.ts` (add `interrupt(terminalId)` and `clear(terminalId)` next to `chooseMenuOption`, using the two constants from D7); `app/src/slack/home.ts` (Home's `＋ New agent` passes JSON metadata); tests `app/test/slack/surfaces-channel.test.ts` (rewrite), `app/test/slack/modals.test.ts`.
**Depends on:** T1–T5, and T7 step 1 (types).
**Steps:**
1. **Guard chain per mention** (in order, each failure → ephemeral with `decision.message` to the sender, nothing else): `#markMessageSeen` (duplicate → return silently) → `checkInbound` once → `parseMention` → for every command except `bind|unbind|help`: channel must be bound (`config.channelBindings[ctx.channel]`, else ephemeral `DENY_TEXT.channel_not_permitted`) → for agent verbs: `requireHerdr` → resolve name inside the bound workspace: local = `state.agentPanes()` where `state.nameOf(pane.terminal_id) === name && pane.workspace_id === workspaceId` (a miss is "No agent called *name* here"; a pane that vanished between lookup and send is reported by `sessions.prompt`'s own failure); foreign = peer heartbeat agents by `name` + `workspaceId`. No `authorizeAction` (D9).
2. **bind:** in `C`/`G` channels and bot DMs (`D`) (D8); elsewhere ephemeral refusal. Ephemeral in `ctx.channel` with one `static_select` (`action_id: channel_bind_select`), options = every herd's workspaces from `herd.homeHerds()` + `herd.launchOptionsFor(herdId)?.workspaces` (local falls back to `state.workspaces`), label `"<herd label> / <workspace label>"`, value `encodeHerdRef(herdId, workspaceId, local)`, through `capOptions`; zero options → ephemeral "No workspaces reported yet." In `#onAction`, handle `channel_bind_select` and `channel_new_agent` in the chrome branch (before ref routing) under `checkInbound({ ...ctx, surface: "mention" })` — the same exemption the mention itself has, so the click is not denied by the `dmOnly` rule in an unbound channel (B1). On select: `config.channelBindings[ctx.channel] = value; saveBindings(instance, config.channelBindings); ephemeral "Bound to …"`. **unbind:** delete key, save, confirm. One workspace may be bound by several channels.
3. **agents:** post in channel (threaded under the mention like today's `reply` helper): `name · kind · status`, max 20 rows; local rows from `state.agentPanes()` in the bound workspace with `state.nameOf`, foreign rows from the heartbeat (`name` + `workspaceId`, T7).
4. **help:** one message listing the commands.
5. **new:** ephemeral with button `channel_new_agent` (value = channel). Click → `#herdReachable(herdId)` (surfaces.ts:884) else the Home ephemeral "That herd is not reachable right now…" and no modal → `#openNewAgentModal(triggerId, herdId, { workspaceId, channel, threadTs })`; `buildNewAgentModal` renders the locked workspace as a context line, omits the workspace select, defaults `kind` to `cre`, and writes `private_metadata = JSON.stringify({herdId, workspaceId?, channel?, threadTs?})`. Home's `＋ New agent` writes `JSON.stringify({herdId})`. `parseNewAgentSubmission` parses JSON only; a non-JSON or empty string → `herdId` absent (no bare-string fallback). On submit (`#launchFromModal`): when metadata has `channel`, use it (not `#replyChannel`, which picks the DM, surfaces.ts:398) for the outcome ephemerals and as origin `{channel, threadTs}`; force `workspaceId` from metadata when present; after `launchAgent` ok: `await tail.reconcile(); reconcileSessions();` then `terminalId = state.terminalByPane.get(result.paneId)`; if a first prompt was delivered → `startTurn(terminalId, firstPrompt, "", origin)` so the first reply lands in the channel. Foreign herd → existing `#forwardLaunch` with the origin `channel` and `threadTs` in the command (T7 satellite does the same turn start).
6. **prompt:** `#submitTurn(terminalId, text, origin?)` — with `origin` set: skip the busy refusal; if `activeTurn` exists → `updateTurn(id, {origin})` (steer) else `startTurn(..., origin)`; send via `sessions.prompt`. Foreign → `herd.forwardCommand({op:"prompt", herdId, ref, text, channel, threadTs})`. Origin = `{channel: ctx.channel, threadTs: ctx.threadTs}`.
7. **context:** `transport.history(ctx.channel, {threadTs: ctx.threadTs, limit: config.contextMessages})` → keep messages where `!botId && !subtype && user && allowedUsers.includes(user) && ts !== ctx.ts` → oldest first → `redact(text).text` each → `"Recent Slack messages:\n<@U>: …\n…\n\nRequest:\n<text>"` → same path as prompt. Empty history → plain prompt. `history` throws `not_in_channel` → ephemeral "Invite @herdr to this channel so it can read messages." and no prompt.
8. **stop:** `sessions.interrupt(terminalId)` → `client.sendKeys(pane, INTERRUPT_KEYS)`; no turn change; ephemeral "Sent interrupt." **clear:** `sessions.clear(terminalId)` → delivers `CLEAR_PROMPT` by the method T0 step 6 recorded, no turn. Foreign → ops `stop` / `clear` (T7).
9. **onMessage** (surfaces.ts:155-182): (a) first, before any `checkInbound`: if `text.trimStart()` starts with `<@BOT>` → `#mention({ ...ctx, surface: "mention" }, text)` and return, in every channel type. `#mention` dedupes on `channel:ts` before its one `checkInbound` (step 1), and `app_mention` and `message.*` share the `ts`, so the first event is handled and the other is dropped at no throttle cost (B2, R1). Else `checkInbound` as today. (b) `#markMessageSeen`; if `ctx.threadTs` and `registry.terminalForReplyPost(ctx.channel, ctx.threadTs)` → local prompt with origin `{channel, threadTs}` through step 1's herdr/live/workspace checks; else if a peer snapshot's `replyPosts` contains `{channel, threadTs}` → forward `prompt` to that herd (T7). (c) else if channel is a DM → `parseMention(text)`; `unknown` → existing `#handleBareMessage`; an `agent` result whose name has no agent in the DM's bound workspace (or an unbound DM) → `#handleBareMessage` (R6); any other result → the step-1 command handler (so `help` and `bind` work). (d) else return silently. Remove the two "Use *Reply* on the session card" ephemerals.
10. `#scheduleChannel` (surfaces.ts:1209): first line `if (!this.deps.config.creOnly) return;` so `#syncChannel`/`#syncBoundPanes`/`#retireMovedThread`/`#detachInvalidThreads` run only for the old attach mode (B3). Drop the `#scheduleChannel()` call from the old `#mentionCommand` with the rewrite.
11. Log lines: `channel.bind`, `channel.unbind`, `channel.prompt terminal=… origin=…`, `channel.denied reason=…` — no message text in logs (invariant 7).
**Tests (rewrite `surfaces-channel.test.ts`, `creOnly:false`):** happy paths for each command; negative: non-allowlisted user ignored (no post, no ephemeral); wrong team ignored; unbound channel `@herdr agents` → ephemeral refusal; `bind` in unbound `C` channel works under `dmOnly:true`; `bind`/`unbind` in a DM work, and DM binding survives restart; a bound DM `@herdr <name> hi` posts the settled reply in that DM, while another-workspace name is refused; a bound DM card button for another workspace still works; an unbound DM agent verb is refused; `channel_bind_select` click from a non-allowlisted user denied; same mention delivered as `message` then `app_mention`, and as `app_mention` then `message` → exactly one `agent.prompt` on FakeHerdr in both orders, and at the throttle limit (29 earlier hits) the pair is allowed and costs one hit in both orders; `@herdr x hi` for an agent in another workspace → refusal, no request; dead terminal → no request; herdr offline → `herdr_offline` and no `agent.prompt`; one mention → throttle counted once (31st mention in a minute denied, 30th allowed); busy agent → prompt sent, same turn id, origin updated; settled turn → one post in the channel, second settle none; thread reply on the posted reply → `agent.prompt`; thread reply on a satellite reply post → `forwardCommand` prompt; thread reply elsewhere → no request, no ephemeral; `context` skips `bot_id`, non-allowlisted, the command itself, and redacts a token; `context` with fake `historyError = "not_in_channel"` → refusal ephemeral, no `agent.prompt`; the `bind` ephemeral carries a `static_select` block and the `new` ephemeral carries a `channel_new_agent` button block (F1); `stop` sends `agent.send_keys` with `["esc"]`; `clear` sends `/clear` without a new turn; `new` → ephemeral with button → click → modal with locked workspace and origin channel in JSON `private_metadata`; click with local herdr offline, and with a foreign herd offline → ephemeral, no modal; channel-origin submit, local and forwarded → outcome ephemeral and first reply in the origin channel, not the DM; Home submit with `{"herdId":…}` still launches; submit with reserved label → refusal; with `creOnly:false` and a binding, no session card is posted into the channel; DM bare `help` answers, DM `what needs my attention` still reaches `#handleBareMessage`, DM bare `build hi` with an agent `build` in the bound workspace → `agent.prompt`; after a DM bind, a card button for a foreign-herd agent still forwards (surfaces.ts:821).
**Done:** `npx vitest run app/test/slack` → pass; `npm run check` → exit 0.

### T7 — herd queue: new ops and snapshot fields
**Goal:** foreign-herd agents accept prompt/stop/clear from a bound channel, reply to the origin, and the primary can route a thread reply on a satellite's post.
**Files:** `app/src/daemon/herd-registry.ts:40-49, 85-110`; `app/src/daemon/herd-bridge.ts:343-366, 384-470`; `app/src/slack/herd-port.ts:29-37`; `app/test/daemon/herd-registry.test.ts`; satellite tests in `app/test/daemon/herd-bridge.test.ts` (use `helpers/fake-herd.ts`).
**Depends on:** T4, T5 (for `state.nameOf`). Step 1 lands before T6 starts; the rest runs beside T6.
**Steps:**
1. `HerdCommandOp` += `"stop" | "clear"`; `HerdCommand.threadTs?: string` (and on `forwardCommand` input). `HerdAgentSnapshot` += `name: string`, `workspaceId: string`, `replyPosts?: {channel: string; ts: string}[]` (fill in `#snapshotAgents` from `state.nameOf`, `pane.workspace_id`, `record.replyPosts`). All still pass through `seal`/`unseal` (invariant 11; no new record type). Why the snapshot: the satellite posts its own reply (run.ts:180-184 gives it a `WebApiTransport` and its own `SessionController`), so only its registry knows the ts; the primary learns it from the heartbeat.
2. `#runCommand`: `prompt` → `startTurn(terminalId, text, baseline, {channel: command.channel, threadTs})` (steer when a turn is active, as T6 step 6); `stop` → `sessions.interrupt(terminalId)`; `clear` → `sessions.clear(terminalId)`. `#runLaunch`: after ok + firstPrompt delivered → `reconcileSessions`-equivalent upsert via the attached sessions, then `startTurn` with origin `{channel: command.channel, threadTs: command.threadTs}` (mirror of T6 step 5; F3).
3. Satellite reply posting already works: `WebApiTransport.postMessage` (web-api-transport.ts:52) + T4 `announceReply`.
**Tests:** forged/unsigned command still dropped (existing); `stop` op → `agent.send_keys`; `prompt` op with threadTs records origin; `launch_agent` op with `threadTs` and a first prompt → turn origin keeps `threadTs` (F3); snapshot carries `name`/`workspaceId`/`replyPosts` and survives `seal`/`unseal`.
**Done:** `npx vitest run app/test/daemon` → pass.

### T8 — AGENTS.md interaction model rewrite
**Goal:** the convention file matches the shipped behaviour.
**Files:** `AGENTS.md` "Interaction model" section only; invariant 3 gains `bind/unbind/agents/new/<name> verbs`.
**Steps:** remove "Prompts enter only through the Reply modal" and the session-card-as-the-model bullets; add: channel (`C`/`G`) or bot DM (`D`) = binding unit, bound-DM prompts reply in that DM, one mention grammar (list the commands), reserved words, origin routing with one reply post per settled turn, reply-to-agent via thread on a posted reply, steer semantics, trust chain order (one `checkInbound` per mention), `context` only from allowlisted humans and redacted, no `trigger_id` on mentions → `new` is a button, `app_mention` + `message.*` share a `ts` so tagged messages route to one handler, the old channel card sync is `creOnly`-only. Keep multi-herd and Block Kit bullets. Mention that `CHANNEL_WORKSPACES.md` describes the older `creOnly` attach mode.
**Done:** review read; `npm run check` unaffected.

### T9 — integration gate
1. `npm run check` → exit 0, coverage ≥ 80%, `guards.ts` 100%.
2. Live QA (manual, needs the re-installed Slack app and herdr): in a private channel: `@herdr bind` → pick → `@herdr new` → start cre with a first prompt → reply appears in channel → thread-reply on it → agent continues → `@herdr <name> context summarise` → `@herdr <name> stop` → `@herdr <name> clear` → `@herdr agents` → `@herdr unbind`. In the bot DM: `help` and `@herdr help` answer; `what needs my attention` still gives the herd summary; `@herdr bind` → pick → `@herdr new` → start an agent with a first prompt → reply appears in DM → `@herdr <name> hi` → reply appears in DM → `@herdr unbind`; a card button for an agent in another workspace still works. Record pass/fail per step in the task result.

## 3. Dependency graph

```
T0 (spike) ──► T5 ──┐
T1 ─────────────────┤
T2 ─────────────────┼──► T6 ──► T8 ──► T9
T3 ─────────────────┤
T4 ──► T7 (step 1) ─┘
       T7 (rest) runs beside T6
```
T0, T1, T2, T3, T4 run in parallel (disjoint files, no shared interface until T6). T7 step 1 (types) lands before T6 so T6 typechecks; the rest of T7 runs beside T6. Integration review after T6+T7, before T8.

## 4. Feasibility risks found in code (with pointers)

| Risk | Where | Handling |
|---|---|---|
| `app_mention` has no `trigger_id`; modals need one. | socket-transport.ts:336-356 passes none; `openModal(triggerId, …)` transport.ts:46 | D2: ephemeral button. |
| `agent.start` has no command override; `cre` is not a herdr kind; `loadCatalog` maps only `AGENT_KINDS`. | `AgentStartParams = {name, kind, pane_id, args?, timeout_ms?}` (live schema); catalog.ts:11-33, 115-127; launcher.ts:139-145 | D7 + T5: type `cre⏎` into the pane, then `agent.rename`. |
| No `name` on the local `AgentInfo` type; wire has it. | herdr/types.ts:105-120 | T5 step 3 adds it and a `State` map; T0 step 2 confirms it is in the snapshot. |
| Interrupt key name. | herdr/keys.ts:1-7 only vouches for digits | `esc` (canonical per reviewer); T0 step 6 confirms. |
| `agent.prompt` may paste `/clear` instead of running it. | — | T0 step 6 records the working delivery; `sessions.clear` uses it. |
| `channelBindings` forces `creOnly`, `creOnly` forces pinned roots, both block launch and gate all surfaces. | config.ts:226-228; surfaces.ts:395, 560, 862, 1039, 1177; cre-roots.ts:11-12 | D3 deletes config.ts:226; new flow is `creOnly=false`; `creOnly` untouched. |
| With `creOnly=false` and any binding, `#scheduleChannel` → `#syncBoundPanes` posts a session card for every agent in the bound workspace. | surfaces.ts:1209-1290 | T6 step 10: gate on `creOnly`. |
| Mentions in unbound channels are denied before any command runs → `bind` impossible. | guards.ts:91 | T2 step 3. |
| The bind select's `block_actions` arrives as surface `conversation`; `dmOnly` denies it in an unbound `C` channel. | guards.ts:92-94 | T6 step 2: handle the two bind action ids with `surface: "mention"`. |
| `app_mention` and `message.channels` fire for the same message with the same `ts`; dedupe keys on `channel:ts`. | surfaces.ts:305-313; transport.ts:201-205 | T6 step 9(a): tagged text routes to `#mention` from both events; test both orders. |
| `authorizeAction` calls `checkInbound` again → two throttle hits per mention. | guards.ts:97, 128 | D9: mentions do not call `authorizeAction`. |
| A bound DM would make `authorizeAction` deny card buttons for agents outside that workspace. | guards.ts:138-141; session-controller.ts:103-110 | D8/T2: skip the workspace comparison only for `D`; preserve the old bound C/G card check; T6 scopes mention/text commands to the bound workspace. |
| A user's thread reply carries `thread_ts` = root; a reply posted as a thread child would not match. | — | D5: record `origin.threadTs ?? posted.ts`. |
| Satellite posts its own reply; the primary cannot resolve a thread reply to it. | run.ts:180-184 | T7 step 1: `replyPosts` in the sealed heartbeat snapshot. |
| Foreign-herd actions from a bound channel are silently dropped. | surfaces.ts:821 | T6 routes mention commands itself. T6 changes the check to bound `C`/`G` channels only, so a DM bind keeps foreign card buttons (D8). |
| Modal submit has no channel; `#replyChannel` picks the DM. | surfaces.ts:398, 1371-1375 | T6 step 5: origin channel rides in `private_metadata`. |
| `message.channels` makes `onMessage` fire for every channel message → today's handler posts a "use Reply" ephemeral per message. | surfaces.ts:155-182 | T6 step 9(d) (silent default). |
| Transitions/replies are gated on a card thread. | surfaces.ts:252, 329-331; session-controller.ts:258, 304 | T4 step 3. |
| Busy refusal blocks steer. | surfaces.ts:1082-1084 | T6 step 6. |
| Scope change needs app re-install; cannot be automated. | manifest.ts:9-24 | Manual step noted in T3. |
| Slack `conversations.history` max `limit` 999; Tier 3 rate. One call per `context`; `RateBudget` covers posts only. Internal custom apps are exempt from the 2025 non-Marketplace history limit. | docs.slack.dev changelog 2025-05-29 | `contextMessages` ≤ 999 (T2). Acceptable. |
| Bot not in the channel → `not_in_channel` on history. | docs.slack.dev conversations.history | T3 step 1 + T6 step 7: refusal ephemeral, no prompt. |
| Ephemerals cannot carry blocks; a select sends `selected_option.value`, not `value`. | transport.ts:62-67, 238; socket-transport.ts:273 | T3 steps 1a/1b. |
| Shared channel: anyone in the channel reads agent output; only allowlisted users can drive. | existing SECURITY.md stance | Unchanged; `context` reads only allowlisted humans. |

## 5. Out of scope (not built)

- Removing App Home, session cards, Reply/Earlier/End modals, or `creOnly` mode.
- Per-agent threads, running-status cards in channels, "agent exited" notices in channels.
- Reading non-allowlisted users' messages into `context`; attachments; files.
- Workspace or herd pickers inside the launch modal (locked by binding).
- Any new config knob beyond `contextMessages`; any catalog field beyond `command` on the seeded `cre` entry; per-kind stop keys or clear prompts; `command` in `agents.toml`.
- Rewriting README, QA.md, SECURITY.md, CHANNEL_WORKSPACES.md (flagged as stale follow-ups).
- Cross-herd `context` beyond passing the composed text as a `prompt` op.

## 6. Open decisions (default stated)

- **OPEN-1** `new` is the approved ephemeral button + modal flow (D2). No alternative.
- **OPEN-2** If T0 step 2 finds no `name` in the subscribe snapshot, `State` refreshes names from `agent.list` on reconcile instead. Supervisor decision at that point.
- **OPEN-3** If T0 step 3 finds no pane-level text input method, `cre` cannot be launched from Slack; the plan then ships `new` for herdr-native kinds only (default `claude`) and cre stays keyboard-launched. Supervisor decision at that point.

## Spike results (T0 fills in)

_pending_

## Review log

| Finding | Resolution |
|---|---|
| S1 | T6 step 9(c): DM bare text goes through `parseMention`; `#handleBareMessage` only on `unknown`. T1 tests include a bare DM phrase → unknown. |
| S2 | D7: `stop_keys`/`clear_prompt` dropped (catalog, TOML, example, lookup). Two constants in `session-controller.ts`; `sessions.interrupt`/`sessions.clear`. T7 no longer depends on T5 for them. |
| S3 | D7 states the real list: `contextMessages` (config) and `AgentEntry.command?` on the seeded `cre` entry only. |
| S4 | T6 step 5: `tail.reconcile()` + `reconcileSessions()` then `startTurn`; no hand upsert. |
| S5 | T6 step 5: JSON `private_metadata` for Home and channel; `parseNewAgentSubmission` has no bare-string fallback; Home test added. |
| S6 | OPEN-1 keeps the button-to-modal flow; text-form recommendation deleted. |
| S7 | T3 step 1: dry-run returns `[]`; only `fake-transport.ts` gets a `history` field. |
| B1 | T6 step 2: `channel_bind_select`/`channel_new_agent` are checked with `surface: "mention"` (same exemption as the mention after T2 step 3). `guards.ts` unchanged beyond T2. Negative test for a non-allowlisted click. |
| B2 | T6 step 9(a): `onMessage` routes text starting with `<@BOT>` to `#mention` with the mention surface in every channel type; `#markMessageSeen` on `channel:ts` makes it exactly-once. Test both arrival orders. |
| B3 | T6 step 10: `#scheduleChannel` returns early unless `creOnly` (one line; keeps the old attach mode, which D3 promised). Test: binding + `creOnly:false` → no card posted. |
| m1 | D7/T5: branch A removed; typed `cre⏎` only. T0 step 1 records the method name. |
| m2 | D4/T5 step 2: `agent.rename` after detection, via `startWithFreeName`. Tab-label fallback dropped. |
| m3 | `esc` everywhere (D7, T0 step 6, T6 tests). |
| m4 | D8/T2/T6: bot DMs bind and unbind like channels; bound-DM agent commands resolve only in that workspace, and their replies post to the DM. Exempt `D` card buttons from `authorizeAction`'s workspace check; preserve the old C/G check and `shared` logic at session-controller.ts:103-110. OPEN-4 removed. |
| m5 | D5/T4 step 2: `addReplyPost(..., origin.threadTs ?? posted.ts)`; test asserts the root ts. |
| m6 | Verified: run.ts:180-184 gives the satellite its own `WebApiTransport` + `Surfaces`/`SessionController`, so the satellite posts its reply and the primary never sees the ts. T7 step 1 adds `replyPosts` to the sealed `HerdAgentSnapshot`; T6 step 9(b) falls back to peer snapshots and forwards `prompt` with `threadTs`. |
| m7 | D9/T6 step 1: one `checkInbound`, then `requireHerdr`, then inline name → terminal + workspace checks; no `authorizeAction`. Test: 30 mentions allowed, 31st denied. |
| m8 | `contextMessages` max 999 (T2 step 4, T3 step 1, risk table). |
| m9 | transport.ts:46; socket-transport.ts:336-356; `terminalForThread` at surfaces.ts:933-939; `#onAction` chrome branch at 802-810; `#markMessageSeen` at 305-313. |
| R1 | D9/T6 steps 1, 9(a): dedupe before the single `checkInbound`; tagged `message` text skips the `onMessage` check. Test both orders at the throttle limit. |
| R2 | T4 step 1: the settled branch at registry.ts:206-216 keeps `origin`; test a full settle. |
| R3 | D8/T6 tests: surfaces.ts:821 refusal only for bound `C`/`G`; test foreign card button after DM bind. |
| R4 | T6 step 5: `{herdId, workspaceId?, channel?, threadTs?}` metadata; submit uses it over `#replyChannel` for local and forwarded launch; both tested. |
| R5 | D1/T2 steps 1-2: `bindings.json` authoritative, seeded once from config. No tombstones. Restart test. |
| R6 | T1 test corrected (bare phrase parses as an agent command); T6 step 9(c) falls back to `#handleBareMessage` when the name has no agent in the bound workspace. Both tested. |
| R7 | T6 step 5: click reuses `#herdReachable` (surfaces.ts:884); offline local and foreign tested. |
| R8 | Settled (round 3): a bot token with `channels:history`/`groups:history`/`im:history` is enough for `conversations.history` and `conversations.replies` in conversations the bot is a member of; otherwise `not_in_channel` (https://docs.slack.dev/reference/methods/conversations.history, https://docs.slack.dev/messaging/retrieving-messages#pulling_threads). Internal custom apps are exempt from the 2025 non-Marketplace rate limit (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps). No user token. T0 step 9 removed; step 8 kept as the one live smoke check. |
| R9 | T3: fake field is `historyMessages`. |
| F1 (r3) | T3 step 1a: optional `blocks` on `EphemeralInput` in all four transports; T6 tests assert the select and button blocks. |
| F2 (r3) | T3 step 1b: `parseActionPayload` reads `selected_option.value`; real `static_select` payload test. |
| F3 (r3) | T7 step 2: satellite `#runLaunch` (herd-bridge.ts:444) origin keeps `command.threadTs`; thread-launch test. |
| F4 (r3) | R8 settled by docs; T0 step 9 removed; `not_in_channel` → refusal ephemeral, no prompt (T3 step 1, T6 step 7), tested. |
| T0 open | Step 6 checks `/clear` under `agent.prompt` and records the working delivery. Step 7 records whether `app_mention` fires in DMs; after B2 it no longer changes behaviour. |
