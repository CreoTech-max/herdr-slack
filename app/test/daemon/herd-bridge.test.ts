import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InstanceConfig, defaultInstance } from "../../src/config/config.js";
import { RateBudget } from "../../src/daemon/budget.js";
import { HerdBridge } from "../../src/daemon/herd-bridge.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { EventTail } from "../../src/herdr/events.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry, registryPath } from "../../src/registry/registry.js";
import { SessionController } from "../../src/slack/session-controller.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("signed satellite commands and heartbeat", () => {
  let dir: string;
  let fake: FakeHerdr;
  let fakeStopped: boolean;
  let tail: EventTail;
  let state: SessionState;
  let registry: SessionRegistry;
  let bridge: HerdBridge;
  let surfaces: Surfaces;
  let transport: FakeTransport;
  let config: InstanceConfig;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "bridge-channel-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    fake = await FakeHerdr.start();
    fakeStopped = false;
    fake.on("pane.read", () => ({ read: { text: "prior" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    fake.on("agent.send_keys", () => ({ ok: true }));
    fake.on("agent.rename", () => ({ ok: true }));
    const client = new HerdrClient(fake.socketPath, 500);
    state = new SessionState();
    state.markPrimed();
    tail = new EventTail(client, state);
    tail.start();
    await wait(40);
    registry = new SessionRegistry("default");
    state.applySnapshot({
      workspaces: [workspace()],
      panes: [pane({ terminal_id: "term_1", pane_id: "w1:p1", agent: "claude" })],
      agents: [
        { terminal_id: "term_1", pane_id: "w1:p1", agent: "claude", name: "build", status: "idle" },
      ],
    });
    const record = registry.upsert("term_1", {
      lastKnownPaneId: "w1:p1",
      agentKind: "claude",
      title: "build",
      cwd: "/app",
      workspaceId: "w1",
      tabId: "w1:t1",
      lastStatus: "idle",
    });
    registry.addReplyPost("term_1", "C1", "reply-root");
    config = defaultInstance({
      slack: {
        botToken: "xoxb-EXAMPLE",
        appToken: "xapp-EXAMPLE",
        appId: "A1",
        teamId: "T1",
        botUserId: "UBOT",
      },
      allowedUsers: ["U1"],
    });
    bridge = new HerdBridge({
      config,
      instance: "default",
      state,
      tail,
      registry,
      client,
      registryDir: path.join(dir, "shared"),
      herdId: "satellite",
      log: () => undefined,
    });
    await bridge.registry.claimOwnership({ appId: "A1", herdId: "primary", pid: process.pid });
    expect(await bridge.elect()).toBe("satellite");
    transport = new FakeTransport();
    surfaces = new Surfaces({
      config,
      instance: "default",
      state,
      tail,
      registry,
      client,
      transport,
      budget: new RateBudget({ totalPerMin: 500 }),
      herd: bridge,
      log: () => undefined,
    });
    surfaces.start();
    bridge.start();
    await vi.waitFor(() => expect(bridge.registry.listHeartbeats("A1")).toHaveLength(1));
    expect(record.ref).toBeTruthy();
  });

  afterEach(async () => {
    bridge.stop();
    surfaces.stop();
    tail.stop();
    state.dispose();
    if (!fakeStopped) await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  });

  it("advertises signed worktrees by workspace despite another focused workspace", async () => {
    state.applySnapshot({
      workspaces: [workspace(), workspace({ workspace_id: "w2" })],
      panes: [],
      agents: [],
    });
    fake.on("worktree.list", (params) => ({
      worktrees:
        params.workspace_id === "w1"
          ? [{ label: "bound", path: "/bound" }]
          : [{ label: "other", path: "/other" }],
    }));
    bridge.stop();
    bridge.start();
    await vi.waitFor(() =>
      expect(bridge.registry.listHeartbeats("A1")[0]?.launch?.worktreesByWorkspace).toEqual({
        w1: [{ label: "bound", path: "/bound" }],
        w2: [{ label: "other", path: "/other" }],
      }),
    );
    expect(
      fake.requests
        .filter((row) => row.method === "worktree.list")
        .map((row) => row.params)
        .slice(-2),
    ).toEqual([{ workspace_id: "w1" }, { workspace_id: "w2" }]);
  });

  const send = async (
    op: "prompt" | "stop" | "clear",
    extra: {
      text?: string;
      threadTs?: string;
      channel?: string;
      expectedWorkspaceId?: string;
    } = {},
  ) => {
    const ref = registry.get("term_1")?.ref ?? "";
    const commandId = bridge.forwardCommand({
      op,
      herdId: "satellite",
      ref,
      channel: "C1",
      userId: "U1",
      ...extra,
    });
    let result = bridge.registry.takeResult(commandId);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(commandId);
        expect(result).not.toBeNull();
      },
      { timeout: 2500 },
    );
    expect(result?.ok).toBe(true);
  };

  it("posts the satellite's own structured Pi reply after a signed prompt", async () => {
    const sessionDir = path.join(dir, "sessions");
    mkdirSync(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: "/app",
    };
    const entry = (
      entryId: string,
      parentId: string | null,
      role: string,
      content: unknown,
      stopReason?: string,
    ) => ({
      type: "message",
      id: entryId,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role, content, ...(stopReason ? { stopReason } : {}), timestamp: Date.now() },
    });
    const old = [
      header,
      entry("u1", null, "user", "old"),
      entry("a1", "u1", "assistant", [{ type: "text", text: "Old answer not for Slack" }], "stop"),
    ];
    writeFileSync(file, `${old.map((item) => JSON.stringify(item)).join("\n")}\n`);
    const live = pane({
      terminal_id: "term_1",
      pane_id: "w1:p1",
      agent: "pi",
      agent_status: "idle",
      agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
    });
    state.markUnprimed();
    state.applySnapshot({ workspaces: [workspace()], panes: [live], agents: [] });
    state.markPrimed();
    surfaces.reconcileSessions();
    await send("prompt", { text: "Give two paragraphs" });
    expect(registry.activeTurn("term_1")?.piBoundary?.entryId).toBe("a1");
    writeFileSync(
      file,
      `${[...old, entry("u2", "a1", "user", "Give two paragraphs"), entry("a2", "u2", "assistant", [{ type: "text", text: "First paragraph.\n\nSecond paragraph." }], "stop")].map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    const controller = new SessionController({
      config,
      client: new HerdrClient(fake.socketPath, 500),
      state,
      registry,
      transport,
      log: () => undefined,
    });
    await controller.refreshResponse("term_1", "done");
    expect(registry.turns("term_1")[0]?.response).toBe("First paragraph.\n\nSecond paragraph.");
    expect(transport.posted[0]?.channel).toBe("C1");
    expect(JSON.stringify(transport.posted)).not.toContain("Old answer");
  });

  it("advertises names, workspace and reply roots in a verified heartbeat", () => {
    const row = bridge.registry.listHeartbeats("A1")[0]?.agents[0];
    expect(row).toMatchObject({
      name: "build",
      workspaceId: "w1",
      replyPosts: [{ channel: "C1", ts: "reply-root" }],
    });
  });

  it("preserves the most recent prompt origin while the agent is busy", async () => {
    await send("prompt", { text: "first", threadTs: "root-one" });
    const turn = registry.activeTurn("term_1");
    expect(turn?.origin).toEqual({ channel: "C1", threadTs: "root-one" });
    await send("prompt", { text: "second", channel: "D1", threadTs: "root-two" });
    expect(registry.activeTurn("term_1")?.id).toBe(turn?.id);
    expect(registry.activeTurn("term_1")?.origin).toEqual({ channel: "D1", threadTs: "root-two" });
  });

  it.each(["prompt", "stop", "clear"] as const)(
    "refuses a moved %s target before terminal I/O",
    async (op) => {
      state.apply({
        type: "pane_moved",
        pane: pane({
          terminal_id: "term_1",
          pane_id: "w2:p2",
          workspace_id: "w2",
          agent: "claude",
        }),
        previous_pane_id: "w1:p1",
      });
      const ref = registry.get("term_1")?.ref ?? "";
      const id = bridge.forwardCommand({
        op,
        herdId: "satellite",
        ref,
        channel: "C1",
        expectedWorkspaceId: "w1",
        userId: "U1",
        ...(op === "prompt" ? { text: "no" } : {}),
      });
      let result = bridge.registry.takeResult(id);
      await vi.waitFor(
        () => {
          result ??= bridge.registry.takeResult(id);
          expect(result).not.toBeNull();
        },
        { timeout: 2500 },
      );
      expect(result?.ok).toBe(false);
      expect(
        fake.requests.filter((r) =>
          ["agent.prompt", "agent.send_keys", "agent.rename", "pane.read"].includes(r.method),
        ),
      ).toHaveLength(0);
    },
  );

  it("refuses a clear rename if the terminal leaves the bound workspace during /new", async () => {
    fake.on("agent.prompt", () => {
      state.apply({
        type: "pane_moved",
        pane: pane({
          terminal_id: "term_1",
          pane_id: "w2:p2",
          workspace_id: "w2",
          agent: "claude",
        }),
        previous_pane_id: "w1:p1",
      });
      return { ok: true };
    });
    const ref = registry.get("term_1")?.ref ?? "";
    const id = bridge.forwardCommand({
      op: "clear",
      herdId: "satellite",
      ref,
      expectedWorkspaceId: "w1",
      channel: "C1",
      userId: "U1",
    });
    let result = bridge.registry.takeResult(id);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(id);
        expect(result).not.toBeNull();
      },
      { timeout: 2500 },
    );
    expect(result?.ok).toBe(false);
    expect(fake.requests.filter((r) => r.method === "agent.rename")).toHaveLength(0);
  });

  it("preserves manual-card prompts without a bound-workspace constraint", async () => {
    state.apply({
      type: "pane_moved",
      pane: pane({ terminal_id: "term_1", pane_id: "w2:p2", workspace_id: "w2", agent: "claude" }),
      previous_pane_id: "w1:p1",
    });
    await send("prompt", { text: "manual card" });
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      target: "w2:p2",
    });
  });

  it.each(["stop", "clear"] as const)(
    "refuses a foreign %s for an unverified CRE root",
    async (op) => {
      config.creOnly = true;
      config.creRoots = [];
      const ref = registry.get("term_1")?.ref ?? "";
      const id = bridge.forwardCommand({
        op,
        herdId: "satellite",
        ref,
        expectedWorkspaceId: "w1",
        channel: "C1",
        userId: "U1",
      });
      let result = bridge.registry.takeResult(id);
      await vi.waitFor(
        () => {
          result ??= bridge.registry.takeResult(id);
          expect(result).not.toBeNull();
        },
        { timeout: 2500 },
      );
      expect(result?.ok).toBe(false);
      expect(
        fake.requests.filter((r) =>
          ["agent.prompt", "agent.send_keys", "agent.rename"].includes(r.method),
        ),
      ).toHaveLength(0);
    },
  );

  it("refuses offline targets and never sends a prompt", async () => {
    await fake.stop();
    fakeStopped = true;
    await vi.waitFor(() => expect(tail.status).toBe("waiting"));
    const ref = registry.get("term_1")?.ref ?? "";
    const id = bridge.forwardCommand({
      op: "prompt",
      herdId: "satellite",
      ref,
      channel: "C1",
      userId: "U1",
      text: "no",
    });
    let result = bridge.registry.takeResult(id);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(id);
        expect(result).not.toBeNull();
      },
      { timeout: 2500 },
    );
    expect(result?.ok).toBe(false);
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(0);
  });

  it("does not prompt an ended satellite session", async () => {
    registry.markEnded("term_1");
    const ref = registry.get("term_1")?.ref ?? "";
    const id = bridge.forwardCommand({
      op: "prompt",
      herdId: "satellite",
      ref,
      channel: "C1",
      userId: "U1",
      text: "must not reach",
    });
    let result = bridge.registry.takeResult(id);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(id);
        expect(result).not.toBeNull();
      },
      { timeout: 2500 },
    );
    expect(result?.ok).toBe(false);
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(0);
  });

  it("uses esc for stop and /new then restores the name for clear", async () => {
    await send("stop");
    await send("clear");
    expect(fake.requests.find((r) => r.method === "agent.send_keys")?.params).toMatchObject({
      keys: ["esc"],
    });
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      text: "/new",
    });
    expect(fake.requests.find((r) => r.method === "agent.rename")?.params).toMatchObject({
      name: "build",
    });
    expect(registry.turns("term_1")).toHaveLength(0);
  });

  it.each([
    ...["pi", "cre"].flatMap(
      (kind) =>
        [
          [kind, false],
          [kind, true],
        ] as const,
    ),
  ])("verifies a pending %s satellite launch with moved=%s", async (kind, moved) => {
    const sessionDir = path.join(dir, "sessions");
    mkdirSync(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const file = path.join(sessionDir, `2026-10-13T00-00-00_${sessionId}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/app" })}\n`,
    );
    fake.on("tab.create", () => ({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }));
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("pane.send_text", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "pi" } }));
    let launchWorkspace = "w1";
    fake.on("session.snapshot", () => ({
      snapshot: {
        version: "1",
        protocol: 1,
        workspaces: [workspace(), workspace({ workspace_id: "w2" })],
        tabs: [],
        panes: [
          pane({
            terminal_id: "term-new",
            pane_id: "w1:p9",
            workspace_id: launchWorkspace,
            agent: "pi",
            agent_status: "idle",
            agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
          }),
        ],
        agents: [],
      },
    }));
    let persistedAtPrompt: unknown;
    fake.on("agent.prompt", () => {
      const registryFile = registryPath("default");
      const saved = existsSync(registryFile)
        ? (JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, { turns?: unknown[] }>)
        : {};
      persistedAtPrompt = saved["term-new"]?.turns?.[0];
      if (moved) launchWorkspace = "w2";
      writeFileSync(
        file,
        `${[
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: "/app",
          },
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "EXAMPLE prompt", timestamp: Date.now() },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              stopReason: "stop",
              timestamp: Date.now(),
              content: [{ type: "text", text: "Completed the satellite reply successfully." }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
      return { ok: true };
    });
    const id = bridge.forwardCommand({
      op: "launch_agent",
      herdId: "satellite",
      ref: "",
      channel: "C1",
      threadTs: "root",
      userId: "U1",
      launch: { kind, workspaceId: "w1", firstPrompt: "EXAMPLE prompt" },
    });
    let result = bridge.registry.takeResult(id);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(id);
        expect(result).not.toBeNull();
      },
      { timeout: 4000 },
    );
    expect(persistedAtPrompt).toMatchObject({
      deliveryPending: true,
      origin: { channel: "C1", threadTs: "root" },
      expectedWorkspaceId: "w1",
      piBoundary: { entryId: null },
    });
    expect(result?.ok).toBe(!moved);
    if (moved) {
      expect(registry.activeTurn("term-new")?.deliveryPending).toBe(true);
      expect(transport.posted).toHaveLength(0);
    } else {
      expect(registry.turns("term-new")[0]?.status).toBe("done");
      expect(transport.posted).toHaveLength(1);
      expect(transport.posted[0]?.channel).toBe("C1");
    }
  });

  it.each(["pi", "cre"])(
    "refuses an unverified %s satellite launch before prompt I/O",
    async (kind) => {
      fake.on("tab.create", () => ({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }));
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("agent.start", () => ({ ok: true }));
      fake.on("pane.send_text", () => ({ ok: true }));
      fake.on("agent.get", () => ({ agent: { agent: "pi" } }));
      fake.on("session.snapshot", () => ({
        snapshot: {
          version: "1",
          protocol: 1,
          workspaces: [workspace()],
          tabs: [],
          panes: [
            pane({
              terminal_id: "term-new",
              pane_id: "w1:p9",
              agent: "pi",
              agent_status: "idle",
              agent_session: {
                agent: "pi",
                kind: "path",
                source: "herdr:pi",
                value: "/outside/2026-10-13T00-00-00_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
              },
            }),
          ],
          agents: [],
        },
      }));
      const id = bridge.forwardCommand({
        op: "launch_agent",
        herdId: "satellite",
        ref: "",
        channel: "C1",
        userId: "U1",
        launch: { kind, workspaceId: "w1", firstPrompt: "EXAMPLE first prompt" },
      });
      let result = bridge.registry.takeResult(id);
      await vi.waitFor(
        () => {
          result ??= bridge.registry.takeResult(id);
          expect(result).not.toBeNull();
        },
        { timeout: 4000 },
      );
      expect(result?.ok).toBe(false);
      expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(0);
      expect(registry.activeTurn("term-new")).toBeUndefined();
    },
  );

  it("keeps the origin thread on a forwarded launch with a first prompt", async () => {
    fake.on("tab.create", () => ({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }));
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    fake.on("session.snapshot", () => ({
      snapshot: {
        version: "1",
        protocol: 1,
        workspaces: [workspace()],
        tabs: [],
        panes: [pane({ terminal_id: "term-new", pane_id: "w1:p9", agent: "claude" })],
        agents: [],
      },
    }));
    const id = bridge.forwardCommand({
      op: "launch_agent",
      herdId: "satellite",
      ref: "",
      channel: "C1",
      threadTs: "root",
      userId: "U1",
      launch: { kind: "claude", workspaceId: "w1", firstPrompt: "go" },
    });
    let result = bridge.registry.takeResult(id);
    await vi.waitFor(
      () => {
        result ??= bridge.registry.takeResult(id);
        expect(result).not.toBeNull();
      },
      { timeout: 4000 },
    );
    expect(result?.ok).toBe(true);
    expect(registry.activeTurn("term-new")?.origin).toEqual({ channel: "C1", threadTs: "root" });
  });
});
