/**
 * Outbound-only Slack transport for satellite herds.
 *
 * Satellites must not open Socket Mode — that would race the primary for events.
 * They still need the Web API to post and update their own session cards when
 * the primary forwards a command.
 */

import type { InstanceConfig } from "../config/config.js";
import { SlackApiError, slackCall } from "./api.js";
import type {
  ActionHandler,
  EphemeralInput,
  HistoryMessage,
  HomeHandler,
  MentionHandler,
  MessageHandler,
  PostInput,
  SlackTransport,
  UpdateInput,
  ViewSubmitHandler,
} from "./transport.js";

type SlackResult = Record<string, unknown> & { ok: boolean };

export class WebApiTransport implements SlackTransport {
  #connected = false;
  #connectionHandlers: ((connected: boolean) => void)[] = [];

  constructor(private readonly config: InstanceConfig) {}

  get connected(): boolean {
    return this.#connected;
  }

  get idleMs(): number | null {
    return this.#connected ? 0 : null;
  }

  async start(): Promise<void> {
    // Prove the bot token works; do not open Socket Mode.
    await slackCall({
      token: this.config.slack.botToken,
      method: "auth.test",
    });
    this.#setConnected(true);
  }

  async stop(): Promise<void> {
    this.#setConnected(false);
  }

  async postMessage(input: PostInput): Promise<{ ts: string; channel: string }> {
    const result = await this.#call("chat.postMessage", {
      channel: input.channel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ts: str(result.ts), channel: str(result.channel) };
  }

  async history(
    channel: string,
    opts: { threadTs?: string; limit: number },
  ): Promise<HistoryMessage[]> {
    try {
      const result = await this.#call(
        opts.threadTs ? "conversations.replies" : "conversations.history",
        {
          channel,
          limit: opts.limit,
          ...(opts.threadTs ? { ts: opts.threadTs } : {}),
        },
      );
      return Array.isArray(result.messages)
        ? result.messages.map((item: unknown) => {
            const message =
              item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            return {
              text: str(message.text),
              ts: str(message.ts),
              ...(str(message.user) ? { user: str(message.user) } : {}),
              ...(str(message.bot_id) ? { botId: str(message.bot_id) } : {}),
              ...(str(message.subtype) ? { subtype: str(message.subtype) } : {}),
            };
          })
        : [];
    } catch (error) {
      if (error instanceof SlackApiError && error.slackError === "not_in_channel")
        throw new Error("not_in_channel");
      throw error;
    }
  }

  async updateMessage(input: UpdateInput): Promise<void> {
    await this.#call("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
  }

  async publishHome(_userId: string, _blocks: unknown[]): Promise<void> {
    // Satellites never publish Home — the primary owns that surface.
  }

  async openDm(userId: string): Promise<string> {
    const result = await this.#call("conversations.open", { users: userId });
    const channel = result.channel as Record<string, unknown> | undefined;
    return str(channel?.id);
  }

  async openModal(_triggerId: string, _view: Record<string, unknown>): Promise<string> {
    throw new Error("satellites cannot open modals — the primary owns Slack interactivity");
  }

  async updateModal(_viewId: string, _view: Record<string, unknown>): Promise<void> {
    throw new Error("satellites cannot update modals — the primary owns Slack interactivity");
  }

  async postEphemeral(input: EphemeralInput): Promise<void> {
    await this.#call("chat.postEphemeral", {
      channel: input.channel,
      user: input.user,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
  }

  async setThreadTitle(channel: string, threadTs: string, title: string): Promise<void> {
    await this.#call("assistant.threads.setTitle", {
      channel_id: channel,
      thread_ts: threadTs,
      title,
    });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const result = await this.#call("chat.getPermalink", { channel, message_ts: ts });
    return str(result.permalink);
  }

  // Inbound handlers are no-ops: Socket Mode is not running.
  onAction(_handler: ActionHandler): void {}
  onViewSubmit(_handler: ViewSubmitHandler): void {}
  onMessage(_handler: MessageHandler): void {}
  onMention(_handler: MentionHandler): void {}
  onHomeOpened(_handler: HomeHandler): void {}
  onConnectionChange(handler: (connected: boolean) => void): void {
    this.#connectionHandlers.push(handler);
    if (this.#connected) handler(true);
  }

  async #call(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    try {
      return await slackCall({
        token: this.config.slack.botToken,
        method,
        body,
      });
    } catch (error) {
      if (error instanceof SlackApiError) throw error;
      throw error;
    }
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    for (const handler of this.#connectionHandlers) handler(connected);
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
