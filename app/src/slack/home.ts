import type { TailStatus } from "../herdr/events.js";
import type { AgentStatus, PaneInfo } from "../herdr/types.js";
import { escapeMrkdwn } from "./format.js";

export const GLYPH: Record<AgentStatus, string> = {
  blocked: "🔴",
  working: "⚙️",
  idle: "💤",
  done: "✅",
  unknown: "❔",
};

export const HOME_ACTIONS = {
  refresh: "home_refresh",
  newAgent: "home_new_agent",
  openSession: "home_open_session",
  selectHerd: "home_select_herd",
} as const;

/** Value used by the "all herds" overview, which is not a herd id. */
export const ALL_HERDS = "__all__";

export interface HomeAgent {
  ref: string;
  /** Button value — may be herd-encoded for foreign agents. */
  actionValue: string;
  terminalId: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  workspaceId: string;
  workspaceLabel: string;
  permalink?: string;
  /** Which herd this agent belongs to. */
  herdId: string;
  herdLabel: string;
}

export interface HomeHerd {
  herdId: string;
  label: string;
  pid: number;
  instance: string;
  socketPath: string;
  herdrStatus: TailStatus;
  role: "primary" | "satellite";
  hostname: string;
  user: string;
  agentCount: number;
  isLocal: boolean;
  updatedAt: number;
}

export interface HomeModel {
  /** All live herds for this Slack app, including this daemon. */
  herds: HomeHerd[];
  localHerdId: string;
  /** Which herd the reader drilled into, or ALL_HERDS / null for the overview. */
  selectedHerdId: string | null;
  agents: HomeAgent[];
  herdr: TailStatus;
  slackConnected: boolean;
  /**
   * ms since herdr state was last reconciled for *this* daemon.
   * Refresh bumps this; it is not "time since Home was published".
   */
  herdrSyncedAgoMs: number | null;
  role: "primary" | "satellite";
  allowLaunch?: boolean;
}

type Block = Record<string, unknown>;

const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text },
});

const divider = (): Block => ({ type: "divider" });

const context = (text: string): Block => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

const button = (
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
  url?: string,
): Block => ({
  type: "button",
  text: { type: "plain_text", text, emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
  ...(url ? { url } : {}),
});

// Slack rejects empty button `value` and rejects the entire Home view with it.
//
// Deliberately no `url` here even when a permalink is known: Slack's own
// clients (desktop and mobile, verified 2026-08-18) do not reliably navigate
// a button whose `url` points back at a slack.com permalink — desktop flags
// it with a warning triangle, mobile shows the loading spinner and then does
// nothing. The API itself accepts the payload without complaint, so this is a
// client-side quirk with self-referential Slack links specifically, not a
// validation error. A plain mrkdwn link in the row text (see `agentRow`)
// works reliably everywhere; this button stays action-only, useful mainly to
// create/reattach a thread for an agent that does not have one yet.
const openButton = (agent: HomeAgent): Block | undefined => {
  if (!agent.actionValue) return undefined;
  return button("Open", HOME_ACTIONS.openSession, agent.actionValue);
};

/** Slack rejects `accessory: undefined`, so the key has to be absent entirely. */
const withOpen = (block: Block, agent: HomeAgent): Block => {
  const accessory = openButton(agent);
  return accessory ? { ...block, accessory } : block;
};

export function needsYou(agents: HomeAgent[]): HomeAgent[] {
  return agents
    .filter((agent) => agent.status === "blocked" || agent.status === "done")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "blocked" ? -1 : 1));
}

export function groupByWorkspace(agents: HomeAgent[]): Map<string, HomeAgent[]> {
  const groups = new Map<string, HomeAgent[]>();
  for (const agent of agents) {
    const key = agent.workspaceLabel || agent.workspaceId;
    const bucket = groups.get(key) ?? [];
    bucket.push(agent);
    groups.set(key, bucket);
  }
  return groups;
}

/**
 * Which herd the view is showing.
 *
 * A single herd never shows the overview — there is nothing to choose between,
 * and an extra tap to see your only machine is noise.
 */
export function resolveSelection(model: HomeModel): HomeHerd | null {
  if (model.herds.length === 1) return model.herds[0] ?? null;
  if (!model.selectedHerdId || model.selectedHerdId === ALL_HERDS) return null;
  return model.herds.find((herd) => herd.herdId === model.selectedHerdId) ?? null;
}

function statusWord(herd: HomeHerd): string {
  if (herd.herdrStatus === "connected") return "connected";
  return herd.herdrStatus === "waiting" ? "herdr down" : "connecting";
}

function shortenPath(socketPath: string): string {
  const home = process.env.HOME;
  if (home && socketPath.startsWith(home)) return `~${socketPath.slice(home.length)}`;
  return socketPath;
}

/**
 * The one-line identity of a herd.
 *
 * The pid is here because two machines can both be labelled "work"; without it
 * there is nothing on screen that tells them apart.
 */
function herdDetail(herd: HomeHerd): string {
  const where = herd.isLocal ? "this daemon" : `${herd.user}@${herd.hostname}`;
  const count = `${herd.agentCount} agent${herd.agentCount === 1 ? "" : "s"}`;
  return (
    `pid \`${herd.pid}\` · ${herd.role} · \`${escapeMrkdwn(shortenPath(herd.socketPath))}\` · ` +
    `${statusWord(herd)} · ${count} · ${escapeMrkdwn(where)}`
  );
}

function livenessFooter(model: HomeModel): Block {
  if (!model.slackConnected) return context("⚠️ reconnecting to Slack…");
  if (model.role === "satellite") {
    return context("satellite — Home is published by the primary daemon for this Slack app");
  }
  const ago = model.herdrSyncedAgoMs;
  const text =
    ago === null
      ? "herdr not synced yet — tap Refresh"
      : ago < 2_000
        ? "herdr synced just now"
        : `herdr synced ${Math.round(ago / 1000)}s ago · Refresh re-syncs`;
  return context(text);
}

/** Slack rejects Home views with more than 100 blocks. */
export const MAX_HOME_BLOCKS = 100;
const RESERVED_BLOCKS = 8;

function agentRow(agent: HomeAgent, detailed: boolean): Block {
  // A plain mrkdwn link, not a button `url` — see the note on `openButton`.
  const openLink = agent.permalink ? ` · <${agent.permalink}|Open>` : "";
  const text = detailed
    ? `${GLYPH[agent.status]} *${escapeMrkdwn(agent.agent)}* · ${escapeMrkdwn(agent.title)}${openLink}\n\`${escapeMrkdwn(agent.cwd)}\``
    : `${GLYPH[agent.status]} \`${escapeMrkdwn(agent.agent)}\`  ${escapeMrkdwn(agent.title)}${openLink}`;
  return withOpen({ type: "section", text: { type: "mrkdwn", text } }, agent);
}

/** The overview: every herd, selectable, with what is waiting on each. */
function overviewBlocks(model: HomeModel): Block[] {
  const blocks: Block[] = [];
  for (const herd of model.herds) {
    const waiting = needsYou(model.agents.filter((a) => a.herdId === herd.herdId)).length;
    const attention = waiting > 0 ? `\n🔴 ${waiting} waiting on you` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(herd.label || herd.instance)}*\n${herdDetail(herd)}${attention}`,
      },
      accessory: button("Open", HOME_ACTIONS.selectHerd, herd.herdId),
    });
  }
  return blocks;
}

function attentionBlocks(agents: HomeAgent[], model: HomeModel): Block[] {
  const attention = needsYou(agents);
  if (attention.length === 0) return [];
  const blocks: Block[] = [divider(), section(`*🔴 NEEDS YOU (${attention.length})*`)];
  for (const agent of attention) {
    const row = agentRow(agent, true);
    blocks.push(model.herds.length > 1 && !model.selectedHerdId ? tagHerd(row, agent) : row);
  }
  return blocks;
}

/** Name the herd on a row that is shown outside its own herd's view. */
function tagHerd(row: Block, agent: HomeAgent): Block {
  const text = (row.text as { text?: string } | undefined)?.text ?? "";
  return { ...row, text: { type: "mrkdwn", text: `${text}\n_${escapeMrkdwn(agent.herdLabel)}_` } };
}

function workspaceBlocks(
  agents: HomeAgent[],
  startLength: number,
): { blocks: Block[]; hidden: number } {
  const blocks: Block[] = [];
  let hidden = 0;
  for (const [workspace, group] of groupByWorkspace(agents)) {
    if (startLength + blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
      hidden += group.length;
      continue;
    }
    blocks.push(
      divider(),
      section(`*${workspace}*  ·  ${group.length} agent${group.length === 1 ? "" : "s"}`),
    );
    for (const agent of group) {
      if (startLength + blocks.length + RESERVED_BLOCKS >= MAX_HOME_BLOCKS) {
        hidden += 1;
        continue;
      }
      blocks.push(agentRow(agent, false));
    }
  }
  return { blocks, hidden };
}

export function buildHome(model: HomeModel): Block[] {
  const selected = resolveSelection(model);
  const multi = model.herds.length > 1;
  const agents = selected
    ? model.agents.filter((agent) => agent.herdId === selected.herdId)
    : model.agents;

  // Launching belongs to a herd, not to the overview. Everything the form asks
  // for — workspace, directory, agent kind — is one machine's, so the button
  // lives where a machine is already in view and the answer is not a guess.
  const canLaunch =
    model.allowLaunch !== false && selected !== null && selected.herdrStatus === "connected";

  const title = selected
    ? `🐑 Herd · ${selected.label || selected.instance}`
    : `🐑 Herds · ${model.herds.length}`;

  const controls: Block[] = [button("⟳ Refresh", HOME_ACTIONS.refresh, "refresh")];
  if (canLaunch) {
    controls.push(button("＋ New agent", HOME_ACTIONS.newAgent, "new", "primary"));
  }
  if (selected && multi) {
    controls.push(button("↩ All herds", HOME_ACTIONS.selectHerd, ALL_HERDS));
  }

  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    // The herd's identity belongs directly under its name, not in a second
    // section repeating it.
    ...(selected ? [context(herdDetail(selected))] : []),
    { type: "actions", elements: controls },
  ];

  if (!selected) {
    if (model.herds.length === 0) {
      return [
        ...blocks,
        section("*No herds are reporting in.*"),
        context(
          "Each machine runs its own daemon. Start herdr and the daemon on at least one, and it will appear here.",
        ),
        divider(),
        livenessFooter(model),
      ];
    }
    blocks.push(divider(), ...overviewBlocks(model), ...attentionBlocks(agents, model));
    blocks.push(divider(), livenessFooter(model));
    return blocks;
  }

  if (selected.herdrStatus !== "connected") {
    return [
      ...blocks,
      section("*This machine is not reachable.*"),
      context(
        "Wake it and start herdr (`herdr`). Phone control only works while the computer is awake — sleep freezes its daemon. This fills in on its own once herdr reconnects.",
      ),
      divider(),
      livenessFooter(model),
    ];
  }

  if (agents.length === 0) {
    return [
      ...blocks,
      section("*No agents running.*"),
      context(
        model.allowLaunch === false
          ? "Start CRE manually in Herdr and pin its terminal and native session in creRoots."
          : "Tap *＋ New agent* above, or start one in herdr and it will appear here.",
      ),
      divider(),
      livenessFooter(model),
    ];
  }

  blocks.push(...attentionBlocks(agents, model));
  const { blocks: workspaces, hidden } = workspaceBlocks(agents, blocks.length);
  blocks.push(...workspaces);

  if (hidden > 0) {
    blocks.push(
      context(
        `… and ${hidden} more. Anything blocked is listed above; open the rest from the thread list in *Messages*.`,
      ),
    );
  }

  blocks.push(divider(), livenessFooter(model));
  return blocks;
}

export function agentFromPane(
  pane: PaneInfo,
  ref: string,
  workspaceLabel: string,
  status: AgentStatus,
  permalink?: string,
  herd?: { herdId: string; herdLabel: string; actionValue: string },
): HomeAgent {
  return {
    ref,
    actionValue: herd?.actionValue ?? ref,
    terminalId: pane.terminal_id,
    agent: pane.agent ?? "agent",
    title: pane.terminal_title_stripped ?? pane.title ?? "(untitled)",
    cwd: pane.cwd ?? "",
    status,
    workspaceId: pane.workspace_id,
    workspaceLabel,
    herdId: herd?.herdId ?? "",
    herdLabel: herd?.herdLabel ?? "",
    ...(permalink ? { permalink } : {}),
  };
}
