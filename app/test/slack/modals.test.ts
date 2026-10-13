import { describe, expect, it } from "vitest";
import { SEED_CATALOG, loadCatalog } from "../../src/agents/catalog.js";
import type { WorkspaceInfo, WorktreeInfo } from "../../src/herdr/types.js";
import {
  ACTION_IDS,
  BLOCK_IDS,
  MODAL_IDS,
  OPTION_CAP,
  buildHistoryModal,
  buildNewAgentModal,
  buildReplyModal,
  capOptions,
  parseNewAgentSubmission,
  parseReplySubmission,
  skeletonModal,
} from "../../src/slack/modals.js";
import { workspace } from "../helpers/factories.js";

const worktree = (overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path: "/work/app",
  label: "app",
  branch: "main",
  is_bare: false,
  is_detached: false,
  is_linked_worktree: false,
  is_prunable: false,
  ...overrides,
});

const asTargets = (workspaces: WorkspaceInfo[], worktrees: WorktreeInfo[]) => ({
  workspaces: workspaces.map((w) => ({ id: w.workspace_id, label: w.label || w.workspace_id })),
  worktrees: worktrees.map((tree) => ({
    label: tree.label,
    path: tree.path,
    ...(tree.branch ? { branch: tree.branch } : {}),
  })),
});

const model = (overrides = {}) => ({
  ...asTargets([workspace({ label: "posi" })], [worktree()]),
  kinds: SEED_CATALOG.map((entry) => ({ kind: entry.kind, label: entry.label })),
  ...overrides,
});

const json = (view: Record<string, unknown>): string => JSON.stringify(view);

describe("skeletonModal", () => {
  it("opens immediately so the trigger_id is not wasted on herdr calls", () => {
    // trigger_id expires in ~3s; fetching first would routinely miss it.
    const view = skeletonModal("New agent");
    expect(view.callback_id).toBe(MODAL_IDS.newAgent);
    expect(json(view)).toContain("Loading");
  });
});

describe("session modals", () => {
  it("builds and parses the reply modal with an opaque ref", () => {
    const modal = buildReplyModal("opaque-ref", "Fix auth");
    expect(modal.private_metadata).toBe("opaque-ref");
    expect(
      parseReplySubmission({ values: { b_reply: { a_reply: { value: "  continue " } } } }),
    ).toBe("continue");
    expect(parseReplySubmission({ values: {} })).toBeNull();
  });

  const historyTurns = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: String(index),
      prompt: `prompt ${index}`,
      response: `response ${index}`,
      status: "done" as const,
      createdAt: 1_000 + index,
      completedAt: 2_000 + index,
    }));

  it("excludes the newest response, since it is already on the card", () => {
    const turns = historyTurns(7);
    const view = buildHistoryModal("opaque-ref", turns);
    const rendered = json(view);

    // response 6 is the newest, shown on the card; "Earlier" starts one back.
    expect(rendered).not.toContain("response 6");
    expect(rendered).toContain("response 5");
    expect(rendered).not.toContain("response 4");
    expect(rendered).toContain("*#6* of 6");
    expect(rendered).toContain("latest");
    expect(view.title).toEqual(expect.objectContaining({ text: "Response #6 of 6" }));
    // Nothing newer than the newest earlier one, so only one direction.
    expect(rendered).toContain("Older");
    expect(rendered).not.toContain("Newer");
  });

  it("walks one step back per Older click and offers both directions in the middle", () => {
    const turns = historyTurns(7);
    const rendered = json(buildHistoryModal("opaque-ref", turns, 1));
    expect(rendered).toContain("response 4");
    expect(rendered).not.toContain("response 5");
    expect(rendered).toContain("*#5* of 6");
    expect(rendered).toContain("session_history_page_2");
    expect(rendered).toContain("session_history_page_0");
  });

  it("stops at the oldest response instead of paging past it", () => {
    const rendered = json(buildHistoryModal("opaque-ref", historyTurns(3), 99));
    expect(rendered).toContain("response 0");
    expect(rendered).toContain("*#1* of 2");
    expect(rendered).not.toContain("Older");
  });

  it("says there are none when only the card's response exists", () => {
    // A single recorded response is on the card, so there is nothing earlier.
    const rendered = json(buildHistoryModal("opaque-ref", historyTurns(1)));
    expect(rendered).toContain("No earlier responses yet");
  });

  it("skips turns with no response and says so when there are none", () => {
    const rendered = json(
      buildHistoryModal("opaque-ref", [
        { id: "a", prompt: "waiting", status: "working" as const, createdAt: 1 },
      ]),
    );
    expect(rendered).toContain("No earlier responses yet");
  });

  it("splits a long recorded response across blocks instead of truncating it", () => {
    const long = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const view = buildHistoryModal("opaque-ref", [
      { id: "a", prompt: "go", response: long, status: "done" as const, createdAt: 1 },
      // A newer turn takes the card slot, leaving the long one as "earlier".
      { id: "b", prompt: "next", response: "on the card", status: "done" as const, createdAt: 2 },
    ]);
    const sections = (view.blocks as { type: string }[]).filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(2);
    expect(json(view)).toContain("line 399");
  });
});

describe("buildNewAgentModal", () => {
  it("offers every field the launch needs", () => {
    const rendered = json(buildNewAgentModal(model()));
    // Mode is deliberately absent — Slack always launches in auto. Herd only
    // appears when there is more than one to choose between.
    const shown = Object.entries(BLOCK_IDS).filter(
      ([name]) => name !== "mode" && name !== "reply" && name !== "herd",
    );
    for (const [, id] of shown) {
      expect(rendered).toContain(id);
    }
  });

  it("has no mode picker at all", () => {
    // It rendered empty until an agent was chosen, to set a value that only
    // ever had one sensible answer from a phone.
    const rendered = json(buildNewAgentModal(model({ selectedKind: "claude" })));
    expect(rendered).not.toContain(BLOCK_IDS.mode);
    expect(rendered).not.toContain("Plan mode");
    expect(rendered).not.toContain("Skip permissions");
  });

  it("comes back pre-filled with the last launch", () => {
    // A second agent is nearly always a variation on the first.
    const rendered = json(
      buildNewAgentModal(
        model({ defaults: { workspaceId: "w1", kind: "codex", typedCwd: "/work/app" } }),
      ),
    );
    expect(rendered).toContain("/work/app");
    expect(rendered).toContain("codex");
  });

  it("ignores a remembered directory that is no longer offered", () => {
    // A worktree can disappear between launches; a stale initial_option is
    // rejected by Slack outright.
    const view = buildNewAgentModal(model({ defaults: { cwd: "/gone" } }));
    const directory = (
      view.blocks as { block_id: string; element?: Record<string, unknown> }[]
    ).find((b) => b.block_id === BLOCK_IDS.directory);
    expect(directory?.element?.initial_option).toBeUndefined();
  });

  it("lists workspaces by label", () => {
    expect(json(buildNewAgentModal(model()))).toContain("posi");
  });

  it("offers worktrees as directories, with their branch", () => {
    expect(json(buildNewAgentModal(model()))).toContain("app (main)");
  });

  it("omits the directory picker when there is nothing to pick", () => {
    const view = buildNewAgentModal(model({ worktrees: [] }));
    const ids = (view.blocks as { block_id: string }[]).map((b) => b.block_id);
    expect(ids).not.toContain(BLOCK_IDS.directory);
    // The free-text path must still be there, or there is no way to choose one.
    expect(ids).toContain(BLOCK_IDS.directoryOther);
  });

  it("includes configured favourites alongside worktrees", () => {
    const rendered = json(buildNewAgentModal(model({ favouriteDirs: ["/home/me/scratch"] })));
    expect(rendered).toContain("/home/me/scratch");
  });

  it("makes workspace, label and prompt optional", () => {
    const view = buildNewAgentModal(model());
    const blocks = view.blocks as { block_id: string; optional?: boolean }[];
    const optional = new Map(blocks.map((b) => [b.block_id, b.optional === true]));
    expect(optional.get(BLOCK_IDS.workspace)).toBe(true);
    expect(optional.get(BLOCK_IDS.label)).toBe(true);
    expect(optional.get(BLOCK_IDS.prompt)).toBe(true);
    // Agent and mode are what the launch actually needs.
    expect(optional.get(BLOCK_IDS.kind)).toBe(false);
  });

  it("survives a machine with a hundred workspaces", () => {
    // Slack rejects the whole view past 100 options, so this is correctness,
    // not tidiness.
    const many: WorkspaceInfo[] = Array.from({ length: 250 }, (_, i) =>
      workspace({ workspace_id: `w${i}`, label: `ws ${i}` }),
    );
    const view = buildNewAgentModal(model({ workspaces: asTargets(many, []).workspaces }));
    const block = (view.blocks as Record<string, unknown>[]).find(
      (b) => b.block_id === BLOCK_IDS.workspace,
    );
    const options = (block?.element as { options: unknown[] }).options;
    expect(options.length).toBe(OPTION_CAP);
  });

  it("never emits an empty option label", () => {
    const view = buildNewAgentModal(
      model({
        workspaces: asTargets([workspace({ label: "", workspace_id: "w9" })], []).workspaces,
      }),
    );
    expect(json(view)).not.toContain('"text":""');
  });

  it("carries the target herd without asking which one", () => {
    // ＋ New agent only exists inside a herd's view, so the herd is already
    // decided; a picker would be asking a question with one answer.
    const view = buildNewAgentModal(model({ selectedHerdId: "h2" }));
    const ids = (view.blocks as { block_id: string }[]).map((b) => b.block_id);
    expect(ids).not.toContain("b_herd");
    expect(view.private_metadata).toBe(JSON.stringify({ herdId: "h2" }));
  });

  /**
   * Slack rejects a view containing a select with no options as
   * `invalid_blocks`. The update then fails and the modal is left showing the
   * skeleton's "Loading…" with no way out but closing it — which is what a
   * peer herd that has not reported its workspaces yet used to produce.
   */
  describe("a herd that has reported nothing yet", () => {
    it("omits the workspace picker rather than emitting an empty one", () => {
      const view = buildNewAgentModal(model({ workspaces: [] }));
      const ids = (view.blocks as { block_id: string }[]).map((b) => b.block_id);
      expect(ids).not.toContain(BLOCK_IDS.workspace);
      // A path can still be typed, so the form is not useless.
      expect(ids).toContain(BLOCK_IDS.directoryOther);
    });

    it("says so instead of rendering a form with no agent to start", () => {
      const view = buildNewAgentModal(model({ kinds: [] }));
      const ids = (view.blocks as { block_id: string }[]).map((b) => b.block_id);
      expect(ids).not.toContain(BLOCK_IDS.kind);
      expect(json(view)).toContain("has not reported any agent kinds");
      // Nothing to submit, so no button promising otherwise.
      expect(view.submit).toBeUndefined();
    });

    it("emits no select at all with an empty options list", () => {
      const view = buildNewAgentModal(model({ workspaces: [], worktrees: [] }));
      for (const block of view.blocks as { element?: { options?: unknown[] } }[]) {
        if (block.element?.options) expect(block.element.options.length).toBeGreaterThan(0);
      }
    });
  });

  it("locks the bound workspace, defaults to cre and keeps origin in metadata", () => {
    const view = buildNewAgentModal(
      model({
        selectedHerdId: "h2",
        lockedWorkspaceId: "w1",
        origin: { channel: "C1", threadTs: "root" },
      }),
    );
    const blocks = view.blocks as { block_id?: string }[];
    expect(blocks.some((block) => block.block_id === BLOCK_IDS.workspace)).toBe(false);
    expect(json(view)).toContain("posi");
    expect(json(view)).toContain('"value":"cre"');
    expect(view.private_metadata).toBe(
      JSON.stringify({ herdId: "h2", workspaceId: "w1", channel: "C1", threadTs: "root" }),
    );
  });

  it("uses a bound workspace id when the herd has not reported its label", () => {
    const view = buildNewAgentModal(
      model({ selectedHerdId: "h2", lockedWorkspaceId: "w9", workspaces: [] }),
    );
    expect(json(view)).toContain("Workspace: *w9*");
    expect(json(view)).not.toContain(BLOCK_IDS.workspace);
  });

  it("prefills the directory someone typed last time", () => {
    // The initial value was being dropped on the floor: `inputBlock` accepted
    // the option and never rendered it.
    const view = buildNewAgentModal(model({ defaults: { typedCwd: "/work/app" } }));
    const block = (view.blocks as { block_id: string; element?: Record<string, unknown> }[]).find(
      (b) => b.block_id === BLOCK_IDS.directoryOther,
    );
    expect(block?.element?.initial_value).toBe("/work/app");
  });
});

describe("capOptions", () => {
  it("caps at Slack's limit", () => {
    const options = Array.from({ length: 150 }, (_, i) => ({ label: `l${i}`, value: `v${i}` }));
    expect(capOptions(options)).toHaveLength(OPTION_CAP);
  });

  it("leaves a short list alone", () => {
    expect(capOptions([{ label: "a", value: "b" }])).toHaveLength(1);
  });
});

describe("parseNewAgentSubmission", () => {
  const view = (values: Record<string, unknown>) => ({ values });

  const complete = () => ({
    [BLOCK_IDS.kind]: { [ACTION_IDS.kind]: { selected_option: { value: "claude" } } },
  });

  it("parses JSON herd and origin metadata, and ignores bare strings", () => {
    expect(
      parseNewAgentSubmission(
        view(complete()),
        JSON.stringify({ herdId: "h2", workspaceId: "w1", channel: "C1", threadTs: "root" }),
      ),
    ).toMatchObject({ herdId: "h2", workspaceId: "w1", channel: "C1", threadTs: "root" });
    expect(parseNewAgentSubmission(view(complete()), "h2")).toBeNull();
  });

  it("ignores malformed, empty and array metadata", () => {
    for (const metadata of ["", "{", "[]", "null", '"h2"']) {
      expect(parseNewAgentSubmission(view(complete()), metadata)).toBeNull();
    }
  });

  it("rejects JSON without a valid herd or with invalid origin fields", () => {
    for (const metadata of [
      "{}",
      '{"herdId":42}',
      '{"herdId":""}',
      '{"herdId":"peer","channel":42}',
      '{"herdId":"peer","workspaceId":false}',
    ]) {
      expect(parseNewAgentSubmission(view(complete()), metadata)).toBeNull();
    }
  });

  it("reads the required fields", () => {
    expect(parseNewAgentSubmission(view(complete()), '{"herdId":"local"}')).toMatchObject({
      kind: "claude",
    });
  });

  it("refuses a submission missing the agent", () => {
    expect(parseNewAgentSubmission(view({}))).toBeNull();
  });

  it("prefers a typed path over the picker", () => {
    // Someone who typed a path meant it.
    const result = parseNewAgentSubmission(
      view({
        ...complete(),
        [BLOCK_IDS.directory]: {
          [ACTION_IDS.directory]: { selected_option: { value: "/picked" } },
        },
        [BLOCK_IDS.directoryOther]: { [ACTION_IDS.directoryOther]: { value: "  /typed  " } },
      }),
      '{"herdId":"local"}',
    );
    expect(result?.cwd).toBe("/typed");
  });

  it("uses the picker when nothing was typed", () => {
    const result = parseNewAgentSubmission(
      view({
        ...complete(),
        [BLOCK_IDS.directory]: {
          [ACTION_IDS.directory]: { selected_option: { value: "/picked" } },
        },
        [BLOCK_IDS.directoryOther]: { [ACTION_IDS.directoryOther]: { value: "   " } },
      }),
      '{"herdId":"local"}',
    );
    expect(result?.cwd).toBe("/picked");
  });

  it("omits optional fields rather than sending empty strings", () => {
    const result = parseNewAgentSubmission(
      view({
        ...complete(),
        [BLOCK_IDS.label]: { [ACTION_IDS.label]: { value: "  " } },
        [BLOCK_IDS.prompt]: { [ACTION_IDS.prompt]: { value: "" } },
      }),
      '{"herdId":"local"}',
    );
    expect(result).not.toHaveProperty("label");
    expect(result).not.toHaveProperty("firstPrompt");
  });

  it("trims a first prompt", () => {
    const result = parseNewAgentSubmission(
      view({ ...complete(), [BLOCK_IDS.prompt]: { [ACTION_IDS.prompt]: { value: "  go  " } } }),
      '{"herdId":"local"}',
    );
    expect(result?.firstPrompt).toBe("go");
  });

  it("tolerates a malformed view instead of throwing", () => {
    expect(parseNewAgentSubmission(undefined)).toBeNull();
    expect(parseNewAgentSubmission({ nope: true })).toBeNull();
  });
});
