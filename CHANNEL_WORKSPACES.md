# Herdr Slack workspace-bound shared channels

This extension binds a Slack conversation (by immutable channel ID) to exactly one local Herdr workspace ID.

## Setup

In the existing Slack app, add the bot OAuth scope `app_mentions:read` and event subscription `app_mention`, then reinstall or re-authorize the app. Invite the bot into each intended private channel.

Configure the existing instance in `config.json`:

```json
{
  "allowedUsers": ["U0C93G42G00", "U0C8CR5CMSQ"],
  "dmOnly": true,
  "channelBindings": {
    "C_CHANNEL_ONE": "HERDR_WORKSPACE_ID"
  }
}
```

Replace the channel and workspace IDs with actual IDs. Channel IDs may start with C (public) or G (private). Keep channels private to prevent other people reading agent output. The two allowlisted Slack IDs are the only people authorized to operate Herdr. Restart the bridge after changing configuration. Binding to an absent workspace will not auto-create it.

## Commands

- `@herdr status` / `@herdr agents`: list agents only in this channel's bound workspace.
- `@herdr blocked`: blocked agents in that workspace.
- `@herdr start codex | task description`: launch an agent in the bound workspace.
- `@herdr instruction` *inside the agent's own thread*: deliver a prompt to that agent.
- End a session with the existing confirmation-gated button on the agent card.

The plugin creates a shared top-level card and thread for each agent in the workspace. Once settled, the existing notification mechanism writes agent replies into that thread.

## Security and limitations

All inbound interactions check the pinned Slack team, allowed Slack member IDs, and bound channel. Actions on agents additionally verify the live workspace ID. Only explicit mentions are consumed; ordinary channel messages cannot drive agents.

This version targets local Herdr workspace IDs and does not implement cross-herd channel command forwarding. It is a draft integration and must be tested against live Slack, including workspace moves, reconnects, and concurrent prompts before production use.
