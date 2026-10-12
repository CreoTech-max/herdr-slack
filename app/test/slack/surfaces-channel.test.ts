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
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const native = { agent: "pi", kind: "session", source: "pi", value: "native-cre" };

function mentionContext(ts: string, overrides: Record<string, string> = {}) {
  return {
    teamId: "T1",
    userId: "U1",
    channel: "C111",
    ts,
    surface: "mention" as const,
    ...overrides,
  };
}

describe("bound channel CRE control", () => {
  let dir: string;
  let fake: FakeHerdr;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let tail: EventTail;
  let surfaces: Surfaces;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-bound-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    fake = await FakeHerdr.start();
    fake.on("pane.read", () => ({ read: { text: "previous answer" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    tail = new EventTail(new HerdrClient(fake.socketPath, 500), state);
    tail.start();
    await pause(40);
    surfaces = new Surfaces({
      config: defaultInstance({
        slack: {
          botToken: "xoxb-EXAMPLE-test",
          appToken: "xapp-EXAMPLE-test",
          teamId: "T1",
          appId: "A1",
          botUserId: "UBOT",
        },
        allowedUsers: ["U1"],
        channelBindings: { C111: "w1" },
        creOnly: true,
        creRoots: [{ workspaceId: "w1", terminalId: "term-cre", sessionId: "native-cre" }],
      }),
      instance: "default",
      transport,
      state,
      tail,
      registry,
      client: new HerdrClient(fake.socketPath, 500),
      budget: new RateBudget({ totalPerMin: 500 }),
      log: () => undefined,
    });
    surfaces.start();
    state.apply({ type: "workspace_created", workspace: workspace() });
    state.apply({
      type: "pane_created",
      pane: pane({ terminal_id: "term-cre", agent: "pi", agent_session: native }),
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

  it("ignores untrusted mentions and reports only verified agents in the bound workspace", async () => {
    const send = (ts: string, text: string, overrides: Record<string, string> = {}) =>
      transport.emitMention({ ctx: mentionContext(ts, overrides), text });
    await send("1", "<@UBOT> status", { userId: "U2" });
    await send("2", "<@UBOT> status", { channel: "C999" });
    await send("3", "status");
    expect(transport.posted).toHaveLength(0);

    await send("4", "<@UBOT> status");
    expect(transport.posted.at(-1)?.text).toContain("1 agents in workspace w1");
    await send("5", "<@UBOT> blocked");
    expect(transport.posted.at(-1)?.text).toContain("0 agents in workspace w1");
    await send("6", "<@UBOT> agents");
    expect(transport.posted.at(-1)?.text).toContain("pi: working");
    await send("7", "<@UBOT> help");
    expect(transport.posted.at(-1)?.text).toContain("@herdr status");
    await send("8", "<@UBOT> start pi | do it");
    expect(transport.posted.at(-1)?.text).toContain("CRE-only attach mode");
    expect(fake.requests.some((request) => request.method === "agent.start")).toBe(false);
    await send("8", "<@UBOT> status");
    expect(transport.posted).toHaveLength(5);
  });

  it("refuses unknown or unverified threads and never closes a CRE root from Slack", async () => {
    const send = (ts: string, text: string, threadTs: string) =>
      transport.emitMention({ ctx: { ...mentionContext(ts), threadTs }, text });
    await send("1", "<@UBOT> do it", "missing");
    expect(transport.posted.at(-1)?.text).toContain("Unknown or unverified");
    registry.setThread("term-cre", "C111", "card");
    await send("2", "<@UBOT> stop", "card");
    expect(transport.posted.at(-1)?.text).toContain("End shared CRE roots directly");
    await send("3", "<@UBOT> do it", "card");
    expect(fake.requests.some((request) => request.method === "agent.prompt")).toBe(true);
    expect(registry.turns("term-cre").at(-1)?.prompt).toBe("do it");
    await send("4", "<@UBOT> another", "card");
    expect(transport.posted.at(-1)?.text).toContain("still working");
  });

  it("attaches a card only to an exact pinned CRE session and retires it after identity changes", async () => {
    await pause(5_100);
    expect(registry.get("term-cre")?.slackChannel).toBe("C111");
    expect(transport.posted.some((post) => post.channel === "C111")).toBe(true);
    state.apply({
      type: "pane_updated",
      pane: pane({
        terminal_id: "term-cre",
        agent: "pi",
        agent_session: { ...native, value: "replaced" },
        revision: 2,
      }),
    });
    await pause(5_100);
    expect(
      transport.updated.some(
        (post) => post.text === "CRE session identity changed. Thread detached.",
      ),
    ).toBe(true);
    expect(registry.get("term-cre")?.slackThreadTs).toBeUndefined();
    expect(transport.posted.filter((post) => post.channel === "C111")).toHaveLength(1);
  }, 12_000);
});
