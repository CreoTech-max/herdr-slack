import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPiSession } from "../../src/agents/pi-session.js";
import { type InstanceConfig, defaultInstance } from "../../src/config/config.js";
import { RateBudget } from "../../src/daemon/budget.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { EventTail } from "../../src/herdr/events.js";
import { SessionState } from "../../src/herdr/state.js";
import { SessionRegistry, registryPath } from "../../src/registry/registry.js";
import { contextFromPayload } from "../../src/slack/inbound.js";
import { Surfaces } from "../../src/slack/surfaces.js";
import { pane, workspace } from "../helpers/factories.js";
import { FakeHerd } from "../helpers/fake-herd.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";
import { FakeTransport } from "../helpers/fake-transport.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ctx = (ts: string, extra: Record<string, string> = {}) => ({
  teamId: "T1",
  userId: "U1",
  channel: "C1",
  ts,
  surface: "mention" as const,
  ...extra,
});
const requestCount = (fake: FakeHerdr, method: string) =>
  fake.requests.filter((r) => r.method === method).length;

describe("channel commands", () => {
  let dir: string;
  let fake: FakeHerdr;
  let transport: FakeTransport;
  let state: SessionState;
  let registry: SessionRegistry;
  let tail: EventTail;
  let surfaces: Surfaces;
  let config: InstanceConfig;
  let herd: FakeHerd;
  let logs: string[];
  const mention = (ts: string, text: string, extra: Record<string, string> = {}) =>
    transport.emitMention({ ctx: ctx(ts, extra), text: `<@UBOT> ${text}` });
  const message = (ts: string, text: string, extra: Record<string, string> = {}) =>
    transport.emitMessage({ ctx: { ...ctx(ts, extra), surface: "conversation" }, text });
  const action = (actionId: string, value: string, extra: Record<string, string> = {}) =>
    transport.emitAction({
      ctx: { ...ctx("click", extra), surface: "conversation" },
      actionId,
      value,
      triggerId: "trig",
    });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "channel-agent-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    fake = await FakeHerdr.start();
    fake.on("pane.read", () => ({ read: { text: "prior" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    fake.on("agent.send_keys", () => ({ ok: true }));
    fake.on("agent.rename", () => ({ ok: true }));
    transport = new FakeTransport();
    state = new SessionState();
    state.markPrimed();
    registry = new SessionRegistry("default");
    tail = new EventTail(new HerdrClient(fake.socketPath, 500), state);
    tail.start();
    await pause(40);
    config = defaultInstance({
      slack: {
        botToken: "xoxb-EXAMPLE",
        appToken: "xapp-EXAMPLE",
        teamId: "T1",
        appId: "A1",
        botUserId: "UBOT",
      },
      allowedUsers: ["U1"],
      channelBindings: { C1: "w1" },
      creOnly: false,
    });
    herd = FakeHerd.withPeer();
    logs = [];
    surfaces = new Surfaces({
      config,
      instance: "default",
      transport,
      state,
      tail,
      registry,
      client: new HerdrClient(fake.socketPath, 500),
      budget: new RateBudget({ totalPerMin: 500 }),
      herd,
      log: (line) => logs.push(line),
    });
    surfaces.start();
    state.applySnapshot({
      workspaces: [workspace(), workspace({ workspace_id: "w2" })],
      panes: [
        pane({ terminal_id: "term-build", pane_id: "w1:p1", workspace_id: "w1", agent: "claude" }),
        pane({ terminal_id: "term-other", pane_id: "w2:p2", workspace_id: "w2", agent: "claude" }),
      ],
      agents: [
        {
          terminal_id: "term-build",
          pane_id: "w1:p1",
          name: "build",
          agent: "claude",
          status: "idle",
        },
        {
          terminal_id: "term-other",
          pane_id: "w2:p2",
          name: "other",
          agent: "claude",
          status: "idle",
        },
      ],
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
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  });

  it("lists agents, explains commands and denies an unbound workspace", async () => {
    await mention("1", "agents");
    expect(transport.posted.at(-1)?.text).toContain("build");
    expect(transport.posted.at(-1)?.text).not.toContain("other");
    await mention("2", "help");
    expect(transport.posted.at(-1)?.text).toContain("@herdr bind");
    await mention("3", "agents", { channel: "C9" });
    expect(transport.ephemerals.at(-1)?.text).toContain("not bound");
  });

  it("refuses bind outside C/G/D and offers peer workspaces if the local list is empty", async () => {
    await mention("1", "bind", { channel: "X1" });
    expect(transport.ephemerals.at(-1)?.text).toContain("only in channels");
    state.workspaces.clear();
    await mention("2", "bind");
    expect(JSON.stringify(transport.ephemerals.at(-1)?.blocks)).toContain("their workspace");
  });

  it("binds and unbinds C/G and D via select under dmOnly", async () => {
    config.dmOnly = true;
    await mention("1", "bind", { channel: "C9" });
    expect(JSON.stringify(transport.ephemerals.at(-1)?.blocks)).toContain("channel_bind_select");
    await action("channel_bind_select", "w1", { channel: "C9" });
    expect(config.channelBindings?.C9).toBe("w1");
    await mention("2", "unbind", { channel: "C9" });
    expect(config.channelBindings?.C9).toBeUndefined();
    await mention("3", "bind", { channel: "D1" });
    await action("channel_bind_select", "w1", { channel: "D1" });
    expect(config.channelBindings?.D1).toBe("w1");
    expect(
      JSON.parse(
        (await import("node:fs")).readFileSync(path.join(dir, "default", "bindings.json"), "utf8"),
      ),
    ).toMatchObject({ D1: "w1" });
    await mention("4", "unbind", { channel: "D1" });
    expect(config.channelBindings?.D1).toBeUndefined();
  });

  it("rejects malformed select values and new clicks outside the bound channel", async () => {
    await action("channel_bind_select", "not-a-workspace", { channel: "C9" });
    expect(config.channelBindings?.C9).toBeUndefined();
    await action("channel_new_agent", "C9");
    await action("channel_new_agent", "C1", { channel: "C9" });
    expect(transport.modals).toHaveLength(0);
    await action("channel_new_agent", "C1", { channel: "X1" });
    expect(transport.modals).toHaveLength(0);
  });

  it("refuses a non-allowlisted bind select", async () => {
    await action("channel_bind_select", "w1", { channel: "C9", userId: "U_BAD" });
    expect(config.channelBindings?.C9).toBeUndefined();
  });

  it("does not send a malformed or unknown command to a terminal", async () => {
    await mention("1", "build");
    await mention("2", "unknown hi");
    await mention("3", "build stop and delete");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(requestCount(fake, "agent.send_keys")).toBe(0);
    expect(transport.ephemerals).toHaveLength(3);
  });

  it("does not route a peer agent command without a signed name and workspace snapshot", async () => {
    config.channelBindings = { C1: `${herd.homeHerds()[1]?.herdId}\u001fw9` };
    await mention("1", "build hi");
    await mention("2", "agents");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(herd.forwarded).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("No agent called");
    expect(transport.posted.at(-1)?.text).toContain("No agents");
  });

  it("routes satellite names, stop, clear and thread replies in the bound workspace", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9`, D1: `${peerId}\u001fw9` };
    herd.setPeerAgents(peerId, [
      {
        ref: "peer-ref",
        terminalId: "term_peer",
        agent: "claude",
        title: "peer task",
        cwd: "/them/app",
        status: "idle",
        name: "remote",
        workspaceId: "w9",
        workspaceLabel: "their workspace",
        replyPosts: [{ channel: "C1", ts: "peer-root" }],
      },
    ]);
    await mention("1", "agents");
    expect(transport.posted.at(-1)?.text).toContain("remote · claude · idle");
    await mention("2", "remote hi", { threadTs: "origin" });
    expect(herd.forwarded.at(-1)).toMatchObject({
      op: "prompt",
      ref: "peer-ref",
      text: "hi",
      channel: "C1",
      threadTs: "origin",
      expectedWorkspaceId: "w9",
    });
    await message("3", "reply", { threadTs: "peer-root" });
    expect(herd.forwarded.at(-1)).toMatchObject({
      op: "prompt",
      ref: "peer-ref",
      text: "reply",
      channel: "C1",
      threadTs: "peer-root",
      expectedWorkspaceId: "w9",
    });
    await mention("4", "remote stop");
    await mention("5", "remote clear");
    expect(herd.forwarded.slice(-2).map((row) => [row.op, row.expectedWorkspaceId])).toEqual([
      ["stop", "w9"],
      ["clear", "w9"],
    ]);
    await message("6", "remote from DM", { channel: "D1" });
    expect(herd.forwarded.at(-1)).toMatchObject({
      op: "prompt",
      ref: "peer-ref",
      channel: "D1",
      text: "from DM",
    });
    expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(0);
  });

  it("refuses offline and other-workspace satellite targets", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9` };
    herd.setPeerAgents(peerId, [
      {
        ref: "peer-ref",
        terminalId: "term_peer",
        agent: "claude",
        title: "other",
        cwd: "",
        status: "idle",
        name: "wrong",
        workspaceId: "w8",
        workspaceLabel: "other",
        replyPosts: [{ channel: "C1", ts: "root" }],
      },
    ]);
    await mention("1", "wrong hi");
    await message("2", "reply", { threadTs: "root" });
    expect(herd.forwarded).toHaveLength(0);
    herd.setPeerAgents(peerId, [
      {
        ref: "peer-ref",
        terminalId: "term_peer",
        agent: "claude",
        title: "remote",
        cwd: "",
        status: "idle",
        name: "remote",
        workspaceId: "w9",
        workspaceLabel: "their workspace",
        replyPosts: [{ channel: "C1", ts: "root" }],
      },
    ]);
    herd.setUnreachable(peerId);
    await mention("3", "remote hi");
    await message("4", "reply", { threadTs: "root" });
    expect(herd.forwarded).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("sends prompt, steers busy turn and records its latest origin", async () => {
    await mention("1", "build hello");
    const turn = registry.activeTurn("term-build");
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(turn?.origin).toEqual({ channel: "C1" });
    await mention("2", "build next", { threadTs: "root" });
    expect(requestCount(fake, "agent.prompt")).toBe(2);
    expect(registry.activeTurn("term-build")?.id).toBe(turn?.id);
    expect(registry.activeTurn("term-build")?.origin).toEqual({ channel: "C1", threadTs: "root" });
  });

  it("refuses a bound local prompt after the agent moves during baseline capture", async () => {
    fake.on("pane.read", () => {
      state.apply({
        type: "pane_moved",
        pane: pane({
          terminal_id: "term-build",
          pane_id: "w2:p3",
          workspace_id: "w2",
          agent: "claude",
        }),
        previous_pane_id: "w1:p1",
      });
      return { read: { text: "prior" } };
    });
    await mention("move", "build hello");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(registry.turns("term-build")).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not in this workspace");
  });

  it("refuses a bound local clear rename after /new moves the agent", async () => {
    fake.on("agent.prompt", () => {
      state.apply({
        type: "pane_moved",
        pane: pane({
          terminal_id: "term-build",
          pane_id: "w2:p3",
          workspace_id: "w2",
          agent: "claude",
        }),
        previous_pane_id: "w1:p1",
      });
      return { ok: true };
    });
    await mention("move-clear", "build clear");
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(1);
    expect(fake.requests.filter((r) => r.method === "agent.rename")).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not in this workspace");
  });

  it("routes a posted reply thread to the agent and ignores other threads", async () => {
    registry.addReplyPost("term-build", "C1", "reply-root");
    await message("1", "follow up", { threadTs: "reply-root" });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(registry.activeTurn("term-build")?.origin).toEqual({
      channel: "C1",
      threadTs: "reply-root",
    });
    await message("2", "unrelated", { threadTs: "unknown" });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(transport.ephemerals).toHaveLength(0);
  });

  it.each(["message-first", "mention-first"])(
    "dedupes %s with one guard hit at the throttle limit",
    async (order) => {
      for (let i = 0; i < 29; i++) await mention(String(i), "help");
      const tagged = "<@UBOT> build go";
      if (order === "message-first") {
        await message("last", tagged);
        await mention("last", "build go");
      } else {
        await mention("last", "build go");
        await message("last", tagged);
      }
      expect(requestCount(fake, "agent.prompt")).toBe(1);
      await mention("overflow", "build no");
      expect(requestCount(fake, "agent.prompt")).toBe(1);
    },
  );

  it("fails closed on user, team, workspace, unknown name, dead pane and offline herdr", async () => {
    await mention("1", "build hi", { userId: "U_BAD" });
    await mention("2", "build hi", { teamId: "T_BAD" });
    await mention("3", "build hi", { channel: "C9" });
    await mention("4", "other hi");
    await mention("5", "missing hi");
    state.apply({ type: "pane_closed", pane_id: "w1:p1" });
    await mention("6", "build hi");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(requestCount(fake, "agent.send_keys")).toBe(0);
    expect(transport.posted).toHaveLength(0);
    expect(transport.ephemerals.some((e) => e.text.includes("No agent called"))).toBe(true);
    fake.dropConnections();
    await pause(20);
    await mention("7", "build hi");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("fails closed on offline agent lists and new-agent commands", async () => {
    fake.dropConnections();
    await pause(20);
    await mention("offline-list", "agents");
    await mention("offline-new", "new");
    expect(transport.posted).toHaveLength(0);
    expect(transport.ephemerals).toHaveLength(2);
    expect(transport.ephemerals.every((e) => e.text.includes("not reachable"))).toBe(true);
  });

  it("filters and redacts context, refuses not_in_channel, and sends stop and clear", async () => {
    transport.historyMessages = [
      { user: "U1", text: "token xoxb-1234567890 secret", ts: "1" },
      { user: "U2", text: "bad", ts: "2" },
      { text: "bot", botId: "B1", ts: "3" },
      { user: "U1", text: "command", ts: "4" },
    ];
    await mention("4", "build context summarise");
    const sent = fake.requests.find((r) => r.method === "agent.prompt")?.params as { text: string };
    expect(sent.text).toContain("Recent Slack messages:");
    expect(sent.text).not.toContain("xoxb-1234567890");
    expect(sent.text).not.toContain("bad");
    expect(sent.text).not.toContain("command");
    transport.historyError = "not_in_channel";
    await mention("5", "build context again");
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(transport.ephemerals.at(-1)?.text).toContain("Invite @herdr");
    await mention("6", "build stop");
    expect(fake.requests.find((r) => r.method === "agent.send_keys")?.params).toMatchObject({
      keys: ["esc"],
    });
    await mention("7", "build clear");
    expect(
      fake.requests.find(
        (r) => r.method === "agent.prompt" && (r.params as { text?: string }).text === "/new",
      ),
    ).toBeDefined();
    expect(fake.requests.find((r) => r.method === "agent.rename")?.params).toMatchObject({
      name: "build",
    });
  });

  it("reads channel history for a threaded context command and keeps the reply origin", async () => {
    transport.historyMessages = [{ user: "U1", text: "channel information", ts: "before" }];
    const history = vi.spyOn(transport, "history");
    await mention("now", "build context summarise", { threadTs: "root" });
    expect(history).toHaveBeenCalledWith("C1", { limit: config.contextMessages });
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      text: expect.stringContaining("channel information"),
    });
    expect(registry.activeTurn("term-build")?.origin).toEqual({ channel: "C1", threadTs: "root" });
    transport.historyError = "not_in_channel";
    await mention("later", "build context summarise", { threadTs: "root" });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(transport.ephemerals.at(-1)?.text).toContain("Invite @herdr");
  });

  it("refuses a generic history failure without sending a prompt", async () => {
    transport.historyError = "service unavailable";
    await mention("1", "build context summarise");
    expect(requestCount(fake, "agent.prompt")).toBe(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("Could not read recent messages");
  });

  it("sends the plain prompt when context has no eligible history", async () => {
    transport.historyMessages = [
      { user: "U2", text: "not allowed", ts: "1" },
      { user: "U1", text: "subtype", ts: "2", subtype: "message_changed" },
    ];
    await mention("3", "build context summarise");
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      text: "summarise",
    });
  });

  it("names context authors and mentions by Slack username, one lookup per id", async () => {
    transport.historyMessages = [
      { user: "U1", text: "again <@U3> and <@U1>", ts: "3" },
      { user: "U2", text: "spoof <@U4>", ts: "2" },
      { text: "bot <@U5>", botId: "B1", ts: "2.5" },
      {
        user: "U1",
        text: "hi <@U3|fake>, see `<@U3>` https://x.test/U3 <#C1|U3> <https://e.test/U3|U3>\n```\n<@U1>\n```",
        ts: "1",
      },
      { user: "U1", text: "the command <@U6>", ts: "9" },
    ];
    for (const [id, name] of [
      ["U1", "alice"],
      ["U2", "alice"],
      ["U3", "bob"],
      ["U4", "carol"],
      ["U5", "bot"],
      ["U6", "dave"],
    ] as const)
      transport.userNames.set(id, name);
    await mention("9", "build context summarise");
    const sent = fake.requests.find((r) => r.method === "agent.prompt")?.params as { text: string };
    expect(sent.text).toBe(
      "Recent Slack messages:\n" +
        "@alice: hi @bob, see `<@U3>` https://x.test/U3 <#C1|U3> <https://e.test/U3|U3>\n```\n<@U1>\n```\n" +
        "@alice: again @bob and @alice\n\nRequest:\nsummarise",
    );
    expect([...transport.userLookups].sort()).toEqual(["U1", "U3"]);
  });

  it("falls back to the member id for unusable names and still sends the prompt", async () => {
    config.allowedUsers = ["U1", "U5", "U6", "U8", "U9"];
    transport.historyMessages = [
      { user: "U1", text: "a <@U7|label>", ts: "1" },
      { user: "U5", text: "b", ts: "2" },
      { user: "U6", text: "c", ts: "3" },
      { user: "U8", text: "d", ts: "4" },
      { user: "U9", text: "e", ts: "5" },
    ];
    transport.userNames
      .set("U1", new Error("ratelimited xoxb-EXAMPLE"))
      .set("U5", "bad\n<@U2>: forged")
      .set("U6", "")
      .set("U8", "xoxb-1234567890abcdef")
      .set("U9", "x".repeat(81));
    await mention("9", "build context summarise");
    const sent = fake.requests.find((r) => r.method === "agent.prompt")?.params as { text: string };
    expect(sent.text).toContain("<@U1>: a <@U7|label>\n<@U5>: b\n<@U6>: c\n@");
    expect(sent.text).toContain("<@U9>: e\n\nRequest:\nsummarise");
    expect(sent.text).not.toContain("forged");
    expect(sent.text).not.toContain("xoxb-1234567890abcdef");
    expect(logs.join("\n")).not.toMatch(/ratelimited|forged|xoxb/);
  });

  it("forwards the same username-rendered context to a satellite agent", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9` };
    herd.setPeerAgents(peerId, [
      {
        ref: "peer-ref",
        terminalId: "term_peer",
        agent: "claude",
        title: "peer task",
        cwd: "/them/app",
        status: "idle",
        name: "remote",
        workspaceId: "w9",
        workspaceLabel: "their workspace",
      },
    ]);
    transport.historyMessages = [{ user: "U1", text: "hi <@U3>", ts: "1" }];
    transport.userNames.set("U1", "alice").set("U3", "bob");
    await mention("2", "remote context sum");
    expect(herd.forwarded.at(-1)).toMatchObject({
      op: "prompt",
      ref: "peer-ref",
      text: "Recent Slack messages:\n@alice: hi @bob\n\nRequest:\nsum",
    });
  });

  it("resolves bare DM agent commands before the summary", async () => {
    config.channelBindings = { ...config.channelBindings, D1: "w1" };
    await message("1", "build hi", { channel: "D1" });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    expect(registry.activeTurn("term-build")?.origin).toEqual({ channel: "D1" });
    await message("2", "what needs my attention", { channel: "D1" });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
    await message("3", "help", { channel: "D1" });
    expect(transport.posted.at(-1)?.text).toContain("@herdr bind");
  });

  it("dedupes untagged DM and thread messages before the throttle", async () => {
    registry.addReplyPost("term-build", "C1", "root");
    config.channelBindings = { ...config.channelBindings, D1: "w1" };
    for (let i = 0; i < 28; i++) await mention(String(i), "help");
    await message("dm", "build hi", { channel: "D1" });
    await message("dm", "build hi", { channel: "D1" });
    await message("thread", "follow up", { threadTs: "root" });
    await message("thread", "follow up", { threadTs: "root" });
    expect(requestCount(fake, "agent.prompt")).toBe(2);
    await mention("overflow", "build no");
    expect(requestCount(fake, "agent.prompt")).toBe(2);
  });

  it("handles an unseen Slack retry once and drops its duplicate", async () => {
    config.channelBindings = { ...config.channelBindings, D1: "w1" };
    const input = {
      ctx: { ...ctx("first", { channel: "D1" }), surface: "conversation" as const, retryNum: 1 },
      text: "build hi",
    };
    await transport.emitMessage(input);
    await transport.emitMessage({ ...input, ctx: { ...input.ctx, retryNum: 2 } });
    expect(requestCount(fake, "agent.prompt")).toBe(1);
  });

  it("posts a settled reply at the origin once, then accepts its thread reply", async () => {
    fake.on("pane.read", () => ({ read: { text: "prior\nnew useful answer" } }));
    await mention("1", "build hi");
    const active = registry.activeTurn("term-build");
    expect(active).toBeDefined();
    await herd.attached?.refreshResponse("term-build", "done");
    expect(transport.posted.filter((post) => post.channel === "C1")).toHaveLength(1);
    expect(registry.get("term-build")?.replyPosts).toEqual([{ channel: "C1", ts: "ts_1" }]);
    if (active) await herd.attached?.announceReply("term-build", active.id);
    expect(transport.posted).toHaveLength(1);
    await message("2", "next", { threadTs: "ts_1" });
    expect(requestCount(fake, "agent.prompt")).toBe(2);
  });

  it("shows only the selected peer workspace worktrees from its signed options", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9` };
    const options = herd.launchOptionsFor(peerId);
    if (!options) throw new Error("missing peer options");
    options.worktreesByWorkspace = {
      w9: [{ label: "peer-bound", path: "/peer/bound" }],
      w8: [{ label: "peer-focused", path: "/peer/focused" }],
    };
    options.worktrees = [{ label: "peer-focused", path: "/peer/focused" }];
    await action("channel_new_agent", "C1");
    const view = JSON.stringify(transport.modalUpdates.at(-1)?.view);
    expect(view).toContain("/peer/bound");
    expect(view).not.toContain("/peer/focused");
    expect(JSON.parse(String(transport.modalUpdates.at(-1)?.view.private_metadata))).toMatchObject({
      workspaceId: "w9",
      channel: "C1",
    });
    delete options.worktreesByWorkspace;
    await action("channel_new_agent", "C1");
    expect(JSON.stringify(transport.modalUpdates.at(-1)?.view)).not.toContain("/peer/focused");
  });

  it("shows worktrees only from the bound workspace when herdr focus changes", async () => {
    fake.on("worktree.list", (params) => ({
      worktrees:
        params.workspace_id === "w1"
          ? [{ label: "bound-tree", path: "/bound/tree", branch: "main" }]
          : [{ label: "focused-elsewhere", path: "/elsewhere/tree", branch: "other" }],
    }));
    await action("channel_new_agent", "C1");
    const view = JSON.stringify(transport.modalUpdates.at(-1)?.view);
    expect(fake.requests.find((request) => request.method === "worktree.list")?.params).toEqual({
      workspace_id: "w1",
    });
    expect(view).toContain("/bound/tree");
    expect(view).not.toContain("/elsewhere/tree");
    fake.on("worktree.list", () => ({ worktrees: [] }));
    await action("channel_new_agent", "C1");
    expect(JSON.stringify(transport.modalUpdates.at(-1)?.view)).not.toContain('"options":[]');
  });

  it("offers a new-agent button and opens a locked modal at the bound workspace", async () => {
    await mention("1", "new");
    expect(JSON.stringify(transport.ephemerals.at(-1)?.blocks)).toContain("channel_new_agent");
    await action("channel_new_agent", "C1");
    const view = transport.modalUpdates.at(-1)?.view;
    expect(view?.private_metadata).toBe(
      JSON.stringify({ herdId: herd.herdId, workspaceId: "w1", channel: "C1" }),
    );
    expect(JSON.stringify(view)).not.toContain("b_workspace");
    expect(JSON.stringify(view)).toContain("cre");
  });

  it.each(["append", "replace"])(
    "keeps a verified Pi turn through a guarded Slack menu approval after %s",
    async (sourceChange) => {
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
      const captured = await readPiSession(file);
      if (captured.kind !== "boundary") throw new Error("missing boundary");
      expect(captured.boundary.newFile).toBe(true);
      const blocked = pane({
        terminal_id: "term-build",
        pane_id: "w1:p1",
        agent: "pi",
        agent_status: "blocked",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      state.markUnprimed();
      state.applySnapshot({ workspaces: [workspace()], panes: [blocked], agents: [] });
      state.markPrimed();
      Object.assign(state.debounceMs, { done: 5 });
      registry.upsert("term-build", {
        lastKnownPaneId: blocked.pane_id,
        agentKind: "pi",
        title: "cre",
        cwd: "/w",
        workspaceId: "w1",
        tabId: "w1:t1",
        lastStatus: "blocked",
      });
      registry.setThread("term-build", "D1", "card");
      const original = registry.startTurn(
        "term-build",
        "first",
        "",
        { channel: "C1" },
        Date.now(),
        captured.boundary,
      );
      const partial = [
        header,
        row("u1", null, "user", "first"),
        row("a1", "u1", "assistant", [{ type: "text", text: "EXAMPLE approval" }], "toolUse"),
      ];
      writeFileSync(file, `${partial.map((item) => JSON.stringify(item)).join("\n")}\n`);
      await herd.attached?.refreshResponse("term-build", "blocked");
      registry.save();
      registry.load();
      expect(registry.activeTurn("term-build")?.piBoundary?.fileIdentity).toMatchObject({
        ino: expect.any(Number),
      });
      expect(registry.activeTurn("term-build")?.piBoundary?.entryId).toBeNull();
      if (sourceChange === "replace") {
        const replacement = path.join(sessionDir, "replacement");
        writeFileSync(replacement, `${partial.map((item) => JSON.stringify(item)).join("\n")}\n`);
        renameSync(replacement, file);
      }
      fake.on("agent.send_keys", () => {
        state.apply({ type: "pane_updated", pane: { ...blocked, agent_status: "working" } });
        return { ok: true };
      });
      await transport.emitAction({
        ctx: { ...ctx("choice"), surface: "conversation" },
        actionId: "session_menu_choice_1",
        value: `${registry.get("term-build")?.ref}:1`,
        triggerId: "trigger",
      });
      expect(registry.activeTurn("term-build")?.id).toBe(original?.id);
      expect(registry.activeTurn("term-build")?.origin).toEqual({ channel: "C1" });
      writeFileSync(
        file,
        `${[...partial, row("tool", "a1", "toolResult", [{ type: "text", text: "EXAMPLE result" }]), row("a2", "tool", "assistant", [{ type: "text", text: "Completed the approved change successfully." }], "stop")].map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      state.apply({ type: "pane_updated", pane: { ...blocked, agent_status: "done" } });
      await vi.waitFor(() =>
        expect(registry.turns("term-build")[0]?.status).toBe(
          sourceChange === "replace" ? "failed" : "done",
        ),
      );
      expect(registry.turns("term-build")).toHaveLength(1);
      if (sourceChange === "replace") {
        expect(transport.posted).toHaveLength(0);
        expect(JSON.stringify(registry.turns("term-build"))).not.toContain(
          "Completed the approved change successfully.",
        );
      } else {
        await vi.waitFor(() => expect(transport.posted).toHaveLength(1));
        expect(transport.posted[0]?.channel).toBe("C1");
        expect(registry.turns("term-build")[0]?.response).toBe(
          "Completed the approved change successfully.",
        );
      }
    },
  );

  it.each(["done", "idle"])(
    "posts a verified pending Pi reply after a %s reconnect snapshot without a status edge",
    async (status) => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
      const live = pane({
        terminal_id: "term-build",
        pane_id: "w1:p1",
        agent: "pi",
        agent_status: status,
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: file },
      });
      const lines = [
        { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/w" },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "fix", timestamp: Date.now() },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Completed the requested change successfully." }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ];
      writeFileSync(file, `${JSON.stringify(lines[0])}\n`);
      const captured = await readPiSession(file);
      if (captured.kind !== "boundary") throw new Error("missing boundary");
      const turn = registry.startTurn(
        "term-build",
        "fix",
        "",
        { channel: "C1" },
        Date.now(),
        captured.boundary,
      );
      registry.save();
      registry.load(); // Reload the saved turn before the real reconnect.
      writeFileSync(
        file,
        `${lines
          .slice(0, status === "idle" ? 2 : 3)
          .map((line) => JSON.stringify(line))
          .join("\n")}\n`,
      );
      fake.on("session.snapshot", () => ({
        snapshot: {
          version: "1",
          protocol: 1,
          workspaces: [workspace()],
          tabs: [],
          panes: [live],
          agents: [],
        },
      }));
      fake.dropConnections();
      await vi.waitFor(() => expect(tail.status).toBe("waiting"));
      await vi.waitFor(() => expect(fake.subscriberCount).toBe(1), { timeout: 5000 });
      fake.emitSubscriptionStarted();
      await vi.waitFor(() => expect(state.primed).toBe(true));
      if (status === "idle") {
        await vi.waitFor(() => expect(requestCount(fake, "session.snapshot")).toBeGreaterThan(0));
        expect(registry.activeTurn("term-build")?.id).toBe(turn?.id);
        expect(transport.posted).toHaveLength(0);
        writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
        await tail.reconcile();
      }
      await vi.waitFor(() =>
        expect(registry.turns("term-build").find((row) => row.id === turn?.id)?.status).toBe(
          "done",
        ),
      );
      expect(transport.posted).toHaveLength(1);
      await tail.reconcile();
      expect(transport.posted).toHaveLength(1);
    },
  );

  it.each(["malformed", "stale", "error", "aborted", "incomplete"])(
    "handles an idle reconnect with a %s Pi reply without reuse or repeated notices",
    async (caseName) => {
      const sessionDir = path.join(dir, "sessions");
      mkdirSync(sessionDir);
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(sessionDir, `2026-10-13T00-00-00_${id}.jsonl`);
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
      const header = {
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: "/w",
      };
      const prior = [
        header,
        entry("u0", null, "user", "old"),
        entry("a0", "u0", "assistant", [{ type: "text", text: "EXAMPLE prior answer" }], "stop"),
      ];
      writeFileSync(file, `${prior.map((item) => JSON.stringify(item)).join("\n")}\n`);
      const captured = await readPiSession(file);
      if (captured.kind !== "boundary") throw new Error("missing boundary");
      const turn = registry.startTurn(
        "term-build",
        "fix",
        "",
        { channel: "C1" },
        Date.now(),
        captured.boundary,
      );
      registry.save();
      registry.load();
      const user = entry("u1", "a0", "user", "fix");
      const answer = entry(
        "a1",
        "u1",
        "assistant",
        [{ type: "text", text: "EXAMPLE incomplete or failed text" }],
        caseName === "aborted" ? "aborted" : "error",
      );
      if (caseName !== "stale") {
        writeFileSync(
          file,
          caseName === "malformed"
            ? `${prior.map((item) => JSON.stringify(item)).join("\n")}\n{invalid json}\n`
            : `${[...prior, user, ...(caseName === "incomplete" ? [] : [answer])].map((item) => JSON.stringify(item)).join("\n")}\n`,
        );
      }
      let source = file;
      if (caseName === "stale") {
        const newId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
        source = path.join(sessionDir, `2026-10-13T00-00-01_${newId}.jsonl`);
        writeFileSync(source, `${JSON.stringify({ ...header, id: newId })}\n`);
      }
      const live = pane({
        terminal_id: "term-build",
        pane_id: "w1:p1",
        agent: "pi",
        agent_status: "idle",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: source },
      });
      fake.on("session.snapshot", () => ({
        snapshot: {
          version: "1",
          protocol: 1,
          workspaces: [workspace()],
          tabs: [],
          panes: [live],
          agents: [],
        },
      }));
      fake.dropConnections();
      await vi.waitFor(() => expect(tail.status).toBe("waiting"));
      await vi.waitFor(() => expect(fake.subscriberCount).toBe(1), { timeout: 5000 });
      fake.emitSubscriptionStarted();
      await vi.waitFor(() => expect(requestCount(fake, "session.snapshot")).toBeGreaterThan(0));
      await vi.waitFor(() => expect(state.paneByTerminal("term-build")?.agent_status).toBe("idle"));
      if (caseName === "incomplete") {
        await tail.reconcile();
        await pause(30);
        expect(registry.activeTurn("term-build")?.id).toBe(turn?.id);
        expect(transport.posted).toHaveLength(0);
        const finished = entry(
          "a1",
          "u1",
          "assistant",
          [{ type: "text", text: "EXAMPLE new complete answer" }],
          "stop",
        );
        writeFileSync(
          file,
          `${[...prior, user, finished].map((item) => JSON.stringify(item)).join("\n")}\n`,
        );
        await tail.reconcile();
        await vi.waitFor(() => expect(transport.posted).toHaveLength(1));
        expect(registry.turns("term-build").find((item) => item.id === turn?.id)?.status).toBe(
          "done",
        );
        expect(JSON.stringify(transport.posted)).toContain("EXAMPLE new complete answer");
      } else {
        await tail.reconcile();
        await vi.waitFor(() => expect(transport.posted).toHaveLength(1));
        expect(registry.turns("term-build").find((item) => item.id === turn?.id)?.status).toBe(
          caseName === "aborted" ? "stopped" : "failed",
        );
        expect(JSON.stringify(transport.posted)).not.toContain("EXAMPLE prior answer");
        expect(JSON.stringify(transport.posted)).not.toContain("EXAMPLE incomplete or failed text");
      }
      expect(transport.posted[0]?.channel).toBe("C1");
      await tail.reconcile();
      expect(transport.posted).toHaveLength(1);
    },
  );

  it.each(["cre", "pi"])(
    "refuses an unverified %s launch session before prompt I/O",
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
      await transport.emitAction({
        ctx: { ...ctx("click"), surface: "conversation" },
        actionId: "channel_new_agent",
        value: "C1",
        triggerId: "trig",
      });
      await transport.emitViewSubmit({
        ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
        callbackId: "modal_new_agent",
        privateMetadata: String(transport.modalUpdates.at(-1)?.view.private_metadata),
        view: {
          values: {
            b_kind: { a_kind: { selected_option: { value: kind } } },
            b_prompt: { a_prompt: { value: "EXAMPLE first prompt" } },
          },
        },
      });
      expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(0);
      expect(registry.activeTurn("term-new")).toBeUndefined();
    },
  );

  it.each([
    ...["cre", "pi"].flatMap(
      (kind) =>
        [
          [kind, false],
          [kind, true],
        ] as const,
    ),
  ])("verifies the boundary of a %s launch with moved=%s", async (kind, moved) => {
    const sessionDir = path.join(dir, "sessions");
    mkdirSync(sessionDir);
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    const file = path.join(
      sessionDir,
      "2026-10-13T00-00-00_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    fake.on("tab.create", () => ({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }));
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("pane.send_text", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "pi" } }));
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
    let persistedAtPrompt: unknown;
    let launchWorkspace = "w1";
    fake.on("agent.prompt", () => {
      const registryFile = registryPath("default");
      const saved = existsSync(registryFile)
        ? (JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, { turns?: unknown[] }>)
        : {};
      persistedAtPrompt = saved["term-new"]?.turns?.[0];
      if (moved) launchWorkspace = "w2";
      // The agent writes the entire reply before the launch call returns.
      writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      return { ok: true };
    });
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
    await transport.emitAction({
      ctx: contextFromPayload({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        container: { type: "message", channel_id: "C1", message_ts: "child" },
        message: { thread_ts: "root" },
      }),
      actionId: "channel_new_agent",
      value: "C1",
      triggerId: "trig",
    });
    await transport.emitViewSubmit({
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
      callbackId: "modal_new_agent",
      privateMetadata: String(transport.modalUpdates.at(-1)?.view.private_metadata),
      view: {
        values: {
          b_kind: { a_kind: { selected_option: { value: kind } } },
          b_prompt: { a_prompt: { value: "Explain TOKEN=EXAMPLE123" } },
        },
      },
    });
    expect(persistedAtPrompt).toMatchObject({
      deliveryPending: true,
      expectedWorkspaceId: "w1",
      origin: { channel: "C1", threadTs: "root" },
      piBoundary: { entryId: null },
    });
    expect(registry.turns("term-new")[0]?.origin).toEqual({ channel: "C1", threadTs: "root" });
    expect(registry.turns("term-new")[0]?.piBoundary?.entryId).toBeNull();
    if (moved) {
      expect(registry.activeTurn("term-new")?.deliveryPending).toBe(true);
      expect(transport.posted).toHaveLength(0);
      expect(transport.ephemerals.at(-1)?.text).toContain("could not be verified");
      return;
    }
    // The reply was already complete when launchAgent returned; no status event is needed.
    expect(transport.posted).toHaveLength(1);
    await herd.attached?.refreshResponse("term-new", "done");
    expect(transport.posted).toHaveLength(1);
    expect(registry.turns("term-new")[0]?.response).toBe(
      "First useful answer paragraph.\n\nSecond useful answer paragraph. TOKEN=‹redacted›",
    );
    expect(transport.posted[0]).toMatchObject({ channel: "C1", threadTs: "root" });
    expect(JSON.stringify(transport.posted)).not.toContain("EXAMPLE123");
    expect(logs.join()).not.toContain("EXAMPLE123");
    expect(transport.ephemerals.at(-1)?.channel).toBe("C1");
  });

  it("forwards the channel and thread origin of a satellite first prompt", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9` };
    await transport.emitAction({
      ctx: contextFromPayload({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        container: { type: "message", channel_id: "C1", message_ts: "child" },
        message: { thread_ts: "origin" },
      }),
      actionId: "channel_new_agent",
      value: "C1",
      triggerId: "trig",
    });
    await transport.emitViewSubmit({
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
      callbackId: "modal_new_agent",
      privateMetadata: String(transport.modalUpdates.at(-1)?.view.private_metadata),
      view: {
        values: {
          b_kind: { a_kind: { selected_option: { value: "claude" } } },
          b_prompt: { a_prompt: { value: "first prompt" } },
        },
      },
    });
    expect(herd.forwarded.at(-1)).toMatchObject({
      op: "launch_agent",
      channel: "C1",
      threadTs: "origin",
      launch: { firstPrompt: "first prompt", workspaceId: "w9" },
    });
    expect(transport.ephemerals.at(-1)?.channel).toBe("C1");
  });

  it.each(["h2", "{", "", "{}"])(
    "refuses stale launch metadata %s without terminal I/O",
    async (metadata) => {
      await transport.emitViewSubmit({
        ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
        callbackId: "modal_new_agent",
        privateMetadata: metadata,
        view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
      });
      expect(requestCount(fake, "tab.create")).toBe(0);
      expect(herd.forwarded).toHaveLength(0);
    },
  );

  it.each(["local", "peer"])("refuses a %s launch after the target disconnects", async (target) => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    if (target === "peer") config.channelBindings = { C1: `${peerId}\u001fw9` };
    await action("channel_new_agent", "C1");
    expect(transport.modalUpdates).toHaveLength(1);
    herd.setUnreachable(target === "peer" ? peerId : herd.herdId);
    await transport.emitViewSubmit({
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
      callbackId: "modal_new_agent",
      privateMetadata: String(transport.modalUpdates[0]?.view.private_metadata),
      view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
    });
    expect(requestCount(fake, "tab.create")).toBe(0);
    expect(herd.forwarded).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("refuses a local launch after its live herdr socket drops despite a stale heartbeat", async () => {
    await action("channel_new_agent", "C1");
    fake.dropConnections();
    await vi.waitFor(() => expect(tail.status).toBe("waiting"));
    await transport.emitViewSubmit({
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
      callbackId: "modal_new_agent",
      privateMetadata: String(transport.modalUpdates[0]?.view.private_metadata),
      view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
    });
    expect(requestCount(fake, "tab.create")).toBe(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it.each(["local", "peer"])("refuses a stale %s bind select after disconnect", async (target) => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    await mention("bind-open", "bind", { channel: "C9" });
    herd.setUnreachable(target === "peer" ? peerId : herd.herdId);
    await action("channel_bind_select", target === "peer" ? `${peerId}\u001fw9` : "w1", {
      channel: "C9",
    });
    expect(config.channelBindings?.C9).toBeUndefined();
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("keeps a new-agent form open for a missing kind and accepts its corrected submit", async () => {
    const input = {
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" as const },
      callbackId: "modal_new_agent",
      privateMetadata: JSON.stringify({ herdId: herd.herdId, workspaceId: "w1", channel: "C1" }),
    };
    const invalid = await transport.emitViewSubmit({ ...input, view: { values: {} } });
    expect(invalid).toMatchObject({ errors: { b_kind: expect.any(String) } });
    expect(requestCount(fake, "tab.create")).toBe(0);
    fake.on("tab.create", () => ({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }));
    await transport.emitViewSubmit({
      ...input,
      view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
    });
    expect(requestCount(fake, "tab.create")).toBe(1);
  });

  it("refuses a forged channel origin on modal submit before launch", async () => {
    await transport.emitViewSubmit({
      ctx: { ...ctx("submit", { channel: "", surface: "modal" }), surface: "modal" },
      callbackId: "modal_new_agent",
      privateMetadata: JSON.stringify({ herdId: herd.herdId, workspaceId: "w1", channel: "C9" }),
      view: { values: { b_kind: { a_kind: { selected_option: { value: "claude" } } } } },
    });
    expect(requestCount(fake, "tab.create")).toBe(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not bound");
  });

  it("does not open a channel modal when a peer herd is offline", async () => {
    const peerId = herd.homeHerds()[1]?.herdId ?? "";
    config.channelBindings = { C1: `${peerId}\u001fw9` };
    herd.setUnreachable(peerId);
    await action("channel_new_agent", "C1");
    expect(transport.modals).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("does not open a channel modal when the target herd is offline", async () => {
    herd.setUnreachable(herd.herdId);
    await action("channel_new_agent", "C1");
    expect(transport.modals).toHaveLength(0);
    expect(transport.ephemerals.at(-1)?.text).toContain("not reachable");
  });

  it("does not schedule channel cards in the new mode", async () => {
    await pause(5100);
    expect(transport.posted).toHaveLength(0);
  }, 7000);
});
