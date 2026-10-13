# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately via
[GitHub Security Advisories](https://github.com/egemenyildiz/herdr-slack/security/advisories/new).

Expect an acknowledgement within a few days. This is a small project — if a fix is going to take a
while, you'll be told that rather than left waiting.

## What this tool actually does

Read this before installing it. herdr-slack lets messages in Slack **type into terminals on your
machine**, so Slack access is terminal access. Two distinct risks:

### 1. Who can act

Anyone able to act through the bot can run commands as you. Mitigations, all on by default:

- **Allowlist is mandatory.** The daemon refuses to start with an empty `allowedUsers`.
- **Team pinning.** Payloads whose `team_id` doesn't match the workspace you set up are rejected.
- **DM-only.** Conversations outside a DM are refused; there is no channel-feed path.
- **Opaque refs.** Interactive payloads carry a random reference resolved server-side; a crafted
  payload cannot name an arbitrary pane. Unknown or dead refs fail closed.
- **herdr must be reachable.** When the Unix socket is down (or the machine is asleep and the
  daemon cannot talk to Slack), session and Home controls are omitted and mutating actions are
  refused. There is no wake-from-Slack — keep the computer awake to drive agents from a phone.
- **Confirmation on the one destructive control.** *End session* closes the pane, so it is gated by a
  Slack confirm dialog that names that consequence. The pane id is resolved from `terminal_id` at
  click time, so a moved pane cannot make it land on a different terminal.
- **Inbound actions are logged** to `daemon.log` as ndjson (user id, action, outcome — never terminal
  content or tokens).
- **Credentials live in the OS keychain** (macOS Keychain, or libsecret on Linux) when one is
  available. `config.json` then contains no secrets at all — only workspace and app identifiers.
  Where no keychain exists, tokens fall back to `config.json`, which the daemon refuses to load
  unless it is 0600. `doctor` tells you which of the two is in use.
- **Nothing reads your clipboard.** Tokens are pasted at an explicit prompt, with terminal echo
  suppressed. Setup may *write* the app manifest to the clipboard; it never polls or reads it.
- **Allowlist is Slack member IDs only.** Handles and display names are rejected. `users:read` is
  used only to show usernames in `context` transcripts (one `users.info` per member ID, no roster
  listing); a name never grants access.

### 2. What leaves your machine

Extracted agent responses shown on session cards are **terminal output sent to Slack's servers**,
where it is retained, indexed for search, and — on a corporate workspace — **exportable by workspace
admins**. Piping work agents into an employer's Slack can put source code, `.env` contents, and stray
API keys into an admin-readable store.

This is inherent to using Slack as the transport. It is disclosed at setup and mitigated, not hidden:

- **Redaction** of common secret shapes before anything is sent. Best-effort by nature — it is a
  pattern matcher, not a guarantee. Do not rely on it as your only control.
- **`contentMode`**: `full` (**default** — extracted responses leave the machine) · `summary`
  (status and detected prompts only, no free terminal text — **prefer this on work workspaces**) ·
  `titles`. Every control keeps working at every level.
- Only the latest extracted response and the last 20 Slack-started turns are retained; there is no
  live terminal mirror or transcript upload.
- **`excludePaths`**: working directories whose panes never render into Slack.

## Scope

In scope: authentication/authorization bypass, ref forgery or confusion, redaction bypass, secret
leakage into logs, anything letting a non-allowlisted user reach a terminal.

Out of scope: a workspace admin reading their own workspace's messages (that is Slack's model, see
above); an attacker who already has local access to your machine or your config file.

## Supported versions

Pre-1.0: only the latest release gets fixes.
