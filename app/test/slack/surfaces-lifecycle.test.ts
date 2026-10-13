import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { RateBudget } from "../../src/daemon/budget.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { EventTail } from "../../src/herdr/events.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry } from "../../src/registry/registry.js";
import { MODAL_IDS } from "../../src/slack/modals.js";
import { SESSION_ACTIONS } from "../../src/slack/session.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const ctx = (overrides = {}) => ({ teamId: "T1", userId: "U1", channel: "D1", ...overrides });
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("single-card session lifecycle", () => {
  let dir: string;
  let fake: FakeHerdr;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let surfaces: Surfaces;
  let tail: EventTail;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-card-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    fake = await FakeHerdr.start();
    transport = new FakeTransport();
    state = new SessionState({ blocked: 5, idle: 5, done: 5 });
    state.markPrimed();
    registry = new SessionRegistry("default");
    tail = new EventTail(new HerdrClient(fake.socketPath, 500), state);
    tail.start();
    await settle();
    surfaces = new Surfaces({
      config: defaultInstance({
        contentMode: "full",
        slack: {
          botToken: "xoxb-1",
          appToken: "xapp-1",
          teamId: "T1",
          appId: "A1",
          botUserId: "UBOT",
        },
        allowedUsers: ["U1"],
      }),
      instance: "default",
      transport,
      state,
      tail,
      registry,
      client: new HerdrClient(fake.socketPath, 1_000),
      budget: new RateBudget({ totalPerMin: 500 }),
      cursorIdleActivityMs: 20,
      agentGoneMs: 20,
      log: () => undefined,
    });
    surfaces.start();
    state.apply({ type: "workspace_created", workspace: workspace() });
    state.apply({
      type: "pane_created",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "idle" }),
    });
    surfaces.reconcileSessions();
  });

  afterEach(async () => {
    surfaces.stop();
    tail.stop();
    state.dispose();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  const ref = () => registry.get("term_1")?.ref ?? "";
  const open = async () => {
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_open_session",
      value: ref(),
      triggerId: "open",
    });
  };
  const reply = async (text: string) => {
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.reply,
      value: ref(),
      triggerId: "reply",
    });
    await transport.emitViewSubmit({
      ctx: ctx({ channel: "", surface: "modal" }),
      callbackId: MODAL_IDS.reply,
      privateMetadata: ref(),
      view: { values: { b_reply: { a_reply: { value: text } } } },
    });
  };

  it("reuses one root card", async () => {
    fake.on("pane.read", () => ({ read: { text: "latest answer" } }));
    await open();
    await open();
    await open();
    expect(transport.posted.filter((post) => !post.threadTs)).toHaveLength(1);
  });

  it("sends a modal reply and updates the card when the turn settles", async () => {
    let reads = 0;
    fake.on("pane.read", () => ({
      read: {
        text: reads++ === 0 ? "old screen" : "old screen\nImplemented the requested change.",
      },
    }));
    fake.on("agent.prompt", () => ({ ok: true }));
    await open();
    await reply("Please make the change");

    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "working", revision: 2 }),
    });
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done", revision: 3 }),
    });
    await settle(30);

    const card = JSON.stringify(transport.updated.at(-1));
    expect(card).toContain("Please make the change");
    expect(card).toContain("Implemented the requested change");
    expect(registry.turns("term_1").at(-1)?.status).toBe("done");
  });

  it("never turns ordinary thread messages into agent prompts", async () => {
    fake.on("pane.read", () => ({ read: { text: "answer" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    await open();
    const threadTs = registry.get("term_1")?.slackThreadTs ?? "";
    await transport.emitMessage({ ctx: ctx({ threadTs, ts: "1.1" }), text: "repeat me" });
    expect(fake.requests.some((request) => request.method === "agent.prompt")).toBe(false);
  });

  it("records work started outside Slack as a turn, editing the card in place", async () => {
    fake.on("pane.read", () => ({ read: { text: "Rebuilt the parser and all tests pass." } }));
    await open();
    const postedBefore = transport.posted.length;

    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "working", revision: 2 }),
    });
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done", revision: 3 }),
    });
    await settle(30);

    const turns = registry.turns("term_1");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.response).toContain("Rebuilt the parser");
    expect(turns[0]?.status).toBe("done");
    // Editing the card is fine; posting a second message is the loop we fixed.
    expect(transport.posted).toHaveLength(postedBefore);
  });

  it("does not record a second turn when the agent settles on the same output", async () => {
    fake.on("pane.read", () => ({ read: { text: "Rebuilt the parser and all tests pass." } }));
    await open();

    for (const revision of [2, 4]) {
      state.apply({
        type: "pane_updated",
        pane: pane({
          terminal_id: "term_1",
          pane_id: "w1:pA",
          agent_status: "working",
          revision,
        }),
      });
      state.apply({
        type: "pane_updated",
        pane: pane({
          terminal_id: "term_1",
          pane_id: "w1:pA",
          agent_status: "done",
          revision: revision + 1,
        }),
      });
      await settle(30);
    }

    expect(registry.turns("term_1")).toHaveLength(1);
  });

  it("records a cursor-style settle (working → idle) after the idle delay", async () => {
    let text = "warming up";
    fake.on("pane.read", () => ({ read: { text } }));
    await open();
    expect(registry.turns("term_1")).toHaveLength(0);
    text = "Refactored the module and tests pass.";

    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "working", revision: 2 }),
    });
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "idle", revision: 3 }),
    });
    await settle(60); // past the 20ms test idle delay

    const turns = registry.turns("term_1");
    expect(turns.at(-1)?.response).toContain("Refactored the module");
    expect(turns.at(-1)?.status).toBe("done");
  });

  it.each(["done", "idle"] as const)(
    "posts a card-less turn's reply to its origin when it settles %s",
    async (to) => {
      fake.on("pane.read", () => ({
        read: { text: "old screen\nPushed the fix and the build is green." },
      }));
      registry.startTurn("term_1", "fix it", "old screen", { channel: "C9" });

      state.apply({
        type: "pane_updated",
        pane: pane({
          terminal_id: "term_1",
          pane_id: "w1:pA",
          agent_status: "working",
          revision: 2,
        }),
      });
      state.apply({
        type: "pane_updated",
        pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: to, revision: 3 }),
      });
      await settle(60);

      expect(registry.get("term_1")?.slackThreadTs).toBeUndefined();
      expect(transport.posted.map((post) => post.channel)).toEqual(["C9"]);
      expect(JSON.stringify(transport.posted[0])).toContain("build is green");
    },
  );

  it("posts nothing when a card-less agent without an origin settles", async () => {
    fake.on("pane.read", () => ({ read: { text: "Pushed the fix and the build is green." } }));
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "working", revision: 2 }),
    });
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done", revision: 3 }),
    });
    await settle(60);

    expect(transport.posted).toHaveLength(0);
  });

  it("records a settled response into history on manual Refresh", async () => {
    let text = "warming up";
    fake.on("pane.read", () => ({ read: { text } }));
    await open();
    expect(registry.turns("term_1")).toHaveLength(0);

    text = "Wrote the migration and verified it applies cleanly.";
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.refresh,
      value: ref(),
      triggerId: "refresh",
    });

    const turns = registry.turns("term_1");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.response).toContain("Wrote the migration");
  });

  it("records only the new output on a second self-started turn", async () => {
    let text = "First answer: the config was missing a port.";
    fake.on("pane.read", () => ({ read: { text } }));
    await open();

    const refresh = async () => {
      await transport.emitAction({
        ctx: ctx(),
        actionId: SESSION_ACTIONS.refresh,
        value: ref(),
        triggerId: "refresh",
      });
    };
    await refresh();
    text = `${text}\nSecond answer: the retry loop now backs off.`;
    await refresh();

    const turns = registry.turns("term_1");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.response).toContain("Second answer");
    expect(turns[1]?.response).not.toContain("First answer");
  });

  it("pushes the finished reply into the thread so Slack raises a notification", async () => {
    // Editing the card is silent in Slack: without a posted message a reply that
    // arrives while the user is away is never announced.
    let text = "warming up";
    fake.on("pane.read", () => ({ read: { text } }));
    await open();
    text = "Done. The migration applies cleanly on a fresh database.";

    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.refresh,
      value: ref(),
      triggerId: "refresh",
    });

    const threadTs = registry.get("term_1")?.slackThreadTs;
    const notices = transport.posted.filter((post) => post.threadTs === threadTs);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain("migration applies cleanly");
    expect(notices[0]?.text).toContain("replied");
  });

  it("announces a settled turn exactly once, however often it settles again", async () => {
    fake.on("pane.read", () => ({ read: { text: "Done. Nothing else to report here." } }));
    await open();

    const refresh = () =>
      transport.emitAction({
        ctx: ctx(),
        actionId: SESSION_ACTIONS.refresh,
        value: ref(),
        triggerId: "refresh",
      });
    await refresh();
    await refresh();
    await refresh();

    const threadTs = registry.get("term_1")?.slackThreadTs;
    // The dedupe that stops the old "Finished" loop: same output, one notice.
    expect(transport.posted.filter((post) => post.threadTs === threadTs)).toHaveLength(1);
  });

  it("does not announce a spinner frame", async () => {
    fake.on("pane.read", () => ({ read: { text: "⢠⢛ Working" } }));
    await open();
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.refresh,
      value: ref(),
      triggerId: "refresh",
    });
    const threadTs = registry.get("term_1")?.slackThreadTs;
    expect(transport.posted.filter((post) => post.threadTs === threadTs)).toHaveLength(0);
  });

  it("does not record a spinner frame as a turn", async () => {
    fake.on("pane.read", () => ({ read: { text: "⢠⢛ Working" } }));
    await open();
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "working", revision: 2 }),
    });
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done", revision: 3 }),
    });
    await settle(30);

    expect(registry.turns("term_1")).toHaveLength(0);
  });

  it("ends the remote session immediately and removes all controls", async () => {
    fake.on("pane.read", () => ({ read: { text: "answer" } }));
    fake.on("pane.close", () => ({ ok: true }));
    await open();
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.end,
      value: ref(),
      triggerId: "end",
    });
    expect(registry.get("term_1")?.closedByUser).toBe(true);
    const card = JSON.stringify(transport.updated.at(-1));
    expect(card).toContain("read-only");
    expect(card).not.toContain(SESSION_ACTIONS.reply);
  });

  it("keeps an Open button on Home for a session closed while its pane is live", async () => {
    fake.on("pane.read", () => ({ read: { text: "answer" } }));
    fake.on("pane.close", () => ({ ok: true }));
    await open();
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.end,
      value: ref(),
      triggerId: "end",
    });
    expect(registry.get("term_1")?.ended).toBe(true);

    // The pane is still live (Cursor may ignore the close), so the row must
    // stay openable instead of losing its ref and stranding the session.
    const agent = surfaces.homeAgents().find((a) => a.terminalId === "term_1");
    expect(agent?.ref).toBe(ref());
    expect(agent?.ref).not.toBe("");
  });

  it("reopening a closed session from Home re-attaches the live card", async () => {
    fake.on("pane.read", () => ({ read: { text: "answer" } }));
    fake.on("pane.close", () => ({ ok: true }));
    await open();
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.end,
      value: ref(),
      triggerId: "end",
    });
    expect(registry.get("term_1")?.closedByUser).toBe(true);

    await open();

    const record = registry.get("term_1");
    expect(record?.ended).toBe(false);
    expect(record?.closedByUser).toBe(false);
    const card = JSON.stringify(transport.updated.at(-1));
    expect(card).toContain(SESSION_ACTIONS.reply);
    expect(card).not.toContain("Session ended");
  });

  it("redacts a completed response before storing or rendering it", async () => {
    let reads = 0;
    fake.on("pane.read", () => ({
      read: { text: reads++ === 0 ? "old" : "old\nAKIAIOSFODNN7EXAMPLE" },
    }));
    fake.on("agent.prompt", () => ({ ok: true }));
    await open();
    await reply("show result");
    state.apply({
      type: "pane_updated",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "done", revision: 2 }),
    });
    await settle(30);
    expect(JSON.stringify(registry.turns("term_1"))).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(transport.updated)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
