import { describe, expect, it } from "vitest";
import { defaultInstance, validateInstance } from "../../src/config/config.js";
import { ActionThrottle, authorizeAction, checkInbound } from "../../src/slack/guards.js";
import { eventsFor, scopesFor } from "../../src/slack/manifest.js";

const config = defaultInstance({
  allowedUsers: ["U0C93G42G00", "U0C8CR5CMSQ"],
  slack: { botToken: "xoxb-test", appToken: "xapp-test", teamId: "T1", appId: "A1", botUserId: "UBOT" },
  channelBindings: { C111: "w1", C222: "w2" },
  creOnly: true,
  creRoots: [{workspaceId:"w1",terminalId:"root1",sessionId:"native1"}],
});

describe("workspace-bound channel permissions", () => {
  it("advertises app mention event and scope", () => {
    expect(eventsFor({ appName: "Herdr" })).toContain("app_mention");
    expect(scopesFor({ appName: "Herdr" })).toContain("app_mentions:read");
  });
  it("allows the two developers in bound channels", () => {
    for (const userId of config.allowedUsers) {
      expect(checkInbound({config, throttle:new ActionThrottle()}, {teamId:"T1",userId,channel:"C111",surface:"mention"}).allowed).toBe(true);
    }
  });
  it("rejects unlisted users and channels", () => {
    expect(checkInbound({config,throttle:new ActionThrottle()}, {teamId:"T1",userId:"UATTACK",channel:"C111",surface:"mention"}).reason).toBe("not_allowed");
    expect(checkInbound({config,throttle:new ActionThrottle()}, {teamId:"T1",userId:config.allowedUsers[0]!,channel:"C999",surface:"mention"}).reason).toBe("channel_not_permitted");
  });
  it("rejects actions targeting the wrong workspace", () => {
    const deps = {config, throttle:new ActionThrottle(),resolveRef:()=> "t1",isLive:()=>true,workspaceForTerminal:()=> "w2"};
    const ctx = {teamId:"T1",userId:config.allowedUsers[0]!,channel:"C111",surface:"conversation" as const};
    expect(authorizeAction(deps,ctx,"ref").decision.reason).toBe("workspace_mismatch");
  });
  it("rejects duplicate workspace bindings", () => {
    expect(validateInstance({...config,channelBindings:{C111:"w1",C222:"w1"}})).toContain("workspace bound to multiple channels: w1");
  });
});
