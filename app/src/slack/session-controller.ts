import { type PiBoundary, readPiSession } from "../agents/pi-session.js";
import type { InstanceConfig } from "../config/config.js";
import type { HerdrClient } from "../herdr/client.js";
import type { SessionState } from "../herdr/state.js";
import { HerdrError } from "../herdr/types.js";
import type { SessionRegistry, TurnStatus } from "../registry/registry.js";
import { isEligibleCreRoot } from "./cre-roots.js";
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
  piBoundary?: PiBoundary;
}

/** Authorised Slack actions → herdr calls; resolve pane id at call time. */
export const SESSION_OVER =
  "This agent has exited — the thread is closed. Start a new one with `+ New agent`.";

const RESPONSE_LINES = 120;
const INTERRUPT_KEYS = ["esc"];
const CLEAR_PROMPT = "/new";

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
  #settledDuringDelivery = new Map<string, "done" | "blocked" | "stopped" | "failed">();
  #inflightTurn = new Map<string, string>();

  constructor(private readonly deps: SessionControllerDeps) {}

  /** Open or reuse the single updating remote-control card. */
  async openSession(terminalId: string, channel: string): Promise<ActionOutcome> {
    const { state, registry, transport } = this.deps;
    const pane = state.paneByTerminal(terminalId);
    if (!pane) return { ok: false, message: "That session has ended." };
    if (!isEligibleCreRoot(this.deps.config, pane))
      return { ok: false, message: "Unverified CRE root." };

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

    const shared =
      record.slackChannel &&
      this.deps.config.channelBindings?.[record.slackChannel] === pane.workspace_id;
    if (
      record.slackThreadTs &&
      record.slackChannel &&
      (record.slackChannel === channel || (shared && channel.startsWith("D")))
    ) {
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
      await transport
        .updateMessage({
          channel: priorChannel,
          ts: priorThread,
          text: "Agent control moved to another channel.",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Agent control moved to another channel." },
            },
          ],
        })
        .catch(() => undefined);
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
      pane.agent === "pi" ||
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
    if (
      !pane ||
      !record ||
      record.ended ||
      !this.hasReplyTarget(terminalId) ||
      this.deps.isHerdrConnected?.() === false
    )
      return;
    if (
      !sendsTerminalText(this.deps.config.contentMode) ||
      isExcluded(pane.cwd ?? "", this.deps.config.excludePaths)
    ) {
      await this.updateCard(terminalId);
      return;
    }

    const active = registry.activeTurn(terminalId);
    if (active?.deliveryPending) {
      if (complete && this.#inflightTurn.get(terminalId) === active.id)
        this.#settledDuringDelivery.set(terminalId, complete);
      return;
    }
    let finalStatus = complete;
    let response = "";
    let safe = "";
    if (pane.agent === "pi") {
      const session = pane.agent_session;
      const source =
        session?.agent === "pi" && session.kind === "path" && session.source === "herdr:pi"
          ? session.value
          : undefined;
      const result = active
        ? await readPiSession(source, active.piBoundary)
        : { kind: "unavailable" as const, reason: "No verified active Pi turn." };
      const current = state.paneByTerminal(terminalId);
      if (
        !current ||
        record.ended ||
        registry.get(terminalId) !== record ||
        this.deps.isHerdrConnected?.() === false ||
        (active?.origin && active.expectedWorkspaceId !== pane.workspace_id) ||
        current.pane_id !== pane.pane_id ||
        current.workspace_id !== pane.workspace_id ||
        current.agent !== "pi" ||
        current.agent_status === "working" ||
        current.agent_session?.value !== session?.value ||
        current.agent_session?.kind !== session?.kind ||
        current.agent_session?.source !== session?.source ||
        registry.activeTurn(terminalId)?.id !== active?.id ||
        registry.activeTurn(terminalId)?.deliveryPending ||
        registry.activeTurn(terminalId)?.piBoundary !== active?.piBoundary ||
        (complete && (state.statusOf(terminalId) ?? current.agent_status) === "working")
      )
        return;
      if (!active) {
        if (complete && record.lastPiResponseId) return; // Repeat settle; keep the posted reply.
        registry.setLatestResponse(terminalId, "Pi reply unavailable: No verified active Pi turn.");
        registry.save();
        await this.updateCard(terminalId);
        return;
      }
      if (result.kind === "pending" && !active.piBoundary?.fileIdentity) {
        registry.updateTurn(terminalId, active.id, { piBoundary: result.boundary });
        registry.save();
      }
      if (complete === "blocked" && (result.kind === "unavailable" || result.kind === "pending"))
        return;
      const idleSnapshot = !complete && pane.agent_status === "idle";
      if (result.kind === "pending") {
        if (!complete) return;
        response = "Pi reply unavailable: No complete Pi reply for this turn.";
        finalStatus = "failed";
      } else if (
        !active.piBoundary ||
        record.piClearedPath === source ||
        result.kind === "unavailable" ||
        result.kind === "boundary"
      ) {
        if (!complete && !idleSnapshot) {
          registry.setLatestResponse(
            terminalId,
            `Pi reply unavailable: ${result.kind === "unavailable" ? result.reason : "No verified turn boundary."}`,
          );
          registry.save();
          await this.updateCard(terminalId);
          return;
        }
        response = `Pi reply unavailable: ${result.kind === "unavailable" ? result.reason : "No verified turn boundary."}`;
        finalStatus = "failed";
      } else if (result.kind === "failed") {
        if (!complete && !idleSnapshot) return;
        response =
          result.reason === "stopped"
            ? "Pi turn stopped without a complete reply."
            : "Pi turn failed without a complete reply.";
        finalStatus = result.reason;
      } else {
        if (result.boundary !== active.piBoundary)
          registry.updateTurn(terminalId, active.id, { piBoundary: result.boundary });
        if (record.lastPiResponseId === result.identity) {
          if ((!complete && !idleSnapshot) || !active) return;
          response = "Pi reply unavailable: no new answer for this turn.";
          finalStatus = "failed";
        } else {
          if (!complete && this.#settledAs(terminalId, pane) !== "done") return;
          finalStatus = complete ?? "done";
          const redaction = redact(result.text);
          response = redaction.text;
          if (redaction.hits.length > 0)
            log(`redacted ${redaction.hits.join(",")} from ${terminalId} response`);
          record.lastPiResponseId = result.identity;
        }
      }
    } else {
      const raw = await client
        .read(pane.pane_id, "recent_unwrapped", RESPONSE_LINES)
        .catch((error) => {
          log(`response read failed for ${terminalId}: ${(error as Error).message}`);
          return "";
        });
      const redaction = redact(raw);
      safe = redaction.text;
      response = extractAgentResponse(safe, active?.baseline ?? record.responseBaseline);
      if (redaction.hits.length > 0)
        log(`redacted ${redaction.hits.join(",")} from ${terminalId} response`);
    }
    if (active && (active.deliveryPending || registry.activeTurn(terminalId)?.id !== active.id))
      return;
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
          finalStatus ?? this.#settledAs(terminalId, pane),
        );
        // Everything on screen is now filed under a turn, so the next one
        // reports only what the agent said after this point.
        if (settled) registry.setResponseBaseline(terminalId, safe);
      }
    }
    if (active && finalStatus) {
      registry.updateTurn(terminalId, active.id, {
        status: finalStatus,
        completedAt: Date.now(),
      });
      registry.setResponseBaseline(terminalId, safe);
      settled = active.id;
    }
    registry.save();
    const replyCheck = {
      ref: record.ref,
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      sessionPath: pane.agent_session?.value,
      boundary: registry.turns(terminalId).find((item) => item.id === settled)?.piBoundary,
      identity: record.lastPiResponseId,
      origin: registry.turns(terminalId).find((item) => item.id === settled)?.origin,
      allowUnavailablePiNotice:
        pane.agent === "pi" &&
        !complete &&
        pane.agent_status === "idle" &&
        finalStatus === "failed",
    };
    await this.updateCard(terminalId);
    if (settled) await this.announceReply(terminalId, settled, replyCheck);
  }

  /**
   * Post the finished turn under the card, once.
   *
   * A `chat.update` raises no notification, so editing the card in place means a
   * reply that arrives while the user is away is never announced — they had to
   * come back and press Refresh to discover it. This is the push: one threaded
   * message per settled turn, carrying the reply itself so the thread reads as
   * the conversation while the card stays the current state.
   *
   * A turn with an origin goes where its prompt came from instead, and the
   * thread root is remembered so a reply in that thread finds this agent.
   */
  async announceReply(
    terminalId: string,
    turnId: string,
    captured?: {
      ref: string;
      paneId: string;
      workspaceId: string;
      sessionPath: string | undefined;
      boundary: PiBoundary | undefined;
      identity: string | undefined;
      origin: { channel: string; threadTs?: string } | undefined;
      allowUnavailablePiNotice?: boolean;
    },
  ): Promise<void> {
    const { registry, transport, log, state } = this.deps;
    const record = registry.get(terminalId);
    if (!record || record.ended) return;

    const turn = registry.turns(terminalId).find((item) => item.id === turnId);
    if (!turn?.response || turn.status === "working") return;
    const target =
      turn.origin ??
      (record.slackChannel && record.slackThreadTs
        ? { channel: record.slackChannel, threadTs: record.slackThreadTs }
        : undefined);
    if (!target) return;
    if (!isSubstantiveResponse(turn.response)) return;
    const initialPane = state.paneByTerminal(terminalId);
    const expected = captured ?? {
      ref: record.ref,
      paneId: initialPane?.pane_id ?? "",
      workspaceId: initialPane?.workspace_id ?? "",
      sessionPath: initialPane?.agent_session?.value,
      boundary: turn.piBoundary,
      identity: record.lastPiResponseId,
      origin: turn.origin,
    };
    const valid = () => {
      const liveRecord = registry.get(terminalId);
      const live = state.paneByTerminal(terminalId);
      const currentTurn = registry.turns(terminalId).at(-1);
      return Boolean(
        liveRecord &&
          !liveRecord.ended &&
          liveRecord.ref === expected.ref &&
          live?.agent &&
          live.pane_id === expected.paneId &&
          live.workspace_id === expected.workspaceId &&
          this.deps.isHerdrConnected?.() !== false &&
          currentTurn?.id === turnId &&
          !currentTurn.deliveryPending &&
          currentTurn.status !== "working" &&
          currentTurn.response === turn.response &&
          currentTurn.origin?.channel === expected.origin?.channel &&
          currentTurn.origin?.threadTs === expected.origin?.threadTs &&
          (!currentTurn.origin || currentTurn.expectedWorkspaceId === expected.workspaceId) &&
          currentTurn.piBoundary === expected.boundary &&
          (live.agent !== "pi" ||
            (live.agent_session?.agent === "pi" &&
              live.agent_session.kind === "path" &&
              live.agent_session.source === "herdr:pi" &&
              live.agent_session.value === expected.sessionPath &&
              liveRecord.lastPiResponseId === expected.identity)),
      );
    };
    if (!valid()) return;
    if (turn.piBoundary) {
      const file = await readPiSession(expected.sessionPath, turn.piBoundary);
      if (
        file.kind !== "ready" &&
        file.kind !== "failed" &&
        !(
          file.kind === "unavailable" &&
          captured?.allowUnavailablePiNotice &&
          turn.status === "failed" &&
          turn.response.startsWith("Pi reply unavailable: ")
        )
      )
        return;
      if (file.kind === "ready" && file.identity !== expected.identity) return;
      if (!valid()) return;
    }
    if (!registry.claimTurnNotification(terminalId, turnId)) return;
    registry.save();

    try {
      const posted = await transport.postMessage({
        channel: target.channel,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
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
      if (turn.origin) {
        registry.addReplyPost(terminalId, turn.origin.channel, turn.origin.threadTs ?? posted.ts);
        registry.save();
      }
    } catch (error) {
      log(`reply notice failed for ${terminalId}: ${(error as Error).message}`);
    }
  }

  /** A settled turn has somewhere to go: the card thread, or the active turn's origin. */
  hasReplyTarget(terminalId: string): boolean {
    const record = this.deps.registry.get(terminalId);
    if (!record) return false;
    if (record.slackChannel && record.slackThreadTs) return true;
    return Boolean(this.deps.registry.activeTurn(terminalId)?.origin);
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

  /** Read Pi's trusted session leaf before the launcher sends the first prompt. */
  async launchBoundary(terminalId: string): Promise<PiBoundary> {
    const pane = this.deps.state.paneByTerminal(terminalId);
    if (
      pane?.agent !== "pi" ||
      pane.agent_session?.kind !== "path" ||
      pane.agent_session.agent !== "pi" ||
      pane.agent_session.source !== "herdr:pi"
    )
      throw new Error("Pi session is unavailable.");
    const result = await readPiSession(pane.agent_session.value);
    if (result.kind !== "boundary" || this.deps.state.paneByTerminal(terminalId) !== pane)
      throw new Error("Pi session is unavailable.");
    return result.boundary;
  }

  /** Persist the launch boundary and an undeliverable turn before the launcher sends text. */
  async preparePiLaunchTurn(
    terminalId: string,
    prompt: string,
    workspaceId: string | undefined,
    origin?: { channel: string; threadTs?: string },
  ): Promise<{
    terminalId: string;
    turnId: string;
    ref: string;
    paneId: string;
    workspaceId: string;
    boundary: PiBoundary;
  }> {
    const pane = this.deps.state.paneByTerminal(terminalId);
    if (
      !pane?.agent ||
      (workspaceId && pane.workspace_id !== workspaceId) ||
      this.deps.isHerdrConnected?.() === false ||
      !isEligibleCreRoot(this.deps.config, pane)
    )
      throw new Error("Pi launch target is unavailable.");
    const boundary = await this.launchBoundary(terminalId);
    if (
      this.deps.state.paneByTerminal(terminalId) !== pane ||
      this.deps.isHerdrConnected?.() === false ||
      this.deps.registry.activeTurn(terminalId)
    )
      throw new Error("Pi launch target changed.");
    const { registry, state } = this.deps;
    const record = registry.upsert(terminalId, {
      lastKnownPaneId: pane.pane_id,
      agentKind: pane.agent,
      title: pane.terminal_title_stripped ?? pane.title ?? "",
      cwd: pane.cwd ?? "",
      workspaceId: pane.workspace_id,
      tabId: pane.tab_id,
      lastStatus: state.statusOf(terminalId) ?? pane.agent_status,
    });
    const turn = registry.startTurn(
      terminalId,
      prompt,
      "",
      origin,
      Date.now(),
      boundary,
      workspaceId ?? pane.workspace_id,
    );
    if (!turn) throw new Error("Pi launch turn is unavailable.");
    registry.updateTurn(terminalId, turn.id, { deliveryPending: true });
    try {
      registry.save();
    } catch (error) {
      registry.discardTurn(terminalId, turn.id);
      throw error;
    }
    return {
      terminalId,
      turnId: turn.id,
      ref: record.ref,
      paneId: pane.pane_id,
      workspaceId: workspaceId ?? pane.workspace_id,
      boundary,
    };
  }

  /** A failed or invalidated launch stays pending across restart. */
  async confirmPiLaunchTurn(
    captured: Awaited<ReturnType<SessionController["preparePiLaunchTurn"]>>,
  ): Promise<boolean> {
    const { terminalId, turnId, ref, paneId, workspaceId, boundary } = captured;
    const { state, registry } = this.deps;
    const pane = state.paneByTerminal(terminalId);
    const turn = registry.activeTurn(terminalId);
    if (
      !pane ||
      pane.agent !== "pi" ||
      pane.pane_id !== paneId ||
      pane.workspace_id !== workspaceId ||
      pane.agent_session?.agent !== "pi" ||
      pane.agent_session.kind !== "path" ||
      pane.agent_session.source !== "herdr:pi" ||
      pane.agent_session.value !== boundary.path ||
      registry.get(terminalId)?.ref !== ref ||
      turn?.id !== turnId ||
      turn.piBoundary !== boundary ||
      !turn.deliveryPending ||
      this.deps.isHerdrConnected?.() === false
    )
      return false;
    registry.updateTurn(terminalId, turnId, { deliveryPending: false });
    registry.save();
    await this.refreshResponse(terminalId);
    return true;
  }

  /** Send free text as a prompt. herdr handles paste mode and the Enter. */
  async prompt(
    terminalId: string,
    text: string,
    expectedWorkspaceId?: string,
    origin?: { channel: string; threadTs?: string },
    baseline?: string,
  ): Promise<ActionOutcome> {
    if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
    if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId)))
      return { ok: false, message: "Unverified CRE root." };
    if (
      expectedWorkspaceId &&
      this.deps.state.paneByTerminal(terminalId)?.workspace_id !== expectedWorkspaceId
    )
      return { ok: false, message: "That agent is not in this workspace." };
    const pane = this.deps.state.paneByTerminal(terminalId);
    const paneId = pane?.pane_id;
    if (!paneId) return { ok: false, message: SESSION_OVER };
    let piBoundary: PiBoundary | undefined;
    if (pane.agent === "pi") {
      if (
        this.deps.isHerdrConnected?.() === false ||
        pane.agent_session?.kind !== "path" ||
        pane.agent_session.agent !== "pi" ||
        pane.agent_session.source !== "herdr:pi" ||
        this.deps.registry.get(terminalId)?.piClearedPath === pane.agent_session.value
      )
        return {
          ok: false,
          message: "Pi session is unavailable; wait for herdr to report its new session.",
        };
      const before = await readPiSession(pane.agent_session.value);
      if (before.kind !== "boundary")
        return {
          ok: false,
          message: before.kind === "unavailable" ? before.reason : "Pi session is unavailable.",
        };
      piBoundary = before.boundary;
      if (this.deps.state.paneByTerminal(terminalId) !== pane)
        return { ok: false, message: "Pi session changed before prompt delivery." };
    }
    const previous = this.deps.registry.activeTurn(terminalId);
    const pending =
      baseline === undefined || previous
        ? undefined
        : this.deps.registry.startTurn(
            terminalId,
            text,
            baseline,
            origin,
            Date.now(),
            piBoundary,
            expectedWorkspaceId,
          );
    if (baseline !== undefined && !previous && !pending)
      return { ok: false, message: SESSION_OVER };
    if (baseline !== undefined) {
      this.#settledDuringDelivery.delete(terminalId);
      this.#inflightTurn.set(terminalId, (previous ?? pending)?.id ?? "");
      if (previous)
        this.deps.registry.updateTurn(terminalId, previous.id, { deliveryPending: true });
      else if (pending)
        this.deps.registry.updateTurn(terminalId, pending.id, { deliveryPending: true });
      this.deps.registry.save();
    }
    const releasePending = () => {
      this.#settledDuringDelivery.delete(terminalId);
      this.#inflightTurn.delete(terminalId);
      if (pending) this.deps.registry.discardTurn(terminalId, pending.id);
      if (previous)
        this.deps.registry.updateTurn(terminalId, previous.id, { deliveryPending: false });
      this.deps.registry.save();
    };
    try {
      // A fast status edge cannot settle until herdr acknowledges delivery.
      await this.deps.client.prompt(paneId, text);
      if (
        expectedWorkspaceId &&
        (this.deps.state.paneByTerminal(terminalId)?.workspace_id !== expectedWorkspaceId ||
          !this.isLive(terminalId))
      ) {
        // Herdr acknowledged a prompt, but its authorized workspace is gone.
        // Keep the saved turn non-deliverable even if the terminal moves back.
        this.#settledDuringDelivery.delete(terminalId);
        this.#inflightTurn.delete(terminalId);
        return { ok: false, message: "That agent is not in this workspace." };
      }
      const active = this.deps.registry.activeTurn(terminalId);
      if (active && (piBoundary || origin)) {
        this.deps.registry.updateTurn(terminalId, active.id, {
          ...(piBoundary ? { piBoundary } : {}),
          ...(origin ? { origin, ...(expectedWorkspaceId ? { expectedWorkspaceId } : {}) } : {}),
        });
        this.deps.registry.save();
      }
      if (baseline !== undefined) {
        if (active)
          this.deps.registry.updateTurn(terminalId, active.id, { deliveryPending: false });
        this.deps.registry.save();
        const settled = this.#settledDuringDelivery.get(terminalId);
        this.#settledDuringDelivery.delete(terminalId);
        this.#inflightTurn.delete(terminalId);
        if (settled) await this.refreshResponse(terminalId, settled);
        else if (piBoundary) await this.refreshResponse(terminalId);
      }
      this.deps.log(`prompt sent to ${terminalId} (${text.length} chars)`);
      return { ok: true, ...(piBoundary ? { piBoundary } : {}) };
    } catch (error) {
      // A failed acknowledgment does not prove a steered prompt was not delivered.
      if (baseline !== undefined) {
        if (previous) {
          this.#settledDuringDelivery.delete(terminalId);
          this.#inflightTurn.delete(terminalId);
          this.deps.registry.save();
        } else releasePending();
      }
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
    const pane = this.deps.state.paneByTerminal(terminalId);
    if (!pane) return { ok: false, message: "That session has ended." };
    let piBoundary: PiBoundary | undefined;
    if (pane.agent === "pi") {
      const session = pane.agent_session;
      const before = await readPiSession(
        session?.agent === "pi" && session.kind === "path" && session.source === "herdr:pi"
          ? session.value
          : undefined,
      );
      if (before.kind !== "boundary" || this.deps.state.paneByTerminal(terminalId) !== pane)
        return { ok: false, message: "Pi session is unavailable." };
      piBoundary = before.boundary;
    }
    try {
      await this.deps.client.sendKeys(pane.pane_id, [choice]);
      const active =
        this.deps.registry.activeTurn(terminalId) ?? this.deps.registry.turns(terminalId).at(-1);
      if (
        piBoundary &&
        active &&
        !active.piBoundary &&
        (active.status === "working" || active.status === "blocked")
      ) {
        this.deps.registry.updateTurn(terminalId, active.id, { piBoundary });
        this.deps.registry.save();
      }
      this.deps.log(`menu choice ${choice} sent to ${terminalId}`);
      return { ok: true, ...(piBoundary ? { piBoundary } : {}) };
    } catch (error) {
      return { ok: false, message: this.#explain(error) };
    }
  }

  /** Interrupt a live agent without ending its turn. */
  async interrupt(terminalId: string, expectedWorkspaceId?: string): Promise<ActionOutcome> {
    if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
    if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId)))
      return { ok: false, message: "Unverified CRE root." };
    if (
      expectedWorkspaceId &&
      this.deps.state.paneByTerminal(terminalId)?.workspace_id !== expectedWorkspaceId
    )
      return { ok: false, message: "That agent is not in this workspace." };
    const paneId = this.#currentPane(terminalId);
    if (!paneId) return { ok: false, message: SESSION_OVER };
    try {
      await this.deps.client.sendKeys(paneId, INTERRUPT_KEYS);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.#explain(error) };
    }
  }

  /** Clear the agent context and restore the name that /new removes. */
  async clear(terminalId: string, expectedWorkspaceId?: string): Promise<ActionOutcome> {
    if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
    if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId)))
      return { ok: false, message: "Unverified CRE root." };
    if (
      expectedWorkspaceId &&
      this.deps.state.paneByTerminal(terminalId)?.workspace_id !== expectedWorkspaceId
    )
      return { ok: false, message: "That agent is not in this workspace." };
    const pane = this.deps.state.paneByTerminal(terminalId);
    const paneId = pane?.pane_id;
    const name = this.deps.state.nameOf(terminalId);
    if (!paneId || !name) return { ok: false, message: "That agent has no name." };
    try {
      await this.deps.client.prompt(paneId, CLEAR_PROMPT);
      if (pane.agent === "pi") {
        const record = this.deps.registry.get(terminalId);
        if (record && pane.agent_session?.value) record.piClearedPath = pane.agent_session.value;
        const active = this.deps.registry.activeTurn(terminalId);
        if (active)
          this.deps.registry.updateTurn(terminalId, active.id, {
            status: "stopped",
            completedAt: Date.now(),
          });
        this.deps.registry.save();
      }
      if (!this.isLive(terminalId)) return { ok: false, message: SESSION_OVER };
      const currentPane = this.deps.state.paneByTerminal(terminalId);
      if (expectedWorkspaceId && currentPane?.workspace_id !== expectedWorkspaceId)
        return { ok: false, message: "That agent is not in this workspace." };
      const current = currentPane?.pane_id;
      if (!current) return { ok: false, message: SESSION_OVER };
      await this.deps.client.request("agent.rename", { target: current, name });
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
