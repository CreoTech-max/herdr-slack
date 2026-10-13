import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry, registryPath, sweepOrphans } from "../../src/registry/registry.js";

const fields = (overrides = {}) => ({
  lastKnownPaneId: "w1:p1",
  agentKind: "claude",
  title: "a task",
  cwd: "/w",
  workspaceId: "w1",
  tabId: "w1:t1",
  lastStatus: "working" as const,
  ...overrides,
});

describe("SessionRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-reg-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("mints a ref on first sight and keeps it stable", () => {
    const registry = new SessionRegistry("default");
    const first = registry.upsert("term_1", fields());
    const second = registry.upsert("term_1", fields({ title: "renamed" }));

    expect(second.ref).toBe(first.ref);
    expect(second.title).toBe("renamed");
  });

  it("does not clear ended when upserting a live agent again", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    registry.markEnded("term_1");
    registry.upsert("term_1", fields({ title: "renamed" }));
    expect(registry.get("term_1")?.ended).toBe(true);
  });

  it("mints distinct refs per terminal", () => {
    const registry = new SessionRegistry("default");
    const a = registry.upsert("term_a", fields());
    const b = registry.upsert("term_b", fields());
    expect(a.ref).not.toBe(b.ref);
  });

  it("resolves a ref back to its terminal", () => {
    const registry = new SessionRegistry("default");
    const record = registry.upsert("term_1", fields());
    expect(registry.terminalForRef(record.ref)).toBe("term_1");
  });

  it("does not resolve a ref it never minted", () => {
    const registry = new SessionRegistry("default");
    expect(registry.terminalForRef("forged")).toBeUndefined();
  });

  it("survives a restart with refs intact", () => {
    // Without persisted refs, every live button in every thread would fail
    // closed after a restart — which reads as the bot silently breaking.
    const registry = new SessionRegistry("default");
    const record = registry.upsert("term_1", fields());
    registry.setThread("term_1", "D1", "111.222");
    registry.save();

    const reloaded = new SessionRegistry("default");
    reloaded.load();
    expect(reloaded.terminalForRef(record.ref)).toBe("term_1");
    expect(reloaded.get("term_1")?.slackThreadTs).toBe("111.222");
  });

  it("persists the latest twenty remote turns", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    for (let index = 0; index < 22; index += 1) {
      const turn = registry.startTurn("term_1", `prompt ${index}`, "");
      if (turn) registry.updateTurn("term_1", turn.id, { status: "done" });
    }
    registry.save();

    const reloaded = new SessionRegistry("default");
    reloaded.load();
    expect(reloaded.turns("term_1")).toHaveLength(20);
    expect(reloaded.turns("term_1")[0]?.prompt).toBe("prompt 2");
  });

  it("does not revive a session explicitly ended by the user", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    registry.markEnded("term_1", Date.now(), true);
    registry.revive("term_1");
    expect(registry.get("term_1")?.ended).toBe(true);
  });

  it("treats a corrupt registry as empty rather than crashing the daemon", () => {
    mkdirSync(path.dirname(registryPath("default")), { recursive: true });
    writeFileSync(registryPath("default"), "{ not json", { mode: 0o600 });
    const registry = new SessionRegistry("default");
    expect(() => registry.load()).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it("ignores a thread update for an unknown terminal", () => {
    const registry = new SessionRegistry("default");
    expect(() => registry.setThread("ghost", "D1", "1")).not.toThrow();
  });

  it("keeps a turn's origin through start, steer and settle", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    const turn = registry.startTurn("term_1", "hi", "", { channel: "C1" });
    expect(turn?.origin).toEqual({ channel: "C1" });

    registry.updateTurn("term_1", turn?.id ?? "", { origin: { channel: "C2", threadTs: "9.1" } });
    registry.updateTurn("term_1", turn?.id ?? "", {
      status: "done",
      response: "all done here",
      completedAt: 5,
    });

    expect(registry.turns("term_1")[0]?.origin).toEqual({ channel: "C2", threadTs: "9.1" });
  });

  it("resolves a reply post back to its terminal and survives a restart", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    registry.addReplyPost("term_1", "C1", "1.1");
    registry.addReplyPost("term_1", "C1", "1.1");
    registry.save();

    const reloaded = new SessionRegistry("default");
    reloaded.load();
    expect(reloaded.terminalForReplyPost("C1", "1.1")).toBe("term_1");
    expect(reloaded.get("term_1")?.replyPosts).toEqual([{ channel: "C1", ts: "1.1" }]);
  });

  it("does not resolve a reply post it never recorded", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    registry.addReplyPost("term_1", "C1", "1.1");
    registry.addReplyPost("ghost", "C1", "2.2");
    expect(registry.terminalForReplyPost("C1", "2.2")).toBeUndefined();
    expect(registry.terminalForReplyPost("C2", "1.1")).toBeUndefined();
  });

  it("keeps only the latest twenty reply posts", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    for (let index = 0; index < 22; index += 1) registry.addReplyPost("term_1", "C1", `${index}`);
    const posts = registry.get("term_1")?.replyPosts ?? [];
    expect(posts).toHaveLength(20);
    expect(posts[0]?.ts).toBe("2");
    expect(registry.terminalForReplyPost("C1", "0")).toBeUndefined();
  });
});

describe("sweepOrphans", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-sweep-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  it("ends terminals that no longer exist", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("gone", fields());
    registry.upsert("alive", fields());

    const result = sweepOrphans(registry, new Set(["alive"]), 2);

    expect(result.orphaned.map((r) => r.title)).toEqual(["a task"]);
    expect(registry.get("gone")?.ended).toBe(true);
    expect(registry.get("alive")?.ended).toBe(false);
  });

  it("reports each orphan exactly once, however often it runs", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("gone", fields());

    expect(sweepOrphans(registry, new Set(), 1).orphaned).toHaveLength(1);
    expect(sweepOrphans(registry, new Set(), 1).orphaned).toHaveLength(0);
    expect(sweepOrphans(registry, new Set(), 1).orphaned).toHaveLength(0);
  });

  it("skips entirely when the snapshot has no workspaces", () => {
    // Cannot distinguish "gone" from "herdr caught mid-restore", and `ended` is
    // persisted, so a wrong firing is unrecoverable. Sweeping late is harmless.
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());

    const result = sweepOrphans(registry, new Set(), 0);

    expect(result.skipped).toBe(true);
    expect(result.orphaned).toEqual([]);
    expect(registry.get("term_1")?.ended).toBe(false);
  });

  it("revives a terminal that comes back", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("term_1", fields());
    sweepOrphans(registry, new Set(), 1);
    expect(registry.get("term_1")?.ended).toBe(true);

    sweepOrphans(registry, new Set(["term_1"]), 1);
    expect(registry.get("term_1")?.ended).toBe(false);
    expect(registry.get("term_1")?.endedNotifiedAt).toBeNull();
  });

  it("survives a restart without re-announcing old orphans", () => {
    const registry = new SessionRegistry("default");
    registry.upsert("gone", fields());
    sweepOrphans(registry, new Set(), 1);
    registry.save();

    const reloaded = new SessionRegistry("default");
    reloaded.load();
    expect(sweepOrphans(reloaded, new Set(), 1).orphaned).toEqual([]);
  });
});
