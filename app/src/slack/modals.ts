import type { SessionTurn } from "../registry/registry.js";
import { escapeMrkdwn } from "./format.js";
import { responseSections } from "./session.js";

type Block = Record<string, unknown>;

export const MODAL_IDS = {
  newAgent: "modal_new_agent",
  picker: "modal_picker",
  reply: "modal_session_reply",
  history: "modal_session_history",
} as const;

export const BLOCK_IDS = {
  workspace: "b_workspace",
  directory: "b_directory",
  directoryOther: "b_directory_other",
  kind: "b_kind",
  mode: "b_mode",
  label: "b_label",
  prompt: "b_prompt",
  reply: "b_reply",
} as const;

export const ACTION_IDS = {
  workspace: "a_workspace",
  directory: "a_directory",
  directoryOther: "a_directory_other",
  kind: "a_kind",
  mode: "a_mode",
  label: "a_label",
  prompt: "a_prompt",
  reply: "a_reply",
} as const;

/** Every action id that is a form input, so inbound handling can ignore them. */
export const MODAL_INPUT_ACTION_IDS: readonly string[] = Object.values(ACTION_IDS);

/** Slack refuses a static_select with more than 100 options. */
export const OPTION_CAP = 100;

/**
 * Slack also refuses one with *no* options, rejecting the whole view as
 * `invalid_blocks`. That is not hypothetical here: a peer herd advertises its
 * workspaces and agent kinds through its heartbeat, and a herd that has not
 * reported any yet would otherwise render an empty select — the view then fails
 * to update and the modal sits on "Loading…" until it is closed.
 */
const hasOptions = (options: Option[]): boolean => options.length > 0;

const text = (value: string, max = 75): { type: "plain_text"; text: string; emoji: true } => ({
  type: "plain_text",
  // Slack rejects empty or over-long option text outright, which surfaces as an
  // opaque "invalid_blocks" rather than anything actionable.
  text: value.trim().slice(0, max) || "—",
  emoji: true,
});

export interface Option {
  label: string;
  value: string;
}

export function option(o: Option): Block {
  return { text: text(o.label), value: o.value.slice(0, 150) };
}

/**
 * Cap an option list, keeping the first N.
 *
 * Slack hard-caps at 100 and rejects the whole view beyond it, so this is not a
 * nicety — an unpaginated list on a busy machine breaks the modal entirely.
 */
export function capOptions(options: Option[]): Option[] {
  return options.slice(0, OPTION_CAP);
}

function selectBlock(
  blockId: string,
  actionId: string,
  label: string,
  options: Option[],
  opts: { optional?: boolean; initial?: string | undefined; placeholder?: string } = {},
): Block {
  const capped = capOptions(options);
  const initial = capped.find((o) => o.value === opts.initial);
  return {
    type: "input",
    block_id: blockId,
    ...(opts.optional ? { optional: true } : {}),
    label: text(label),
    element: {
      type: "static_select",
      action_id: actionId,
      placeholder: text(opts.placeholder ?? "Choose one"),
      options: capped.map(option),
      ...(initial ? { initial_option: option(initial) } : {}),
    },
  };
}

function inputBlock(
  blockId: string,
  actionId: string,
  label: string,
  opts: {
    optional?: boolean;
    multiline?: boolean;
    placeholder?: string;
    initial?: string | undefined;
  } = {},
): Block {
  return {
    type: "input",
    block_id: blockId,
    ...(opts.optional ? { optional: true } : {}),
    label: text(label),
    element: {
      type: "plain_text_input",
      action_id: actionId,
      ...(opts.multiline ? { multiline: true } : {}),
      ...(opts.placeholder ? { placeholder: text(opts.placeholder, 150) } : {}),
      ...(opts.initial ? { initial_value: opts.initial } : {}),
    },
  };
}

/**
 * What the form should come back pre-filled with.
 *
 * Launching a second agent is usually a variation on the last one — same
 * workspace, same directory, same kind — so making someone re-pick all of it
 * every time is pure friction.
 */
export interface NewAgentDefaults {
  workspaceId?: string | undefined;
  cwd?: string | undefined;
  typedCwd?: string | undefined;
  kind?: string | undefined;
}

/**
 * Launch targets, in the shape the form needs.
 *
 * Deliberately not herdr's own types: the options may describe another herd,
 * read from its heartbeat rather than from a socket we can reach.
 */
export interface NewAgentTargets {
  workspaces: { id: string; label: string }[];
  worktrees: { label: string; path: string; branch?: string }[];
  kinds: { kind: string; label: string }[];
}

export interface NewAgentModel extends NewAgentTargets {
  /** Currently selected kind. */
  selectedKind?: string;
  favouriteDirs?: string[];
  defaults?: NewAgentDefaults | undefined;
  /**
   * Which herd this launch is for. Not a choice in the form: ＋ New agent only
   * exists inside a herd's view, so the answer is whichever herd the reader was
   * already looking at. It rides in `private_metadata` to survive the round
   * trip to submission.
   */
  selectedHerdId?: string | undefined;
  lockedWorkspaceId?: string | undefined;
  origin?: { channel: string; threadTs?: string } | undefined;
}

/**
 * The New agent modal, opened from a herd's view on the Home tab.
 *
 * A skeleton is opened first and this replaces it via views.update, because
 * trigger_id expires in about three seconds and fetching workspaces and
 * worktrees from herdr first would routinely blow that window.
 */
export function buildNewAgentModal(model: NewAgentModel): Record<string, unknown> {
  const kinds = model.kinds.map((entry) => ({
    label: entry.label === entry.kind ? entry.kind : `${entry.label} (${entry.kind})`,
    value: entry.kind,
  }));

  const selected =
    model.selectedKind ??
    (model.lockedWorkspaceId ? "cre" : model.defaults?.kind) ??
    model.kinds[0]?.kind ??
    "";

  const directories: Option[] = [
    ...(model.favouriteDirs ?? []).map((dir) => ({ label: dir, value: dir })),
    ...model.worktrees.map((tree) => ({
      label: tree.branch ? `${tree.label} (${tree.branch})` : tree.label,
      value: tree.path,
    })),
  ];

  const blocks: Block[] = [];

  // Nothing to launch into means the form cannot work. Say so rather than
  // rendering a dead one — and rather than an empty select Slack would reject.
  if (kinds.length === 0) {
    blocks.push(note("This herd has not reported any agent kinds yet. Try again in a moment."));
    return { ...shell(model), blocks };
  }

  const workspaces = model.workspaces.map((w) => ({ label: w.label || w.id, value: w.id }));
  if (model.lockedWorkspaceId) {
    const label =
      workspaces.find((w) => w.value === model.lockedWorkspaceId)?.label ?? model.lockedWorkspaceId;
    blocks.push(note(`Workspace: *${escapeMrkdwn(label)}*`));
  } else if (hasOptions(workspaces)) {
    blocks.push(
      selectBlock(BLOCK_IDS.workspace, ACTION_IDS.workspace, "Workspace", workspaces, {
        optional: true,
        placeholder: "New workspace",
        ...(model.defaults?.workspaceId ? { initial: model.defaults.workspaceId } : {}),
      }),
    );
  }

  if (hasOptions(directories)) {
    blocks.push(
      selectBlock(BLOCK_IDS.directory, ACTION_IDS.directory, "Directory", directories, {
        optional: true,
        // Only if it is still on offer; a worktree can disappear between launches.
        ...(model.defaults?.cwd && directories.some((d) => d.value === model.defaults?.cwd)
          ? { initial: model.defaults.cwd }
          : {}),
      }),
    );
  }

  blocks.push(
    inputBlock(BLOCK_IDS.directoryOther, ACTION_IDS.directoryOther, "…or type a path", {
      optional: true,
      placeholder: "/Users/you/project",
      ...(model.defaults?.typedCwd ? { initial: model.defaults.typedCwd } : {}),
    }),
    selectBlock(BLOCK_IDS.kind, ACTION_IDS.kind, "Agent", kinds, { initial: selected }),
    inputBlock(BLOCK_IDS.label, ACTION_IDS.label, "Tab label", {
      optional: true,
      placeholder: "what this agent is for",
    }),
    inputBlock(BLOCK_IDS.prompt, ACTION_IDS.prompt, "First prompt", {
      optional: true,
      multiline: true,
      placeholder: "What should it start on?",
    }),
  );

  return { ...shell(model), submit: text("Start"), blocks };
}

const note = (message: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: message },
});

function shell(model: NewAgentModel): Block {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    // Carries the target herd even when there is no picker to read it back from.
    private_metadata: JSON.stringify({
      herdId: model.selectedHerdId ?? "",
      ...(model.lockedWorkspaceId ? { workspaceId: model.lockedWorkspaceId } : {}),
      ...(model.origin
        ? {
            channel: model.origin.channel,
            ...(model.origin.threadTs ? { threadTs: model.origin.threadTs } : {}),
          }
        : {}),
    }),
    title: text("New agent"),
    close: text("Cancel"),
  };
}

/** A modal that only has something to say — used when a form cannot be built. */
export function messageModal(title: string, message: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    title: text(title),
    close: text("Close"),
    blocks: [note(message)],
  };
}

/** Opened immediately so the trigger_id is spent before any herdr call. */
export function skeletonModal(title: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    title: text(title),
    close: text("Cancel"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Loading…_" } }],
  };
}

export function buildReplyModal(ref: string, title: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.reply,
    private_metadata: ref,
    title: text("Reply to agent"),
    submit: text("Send"),
    close: text("Cancel"),
    blocks: [
      inputBlock(BLOCK_IDS.reply, ACTION_IDS.reply, title.slice(0, 75), {
        multiline: true,
        placeholder: "Ask for a change or give the next instruction",
      }),
    ],
  };
}

export function parseReplySubmission(view: unknown): string | null {
  const values = (view as ViewState)?.values ?? {};
  const value = values[BLOCK_IDS.reply]?.[ACTION_IDS.reply]?.value?.trim();
  return value || null;
}

const HISTORY_PAGE_ACTION = "session_history_page";

const pageButton = (label: string, ref: string, page: number): Block => ({
  type: "button",
  text: text(label),
  action_id: `${HISTORY_PAGE_ACTION}_${page}`,
  value: ref,
});

/** Slack renders this in the reader's own timezone; the fallback is for exports. */
function whenLine(turn: SessionTurn): string {
  const at = turn.completedAt ?? turn.createdAt;
  const seconds = Math.floor(at / 1_000);
  return `<!date^${seconds}^{date_short_pretty} at {time}|${new Date(at).toISOString()}>`;
}

/**
 * One response per view, newest first.
 *
 * The newest recorded response is the one on the session card, so this list
 * starts one back — "Earlier" means earlier than what you are already looking
 * at, not a duplicate of it. `page` indexes the list, so page 0 is the newest
 * *earlier* response and *Older* walks back through time. Showing turns one at a
 * time is the whole point of this modal: stacked side by side they read as one
 * wall of terminal text, which is what the session card already avoids.
 */
export function buildHistoryModal(
  ref: string,
  turns: SessionTurn[],
  page = 0,
): Record<string, unknown> {
  const newestFirst = turns
    .filter((turn) => turn.response)
    .reverse()
    .slice(1);
  const total = newestFirst.length;
  if (total === 0) {
    return {
      type: "modal",
      callback_id: MODAL_IDS.history,
      private_metadata: ref,
      title: text("Earlier responses"),
      close: text("Close"),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "_No earlier responses yet._" } }],
    };
  }

  const index = Math.min(Math.max(0, page), total - 1);
  const turn = newestFirst[index] as SessionTurn;
  const number = total - index;

  const blocks: Block[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*#${number}* of ${total}${index === 0 ? " · latest" : ""} · ${whenLine(turn)}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*You asked*\n${escapeMrkdwn(turn.prompt).slice(0, 1_200)}` },
    },
    ...responseSections(turn.response ?? ""),
  ];

  const controls: Block[] = [];
  if (index < total - 1) controls.push(pageButton("← Older", ref, index + 1));
  if (index > 0) controls.push(pageButton("Newer →", ref, index - 1));
  if (controls.length > 0)
    blocks.push({ type: "divider" }, { type: "actions", elements: controls });

  return {
    type: "modal",
    callback_id: MODAL_IDS.history,
    private_metadata: ref,
    title: text(`Response #${number} of ${total}`),
    close: text("Close"),
    blocks,
  };
}

export interface NewAgentSubmission {
  workspaceId?: string;
  cwd?: string;
  kind: string;
  label?: string;
  firstPrompt?: string;
  /** A launch must name its herd in modal metadata. */
  herdId: string;
  channel?: string;
  threadTs?: string;
}

type ViewState = {
  values?: Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>>;
};

/**
 * Read a submitted view. Returns null when required fields are missing.
 *
 * `privateMetadata` is the target herd. The form never asks for one — ＋ New
 * agent only exists inside a herd's view — so this is the only place it is
 * recorded.
 */
export function parseNewAgentSubmission(
  view: unknown,
  privateMetadata = "",
): NewAgentSubmission | null {
  const values = (view as ViewState)?.values ?? {};
  const pick = (block: string, action: string): string | undefined => {
    const field = values[block]?.[action];
    return field?.selected_option?.value ?? field?.value ?? undefined;
  };

  const kind = pick(BLOCK_IDS.kind, ACTION_IDS.kind);
  if (!kind) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(privateMetadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const metadata = parsed as Record<string, unknown>;
  const field = (key: string): string | undefined =>
    typeof metadata[key] === "string" && metadata[key] ? (metadata[key] as string) : undefined;
  const herdId = field("herdId");
  if (
    !herdId ||
    ["workspaceId", "channel", "threadTs"].some((key) => metadata[key] !== undefined && !field(key))
  )
    return null;
  const channel = field("channel");
  const threadTs = field("threadTs");

  // A typed path wins over the picker: someone who typed one meant it.
  const typed = pick(BLOCK_IDS.directoryOther, ACTION_IDS.directoryOther)?.trim();
  const picked = pick(BLOCK_IDS.directory, ACTION_IDS.directory);
  const cwd = typed || picked;

  const workspaceId = pick(BLOCK_IDS.workspace, ACTION_IDS.workspace);
  const label = pick(BLOCK_IDS.label, ACTION_IDS.label)?.trim();
  const firstPrompt = pick(BLOCK_IDS.prompt, ACTION_IDS.prompt)?.trim();

  // Fields are omitted rather than set to empty strings, so callers can rely on
  // presence meaning "the user chose something".
  return {
    kind,
    ...((field("workspaceId") ?? workspaceId)
      ? { workspaceId: (field("workspaceId") ?? workspaceId) as string }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(label ? { label } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    herdId,
    ...(channel ? { channel } : {}),
    ...(channel && threadTs ? { threadTs } : {}),
  };
}
