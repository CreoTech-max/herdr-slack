import bolt from "@slack/bolt";
import type { InstanceConfig } from "../config/config.js";
import { contextFromPayload } from "./inbound.js";
import {
  DeliveryLedger,
  VIEW_SUBMIT_BUDGET_MS,
  isActionableMessage,
  parseActionPayload,
} from "./transport.js";
import type {
  ActionHandler,
  EphemeralInput,
  HomeHandler,
  InboundContext,
  MessageHandler,
  MentionHandler,
  PostInput,
  SlackTransport,
  UpdateInput,
  ViewSubmitHandler,
} from "./transport.js";

/**
 * No frame from Slack for this long means the socket is probably half-open.
 *
 * Slack pings roughly every 30s on an idle connection, so silence this long is
 * genuine. It is only a valid signal because every frame refreshes the clock:
 * counting handled interactions alone made a quiet workspace look dead, and the
 * watchdog then recycled a healthy socket every couple of minutes. Each of those
 * teardowns lost in-flight acks, which Slack shows as "We had some trouble
 * connecting" before redelivering the interaction with its now-spent trigger_id.
 */
const IDLE_TEARDOWN_MS = 90_000;

/**
 * Bound on one recycle attempt (stop + start).
 *
 * Without this, a hung `app.start()` — seen live as a promise that never
 * settled, alongside "recycle failed: undefined" from something rejecting
 * with no reason at all — leaves `#recycling` stuck `true` forever, since its
 * `finally` never runs. Every later watchdog tick then no-ops on the guard,
 * silently disabling recovery for good. A timeout forces the attempt to fail
 * fast so the next tick gets a real try.
 */
const RECYCLE_TIMEOUT_MS = 20_000;

type AnyRecord = Record<string, unknown>;

/** Bolt payloads → untrusted records; fields read with `str` at the boundary. */
const toRecord = (value: unknown): AnyRecord => value as AnyRecord;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Socket Mode transport with idle watchdog — half-open sockets look like "nothing happening". */
export class SocketModeTransport implements SlackTransport {
  #app: bolt.App;
  #receiver: bolt.SocketModeReceiver;
  #connected = false;
  #lastFrameAt: number | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  /** Guards against the idle check and the readyState check both firing a recycle at once. */
  #recycling = false;
  #connectionHandlers: ((connected: boolean) => void)[] = [];
  /** trigger_ids already handled, to drop Slack's redeliveries. */
  #deliveries = new DeliveryLedger();

  #log: (line: string) => void;

  constructor(
    private readonly config: InstanceConfig,
    log: (line: string) => void = () => undefined,
  ) {
    this.#log = log;
    const logger = this.#boltLogger();
    // Built here rather than via `socketMode: true` so the socket client stays
    // reachable: App.receiver is private, and the idle watchdog needs to see
    // Slack's own frames to tell a quiet connection from a dead one.
    this.#receiver = new bolt.SocketModeReceiver({
      appToken: config.slack.appToken,
      logger,
    });
    this.#app = new bolt.App({
      token: config.slack.botToken,
      receiver: this.#receiver,
      // We do our own logging; Bolt's is noisy and can echo payloads. Its
      // warnings still matter though — an unmatched interaction is never acked,
      // which surfaces in Slack as a button that silently does nothing.
      logLevel: "warn" as bolt.LogLevel,
      logger,
    });
    this.#app.error(async (error) => {
      this.#log(`bolt error: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Attached once: the receiver keeps the same client across a recycle, so
    // doing this in start() would stack a listener per reconnect.
    this.#receiver.client.on("ws_message", () => this.#touch());
    // The idle-frame heuristic below only sees silence — it can't tell a
    // quiet-but-healthy connection from one the client itself gave up on.
    // These log the library's own state machine so a stuck reconnect leaves a
    // trail instead of the total silence we saw on 2026-08-18: the daemon held
    // zero TCP connections to Slack for the better part of an hour with no
    // disconnect, no ping/pong warning, and no watchdog line at all.
    this.#receiver.client.on("disconnected", () =>
      this.#log("slack: client state -> disconnected"),
    );
    this.#receiver.client.on("reconnecting", () =>
      this.#log("slack: client state -> reconnecting"),
    );
    this.#receiver.client.on("connected", () => this.#log("slack: client state -> connected"));
  }

  /** Forward Bolt's own warn/error into daemon.log; the daemon has no stderr. */
  #boltLogger(): bolt.Logger {
    let level = "warn" as bolt.LogLevel;
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => this.#log(`bolt warn: ${args.map(String).join(" ")}`),
      error: (...args: unknown[]) => this.#log(`bolt error: ${args.map(String).join(" ")}`),
      setLevel: (next: bolt.LogLevel) => {
        level = next;
      },
      getLevel: () => level,
      setName: () => undefined,
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  get idleMs(): number | null {
    return this.#lastFrameAt === null ? null : Date.now() - this.#lastFrameAt;
  }

  async start(): Promise<void> {
    await this.#app.start();
    this.#setConnected(true);
    this.#watchdog = setInterval(() => this.#checkHealth(), 15_000);
    this.#watchdog.unref?.();
  }

  /**
   * Two independent checks, because 2026-08-18 showed the idle-frame heuristic
   * alone is not enough: the daemon sat "connected" with zero TCP sockets open
   * to Slack for the better part of an hour, and the client's own ping/pong
   * timers never fired to say so either. `isActive()` reads the underlying
   * WebSocket's actual readyState directly — no network round trip, and it
   * catches a socket the client itself has lost track of.
   */
  #checkHealth(): void {
    if (this.#recycling) return;
    const active = this.#receiver.client.websocket?.isActive() ?? false;
    if (this.#connected && !active) {
      this.#log("slack: websocket reports inactive while still marked connected, recycling socket");
      void this.#recycle();
      return;
    }
    if (this.idleMs !== null && this.idleMs > IDLE_TEARDOWN_MS) {
      this.#log(`slack: no frame for ${Math.round((this.idleMs ?? 0) / 1000)}s, recycling socket`);
      void this.#recycle();
    }
  }

  async stop(): Promise<void> {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
    this.#setConnected(false);
    await this.#app.stop().catch(() => undefined);
  }

  async postMessage(input: PostInput): Promise<{ ts: string; channel: string }> {
    const result = await this.#app.client.chat.postMessage({
      channel: input.channel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks as never } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: str(result.ts), channel: str(result.channel) };
  }

  async updateMessage(input: UpdateInput): Promise<void> {
    await this.#app.client.chat.update({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks as never } : {}),
    });
  }

  /** Append Slack's `response_metadata.messages` to WebAPI errors. */
  #detail(error: unknown): string {
    const data = (error as { data?: AnyRecord })?.data;
    const messages = (data?.response_metadata as AnyRecord | undefined)?.messages;
    const base = error instanceof Error ? error.message : String(error);
    return Array.isArray(messages) && messages.length > 0
      ? `${base} — ${messages.join("; ")}`
      : base;
  }

  async publishHome(userId: string, blocks: unknown[]): Promise<void> {
    try {
      await this.#app.client.views.publish({
        user_id: userId,
        view: { type: "home", blocks: blocks as never },
      });
    } catch (error) {
      throw new Error(this.#detail(error));
    }
  }

  async openDm(userId: string): Promise<string> {
    const result = await this.#app.client.conversations.open({ users: userId });
    return str((result.channel as AnyRecord | undefined)?.id);
  }

  async openModal(triggerId: string, view: Record<string, unknown>): Promise<string> {
    const result = await this.#app.client.views.open({
      trigger_id: triggerId,
      view: view as never,
    });
    return str((result.view as AnyRecord | undefined)?.id);
  }

  async updateModal(viewId: string, view: Record<string, unknown>): Promise<void> {
    await this.#app.client.views.update({ view_id: viewId, view: view as never });
  }

  /**
   * Do the work first, then ack — so the modal only closes once the prompt is
   * actually with the agent, and stays open with an error when it is not.
   *
   * The handler races a budget below Slack's 3s cutoff. If it overruns we ack
   * plainly and let it finish in the background: an expired ack is shown to the
   * user as a failure even when the prompt landed, which is worse than closing.
   */
  onViewSubmit(handler: ViewSubmitHandler): void {
    this.#app.view(/.*/, async ({ ack, body, view }) => {
      this.#touch();
      const payload = toRecord(body);
      const viewRecord = toRecord(view);
      const running = handler({
        ctx: this.#context(payload),
        callbackId: str(viewRecord.callback_id),
        view: viewRecord.state,
        privateMetadata: str(viewRecord.private_metadata),
      });

      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), VIEW_SUBMIT_BUDGET_MS);
        timer.unref?.();
      });

      try {
        const result = await Promise.race([running.catch(() => undefined), budget]);
        if (result && result !== "timeout" && Object.keys(result.errors).length > 0) {
          await ack({ response_action: "errors", errors: result.errors } as never);
          return;
        }
        await ack();
      } finally {
        if (timer) clearTimeout(timer);
        void running.catch((error: unknown) => {
          this.#log(`view submit failed: ${(error as Error).message}`);
        });
      }
    });
  }

  async postEphemeral(input: EphemeralInput): Promise<void> {
    await this.#app.client.chat.postEphemeral({
      channel: input.channel,
      user: input.user,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
  }

  async setThreadTitle(channel: string, threadTs: string, title: string): Promise<void> {
    await this.#app.client.assistant.threads.setTitle({
      channel_id: channel,
      thread_ts: threadTs,
      title,
    });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const result = await this.#app.client.chat.getPermalink({ channel, message_ts: ts });
    return str(result.permalink);
  }

  onAction(handler: ActionHandler): void {
    this.#app.action(/.*/, async ({ ack, body, action }) => {
      const parsed = parseActionPayload(body, action);
      // Logged before ack so a click is visible even if handling later throws.
      this.#log(`inbound action ${parsed.actionId || "(no action_id)"}`);
      await ack();
      this.#touch();
      // A redelivery carries the same trigger_id, which Slack has already spent
      // — handling it again only produces exchanged_trigger_id and a duplicate
      // action. Acked above regardless, so Slack stops retrying.
      if (parsed.triggerId && !this.#deliveries.first(parsed.triggerId)) {
        this.#log(`duplicate delivery of ${parsed.actionId} ignored`);
        return;
      }
      await handler({ ctx: this.#context(toRecord(body)), ...parsed });
    });
  }

  onMessage(handler: MessageHandler): void {
    this.#app.event("message", async ({ event, body, context }) => {
      this.#touch();
      const record = toRecord(event);
      // Ignore message_changed — card updates are outbound, never prompts.
      if (!isActionableMessage(record, this.config.slack.botUserId)) return;
      const envelope = toRecord(body);
      await handler({
        ctx: {
          teamId: str(record.team) || this.config.slack.teamId,
          userId: str(record.user),
          channel: str(record.channel),
          surface: "conversation",
          ts: str(record.ts),
          ...(record.thread_ts ? { threadTs: str(record.thread_ts) } : {}),
          ...(str(envelope.event_id) ? { eventId: str(envelope.event_id) } : {}),
          ...(typeof context.retryNum === "number" ? { retryNum: context.retryNum } : {}),
        },
        text: str(record.text),
      });
    });
  }

  onMention(handler: MentionHandler): void {
    this.#app.event("app_mention", async ({ event, body, context }) => {
      this.#touch();
      const record = toRecord(event);
      if (!isActionableMessage(record, this.config.slack.botUserId)) return;
      const envelope = toRecord(body);
      await handler({
        ctx: {
          teamId: str(record.team) || str(envelope.team_id),
          userId: str(record.user),
          channel: str(record.channel),
          surface: "mention",
          ts: str(record.ts),
          ...(record.thread_ts ? { threadTs: str(record.thread_ts) } : {}),
          ...(str(envelope.event_id) ? { eventId: str(envelope.event_id) } : {}),
          ...(typeof context.retryNum === "number" ? { retryNum: context.retryNum } : {}),
        },
        text: str(record.text),
      });
    });
  }

  onHomeOpened(handler: HomeHandler): void {
    this.#app.event("app_home_opened", async ({ event, body }) => {
      this.#touch();
      const record = toRecord(event);
      if (str(record.tab) !== "home") return;
      await handler({
        ctx: {
          teamId: str(toRecord(body).team_id) || this.config.slack.teamId,
          userId: str(record.user),
          channel: str(record.channel),
          surface: "home",
        },
      });
    });
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.#connectionHandlers.push(handler);
  }

  #context(payload: AnyRecord): InboundContext {
    return contextFromPayload(payload, this.config.slack.teamId);
  }

  #touch(): void {
    this.#lastFrameAt = Date.now();
    if (!this.#connected) this.#setConnected(true);
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    if (connected) this.#lastFrameAt = Date.now();
    for (const handler of this.#connectionHandlers) handler(connected);
  }

  /* v8 ignore start -- needs a live socket to exercise */
  async #recycle(): Promise<void> {
    if (this.#recycling) return;
    this.#recycling = true;
    this.#setConnected(false);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("recycle timed out")), RECYCLE_TIMEOUT_MS);
        timer.unref?.();
      });
      await Promise.race([
        (async () => {
          await this.#app.stop();
          await this.#app.start();
        })(),
        timeout,
      ]);
      this.#setConnected(true);
    } catch (error) {
      // Bolt retries on its own; the next watchdog tick tries again. Logged
      // rather than swallowed — a silent failure here looks identical to a
      // healthy reconnect until buttons stop working.
      this.#log(
        `slack: recycle failed, still disconnected: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.#recycling = false;
    }
  }
  /* v8 ignore stop */
}
