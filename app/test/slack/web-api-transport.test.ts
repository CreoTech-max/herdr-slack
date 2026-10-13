import { afterEach, expect, it, vi } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { WebApiTransport } from "../../src/slack/web-api-transport.js";
import { FAKE } from "../helpers/fake-credentials.js";

afterEach(() => vi.unstubAllGlobals());

it("reads channel history, not thread replies, for a threaded context request", async () => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return {
      json: async () => ({ ok: true, messages: [{ text: "channel note", ts: "1", user: "U1" }] }),
    };
  });
  const transport = new WebApiTransport(
    defaultInstance({
      slack: {
        botToken: FAKE.slackBot,
        appToken: FAKE.slackApp,
        teamId: "T1",
        appId: "A1",
        botUserId: "UBOT",
      },
    }),
  );
  expect(await transport.history("C1", { threadTs: "root", limit: 50 })).toEqual([
    { text: "channel note", ts: "1", user: "U1" },
  ]);
  expect(calls).toEqual([
    { url: "https://slack.com/api/conversations.history", body: { channel: "C1", limit: 50 } },
  ]);
});

it("reads one member's Slack username through users.info", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const users: unknown[] = [{ name: "alice" }, { name: "gone", deleted: true }, { name: 7 }];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return { json: async () => ({ ok: true, user: users.shift() }) };
  });
  const transport = new WebApiTransport(
    defaultInstance({
      slack: {
        botToken: FAKE.slackBot,
        appToken: FAKE.slackApp,
        teamId: "T1",
        appId: "A1",
        botUserId: "UBOT",
      },
    }),
  );
  expect(await transport.userName("U1")).toBe("alice");
  expect(await transport.userName("U2")).toBeUndefined();
  expect(await transport.userName("U3")).toBeUndefined();
  expect(calls[0]).toEqual({ url: "https://slack.com/api/users.info", body: { user: "U1" } });
});
