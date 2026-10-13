/** Slack app manifest; generate variants from one source to avoid scope drift. */

export interface ManifestOptions {
  /** Display name; users often want "Herdr (work)" to tell instances apart. */
  appName: string;
}

/** Scopes needed for the DM-only control plane. Each is load-bearing. */
export const BASE_SCOPES = [
  "chat:write", // post and update every surface
  "im:history", // receive DM replies
  "im:write", // open the DM in the first place
  "im:read",
  "assistant:write", // agent timeline titles via setThreadTitle
  "app_mentions:read", // explicit @herdr commands in bound channels
  "channels:history", // read context in public channels
  "groups:history", // read context in private channels
] as const;

/** Sent when the user switches the agent pane's channel/thread context. */
export const BASE_EVENTS = [
  "app_home_opened",
  "app_context_changed",
  "message.im",
  "app_mention",
  "message.channels",
  "message.groups",
] as const;

export function scopesFor(_options: ManifestOptions): string[] {
  return [...BASE_SCOPES];
}

export function eventsFor(_options: ManifestOptions): string[] {
  return [...BASE_EVENTS];
}

/** Render manifest JSON for paste into Slack's create-from-manifest form. */
export function renderManifest(options: ManifestOptions): string {
  const manifest = {
    display_information: {
      name: options.appName,
      description: "Drive your local herdr agents from Slack.",
      background_color: "#1b1b1f",
    },
    features: {
      bot_user: { display_name: "herdr", always_online: true },
      // Agent container: per-agent threads in a switchable timeline.
      agent_view: {
        agent_description: "Drive your local herdr agents: browse, prompt, approve, and launch.",
        // Suggested prompts are posted as the user; keep them natural.
        suggested_prompts: [
          { title: "What needs me?", message: "What needs my attention?" },
          { title: "Show my herd", message: "Show my herd" },
        ],
      },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: { scopes: { bot: scopesFor(options) } },
    settings: {
      event_subscriptions: { bot_events: eventsFor(options) },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

/** Where the user creates the app. */
export const CREATE_APP_URL = "https://api.slack.com/apps/new";

/** Public repo URL included in admin approval requests. */
export const REPO_URL = "https://github.com/egemenyildiz/herdr-slack";

/** App icon path and raw URL; manifests have no icon field. */
export const ICON_REPO_PATH = "assets/app-icon.png";
/** Public raw URL; requires a public repo (works after release). */
export const ICON_URL = `${REPO_URL}/raw/main/${ICON_REPO_PATH}`;

export function appSettingsUrl(appId: string, page: "general" | "install" | "oauth"): string {
  const suffix = page === "install" ? "install-on-team" : page === "oauth" ? "oauth" : "general";
  return `https://api.slack.com/apps/${appId}/${suffix}`;
}

/** Admin approval request text for workspaces that require install approval. */
export function adminRequest(options: ManifestOptions): string {
  const scopes = scopesFor(options)
    .map((scope) => `  - ${scope}: ${SCOPE_REASON[scope] ?? "required"}`)
    .join("\n");
  return `Requesting approval to install a Slack app: "${options.appName}"

What it is: a self-hosted bridge that lets me answer my own coding agents from
Slack. It runs on my machine only.

Network exposure: none. It uses Slack Socket Mode, an outbound WebSocket — there
is no public URL, no inbound firewall rule, and no third-party server involved.
Nothing is hosted outside Slack and my laptop.

Bot scopes requested:
${scopes}

The app is not distributed and is installed only to this workspace.

Source code, for review:  ${REPO_URL}
Security policy:          ${REPO_URL}/blob/main/SECURITY.md`;
}

const SCOPE_REASON: Record<string, string> = {
  "chat:write": "post and update messages",
  "im:history": "read my replies in a DM thread",
  "im:write": "open a DM with me",
  "im:read": "resolve the DM channel",
  "assistant:write": "title agent timeline threads",
  "app_mentions:read": "accept explicit mentions in bound channels",
  "channels:history": "read recent public channel messages for context",
  "groups:history": "read recent private channel messages for context",
};
