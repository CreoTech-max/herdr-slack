# AGENTS.md — contributor conventions

Update this file in any PR that changes a convention.

## Project

Slack control plane for a local [herdr](https://herdr.dev) instance. A daemon holds one outbound
Socket Mode connection to Slack and one Unix-socket connection to herdr. No inbound network listener.

Do not re-derive the herdr protocol from other plugins — use [herdr](https://herdr.dev) docs and a
live socket when verifying behaviour.

**Verified agents:** Claude and Cursor (manual + integration tests). Other kinds in the catalog are
best-effort until someone tests them.

## Toolchain

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 22; CI matrix 22 + 26 |
| Language | TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Lint + format | Biome |
| Tests | Vitest + v8 coverage |
| Hooks | Lefthook (`npm run prepare:dev` to repair) |
| Commits | Conventional Commits, squash-merge |

`npm run check` = lint + typecheck + test with coverage (same as CI).

## Invariants

Security-sensitive; breaking these is a security bug.

1. **Identity is `terminal_id`, never `pane_id`.** Resolve `ref → terminal_id → current pane_id` at
   action time; fail closed when the terminal is gone.
2. **Block Kit payloads carry only an opaque `ref`.** Never a pane id or terminal id.
3. **Fail closed** on unknown ref, dead terminal, wrong `team_id`, non-allowlisted user, exhausted
   throttle, or **target herdr not connected** (Reply / End / Refresh / Earlier / New agent /
   menu choices / bind / unbind / agents / named-agent verbs where herdr access is needed).
4. **Every outbound reply is redacted** (`redact.ts`) before registry storage or Slack. Pi/cre
   replies use the locally reported, validated session JSONL and a persisted pre-send turn boundary;
   verified directory and file identity persist with that boundary. Missing or changed sessions fail
   closed, never fall back to terminal scrollback. Same-OS-account processes are trusted; portable
   path checks do not provide atomic containment against a hostile same-account writer. Non-Pi agents
   retain the existing terminal extractor. Replies use mrkdwn sections (`responseSections`).
5. **No inbound listener.** Phone control requires the **machine awake** with herdr running — sleep
   freezes the daemon and Socket Mode; there is no wake-from-Slack path.
6. **Daemon reads `herdrSocketPath` from config**, not `HERDR_SOCKET_PATH` at runtime (except
   `setup` and `daemon ensure`).
7. **Secrets never in logs.** No terminal content in `daemon.log` except `--dry-run`.
8. **Credentials in OS keychain when available**; read via `withCredentials`.
9. **Never read the user's clipboard** (polling). Writing the setup manifest to the clipboard is
   allowed.
10. **Allowlist is Slack member IDs only** — no handle/display-name resolution for authorization.
    `users:read` exists only so `context` can show `users.info` usernames as display text, looked
    up per member ID after filtering; a missing or unsafe name falls back to the ID.
11. **Every herd-registry record is signed, and unverifiable records are dropped.** A shared registry
    directory is writable by other local accounts, and a queued command is *typed into a terminal* —
    so "can create a file there" must not mean "can drive your agents". The HMAC key derives from the
    Slack bot token (`herd-signing.ts`), which only daemons on that app hold. Never add a registry
    record type that skips `seal`/`unseal`.

## Interaction model

- A channel (`C`/`G`) or bot DM (`D`) binds to one herd workspace. Bound DM prompts reply in that DM.
  `CHANNEL_WORKSPACES.md` describes the older `creOnly` attach mode; channel card sync runs only there.
- `@herdr bind`, `unbind`, `agents`, `new`, `help`, and `<name> <prompt>` are the channel commands.
  `<name> context <prompt>`, `<name> stop`, and `<name> clear` are agent verbs. Command words are
  reserved agent names. A bound DM also accepts bare commands. Stop sends Esc; clear sends `/new`
  and restores the herdr agent name.
- Tagged `app_mention` and `message.*` deliveries share a `ts` and enter one deduplicated handler.
  Check team, allowlist and throttle once per mention before resolving a live named agent inside
  the bound workspace. Fail closed if the target herd is offline. `context` includes only recent
  messages from allowlisted humans and redacts them before a prompt reaches an agent.
- A mention has no `trigger_id`: `new` sends an ephemeral button that opens the locked-workspace
  modal on click. A settled turn posts one reply at its latest prompt origin in a channel, DM, or
  thread. A reply in that posted reply's thread prompts the same agent. A prompt to a busy agent
  steers the existing turn to its latest origin; it does not start a second turn.
- App Home and manual session cards remain supported. One card per agent updates in place; the
  **Reply** modal also sends prompts. **End session** = herdr `pane.close` (confirm-gated), not Esc.
  **Earlier** excludes the response already on the card; one prior turn per modal page. Settled
  card turns post one threaded reply notice (claimed by turn id); `chat.update` alone is silent.
- Shared Slack write budget is a **single** token bucket (`RateBudget`), not separate control/data
  lanes.
- When herdr is down, cards and Home **omit** interactive controls and refuse those actions — keep
  the machine awake to drive agents from Slack.
- **One Slack app may back many herdr sources** (same user, other OS user, remote). Exactly one
  daemon is primary and owns Socket Mode + App Home; the rest are satellites that publish neither
  and only write heartbeats into the shared `herdRegistryDir`. Two Socket Mode clients on one app
  race for interactions, and two Home publishers overwrite each other — so ownership is a file
  lock, not a convention.
- **Daemons discover each other; the registry path is not something a user has to get right.** Each
  one publishes a signed pointer to `<machine shared root>/peers` (`/Users/Shared/herdr-slack` on
  macOS, `/var/tmp/herdr-slack` elsewhere). A pointer from another herd on the same app means a
  shared registry is needed, and the daemon moves to `sharedRegistryDir()` and *stays* there — a
  sleeping peer must not send it back to a private directory only to split again on waking. Alone on
  a machine it keeps the private 0700 registry, so agent titles and cwds stay unreadable by other
  local accounts. `herdRegistryDir` still overrides everything, for registries on a network mount.
- **A pointer never says where to migrate to.** It answers "is anyone else here?" and nothing more;
  the destination is a constant. Pointers are signed like registry records and carry hashes rather
  than the app id and path, because that directory is writable and readable by every local account.
  This is why `herdRegistryDir` was a footgun worth removing: `setup` never wrote it, `reset` deleted
  it with the rest of the instance section, and each reinstall silently re-split the herds.
- **A live split warns and restarts, it does not fail closed.** Discovery runs at boot, so a daemon
  that spots a peer on a different registry logs `daemon.registry_split` and exits non-zero for the
  service manager. Refusing to run would leave Slack with no owner at all.
- **Ownership is only taken during election.** A satellite that claimed it mid-flight would demote
  the real primary on its next tick and leave Slack with no owner at all, so a satellite that sees no
  live owner exits non-zero and lets the service manager restart it into an election.
- **A failed heartbeat must not kill the daemon.** The shared registry can vanish between ticks
  (another account resets it, a tmp reaper, a wipe during QA). Every write re-ensures its parent
  directory, and `#tick` swallows I/O errors so they cannot escape as `unhandledRejection`. A stray
  rejection from anywhere else is logged and kept alive; only an `uncaughtException` exits 1, which
  is what launchd `KeepAlive={SuccessfulExit:false}` / systemd `Restart=on-failure` need in order to
  bring the process back. Intentional stops (`SIGINT`/`SIGTERM` via `daemon stop`) still exit 0 so
  the service manager does not bounce.
- Home is a **two-level view** when more than one herd reports in: an overview of herds with their
  agent counts, then one herd's agents. A single herd skips the overview.
- `Surfaces` depends on **`HerdPort`**, not on `HerdBridge`, so the multi-herd paths are testable
  without a registry directory or a second daemon.
- **＋ New agent lives inside a herd, never on the overview, and the form never asks which one.**
  Workspaces, worktrees and agent kinds all belong to one machine, so a launch has to start from one;
  putting the button only where a herd is already in view makes the target a fact rather than a
  question. It rides to submission in `private_metadata`. A picker was tried first and was worse: it
  is a question with one sensible answer, and it made the form's contents depend on a field inside
  itself.
- **A tab label is made unique before `tab.create`** (`freeTabLabel`), because herdr accepts
  duplicates and two tabs called "review" are indistinguishable in Home, in the terminal, and in
  thread titles. Agent *names* need no such care — herdr refuses a name in use and `launchAgent`
  walks to the next one. If herdr will not answer `tab.list`, launch with the label as asked: a
  duplicate is a much smaller problem than a refused launch.
- One New-agent modal view launches once per process: team, user and Slack view id identify its
  submissions. Ack each redelivery; validation errors let the same view submit again. Bound forms
  list only the selected workspace's worktrees, including signed peer options. Socket recycling
  waits for view acknowledgments and actual disconnect before it starts a replacement connection.

### Slack Block Kit facts that are not obvious

Each of these has cost a bug. Slack reports all of them the same unhelpful way.

- **An `input` block is silent.** No `block_actions` arrives when its value changes unless the block
  sets `dispatch_action: true`. This is why no field in a form may drive the contents of another one
  without that flag — and why the launch form now has no such field at all.
- **A `static_select` with zero options fails the whole view** as `invalid_blocks`, exactly like the
  100-option cap. Build option lists through `hasOptions`/`capOptions` and drop the block when it is
  empty — a peer herd that has not reported its workspaces yet is a normal state, not an error.
- **A failed `views.update` is invisible**: the skeleton keeps saying "Loading…" and the only way out
  is closing the modal. Go through `#updateModal`, which retries once and then says what happened.
- `views.update` replaces blocks wholesale, so anything already typed is gone. Prefer not re-rendering
  a form someone is filling in.

## Layout

```
app/src/
  herdr/     socket client, event tail, state projection
  registry/  terminal_id ↔ ref ↔ Slack card, persisted remote turns
  slack/     transport, turn cards/modals, response extraction, guards, redact
  agents/    agents.toml catalog, blocked-prompt menu parser
  config/    config, setup wizard, doctor
  daemon/    supervisor, service units, rate budget, multi-herd registry
app/test/    mirrors app/src
```

## Code

- ESM, `.js` extensions on relative imports.
- `import type` for type-only imports.
- No `any`. Parse untrusted input at boundaries with explicit guards.
- Errors: `HerdrError` / `SlackError` with a `code`; user-visible text, not stack traces.
- No side effects at import time.
- Prefer pure functions for `redact`, `response`, `menu`, `budget`, `state`.

### Slack `action_id` naming

`<surface>_<verb>[_<qualifier>]`, lowercase snake. The `ref` goes in `value` / `private_metadata`.

### Logging

`daemon.log` is ndjson, mode 0600, 5 MB × 3 rotation. Event names: `<area>.<thing>`, lowercase
snake.

## Testing

- Mirror source paths under `app/test/`.
- Fake herdr socket + stubbed Slack transport; no live credentials.
- Global coverage 80%; `slack/guards.ts` 100%.
- Security behaviour needs negative tests.
- Synthetic credentials in `app/test/helpers/fake-credentials.ts` must contain `EXAMPLE`.
