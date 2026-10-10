import type {
  ActionHandler,
  HomeHandler,
  MessageHandler,
  MentionHandler,
  PostInput,
  SlackTransport,
  UpdateInput,
  ViewSubmitHandler,
  ViewSubmitResult,
} from "../../src/slack/transport.js";

/**
 * A SlackTransport that records instead of connecting.
 *
 * The point of the transport interface: surfaces are tested by driving handlers
 * directly and asserting on what was posted, with no socket and no credentials.
 */
export class FakeTransport implements SlackTransport {
  connected = true;
  idleMs: number | null = 0;

  readonly posted: PostInput[] = [];
  readonly updated: UpdateInput[] = [];
  readonly homes: { userId: string; blocks: unknown[] }[] = [];

  readonly ephemerals: { channel: string; user: string; text: string; threadTs?: string }[] = [];
  readonly titles: { channel: string; threadTs: string; title: string }[] = [];
  readonly modals: { triggerId: string; view: Record<string, unknown> }[] = [];
  readonly modalUpdates: { viewId: string; view: Record<string, unknown> }[] = [];

  #action: ActionHandler | null = null;
  #viewSubmit: ViewSubmitHandler | null = null;
  #message: MessageHandler | null = null;
  #mention: MentionHandler | null = null;
  #home: HomeHandler | null = null;
  #connection: ((connected: boolean) => void)[] = [];

  /** Set to make the next postMessage/publishHome reject. */
  failNext = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async postMessage(input: PostInput): Promise<{ ts: string; channel: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("slack unavailable");
    }
    this.posted.push(input);
    return { ts: `ts_${this.posted.length}`, channel: input.channel };
  }

  async updateMessage(input: UpdateInput): Promise<void> {
    this.updated.push(input);
  }

  async publishHome(userId: string, blocks: unknown[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("slack unavailable");
    }
    this.homes.push({ userId, blocks });
  }

  async openDm(userId: string): Promise<string> {
    return `D_${userId}`;
  }

  async postEphemeral(input: {
    channel: string;
    user: string;
    text: string;
    threadTs?: string;
  }): Promise<void> {
    this.ephemerals.push(input);
  }

  async setThreadTitle(channel: string, threadTs: string, title: string): Promise<void> {
    this.titles.push({ channel, threadTs, title });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    return `https://test.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  }

  async openModal(triggerId: string, view: Record<string, unknown>): Promise<string> {
    this.modals.push({ triggerId, view });
    return `V${this.modals.length}`;
  }

  /** Make the next N views.update calls fail, as a rejected view does. */
  failModalUpdates = 0;

  async updateModal(viewId: string, view: Record<string, unknown>): Promise<void> {
    if (this.failModalUpdates > 0) {
      this.failModalUpdates -= 1;
      throw new Error("invalid_blocks");
    }
    this.modalUpdates.push({ viewId, view });
  }

  onViewSubmit(handler: ViewSubmitHandler): void {
    this.#viewSubmit = handler;
  }

  /** Returns what the real transport would ack with: errors keep the modal open. */
  async emitViewSubmit(
    input: Parameters<ViewSubmitHandler>[0],
  ): Promise<ViewSubmitResult | undefined> {
    return (await this.#viewSubmit?.(input)) ?? undefined;
  }

  onAction(handler: ActionHandler): void {
    this.#action = handler;
  }
  onMessage(handler: MessageHandler): void {
    this.#message = handler;
  }
  onMention(handler: MentionHandler): void {
    this.#mention = handler;
  }
  onHomeOpened(handler: HomeHandler): void {
    this.#home = handler;
  }
  onConnectionChange(handler: (connected: boolean) => void): void {
    this.#connection.push(handler);
  }

  // ── drivers ───────────────────────────────────────────────────────────────

  emitHomeOpened(ctx: Parameters<HomeHandler>[0]["ctx"]): Promise<void> {
    return this.#home?.({ ctx }) ?? Promise.resolve();
  }

  emitAction(input: Parameters<ActionHandler>[0]): Promise<void> {
    return this.#action?.(input) ?? Promise.resolve();
  }

  emitMessage(input: Parameters<MessageHandler>[0]): Promise<void> {
    return this.#message?.(input) ?? Promise.resolve();
  }
  emitMention(input: Parameters<MentionHandler>[0]): Promise<void> {
    return this.#mention?.(input) ?? Promise.resolve();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const handler of this.#connection) handler(connected);
  }

  /** The blocks of the most recent Home publish, as searchable text. */
  lastHomeText(): string {
    return JSON.stringify(this.homes.at(-1)?.blocks ?? []);
  }
}
