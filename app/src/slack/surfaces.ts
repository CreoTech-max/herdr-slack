import { autoModeFor, findEntry, loadCatalog } from "../agents/catalog.js";
import { readLastLaunch, writeLastLaunch } from "../agents/last-launch.js";
import { launchAgent, sanitizeAgentName } from "../agents/launcher.js";
import type { InstanceConfig } from "../config/config.js";
import type { RateBudget } from "../daemon/budget.js";
import { decodeHerdRef } from "../daemon/herd-registry.js";
import type { HerdrClient } from "../herdr/client.js";
import type { EventTail } from "../herdr/events.js";
import type { SessionState } from "../herdr/state.js";
import type { AgentStatus } from "../herdr/types.js";
import { type SessionRegistry, sweepOrphans } from "../registry/registry.js";
import { isEligibleCreRoot } from "./cre-roots.js";
import { escapeMrkdwn } from "./format.js";
import {
  ActionThrottle,
  type GuardDeps,
  authorizeAction,
  checkInbound,
  requireHerdr,
} from "./guards.js";
import type { HerdPort } from "./herd-port.js";
import {
  ALL_HERDS,
  GLYPH,
  HOME_ACTIONS,
  type HomeAgent,
  type HomeHerd,
  agentFromPane,
  buildHome,
} from "./home.js";
import { resolveThreadPermalink } from "./links.js";
import {
  BLOCK_IDS,
  MODAL_IDS,
  MODAL_INPUT_ACTION_IDS,
  type NewAgentSubmission,
  type NewAgentTargets,
  buildHistoryModal,
  buildNewAgentModal,
  buildReplyModal,
  messageModal,
  parseNewAgentSubmission,
  parseReplySubmission,
  skeletonModal,
} from "./modals.js";
import { SessionController } from "./session-controller.js";
import { SESSION_ACTIONS } from "./session.js";
import type { InboundContext, SlackTransport, ViewSubmitResult } from "./transport.js";
import { inboundMessageDedupeKey } from "./transport.js";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keep the reply modal open, with the reason under the text box. */
const replyError = (message: string): ViewSubmitResult => ({
  errors: { [BLOCK_IDS.reply]: message },
});

/** Default wait before treating a missing pane.agent as a quit (not a flap). */
export const AGENT_GONE_MS = 10_000;

/** Cursor reports idle between tool calls; wait before posting thread activity. */
export const CURSOR_IDLE_ACTIVITY_MS = 15_000;

/** Debounce Home republish after state changes. */
const HOME_DEBOUNCE_MS = 5_000;

interface NoticeTarget {
  userId?: string | undefined;
  threadTs?: string | undefined;
}

export interface SurfacesDeps {
  config: InstanceConfig;
  instance: string;
  transport: SlackTransport;
  state: SessionState;
  tail: EventTail;
  registry: SessionRegistry;
  budget: RateBudget;
  client: HerdrClient;
  /** How long to wait for a menu keypress to be acknowledged. */
  ackTimeoutMs?: number;
  /** Wait after pane.agent clears before posting "Agent exited". Defaults to AGENT_GONE_MS. */
  agentGoneMs?: number;
  /** Wait after cursor goes idle before posting activity. Defaults to CURSOR_IDLE_ACTIVITY_MS. */
  cursorIdleActivityMs?: number;
  /** Multi-herd coordination; omitted in unit tests that only exercise local Home. */
  herd?: HerdPort;
  log: (line: string) => void;
}

/** Wires herdr state to Slack surfaces; inbound actions go through guards first. */
export class Surfaces {
  #homeTimer: NodeJS.Timeout | null = null;
  #cardTimer: NodeJS.Timeout | null = null;
  #channelTimer: NodeJS.Timeout | null = null;
  #channelBusy = false;
  /** userId → DM channel, for interactions that arrive without one. */
  #dmChannels = new Map<string, string>();
  /** Who acted most recently, so a note can be addressed even deep in a helper. */
  #lastActor = "";
  #lastSyncAt: number | null = null;
  #guards: GuardDeps;
  #sessions: SessionController;
  /** terminalId → timer waiting to confirm the agent actually quit. */
  #agentGoneTimers = new Map<string, NodeJS.Timeout>();
  /** terminalId → timer waiting to confirm an idle turn is actually settled. */
  #cursorIdleTimers = new Map<string, NodeJS.Timeout>();
  /** Slack message deliveries already handled (`channel:ts` or event id). */
  #seenMessageKeys = new Set<string>();
  #submitting = new Set<string>();
  /** userId → herd they drilled into on Home. Lost on restart, which is fine. */
  #homeSelection = new Map<string, string>();

  constructor(private readonly deps: SurfacesDeps) {
    const isHerdrConnected = (): boolean => deps.tail.status === "connected";
    this.#sessions = new SessionController({
      config: deps.config,
      client: deps.client,
      state: deps.state,
      registry: deps.registry,
      transport: deps.transport,
      log: deps.log,
      isHerdrConnected,
    });
    deps.herd?.attachSessions(this.#sessions);
    this.#guards = {
      config: deps.config,
      throttle: new ActionThrottle(),
      resolveRef: (ref) => deps.registry.terminalForRef(ref),
      isLive: (terminalId) => deps.state.paneByTerminal(terminalId) !== undefined,
      workspaceForTerminal: (id) => deps.state.paneByTerminal(id)?.workspace_id,
      isApprovedCreRoot: (id) => isEligibleCreRoot(deps.config, deps.state.paneByTerminal(id)),
      isHerdrConnected,
    };
  }

  start(): void {
    const { transport, state, tail, registry, log } = this.deps;

    transport.onHomeOpened(async ({ ctx }) => {
      const decision = checkInbound(this.#guards, ctx);
      if (!decision.allowed) {
        log(`home_opened denied: ${decision.reason}`);
        return;
      }
      await this.publishHome(ctx.userId);
    });

    transport.onAction(async ({ ctx, actionId, value, triggerId, viewId }) => {
      this.#lastActor = ctx.userId;
      await this.#onAction(ctx, actionId, value, triggerId, viewId);
    });

    // Bare DMs have no thread target; treat them as commands, not prompts.
    transport.onMention(async ({ ctx, text }) => this.#mention(ctx, text));
    transport.onMessage(async ({ ctx, text }) => {
      this.#lastActor = ctx.userId;
      const decision = checkInbound(this.#guards, ctx);
      if (!decision.allowed) {
        log(`message denied: ${decision.reason}`);
        return;
      }
      if (!ctx.threadTs) {
        if (!this.#markMessageSeen(ctx)) {
          log(`duplicate bare message ignored ts=${ctx.ts ?? ctx.eventId ?? "?"}`);
          return;
        }
        await this.#handleBareMessage(ctx.channel, ctx.userId, text);
        return;
      }
      if (!this.#markMessageSeen(ctx)) return;
      const terminalId = this.terminalForThread(ctx.threadTs, ctx.channel);
      if (!terminalId) {
        await this.#ephemeral(
          ctx.channel,
          "I do not recognise this thread — open a session first.",
          {
            userId: ctx.userId,
            threadTs: ctx.threadTs,
          },
        );
        return;
      }
      await this.#ephemeral(
        ctx.channel,
        "Use *Reply* on the session card so prompts stay attached to a single remote turn.",
        { userId: ctx.userId, threadTs: ctx.threadTs },
      );
    });

    // Debounce Home refresh on structural changes to protect the write budget.
    state.on("changed", () => {
      void this.#reapDeadSessions();
      this.#scheduleHome();
      this.#scheduleChannel();
    });
    tail.on("ready", () => {
      this.reconcileSessions();
      this.#scheduleHome();
      this.#scheduleChannel();
    });
    // "synced Ns ago" tracks this, not the connect-time "ready" alone — a
    // healthy daemon that has been connected for hours without a hiccup was
    // showing that whole duration as "stale" because nothing had touched the
    // clock since the original connect. `synced` fires on every reconcile,
    // including the 30s periodic one, so the number reflects actual freshness
    // and only grows large when reconciling is genuinely failing.
    tail.on("synced", () => {
      this.#lastSyncAt = Date.now();
      this.#scheduleHome();
    });
    tail.on("status", () => {
      this.#scheduleHome();
      // Strip or restore session-card buttons when herdr flaps. Sleep freezes
      // us before we can do this; this covers awake-but-disconnected.
      this.#scheduleCards();
    });
    transport.onConnectionChange((connected) => {
      log(`slack: ${connected ? "connected" : "disconnected"}`);
      if (connected) this.#scheduleHome();
    });

    transport.onViewSubmit(async (input) => this.#onViewSubmit(input));

    // Post settled agent output to the session thread on status transition.
    state.on("transition", ({ terminalId, to, from }) => {
      void this.#onTransition(terminalId, to, from);
    });

    // Close the session thread when the pane is gone.
    state.on("paneGone", ({ terminalId }) => {
      void this.#endSession(terminalId);
    });

    registry.load();
    this.#scheduleChannel();
  }

  /**
   * Keep the session card current as its agent moves.
   *
   * This runs for any session with a card, not only Slack-driven turns, so work
   * done at the keyboard still lands in the card, in "Earlier", and in the ping.
   * The only new message is the one-per-turn reply notice, claimed against the
   * turn id — an earlier version keyed off status alone and announced "Finished"
   * on a loop.
   */
  async #onTransition(terminalId: string, to: AgentStatus, from?: AgentStatus): Promise<void> {
    const record = this.deps.registry.get(terminalId);
    if (!record?.slackThreadTs || !record.slackChannel || record.ended) return;
    if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId))) return;

    if (to === "working" || to === "unknown") {
      if (to === "working") this.#clearCursorIdleTimer(terminalId);
      if (this.deps.registry.activeTurn(terminalId)) await this.#sessions.updateCard(terminalId);
      return;
    }
    if (from === undefined) return;

    await this.#sessions.retitle(terminalId);
    this.#clearCursorIdleTimer(terminalId);
    if (to === "idle") {
      this.#scheduleCursorIdlePost(terminalId);
      return;
    }
    if (to === "done" || to === "blocked") {
      await this.#sessions.refreshResponse(terminalId, to);
    }
  }

  /** Close threads whose agent exited but the pane remains. */
  async #reapDeadSessions(): Promise<void> {
    const { state, registry } = this.deps;
    for (const [terminalId, record] of registry.entries()) {
      if (!record.slackThreadTs) continue;
      const pane = state.paneByTerminal(terminalId);
      if (pane?.agent) {
        if (!isEligibleCreRoot(this.deps.config, pane)) continue;
        this.#clearAgentGoneTimer(terminalId);
        if (record.ended) {
          await this.#sessions.reviveIfLive(terminalId);
          registry.save();
        }
        continue;
      }
      if (record.ended) continue;
      if (!pane) {
        this.#clearAgentGoneTimer(terminalId);
        continue;
      }
      this.#scheduleAgentGoneTimer(terminalId);
    }
  }

  #agentGoneDelayMs(): number {
    return this.deps.agentGoneMs ?? AGENT_GONE_MS;
  }

  #cursorIdleDelayMs(): number {
    return this.deps.cursorIdleActivityMs ?? CURSOR_IDLE_ACTIVITY_MS;
  }

  /** Drop Slack retries and duplicate deliveries of the same message ts. */
  #markMessageSeen(ctx: InboundContext): boolean {
    if (ctx.retryNum !== undefined && ctx.retryNum > 0) return false;
    const key = inboundMessageDedupeKey(ctx);
    if (!key) return true;
    if (this.#seenMessageKeys.has(key)) return false;
    this.#seenMessageKeys.add(key);
    if (this.#seenMessageKeys.size > 2_000) this.#seenMessageKeys.clear();
    return true;
  }

  #clearCursorIdleTimer(terminalId: string): void {
    const timer = this.#cursorIdleTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.#cursorIdleTimers.delete(terminalId);
  }

  #scheduleCursorIdlePost(terminalId: string): void {
    this.#clearCursorIdleTimer(terminalId);
    const timer = setTimeout(() => {
      this.#cursorIdleTimers.delete(terminalId);
      const pane = this.deps.state.paneByTerminal(terminalId);
      if (!pane || pane.agent_status !== "idle" || !isEligibleCreRoot(this.deps.config, pane))
        return;
      const record = this.deps.registry.get(terminalId);
      if (!record?.slackThreadTs || !record.slackChannel || record.ended) return;
      void this.#sessions.refreshResponse(terminalId, "done");
    }, this.#cursorIdleDelayMs());
    timer.unref?.();
    this.#cursorIdleTimers.set(terminalId, timer);
  }

  #scheduleAgentGoneTimer(terminalId: string): void {
    if (this.#agentGoneTimers.has(terminalId)) return;
    const timer = setTimeout(() => {
      this.#agentGoneTimers.delete(terminalId);
      void this.#confirmAgentGone(terminalId);
    }, this.#agentGoneDelayMs());
    timer.unref?.();
    this.#agentGoneTimers.set(terminalId, timer);
  }

  #clearAgentGoneTimer(terminalId: string): void {
    const timer = this.#agentGoneTimers.get(terminalId);
    if (!timer) return;
    clearTimeout(timer);
    this.#agentGoneTimers.delete(terminalId);
  }

  async #confirmAgentGone(terminalId: string): Promise<void> {
    const { state, registry } = this.deps;
    const record = registry.get(terminalId);
    if (!record || record.ended || !record.slackThreadTs) return;
    const pane = state.paneByTerminal(terminalId);
    if (!pane || pane.agent) return;
    // herdr can omit agent briefly while the turn is still active.
    if (pane.agent_status === "working" || pane.agent_status === "blocked") {
      this.#scheduleAgentGoneTimer(terminalId);
      return;
    }
    await this.#endSession(terminalId);
  }

  /** End a session once and replace its card with a read-only state. */
  async #endSession(terminalId: string, closedByUser = false): Promise<void> {
    const { registry, log } = this.deps;
    const record = registry.markEnded(terminalId, Date.now(), closedByUser);
    if (!record) return;
    await this.#sessions.closeHeader(terminalId).catch(() => undefined);
    log(`session ended: ${record.title || terminalId}`);
    registry.save();
    this.#scheduleHome();
  }

  async #onViewSubmit(input: {
    ctx: InboundContext;
    callbackId: string;
    view: unknown;
    privateMetadata?: string;
  }): Promise<ViewSubmitResult | undefined> {
    const { ctx, callbackId, view, privateMetadata } = input;
    const { log } = this.deps;
    const decision = checkInbound(this.#guards, ctx);
    if (!decision.allowed) {
      log(`view submit denied: ${decision.reason}`);
      return;
    }
    // A launch may target a peer herd, so this daemon's own herdr being down is
    // not grounds to refuse it; the target's reachability is checked on arrival.
    if (callbackId === MODAL_IDS.newAgent) {
      if (this.deps.config.creOnly) return;
      await this.#launchFromModal(
        ctx.userId,
        await this.#replyChannel(ctx),
        view,
        privateMetadata ?? "",
      );
      return;
    }
    const herdr = requireHerdr(this.#guards);
    if (!herdr.allowed) {
      log(`view submit denied: ${herdr.reason}`);
      if (callbackId === MODAL_IDS.reply) {
        return replyError(herdr.message ?? "herdr is not connected.");
      }
      await this.#ephemeral(
        await this.#replyChannel(ctx),
        herdr.message ?? "herdr is not connected.",
      );
      return;
    }
    if (callbackId !== MODAL_IDS.reply) return;
    const terminalId = this.deps.registry.terminalForRef(privateMetadata ?? "");
    const prompt = parseReplySubmission(view);
    if (!terminalId || !prompt) {
      log("reply modal rejected: missing target or prompt");
      return replyError("That session is no longer available — reopen it from Home.");
    }
    const error = await this.#submitTurn(terminalId, prompt);
    if (error) return replyError(error);
    return;
  }

  /**
   * Open the launch form for the herd whose view the button was in.
   *
   * ＋ New agent only exists inside a herd, so the target is never in doubt and
   * the form never asks. From the overview there would be nothing to infer —
   * which is exactly why the button is not there.
   */
  async #openNewAgentModal(triggerId: string, herdId: string): Promise<void> {
    // Skeleton first: trigger_id expires in about three seconds, well inside
    // the time herdr can take to answer.
    const viewId = await this.deps.transport.openModal(triggerId, skeletonModal("New agent"));
    await this.#renderNewAgentModal(viewId, herdId);
  }

  /**
   * Which herd a launch by this person is for.
   *
   * The same rule Home draws with: one herd needs no choosing, and beyond that
   * it is whichever one they drilled into. Null means the overview, where there
   * is no button to have pressed.
   */
  #targetHerd(userId: string): string | null {
    const herds = this.deps.herd?.homeHerds() ?? [];
    if (herds.length <= 1) return herds[0]?.herdId ?? this.deps.herd?.herdId ?? "";
    const selection = this.#homeSelection.get(userId);
    return selection && selection !== ALL_HERDS ? selection : null;
  }

  /** Render the launch form for one herd. */
  async #renderNewAgentModal(viewId: string, herdId: string): Promise<void> {
    const { herd } = this.deps;
    const targets = await this.#launchTargets(herdId);
    // Last-launch defaults describe a workspace and a directory on *this*
    // machine, so they only apply when this machine is the target.
    const defaults = herdId === (herd?.herdId ?? "") ? readLastLaunch(this.deps.instance) : {};
    await this.#updateModal(
      viewId,
      buildNewAgentModal({ ...targets, selectedHerdId: herdId, defaults }),
    );
  }

  /**
   * Update a modal, and never leave it stuck on the skeleton.
   *
   * A failed `views.update` is invisible: the modal keeps showing "Loading…"
   * with no way forward but closing it. Slack can reject an update for reasons
   * that pass on a second try, so it is worth one — and when it is not, saying
   * so beats an empty box.
   */
  async #updateModal(viewId: string, view: Record<string, unknown>): Promise<void> {
    const { transport, log } = this.deps;
    try {
      await transport.updateModal(viewId, view);
      return;
    } catch (error) {
      log(`modal update failed, retrying: ${describe(error)}`);
    }
    try {
      await transport.updateModal(viewId, view);
    } catch (error) {
      log(`modal update failed: ${describe(error)}`);
      await transport
        .updateModal(viewId, messageModal("New agent", "Slack would not load this form."))
        .catch(() => undefined);
    }
  }

  /** Launch options for a herd: live from herdr locally, heartbeat for a peer. */
  async #launchTargets(herdId: string): Promise<NewAgentTargets> {
    const { herd } = this.deps;
    const isLocal = !herd || herdId === herd.herdId;
    if (isLocal) {
      const [workspaces, worktrees] = await Promise.all([
        this.deps.client.workspaceList().catch(() => []),
        this.deps.client.worktreeList().catch(() => []),
      ]);
      return {
        workspaces: workspaces.map((w) => ({
          id: w.workspace_id,
          label: w.label || w.workspace_id,
        })),
        worktrees: worktrees.map((tree) => ({
          label: tree.label,
          path: tree.path,
          ...(tree.branch ? { branch: tree.branch } : {}),
        })),
        kinds: loadCatalog().map((entry) => ({ kind: entry.kind, label: entry.label })),
      };
    }
    const remote = herd.launchOptionsFor(herdId);
    return remote ?? { workspaces: [], worktrees: [], kinds: [] };
  }

  /**
   * Hand a launch to the herd that owns the machine.
   *
   * We cannot start it ourselves — the target herdr is on a socket only that
   * daemon can reach — so this is fire-and-forget and Home is the receipt.
   */
  async #forwardLaunch(
    herd: HerdPort,
    submission: NewAgentSubmission,
    channel: string,
    userId: string,
  ): Promise<void> {
    herd.forwardCommand({
      op: "launch_agent",
      herdId: submission.herdId ?? "",
      ref: "",
      channel,
      userId,
      launch: {
        kind: submission.kind,
        ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
        ...(submission.cwd ? { cwd: submission.cwd } : {}),
        ...(submission.label ? { label: submission.label } : {}),
        ...(submission.firstPrompt ? { firstPrompt: submission.firstPrompt } : {}),
      },
    });
    this.deps.log(`forwarded launch ${submission.kind} to herd ${submission.herdId}`);
    await this.#ephemeral(
      channel,
      `Starting *${submission.kind}* on that herd — it will appear on Home shortly.`,
    );
  }

  async #launchFromModal(
    userId: string,
    channel: string,
    view: unknown,
    privateMetadata = "",
  ): Promise<void> {
    if (this.deps.config.creOnly) return;
    const submission = parseNewAgentSubmission(view, privateMetadata);
    if (!submission) {
      await this.#ephemeral(channel, "That form was missing an agent.");
      return;
    }

    const { herd } = this.deps;
    if (herd && submission.herdId && submission.herdId !== herd.herdId) {
      await this.#forwardLaunch(herd, submission, channel, userId);
      return;
    }

    // Always auto mode: remote launches cannot answer permission prompts.
    const entry = findEntry(loadCatalog(), submission.kind);
    const mode = autoModeFor(entry);

    writeLastLaunch(this.deps.instance, {
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
      ...(submission.cwd ? { cwd: submission.cwd } : {}),
      kind: submission.kind,
    });

    const name = sanitizeAgentName(submission.label ?? submission.kind);
    const result = await launchAgent(this.deps.client, {
      kind: submission.kind,
      mode,
      name,
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
      ...(submission.cwd ? { cwd: submission.cwd } : {}),
      ...(submission.label ? { label: submission.label } : {}),
      ...(submission.firstPrompt ? { firstPrompt: submission.firstPrompt } : {}),
    });

    // The outcome message is the only record of a first prompt that was lost,
    // so it belongs in the log and not just in an ephemeral the user may miss.
    const delivery =
      result.promptDelivered === undefined ? "" : ` delivered=${result.promptDelivered}`;
    const why = result.message ? ` msg=${result.message}` : "";
    this.deps.log(
      `launch ${submission.kind}/${mode.id} → ${result.ok ? "ok" : "failed"} pane=${result.paneId ?? "?"} firstPrompt=${submission.firstPrompt ? "yes" : "no"}${delivery}${why}`,
    );
    if (!result.ok) {
      await this.#ephemeral(channel, `Could not start ${submission.kind}: ${result.message}`);
      return;
    }
    await this.#ephemeral(
      channel,
      result.promptDelivered === false
        ? `⚠️ Started *${submission.kind}*, but your first prompt did not reach it — ` +
            `open it from the *Home* tab and use *Reply* to send it. (${result.message})`
        : result.message
          ? `Started *${submission.kind}* — ${result.message}`
          : `Started *${submission.kind}* in ${mode.label}. It will appear on the Home tab.`,
    );
    await this.publishHome(userId);
  }

  stop(): void {
    if (this.#homeTimer) clearTimeout(this.#homeTimer);
    this.#homeTimer = null;
    if (this.#cardTimer) clearTimeout(this.#cardTimer);
    this.#cardTimer = null;
    if (this.#channelTimer) clearTimeout(this.#channelTimer);
    this.#channelTimer = null;
    for (const timer of this.#agentGoneTimers.values()) clearTimeout(timer);
    this.#agentGoneTimers.clear();
    for (const timer of this.#cursorIdleTimers.values()) clearTimeout(timer);
    this.#cursorIdleTimers.clear();
    this.#seenMessageKeys.clear();
    this.deps.registry.save();
  }

  /** Refresh registry entries from live state, then retire anything gone. */
  reconcileSessions(): void {
    const { state, registry, log } = this.deps;
    for (const pane of state.agentPanes()) {
      if (!isEligibleCreRoot(this.deps.config, pane)) continue;
      if (registry.get(pane.terminal_id)?.ended) {
        void this.#sessions.reviveIfLive(pane.terminal_id).then((ok) => {
          if (ok) registry.save();
        });
      }
      registry.upsert(pane.terminal_id, {
        lastKnownPaneId: pane.pane_id,
        agentKind: pane.agent ?? "agent",
        title: pane.terminal_title_stripped ?? pane.title ?? "",
        cwd: pane.cwd ?? "",
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        lastStatus: state.statusOf(pane.terminal_id) ?? pane.agent_status,
      });
    }

    const live = new Set(
      state
        .agentPanes()
        .filter((pane) => isEligibleCreRoot(this.deps.config, pane))
        .map((pane) => pane.terminal_id),
    );
    const result = sweepOrphans(registry, live, state.workspaces.size);
    if (result.skipped) {
      log("orphan sweep skipped: snapshot had no workspaces");
    }
    for (const orphan of result.orphaned) {
      log(`session ended: ${orphan.title}`);
      void this.#sessions.closeHeader(
        registry.entries().find(([, record]) => record === orphan)?.[0] ?? "",
      );
    }
    registry.save();
  }

  /**
   * This daemon's herd id.
   *
   * Falls back to the instance key so the id is never empty: Home filters agent
   * rows by herd, and an empty id would match no herd and hide every agent.
   */
  #localHerdId(): string {
    return this.deps.herd?.herdId ?? this.deps.instance;
  }

  /** Build the Home model from live state, never from the registry alone. */
  homeAgents(): HomeAgent[] {
    const { state, registry, herd, config } = this.deps;
    const localHerdId = this.#localHerdId();
    const localLabel = config.label || this.deps.instance;
    // Mint refs for new agents so Home buttons always carry a valid target.
    for (const pane of state.agentPanes()) {
      if (!isEligibleCreRoot(config, pane)) continue;
      if (!registry.get(pane.terminal_id)) {
        registry.upsert(pane.terminal_id, {
          lastKnownPaneId: pane.pane_id,
          agentKind: pane.agent ?? "agent",
          title: pane.terminal_title_stripped ?? pane.title ?? "",
          cwd: pane.cwd ?? "",
          workspaceId: pane.workspace_id,
          tabId: pane.tab_id,
          lastStatus: state.statusOf(pane.terminal_id) ?? pane.agent_status,
        });
      }
    }
    const local = state
      .agentPanes()
      .filter((pane) => isEligibleCreRoot(config, pane))
      .map((pane) => {
        const record = registry.get(pane.terminal_id);
        const workspace = state.workspaces.get(pane.workspace_id);
        // Home only lists live panes, so an ended record here is one the user
        // closed (revival is blocked for those). Keep its ref so Home can offer
        // Open, which re-attaches the card instead of leaving it stranded.
        return agentFromPane(
          pane,
          record?.ref ?? "",
          workspace?.label ?? pane.workspace_id,
          state.statusOf(pane.terminal_id) ?? pane.agent_status,
          record?.ended || !record?.slackChannel || !record.slackThreadTs
            ? undefined
            : resolveThreadPermalink(
                record.slackChannel,
                record.slackThreadTs,
                record.slackPermalink,
              ),
          {
            herdId: localHerdId,
            herdLabel: localLabel,
            actionValue: record?.ref ?? "",
          },
        );
      });
    return config.creOnly ? local : herd ? herd.homeAgents(local) : local;
  }

  async publishHome(userId: string): Promise<void> {
    const { transport, tail, budget, log, herd } = this.deps;
    // Only the primary publishes App Home — satellites would overwrite peers.
    if (herd?.role === "satellite") return;
    if (!budget.tryConsume()) {
      log("home publish skipped: rate budget exhausted");
      return;
    }
    try {
      const agents = this.homeAgents();
      await transport.publishHome(
        userId,
        buildHome({
          herds: herd?.homeHerds() ?? [this.#soloHerd(agents.length)],
          localHerdId: this.#localHerdId(),
          selectedHerdId: this.#homeSelection.get(userId) ?? null,
          agents,
          herdr: tail.status,
          slackConnected: transport.connected,
          herdrSyncedAgoMs: this.#lastSyncAt === null ? null : Date.now() - this.#lastSyncAt,
          role: herd?.role ?? "primary",
          allowLaunch: !this.deps.config.creOnly,
        }),
      );
    } catch (error) {
      log(`home publish failed: ${(error as Error).message}`);
    }
  }

  /** Home's herd row when no bridge is wired (unit tests, single-herd fallback). */
  #soloHerd(agentCount: number): HomeHerd {
    return {
      herdId: this.#localHerdId(),
      label: this.deps.config.label || this.deps.instance,
      pid: process.pid,
      instance: this.deps.instance,
      socketPath: this.deps.config.herdrSocketPath,
      herdrStatus: this.deps.tail.status,
      role: "primary",
      hostname: "local",
      user: "local",
      agentCount,
      isLocal: true,
      updatedAt: Date.now(),
    };
  }

  /**
   * Refresh: pull a fresh snapshot from herdr, not just re-render the cache.
   *
   * `tail.reconcile()` bumps the sync clock itself (via the `synced` event) —
   * a plain re-render here without the live pull would satisfy the tap but
   * leave the data exactly as stale as it was.
   */
  async #resyncHerdr(userId: string): Promise<void> {
    await this.deps.tail.reconcile();
    this.reconcileSessions();
    await this.publishHome(userId);
  }

  async #onAction(
    ctx: InboundContext,
    actionId: string,
    value: string,
    triggerId: string,
    viewId?: string,
  ): Promise<void> {
    const { log } = this.deps;
    // A form input fires block_actions too, and carries no ref — falling
    // through to ref resolution would answer every pick with "I do not
    // recognise that". Nothing in the form needs handling: it is read once, on
    // submit.
    if (MODAL_INPUT_ACTION_IDS.includes(actionId)) return;
    if (
      actionId === HOME_ACTIONS.refresh ||
      actionId === HOME_ACTIONS.newAgent ||
      actionId === HOME_ACTIONS.selectHerd
    ) {
      await this.#onHomeChrome(ctx, actionId, triggerId, value);
      return;
    }
    const rawForAuth = SessionController.isMenuChoiceAction(actionId)
      ? (SessionController.decodeMenuChoice(value)?.ref ?? "")
      : value;
    const channel = await this.#replyChannel(ctx);
    const routed = this.#routeHerdRef(rawForAuth);
    if (routed.foreign) {
      if (this.deps.config.creOnly || this.deps.config.channelBindings?.[ctx.channel]) return;
      const inbound = checkInbound(this.#guards, ctx);
      if (!inbound.allowed) {
        log(`action ${actionId} denied: ${inbound.reason}`);
        await this.#ephemeral(channel, inbound.message ?? "Not allowed.");
        return;
      }
      await this.#forwardForeign(actionId, routed.herdId, routed.ref, channel, ctx.userId);
      return;
    }
    const result = authorizeAction(this.#guards, ctx, routed.ref);
    if (!result.decision.allowed) {
      log(`action ${actionId} denied: ${result.decision.reason}`);
      await this.#ephemeral(channel, result.decision.message ?? "Not allowed.");
      return;
    }
    log(`action ${actionId} terminal=${result.terminalId} actor=${ctx.userId}`);
    await this.#dispatch(actionId, result.terminalId ?? "", value, channel, triggerId, viewId);
  }

  async #onHomeChrome(
    ctx: InboundContext,
    actionId: string,
    triggerId: string,
    value: string,
  ): Promise<void> {
    const { log } = this.deps;
    const decision = checkInbound(this.#guards, ctx);
    if (!decision.allowed) {
      log(`action ${actionId} denied: ${decision.reason}`);
      return;
    }
    if (actionId === HOME_ACTIONS.selectHerd) {
      this.#homeSelection.set(ctx.userId, value);
      await this.publishHome(ctx.userId);
      return;
    }
    if (actionId === HOME_ACTIONS.refresh) {
      await this.#resyncHerdr(ctx.userId);
      return;
    }
    if (this.deps.config.creOnly) {
      await this.#ephemeral(
        await this.#replyChannel(ctx),
        "CRE-only mode: launch CRE in Herdr and pin its session.",
      );
      return;
    }
    // A launch belongs to one herd, and it is the one whose view the button was
    // in. Home does not offer ＋ New agent anywhere else.
    const target = this.#targetHerd(ctx.userId);
    if (target === null || !this.#herdReachable(target)) {
      log(`action ${actionId} denied: no reachable herd`);
      await this.#ephemeral(
        await this.#replyChannel(ctx),
        "That herd is not reachable right now — wake the machine and start herdr.",
      );
      return;
    }
    await this.#openNewAgentModal(triggerId, target);
  }

  /** Fail closed: a herd we cannot find is a herd we will not launch on. */
  #herdReachable(herdId: string): boolean {
    const herds = this.deps.herd?.homeHerds() ?? [];
    if (herds.length === 0) return this.deps.tail.status === "connected";
    return herds.find((herd) => herd.herdId === herdId)?.herdrStatus === "connected";
  }

  #routeHerdRef(value: string): { herdId: string; ref: string; foreign: boolean } {
    const localHerdId = this.#localHerdId();
    const decoded = decodeHerdRef(value, localHerdId);
    return { ...decoded, foreign: decoded.herdId !== localHerdId };
  }

  async #forwardForeign(
    actionId: string,
    herdId: string,
    ref: string,
    channel: string,
    userId: string,
  ): Promise<void> {
    const { herd, log } = this.deps;
    if (!herd) {
      await this.#ephemeral(channel, "That agent belongs to another herd, which is not linked.");
      return;
    }
    if (actionId === SESSION_ACTIONS.reply) {
      await this.#ephemeral(
        channel,
        "Open the session card from that herd, then use *Reply* there — cross-herd Reply from Home is not wired yet.",
      );
      return;
    }
    const op =
      actionId === "home_open_session"
        ? "open_session"
        : actionId === SESSION_ACTIONS.refresh
          ? "refresh"
          : actionId === SESSION_ACTIONS.end
            ? "end_session"
            : null;
    if (!op) {
      await this.#ephemeral(channel, "That action cannot be forwarded to another herd yet.");
      return;
    }
    herd.forwardCommand({ op, herdId, ref, channel, userId });
    log(`forwarded ${actionId} to herd ${herdId} ref=${ref}`);
    await this.#ephemeral(channel, `Sent to herd \`${herdId}\`.`);
  }

  /** Which session owns a Slack thread, if any. */
  terminalForThread(threadTs: string, channel?: string): string | undefined {
    for (const [terminalId, record] of this.deps.registry.entries()) {
      if (record.slackThreadTs === threadTs && (!channel || channel === record.slackChannel))
        return terminalId;
    }
    return undefined;
  }

  async #dispatch(
    actionId: string,
    terminalId: string,
    value: string,
    channel: string,
    triggerId: string,
    viewId?: string,
  ): Promise<void> {
    if (actionId.startsWith(`${SESSION_ACTIONS.historyPage}_`)) {
      const page = Number(actionId.slice(`${SESSION_ACTIONS.historyPage}_`.length));
      if (viewId && Number.isInteger(page) && page >= 0) {
        await this.deps.transport.updateModal(
          viewId,
          buildHistoryModal(
            this.deps.registry.get(terminalId)?.ref ?? "",
            this.deps.registry.turns(terminalId),
            page,
          ),
        );
      }
      return;
    }
    if (SessionController.isMenuChoiceAction(actionId)) {
      await this.#dispatchMenuChoice(terminalId, value, channel);
      return;
    }
    await this.#dispatchSessionControl(actionId, terminalId, channel, triggerId);
  }

  async #dispatchMenuChoice(terminalId: string, value: string, channel: string): Promise<void> {
    const decoded = SessionController.decodeMenuChoice(value);
    if (!decoded) {
      // Malformed menu choices are never forwarded as keypresses.
      this.deps.log("rejected malformed menu choice");
      await this.#ephemeral(channel, "That option is no longer valid.", {
        threadTs: this.#threadFor(terminalId),
      });
      return;
    }
    const prior = this.deps.registry.turns(terminalId).at(-1);
    const baseline =
      prior?.status === "blocked" ? "" : await this.#sessions.captureBaseline(terminalId);
    const outcome = await this.#sessions.chooseMenuOption(terminalId, decoded.choice);
    if (!outcome.ok) {
      await this.#ephemeral(channel, outcome.message ?? "That did not work.");
      return;
    }
    let latest = this.deps.registry.turns(terminalId).at(-1);
    if (!latest || latest.status !== "blocked") {
      latest = this.deps.registry.startTurn(
        terminalId,
        `Selected option ${decoded.choice}`,
        baseline,
      );
    }
    if (latest?.status === "blocked") {
      this.deps.registry.updateTurn(terminalId, latest.id, { status: "working" });
    }
    this.deps.registry.save();
    await this.#sessions.updateCard(terminalId);
    // No retry on timeout; tell the user instead.
    if (!(await this.#sessions.verifyAcknowledged(terminalId, this.deps.ackTimeoutMs))) {
      await this.#ephemeral(
        channel,
        "⚠️ No response yet — the agent may still be waiting. Open the session to check.",
      );
    }
  }

  async #dispatchSessionControl(
    actionId: string,
    terminalId: string,
    channel: string,
    triggerId: string,
  ): Promise<void> {
    switch (actionId) {
      case SESSION_ACTIONS.reply: {
        const record = this.deps.registry.get(terminalId);
        if (!record || record.ended) return;
        await this.deps.transport.openModal(
          triggerId,
          buildReplyModal(record.ref, record.title || record.agentKind),
        );
        return;
      }
      case SESSION_ACTIONS.refresh:
        await this.#sessions.refreshResponse(terminalId);
        return;
      case SESSION_ACTIONS.history: {
        const record = this.deps.registry.get(terminalId);
        if (!record) return;
        await this.deps.transport.openModal(
          triggerId,
          buildHistoryModal(record.ref, this.deps.registry.turns(terminalId)),
        );
        return;
      }
      case SESSION_ACTIONS.end: {
        if (this.deps.config.creOnly) {
          await this.#ephemeral(channel, "Close CRE roots directly in Herdr, not from Slack.");
          return;
        }
        const outcome = await this.#sessions.closeTerminal(terminalId);
        if (!outcome.ok) {
          await this.#ephemeral(channel, outcome.message ?? "That did not work.", {
            threadTs: this.#threadFor(terminalId),
          });
          return;
        }
        const active = this.deps.registry.activeTurn(terminalId);
        if (active) {
          this.deps.registry.updateTurn(terminalId, active.id, {
            status: "stopped",
            completedAt: Date.now(),
          });
        }
        await this.#endSession(terminalId, true);
        return;
      }
      default: {
        const outcome = await this.#sessions.openSession(terminalId, channel);
        if (!outcome.ok) await this.#ephemeral(channel, outcome.message ?? "That did not work.");
        return;
      }
    }
  }

  /**
   * Send one reply, returning a message when it did not reach the agent.
   *
   * The prompt goes out before the turn is recorded and before the card is
   * touched, so a refusal needs no rollback and can be reported in the modal
   * the user is still looking at. Redrawing the card is Slack I/O and would eat
   * the submission's time budget, so it happens after this returns.
   */
  async #submitTurn(terminalId: string, prompt: string): Promise<string | undefined> {
    const record = this.deps.registry.get(terminalId);
    if (!record || record.ended) return "That session has ended — reopen it from the Home tab.";
    if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId))) {
      return "This session is not a verified CRE root.";
    }
    if (this.#submitting.has(terminalId) || this.deps.registry.activeTurn(terminalId)) {
      return "This agent is still working on your last reply. Wait for it to finish.";
    }
    this.#submitting.add(terminalId);
    try {
      const baseline = await this.#sessions.captureBaseline(terminalId);
      if (!isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId))) {
        return "This session is no longer a verified CRE root.";
      }
      const outcome = await this.#sessions.prompt(terminalId, prompt);
      if (!outcome.ok) return outcome.message ?? "The prompt could not be delivered.";
      const turn = this.deps.registry.startTurn(terminalId, prompt, baseline);
      if (!turn) return "That session has ended — reopen it from the Home tab.";
      this.deps.registry.save();
      void this.#sessions.updateCard(terminalId);
      return undefined;
    } finally {
      this.#submitting.delete(terminalId);
    }
  }
  async #mention(ctx: InboundContext, text: string): Promise<void> {
    const auth = checkInbound(this.#guards, ctx);
    if (!auth.allowed || !this.#markMessageSeen(ctx)) return;
    const { state, config, transport } = this.deps;
    const workspaceId = config.channelBindings?.[ctx.channel];
    if (!workspaceId || !state.workspaces.has(workspaceId) || !requireHerdr(this.#guards).allowed)
      return;
    const tag = `<@${config.slack.botUserId}>`;
    const clean = text.trimStart();
    if (!clean.startsWith(tag)) return;
    const instruction = clean.slice(tag.length).trim();
    const cmd = instruction.toLowerCase();
    const reply = async (msg: string) => {
      await transport.postMessage({
        channel: ctx.channel,
        text: msg,
        ...(ctx.threadTs || ctx.ts ? { threadTs: ctx.threadTs || ctx.ts } : {}),
      });
    };
    if (ctx.threadTs) {
      const id = this.terminalForThread(ctx.threadTs, ctx.channel);
      if (
        !id ||
        state.paneByTerminal(id)?.workspace_id !== workspaceId ||
        !isEligibleCreRoot(config, state.paneByTerminal(id))
      ) {
        await reply("Unknown or unverified CRE agent thread.");
        return;
      }
      if (cmd === "stop" || cmd === "end") {
        await reply("End shared CRE roots directly in Herdr.");
        return;
      }
      const error = await this.#submitTurn(id, instruction);
      if (error) await reply(error);
      return;
    }
    await this.#mentionCommand(workspaceId, instruction, reply);
  }

  async #mentionCommand(
    workspaceId: string,
    instruction: string,
    reply: (message: string) => Promise<void>,
  ): Promise<void> {
    const { state, config } = this.deps;
    const cmd = instruction.toLowerCase();
    if (["status", "agents", "blocked"].includes(cmd)) {
      const panes = state
        .agentPanes()
        .filter(
          (p) =>
            p.workspace_id === workspaceId &&
            isEligibleCreRoot(config, p) &&
            (cmd !== "blocked" || p.agent_status === "blocked"),
        );
      await reply(
        [
          `${panes.length} agents in workspace ${workspaceId}`,
          ...panes
            .slice(0, 20)
            .map(
              (p) =>
                `${p.agent ?? "agent"}: ${p.agent_status} — ${p.terminal_title_stripped ?? "untitled"}`,
            ),
        ].join("\\n"),
      );
      return;
    }
    if (cmd === "help" || !cmd) {
      await reply(
        "Use @herdr status, @herdr blocked, @herdr start codex | task, or mention me in an agent thread.",
      );
      return;
    }
    if (config.creOnly) {
      await reply("CRE-only attach mode: start CRE manually in Herdr and pin its session.");
      return;
    }
    const found = /^(?:start|new)\s+([a-z][a-z0-9_-]*)\s*\|\s*([\s\S]+)$/i.exec(instruction);
    if (!found) {
      await reply("Unknown command; try @herdr help.");
      return;
    }
    const kind = found[1] ?? "";
    const firstPrompt = found[2]?.trim() ?? "";
    const entry = findEntry(loadCatalog(), kind);
    if (!entry || !firstPrompt) {
      await reply("Invalid agent kind or empty prompt.");
      return;
    }
    const result = await launchAgent(this.deps.client, {
      workspaceId,
      kind,
      mode: autoModeFor(entry),
      name: sanitizeAgentName(`${kind}-${Date.now().toString(36)}`),
      label: `Slack ${kind}`,
      firstPrompt,
    });
    await reply(
      result.ok
        ? `Started ${kind} in bound workspace.`
        : `Launch failed: ${result.message ?? "unknown"}`,
    );
    this.#scheduleChannel();
  }

  #scheduleChannel(): void {
    if (this.#channelTimer || !Object.keys(this.deps.config.channelBindings ?? {}).length) return;
    this.#channelTimer = setTimeout(() => {
      this.#channelTimer = null;
      void this.#syncChannel();
    }, HOME_DEBOUNCE_MS);
    this.#channelTimer.unref?.();
  }

  async #syncChannel(): Promise<void> {
    if (this.#channelBusy || this.deps.tail.status !== "connected" || !this.deps.state.primed)
      return;
    this.#channelBusy = true;
    try {
      await this.#detachInvalidThreads();
      await this.#syncBoundPanes();
      this.deps.registry.save();
    } finally {
      this.#channelBusy = false;
    }
  }

  async #detachInvalidThreads(): Promise<void> {
    const { state, config, registry, transport } = this.deps;
    for (const [terminalId, record] of registry.entries()) {
      if (
        !config.creOnly ||
        !record.slackChannel ||
        isEligibleCreRoot(config, state.paneByTerminal(terminalId))
      )
        continue;
      if (record.slackThreadTs)
        await transport
          .updateMessage({
            channel: record.slackChannel,
            ts: record.slackThreadTs,
            text: "CRE session identity changed. Thread detached.",
          })
          .catch(() => undefined);
      registry.clearThread(terminalId);
    }
  }

  async #syncBoundPanes(): Promise<void> {
    const { state, config, registry } = this.deps;
    const bindings = Object.entries(config.channelBindings ?? {});
    for (const pane of state.agentPanes()) {
      if (!isEligibleCreRoot(config, pane)) continue;
      const channel = bindings.find(([, id]) => id === pane.workspace_id)?.[0];
      await this.#retireMovedThread(pane.terminal_id, channel);
      if (!channel) continue;
      registry.upsert(pane.terminal_id, {
        lastKnownPaneId: pane.pane_id,
        agentKind: pane.agent ?? "agent",
        title: pane.terminal_title_stripped ?? "",
        cwd: pane.cwd ?? "",
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        lastStatus: state.statusOf(pane.terminal_id) ?? pane.agent_status,
      });
      const rec = registry.get(pane.terminal_id);
      if (rec?.closedByUser || (rec?.slackChannel === channel && rec.slackThreadTs && !rec.ended))
        continue;
      if (!this.deps.budget.tryConsume()) break;
      await this.#sessions
        .openSession(pane.terminal_id, channel)
        .catch((e) => this.deps.log(String(e)));
    }
  }

  async #retireMovedThread(terminalId: string, channel: string | undefined): Promise<void> {
    const { registry, transport } = this.deps;
    const old = registry.get(terminalId);
    if (old?.slackChannel?.match(/^[CG]/) && old.slackChannel !== channel) {
      if (old.slackThreadTs)
        await transport
          .updateMessage({
            channel: old.slackChannel,
            ts: old.slackThreadTs,
            text: "Agent moved. Card retired.",
          })
          .catch(() => undefined);
      registry.clearThread(terminalId);
    }
  }

  /** Handle bare DMs and agent-container suggested prompts as commands. */
  async #handleBareMessage(channel: string, userId: string, text: string): Promise<void> {
    const command = text
      .trim()
      .toLowerCase()
      .replace(/[?.!]+$/, "");
    const wantsAttention = /\b(blocked|needs?|attention|waiting)\b/.test(command);
    const wantsList = /\b(herd|agents?|list|status|show)\b/.test(command);

    if (wantsAttention || wantsList) {
      await this.publishHome(userId);
      await this.#ephemeral(channel, this.#herdSummary(wantsAttention && !wantsList));
      return;
    }
    await this.#ephemeral(
      channel,
      "Open an agent from the *Home* tab and use *Reply* on its session card to prompt it. " +
        "Ask me *what needs my attention* for a summary.",
    );
  }

  /** A one-message answer to "what is my herd doing". */
  #herdSummary(attentionOnly: boolean): string {
    const agents = this.homeAgents();
    if (agents.length === 0)
      return "No agents running. Start one with *＋ New agent* on the Home tab.";

    const blocked = agents.filter((a) => a.status === "blocked");
    if (attentionOnly && blocked.length === 0) {
      return `Nothing is waiting on you. ${agents.length} agent${agents.length === 1 ? "" : "s"} running.`;
    }

    const shown = (attentionOnly ? blocked : agents).slice(0, 10);
    const lines = shown.map(
      (a) =>
        `${GLYPH[a.status]} *${escapeMrkdwn(a.agent)}* · ${escapeMrkdwn(a.title)}${a.permalink ? ` — <${a.permalink}|open>` : ""}`,
    );
    const more = (attentionOnly ? blocked.length : agents.length) - shown.length;
    if (more > 0) lines.push(`_… and ${more} more on the Home tab._`);
    return [
      blocked.length > 0 ? `*${blocked.length} waiting on you*` : "*Your herd*",
      ...lines,
    ].join("\n");
  }

  #scheduleHome(): void {
    if (this.#homeTimer) return;
    this.#homeTimer = setTimeout(() => {
      this.#homeTimer = null;
      for (const userId of this.deps.config.allowedUsers) {
        void this.publishHome(userId);
      }
    }, HOME_DEBOUNCE_MS);
    this.#homeTimer.unref?.();
  }

  /** Republish open session cards so controls appear/disappear with herdr liveness. */
  #scheduleCards(): void {
    if (this.#cardTimer) return;
    this.#cardTimer = setTimeout(() => {
      this.#cardTimer = null;
      for (const [terminalId, record] of this.deps.registry.entries()) {
        if (
          record.ended ||
          !record.slackThreadTs ||
          !record.slackChannel ||
          !isEligibleCreRoot(this.deps.config, this.deps.state.paneByTerminal(terminalId))
        )
          continue;
        void this.#sessions.updateCard(terminalId);
      }
    }, HOME_DEBOUNCE_MS);
    this.#cardTimer.unref?.();
  }

  /** Resolve a reply channel; App Home and modals may omit one. */
  async #replyChannel(ctx: { channel: string; userId: string }): Promise<string> {
    if (ctx.channel) return ctx.channel;
    const cached = this.#dmChannels.get(ctx.userId);
    if (cached) return cached;
    try {
      const channel = await this.deps.transport.openDm(ctx.userId);
      if (channel) this.#dmChannels.set(ctx.userId, channel);
      return channel;
    } catch {
      return "";
    }
  }

  /** Post user-only notes; use ephemeral so they never persist on the card. */
  async #ephemeral(channel: string, text: string, to?: NoticeTarget): Promise<void> {
    if (!channel || !this.deps.budget.tryConsume()) return;
    const userId = to?.userId ?? this.#lastActor;
    if (!userId) {
      await this.deps.transport.postMessage({ channel, text }).catch(() => undefined);
      return;
    }
    await this.deps.transport
      .postEphemeral({
        channel,
        user: userId,
        text,
        ...(to?.threadTs ? { threadTs: to.threadTs } : {}),
      })
      .catch(() => undefined);
  }

  /** The thread for a terminal, when it has one, so notes land in context. */
  #threadFor(terminalId: string): string | undefined {
    return this.deps.registry.get(terminalId)?.slackThreadTs;
  }
}
