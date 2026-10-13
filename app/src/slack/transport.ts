import type { InstanceConfig } from "../config/config.js";

/**
 * Everything the surfaces need from Slack.
 *
 * An interface rather than Bolt-everywhere so the HTTP transport stays a
 * drop-in if Marketplace distribution is ever wanted (ADR 0001) — and, more
 * immediately, so surfaces can be tested against a stub instead of a socket.
 */
export interface SlackTransport {
  readonly connected: boolean;
  /** ms since the last frame from Slack, or null when never connected. */
  readonly idleMs: number | null;

  start(): Promise<void>;
  stop(): Promise<void>;

  postMessage(input: PostInput): Promise<{ ts: string; channel: string }>;
  history(channel: string, opts: { threadTs?: string; limit: number }): Promise<HistoryMessage[]>;
  /**
   * A member's Slack `user.name` (`users.info`), or undefined when deleted or absent.
   *
   * Display text for `context` transcripts only — never an authorization input.
   */
  userName(userId: string): Promise<string | undefined>;
  /**
   * A note only `user` can see, optionally inside a thread.
   *
   * Used for everything the tool says *about* itself — "reply in this thread",
   * "that option expired". As real messages these landed in the DM root, which
   * both cluttered the conversation and put our own words next to the agent's.
   */
  postEphemeral(input: EphemeralInput): Promise<void>;
  updateMessage(input: UpdateInput): Promise<void>;
  publishHome(userId: string, blocks: unknown[]): Promise<void>;
  openDm(userId: string): Promise<string>;
  /**
   * A clickable link that opens a specific message in Slack.
   *
   * Home's Open button uses this so a second click jumps to the thread that
   * already exists instead of hunting for it in the DM history.
   */
  permalink(channel: string, ts: string): Promise<string>;
  /**
   * Name a thread in the agent container's timeline.
   *
   * This is what makes a herd of any size navigable: Slack lists our per-agent
   * threads above the composer, and without a title every one of them reads as
   * an undifferentiated conversation.
   */
  setThreadTitle(channel: string, threadTs: string, title: string): Promise<void>;

  openModal(triggerId: string, view: Record<string, unknown>): Promise<string>;
  updateModal(viewId: string, view: Record<string, unknown>): Promise<void>;

  onAction(handler: ActionHandler): void;
  onViewSubmit(handler: ViewSubmitHandler): void;
  onMessage(handler: MessageHandler): void;
  onMention(handler: MentionHandler): void;
  onHomeOpened(handler: HomeHandler): void;
  onConnectionChange(handler: (connected: boolean) => void): void;
}

export interface HistoryMessage {
  user?: string;
  text: string;
  ts: string;
  botId?: string;
  subtype?: string;
}

export interface PostInput {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

export interface EphemeralInput {
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
}

export interface UpdateInput {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

/**
 * Where an interaction came from.
 *
 * `conversation` is a DM, channel message, or slash command — something that
 * happens *in* a channel other people may be able to see and type in.
 * `home` and `modal` are per-user surfaces: only the authenticated user sees
 * their own App Home, and a modal is opened for exactly one user against a
 * trigger_id. Neither carries a channel id at all.
 */
export type InboundSurface = "conversation" | "home" | "modal" | "mention";

/** The normalised shape every handler sees, whatever the transport. */
export interface InboundContext {
  teamId: string;
  userId: string;
  channel: string;
  /**
   * Omitted means `conversation` — the restrictive default. A construction
   * site that forgets this must fail closed, never fall into the exempt path.
   */
  surface?: InboundSurface;
  ts?: string;
  threadTs?: string;
  /** Slack envelope id; stable across retries of the same delivery. */
  eventId?: string;
  /** Non-zero when Slack is redelivering an event we should already have handled. */
  retryNum?: number;
}

export type ActionHandler = (input: {
  ctx: InboundContext;
  actionId: string;
  value: string;
  triggerId: string;
  /** Present for actions inside a modal, enabling in-place pagination. */
  viewId?: string;
}) => Promise<void>;

export type MessageHandler = (input: { ctx: InboundContext; text: string }) => Promise<void>;
export type MentionHandler = MessageHandler;

export type HomeHandler = (input: { ctx: InboundContext }) => Promise<void>;

/**
 * How a submitted modal should close.
 *
 * Returning `errors` keeps the modal open with the message under the named
 * input and the typed text intact, which is the only honest answer when the
 * prompt never reached the agent — acking blind closed the modal and left the
 * user believing a failed reply had been sent.
 */
export interface ViewSubmitResult {
  /** block_id → message shown beneath that input. */
  errors: Record<string, string>;
}

export type ViewSubmitHandler = (input: {
  ctx: InboundContext;
  callbackId: string;
  view: unknown;
  privateMetadata?: string;
}) => Promise<ViewSubmitResult | undefined>;

/**
 * Slack discards a view_submission response after 3s and shows a generic
 * failure, so the synchronous window is deliberately short of that.
 */
export const VIEW_SUBMIT_BUDGET_MS = 2_500;

/**
 * Remembers deliveries so a redelivered interaction is handled once.
 *
 * Slack redelivers an interaction whose ack it never saw, reusing the same
 * `trigger_id`. Handling it twice means a second prompt or a `views.open` on an
 * already-spent trigger, which fails as `exchanged_trigger_id`. Bounded so a
 * long-lived daemon cannot grow it without limit.
 */
export class DeliveryLedger {
  #seen = new Set<string>();

  constructor(private readonly limit = 500) {}

  /** True the first time an id is seen, false for every repeat. */
  first(id: string): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > this.limit) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }
}

/**
 * Decide whether an inbound Slack message should reach an agent.
 *
 * Kept here, transport-agnostic and pure, because it is a security boundary and
 * every transport must apply it identically.
 *
 * Our own card `chat.update` calls emit `message_changed` events in the same DM.
 * Filtering on bot id alone would let rendered card text re-enter inbound
 * routing.
 */
export function isActionableMessage(
  event: {
    subtype?: string | undefined;
    bot_id?: string | undefined;
    user?: string | undefined;
    text?: string | undefined;
  },
  botUserId: string,
): boolean {
  if (event.subtype) return false;
  if (event.bot_id) return false;
  if (!event.user || event.user === botUserId) return false;
  return Boolean(event.text?.trim());
}

/** How long to suppress an identical prompt re-fired with a different message ts. */
export const PROMPT_DEDUPE_MS = 10_000;

/** Stable key for a Slack message delivery; ts is unique per posted message. */
export function inboundMessageDedupeKey(ctx: InboundContext): string | undefined {
  if (ctx.ts) return `${ctx.channel}:${ctx.ts}`;
  if (ctx.eventId) return ctx.eventId;
  return undefined;
}

/** Reject payloads from any workspace other than the one set up. */
export function isPinnedTeam(config: InstanceConfig, teamId: string | undefined): boolean {
  return Boolean(teamId) && teamId === config.slack.teamId;
}

/** The action fields we read from a Bolt block-action payload. */
export interface ParsedActionPayload {
  actionId: string;
  value: string;
  triggerId: string;
  /** Only modal actions carry a view; message actions (session cards) do not. */
  viewId?: string;
}

/**
 * Pull action fields out of an untrusted Bolt payload.
 *
 * A message action (a button on a session card) has no `view`, so reading
 * `payload.view.id` unconditionally throws and the handler never runs — the
 * button then does nothing in Slack. This reads every field defensively.
 */
export function parseActionPayload(body: unknown, action: unknown): ParsedActionPayload {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  const payload = asRecord(body) ?? {};
  const actionRecord = asRecord(action) ?? {};
  const viewId = str(asRecord(payload.view)?.id);
  return {
    actionId: str(actionRecord.action_id),
    value: str(actionRecord.value) || str(asRecord(actionRecord.selected_option)?.value),
    triggerId: str(payload.trigger_id),
    ...(viewId ? { viewId } : {}),
  };
}
