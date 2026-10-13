import { EventEmitter } from "node:events";
import type {
  AgentStatus,
  HerdrEvent,
  PaneInfo,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "./types.js";

/** Debounce agent_status before emitting transitions; shorter for `blocked`. */
export const STATUS_DEBOUNCE_MS: Readonly<Record<AgentStatus, number>> = {
  blocked: 3_000,
  done: 10_000,
  idle: 3_000,
  working: 0,
  unknown: 0,
};

export interface StatusTransition {
  terminalId: string;
  pane: PaneInfo;
  from: AgentStatus | undefined;
  to: AgentStatus;
}

export interface PaneGone {
  terminalId: string;
  paneId: string;
}

export interface SessionStateEvents {
  transition: [StatusTransition];
  paneGone: [PaneGone];
  /** Any structural change worth re-rendering App Home for. */
  changed: [];
  /** A pane's output revision advanced. */
  output: [{ terminalId: string; paneId: string; revision: number }];
}

/** In-memory herdr session projection; identity is terminal_id, not pane_id. */
export class SessionState extends EventEmitter<SessionStateEvents> {
  /** Overridable debounce windows for tests. */
  readonly debounceMs: Readonly<Record<AgentStatus, number>>;

  constructor(debounceMs: Partial<Record<AgentStatus, number>> = {}) {
    super();
    this.debounceMs = { ...STATUS_DEBOUNCE_MS, ...debounceMs };
  }

  readonly workspaces = new Map<string, WorkspaceInfo>();
  readonly tabs = new Map<string, TabInfo>();
  /** terminal_id → pane */
  readonly panes = new Map<string, PaneInfo>();
  /** pane_id → terminal_id; needed because pane_closed carries no terminal_id. */
  readonly terminalByPane = new Map<string, string>();

  /** Status we have actually announced, per terminal. */
  readonly #committed = new Map<string, AgentStatus>();
  readonly #pending = new Map<string, NodeJS.Timeout>();
  /** terminal_id → agent name. Only snapshots carry it; no event does. */
  readonly #names = new Map<string, string>();

  /** Suppress transition emissions until connect-time replay finishes. */
  #primed = false;

  get primed(): boolean {
    return this.#primed;
  }

  /** Called by the tail once the connect-time replay has finished. */
  markPrimed(): void {
    this.#primed = true;
  }

  /** Silence transitions while a snapshot overwrites committed status. */
  markUnprimed(): void {
    this.#primed = false;
  }

  statusOf(terminalId: string): AgentStatus | undefined {
    return this.#committed.get(terminalId);
  }

  /** herdr's agent name (`agent.rename`), refreshed from each snapshot. */
  nameOf(terminalId: string): string | undefined {
    return this.#names.get(terminalId);
  }

  paneByTerminal(terminalId: string): PaneInfo | undefined {
    return this.panes.get(terminalId);
  }

  /** Resolve a terminal to the pane id that currently hosts it. */
  currentPaneId(terminalId: string): string | undefined {
    return this.panes.get(terminalId)?.pane_id;
  }

  /** Every live agent pane, newest-blocked first is left to callers. */
  agentPanes(): PaneInfo[] {
    return [...this.panes.values()].filter((pane) => Boolean(pane.agent));
  }

  /** Replace all state from a full snapshot (bootstrap and periodic reconcile). */
  applySnapshot(snapshot: SessionSnapshot): void {
    this.workspaces.clear();
    this.tabs.clear();
    for (const workspace of snapshot.workspaces ?? []) {
      this.workspaces.set(workspace.workspace_id, workspace);
    }
    for (const tab of snapshot.tabs ?? []) this.tabs.set(tab.tab_id, tab);

    const seen = new Set<string>();
    for (const pane of snapshot.panes ?? []) {
      seen.add(pane.terminal_id);
      this.#upsertPane(pane);
    }
    for (const terminalId of [...this.panes.keys()]) {
      if (!seen.has(terminalId)) this.#removeTerminal(terminalId);
    }
    this.#names.clear();
    for (const agent of snapshot.agents ?? []) {
      if (agent.name) this.#names.set(agent.terminal_id, agent.name);
    }
    this.emit("changed");
  }

  apply(event: HerdrEvent): void {
    switch (event.type) {
      case "workspace_created":
      case "workspace_updated": {
        const { workspace } = event as { workspace: WorkspaceInfo };
        this.workspaces.set(workspace.workspace_id, workspace);
        this.emit("changed");
        break;
      }
      case "workspace_renamed": {
        const { workspace_id, label } = event as { workspace_id: string; label: string };
        const existing = this.workspaces.get(workspace_id);
        if (existing) this.workspaces.set(workspace_id, { ...existing, label });
        this.emit("changed");
        break;
      }
      case "workspace_closed": {
        const { workspace_id } = event as { workspace_id: string };
        this.workspaces.delete(workspace_id);
        for (const [tabId, tab] of this.tabs) {
          if (tab.workspace_id === workspace_id) this.tabs.delete(tabId);
        }
        for (const pane of [...this.panes.values()]) {
          if (pane.workspace_id === workspace_id) this.#closePane(pane.pane_id);
        }
        this.emit("changed");
        break;
      }
      case "tab_created":
      case "tab_renamed": {
        const { tab } = event as { tab?: TabInfo };
        // Seen live from herdr with `tab` absent; the 30s reconcile repairs
        // the projection either way, so drop the malformed frame rather than
        // crash the whole daemon on it.
        if (!tab) break;
        this.tabs.set(tab.tab_id, tab);
        this.emit("changed");
        break;
      }
      case "tab_closed": {
        const { tab_id } = event as { tab_id: string };
        this.tabs.delete(tab_id);
        this.emit("changed");
        break;
      }
      case "pane_created":
      case "pane_updated": {
        this.#upsertPane((event as { pane: PaneInfo }).pane);
        break;
      }
      case "pane_moved": {
        const { pane, previous_pane_id } = event as { pane: PaneInfo; previous_pane_id: string };
        // Drop stale pane_id mapping before inserting the reassigned id.
        this.terminalByPane.delete(previous_pane_id);
        this.#upsertPane(pane);
        this.emit("changed");
        break;
      }
      case "pane_closed":
      case "pane_exited": {
        this.#closePane((event as { pane_id: string }).pane_id);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Apply a per-pane `pane.agent_status_changed` event.
   *
   * The event carries no terminal_id or revision, so it only moves the status
   * of a pane we already know; anything else waits for the next reconcile.
   */
  applyAgentStatus(paneId: string, status: AgentStatus): void {
    const terminalId = this.terminalByPane.get(paneId);
    const pane = terminalId ? this.panes.get(terminalId) : undefined;
    if (!pane || pane.agent_status === status) return;
    this.#upsertPane({ ...pane, agent_status: status });
  }

  /** Cancel pending debounce timers. Call on shutdown so the process can exit. */
  dispose(): void {
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    this.removeAllListeners();
  }

  #upsertPane(pane: PaneInfo): void {
    const previous = this.panes.get(pane.terminal_id);
    this.panes.set(pane.terminal_id, pane);
    this.terminalByPane.set(pane.pane_id, pane.terminal_id);

    // Drop the old pane_id when a terminal moves.
    if (previous && previous.pane_id !== pane.pane_id) {
      this.terminalByPane.delete(previous.pane_id);
      this.emit("changed");
    }

    if (previous && pane.revision > previous.revision) {
      this.emit("output", {
        terminalId: pane.terminal_id,
        paneId: pane.pane_id,
        revision: pane.revision,
      });
    }
    // Agent attach/detach is structural even when status does not change.
    if (previous && Boolean(previous.agent) !== Boolean(pane.agent)) this.emit("changed");
    if (!previous) this.emit("changed");

    this.#observeStatus(pane);
  }

  #observeStatus(pane: PaneInfo): void {
    const terminalId = pane.terminal_id;
    const next = pane.agent_status;
    const committed = this.#committed.get(terminalId);

    if (!this.#primed) {
      this.#committed.set(terminalId, next);
      return;
    }
    if (next === committed) {
      // Status returned before the debounce window elapsed.
      const timer = this.#pending.get(terminalId);
      if (timer) {
        clearTimeout(timer);
        this.#pending.delete(terminalId);
      }
      return;
    }

    const existing = this.#pending.get(terminalId);
    if (existing) clearTimeout(existing);

    const delay = this.debounceMs[next] ?? 0;
    if (delay === 0) {
      this.#pending.delete(terminalId);
      this.#commit(terminalId, committed, next);
      return;
    }

    const timer = setTimeout(() => {
      this.#pending.delete(terminalId);
      const current = this.panes.get(terminalId);
      // Only fire if the status still holds and the terminal still exists.
      if (!current || current.agent_status !== next) return;
      this.#commit(terminalId, this.#committed.get(terminalId), next);
    }, delay);
    timer.unref?.();
    this.#pending.set(terminalId, timer);
  }

  #commit(terminalId: string, from: AgentStatus | undefined, to: AgentStatus): void {
    this.#committed.set(terminalId, to);
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    this.emit("transition", { terminalId, pane, from, to });
    this.emit("changed");
  }

  #closePane(paneId: string): void {
    // pane_closed carries pane_id only; resolve via terminalByPane.
    const terminalId = this.terminalByPane.get(paneId);
    this.terminalByPane.delete(paneId);
    if (!terminalId) return;
    const pane = this.panes.get(terminalId);
    // Ignore stale pane_id after a terminal moved elsewhere.
    if (pane && pane.pane_id !== paneId) return;
    this.#removeTerminal(terminalId);
    this.emit("paneGone", { terminalId, paneId });
    this.emit("changed");
  }

  #removeTerminal(terminalId: string): void {
    const pane = this.panes.get(terminalId);
    if (pane) this.terminalByPane.delete(pane.pane_id);
    this.panes.delete(terminalId);
    this.#committed.delete(terminalId);
    this.#names.delete(terminalId);
    const timer = this.#pending.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.#pending.delete(terminalId);
    }
  }
}
