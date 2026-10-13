/**
 * Primary / satellite coordination for one Slack app and many herdr sources.
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import { autoModeFor, findEntry, loadCatalog } from "../agents/catalog.js";
import { launchAgent, sanitizeAgentName } from "../agents/launcher.js";
import type { InstanceConfig } from "../config/config.js";
import { configDir } from "../config/instance.js";
import type { HerdrClient } from "../herdr/client.js";
import type { EventTail, TailStatus } from "../herdr/events.js";
import type { SessionState } from "../herdr/state.js";
import type { SessionRegistry } from "../registry/registry.js";
import type { HomeAgent, HomeHerd } from "../slack/home.js";
import { agentFromPane } from "../slack/home.js";
import type { SessionController } from "../slack/session-controller.js";
import { PeerDirectory, hashId, pointerFor, resolveRegistryDir, splitWith } from "./herd-peers.js";
import {
  HEARTBEAT_INTERVAL_MS,
  type HerdAgentSnapshot,
  type HerdCommand,
  type HerdHeartbeat,
  type HerdLaunchOptions,
  type HerdLaunchRequest,
  HerdRegistry,
  OWNERSHIP_STALE_MS,
  defaultHerdRegistryDir,
  deriveHerdId,
  encodeHerdRef,
} from "./herd-registry.js";
import { registryKey } from "./herd-signing.js";

export type SlackRole = "primary" | "satellite";

/** Cap on agents advertised to peers, so one busy herd cannot bloat the file. */
const MAX_ADVERTISED_AGENTS = 40;

export interface HerdBridgeDeps {
  config: InstanceConfig;
  instance: string;
  state: SessionState;
  tail: EventTail;
  registry: SessionRegistry;
  client: HerdrClient;
  log: (line: string) => void;
  /**
   * Called when this satellite could take Slack ownership but cannot without a
   * restart. Swapping the transport in place would mean rebuilding every
   * handler mid-flight; the service manager restarting us is simpler and the
   * election on startup is the only place ownership is taken.
   */
  onPromotable?: () => void;
  /**
   * A dry run takes no part in ownership: it must not claim Slack from the real
   * daemon, must not demote it, and must not restart itself to take over a seat
   * it is only pretending to hold.
   */
  dryRun?: boolean;
  /**
   * Called when a peer on this Slack app is using a different registry. That is
   * two primaries, which is exactly what makes Home flap. Restarting re-runs
   * discovery, which lands this daemon on the shared registry and back to one
   * owner — the alternative is rebuilding the transport in place mid-flight.
   */
  onRegistrySplit?: () => void;
  /** Override for tests. */
  registryDir?: string;
  peersDir?: string;
  herdId?: string;
}

export class HerdBridge {
  readonly herdId: string;
  readonly registry: HerdRegistry;
  #role: SlackRole = "satellite";
  #timer: NodeJS.Timeout | null = null;
  #commandTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #sessions: SessionController | null = null;
  #promotionAnnounced = false;
  #splitAnnounced = false;
  /** Cached worktrees, refreshed on the heartbeat tick for peers' launch form. */
  #worktrees: HerdLaunchOptions["worktrees"] = [];
  readonly #peers: PeerDirectory | null;
  readonly #appIdHash: string;

  constructor(private readonly deps: HerdBridgeDeps) {
    this.herdId = deps.herdId ?? deriveHerdId(deps.instance);
    const key = registryKey(deps.config.slack.botToken);
    this.#appIdHash = hashId(deps.config.slack.appId);

    // A dry run must not advertise itself machine-wide: a phantom pointer would
    // read as a peer to the real daemons and send them into a restart.
    this.#peers =
      deps.dryRun === true || deps.registryDir !== undefined
        ? null
        : new PeerDirectory(key, deps.peersDir);

    const choice = this.#chooseRegistry();
    this.registry = new HerdRegistry(choice.dir, key, { shared: choice.shared });
    this.deps.log(`herd registry ${choice.dir} (${choice.reason}, shared=${choice.shared})`);
  }

  #chooseRegistry(): ReturnType<typeof resolveRegistryDir> {
    const { deps } = this;
    if (deps.registryDir !== undefined) {
      return { dir: deps.registryDir, shared: false, reason: "configured" };
    }
    return resolveRegistryDir({
      configured: deps.config.herdRegistryDir,
      privateDefault: defaultHerdRegistryDir(configDir()),
      peers: this.#peers?.peers(this.#appIdHash, this.herdId) ?? [],
      self: this.#peers?.self(this.#appIdHash, this.herdId) ?? null,
    });
  }

  /** Called once Surfaces has constructed its SessionController. */
  attachSessions(sessions: SessionController): void {
    this.#sessions = sessions;
  }

  get role(): SlackRole {
    return this.#role;
  }

  /** Elect primary (Socket Mode owner) or fall back to satellite. */
  async elect(): Promise<SlackRole> {
    const won = await this.registry.claimOwnership({
      appId: this.deps.config.slack.appId,
      herdId: this.herdId,
      pid: process.pid,
    });
    this.#role = won ? "primary" : "satellite";
    this.deps.log(
      `herd ${this.herdId} is ${this.#role} for app ${this.deps.config.slack.appId} (registry ${this.registry.root}, shared=${this.registry.shared})`,
    );
    return this.#role;
  }

  start(): void {
    this.#stopped = false;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), HEARTBEAT_INTERVAL_MS);
    this.#timer.unref?.();
    if (this.#role === "satellite") {
      this.#commandTimer = setInterval(() => void this.#drainCommands(), 750);
      this.#commandTimer.unref?.();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#commandTimer) clearInterval(this.#commandTimer);
    this.#commandTimer = null;
    this.registry.removeHeartbeat(this.herdId);
    this.#peers?.remove(this.herdId);
  }

  /**
   * Announce our registry, and notice anyone who is not on it.
   *
   * A peer on a different registry cannot see our ownership claim, so it has
   * elected itself primary too — two Socket Mode clients and two Home
   * publishers. Discovery on the next boot puts us both on the shared
   * registry, so the way out is a restart.
   */
  #syncPeers(): void {
    const peers = this.#peers;
    if (!peers || this.#stopped) return;
    peers.publish(
      pointerFor({
        herdId: this.herdId,
        appId: this.deps.config.slack.appId,
        registryDir: this.registry.root,
      }),
    );

    const split = splitWith(peers.peers(this.#appIdHash, this.herdId), this.registry.root);
    if (split.length === 0) {
      this.#splitAnnounced = false;
      return;
    }
    if (this.#splitAnnounced) return;
    this.#splitAnnounced = true;
    const strays = split.map((peer) => peer.herdId).join(", ");
    this.deps.log(
      `another herd on this Slack app is using a different registry (${strays}) — both sides think they own Slack, which is what makes Home flap. Restarting to move onto the shared registry.`,
    );
    this.deps.onRegistrySplit?.();
  }

  /** Snapshot for Home: every live herd on this Slack app. */
  homeHerds(): HomeHerd[] {
    return this.registry.listHeartbeats(this.deps.config.slack.appId).map((peer) => ({
      herdId: peer.herdId,
      label: peer.label || peer.instance,
      pid: peer.pid,
      instance: peer.instance,
      socketPath: peer.socketPath,
      herdrStatus: peer.herdrStatus,
      role: peer.role,
      hostname: peer.hostname,
      user: peer.user,
      agentCount: peer.agents.length,
      isLocal: peer.herdId === this.herdId,
      updatedAt: peer.updatedAt,
    }));
  }

  /** Agents across all herds, with Open values routed for foreign ones. */
  homeAgents(localAgents: HomeAgent[]): HomeAgent[] {
    const localIds = new Set(localAgents.map((a) => a.terminalId));
    const merged = [...localAgents];
    for (const peer of this.registry.listHeartbeats(this.deps.config.slack.appId)) {
      if (peer.herdId === this.herdId) continue;
      for (const agent of peer.agents) {
        if (localIds.has(agent.terminalId)) continue;
        merged.push({
          ref: agent.ref,
          actionValue: encodeHerdRef(peer.herdId, agent.ref, this.herdId),
          terminalId: agent.terminalId,
          agent: agent.agent,
          title: agent.title,
          cwd: agent.cwd,
          status: agent.status,
          workspaceId: "",
          workspaceLabel: agent.workspaceLabel,
          herdId: peer.herdId,
          herdLabel: peer.label || peer.instance,
          ...(agent.permalink ? { permalink: agent.permalink } : {}),
        });
      }
    }
    return merged;
  }

  /** What a herd can launch into, for the New agent form. */
  launchOptionsFor(herdId: string): HerdLaunchOptions | null {
    if (herdId === this.herdId) return this.#localLaunchOptions();
    const peer = this.registry
      .listHeartbeats(this.deps.config.slack.appId)
      .find((row) => row.herdId === herdId);
    return peer?.launch ?? null;
  }

  forwardCommand(input: {
    op: HerdCommand["op"];
    herdId: string;
    ref: string;
    channel: string;
    userId: string;
    text?: string;
    launch?: HerdLaunchRequest;
  }): string {
    const id = randomBytes(8).toString("hex");
    this.registry.enqueueCommand({
      id,
      op: input.op,
      herdId: input.herdId,
      ref: input.ref,
      channel: input.channel,
      userId: input.userId,
      createdAt: Date.now(),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.launch !== undefined ? { launch: input.launch } : {}),
    });
    return id;
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#tickBody();
    } catch (error) {
      // A wiped shared directory, a locked mount, anything mid-tick — log and
      // try again next interval. Letting this escape kills the daemon via
      // unhandledRejection, and KeepAlive only helps after that if the exit
      // was non-zero; better never to die for a heartbeat in the first place.
      this.deps.log(`herd tick failed: ${(error as Error).message}`);
    }
  }

  async #tickBody(): Promise<void> {
    this.#syncPeers();
    const appId = this.deps.config.slack.appId;
    if (this.#role === "primary") {
      this.registry.renewOwnership(appId, this.herdId, process.pid);
      const owner = this.registry.readOwnership(appId);
      if (owner && owner.herdId !== this.herdId) {
        this.deps.log(`lost Slack ownership to ${owner.herdId}; becoming satellite`);
        this.#role = "satellite";
      }
    } else {
      // Deliberately does not claim: taking ownership without owning Socket
      // Mode would demote the real primary on its next tick and leave Slack
      // with no owner at all. Ownership is only ever taken during election.
      const owner = this.registry.readOwnership(appId);
      const ownerless = !owner || Date.now() - owner.updatedAt > OWNERSHIP_STALE_MS;
      if (ownerless && !this.#promotionAnnounced) {
        this.#promotionAnnounced = true;
        this.deps.log("no live Slack owner for this app; restarting to take it over");
        this.deps.onPromotable?.();
      } else if (!ownerless) {
        this.#promotionAnnounced = false;
      }
    }

    await this.#refreshWorktrees();
    this.registry.writeHeartbeat({
      herdId: this.herdId,
      label: this.deps.config.label || this.deps.instance,
      pid: process.pid,
      instance: this.deps.instance,
      socketPath: this.deps.config.herdrSocketPath,
      appId,
      teamId: this.deps.config.slack.teamId,
      herdrStatus: this.deps.tail.status as TailStatus,
      agents: this.#snapshotAgents(),
      updatedAt: Date.now(),
      role: this.#role,
      hostname: os.hostname(),
      user: os.userInfo().username,
      launch: this.#localLaunchOptions(),
    } satisfies HerdHeartbeat);
  }

  async #refreshWorktrees(): Promise<void> {
    if (this.deps.tail.status !== "connected") return;
    try {
      const worktrees = await this.deps.client.worktreeList();
      this.#worktrees = worktrees.map((tree) => ({
        label: tree.label,
        path: tree.path,
        ...(tree.branch ? { branch: tree.branch } : {}),
      }));
    } catch {
      // Keep the last known list; the form degrades to typing a path.
    }
  }

  #localLaunchOptions(): HerdLaunchOptions {
    return {
      workspaces: [...this.deps.state.workspaces.values()].map((workspace) => ({
        id: workspace.workspace_id,
        label: workspace.label || workspace.workspace_id,
      })),
      worktrees: this.#worktrees,
      kinds: loadCatalog().map((entry) => ({ kind: entry.kind, label: entry.label })),
    };
  }

  #snapshotAgents(): HerdAgentSnapshot[] {
    const { state, registry } = this.deps;
    const out: HerdAgentSnapshot[] = [];
    for (const pane of state.agentPanes()) {
      const record = registry.get(pane.terminal_id);
      const status = state.statusOf(pane.terminal_id) ?? pane.agent_status ?? "unknown";
      const workspace = state.workspaces.get(pane.workspace_id);
      const agent = agentFromPane(
        pane,
        record?.ref ?? "",
        workspace?.label ?? pane.workspace_id,
        status,
        record?.slackPermalink,
      );
      out.push({
        ref: agent.ref,
        terminalId: agent.terminalId,
        agent: agent.agent,
        title: agent.title,
        cwd: agent.cwd,
        status: agent.status,
        workspaceLabel: agent.workspaceLabel,
        ...(agent.permalink ? { permalink: agent.permalink } : {}),
      });
      if (out.length >= MAX_ADVERTISED_AGENTS) break;
    }
    return out;
  }

  async #drainCommands(): Promise<void> {
    if (this.#stopped || this.#role !== "satellite") return;
    for (const command of this.registry.listCommands(this.herdId)) {
      try {
        const message = await this.#runCommand(command);
        this.registry.completeCommand(command, {
          ok: !message,
          ...(message ? { message } : {}),
          completedAt: Date.now(),
        });
      } catch (error) {
        this.registry.completeCommand(command, {
          ok: false,
          message: (error as Error).message,
          completedAt: Date.now(),
        });
      }
    }
  }

  async #runCommand(command: HerdCommand): Promise<string | undefined> {
    const sessions = this.#sessions;
    if (!sessions) return "Session controller not ready.";
    if (this.deps.tail.status !== "connected") return "That herd's herdr is not connected.";

    if (command.op === "launch_agent") {
      return this.#runLaunch(command);
    }

    const terminalId = this.deps.registry.terminalForRef(command.ref);
    if (!terminalId) return "That agent is no longer on this herd.";

    switch (command.op) {
      case "open_session": {
        const outcome = await sessions.openSession(terminalId, command.channel);
        return outcome.ok ? undefined : outcome.message;
      }
      case "refresh": {
        await sessions.refreshResponse(terminalId);
        return undefined;
      }
      case "end_session": {
        const outcome = await sessions.closeTerminal(terminalId);
        return outcome.ok ? undefined : outcome.message;
      }
      case "prompt": {
        if (!command.text) return "Missing prompt.";
        const baseline = await sessions.captureBaseline(terminalId);
        const outcome = await sessions.prompt(terminalId, command.text);
        if (!outcome.ok) return outcome.message;
        this.deps.registry.startTurn(terminalId, command.text, baseline);
        this.deps.registry.save();
        void sessions.updateCard(terminalId);
        return undefined;
      }
      default:
        return "Unknown command.";
    }
  }

  async #runLaunch(command: HerdCommand): Promise<string | undefined> {
    const request = command.launch;
    if (!request?.kind) return "Missing agent kind.";
    // Always auto mode: a remote launch cannot answer a permission prompt.
    const entry = findEntry(loadCatalog(), request.kind);
    const mode = autoModeFor(entry);
    const result = await launchAgent(this.deps.client, {
      kind: request.kind,
      mode,
      name: sanitizeAgentName(request.label ?? request.kind),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.label ? { label: request.label } : {}),
      ...(request.firstPrompt ? { firstPrompt: request.firstPrompt } : {}),
      command: entry?.command,
    });
    this.deps.log(
      `remote launch ${request.kind} → ${result.ok ? "ok" : "failed"} pane=${result.paneId ?? "?"}`,
    );
    if (!result.ok) return result.message ?? `Could not start ${request.kind}.`;
    if (result.promptDelivered === false) {
      return `Started ${request.kind}, but the first prompt did not reach it — open it and use Reply.`;
    }
    return undefined;
  }
}
