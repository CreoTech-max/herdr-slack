import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient, defaultSocketPath, sessionSocketPath } from "../../src/herdr/client.js";
import { HerdrError } from "../../src/herdr/types.js";
import { pane, tab, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";

describe("HerdrClient collection helpers", () => {
  let fake: FakeHerdr;
  let client: HerdrClient;

  beforeEach(async () => {
    fake = await FakeHerdr.start();
    client = new HerdrClient(fake.socketPath, 1_000);
  });

  afterEach(async () => {
    await fake.stop();
  });

  it("lists workspaces", async () => {
    fake.on("workspace.list", () => ({ workspaces: [workspace()] }));
    await expect(client.workspaceList()).resolves.toHaveLength(1);
  });

  it("scopes a tab list to a workspace when given one", async () => {
    fake.on("tab.list", () => ({ tabs: [tab()] }));
    await client.tabList("w2");
    expect(fake.requests.at(-1)?.params).toEqual({ workspace_id: "w2" });
  });

  it("lists every tab when no workspace is given", async () => {
    fake.on("tab.list", () => ({ tabs: [] }));
    await client.tabList();
    expect(fake.requests.at(-1)?.params).toEqual({});
  });

  it("lists worktrees", async () => {
    fake.on("worktree.list", () => ({ worktrees: [] }));
    await expect(client.worktreeList()).resolves.toEqual([]);
    expect(fake.requests.at(-1)?.params).toEqual({});
    await expect(client.worktreeList("w2")).resolves.toEqual([]);
    expect(fake.requests.at(-1)?.params).toEqual({ workspace_id: "w2" });
  });

  it("passes a line limit through when asked", async () => {
    fake.on("pane.read", () => ({ read: { text: "" } }));
    await client.read("w1:p1", "recent_unwrapped", 120);
    expect(fake.requests.at(-1)?.params).toMatchObject({ lines: 120 });
  });

  it("omits the wait option when not requested", async () => {
    fake.on("agent.prompt", () => ({}));
    await client.prompt("w1:p1", "hi");
    expect(fake.requests.at(-1)?.params).toEqual({ target: "w1:p1", text: "hi" });
  });

  it("returns a pane when herdr answers normally", async () => {
    const expected = pane({ terminal_id: "term_get" });
    fake.on("pane.get", () => ({ pane: expected }));
    await expect(client.paneGet("w1:p1")).resolves.toMatchObject({ terminal_id: "term_get" });
  });

  it("rejects an unparsable response rather than resolving with garbage", async () => {
    // A response that is valid ndjson framing but not valid JSON.
    fake.on("pane.get", () => ({ ok: true }));
    const broken = new HerdrClient(fake.socketPath, 500);
    fake.emitRaw("");
    await expect(broken.paneGet("w1:p1")).resolves.toBeUndefined();
  });

  it("surfaces an unknown method as a typed error", async () => {
    const error = await client.request("nope.does_not_exist").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("unknown_method");
  });
});

describe("socket path helpers", () => {
  it("points named sessions at their own socket", () => {
    expect(sessionSocketPath("work")).toContain("/sessions/work/herdr.sock");
  });

  it("uses the unnamed session socket by default", () => {
    expect(defaultSocketPath()).toMatch(/\.config\/herdr\/herdr\.sock$/);
  });
});
