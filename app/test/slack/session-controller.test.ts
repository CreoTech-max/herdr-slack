import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry } from "../../src/registry/registry.js";
import { SESSION_OVER, SessionController } from "../../src/slack/session-controller.js";
import { pane, workspace } from "../helpers/factories.js";
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
    const settleWith = async (origin?: { channel: string; threadTs?: string }) => {
      withAgent();
      fake.on("pane.read", () => ({
        read: { text: "old screen\nImplemented the requested change in full." },
      }));
      registry.startTurn("term_1", "make the change", "old screen", origin);
      await controller.refreshResponse("term_1", "done");
    };

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

    it("extracts a cre (pi) reply from its redrawn screen", async () => {
      const screen = (name: string) =>
        readFileSync(new URL(`fixtures/${name}.txt`, import.meta.url), "utf8");
      state.apply({
        type: "pane_created",
        pane: pane({ terminal_id: "term_cre", pane_id: "w1:pC", agent: "pi" }),
      });
      registry.upsert("term_cre", {
        lastKnownPaneId: "w1:pC",
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "working",
      });
      fake.on("pane.read", () => ({ read: { text: screen("cre-turn2") } }));
      registry.startTurn("term_cre", "say it", screen("cre-turn1"), { channel: "C1" });

      await controller.refreshResponse("term_cre", "done");

      expect(registry.turns("term_cre")[0]?.response).toBe("ALPHA BRAVO CHARLIE");
      expect(JSON.stringify(transport.posted)).not.toContain("Update Available");
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
