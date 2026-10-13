import { describe, expect, it } from "vitest";
import { contextFromPayload, surfaceOf } from "../../src/slack/inbound.js";

/**
 * Payload shapes below mirror what Slack actually sends. The App Home one is
 * the shape that caused every Home button to be denied: container.type "view",
 * and no channel id anywhere in the payload.
 */
const homeButton = {
  type: "block_actions",
  team: { id: "T1" },
  user: { id: "U1" },
  container: { type: "view", view_id: "V1", view_type: "home" },
  view: { id: "V1", type: "home" },
  trigger_id: "tr1",
};

const modalSubmit = {
  type: "view_submission",
  team: { id: "T1" },
  user: { id: "U1" },
  view: { id: "V2", type: "modal", callback_id: "new_agent", state: {} },
};

const messageButton = {
  type: "block_actions",
  team: { id: "T1" },
  user: { id: "U1" },
  channel: { id: "D123" },
  container: { type: "message", channel_id: "D123", message_ts: "111.2", thread_ts: "111.0" },
  trigger_id: "tr2",
};

describe("surfaceOf", () => {
  it("calls an App Home button 'home'", () => {
    expect(surfaceOf(homeButton)).toBe("home");
  });

  it("calls a modal submission 'modal'", () => {
    expect(surfaceOf(modalSubmit)).toBe("modal");
  });

  it("calls a message button 'conversation'", () => {
    expect(surfaceOf(messageButton)).toBe("conversation");
  });

  it("calls a button inside a modal 'modal'", () => {
    const inModal = {
      type: "block_actions",
      container: { type: "view", view_id: "V3", view_type: "modal" },
      view: { id: "V3", type: "modal" },
    };
    expect(surfaceOf(inModal)).toBe("modal");
  });

  it("defaults to conversation for anything unrecognised", () => {
    // Conversation is the restrictive branch in the guard, so an unknown shape
    // must land there rather than in the exempt one.
    expect(surfaceOf({})).toBe("conversation");
    expect(surfaceOf({ type: "block_actions" })).toBe("conversation");
  });
});

describe("contextFromPayload", () => {
  it("reports no channel for an App Home button, rather than inventing one", () => {
    const ctx = contextFromPayload(homeButton);
    expect(ctx).toMatchObject({ teamId: "T1", userId: "U1", channel: "", surface: "home" });
  });

  it("carries channel and thread through for a message button", () => {
    const ctx = contextFromPayload(messageButton);
    expect(ctx).toMatchObject({
      teamId: "T1",
      userId: "U1",
      channel: "D123",
      surface: "conversation",
      ts: "111.2",
      threadTs: "111.0",
    });
  });

  it("reads message.thread_ts when the button container lacks it", () => {
    const payload = {
      ...messageButton,
      container: { type: "message", channel_id: "C1", message_ts: "111.2" },
      message: { thread_ts: "111.0" },
    };
    expect(contextFromPayload(payload).threadTs).toBe("111.0");
  });

  it("falls back to the configured team when the payload omits one", () => {
    const ctx = contextFromPayload({ type: "block_actions", user: { id: "U1" } }, "T_CONFIG");
    expect(ctx.teamId).toBe("T_CONFIG");
  });

  it("prefers the payload's own team over the fallback", () => {
    // Team pinning compares this against config; silently substituting the
    // configured id for a foreign payload would defeat the check entirely.
    const ctx = contextFromPayload(homeButton, "T_CONFIG");
    expect(ctx.teamId).toBe("T1");
  });

  it("omits ts and threadTs when there is no container", () => {
    const ctx = contextFromPayload(modalSubmit);
    expect(ctx.ts).toBeUndefined();
    expect(ctx.threadTs).toBeUndefined();
  });
});
