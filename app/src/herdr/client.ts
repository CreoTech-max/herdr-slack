import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type AgentInfo,
  HerdrError,
  type PaneInfo,
  type ReadSource,
  type SessionSnapshot,
  type TabInfo,
  type WorkspaceInfo,
  type WorktreeInfo,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;

/** Default socket for setup/CLI only — daemon reads path from config (ADR 0002). */
export function defaultSocketPath(): string {
  return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

/** Socket path for a named herdr session. */
export function sessionSocketPath(session: string): string {
  return path.join(os.homedir(), ".config", "herdr", "sessions", session, "herdr.sock");
}

/** One connection per request — herdr closes the socket on any error. */
export class HerdrClient {
  #seq = 0;

  constructor(
    readonly socketPath: string = defaultSocketPath(),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const id = `req_${++this.#seq}`;
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new HerdrError("timeout", `${method} timed out`, method))),
        timeoutMs,
      );

      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const message = JSON.parse(line) as {
            error?: { code?: string; message?: string };
            result?: T;
          };
          if (message.error) {
            const { code = "unknown", message: text = "herdr rejected the request" } =
              message.error;
            finish(() => reject(new HerdrError(code, text, method)));
            return;
          }
          finish(() => resolve(message.result as T));
        } catch {
          finish(() =>
            reject(new HerdrError("bad_response", `${method}: unparsable response`, method)),
          );
        }
      });

      socket.on("error", (cause) => {
        finish(() => reject(new HerdrError("unreachable", `${method}: ${cause.message}`, method)));
      });

      socket.on("close", () => {
        finish(() =>
          reject(new HerdrError("closed", `${method}: connection closed early`, method)),
        );
      });
    });
  }

  /** True when a herdr server is listening and answering. */
  async ping(timeoutMs = 1_500): Promise<boolean> {
    try {
      await this.request("ping", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<SessionSnapshot> {
    const result = await this.request<{ snapshot: SessionSnapshot }>("session.snapshot");
    return result.snapshot;
  }

  async agentList(): Promise<AgentInfo[]> {
    const result = await this.request<{ agents?: AgentInfo[] }>("agent.list");
    return result.agents ?? [];
  }

  async workspaceList(): Promise<WorkspaceInfo[]> {
    const result = await this.request<{ workspaces?: WorkspaceInfo[] }>("workspace.list");
    return result.workspaces ?? [];
  }

  async tabList(workspaceId?: string): Promise<TabInfo[]> {
    const result = await this.request<{ tabs?: TabInfo[] }>(
      "tab.list",
      workspaceId ? { workspace_id: workspaceId } : {},
    );
    return result.tabs ?? [];
  }

  async worktreeList(workspaceId?: string): Promise<WorktreeInfo[]> {
    const result = await this.request<{ worktrees?: WorktreeInfo[] }>(
      "worktree.list",
      workspaceId ? { workspace_id: workspaceId } : {},
    );
    return result.worktrees ?? [];
  }

  /** `pane.read` takes `pane_id`, not `target` (unlike agent.prompt/send_keys). */
  async read(
    paneId: string,
    source: ReadSource,
    lines?: number,
    timeoutMs?: number,
  ): Promise<string> {
    const result = await this.request<{ read?: { text?: string }; text?: string }>(
      "pane.read",
      {
        pane_id: paneId,
        source,
        strip_ansi: true,
        ...(lines === undefined ? {} : { lines }),
      },
      timeoutMs,
    );
    return result.read?.text ?? result.text ?? "";
  }

  async prompt(
    target: string,
    text: string,
    wait?: { until?: string[]; timeout_ms?: number },
  ): Promise<void> {
    await this.request("agent.prompt", { target, text, ...(wait ? { wait } : {}) });
  }

  /** Menu digits use send_keys — agent.prompt appends Enter. */
  async sendKeys(target: string, keys: string[]): Promise<void> {
    await this.request("agent.send_keys", { target, keys });
  }

  /** Destroys the pane and whatever runs in it. Only reached behind a confirm. */
  async paneClose(paneId: string): Promise<void> {
    await this.request("pane.close", { pane_id: paneId });
  }

  async paneGet(paneId: string): Promise<PaneInfo> {
    const result = await this.request<{ pane: PaneInfo }>("pane.get", { pane_id: paneId });
    return result.pane;
  }
}
