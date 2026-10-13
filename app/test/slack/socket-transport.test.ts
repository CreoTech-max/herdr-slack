import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultInstance } from "../../src/config/config.js";
import { SocketModeTransport } from "../../src/slack/socket-transport.js";

const sdk = vi.hoisted(() => ({
  handler: null as
    | null
    | ((args: {
        ack: (result?: unknown) => Promise<void>;
        body: unknown;
        view: unknown;
      }) => Promise<void>),
  starts: 0,
  stops: 0,
  disconnects: 0,
  active: true,
  disconnect: null as null | (() => Promise<void>),
  finishDisconnect: null as null | (() => void),
  usersInfo: [] as unknown[],
}));

vi.mock("@slack/bolt", async () => {
  const { EventEmitter } = await import("node:events");
  class SocketModeReceiver {
    client = Object.assign(new EventEmitter(), {
      websocket: { isActive: () => sdk.active },
      disconnect: () => sdk.disconnect?.() ?? Promise.resolve(),
    });
    constructor(_options: unknown) {
      let pending: Promise<void> | null = null;
      sdk.disconnect = () => {
        sdk.disconnects += 1;
        if (!pending)
          pending = new Promise<void>((resolve) => {
            sdk.finishDisconnect = () => {
              this.client.emit("disconnected");
              resolve();
              pending = null;
            };
          });
        return pending;
      };
    }
  }
  class App {
    client = {
      users: {
        info: async (args: unknown) => {
          sdk.usersInfo.push(args);
          return {
            ok: true,
            user:
              args && (args as { user: string }).user === "U1"
                ? { name: "alice" }
                : { name: "gone", deleted: true },
          };
        },
      },
    };
    error(_handler: unknown) {}
    view(_pattern: unknown, handler: NonNullable<typeof sdk.handler>) {
      sdk.handler = handler;
    }
    start = async () => {
      sdk.starts += 1;
    };
    stop = async () => {
      sdk.stops += 1;
      void sdk.disconnect?.(); // Installed Bolt resolves before the socket disconnects.
    };
  }
  return { default: { SocketModeReceiver, App } };
});

const config = defaultInstance({
  slack: {
    botToken: "xoxb-EXAMPLE",
    appToken: "xapp-EXAMPLE",
    teamId: "T1",
    appId: "A1",
    botUserId: "UBOT",
  },
});
const submit = (id: string, marker = "same") => {
  const ack = vi.fn(async (_result?: unknown) => undefined);
  const view = {
    id,
    callback_id: "modal_new_agent",
    private_metadata: '{"herdId":"local"}',
    state: { marker },
  };
  const body = { type: "view_submission", team: { id: "T1" }, user: { id: "U1" }, view };
  if (!sdk.handler) throw new Error("view handler not installed");
  return { received: sdk.handler({ ack, body, view }), ack };
};

beforeEach(() => {
  sdk.handler = null;
  sdk.starts = 0;
  sdk.stops = 0;
  sdk.disconnects = 0;
  sdk.disconnect = null;
  sdk.finishDisconnect = null;
  sdk.active = true;
});
afterEach(() => vi.useRealTimers());

describe("Socket Mode new-agent submission", () => {
  it("acks three receipts of one view, but permits a distinct form and a corrected validation error", async () => {
    const transport = new SocketModeTransport(config);
    const handler = vi.fn(async (input: { view: unknown }) =>
      (input.view as { marker: string }).marker === "invalid"
        ? { errors: { b_kind: "Choose an agent." } }
        : undefined,
    );
    transport.onViewSubmit(handler);
    const receipts = [submit("V1"), submit("V1"), submit("V1")];
    await Promise.all(receipts.map((item) => item.received));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(receipts.map((item) => item.ack.mock.calls.length)).toEqual([1, 1, 1]);
    await submit("V2").received;
    expect(handler).toHaveBeenCalledTimes(2);
    const invalid = submit("V3", "invalid");
    await invalid.received;
    expect(invalid.ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { b_kind: "Choose an agent." },
    });
    await submit("V3", "corrected").received;
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it("refuses a new-agent submit without a stable Slack view id", async () => {
    const handler = vi.fn(async () => undefined);
    const transport = new SocketModeTransport(config);
    transport.onViewSubmit(handler);
    const receipt = submit("");
    await receipt.received;
    expect(handler).not.toHaveBeenCalled();
    expect(receipt.ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { b_kind: "Reopen this form." },
    });
  });

  it("does not retry an ambiguous rejected launch from the same view", async () => {
    const handler = vi.fn(async () => {
      throw new Error("EXAMPLE unknown result");
    });
    const transport = new SocketModeTransport(config);
    transport.onViewSubmit(handler);
    const first = submit("Vunknown");
    await first.received;
    const duplicate = submit("Vunknown");
    await duplicate.received;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(duplicate.ack).toHaveBeenCalledTimes(1);
  });

  it("keeps one in-flight launch after the ack budget expires", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const transport = new SocketModeTransport(config);
    transport.onViewSubmit(handler);
    const receipts = [submit("Vslow"), submit("Vslow"), submit("Vslow")];
    await vi.advanceTimersByTimeAsync(2_500);
    await Promise.all(receipts.map((item) => item.received));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(receipts.every((item) => item.ack.mock.calls.length === 1)).toBe(true);
    const late = submit("Vslow");
    await vi.advanceTimersByTimeAsync(2_500);
    await late.received;
    expect(handler).toHaveBeenCalledTimes(1);
    finish?.();
    await submit("Vslow").received;
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("Socket Mode recycle", () => {
  it("awaits the real disconnect before one restart", async () => {
    vi.useFakeTimers();
    const transport = new SocketModeTransport(config);
    await transport.start();
    sdk.active = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sdk.stops).toBe(1);
    expect(sdk.starts).toBe(1);
    sdk.active = true;
    sdk.finishDisconnect?.();
    await vi.waitFor(() => expect(sdk.starts).toBe(2));
    const stopping = transport.stop();
    await vi.waitFor(() => expect(sdk.stops).toBe(2));
    sdk.finishDisconnect?.();
    await stopping;
  });

  it("acks an in-flight view before recycling its original socket", async () => {
    vi.useFakeTimers();
    const transport = new SocketModeTransport(config);
    let finish: (() => void) | undefined;
    transport.onViewSubmit(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await transport.start();
    await vi.advanceTimersByTimeAsync(14_999);
    const receipt = submit("Vslow-recycle");
    sdk.active = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.stops).toBe(0);
    await vi.advanceTimersByTimeAsync(2_499);
    await receipt.received;
    expect(receipt.ack).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sdk.stops).toBe(1));
    expect(sdk.starts).toBe(1);
    finish?.();
    sdk.finishDisconnect?.();
    await vi.waitFor(() => expect(sdk.starts).toBe(2));
    const stopping = transport.stop();
    await vi.waitFor(() => expect(sdk.stops).toBe(2));
    sdk.finishDisconnect?.();
    await stopping;
  });

  it("does not overlap a second recycle after a slow disconnect", async () => {
    vi.useFakeTimers();
    const transport = new SocketModeTransport(config);
    await transport.start();
    sdk.active = false;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sdk.stops).toBe(1);
    expect(sdk.starts).toBe(1);
    const stopping = transport.stop();
    sdk.finishDisconnect?.();
    await stopping;
    expect(sdk.starts).toBe(1);
  });

  it("cancels a restart when shutdown starts during disconnect", async () => {
    vi.useFakeTimers();
    const transport = new SocketModeTransport(config);
    await transport.start();
    sdk.active = false;
    await vi.advanceTimersByTimeAsync(15_000);
    const shuttingDown = transport.stop();
    expect(sdk.starts).toBe(1);
    sdk.finishDisconnect?.();
    await shuttingDown;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sdk.starts).toBe(1);
    expect(sdk.stops).toBe(1);
  });
});

describe("Socket Mode users.info", () => {
  it("returns a member's username and drops deleted members", async () => {
    sdk.usersInfo = [];
    const transport = new SocketModeTransport(config);
    expect(await transport.userName("U1")).toBe("alice");
    expect(await transport.userName("U2")).toBeUndefined();
    expect(sdk.usersInfo).toEqual([{ user: "U1" }, { user: "U2" }]);
  });
});
