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
import type { HerdPort } from "../../src/slack/herd-port.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerd } from "../helpers/fake-herd.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const config = (overrides = {}) =>
  defaultInstance({
    label: "personal",
    slack: { botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", appId: "A1", botUserId: "UBOT" },
    allowedUsers: ["U1"],
    ...overrides,
  });

const ctx = (overrides = {}) => ({ teamId: "T1", userId: "U1", channel: "D1", ...overrides });

describe("Surfaces", () => {
  let dir: string;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let surfaces: Surfaces;
  let logs: string[];
  let fakeHerdr: FakeHerdr;
  let tail: EventTail;

  const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

  const build = async (cfg = config(), herd?: HerdPort) => {
    logs = [];
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    // A real socket so the tail reaches "connected" — Home deliberately hides
    // the agent list while herdr is unreachable, so a disconnected tail would
    // render the empty state instead.
    fakeHerdr = await FakeHerdr.start();
    tail = new EventTail(new HerdrClient(fakeHerdr.socketPath, 500), state);
    tail.start();
    await settle();
    surfaces = new Surfaces({
      config: cfg,
      instance: "default",
      transport,
      state,
      tail,
      registry,
      client: new HerdrClient(fakeHerdr.socketPath, 500),
      budget: new RateBudget({ totalPerMin: 100 }),
      log: (line) => logs.push(line),
      ...(herd ? { herd } : {}),
    });
    surfaces.start();
    return surfaces;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-surf-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });

  afterEach(async () => {
    surfaces?.stop();
    tail?.stop();
    state?.dispose();
    await fakeHerdr?.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HERDR_PLUGIN_STATE_DIR;
  });

  describe("app home", () => {
    it("publishes for an allowlisted user", async () => {
      await build();
      await transport.emitHomeOpened(ctx());
      expect(transport.homes).toHaveLength(1);
      expect(transport.homes[0]?.userId).toBe("U1");
    });

    it("publishes nothing for a user who is not allowlisted", async () => {
      await build();
      await transport.emitHomeOpened(ctx({ userId: "U_INTRUDER" }));
      expect(transport.homes).toEqual([]);
      expect(logs.join()).toContain("not_allowed");
    });

    it("publishes nothing for another workspace", async () => {
      await build();
      await transport.emitHomeOpened(ctx({ teamId: "T_EVIL" }));
      expect(transport.homes).toEqual([]);
      expect(logs.join()).toContain("wrong_team");
    });

    it("renders live agents with their workspace label", async () => {
      await build();
      state.apply({ type: "workspace_created", workspace: workspace({ label: "posi" }) });
      state.apply({ type: "pane_created", pane: pane({ terminal_title_stripped: "fix auth" }) });
      surfaces.reconcileSessions();

      await transport.emitHomeOpened(ctx());
      const rendered = transport.lastHomeText();
      expect(rendered).toContain("posi");
      expect(rendered).toContain("fix auth");
    });

    it("never puts a terminal or pane id in a button", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_secret" }) });
      surfaces.reconcileSessions();
      await transport.emitHomeOpened(ctx());

      const rendered = transport.lastHomeText();
      expect(rendered).not.toContain("term_secret");
      expect(rendered).not.toContain("w1:p");
    });

    it("survives Slack failing mid-publish", async () => {
      await build();
      transport.failNext = true;
      await transport.emitHomeOpened(ctx());
      expect(logs.join()).toContain("home publish failed");
    });

    it("stops publishing once the write budget is spent", async () => {
      logs = [];
      transport = new FakeTransport();
      state = new SessionState();
      registry = new SessionRegistry("default");
      const tail = new EventTail(new HerdrClient("/tmp/nope.sock", 100), state);
      surfaces = new Surfaces({
        config: config(),
        instance: "default",
        transport,
        state,
        tail,
        registry,
        client: new HerdrClient("/tmp/nope.sock", 100),
        // Just enough for the control reserve; the next call must be refused.
        budget: new RateBudget({ totalPerMin: 6 }),
        log: (line) => logs.push(line),
      });
      surfaces.start();

      for (let i = 0; i < 8; i += 1) await transport.emitHomeOpened(ctx());
      expect(transport.homes.length).toBeLessThanOrEqual(6);
      expect(logs.join()).toContain("rate budget exhausted");
    });
  });

  describe("many herds on one Slack app", () => {
    const modalJson = () => JSON.stringify(transport.modalUpdates.at(-1)?.view ?? {});

    it("drills into a herd and shows only its agents", async () => {
      const herd = FakeHerd.withPeer();
      await build(config(), herd);
      state.apply({ type: "workspace_created", workspace: workspace({ label: "posi" }) });
      state.apply({ type: "pane_created", pane: pane({ terminal_title_stripped: "my task" }) });
      surfaces.reconcileSessions();

      await transport.emitHomeOpened(ctx());
      // The overview lists both, and neither one's agents.
      expect(transport.lastHomeText()).toContain("🐑 Herds · 2");

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_select_herd",
        value: "host:them:default",
        triggerId: "t1",
      });
      const rendered = transport.lastHomeText();
      expect(rendered).toContain("peer task");
      expect(rendered).not.toContain("my task");
    });

    it("remembers the drill-down per person, and lets them back out", async () => {
      await build(config(), FakeHerd.withPeer());
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_select_herd",
        value: "host:them:default",
        triggerId: "t1",
      });
      // Someone else opening Home is still on the overview.
      await transport.emitHomeOpened(ctx({ userId: "U1" }));
      expect(transport.lastHomeText()).toContain("🐑 Herd · personal");

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_select_herd",
        value: "__all__",
        triggerId: "t2",
      });
      expect(transport.lastHomeText()).toContain("🐑 Herds · 2");
    });

    /** Drilling in is what names the herd; the form never asks. */
    const openFormOn = async (herdId: string): Promise<void> => {
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_select_herd",
        value: herdId,
        triggerId: "t1",
      });
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_new_agent",
        value: "new",
        triggerId: "t2",
      });
    };

    it("builds the form from the herd whose view it was opened in", async () => {
      await build(config(), FakeHerd.withPeer());
      await openFormOn("host:them:default");
      // These belong to the peer, and could not have come from our own socket.
      expect(modalJson()).toContain("their workspace");
      expect(modalJson()).toContain("their-tree");
    });

    it("carries that herd to submission without asking for it", async () => {
      await build(config(), FakeHerd.withPeer());
      await openFormOn("host:them:default");
      const view = transport.modalUpdates.at(-1)?.view ?? {};
      const ids = ((view.blocks ?? []) as { block_id: string }[]).map((b) => b.block_id);
      expect(ids).not.toContain("b_herd");
      expect(view.private_metadata).toBe(JSON.stringify({ herdId: "host:them:default" }));
    });

    it("refuses from the overview, where no herd is implied", async () => {
      // Nothing to infer with several herds in view, and guessing would offer
      // one machine's workspaces as if they were the only ones.
      await build(config(), FakeHerd.withPeer());
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_new_agent",
        value: "new",
        triggerId: "t1",
      });
      expect(transport.modals).toEqual([]);
      expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
    });

    /**
     * A failed views.update is invisible in Slack: the modal keeps showing the
     * skeleton's "Loading…" and the only way out is closing it.
     */
    describe("when Slack refuses to update the view", () => {
      it("tries again, since the same view often lands on a second attempt", async () => {
        await build(config(), FakeHerd.withPeer());
        transport.failModalUpdates = 1;
        await openFormOn("host:them:default");
        expect(modalJson()).toContain("their workspace");
      });

      it("says so rather than leaving it loading forever", async () => {
        await build(config(), FakeHerd.withPeer());
        transport.failModalUpdates = 2;
        await openFormOn("host:them:default");
        expect(modalJson()).toContain("Slack would not load this form");
      });
    });

    it("does not answer a form input as if it were a session button", async () => {
      // Selects fire block_actions with no value; treating that as a ref
      // answered every pick with "I do not recognise that".
      await build(config(), FakeHerd.withPeer());
      await transport.emitAction({
        ctx: ctx(),
        actionId: "a_workspace",
        value: "",
        triggerId: "t1",
        viewId: "V1",
      });
      expect(transport.ephemerals).toEqual([]);
      expect(logs.join()).not.toContain("unknown_ref");
    });

    it("hands a launch on another herd to the daemon that owns it", async () => {
      const herd = FakeHerd.withPeer();
      await build(config(), herd);
      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: "modal_new_agent",
        privateMetadata: JSON.stringify({ herdId: "host:them:default" }),
        view: {
          values: {
            b_kind: { a_kind: { selected_option: { value: "claude" } } },
            b_prompt: { a_prompt: { value: "start on the bug" } },
          },
        },
      });
      expect(herd.forwarded).toHaveLength(1);
      const [forwarded] = herd.forwarded;
      expect(forwarded?.op).toBe("launch_agent");
      expect(forwarded?.herdId).toBe("host:them:default");
      expect(forwarded?.launch).toMatchObject({ kind: "claude", firstPrompt: "start on the bug" });
    });

    it("launches locally when the form names this herd", async () => {
      const herd = FakeHerd.withPeer();
      await build(config(), herd);
      await transport.emitViewSubmit({
        ctx: ctx(),
        callbackId: "modal_new_agent",
        privateMetadata: JSON.stringify({ herdId: "host:me:default" }),
        view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
      });
      expect(herd.forwarded).toEqual([]);
    });

    it("refuses to open the form on a herd that is asleep", async () => {
      const herd = FakeHerd.withPeer();
      herd.setUnreachable("host:them:default");
      await build(config(), herd);
      await openFormOn("host:them:default");
      expect(transport.modals).toEqual([]);
      expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
    });

    it("wires the session controller into the bridge so forwarded work can run", async () => {
      const herd = FakeHerd.withPeer();
      await build(config(), herd);
      expect(herd.attached).not.toBeNull();
    });
  });

  describe("actions", () => {
    it("refuses an action carrying a ref it never minted", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: "forged-ref",
        triggerId: "t1",
      });
      expect(logs.join()).toContain("unknown_ref");
      // Shown only to the person who clicked, not posted into the DM.
      expect(transport.ephemerals.at(-1)?.text).toContain("older message");
      expect(transport.posted).toHaveLength(0);
    });

    it("refuses an action carrying a raw pane id", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ pane_id: "w1:p1" }) });
      surfaces.reconcileSessions();

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: "w1:p1",
        triggerId: "t1",
      });
      expect(logs.join()).toContain("unknown_ref");
    });

    it("accepts an action carrying a minted ref", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_ok" }) });
      surfaces.reconcileSessions();
      const ref = registry.get("term_ok")?.ref ?? "";

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: ref,
        triggerId: "t1",
      });
      expect(logs.join()).toContain("terminal=term_ok");
    });

    it("fails closed for a ref whose terminal has ended", async () => {
      await build();
      state.apply({
        type: "pane_created",
        pane: pane({ terminal_id: "term_gone", pane_id: "w1:pX" }),
      });
      surfaces.reconcileSessions();
      const ref = registry.get("term_gone")?.ref ?? "";
      state.apply({ type: "pane_closed", pane_id: "w1:pX", workspace_id: "w1" });

      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_open_session",
        value: ref,
        triggerId: "t1",
      });
      expect(logs.join()).toContain("session_ended");
    });

    it("lets refresh through without needing a ref", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx(),
        actionId: "home_refresh",
        value: "refresh",
        triggerId: "t1",
      });
      expect(transport.homes).toHaveLength(1);
    });

    it("ignores refresh from a non-allowlisted user", async () => {
      await build();
      await transport.emitAction({
        ctx: ctx({ userId: "U_OTHER" }),
        actionId: "home_refresh",
        value: "refresh",
        triggerId: "t1",
      });
      expect(transport.homes).toEqual([]);
    });
  });

  describe("session reconciliation", () => {
    it("registers live agents and keeps their refs stable", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_1" }) });
      surfaces.reconcileSessions();
      const first = registry.get("term_1")?.ref;

      surfaces.reconcileSessions();
      expect(registry.get("term_1")?.ref).toBe(first);
    });

    it("locks an ended session card once", async () => {
      await build();
      state.apply({ type: "workspace_created", workspace: workspace() });
      state.apply({
        type: "pane_created",
        pane: pane({ terminal_id: "term_1", pane_id: "w1:pY" }),
      });
      surfaces.reconcileSessions();
      registry.setThread("term_1", "D1", "111.1");

      state.apply({ type: "pane_closed", pane_id: "w1:pY", workspace_id: "w1" });
      // paneGone ends the session immediately; the sweep is the backstop for a
      // terminal that vanished while the daemon was down. Both must not post.
      await settle();
      surfaces.reconcileSessions();
      surfaces.reconcileSessions();
      await settle();

      const ended = transport.updated.filter((p) => JSON.stringify(p.blocks).includes("read-only"));
      expect(ended).toHaveLength(1);
      expect(ended[0]?.ts).toBe("111.1");
    });

    it("skips the sweep when herdr reports no workspaces at all", async () => {
      await build();
      state.apply({ type: "pane_created", pane: pane({ terminal_id: "term_1" }) });
      surfaces.reconcileSessions();
      // No workspace_created was applied, so workspaces.size is 0 — this is what
      // a mid-restore herdr looks like, and sweeping then would be unrecoverable.
      expect(logs.join()).toContain("orphan sweep skipped");
      expect(registry.get("term_1")?.ended).toBe(false);
    });
  });
});
