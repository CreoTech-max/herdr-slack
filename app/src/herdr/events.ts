import { EventEmitter } from "node:events";
import net from "node:net";
import type { HerdrClient } from "./client.js";
import type { SessionState } from "./state.js";
import {
  AGENT_STATUSES,
  type AgentStatus,
  type EventEnvelope,
  GLOBAL_SUBSCRIPTIONS,
} from "./types.js";

/** Full reconcile cadence — a safety net against a missed or malformed event. */
const RECONCILE_INTERVAL_MS = 30_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type TailStatus = "connecting" | "connected" | "waiting";

export interface EventTailEvents {
  status: [{ status: TailStatus; attempt: number; error?: string }];
  /** Emitted once per successful connect, after the replay has been applied. */
  ready: [];
  /**
   * Emitted after every reconcile that actually lands, on the periodic
   * cadence as well as the connect-time one. This is what "synced Ns ago"
   * should track — time since last *reconnect* looked like data staleness
   * to a healthy daemon that just hadn't reconnected in hours.
   */
  synced: [];
  /** A live event's shape didn't match what SessionState expects; dropped, not fatal. */
  applyError: [{ message: string }];
}

/**
 * Long-lived `events.subscribe` connection feeding a SessionState.
 *
 * A missing herdr socket is not fatal: herdr may simply not be running yet (the
 * daemon outlives it — ADR 0002). We back off, report `waiting`, and keep trying
 * forever so Slack can still explain *why* the herd looks empty.
 */
export class EventTail extends EventEmitter<EventTailEvents> {
  #socket: net.Socket | null = null;
  /**
   * One `pane.agent_status_changed` subscription per agent pane, by pane id.
   *
   * Verified live (herdr 0.9.3): cre/pi working → done arrives only here, not on
   * the global pane.updated stream. Each pane gets its own connection because a
   * second `events.subscribe` on one connection resets it, and one stale pane id
   * fails the whole request with `pane_not_found`.
   */
  #paneSockets = new Map<string, net.Socket>();
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #attempt = 0;
  #stopped = false;
  #status: TailStatus = "connecting";

  constructor(
    private readonly client: HerdrClient,
    private readonly state: SessionState,
  ) {
    super();
  }

  get status(): TailStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    this.state.on("changed", this.#syncPaneSubscriptions);
    this.#connect();
    this.#reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, RECONCILE_INTERVAL_MS);
    this.#reconcileTimer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconnectTimer = null;
    this.#reconcileTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.state.off("changed", this.#syncPaneSubscriptions);
    for (const socket of this.#paneSockets.values()) socket.destroy();
    this.#paneSockets.clear();
  }

  /** Pull a full snapshot and overwrite the projection. */
  async reconcile(): Promise<boolean> {
    try {
      const snapshot = await this.client.snapshot();
      this.state.applySnapshot(snapshot);
      this.emit("synced");
      return true;
    } catch {
      return false;
    }
  }

  #setStatus(status: TailStatus, error?: string): void {
    this.#status = status;
    this.emit("status", {
      status,
      attempt: this.#attempt,
      ...(error === undefined ? {} : { error }),
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setStatus("connecting");

    const socket = net.createConnection(this.client.socketPath);
    this.#socket = socket;

    socket.on("connect", () => {
      this.#attempt = 0;
      socket.write(
        `${JSON.stringify({
          id: "sub_1",
          method: "events.subscribe",
          params: { subscriptions: GLOBAL_SUBSCRIPTIONS },
        })}\n`,
      );
      this.#setStatus("connected");
    });

    onLines(socket, (line) => this.#handleLine(line));

    const restart = (reason: string) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      socket.destroy();
      this.#scheduleReconnect(reason);
    };

    socket.on("error", (error) => restart(error.message));
    socket.on("close", () => restart("connection closed"));
  }

  /** Follow the current agent panes: subscribe new ones, drop gone ones. */
  #syncPaneSubscriptions = (): void => {
    if (this.#stopped) return;
    const wanted = new Set(this.state.agentPanes().map((pane) => pane.pane_id));
    for (const [paneId, socket] of this.#paneSockets) {
      if (wanted.has(paneId)) continue;
      this.#paneSockets.delete(paneId);
      socket.destroy();
    }
    for (const paneId of wanted) {
      if (!this.#paneSockets.has(paneId)) this.#subscribePane(paneId);
    }
  };

  /**
   * A failed or closed pane connection is simply forgotten; the next state
   * change (at worst the 30s reconcile) subscribes again if the pane still has
   * an agent.
   */
  #subscribePane(paneId: string): void {
    const socket = net.createConnection(this.client.socketPath);
    this.#paneSockets.set(paneId, socket);
    const drop = () => {
      if (this.#paneSockets.get(paneId) === socket) this.#paneSockets.delete(paneId);
      socket.destroy();
    };
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: `sub_${paneId}`,
          method: "events.subscribe",
          params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }] },
        })}\n`,
      );
    });
    onLines(socket, (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const record = message as { error?: unknown; event?: unknown; data?: unknown };
      if (record.error) {
        drop();
        return;
      }
      if (record.event !== "pane.agent_status_changed") return;
      const data = record.data as { pane_id?: unknown; agent_status?: unknown } | undefined;
      const status = data?.agent_status;
      if (data?.pane_id !== paneId || !AGENT_STATUSES.includes(status as AgentStatus)) return;
      this.state.applyAgentStatus(paneId, status as AgentStatus);
    });
    socket.on("error", drop);
    socket.on("close", drop);
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // A malformed frame is survivable; the 30s reconcile repairs drift.
    }
    if (typeof message !== "object" || message === null) return;

    const record = message as Record<string, unknown>;

    // The subscribe ack. Verified against a live herdr 0.8.0: this arrives
    // BEFORE the replay of existing entities, not after — so it says nothing
    // about whether we have seen current state yet, and priming on it would
    // announce every already-running agent as a fresh transition.
    const result = record.result as { type?: string } | undefined;
    if (result?.type === "subscription_started") {
      void this.#prime();
      return;
    }
    if (record.error) return;

    const envelope = message as Partial<EventEnvelope>;
    if (envelope.data && typeof envelope.data === "object") {
      // A shape the projection doesn't expect is as survivable as a
      // malformed frame above — seen live from herdr as a `tab_created` with
      // no `tab` field, which took the whole daemon down in a crash loop
      // (2026-08-19) since nothing here was catching it. The 30s reconcile
      // repairs drift either way.
      try {
        this.state.apply(envelope.data);
      } catch (error) {
        this.emit("applyError", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Establish the silent baseline, then start announcing transitions.
   *
   * Deliberately driven by an explicit `session.snapshot` rather than by
   * counting replay frames: the ack ordering above means there is no frame that
   * reliably marks "you have now seen everything", and a heuristic there fails
   * as a notification storm. The snapshot is authoritative and also fills in
   * workspace/tab labels the replay may not resend.
   *
   * Events landing while the snapshot is in flight are applied pre-primed (so
   * silent) and then overwritten by it.
   */
  async #prime(): Promise<void> {
    // Reconnect replays subscription_started too. Without unpriming first, a
    // snapshot that catches up to idle would announce working→idle for every
    // agent that was still marked working when the socket dropped.
    this.state.markUnprimed();
    await this.reconcile();
    this.state.markPrimed();
    this.emit("ready");
  }

  #scheduleReconnect(reason: string): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#attempt += 1;
    this.#setStatus("waiting", reason);

    // Exponential backoff with jitter, capped — herdr may be down for hours.
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (this.#attempt - 1), BACKOFF_MAX_MS);
    const delay = base / 2 + Math.random() * (base / 2);

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }
}

/** Feed each complete ndjson line of a socket to `handle`. */
function onLines(socket: net.Socket, handle: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(line);
      newline = buffer.indexOf("\n");
    }
  });
}
