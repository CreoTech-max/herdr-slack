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
import { SESSION_ACTIONS } from "../../src/slack/session.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

/** Everything the bot said, whether posted or shown only to the user. */
const said = (transport: FakeTransport): string =>
  [...transport.posted.map((p) => p.text), ...transport.ephemerals.map((e) => e.text)].join("\n");

const ctx = (overrides = {}) => ({ teamId: "T1", userId: "U1", channel: "D1", ...overrides });

describe("Surfaces action dispatch", () => {
  let dir: string;
  let fake: FakeHerdr;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let surfaces: Surfaces;
  let tail: EventTail;
  let logs: string[];

  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-disp-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    logs = [];
    fake = await FakeHerdr.start();
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    tail = new EventTail(new HerdrClient(fake.socketPath, 500), state);
    tail.start();
    await settle();

    surfaces = new Surfaces({
      config: defaultInstance({
        label: "personal",
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
      budget: new RateBudget({ totalPerMin: 200 }),
      ackTimeoutMs: 50,
      log: (line) => logs.push(line),
    });
    surfaces.start();

    state.apply({ type: "workspace_created", workspace: workspace() });
    state.apply({
      type: "pane_created",
      pane: pane({ terminal_id: "term_1", pane_id: "w1:pA", agent_status: "blocked" }),
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

  it("opens the launch modal from the Home button, which targets no session", async () => {
    // The button carries the literal "new", not a ref, so routing it through
    // ref resolution denied it as unknown — telling the user the button was
    // from an older message, which they could do nothing about.
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_new_agent",
      value: "new",
      triggerId: "t-new",
    });

    expect(transport.modals.length).toBeGreaterThan(0);
    expect(logs.join()).not.toContain("unknown_ref");
  });

  it("refreshes Home without needing a session ref either", async () => {
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_refresh",
      value: "refresh",
      triggerId: "t-ref",
    });
    expect(logs.join()).not.toContain("unknown_ref");
  });

  it("opens a session thread and records it", async () => {
    fake.on("pane.read", () => ({ read: { text: "recent output" } }));

    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_open_session",
      value: ref(),
      triggerId: "t1",
    });

    expect(transport.posted.length).toBeGreaterThan(0);
    expect(registry.get("term_1")?.slackThreadTs).toBeDefined();
  });

  it("ends the session by closing the pane, and locks the card", async () => {
    fake.on("pane.read", () => ({ read: { text: "latest answer" } }));
    fake.on("pane.close", () => ({ ok: true }));
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_open_session",
      value: ref(),
      triggerId: "open",
    });

    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.end,
      value: ref(),
      triggerId: "t1",
    });

    const sent = fake.requests.filter((r) => r.method === "pane.close").at(-1);
    expect(sent?.params).toEqual({ pane_id: "w1:pA" });
    expect(registry.get("term_1")?.ended).toBe(true);
    expect(JSON.stringify(transport.updated)).toContain("read-only");
  });

  it("answers a menu choice with a bare digit", async () => {
    fake.on("agent.send_keys", () => ({ ok: true }));

    await transport.emitAction({
      ctx: ctx(),
      actionId: "session_menu_choice_2",
      value: `${ref()}:2`,
      triggerId: "t1",
    });

    const sent = fake.requests.filter((r) => r.method === "agent.send_keys").at(-1);
    expect(sent?.params).toEqual({ target: "w1:pA", keys: ["2"] });
  });

  it("refuses a menu value carrying something that is not a digit", async () => {
    // A crafted value must never reach send_keys.
    fake.on("agent.send_keys", () => ({ ok: true }));

    await transport.emitAction({
      ctx: ctx(),
      actionId: "session_menu_choice_1",
      value: `${ref()}:rm -rf /`,
      triggerId: "t1",
    });

    // It is refused at the guard, before dispatch — a packed value whose digit
    // is not a digit resolves to no ref at all, which fails closed.
    expect(fake.requests.some((r) => r.method === "agent.send_keys")).toBe(false);
    expect(logs.join()).toContain("denied");
  });

  it("warns when a menu keypress goes unacknowledged, without resending", async () => {
    fake.on("agent.send_keys", () => ({ ok: true }));

    await transport.emitAction({
      ctx: ctx(),
      actionId: "session_menu_choice_1",
      value: `${ref()}:1`,
      triggerId: "t1",
    });

    // The agent is still blocked, so the user is told rather than retried at.
    const sends = fake.requests.filter((r) => r.method === "agent.send_keys");
    expect(sends).toHaveLength(1);
    expect(said(transport)).toContain("No response yet");
  });

  it("opens a reply modal and submits one remote turn", async () => {
    fake.on("pane.read", () => ({ read: { text: "output" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.reply,
      value: ref(),
      triggerId: "reply-trigger",
    });
    expect(transport.modals.at(-1)?.view.callback_id).toBe("modal_session_reply");

    await transport.emitViewSubmit({
      ctx: ctx({ channel: "", surface: "modal" }),
      callbackId: "modal_session_reply",
      privateMetadata: ref(),
      view: {
        values: { b_reply: { a_reply: { value: "keep going" } } },
      },
    });

    const sent = fake.requests.filter((r) => r.method === "agent.prompt").at(-1);
    expect(sent?.params).toMatchObject({ target: "w1:pA", text: "keep going" });
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(1);
  });

  it("keeps the reply modal open when the prompt never reaches the agent", async () => {
    fake.on("pane.read", () => ({ read: { text: "before" } }));
    fake.on("agent.prompt", () => new Error("agent rejected prompt"));
    registry.setThread("term_1", "D1", "card-ts");
    const result = await transport.emitViewSubmit({
      ctx: ctx({ channel: "", surface: "modal" }),
      callbackId: "modal_session_reply",
      privateMetadata: ref(),
      view: { values: { b_reply: { a_reply: { value: "try this" } } } },
    });
    // Reported in the modal the user is still looking at, not as a closed
    // modal plus a card claiming a reply was sent.
    expect(result?.errors.b_reply).toBeTruthy();
    expect(registry.activeTurn("term_1")).toBeUndefined();
    expect(registry.turns("term_1")).toHaveLength(0);
  });

  it("closes the reply modal only after the agent has the prompt", async () => {
    fake.on("pane.read", () => ({ read: { text: "before" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    registry.setThread("term_1", "D1", "card-ts");
    const result = await transport.emitViewSubmit({
      ctx: ctx({ channel: "", surface: "modal" }),
      callbackId: "modal_session_reply",
      privateMetadata: ref(),
      view: { values: { b_reply: { a_reply: { value: "go on" } } } },
    });
    expect(result).toBeUndefined();
    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(true);
    expect(registry.activeTurn("term_1")?.prompt).toBe("go on");
  });

  it("refuses a second reply while the first is still working", async () => {
    fake.on("pane.read", () => ({ read: { text: "before" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    registry.setThread("term_1", "D1", "card-ts");
    const submit = (text: string) =>
      transport.emitViewSubmit({
        ctx: ctx({ channel: "", surface: "modal" }),
        callbackId: "modal_session_reply",
        privateMetadata: ref(),
        view: { values: { b_reply: { a_reply: { value: text } } } },
      });

    await submit("first");
    const second = await submit("second");
    expect(second?.errors.b_reply).toContain("still working");
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(1);
  });

  it("refreshes the existing card without posting another message", async () => {
    fake.on("pane.read", () => ({ read: { text: "fresh response" } }));
    registry.setThread("term_1", "D1", "card-ts");
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.refresh,
      value: ref(),
      triggerId: "refresh",
    });
    expect(transport.posted).toHaveLength(0);
    expect(JSON.stringify(transport.updated)).toContain("fresh response");
  });

  it("opens the newest recorded response and steps back one per page", async () => {
    for (let index = 0; index < 7; index += 1) {
      const turn = registry.startTurn("term_1", `prompt ${index}`, "");
      if (turn) {
        registry.updateTurn("term_1", turn.id, {
          status: "done",
          response: `response ${index}`,
        });
      }
    }
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.history,
      value: ref(),
      triggerId: "history",
    });
    // response 6 is on the card; "Earlier" opens on the one before it.
    const opened = JSON.stringify(transport.modals.at(-1)?.view);
    expect(opened).toContain("response 5");
    expect(opened).not.toContain("response 6");

    await transport.emitAction({
      ctx: ctx(),
      actionId: `${SESSION_ACTIONS.historyPage}_1`,
      value: ref(),
      triggerId: "",
      viewId: "V1",
    });
    expect(transport.modalUpdates.at(-1)?.viewId).toBe("V1");
    const paged = JSON.stringify(transport.modalUpdates.at(-1)?.view);
    expect(paged).toContain("response 4");
    expect(paged).toContain("*#5* of 6");
  });

  it("ignores malformed history pagination and reply submissions", async () => {
    await transport.emitAction({
      ctx: ctx(),
      actionId: `${SESSION_ACTIONS.historyPage}_-1`,
      value: ref(),
      triggerId: "",
    });
    expect(transport.modalUpdates).toHaveLength(0);

    await transport.emitViewSubmit({
      ctx: ctx({ channel: "", surface: "modal" }),
      callbackId: "modal_session_reply",
      privateMetadata: "forged",
      view: { values: {} },
    });
    expect(fake.requests.some((request) => request.method === "agent.prompt")).toBe(false);
    expect(logs.join()).toContain("reply modal rejected");
  });

  it("keeps the card live when closing the pane fails", async () => {
    fake.on("pane.close", () => new Error("pane is busy"));
    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.end,
      value: ref(),
      triggerId: "end",
    });
    expect(registry.get("term_1")?.ended).toBe(false);
    expect(said(transport)).toContain("session has ended");
  });

  it("does not treat card-thread messages as prompts", async () => {
    fake.on("agent.prompt", () => ({ ok: true }));
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_open_session",
      value: ref(),
      triggerId: "t1",
    });
    const threadTs = registry.get("term_1")?.slackThreadTs ?? "";

    await transport.emitMessage({ ctx: ctx({ threadTs, ts: "100.001" }), text: "keep going" });

    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
    expect(transport.ephemerals).toHaveLength(0);
  });

  it("refuses session controls when herdr disconnects", async () => {
    await transport.emitAction({
      ctx: ctx(),
      actionId: "home_open_session",
      value: ref(),
      triggerId: "t-open",
    });

    await fake.stop();
    await new Promise<void>((resolve, reject) => {
      if (tail.status !== "connected") {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("tail stayed connected")), 3_000);
      tail.on("status", ({ status }) => {
        if (status !== "connected") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await transport.emitAction({
      ctx: ctx(),
      actionId: SESSION_ACTIONS.refresh,
      value: ref(),
      triggerId: "t-refresh",
    });
    expect(said(transport)).toMatch(/not reachable/i);
    expect(logs.join()).toContain("herdr_offline");
  });

  it("dedupes bare Slack deliveries by message timestamp", async () => {
    const message = { ctx: ctx({ ts: "100.001" }), text: "Show my herd" };
    await transport.emitMessage(message);
    const before = transport.ephemerals.length;
    await transport.emitMessage(message);
    expect(transport.ephemerals).toHaveLength(before);
  });

  it("ignores a reply in an unknown thread", async () => {
    await transport.emitMessage({
      ctx: ctx({ threadTs: "unknown", ts: "100.002" }),
      text: "hello",
    });
    expect(transport.ephemerals).toHaveLength(0);
  });

  it("never guesses a target for a bare DM", async () => {
    fake.on("agent.prompt", () => ({ ok: true }));

    await transport.emitMessage({ ctx: ctx(), text: "do the thing" });

    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
    expect(said(transport)).toContain("session card");
  });

  it("treats `blocked` in a bare DM as a command", async () => {
    await transport.emitMessage({ ctx: ctx(), text: "blocked" });
    expect(transport.homes.length).toBeGreaterThan(0);
  });

  it("ignores a thread it does not recognise", async () => {
    fake.on("agent.prompt", () => ({ ok: true }));

    await transport.emitMessage({ ctx: ctx({ threadTs: "999.999" }), text: "hello" });

    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
    expect(transport.ephemerals).toHaveLength(0);
  });

  it("ignores a message from someone not on the allowlist", async () => {
    fake.on("agent.prompt", () => ({ ok: true }));

    await transport.emitMessage({ ctx: ctx({ userId: "U_OTHER" }), text: "hello" });

    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
    expect(logs.join()).toContain("not_allowed");
  });
});
