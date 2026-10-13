import type { InboundContext, InboundSurface } from "./transport.js";

type AnyRecord = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const rec = (value: unknown): AnyRecord | undefined =>
  value && typeof value === "object" ? (value as AnyRecord) : undefined;

/**
 * Which surface a block_actions / view_submission payload came from.
 *
 * Slack never says this in a field — it is structural. An App Home button
 * arrives with `container.type === "view"` and **no channel id whatsoever**;
 * a modal submission arrives as `type: "view_submission"` with a `view` and no
 * container. Everything else (message buttons, slash commands) happens in a
 * real conversation and has a channel.
 *
 * Getting this wrong is not cosmetic: reading a channel that was never there
 * and testing it against the DM-only rule denied every Home button and every
 * modal submission with `channel_not_permitted`.
 */
export function surfaceOf(payload: AnyRecord): InboundSurface {
  const container = rec(payload.container);
  const view = rec(payload.view);

  const isViewPayload = str(payload.type) === "view_submission" || str(container?.type) === "view";
  if (!isViewPayload) return "conversation";

  // App Home views are `type: "home"`; modals are `type: "modal"`. Slack puts it
  // on the view for submissions and on the container for button clicks.
  const viewType = str(view?.type) || str(container?.view_type);
  return viewType === "home" ? "home" : "modal";
}

/** Normalise an interaction payload into the shape every handler sees. */
export function contextFromPayload(payload: AnyRecord, fallbackTeamId = ""): InboundContext {
  const team = rec(payload.team);
  const user = rec(payload.user);
  const channel = rec(payload.channel);
  const container = rec(payload.container);
  const message = rec(payload.message);
  const threadTs = str(container?.thread_ts) || str(message?.thread_ts);

  return {
    teamId: str(team?.id) || str(payload.team_id) || fallbackTeamId,
    userId: str(user?.id) || str(payload.user_id),
    channel: str(channel?.id) || str(container?.channel_id),
    surface: surfaceOf(payload),
    ...(container?.message_ts ? { ts: str(container.message_ts) } : {}),
    ...(threadTs ? { threadTs } : {}),
  };
}
