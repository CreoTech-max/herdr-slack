# Herdr Slack: CRE-only attach mode

This plugin binds one Slack channel to one Herdr workspace and exposes **only the pinned CRE root sessions** in that workspace. The CRE root is the personal `cre` executable from [cre-execution-harness](https://github.com/CreoTech-max/cre-execution-harness); Herdr recognizes that process as `pi`. A generic `pi` session is **not** a CRE root.

## Minimal deployment

1. Install the CRE executable using the harness's `scripts/install-personal-cre.sh`. Use an operator-approved, pinned release.
2. Inside Herdr, create/open the intended project workspace and manually launch the absolute CRE path (`~/.local/bin/cre`) in its terminal.
3. Install Herdr's Pi integration to the CRE profile: `PI_CODING_AGENT_DIR="$HOME/.pi/cre" herdr integration install pi`. Inspect the foreground executable, stable `terminal_id`, `workspace_id`, and native `agent_session.value` using Herdr. **Do not pin any ID until the executable's provenance has been checked.**
4. Configure the existing instance in `config.json` (replace the placeholders with *actual* Herdr IDs):

```json
{
  "allowedUsers": ["U0C93G42G00", "U0C8CR5CMSQ"],
  "dmOnly": true,
  "creOnly": true,
  "channelBindings": { "C0C8406M2NR": "HERDR_WORKSPACE_ID" },
  "creRoots": [
    { "workspaceId": "HERDR_WORKSPACE_ID", "terminalId": "HERDR_TERMINAL_ID", "sessionId": "NATIVE_PI_SESSION_ID" }
  ]
}
```

5. Enable Slack `app_mentions:read` and `app_mention` event and reauthorize the Slack app. Invite Herdr into the channel. Restart the plugin service after configuration changes. Pin Slack workspace/team and only the two known Slack operator IDs as usual.
6. Disable automatic Herdr Pi resume until the restored executable/profile are verified: `[session] resume_agents_on_restore = false`. After a restart, recheck the CRE process/session identity and update pins explicitly.

## Commands

- `@Herdr agents`, `@Herdr status`, `@Herdr blocked` list **only** verified CRE roots in the bound workspace.
- Once the bridge creates the root's thread, `@Herdr <instruction>` inside that thread forwards one turn via Herdr `agent.prompt`. Either authorized user can reply.
- Home shows attached, pinned roots only, with Reply, Refresh and history. End session and generic New agent are disabled in CRE-only mode.
- To start another root, use the actual personal `cre` executable in Herdr, verify provenance, and update `creRoots`. No shell commands or arbitrary CLI agent kinds from Slack.
- Non-Slack-triggered CRE work can produce status/response notifications in the root's shared thread.

## Security and limitations

This is **attach-only**, not yet a Slack launcher. Merely seeing `pi` in Herdr does not attest CRE; an operator is responsible for pinning correct provenance. The plugin rechecks the live terminal and native Pi session before control and status operations and fails closed on changed identity. Slack thread authorization uses pinned team, user allowlist, channel binding and workspace. The channel and thread are shared: anyone able to read the Slack channel sees the posted output, even if they are not allowed to control Herdr. Prefer a private Slack channel containing only both developers before sending confidential code or terminal output.

Native Pi session identities must be available through the deployed Herdr Pi integration. The repository still targets Herdr protocol 19; test it against the exact installed Herdr version before production. Slack OAuth reauthorization, Herdr lifecycle, root restart/rebind and concurrent turn tests are not live-verified. The personal `cre` root does not magically gain the managed `cre-pi` workflow authority and evidence/ledger semantics.
