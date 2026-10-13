import { describe, expect, it } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import {
  ActionThrottle,
  authorizeAction,
  checkInbound,
  resolveTarget,
} from "../../src/slack/guards.js";
import {
  inboundMessageDedupeKey,
  isActionableMessage,
  isPinnedTeam,
} from "../../src/slack/transport.js";

const config = (overrides = {}) =>
  defaultInstance({
    slack: { botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", appId: "A1", botUserId: "UBOT" },
    allowedUsers: ["U1"],
    ...overrides,
  });

const ctx = (overrides = {}) => ({
  teamId: "T1",
  userId: "U1",
  channel: "D1",
  ...overrides,
});

const deps = (overrides = {}) => ({
  config: config(),
  throttle: new ActionThrottle(),
  resolveRef: (ref: string) => (ref === "good" ? "term_1" : undefined),
  isLive: () => true,
  ...overrides,
});

describe("checkInbound", () => {
  it("allows an allowlisted user in a DM from the pinned workspace", () => {
    expect(checkInbound(deps(), ctx()).allowed).toBe(true);
  });

  it("rejects another workspace, whoever it claims to be", () => {
    const decision = checkInbound(deps(), ctx({ teamId: "T_EVIL", userId: "U1" }));
    expect(decision).toMatchObject({ allowed: false, reason: "wrong_team" });
  });

  it("rejects a payload with no team at all", () => {
    expect(checkInbound(deps(), ctx({ teamId: "" })).reason).toBe("wrong_team");
  });

  it("rejects a user who is not on the allowlist", () => {
    expect(checkInbound(deps(), ctx({ userId: "U_OTHER" })).reason).toBe("not_allowed");
  });

  it("rejects a payload with no user", () => {
    expect(checkInbound(deps(), ctx({ userId: "" })).reason).toBe("not_allowed");
  });

  it("refuses to act in a channel while dmOnly is set", () => {
    expect(checkInbound(deps(), ctx({ channel: "C1" })).reason).toBe("channel_not_permitted");
  });

  it("still refuses channels when dmOnly is explicitly true", () => {
    const d = deps({ config: config({ dmOnly: true }) });
    expect(checkInbound(d, ctx({ channel: "C1" })).reason).toBe("channel_not_permitted");
  });

  it("allows an App Home button, which carries no channel at all", () => {
    // The bug this exists for: every Home button and every modal submission was
    // denied with channel_not_permitted, because block_actions from a view have
    // container.type "view" and no channel id — so the DM rule tested "" and
    // refused. Home is a per-user surface; the room rule does not apply to it.
    expect(checkInbound(deps(), ctx({ channel: "", surface: "home" })).allowed).toBe(true);
  });

  it("allows a modal submission, which also carries no channel", () => {
    expect(checkInbound(deps(), ctx({ channel: "", surface: "modal" })).allowed).toBe(true);
  });

  it("still pins the team on a home interaction", () => {
    // Exempting the channel rule must not exempt anything else.
    expect(
      checkInbound(deps(), ctx({ channel: "", surface: "home", teamId: "T_OTHER" })).reason,
    ).toBe("wrong_team");
  });

  it("still enforces the allowlist on a home interaction", () => {
    expect(
      checkInbound(deps(), ctx({ channel: "", surface: "home", userId: "U_OTHER" })).reason,
    ).toBe("not_allowed");
  });

  it("still throttles a home interaction", () => {
    const d = deps({ throttle: new ActionThrottle(1, 60_000) });
    expect(checkInbound(d, ctx({ channel: "", surface: "home" })).allowed).toBe(true);
    expect(checkInbound(d, ctx({ channel: "", surface: "home" })).reason).toBe("throttled");
  });

  it("treats a missing surface as a conversation, failing closed", () => {
    // A construction site that forgets to set surface must land in the strict
    // branch, never the exempt one.
    expect(checkInbound(deps(), ctx({ channel: "C1" })).reason).toBe("channel_not_permitted");
    expect(checkInbound(deps(), ctx({ channel: "" })).reason).toBe("channel_not_permitted");
  });

  it("allows an unbound mention, but still pins team, allowlist and throttle", () => {
    const { channelBindings, ...withoutBindings } = config();
    expect(channelBindings).toEqual({});
    const d = deps({ config: withoutBindings, throttle: new ActionThrottle(1) });
    const mention = ctx({ channel: "C1", surface: "mention" });
    expect(checkInbound(d, ctx({ ...mention, teamId: "T_OTHER" })).reason).toBe("wrong_team");
    expect(checkInbound(d, ctx({ ...mention, userId: "U_OTHER" })).reason).toBe("not_allowed");
    expect(checkInbound(d, mention).allowed).toBe(true);
    expect(checkInbound(d, mention).reason).toBe("throttled");
    expect(checkInbound(deps({ config: withoutBindings }), ctx({ channel: "C1" })).reason).toBe(
      "channel_not_permitted",
    );
  });

  it("accepts a bound conversation channel for an allowlisted member", () => {
    const d = deps({ config: config({ channelBindings: { C1: "w1" } }) });
    expect(checkInbound(d, ctx({ channel: "C1", surface: "conversation" })).allowed).toBe(true);
    expect(checkInbound(d, ctx({ channel: "C2", surface: "conversation" })).reason).toBe(
      "channel_not_permitted",
    );
  });

  it("still refuses a public channel even when surface is explicit", () => {
    expect(checkInbound(deps(), ctx({ channel: "C1", surface: "conversation" })).reason).toBe(
      "channel_not_permitted",
    );
  });

  it("throttles a user hammering the bot", () => {
    const d = deps({ throttle: new ActionThrottle(3, 60_000) });
    for (let i = 0; i < 3; i += 1) expect(checkInbound(d, ctx()).allowed).toBe(true);
    expect(checkInbound(d, ctx()).reason).toBe("throttled");
  });

  it("lets the throttle recover once the window passes", () => {
    let clock = 0;
    const d = deps({ throttle: new ActionThrottle(2, 1_000, () => clock) });
    expect(checkInbound(d, ctx()).allowed).toBe(true);
    expect(checkInbound(d, ctx()).allowed).toBe(true);
    expect(checkInbound(d, ctx()).allowed).toBe(false);
    clock += 1_001;
    expect(checkInbound(d, ctx()).allowed).toBe(true);
  });

  it("throttles per user, not globally", () => {
    const d = deps({
      config: config({ allowedUsers: ["U1", "U2"] }),
      throttle: new ActionThrottle(1, 60_000),
    });
    expect(checkInbound(d, ctx({ userId: "U1" })).allowed).toBe(true);
    expect(checkInbound(d, ctx({ userId: "U2" })).allowed).toBe(true);
  });

  it("denies everything when the allowlist is empty", () => {
    const d = deps({ config: config({ allowedUsers: [] }) });
    expect(checkInbound(d, ctx()).reason).toBe("not_allowed");
  });
});

describe("resolveTarget", () => {
  it("resolves a known ref to its terminal", () => {
    const result = resolveTarget(deps(), "good");
    expect(result.decision.allowed).toBe(true);
    expect(result.terminalId).toBe("term_1");
  });

  it("fails closed on an unknown ref", () => {
    expect(resolveTarget(deps(), "nope").decision.reason).toBe("unknown_ref");
  });

  it("fails closed on an empty ref", () => {
    expect(resolveTarget(deps(), "").decision.reason).toBe("unknown_ref");
  });

  it("fails closed when the terminal has ended", () => {
    const result = resolveTarget(deps({ isLive: () => false }), "good");
    expect(result.decision.reason).toBe("session_ended");
    expect(result.terminalId).toBeUndefined();
  });

  it("has no resolver at all and still fails closed", () => {
    expect(
      resolveTarget({ config: config(), throttle: new ActionThrottle() }, "good").decision.reason,
    ).toBe("unknown_ref");
  });

  it("explains itself in words a user can act on", () => {
    expect(resolveTarget(deps(), "nope").decision.message).toMatch(/older message/);
  });
});

describe("authorizeAction", () => {
  it("allows bound DM card actions outside its workspace but preserves all other guards", () => {
    const d = deps({
      config: config({ channelBindings: { D1: "w1" } }),
      workspaceForTerminal: () => "w2",
    });
    expect(authorizeAction(d, ctx(), "good").decision.allowed).toBe(true);
    expect(authorizeAction(d, ctx({ teamId: "T_OTHER" }), "good").decision.reason).toBe(
      "wrong_team",
    );
    expect(authorizeAction(d, ctx(), "missing").decision.reason).toBe("unknown_ref");
    expect(authorizeAction({ ...d, isLive: () => false }, ctx(), "good").decision.reason).toBe(
      "session_ended",
    );
    expect(
      authorizeAction({ ...d, isHerdrConnected: () => false }, ctx(), "good").decision.reason,
    ).toBe("herdr_offline");
  });

  it("passes both gates for a legitimate action", () => {
    const result = authorizeAction(deps(), ctx(), "good");
    expect(result.decision.allowed).toBe(true);
    expect(result.terminalId).toBe("term_1");
  });

  it("stops at the identity gate before ever touching the ref", () => {
    // A crafted payload must not get as far as resolving a target.
    const result = authorizeAction(deps(), ctx({ teamId: "T_EVIL" }), "good");
    expect(result.decision.reason).toBe("wrong_team");
    expect(result.terminalId).toBeUndefined();
  });

  it("rejects a payload carrying a raw pane id instead of a ref", () => {
    // Pane ids are never minted into payloads; one appearing here is forged.
    const result = authorizeAction(deps(), ctx(), "w1:p1");
    expect(result.decision.reason).toBe("unknown_ref");
  });

  it("refuses when herdr is offline, before resolving the ref", () => {
    const result = authorizeAction(deps({ isHerdrConnected: () => false }), ctx(), "good");
    expect(result.decision.reason).toBe("herdr_offline");
    expect(result.terminalId).toBeUndefined();
    expect(result.decision.message).toMatch(/not reachable/i);
  });
});

describe("isActionableMessage", () => {
  it("accepts a plain user message", () => {
    expect(isActionableMessage({ user: "U1", text: "hello" }, "UBOT")).toBe(true);
  });

  it("drops message_changed, which our own card updates generate", () => {
    // Without this, our rendered terminal output is fed back in as a prompt —
    // a self-inflicted injection loop.
    expect(
      isActionableMessage({ subtype: "message_changed", user: "U1", text: "term output" }, "UBOT"),
    ).toBe(false);
  });

  it("drops anything with a bot id", () => {
    expect(isActionableMessage({ bot_id: "B1", user: "U1", text: "hi" }, "UBOT")).toBe(false);
  });

  it("drops our own messages", () => {
    expect(isActionableMessage({ user: "UBOT", text: "hi" }, "UBOT")).toBe(false);
  });

  it("drops empty and whitespace-only text", () => {
    expect(isActionableMessage({ user: "U1", text: "   " }, "UBOT")).toBe(false);
    expect(isActionableMessage({ user: "U1" }, "UBOT")).toBe(false);
  });
});

describe("inboundMessageDedupeKey", () => {
  it("prefers channel and ts", () => {
    expect(inboundMessageDedupeKey({ teamId: "T1", userId: "U1", channel: "D1", ts: "1.2" })).toBe(
      "D1:1.2",
    );
  });

  it("falls back to event id", () => {
    expect(
      inboundMessageDedupeKey({ teamId: "T1", userId: "U1", channel: "D1", eventId: "Ev123" }),
    ).toBe("Ev123");
  });
});

describe("isPinnedTeam", () => {
  it("accepts the pinned workspace and nothing else", () => {
    expect(isPinnedTeam(config(), "T1")).toBe(true);
    expect(isPinnedTeam(config(), "T2")).toBe(false);
    expect(isPinnedTeam(config(), undefined)).toBe(false);
  });
});
