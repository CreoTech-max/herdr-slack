import { describe, expect, it } from "vitest";
import { defaultInstance, validateInstance } from "../../src/config/config.js";
import { ActionThrottle, authorizeAction, checkInbound } from "../../src/slack/guards.js";
import { eventsFor, scopesFor } from "../../src/slack/manifest.js";

const config = defaultInstance({
  allowedUsers: ["U0C93G42G00", "U0C8CR5CMSQ"],
  slack: {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    teamId: "T1",
    appId: "A1",
    botUserId: "UBOT",
  },
  channelBindings: { C111: "w1", C222: "w2" },
  creOnly: true,
  creRoots: [{ workspaceId: "w1", terminalId: "root1", sessionId: "native1" }],
});

describe("workspace-bound channel permissions", () => {
  it("advertises app mention event and scope", () => {
    expect(eventsFor({ appName: "Herdr" })).toContain("app_mention");
    expect(scopesFor({ appName: "Herdr" })).toContain("app_mentions:read");
  });
  it("allows the two developers in bound channels", () => {
    for (const userId of config.allowedUsers) {
      expect(
        checkInbound(
          { config, throttle: new ActionThrottle() },
          { teamId: "T1", userId, channel: "C111", surface: "mention" },
        ).allowed,
      ).toBe(true);
    }
  });
  it("rejects unlisted users but lets an unbound channel request bind", () => {
    expect(
      checkInbound(
        { config, throttle: new ActionThrottle() },
        { teamId: "T1", userId: "UATTACK", channel: "C111", surface: "mention" },
      ).reason,
    ).toBe("not_allowed");
    expect(
      checkInbound(
        { config, throttle: new ActionThrottle() },
        { teamId: "T1", userId: "U0C93G42G00", channel: "C999", surface: "mention" },
      ).reason,
    ).toBeUndefined();
  });
  it("rejects actions targeting the wrong workspace in bound C and G channels", () => {
    const deps = {
      config: {
        ...config,
        creOnly: false,
        channelBindings: { ...config.channelBindings, G333: "w3" },
      },
      throttle: new ActionThrottle(),
      resolveRef: () => "t1",
      isLive: () => true,
      workspaceForTerminal: () => "w2",
    };
    const ctx = {
      teamId: "T1",
      userId: "U0C93G42G00",
      channel: "C111",
      surface: "conversation" as const,
    };
    expect(authorizeAction(deps, ctx, "ref").decision.reason).toBe("workspace_mismatch");
    expect(authorizeAction(deps, { ...ctx, channel: "C222" }, "ref").decision.allowed).toBe(true);
    expect(authorizeAction(deps, { ...ctx, channel: "G333" }, "ref").decision.reason).toBe(
      "workspace_mismatch",
    );
  });
  it("rejects duplicate workspace bindings", () => {
    expect(validateInstance({ ...config, channelBindings: { C111: "w1", C222: "w1" } })).toContain(
      "workspace bound to multiple channels: w1",
    );
  });
});
