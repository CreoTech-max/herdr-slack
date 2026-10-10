import type { InstanceConfig } from "../config/config.js";
import type { HerdrClient } from "../herdr/client.js";
import type { SessionState } from "../herdr/state.js";
import { HerdrError } from "../herdr/types.js";
import type { SessionRegistry, TurnStatus } from "../registry/registry.js";
import { resolveThreadPermalink } from "./links.js";
import { redact } from "./redact.js";
import { extractAgentResponse, isSubstantiveResponse } from "./response.js";
import {
  SESSION_ACTIONS,
  type SessionView,
  blockedPromptBlocks,
  isExcluded,
  parseMenuChoiceValue,
  responseSections,
  sendsTerminalText,
  sessionCard,
  threadTitle,
  viewFromPane,
} from "./session.js";
import type { SlackTransport } from "./transport.js";

/** How long a menu keypress has to move the agent off `blocked`. */
export const ACK_TIMEOUT_MS = 10_000;

/** Stands in for the prompt on work that was not driven from Slack. */
export const SELF_STARTED_PROMPT = "_(started on this computer)_";

export interface SessionControllerDeps {
  config: InstanceConfig;
  client: HerdrClient;
  state: SessionState;
  registry: SessionRegistry;
  transport: SlackTransport;
  log: (line: string) => void;
  /** Injected so tests need no timers. */
  now?: () => number;
  /** Live herdr socket; absent means assume connected (unit tests). */
  isHerdrConnected?: () => boolean;
}

export interface ActionOutcome {
  ok: boolean;
  message?: string;
}

/** Authorised Slack actions → herdr calls; resolve pane id at call time. */
export const SESSION_OVER =
  "This agent has exited — the thread is closed. Start a new one with `+ New agent`.";

const RESPONSE_LINES = 120;

/** The one-line header on a pushed reply; also the notification preview text. */
function replyNotice(agent: string, title: string, status: TurnStatus): string {
  const what =
    status === "blocked"
      ? "needs your input"
      : status === "failed" || status === "stopped"
        ? "stopped"
        : "replied";
  return `${TURN_GLYPH[status]} *${agent}* ${what} · ${title || "untitled"}`;
}

const TURN_GLYPH: Record<TurnStatus, string> = {
  working: "⚙️",
  done: "✅",
  blocked: "🔴",
  stopped: "⚪️",
  failed: "⚠️",
};

export class SessionController {
  constructor(private readonly deps: SessionControllerDeps) {}

  /** Open or reuse the single updating remote-control card. */
  async openSession(terminalId: string, channel: string): Promise<ActionOutcome> {
    const { state, registry, transport } = this.deps;
    const pane = state.paneByTerminal(terminalId);
    if (!pane) return { ok: false, message: "That session has ended." };

    const record = registry.get(terminalId);
    if (!record) return { ok: false, message: SESSION_OVER };
    // The pane is live, so a closed card is stale rather than over: opening it
    // again re-attaches instead of refusing.
    if (record.ended) registry.reopen(terminalId);
    const workspace = state.workspaces.get(pane.workspace_id);
    const herdrConnected = this.deps.isHerdrConnected?.() ?? true;
    const view = {
      ...viewFromPane(
        pane,
        record.ref,
        workspace?.label ?? pane.workspace_id,
        state.statusOf(terminalId) ?? pane.agent_status,
      ),
      ...(herdrConnected ? {} : { herdrConnected: false as const }),
    };
    const card = sessionCard(view, record);

    const shared = record.slackChannel && this.deps.config.channelBindings?.[record.slackChannel] === pane.workspace_id;
    if (record.slackThreadTs && record.slackChannel &&
      (record.slackChannel === channel || (shared && channel.startsWith("D")))) {
      await transport
        .updateMessage({
          channel: record.slackChannel,
          ts: record.slackThreadTs,
          text: card.text,
          blocks: card.blocks,
        })
        .catch(() => undefined);
      const bareLink = await transport
        .permalink(record.slackChannel, record.slackThreadTs)
        .catch(() => "");
      const threadLink = resolveThreadPermalink(
        record.slackChannel,
        record.slackThreadTs,
        bareLink || record.slackPermalink,
      );
      if (threadLink) registry.setPermalink(terminalId, threadLink);
      await this.refreshResponse(terminalId);
      return { ok: true, message: "Opened the existing thread for this agent." };
    }

    const priorChannel = record.slackChannel;
    const priorThread = record.slackThreadTs;
    const posted = await transport.postMessage({
      channel,
      text: card.text,
      blocks: card.blocks,
    });
    registry.setThread(terminalId, posted.channel, posted.ts);
    if (priorChannel && priorThread && priorChannel !== posted.channel) {
      await transport.updateMessage({
        channel: priorChannel, ts: priorThread,
        text: "Agent control moved to another channel.",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Agent control moved to another channel." } }],
      }).catch(() => undefined);
    }
    const bareLink = await transport.permalink(posted.channel, posted.ts).catch(() => "");
    await this.retitle(terminalId);
    const threadLink = resolveThreadPermalink(posted.channel, posted.ts, bareLink || undefined);
    if (threadLink) registry.setPermalink(terminalId, threadLink);
    await this.refreshResponse(terminalId);
    return { ok: true };
  }

  /** Set the agent timeline thread title; best-effort on missing_scope. */
  async retitle(terminalId: string): Promise<void> {
    const { state, registry, transport, log } = this.deps;
    const record = registry.get(terminalId);
    if (!record?.slackChannel || !record.slackThreadTs) return;

    const pane = state.paneByTerminal(terminalId);
    const status = state.statusOf(terminalId) ?? pane?.agent_status ?? "unknown";
    const title = threadTitle({
      status,
      agent: pane?.agent ?? record.agentKind,
      label: pane?.terminal_title_stripped ?? record.title,
    });
    if (title === record.threadTitle) return;

    try {
      await transport.setThreadTitle(record.slackChannel, record.slackThreadTs, title);
      registry.setThreadTitle(terminalId, title);
    } catch (error) {
      log(`could not title thread for ${terminalId}: ${(error as Error).message}`);
    }
  }

  /** Replace session controls with a closing note; Block Kit has no disabled buttons. */
  async closeHeader(terminalId: string): Promise<void> {
    const { state, registry, transport } = this.deps;
    const record = registry.get(terminalId);
    if (!record?.slackChannel || !record.slackThreadTs) return;

    const pane = state.paneByTerminal(terminalId);
    const view: SessionView = pane
      ? viewFromPane(
          pane,
          record.ref,
          state.workspaces.get(pane.workspace_id)?.label ?? pane.workspace_id,
          state.statusOf(terminalId) ?? pane.agent_status,
          true,
        )
      : {
          ended: true,
          ref: record.ref,
          agent: record.agentKind,
          title: record.title,
          cwd: record.cwd,
          status: "unknown",
          workspaceLabel: record.workspaceId,
          tabId: record.tabId,
        };

    const card = sessionCard(view, record);
    await transport.updateMessage({
      channel: record.slackChannel,
      ts: record.slackThreadTs,
      text: card.text,
      blocks: card.blocks,
    });
  }

  /**
   * Undo a false "Agent exited" when the agent is still on this terminal.
   *
   * Restores the thread header and controls so prompts and transitions work again.
   */
  async reviveIfLive(terminalId: string): Promise<boolean> {
    const { state, registry } = this.deps;
    const record = registry.get(terminalId);
    const pane = state.paneByTerminal(terminalId);
    if (
      !record?.ended ||
      record.closedByUser ||
      !pane?.agent ||
      !record.slackChannel ||
      !record.slackThreadTs
    ) {
      return false;
    }
    registry.revive(terminalId);
    await this.updateCard(terminalId);
    await this.retitle(terminalId);
    return true;
  }

  async captureBaseline(terminalId: string): Promise<string> {
    const pane = this.deps.state.paneByTerminal(terminalId);
    if (
      !pane ||
      !sendsTerminalText(this.deps.config.contentMode) ||
      isExcluded(pane.cwd ?? "", this.deps.config.excludePaths)
    ) {
      return "";
    }
    const paneId = this.#currentPane(terminalId);
    if (!paneId) return "";
    const raw = await this.deps.client
      .read(paneId, "recent_unwrapped", RESPONSE_LINES)
      .catch(() => "");
    return redact(raw).text;
  }

  async refreshResponse(
    terminalId: string,
    complete?: "done" | "blocked" | "stopped" | "failed",
  ): Promise<void> {
    const { state, registry, client, log } = this.deps;
    const pane = state.paneByTerminal(terminalId);
    const record = registry.get(terminalId);
    if (!pane || !record?.slackChannel || !record.slackThreadTs) return;
    if (
      !sendsTerminalText(this.deps.config.contentMode) ||
      isExcluded(pane.cwd ?? "", this.deps.config.excludePaths)
    ) {
      await this.updateCard(terminalId);
      return;
    }

    const raw = await client
      .read(pane.pane_id, "recent_unwrapped", RESPONSE_LINES)
      .catch((error) => {
        log(`response read failed for ${terminalId}: ${(error as Error).message}`);
        return "";
      });
    const active = registry.activeTurn(terminalId);
    const { text: safe, hits } = redact(raw);
    const response = extractAgentResponse(safe, active?.baseline ?? record.responseBaseline);
    if (hits.length > 0) log(`redacted ${hits.join(",")} from ${terminalId} response`);
    let settled: string | undefined;
    if (response) {
      registry.setLatestResponse(terminalId, response);
      if (active) {
        registry.updateTurn(terminalId, active.id, { response });
      } else {
        // A manual Refresh of a settled agent is also a finished turn — the
        // user should find what they just read in "Earlier" later on.
        settled = this.#recordSelfStartedTurn(
          terminalId,
          response,
          complete ?? this.#settledAs(terminalId, pane),
        );
        // Everything on screen is now filed under a turn, so the next one
        // reports only what the agent said after this point.
        if (settled) registry.setResponseBaseline(terminalId, safe);
      }
    }
    if (active && complete) {
      registry.updateTurn(terminalId, active.id, {
        status: complete,
        completedAt: Date.now(),
      });
      registry.setResponseBaseline(terminalId, safe);
      settled = active.id;
    }
    registry.save();
    await this.updateCard(terminalId);
    if (settled) await this.announceReply(terminalId, settled);
  }

  /**
   * Post the finished turn under the card, once.
   *
   * A `chat.update` raises no notification, so editing the card in place means a
   * reply that arrives while the user is away is never announced — they had to
   * come back and press Refresh to discover it. This is the push: one threaded
   * message per settled turn, carrying the reply itself so the thread reads as
   * the conversation while the card stays the current state.
   */
  async announceReply(terminalId: string, turnId: string): Promise<void> {
    const { registry, transport, log } = this.deps;
    const record = registry.get(terminalId);
    if (!record?.slackChannel || !record.slackThreadTs || record.ended) return;

    const turn = registry.turns(terminalId).find((item) => item.id === turnId);
    if (!turn?.response || turn.status === "working") return;
    if (!isSubstantiveResponse(turn.response)) return;
    if (!registry.claimTurnNotification(terminalId, turnId)) return;
    registry.save();

    try {
      await transport.postMessage({
        channel: record.slackChannel,
        threadTs: record.slackThreadTs,
        text: replyNotice(record.agentKind, record.title, turn.status),
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: replyNotice(record.agentKind, record.title, turn.status) },
            ],
          },
          ...responseSections(turn.response, "*Replied*"),
        ],
      });
    } catch (error) {
      log(`reply notice failed for ${terminalId}: ${(error as Error).message}`);
    }
  }

  /** "done" when the agent is currently settled; undefined while it works. */
  #settledAs(terminalId: string, pane: { agent_status?: string | null }): "done" | undefined {
    const status = this.deps.state.statusOf(terminalId) ?? pane.agent_status ?? "unknown";
    return status === "idle" || status === "done" ? "done" : undefined;
  }

  /**
   * Record a settled turn the user never drove from Slack, returning its id.
   *
   * Without this, "Earlier" only ever lists prompts sent through the Reply
   * modal, so a session worked on at the keyboard shows an empty history. The
   * response is deduped against the previous turn because a flickering agent
   * can settle repeatedly on the same output.
   */
  #recordSelfStartedTurn(
    terminalId: string,
    response: string,
    status: "done" | "blocked" | "stopped" | "failed" | undefined,
  ): string | undefined {
    const { registry } = this.deps;
    if (!status) return undefined;
    if (!isSubstantiveResponse(response)) return undefined;
    if (registry.turns(terminalId).at(-1)?.response === response) return undefined;
    const turn = registry.startTurn(terminalId, SELF_STARTED_PROMPT, "");
    if (!turn) return undefined;
    registry.updateTurn(terminalId, turn.id, {
      response,
      status,
      completedAt: Date.now(),
    });
    return turn.id;
  }

  async updateCard(terminalId: string): Promise<void> {
    const { state, registry, transport, client, log } = this.deps;
    const pane = state.paneByTerminal(terminalId);
    const record = registry.get(terminalId);
    if (!record?.slackChannel || !record.slackThreadTs) return;

    const status = state.statusOf(terminalId) ?? pane?.agent_status ?? record.lastStatus;
    const herdrConnected = this.deps.isHerdrConnected?.() ?? true;
    const offline = herdrConnected ? {} : { herdrConnected: false as const };
    const view: SessionView = pane
      ? {
          ...viewFromPane(
            pane,
            record.ref,
            state.workspaces.get(pane.workspace_id)?.label ?? pane.workspace_id,
            status,
            record.ended,
          ),
          ...offline,
        }
      : {
          ended: record.ended,
          ref: record.ref,
          agent: record.agentKind,
          title: record.title,
          cwd: record.cwd,
          status,
          workspaceLabel: record.workspaceId,
          tabId: record.tabId,
          ...offline,
        };

    let waiting: Record<string, unknown>[] = [];
    if (!record.ended && herdrConnected && pane && status === "blocked") {
      const detection = await client.read(pane.pane_id, "detection", 60).catch(() => "");
      const workspace = state.workspaces.get(pane.workspace_id);
      const blockedView = viewFromPane(
        pane,
        record.ref,
        workspace?.label ?? pane.workspace_id,
        "blocked",
      );
      waiting = blockedPromptBlocks(blockedView, detection) ?? [];
      if (waiting.length === 0) log(`no menu detected for ${terminalId}`);
    }

    const card = sessionCard(view, record, waiting);
    await transport
      .updateMessage({
        channel: record.slackChannel,
        ts: record.slackThreadTs,
        text: card.text,
        blocks: card.blocks,
      })
      .catch((error) => log(`card update failed: ${(error as Error).message}`));
  }

  /** Send free text as a prompt. herdr handles paste mode and the Enter. */
  async prompt(terminalId: string, text: string): Promise<ActionOutcome> {
    if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
    const paneId = this.#currentPane(terminalId);
    if (!paneId) return { ok: false, message: SESSION_OVER };
    try {
      // No wait: replies arrive via transition events, not this call.
      await this.deps.client.prompt(paneId, text);
      this.deps.log(`prompt sent to ${terminalId} (${text.length} chars)`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.#explain(error) };
    }
  }

  /**
   * Close the terminal the agent runs in.
   *
   * Ctrl-C twice does not exit every agent TUI (Cursor ignores it), so the only
   * honest remote "end" is herdr's destructive `pane.close`. Confirm-gated in the
   * card, and the pane id is resolved here so `pane.move` cannot redirect it.
   */
  async closeTerminal(terminalId: string): Promise<ActionOutcome> {
    if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
    const paneId = this.#currentPane(terminalId);
    if (!paneId) return { ok: false, message: SESSION_OVER };
    try {
      await this.deps.client.paneClose(paneId);
      this.deps.log(`pane.close sent for ${terminalId}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.#explain(error) };
    }
  }

  /** Send a bare digit for numbered menus; prompt would append Enter. */
  async chooseMenuOption(terminalId: string, choice: string): Promise<ActionOutcome> {
    const paneId = this.#currentPane(terminalId);
    if (!paneId) return { ok: false, message: "That session has ended." };
    try {
      await this.deps.client.sendKeys(paneId, [choice]);
      this.deps.log(`menu choice ${choice} sent to ${terminalId}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.#explain(error) };
    }
  }

  /** Wait for the agent to leave `blocked`; no retry or re-send on timeout. */
  async verifyAcknowledged(
    terminalId: string,
    timeoutMs: number = ACK_TIMEOUT_MS,
  ): Promise<boolean> {
    const { state, now = Date.now } = this.deps;

    // Use live pane status, not debounced statusOf().
    const stillBlocked = () => state.paneByTerminal(terminalId)?.agent_status === "blocked";

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (!stillBlocked()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !stillBlocked();
  }

  /** Decode a `session_menu_choice_*` action value. */
  static decodeMenuChoice(value: string): { ref: string; choice: string } | null {
    return parseMenuChoiceValue(value);
  }

  static isMenuChoiceAction(actionId: string): boolean {
    return actionId.startsWith(SESSION_ACTIONS.menuChoice);
  }

  #currentPane(terminalId: string): string | undefined {
    // Resolve at call time; pane.move can reassign ids.
    return this.deps.state.currentPaneId(terminalId);
  }

  /** A pane with no agent is not drivable, even if the pane still exists. */
  isLive(terminalId: string): boolean {
    const pane = this.deps.state.paneByTerminal(terminalId);
    if (!pane) return false;
    if (!pane.agent) return false;
    return this.deps.registry.get(terminalId)?.ended !== true;
  }

  #explain(error: unknown): string {
    if (error instanceof HerdrError) {
      if (error.code === "agent_prompt_stalled") {
        return "herdr accepted the prompt but the agent did not react — it may be busy.";
      }
      if (error.isNotFound) return "That session has ended.";
      return `herdr refused: ${error.message}`;
    }
    return "Something went wrong talking to herdr.";
  }
}
