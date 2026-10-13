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
import { ACTION_IDS, BLOCK_IDS, MODAL_IDS } from "../../src/slack/modals.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

/** Everything the bot said, whether posted or shown only to the user. */
const said = (transport: FakeTransport): string =>
  [...transport.posted.map((p) => p.text), ...transport.ephemerals.map((e) => e.text)].join("\n");

const ctx = (overrides = {}) => ({ teamId: "T1", userId: "U1", channel: "D1", ...overrides });

const submission = (values: Record<string, unknown>) => ({
  values: {
    [BLOCK_IDS.kind]: { [ACTION_IDS.kind]: { selected_option: { value: "claude" } } },
    [BLOCK_IDS.mode]: { [ACTION_IDS.mode]: { selected_option: { value: "plan" } } },
    ...values,
  },
});

describe("Surfaces commands and launching", () => {
  let dir: string;
  let fake: FakeHerdr;
  let transport: FakeTransport;
  let state: SessionState;
  let surfaces: Surfaces;
  let tail: EventTail;
  let logs: string[];

  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-cmd-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = path.join(dir, "cfg");
    logs = [];
    fake = await FakeHerdr.start();
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    tail = new EventTail(new HerdrClient(fake.socketPath, 500), state);
    tail.start();
    await settle();

    surfaces = new Surfaces({
      config: defaultInstance({
        label: "personal",
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
      registry: new SessionRegistry("default"),
      client: new HerdrClient(fake.socketPath, 1_000),
      budget: new RateBudget({ totalPerMin: 200 }),
      ackTimeoutMs: 20,
      log: (line) => logs.push(line),
    });
    surfaces.start();
  });

  afterEach(async () => {
    surfaces.stop();
    tail.stop();
    state.dispose();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  });

  describe("New agent button", () => {
    const openModal = (overrides = {}) =>
      transport.emitAction({
        ctx: ctx(overrides),
        actionId: "home_new_agent",
        value: "new",
        triggerId: "trig1",
      });

    it("opens a skeleton before calling herdr, then fills it in", async () => {
      // trigger_id expires in ~3s; fetching first would routinely miss it.
      fake.on("workspace.list", () => ({ workspaces: [workspace()] }));
      fake.on("worktree.list", () => ({ worktrees: [] }));

      await openModal();

      expect(transport.modals).toHaveLength(1);
      expect(JSON.stringify(transport.modals[0]?.view)).toContain("Loading");
      expect(transport.modalUpdates).toHaveLength(1);
      expect(JSON.stringify(transport.modalUpdates[0]?.view)).toContain(BLOCK_IDS.kind);
    });

    it("still opens the modal when herdr cannot list workspaces", async () => {
      // No handlers registered → unknown_method. The form should degrade, not
      // leave the user with a spinner.
      await openModal();
      expect(transport.modalUpdates).toHaveLength(1);
    });

    it("ignores the button from someone not on the allowlist", async () => {
      await openModal({ userId: "U_OTHER" });
      expect(transport.modals).toEqual([]);
      expect(logs.join()).toContain("not_allowed");
    });
  });

  describe("launching from the modal", () => {
    const wireLaunch = () => {
      fake.on("tab.create", () => ({
        tab: { tab_id: "w1:t9" },
        root_pane: { pane_id: "w1:p9" },
      }));
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("agent.start", () => ({ ok: true }));
      // herdr has to report the agent registered before the first prompt is
      // sent; without this the launcher waits out its readiness window.
      fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
      fake.on("agent.prompt", () => ({ ok: true }));
    };

    it("creates the tab, starts the agent, and sends the first prompt", async () => {
      wireLaunch();

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({
          [BLOCK_IDS.directoryOther]: { [ACTION_IDS.directoryOther]: { value: "/work/app" } },
          [BLOCK_IDS.prompt]: { [ACTION_IDS.prompt]: { value: "start here" } },
        }),
      });

      expect(fake.requests.find((r) => r.method === "tab.create")?.params).toMatchObject({
        cwd: "/work/app",
        focus: false,
      });
      expect(fake.requests.find((r) => r.method === "agent.start")?.params).toMatchObject({
        kind: "claude",
        args: ["--permission-mode", "acceptEdits"],
      });
      expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
        text: "start here",
      });
    });

    it("launches cre by typing its catalog command instead of agent.start", async () => {
      wireLaunch();
      fake.on("pane.send_text", () => ({ ok: true }));
      fake.on("agent.rename", () => ({ agent: { name: "cre" } }));

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({
          [BLOCK_IDS.kind]: { [ACTION_IDS.kind]: { selected_option: { value: "cre" } } },
        }),
      });

      expect(fake.requests.find((r) => r.method === "pane.send_text")?.params).toMatchObject({
        text: "cre\n",
      });
      expect(fake.requests.some((r) => r.method === "agent.start")).toBe(false);
    });

    it("reports a launch failure in words", async () => {
      fake.on("tab.create", () => new Error("no such workspace"));

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({}),
      });

      const words = said(transport);
      expect(words).toContain("Could not start claude");
      expect(words).not.toContain("Error:");
    });

    it("always launches in auto mode, whatever the form said", async () => {
      // Nobody is at the terminal to answer a permission prompt when the
      // launch came from a phone, so an agent that stops to ask has stalled
      // until someone opens the thread.
      wireLaunch();

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({}),
      });

      expect(fake.requests.find((r) => r.method === "agent.start")?.params).toMatchObject({
        kind: "claude",
        args: ["--permission-mode", "acceptEdits"],
      });
    });

    it("remembers the choices for the next form", async () => {
      wireLaunch();

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({
          [BLOCK_IDS.directoryOther]: { [ACTION_IDS.directoryOther]: { value: "/work/app" } },
        }),
      });

      const { readLastLaunch } = await import("../../src/agents/last-launch.js");
      expect(readLastLaunch("default")).toMatchObject({ kind: "claude", cwd: "/work/app" });
    });

    it("ignores a submission from someone not on the allowlist", async () => {
      wireLaunch();

      await transport.emitViewSubmit({
        ctx: ctx({ userId: "U_OTHER" }),
        callbackId: MODAL_IDS.newAgent,
        view: submission({}),
      });

      expect(fake.requests.some((r) => r.method === "tab.create")).toBe(false);
    });

    it("ignores a submission for a different modal", async () => {
      wireLaunch();
      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: "some_other_modal",
        view: submission({}),
      });
      expect(fake.requests.some((r) => r.method === "tab.create")).toBe(false);
    });

    it("derives an agent name herdr will accept from the tab label", async () => {
      wireLaunch();

      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: MODAL_IDS.newAgent,
        privateMetadata: '{"herdId":"default"}',
        view: submission({
          [BLOCK_IDS.label]: { [ACTION_IDS.label]: { value: "Fix Auth Redirect!" } },
        }),
      });

      const name = (
        fake.requests.find((r) => r.method === "agent.start")?.params as { name: string }
      ).name;
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    });
  });
});
