import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../../src/herdr/client.js";
import { EventTail } from "../../src/herdr/events.js";
import { SessionState } from "../../src/herdr/state.js";
import type { StatusTransition } from "../../src/herdr/state.js";
import { pane, snapshot } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await settle(10);
  }
  throw new Error("condition not met before timeout");
}

describe("EventTail", () => {
  let fake: FakeHerdr;
  let state: SessionState;
  let tail: EventTail;

  beforeEach(async () => {
    fake = await FakeHerdr.start();
    state = new SessionState();
    tail = new EventTail(new HerdrClient(fake.socketPath, 1_000), state);
  });

  afterEach(async () => {
    tail.stop();
    state.dispose();
    await fake.stop();
  });

  it("subscribes on connect", async () => {
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);

    const sub = fake.requests.find((r) => r.method === "events.subscribe");
    expect(sub).toBeDefined();
    const subscriptions = sub?.params.subscriptions as { type: string }[];
    // pane.moved is load-bearing — it is the only event carrying previous_pane_id.
    expect(subscriptions.map((s) => s.type)).toContain("pane.moved");
    expect(subscriptions.map((s) => s.type)).toContain("pane.updated");
  });

  it("does not announce agents that were already running when it connected", async () => {
    // Verified against live herdr 0.8.0: subscription_started arrives BEFORE the
    // replay of existing entities. Priming therefore comes from an explicit
    // snapshot, so it cannot depend on frame ordering — this test pins that.
    const existing = pane({ terminal_id: "term_existing", agent_status: "blocked" });
    fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes: [existing] }) }));

    const seen: StatusTransition[] = [];
    state.on("transition", (t) => seen.push(t));
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);

    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    // Replay frames arrive after the ack, for panes the snapshot already covers.
    fake.emitEvent({ type: "pane_created", pane: existing });
    await settle(50);

    expect(seen).toEqual([]);
    expect(state.agentPanes()).toHaveLength(1);
  });

  it("announces a genuinely new transition after priming", async () => {
    const p = pane({ terminal_id: "term_live", agent_status: "working" });
    fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes: [p] }) }));
    const seen: StatusTransition[] = [];
    state.on("transition", (t) => seen.push(t));

    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    // Same pane, same status — nothing to announce.
    fake.emitEvent({ type: "pane_updated", pane: { ...p, revision: 2 } });
    // A brand-new agent, though, is a real event worth announcing.
    fake.emitEvent({ type: "pane_created", pane: pane({ terminal_id: "term_new" }) });
    await waitFor(() => seen.length > 0);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ terminalId: "term_new", from: undefined, to: "working" });
  });

  it("projects a Pi session path event and repairs it from a reconnect snapshot", async () => {
    const old = pane({
      terminal_id: "term_pi",
      agent: "pi",
      agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/local/old.jsonl" },
    });
    let current = old;
    fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes: [current] }) }));
    tail.start();
    await waitFor(() => fake.subscriberCount >= 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);
    fake.emitEvent({
      type: "pane_updated",
      pane: {
        ...old,
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/local/new.jsonl" },
      },
    });
    await waitFor(
      () => state.paneByTerminal("term_pi")?.agent_session?.value === "/local/new.jsonl",
    );
    current = {
      ...old,
      agent_session: {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: "/local/reconnected.jsonl",
      },
    };
    fake.dropConnections();
    await waitFor(() => tail.status === "waiting");
    await waitFor(() => tail.status === "connected", 5_000);
    fake.emitSubscriptionStarted();
    await waitFor(
      () => state.paneByTerminal("term_pi")?.agent_session?.value === "/local/reconnected.jsonl",
    );
  });

  it("survives a malformed frame and keeps processing", async () => {
    fake.on("session.snapshot", () => ({ snapshot: snapshot() }));
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    fake.emitRaw("{ this is not json");
    fake.emitEvent({ type: "pane_created", pane: pane({ terminal_id: "term_after" }) });
    await waitFor(() => state.paneByTerminal("term_after") !== undefined);

    expect(state.paneByTerminal("term_after")).toBeDefined();
  });

  it("survives an event whose shape SessionState rejects and keeps processing", async () => {
    // Valid JSON, wrong payload shape — seen live from herdr as a
    // tab_created with no `tab` field, which crashed the daemon before this
    // was caught (2026-08-19). Uses pane_moved with no `pane` here since
    // tab_created is now separately guarded in SessionState itself; this
    // exercises the catch-all for whatever the next unguarded shape is.
    fake.on("session.snapshot", () => ({ snapshot: snapshot() }));
    const applyErrors: string[] = [];
    tail.on("applyError", ({ message }) => applyErrors.push(message));
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    fake.emitEvent({ type: "pane_moved", previous_pane_id: "w1:p1" });
    fake.emitEvent({ type: "pane_created", pane: pane({ terminal_id: "term_after" }) });
    await waitFor(() => state.paneByTerminal("term_after") !== undefined);

    expect(state.paneByTerminal("term_after")).toBeDefined();
    expect(applyErrors).toHaveLength(1);
  });

  it("reconnects after herdr drops the connection", async () => {
    fake.on("session.snapshot", () => ({ snapshot: snapshot() }));
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    fake.dropConnections();
    await waitFor(() => tail.status === "waiting");
    await waitFor(() => fake.subscriberCount === 1, 5_000);

    expect(tail.status).toBe("connected");
  });

  it("does not replay working→idle when reconnecting to already-idle agents", async () => {
    const settled = pane({ terminal_id: "term_settled", agent_status: "idle" });
    fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes: [settled] }) }));
    const seen: StatusTransition[] = [];
    state.on("transition", (t) => seen.push(t));

    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    // Stale committed status: herdr briefly looked working before the socket dropped.
    fake.emitEvent({
      type: "pane_updated",
      pane: { ...settled, agent_status: "working", revision: 2 },
    });
    await waitFor(() => state.statusOf("term_settled") === "working");

    seen.length = 0;
    fake.dropConnections();
    await waitFor(() => tail.status === "waiting");
    await waitFor(() => fake.subscriberCount === 1, 5_000);
    fake.emitSubscriptionStarted();
    await waitFor(() => state.primed);

    expect(seen).toEqual([]);
  });

  it("waits rather than dying when herdr is not running at all", async () => {
    const orphan = new EventTail(new HerdrClient("/tmp/no-such-herdr.sock", 300), state);
    const statuses: string[] = [];
    orphan.on("status", (s) => statuses.push(s.status));
    orphan.start();
    await waitFor(() => statuses.includes("waiting"), 3_000);
    orphan.stop();

    // The daemon outlives herdr (ADR 0002) — this must never be fatal.
    expect(statuses).toContain("waiting");
  });

  it("reconciles from a full snapshot", async () => {
    fake.on("session.snapshot", () => ({
      snapshot: snapshot({ panes: [pane({ terminal_id: "term_snap" })] }),
    }));
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);

    await expect(tail.reconcile()).resolves.toBe(true);
    expect(state.paneByTerminal("term_snap")).toBeDefined();
  });

  describe("per-pane agent status", () => {
    // Verified live (herdr 0.9.3, T0): a cre/pi turn's working → done reaches
    // only the per-pane `pane.agent_status_changed` subscription; the global
    // pane.updated stream stayed idle, so turns settled only on the 30s reconcile.
    const statusEvent = (paneId: string, agent_status: string) =>
      JSON.stringify({
        event: "pane.agent_status_changed",
        data: { agent: "pi", agent_status, pane_id: paneId, workspace_id: "w1" },
      });
    const paneSubscriptions = () =>
      fake.requests
        .filter((r) => r.method === "events.subscribe")
        .flatMap((r) => r.params.subscriptions as { type: string; pane_id?: string }[])
        .filter((s) => s.type === "pane.agent_status_changed");

    const primeWith = async (panes: ReturnType<typeof pane>[]) => {
      state.dispose();
      state = new SessionState({ done: 0, idle: 0 });
      tail = new EventTail(new HerdrClient(fake.socketPath, 1_000), state);
      fake.on("session.snapshot", () => ({ snapshot: snapshot({ panes }) }));
      tail.start();
      await waitFor(() => fake.subscriberCount === 1);
      fake.emitSubscriptionStarted();
      await waitFor(() => state.primed);
      await settle(100);
    };

    it("subscribes each agent pane on its own connection, and no plain shell", async () => {
      await primeWith([
        pane({ terminal_id: "term_cre", pane_id: "w1:pA", agent: "pi", agent_status: "idle" }),
        pane({ terminal_id: "term_sh", pane_id: "w1:pB", agent: null, agent_status: "unknown" }),
      ]);

      expect(paneSubscriptions()).toEqual([
        { type: "pane.agent_status_changed", pane_id: "w1:pA" },
      ]);
      expect(fake.subscriberCount).toBe(2);
    });

    it("settles a turn from per-pane events without waiting for a reconcile", async () => {
      await primeWith([
        pane({ terminal_id: "term_cre", pane_id: "w1:pA", agent: "pi", agent_status: "idle" }),
      ]);
      const seen: StatusTransition[] = [];
      state.on("transition", (t) => seen.push(t));
      const snapshots = fake.requests.filter((r) => r.method === "session.snapshot").length;

      fake.emitRaw(statusEvent("w1:pA", "working"));
      await settle(50);
      fake.emitRaw(statusEvent("w1:pA", "done"));
      await settle(50);

      expect(seen.map((t) => [t.terminalId, t.to])).toEqual([
        ["term_cre", "working"],
        ["term_cre", "done"],
      ]);
      expect(fake.requests.filter((r) => r.method === "session.snapshot")).toHaveLength(snapshots);
    });

    it("ignores per-pane events for an unknown pane or an unknown status", async () => {
      await primeWith([
        pane({ terminal_id: "term_cre", pane_id: "w1:pA", agent: "pi", agent_status: "idle" }),
      ]);
      const seen: StatusTransition[] = [];
      state.on("transition", (t) => seen.push(t));

      fake.emitRaw(statusEvent("w1:pZ", "working"));
      fake.emitRaw(statusEvent("w1:pA", "exploded"));
      await settle(50);

      expect(seen).toEqual([]);
      expect(state.statusOf("term_cre")).toBe("idle");
    });

    it("drops the subscription when the agent pane goes away", async () => {
      await primeWith([
        pane({ terminal_id: "term_cre", pane_id: "w1:pA", agent: "pi", agent_status: "idle" }),
      ]);
      expect(fake.subscriberCount).toBe(2);

      fake.emitEvent({ type: "pane_closed", pane_id: "w1:pA", workspace_id: "w1" });
      await settle(100);

      expect(fake.subscriberCount).toBe(1);
    });
  });

  it("reports a failed reconcile instead of throwing", async () => {
    tail.start();
    await waitFor(() => fake.subscriberCount === 1);
    // No session.snapshot handler registered → herdr answers unknown_method.
    await expect(tail.reconcile()).resolves.toBe(false);
  });
});
