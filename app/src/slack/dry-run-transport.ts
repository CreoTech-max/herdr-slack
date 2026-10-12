import type {
  ActionHandler,
  EphemeralInput,
  HomeHandler,
  MentionHandler,
  MessageHandler,
  PostInput,
  SlackTransport,
  UpdateInput,
  ViewSubmitHandler,
} from "./transport.js";

/** One intended write, as it would have gone to Slack. */
export interface DryRunWrite {
  api: string;
  target: string;
  text?: string;
  blocks?: unknown[];
  bytes: number;
}

/**
 * A transport that renders everything and sends nothing.
 *
 * The whole premise of this project is that terminal output on Slack is
 * retained and admin-exportable, and the honest answer to "what would actually
 * leave my machine?" is to show someone their own herd rendered under their own
 * `contentMode` — before any of it is sent, and before an app exists to send it
 * with. So this decorator sits at the transport boundary, below redaction and
 * `contentMode` filtering, and above the network: what it prints is byte-for-byte
 * what Slack would have received.
 *
 * It never opens a connection, which is what makes `--dry-run` usable as a
 * pre-flight with no tokens at all.
 *
 * ⚠️ Writes return **synthetic but stable ids** rather than empty strings. A
 * `postMessage` that returned `""` would leave the registry with no card ts,
 * and the card's `chat.update` path would never execute — dry-run would then
 * be exercising a code path that production never takes, which is worse than
 * useless because it looks like coverage.
 */
export class DryRunTransport implements SlackTransport {
  #counter = 0;
  readonly writes: DryRunWrite[] = [];

  constructor(private readonly sink: (write: DryRunWrite) => void) {}

  /**
   * Reported connected on purpose.
   *
   * The surfaces render a "⚠️ reconnecting" banner when they are not, and a
   * dry run that only ever shows you the degraded view would not show you the
   * thing you asked to see.
   */
  get connected(): boolean {
    return true;
  }

  get idleMs(): number | null {
    return 0;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  #record(write: Omit<DryRunWrite, "bytes">): void {
    const full: DryRunWrite = {
      ...write,
      bytes: Buffer.byteLength(`${write.text ?? ""}${JSON.stringify(write.blocks ?? [])}`),
    };
    this.writes.push(full);
    this.sink(full);
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `dry-${prefix}-${this.#counter}`;
  }

  async postMessage(input: PostInput): Promise<{ ts: string; channel: string }> {
    this.#record({
      api: "chat.postMessage",
      target: input.threadTs ? `${input.channel} thread ${input.threadTs}` : input.channel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
    return { ts: this.#id("ts"), channel: input.channel };
  }

  async updateMessage(input: UpdateInput): Promise<void> {
    this.#record({
      api: "chat.update",
      target: `${input.channel} @ ${input.ts}`,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
  }

  async publishHome(userId: string, blocks: unknown[]): Promise<void> {
    this.#record({ api: "views.publish", target: userId, blocks });
  }

  async openDm(userId: string): Promise<string> {
    return `dry-dm-${userId}`;
  }

  async postEphemeral(input: EphemeralInput): Promise<void> {
    this.#record({
      api: "chat.postEphemeral",
      target: input.threadTs ? `${input.channel} thread ${input.threadTs}` : input.channel,
      text: input.text,
    });
  }

  async setThreadTitle(channel: string, threadTs: string, title: string): Promise<void> {
    this.#record({
      api: "assistant.threads.setTitle",
      target: `${channel}/${threadTs}`,
      text: title,
    });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    return `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  }

  async openModal(triggerId: string, view: Record<string, unknown>): Promise<string> {
    this.#record({ api: "views.open", target: triggerId, ...{ blocks: [view] } });
    return this.#id("view");
  }

  async updateModal(viewId: string, view: Record<string, unknown>): Promise<void> {
    this.#record({ api: "views.update", target: viewId, blocks: [view] });
  }

  // Nothing inbound ever arrives, so the handlers are accepted and never called.
  onAction(_handler: ActionHandler): void {}
  onViewSubmit(_handler: ViewSubmitHandler): void {}
  onMessage(_handler: MessageHandler): void {}
  onMention(_handler: MentionHandler): void {}
  onHomeOpened(_handler: HomeHandler): void {}
  onConnectionChange(handler: (connected: boolean) => void): void {
    handler(true);
  }
}

/**
 * Every human-visible string in a Block Kit payload, in order.
 *
 * Byte counts answer the wrong question. Someone deciding whether to point this
 * at their employer's workspace is asking *what words leave the machine*, and
 * for Home and session threads all of those words live in nested `text` fields
 * rather than the top-level fallback.
 */
export function blockText(blocks: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "text" && typeof value === "string") found.push(value);
      else walk(value);
    }
  };
  walk(blocks);
  return found;
}

/** One entry per intended write, for a human watching a foreground dry run. */
export function formatWrite(write: DryRunWrite): string {
  const head = `would send ${write.api} → ${write.target} (${write.bytes} bytes)`;
  const parts = write.text ? [write.text] : [];
  if (write.blocks) parts.push(...blockText(write.blocks));

  const body = parts
    .filter((part) => part.trim().length > 0)
    .map((part) => `  ${part.split("\n").join("\n  ")}`)
    .join("\n");
  return body ? `${head}\n${body}` : head;
}
