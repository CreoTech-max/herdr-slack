/**
 * herdr protocol 19 wire types.
 *
 * Shapes verified against `herdr api schema --json` from a live 0.8.0 server.
 * Do not re-derive from other plugins — check herdr docs and a live socket first.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export const AGENT_STATUSES: readonly AgentStatus[] = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
] as const;

/** Snapshot source for pane.read / agent.read. */
export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export interface PaneScrollInfo {
  max_offset_from_bottom: number;
  offset_from_bottom: number;
  viewport_rows: number;
}

export interface AgentSessionInfo {
  /** Agent kind that owns the session, e.g. "codex". */
  agent: string;
  kind: string;
  source: string;
  /** The agent's own session identifier — its native resume handle. */
  value: string;
}

/**
 * A pane as reported by pane.updated / pane.created / session.snapshot.
 *
 * `terminal_id` is the stable identity. `pane_id` is NOT: pane.move reassigns it
 * and closed ids are never reused. See ADR 0003.
 */
export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  scroll?: PaneScrollInfo | null;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status: AgentStatus;
  active_tab_id: string;
  tab_count: number;
  pane_count: number;
  worktree?: WorkspaceWorktreeInfo | null;
  tokens?: Record<string, string>;
}

export interface WorkspaceWorktreeInfo {
  path?: string;
  branch?: string | null;
  label?: string;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  agent_status: AgentStatus;
  pane_count: number;
}

export interface WorktreeInfo {
  path: string;
  label: string;
  branch?: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_linked_worktree: boolean;
  is_prunable: boolean;
  open_workspace_id?: string | null;
}

/** An entry from agent.list. Shares most fields with PaneInfo. */
export interface AgentInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: AgentStatus;
  focused: boolean;
  revision: number;
  /** Set by `agent.start`/`agent.rename`; null after cre's `/new` (herdr 0.9.3). */
  name?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  state_change_seq?: number;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// events.subscribe replays current state on connect as synthetic *_created
// events, then emits {"type":"subscription_started"}. That replay is our
// bootstrap snapshot.

export type EventKind =
  | "workspace_created"
  | "workspace_updated"
  | "workspace_metadata_updated"
  | "workspace_closed"
  | "workspace_renamed"
  | "workspace_moved"
  | "workspace_reordered"
  | "workspace_focused"
  | "worktree_created"
  | "worktree_opened"
  | "worktree_removed"
  | "tab_created"
  | "tab_closed"
  | "tab_renamed"
  | "tab_moved"
  | "tab_focused"
  | "pane_created"
  | "pane_closed"
  | "pane_updated"
  | "pane_focused"
  | "pane_moved"
  | "pane_output_changed"
  | "pane_exited"
  | "pane_agent_detected"
  | "pane_agent_status_changed"
  | "layout_updated";

/**
 * Only the event payloads we act on are modelled precisely; everything else
 * arrives as a generic record and is ignored by the projection.
 *
 * Note pane_closed / pane_exited carry NO terminal_id — by the time they arrive
 * the pane is gone, which is why the projection maintains a paneId→terminalId
 * reverse index eagerly. See ADR 0003.
 */
export type HerdrEvent =
  | { type: "workspace_created" | "workspace_updated"; workspace: WorkspaceInfo }
  | { type: "workspace_closed"; workspace_id: string }
  | { type: "workspace_renamed"; workspace_id: string; label: string }
  | { type: "tab_created" | "tab_renamed"; tab: TabInfo }
  | { type: "tab_closed"; tab_id: string }
  | { type: "pane_created" | "pane_updated"; pane: PaneInfo }
  | { type: "pane_moved"; pane: PaneInfo; previous_pane_id: string }
  | { type: "pane_closed" | "pane_exited"; pane_id: string; workspace_id: string }
  | { type: string; [key: string]: unknown };

export interface EventEnvelope {
  event: EventKind;
  data: HerdrEvent;
}

/** Subscriptions we use. All are global — none require a pane_id. */
export const GLOBAL_SUBSCRIPTIONS = [
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.closed" },
  { type: "pane.created" },
  { type: "pane.updated" },
  { type: "pane.moved" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
  { type: "worktree.created" },
  { type: "worktree.removed" },
] as const;

// ── Errors ──────────────────────────────────────────────────────────────────

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }

  /** True when herdr rejected the request because the target no longer exists. */
  get isNotFound(): boolean {
    return this.code === "not_found";
  }
}
