# Verification status — CRE-only attach MVP

**Draft: not production ready.**

- Base workspace-bound Slack patch retained and extended.
- Added `creOnly` / `creRoots` operator pins and an explicit native Pi session verifier; ordinary `pi` alone is insufficient.
- Disabled arbitrary Slack-launches and remote End Session controls in CRE-only mode.
- Added controls to prevent status/response disclosure and prompts to non-pinned roots, including modal and App Home paths.
- Serialized prompts targeting the same root for the duration of a Slack submission.
- Filled missing `onMention` handlers in dry-run and Web API transports.
- Source tests added; CI and typechecks still require execution in a dependency-equipped environment.
- Needs live acceptance: two user IDs, channel/workspace scope, Slack mention delivery, exact CRE identity, native Pi session changes, pane movement, blocked approval, service restart and Slack reconnect.
- **Deployment not performed**: no access to the user's private Herdr host from this connector.
