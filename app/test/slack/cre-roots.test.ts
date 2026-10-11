import { describe, expect, it } from "vitest";
import { defaultInstance, validateInstance } from "../../src/config/config.js";
import { isEligibleCreRoot } from "../../src/slack/cre-roots.js";
import { ActionThrottle, authorizeAction } from "../../src/slack/guards.js";
import { pane } from "../helpers/factories.js";

const config = defaultInstance({
  allowedUsers: ["U1", "U2"],
  slack: { botToken: "xoxb-test", appToken: "xapp-test", teamId: "T1", appId: "A1", botUserId: "UBOT" },
  channelBindings: { C111: "w1" },
  creOnly: true,
  creRoots: [{ workspaceId: "w1", terminalId: "term-cre", sessionId: "native-cre" }],
});
const verified = pane({ terminal_id: "term-cre", workspace_id: "w1", agent: "pi",
  agent_session: { agent: "pi", kind: "session", source: "pi", value: "native-cre" } });

describe("attach-only CRE roots", () => {
  it("only allows exact workspace + terminal + native Pi session", () => {
    expect(isEligibleCreRoot(config, verified)).toBe(true);
    expect(isEligibleCreRoot(config, { ...verified, terminal_id: "plain-pi" })).toBe(false);
    expect(isEligibleCreRoot(config, { ...verified, agent: "claude" })).toBe(false);
    expect(isEligibleCreRoot(config, { ...verified, agent_session: undefined })).toBe(false);
    expect(isEligibleCreRoot(config, { ...verified, agent_session: { ...verified.agent_session!, value: "new-session" } })).toBe(false);
    expect(isEligibleCreRoot(config, { ...verified, workspace_id: "w2" })).toBe(false);
  });
  it("denies Slack actions targeting unverified Pi, even from an allowlisted user", () => {
    const deps = { config, throttle: new ActionThrottle(), resolveRef: () => verified.terminal_id,
      isLive: () => true, workspaceForTerminal: () => "w1", isApprovedCreRoot: () => false };
    const ctx = { teamId: "T1", userId: "U1", channel: "C111", surface: "conversation" as const };
    expect(authorizeAction(deps, ctx, "ref").decision.reason).toBe("cre_root_unverified");
    expect(authorizeAction({ ...deps, isApprovedCreRoot: () => true }, ctx, "ref").decision.allowed).toBe(true);
  });
  it("rejects missing root pins and unbound channels during startup validation", () => {
    expect(validateInstance(config)).not.toContain("creOnly requires at least one pinned creRoots entry");
    expect(validateInstance({ ...config, creRoots: [] })).toContain("creOnly requires at least one pinned creRoots entry");
    expect(validateInstance({ ...config, creOnly: false })).toContain("channelBindings requires creOnly=true");
  });
});
