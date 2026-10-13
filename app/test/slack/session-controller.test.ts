import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry } from "../../src/registry/registry.js";
import { SESSION_OVER, SessionController } from "../../src/slack/session-controller.js";
import { pane, snapshot, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const BLOCKED_MENU = "Proceed?\n❯ 1. Yes\n  2. No";

describe("SessionController", () => {
  let dir: string;
  let fake: FakeHerdr;
  let state: SessionState;
  let registry: SessionRegistry;
  let transport: FakeTransport;
  let controller: SessionController;
  let logs: string[];

  const build = async (configOverrides = {}) => {
    fake = await FakeHerdr.start();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    transport = new FakeTransport();
    logs = [];
    controller = new SessionController({
      config: defaultInstance({ contentMode: "full", ...configOverrides }),
      client: new HerdrClient(fake.socketPath, 1_000),
      state,
      registry,
      transport,
      log: (line) => logs.push(line),
    });
  };

  const withAgent = (terminalId = "term_1", paneId = "w1:pA") => {
    state.apply({ type: "workspace_created", workspace: workspace({ label: "proj" }) });
    state.apply({
      type: "pane_created",
      pane: pane({ terminal_id: terminalId, pane_id: paneId, agent_status: "blocked" }),
    });
    registry.upsert(terminalId, {
      lastKnownPaneId: paneId,
      agentKind: "claude",
      title: "fix auth",
      cwd: "/w",
      workspaceId: "w1",
      tabId: "w1:t1",
      lastStatus: "blocked",
    });
    return registry.get(terminalId)?.ref ?? "";
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-ctrl-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    await build();
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    state.dispose();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  describe("prompt", () => {
    it("sends text to the terminal's current pane", async () => {
      withAgent("term_1", "w1:pA");
      fake.on("agent.prompt", () => ({ ok: true }));

      const result = await controller.prompt("term_1", "carry on");

      expect(result.ok).toBe(true);
      const sent = fake.requests.find((r) => r.method === "agent.prompt");
      expect(sent?.params).toMatchObject({ target: "w1:pA", text: "carry on" });
    });

    it("follows a terminal that moved to a new pane", async () => {
      // The exact bug opaque refs exist to prevent: a stored pane id would now
      // point at whatever occupies w1:pA.
      const before = pane({ terminal_id: "term_1", pane_id: "w1:pA" });
      state.apply({ type: "pane_created", pane: before });
      registry.upsert("term_1", {
        lastKnownPaneId: "w1:pA",
        agentKind: "claude",
        title: "t",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "working",
      });
      state.apply({
        type: "pane_moved",
        pane: { ...before, pane_id: "w2:pZ", workspace_id: "w2" },
        previous_pane_id: "w1:pA",
      });
      fake.on("agent.prompt", () => ({ ok: true }));

      await controller.prompt("term_1", "hello");

      expect(fake.requests.at(-1)?.params).toMatchObject({ target: "w2:pZ" });
    });

    it("refuses when the session has ended", async () => {
      const result = await controller.prompt("term_ghost", "hello");
      expect(result).toMatchObject({ ok: false, message: SESSION_OVER });
      // Never a raw herdr error: the user did not address a pane id.
      expect(result.message).not.toContain("target");
    });

    it("explains a stalled prompt in plain words", async () => {
      withAgent();
      fake.on("agent.prompt", () => {
        const error = new Error("agent did not react");
        return error;
      });
      const result = await controller.prompt("term_1", "hello");
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("Error:");
    });
  });

  describe("channel controls", () => {
    it("waits for prompt acknowledgment before it settles a fast reply", async () => {
      withAgent();
      let acknowledge: (() => void) | undefined;
      const promptSpy = vi.spyOn(HerdrClient.prototype, "prompt").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      );
      fake.on("pane.read", () => ({
        read: { text: "old screen\nCompleted the requested change successfully." },
      }));
      const pending = controller.prompt("term_1", "fix", "w1", { channel: "C1" }, "old screen");
      await vi.waitFor(() => expect(acknowledge).toBeDefined());
      expect(registry.activeTurn("term_1")?.deliveryPending).toBe(true);
      // Registry reconciliation must not replace the bound workspace captured before delivery.
      const record = registry.get("term_1");
      if (record) record.workspaceId = "w2";
      expect(registry.activeTurn("term_1")?.expectedWorkspaceId).toBe("w1");
      state.apply({
        type: "pane_updated",
        pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done" }),
      });
      await controller.refreshResponse("term_1", "done");
      expect(transport.posted).toHaveLength(0);
      acknowledge?.();
      expect((await pending).ok).toBe(true);
      expect(registry.turns("term_1")[0]).toMatchObject({
        status: "done",
        response: "Completed the requested change successfully.",
      });
      expect(transport.posted).toHaveLength(1);
      promptSpy.mockRestore();
    });

    it("does not leave a pending turn after herdr rejects prompt delivery", async () => {
      withAgent();
      fake.on("agent.prompt", () => new Error("rejected"));
      expect(
        (await controller.prompt("term_1", "fix", "w1", { channel: "C1" }, "old screen")).ok,
      ).toBe(false);
      expect(registry.turns("term_1")).toHaveLength(0);
      expect(transport.posted).toHaveLength(0);
    });

    it("does not settle a steered Pi turn after an unacknowledged prompt", async () => {
      withAgent();
      const turn = registry.startTurn("term_1", "first", "", { channel: "C1" });
      fake.on("agent.prompt", () => new Error("acknowledgment lost"));
      expect((await controller.prompt("term_1", "second", "w1", { channel: "C2" }, "")).ok).toBe(
        false,
      );
      expect(registry.activeTurn("term_1")?.id).toBe(turn?.id);
      expect(registry.activeTurn("term_1")?.deliveryPending).toBe(true);
      expect(registry.activeTurn("term_1")?.origin).toEqual({ channel: "C1" });
    });

    it("does not attach an origin after a bound prompt moves while herdr acknowledges it", async () => {
      withAgent();
      let acknowledge: (() => void) | undefined;
      const promptSpy = vi.spyOn(HerdrClient.prototype, "prompt").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      );
      const existing = registry.startTurn("term_1", "first", "", { channel: "C1" });
      const pending = controller.prompt("term_1", "second", "w1", { channel: "C2" });
      await vi.waitFor(() => expect(acknowledge).toBeDefined());
      state.apply({
        type: "pane_moved",
        pane: pane({ terminal_id: "term_1", pane_id: "w2:pZ", workspace_id: "w2" }),
        previous_pane_id: "w1:pA",
      });
      acknowledge?.();
      expect((await pending).ok).toBe(false);
      expect(registry.activeTurn("term_1")?.id).toBe(existing?.id);
      expect(registry.activeTurn("term_1")?.origin).toEqual({ channel: "C1" });
      promptSpy.mockRestore();
    });

    it("refuses bound prompt and stop after a workspace move but allows a manual prompt", async () => {
      withAgent();
      state.apply({
        type: "pane_moved",
        pane: pane({ terminal_id: "term_1", pane_id: "w2:pZ", workspace_id: "w2" }),
        previous_pane_id: "w1:pA",
      });
      fake.on("agent.prompt", () => ({ ok: true }));
      fake.on("agent.send_keys", () => ({ ok: true }));
      expect(await controller.prompt("term_1", "bound", "w1")).toMatchObject({ ok: false });
      expect(await controller.interrupt("term_1", "w1")).toMatchObject({ ok: false });
      expect(
        fake.requests.filter((r) => ["agent.prompt", "agent.send_keys"].includes(r.method)),
      ).toHaveLength(0);
      expect(await controller.prompt("term_1", "manual")).toMatchObject({ ok: true });
      expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
        target: "w2:pZ",
        text: "manual",
      });
    });
    it("does not rename a reused pane after clear loses the original terminal", async () => {
      const live = pane({ terminal_id: "term_1", pane_id: "w1:pA" });
      state.applySnapshot(
        snapshot({
          panes: [live],
          agents: [
            {
              terminal_id: "term_1",
              pane_id: "w1:pA",
              name: "build",
              agent: "claude",
              status: "idle",
            },
          ],
        }),
      );
      withAgent();
      fake.on("agent.prompt", () => {
        state.apply({ type: "pane_closed", pane_id: "w1:pA" });
        state.apply({
          type: "pane_created",
          pane: pane({ terminal_id: "intruder", pane_id: "w1:pA" }),
        });
        return { ok: true };
      });
      expect(await controller.clear("term_1")).toMatchObject({ ok: false });
      expect(fake.requests.filter((r) => r.method === "agent.rename")).toHaveLength(0);
    });

    it("refuses stop and clear for an unverified CRE root", async () => {
      await build({ creOnly: true, creRoots: [] });
      withAgent();
      fake.on("agent.send_keys", () => ({ ok: true }));
      fake.on("agent.prompt", () => ({ ok: true }));
      expect(await controller.interrupt("term_1")).toMatchObject({ ok: false });
      expect(await controller.clear("term_1")).toMatchObject({ ok: false });
      expect(
        fake.requests.filter((r) =>
          ["agent.send_keys", "agent.prompt", "agent.rename"].includes(r.method),
        ),
      ).toHaveLength(0);
    });
    it("refuses interrupt and clear when the terminal is gone", async () => {
      expect(await controller.interrupt("gone")).toMatchObject({ ok: false });
      expect(await controller.clear("gone")).toMatchObject({ ok: false });
      expect(
        fake.requests.some((r) => r.method === "agent.send_keys" || r.method === "agent.prompt"),
      ).toBe(false);
    });

    it("refuses clear when herdr has not reported a name", async () => {
      withAgent();
      expect(await controller.clear("term_1")).toMatchObject({
        ok: false,
        message: "That agent has no name.",
      });
      expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
    });

    it("reports an interrupt refusal without a terminal call retry", async () => {
      withAgent();
      fake.on("agent.send_keys", () => new Error("refused"));
      expect(await controller.interrupt("term_1")).toMatchObject({ ok: false });
      expect(fake.requests.filter((r) => r.method === "agent.send_keys")).toHaveLength(1);
    });

    it("stops clear before rename if /new fails", async () => {
      const live = pane({ terminal_id: "term_1", pane_id: "w1:pA" });
      state.applySnapshot(
        snapshot({
          panes: [live],
          agents: [
            {
              pane_id: live.pane_id,
              terminal_id: live.terminal_id,
              workspace_id: live.workspace_id,
              tab_id: live.tab_id,
              agent: "claude",
              agent_status: live.agent_status,
              focused: false,
              revision: live.revision,
              name: "build",
            },
          ],
        }),
      );
      withAgent();
      fake.on("agent.prompt", () => new Error("refused"));
      expect(await controller.clear("term_1")).toMatchObject({ ok: false });
      expect(fake.requests.some((r) => r.method === "agent.rename")).toBe(false);
    });
  });

  describe("menu choices", () => {
    it("sends a bare digit, never text plus Enter", async () => {
      // agent.prompt would append Enter, which lands on the next prompt.
      withAgent();
      fake.on("agent.send_keys", () => ({ ok: true }));

      await controller.chooseMenuOption("term_1", "2");

      const sent = fake.requests.at(-1);
      expect(sent?.method).toBe("agent.send_keys");
      expect(sent?.params).toEqual({ target: "w1:pA", keys: ["2"] });
    });

    it("decodes a well-formed action value", () => {
      expect(SessionController.decodeMenuChoice("abc:3")).toEqual({ ref: "abc", choice: "3" });
    });

    it.each(["abc:0", "abc:99", "abc:x", "abc:;rm -rf /", "nocolon"])(
      "refuses to decode %o",
      (value) => {
        expect(SessionController.decodeMenuChoice(value)).toBeNull();
      },
    );

    it("recognises its own action ids", () => {
      expect(SessionController.isMenuChoiceAction("session_menu_choice_1")).toBe(true);
      expect(SessionController.isMenuChoiceAction("home_refresh")).toBe(false);
    });
  });

  describe("openSession", () => {
    it("posts one card, refreshes it, and records the thread", async () => {
      withAgent();
      fake.on("pane.read", () => ({ read: { text: "build output here" } }));

      const result = await controller.openSession("term_1", "D1");

      expect(result.ok).toBe(true);
      expect(transport.posted[0]?.text).toContain("claude");
      expect(transport.posted).toHaveLength(1);
      expect(JSON.stringify(transport.updated)).toContain("build output here");
      expect(registry.get("term_1")?.slackThreadTs).toBe("ts_1");
    });

    it("redacts the recap before it leaves", async () => {
      withAgent();
      fake.on("pane.read", () => ({ read: { text: "AKIAIOSFODNN7EXAMPLE" } }));

      await controller.openSession("term_1", "D1");

      expect(JSON.stringify(transport.posted)).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(logs.join()).toContain("redacted");
    });

    it("sends no terminal text in summary mode", async () => {
      await build({ contentMode: "summary" });
      withAgent();
      fake.on("pane.read", () => ({ read: { text: "sensitive build output" } }));

      await controller.openSession("term_1", "D1");

      expect(JSON.stringify(transport.posted)).not.toContain("sensitive build output");
    });

    it("does not capture a prompt baseline outside full content mode", async () => {
      await build({ contentMode: "summary" });
      withAgent();
      expect(await controller.captureBaseline("term_1")).toBe("");
      expect(fake.requests.some((request) => request.method === "pane.read")).toBe(false);
    });

    it("offers menu buttons for a blocked agent", async () => {
      withAgent();
      fake.on("pane.read", (params) =>
        params.source === "detection"
          ? { read: { text: BLOCKED_MENU } }
          : { read: { text: "recap" } },
      );

      await controller.openSession("term_1", "D1");

      expect(JSON.stringify(transport.updated)).toContain("1. Yes");
    });

    it("stays quiet when the blocked output is not a menu", async () => {
      withAgent();
      fake.on("pane.read", () => ({ read: { text: "thinking about it" } }));

      await controller.openSession("term_1", "D1");

      expect(logs.join()).toContain("no menu detected");
    });

    it("refuses to open a session that has ended", async () => {
      expect((await controller.openSession("term_ghost", "D1")).ok).toBe(false);
    });

    it("survives herdr refusing the read", async () => {
      withAgent();
      // No pane.read handler → unknown_method; the recap must degrade, not throw.
      const result = await controller.openSession("term_1", "D1");
      expect(result.ok).toBe(true);
    });
  });

  describe("origin-routed replies", () => {
    it.each(["stale", "reconciled"])(
      "authorizes a channel prompt on a %s manual-card turn after a workspace move",
      async (recordState) => {
        const sessionDir = path.join(dir, "sessions");
        mkdirSync(sessionDir);
        process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
        const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
        const live = pane({
          terminal_id: "term_1",
          pane_id: "w1:pA",
          agent: "pi",
          agent_status: "idle",
          agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
        });
        state.applySnapshot(snapshot({ panes: [live] }));
        registry.upsert("term_1", {
          lastKnownPaneId: live.pane_id,
          agentKind: "pi",
          title: "cre",
          cwd: "/w",
          workspaceId: "w1",
          tabId: "w1:t1",
          lastStatus: "idle",
        });
        const header = {
          type: "session",
          version: 3,
          id,
          timestamp: new Date().toISOString(),
          cwd: "/w",
        };
        const row = (
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
        writeFileSync(file, `${JSON.stringify(header)}\n`);
        const captured = await controller.launchBoundary("term_1");
        const original = registry.startTurn(
          "term_1",
          "manual",
          "",
          undefined,
          Date.now(),
          captured,
        );
        const manual = row("u1", null, "user", "manual");
        writeFileSync(file, `${[header, manual].map((item) => JSON.stringify(item)).join("\n")}\n`);
        const moved = { ...live, pane_id: "w2:pZ", workspace_id: "w2" };
        state.apply({ type: "pane_moved", pane: moved, previous_pane_id: live.pane_id });
        if (recordState === "reconciled") registry.upsert("term_1", { workspaceId: "w2" });
        fake.on("agent.prompt", () => ({ ok: true }));
        expect((await controller.prompt("term_1", "second", "w2", { channel: "C2" }, "")).ok).toBe(
          true,
        );
        expect(registry.activeTurn("term_1")).toMatchObject({
          id: original?.id,
          origin: { channel: "C2" },
          expectedWorkspaceId: "w2",
          deliveryPending: false,
        });
        const second = row("u2", "u1", "user", "second");
        const answer = row(
          "a2",
          "u2",
          "assistant",
          [{ type: "text", text: "Completed the authorized change successfully." }],
          "stop",
        );
        writeFileSync(
          file,
          `${[header, manual, second, answer].map((item) => JSON.stringify(item)).join("\n")}\n`,
        );
        await controller.refreshResponse("term_1", "done");
        expect(transport.posted).toHaveLength(1);
        expect(transport.posted[0]?.channel).toBe("C2");
        expect(JSON.stringify(transport.posted)).toContain(
          "Completed the authorized change successfully.",
        );
        await controller.refreshResponse("term_1", "done");
        expect(transport.posted).toHaveLength(1);
      },
    );

    it("keeps the first origin private and authorizes a new prompt after a workspace move", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "idle",
      });
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
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
      const first = entry("u1", null, "user", "first");
      writeFileSync(file, `${JSON.stringify(header)}\n`);
      fake.on("agent.prompt", () => ({ ok: true }));
      expect((await controller.prompt("term_1", "first", "w1", { channel: "C1" }, "")).ok).toBe(
        true,
      );
      writeFileSync(file, `${[header, first].map((row) => JSON.stringify(row)).join("\n")}\n`);
      state.apply({
        type: "pane_moved",
        pane: { ...live, pane_id: "w2:pZ", workspace_id: "w2" },
        previous_pane_id: live.pane_id,
      });
      await controller.refreshResponse("term_1", "done");
      expect(transport.posted).toHaveLength(0);
      expect((await controller.prompt("term_1", "second", "w2", { channel: "C2" }, "")).ok).toBe(
        true,
      );
      const active = registry.activeTurn("term_1");
      expect(active).toMatchObject({ origin: { channel: "C2" }, expectedWorkspaceId: "w2" });
      const second = entry("u2", "u1", "user", "second");
      const answer = entry(
        "a2",
        "u2",
        "assistant",
        [{ type: "text", text: "Completed the second change successfully." }],
        "stop",
      );
      writeFileSync(
        file,
        `${[header, first, second, answer].map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1").find((turn) => turn.id === active?.id)?.status).toBe("done");
      expect(transport.posted).toHaveLength(1);
      expect(transport.posted[0]?.channel).toBe("C2");
      expect(JSON.stringify(transport.posted)).toContain(
        "Completed the second change successfully.",
      );
    });

    it("keeps a launch turn pending across restart after its confirmed target moves", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/w" })}\n`,
      );
      const captured = await controller.preparePiLaunchTurn("term_1", "first", "w1", {
        channel: "C1",
      });
      state.apply({
        type: "pane_moved",
        pane: { ...live, pane_id: "w2:pZ", workspace_id: "w2" },
        previous_pane_id: live.pane_id,
      });
      expect(await controller.confirmPiLaunchTurn(captured)).toBe(false);
      state.apply({ type: "pane_moved", pane: live, previous_pane_id: "w2:pZ" });
      writeFileSync(
        file,
        `${[
          { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/w" },
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "first", timestamp: Date.now() },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Completed the first change successfully." }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
          },
        ]
          .map((item) => JSON.stringify(item))
          .join("\n")}\n`,
      );
      const recovered = new SessionRegistry("default");
      recovered.load();
      controller = new SessionController({
        config: defaultInstance({ contentMode: "full" }),
        client: new HerdrClient(fake.socketPath, 1_000),
        state,
        registry: recovered,
        transport,
        log: (line) => logs.push(line),
      });
      await controller.refreshResponse("term_1", "done");
      expect(recovered.activeTurn("term_1")?.deliveryPending).toBe(true);
      expect(transport.posted).toHaveLength(0);
    });

    it("does not post a confirmed but invalidated Pi steer to the earlier origin", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "idle",
      });
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
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
      writeFileSync(file, `${JSON.stringify(header)}\n`);
      fake.on("agent.prompt", () => ({ ok: true }));
      expect((await controller.prompt("term_1", "first", "w1", { channel: "C1" }, "")).ok).toBe(
        true,
      );
      const first = registry.activeTurn("term_1");
      writeFileSync(
        file,
        `${[header, entry("u1", null, "user", "first"), entry("a1", "u1", "assistant", [{ type: "text", text: "EXAMPLE approval" }], "toolUse")].map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
      const promptSpy = vi.spyOn(HerdrClient.prototype, "prompt").mockImplementation(async () => {
        state.apply({
          type: "pane_moved",
          pane: { ...live, pane_id: "w2:pZ", workspace_id: "w2" },
          previous_pane_id: live.pane_id,
        });
        await controller.refreshResponse("term_1", "done");
        expect(transport.posted).toHaveLength(0);
      });
      try {
        expect((await controller.prompt("term_1", "second", "w1", { channel: "C2" }, "")).ok).toBe(
          false,
        );
      } finally {
        promptSpy.mockRestore();
      }
      state.apply({ type: "pane_moved", pane: live, previous_pane_id: "w2:pZ" });
      writeFileSync(
        file,
        `${[header, entry("u1", null, "user", "first"), entry("a1", "u1", "assistant", [{ type: "text", text: "EXAMPLE approval" }], "toolUse"), entry("u2", "a1", "user", "second"), entry("a2", "u2", "assistant", [{ type: "text", text: "Completed the second change successfully." }], "stop")].map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
      registry.save();
      const recovered = new SessionRegistry("default");
      recovered.load();
      controller = new SessionController({
        config: defaultInstance({ contentMode: "full" }),
        client: new HerdrClient(fake.socketPath, 1_000),
        state,
        registry: recovered,
        transport,
        log: (line) => logs.push(line),
      });
      await controller.refreshResponse("term_1", "done");
      expect(recovered.activeTurn("term_1")?.id).toBe(first?.id);
      expect(recovered.activeTurn("term_1")?.deliveryPending).toBe(true);
      expect(transport.posted).toHaveLength(0);
      fake.on("agent.prompt", () => ({ ok: true }));
      expect((await controller.prompt("term_1", "third", "w1", { channel: "C3" }, "")).ok).toBe(
        true,
      );
      expect(recovered.turns("term_1")[0]).toMatchObject({
        status: "working",
        deliveryPending: false,
        origin: { channel: "C3" },
      });
      expect(transport.posted).toHaveLength(0);
    });

    it("keeps a blocked Pi tool-use turn active until its final answer", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "blocked",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "blocked",
      });
      const boundary = await controller.launchBoundary("term_1");
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
      };
      const row = (
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
      const partial = [
        header,
        row("u1", null, "user", "fix"),
        row("a1", "u1", "assistant", [{ type: "text", text: "Need approval" }], "toolUse"),
      ];
      writeFileSync(file, `${partial.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const turn = registry.startTurn("term_1", "fix", "", { channel: "C1" }, Date.now(), boundary);
      await controller.refreshResponse("term_1", "blocked");
      expect(registry.activeTurn("term_1")?.id).toBe(turn?.id);
      expect(transport.posted).toHaveLength(0);
      fake.on("agent.send_keys", () => ({ ok: true }));
      expect((await controller.chooseMenuOption("term_1", "1")).ok).toBe(true);
      expect(registry.activeTurn("term_1")?.piBoundary?.entryId).toBeNull();
      writeFileSync(
        file,
        `${[...partial, row("t1", "a1", "toolResult", [{ type: "text", text: "EXAMPLE result" }]), row("a2", "t1", "assistant", [{ type: "text", text: "Completed the approved change and verified the result." }], "stop")].map((line) => JSON.stringify(line)).join("\n")}\n`,
      );
      state.apply({ type: "pane_updated", pane: { ...live, agent_status: "done" } });
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1")[0]).toMatchObject({
        status: "done",
        response: "Completed the approved change and verified the result.",
      });
      expect(transport.posted).toHaveLength(1);
    });

    it("reads a complete Pi reply from the current local session, not terminal scrollback", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const file = path.join(
        sessionDir,
        "2026-10-13T00-00-00_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      );
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "working",
      });
      const boundary = await controller.launchBoundary("term_1");
      expect(boundary?.entryId).toBeNull();
      const lines = [
        {
          type: "session",
          version: 3,
          id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          timestamp: new Date().toISOString(),
          cwd: "/w",
        },
        {
          type: "message",
          id: "user1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Explain TOKEN=EXAMPLE123", timestamp: Date.now() },
        },
        {
          type: "message",
          id: "answer1",
          parentId: "user1",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "do not publish" },
              {
                type: "text",
                text: "First useful answer paragraph.\n\nSecond useful answer paragraph. TOKEN=EXAMPLE123",
              },
            ],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ];
      writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      registry.startTurn(
        "term_1",
        "Explain TOKEN=EXAMPLE123",
        "",
        { channel: "C1" },
        Date.now(),
        boundary,
      );
      fake.on("pane.read", () => ({ read: { text: "an unrelated terminal message" } }));
      const pending = controller.refreshResponse("term_1", "done");
      state.apply({
        type: "pane_moved",
        pane: { ...live, pane_id: "w2:pZ", workspace_id: "w2" },
        previous_pane_id: live.pane_id,
      });
      await pending;
      expect(transport.posted).toHaveLength(0);
      expect(registry.activeTurn("term_1")?.status).toBe("working");
      state.apply({ type: "pane_moved", pane: live, previous_pane_id: "w2:pZ" });
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1")[0]?.response).toBe(
        "First useful answer paragraph.\n\nSecond useful answer paragraph. TOKEN=‹redacted›",
      );
      expect(JSON.stringify(transport.posted)).not.toContain("EXAMPLE123");
      expect(JSON.stringify(transport.posted)).not.toContain("do not publish");
      const oldIdentity = registry.get("term_1")?.lastPiResponseId;
      if (!boundary || !live.agent_session) throw new Error("Pi session boundary missing");
      const next = registry.startTurn(
        "term_1",
        "new session prompt",
        "",
        { channel: "C1" },
        Date.now(),
        { ...boundary, entryId: "answer1" },
      );
      const newPath = path.join(
        sessionDir,
        "2026-10-13T00-00-00_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl",
      );
      state.apply({
        type: "pane_updated",
        pane: { ...live, agent_session: { ...live.agent_session, value: newPath } },
      });
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1").find((turn) => turn.id === next?.id)).toMatchObject({
        status: "failed",
      });
      expect(registry.get("term_1")?.lastPiResponseId).toBe(oldIdentity);
      // A changed Pi source cannot announce even an unavailable notice.
      expect(transport.posted).toHaveLength(1);
      const fresh = await controller.launchBoundary("term_1");
      const failed = registry.startTurn(
        "term_1",
        "new failed request",
        "",
        { channel: "C1" },
        Date.now(),
        fresh,
      );
      const newLines = [
        {
          type: "session",
          version: 3,
          id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
          timestamp: new Date().toISOString(),
          cwd: "/w",
        },
        {
          type: "message",
          id: "u3",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "new failed request", timestamp: Date.now() },
        },
        {
          type: "message",
          id: "a3",
          parentId: "u3",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Partial secret TOKEN=EXAMPLE123" }],
            stopReason: "error",
            timestamp: Date.now(),
          },
        },
      ];
      writeFileSync(newPath, `${newLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1").find((turn) => turn.id === failed?.id)).toMatchObject({
        status: "failed",
        response: "Pi turn failed without a complete reply.",
      });
      expect(JSON.stringify(transport.posted.at(-1))).not.toContain("Partial secret");
      expect(JSON.stringify(transport.posted.at(-1))).not.toContain(
        "First useful answer paragraph",
      );
    });

    it("keeps a steered Pi turn boundary and origin after daemon restart", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "idle",
      });
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
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
      const previous = [
        header,
        entry("u1", null, "user", "old prompt"),
        entry(
          "a1",
          "u1",
          "assistant",
          [{ type: "text", text: "Old answer that must not post" }],
          "stop",
        ),
      ];
      writeFileSync(file, `${previous.map((line) => JSON.stringify(line)).join("\n")}\n`);
      registry.startTurn("term_1", "old prompt", "", { channel: "C1" });
      fake.on("agent.prompt", () => ({ ok: true }));
      const prompt = "Explain the first line\nand the second line TOKEN=EXAMPLE123";
      expect(
        await controller.prompt("term_1", prompt, undefined, { channel: "C2", threadTs: "root" }),
      ).toMatchObject({ ok: true });
      expect(registry.activeTurn("term_1")?.piBoundary?.entryId).toBe("a1");
      fake.on("agent.prompt", () => new Error("send refused"));
      expect(
        (await controller.prompt("term_1", "unsent steering prompt", undefined, { channel: "C9" }))
          .ok,
      ).toBe(false);
      expect(registry.activeTurn("term_1")?.piBoundary?.entryId).toBe("a1");
      expect(registry.activeTurn("term_1")?.origin).toEqual({ channel: "C2", threadTs: "root" });
      writeFileSync(
        file,
        `${[...previous, entry("u2", "a1", "user", prompt), entry("a2", "u2", "assistant", [{ type: "text", text: prompt }], "stop")].map((line) => JSON.stringify(line)).join("\n")}\n`,
      );
      registry.save();
      const recovered = new SessionRegistry("default");
      recovered.load();
      registry = recovered;
      controller = new SessionController({
        config: defaultInstance({ contentMode: "full" }),
        client: new HerdrClient(fake.socketPath, 1_000),
        state,
        registry,
        transport,
        log: (line) => logs.push(line),
      });
      await controller.refreshResponse("term_1", "done");
      expect(registry.turns("term_1")[0]?.response).toBe(
        "Explain the first line\nand the second line TOKEN=‹redacted›",
      );
      expect(transport.posted[0]).toMatchObject({ channel: "C2", threadTs: "root" });
      expect(JSON.stringify(transport.posted)).not.toContain("Old answer");
      expect(JSON.stringify(transport.posted)).not.toContain("EXAMPLE123");
      await controller.refreshResponse("term_1", "done");
      expect(transport.posted).toHaveLength(1);
    });

    it("refuses stale Pi session after /new and accepts an empty new session path", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const oldPath = path.join(
        sessionDir,
        "2026-10-13T00-00-00_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      );
      const newPath = path.join(
        sessionDir,
        "2026-10-13T00-00-01_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl",
      );
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: oldPath },
      });
      state.applySnapshot(
        snapshot({
          panes: [live],
          agents: [
            {
              terminal_id: "term_1",
              pane_id: "w1:pA",
              workspace_id: "w1",
              tab_id: "w1:t1",
              agent: "pi",
              agent_status: "idle",
              focused: false,
              revision: 1,
              name: "build",
            },
          ],
        }),
      );
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "idle",
      });
      fake.on("agent.prompt", () => ({ ok: true }));
      fake.on("agent.rename", () => ({ ok: true }));
      expect(await controller.clear("term_1")).toMatchObject({ ok: true });
      expect((await controller.prompt("term_1", "new prompt")).ok).toBe(false);
      expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(1);
      state.apply({
        type: "pane_updated",
        pane: {
          ...live,
          agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: newPath },
        },
      });
      expect(await controller.prompt("term_1", "new prompt")).toMatchObject({
        ok: true,
        piBoundary: { path: newPath, entryId: null },
      });
      expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(2);
    });

    const settleWith = async (origin?: { channel: string; threadTs?: string }) => {
      withAgent();
      fake.on("pane.read", () => ({
        read: { text: "old screen\nImplemented the requested change in full." },
      }));
      registry.startTurn("term_1", "make the change", "old screen", origin);
      await controller.refreshResponse("term_1", "done");
    };

    it.each(["workspace_move", "terminal_loss", "new_delivery", "disconnected"] as const)(
      "does not announce after %s during card update",
      async (change) => {
        withAgent();
        registry.setThread("term_1", "D1", "card");
        let connected = true;
        controller = new SessionController({
          config: defaultInstance({ contentMode: "full" }),
          client: new HerdrClient(fake.socketPath, 1_000),
          state,
          registry,
          transport,
          log: (line) => logs.push(line),
          isHerdrConnected: () => connected,
        });
        fake.on("pane.read", () => ({
          read: { text: "old screen\nCompleted the requested change successfully." },
        }));
        const old = registry.startTurn("term_1", "fix", "old screen", { channel: "C1" });
        transport.updateMessage = async () => {
          if (change === "workspace_move")
            state.apply({
              type: "pane_moved",
              pane: pane({ terminal_id: "term_1", pane_id: "w2:pZ", workspace_id: "w2" }),
              previous_pane_id: "w1:pA",
            });
          if (change === "terminal_loss") state.apply({ type: "pane_closed", pane_id: "w1:pA" });
          if (change === "new_delivery")
            registry.startTurn("term_1", "new prompt", "old screen", { channel: "C2" });
          if (change === "disconnected") connected = false;
        };
        await controller.refreshResponse("term_1", "done");
        expect(transport.posted).toHaveLength(0);
        expect(
          registry.turns("term_1").find((item) => item.id === old?.id)?.notifiedAt,
        ).toBeUndefined();
      },
    );

    it("does not announce a Pi turn after its session path changes during card update", async () => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const next = path.join(
        sessionDir,
        "2026-10-13T00-00-01_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl",
      );
      const live = pane({
        terminal_id: "term_1",
        pane_id: "w1:pA",
        agent: "pi",
        agent_status: "done",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.applySnapshot(snapshot({ panes: [live] }));
      registry.upsert("term_1", {
        lastKnownPaneId: live.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "done",
      });
      registry.setThread("term_1", "D1", "card");
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
      };
      writeFileSync(file, `${JSON.stringify(header)}\n`);
      const boundary = await controller.launchBoundary("term_1");
      const turn = registry.startTurn("term_1", "fix", "", { channel: "C1" }, Date.now(), boundary);
      writeFileSync(
        file,
        `${[header, { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "fix", timestamp: Date.now() } }, { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Completed the requested change successfully." }], stopReason: "stop", timestamp: Date.now() } }].map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
      transport.updateMessage = async () => {
        state.apply({
          type: "pane_updated",
          pane: {
            ...live,
            agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: next },
          },
        });
      };
      await controller.refreshResponse("term_1", "done");
      expect(transport.posted).toHaveLength(0);
      expect(
        registry.turns("term_1").find((row) => row.id === turn?.id)?.notifiedAt,
      ).toBeUndefined();
    });

    it("posts a settled turn once, top-level in its origin channel", async () => {
      await settleWith({ channel: "C1" });
      await controller.refreshResponse("term_1", "done");

      expect(transport.posted).toHaveLength(1);
      expect(transport.posted[0]?.channel).toBe("C1");
      expect(transport.posted[0]?.threadTs).toBeUndefined();
      expect(JSON.stringify(transport.posted[0]?.blocks)).toContain("Implemented the requested");
      expect(registry.get("term_1")?.replyPosts).toEqual([{ channel: "C1", ts: "ts_1" }]);
      expect(registry.terminalForReplyPost("C1", "ts_1")).toBe("term_1");
    });

    it("answers in the origin thread and records the thread root", async () => {
      await settleWith({ channel: "C1", threadTs: "5.5" });

      expect(transport.posted[0]).toMatchObject({ channel: "C1", threadTs: "5.5" });
      expect(registry.get("term_1")?.replyPosts).toEqual([{ channel: "C1", ts: "5.5" }]);
    });

    it("posts nothing for a turn with no origin and no card", async () => {
      await settleWith();
      expect(transport.posted).toHaveLength(0);
    });

    it("posts nothing for an ended session", async () => {
      withAgent();
      const turn = registry.startTurn("term_1", "go", "", { channel: "C1" });
      registry.updateTurn("term_1", turn?.id ?? "", {
        status: "done",
        response: "Implemented the requested change in full.",
      });
      registry.markEnded("term_1");
      await controller.announceReply("term_1", turn?.id ?? "");
      expect(transport.posted).toHaveLength(0);
    });
  });

  describe("verifyAcknowledged", () => {
    it("reports success once the agent leaves blocked", async () => {
      const paneInfo = pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "blocked" });
      state.apply({ type: "pane_created", pane: paneInfo });
      state.apply({ type: "pane_updated", pane: { ...paneInfo, agent_status: "working" } });

      await expect(controller.verifyAcknowledged("term_1", 100)).resolves.toBe(true);
    });

    it("reports failure when the agent is still blocked", async () => {
      withAgent();
      await expect(controller.verifyAcknowledged("term_1", 60)).resolves.toBe(false);
    });
  });
});
