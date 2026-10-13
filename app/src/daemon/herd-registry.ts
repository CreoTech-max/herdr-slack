/**
 * Shared herd registry for one Slack app backed by many herdr sources.
 *
 * Each daemon writes a heartbeat here. Exactly one daemon (the primary) owns
 * Socket Mode and Home for a given Slack appId; the others run as satellites
 * and take work from the command queue. The directory can live on the same
 * machine (including `/Users/Shared/...` across macOS accounts) or on a mount
 * reachable from a remote host — the format does not care where herdr runs.
 *
 * Every record is sealed (see herd-signing.ts). A shared directory is writable
 * by other local accounts, and an unauthenticated command queue would let any
 * of them type into a terminal.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { TailStatus } from "../herdr/events.js";
import type { AgentStatus } from "../herdr/types.js";
import { seal, unseal } from "./herd-signing.js";

/** How long a heartbeat may sit before the herd is treated as gone. */
export const HEARTBEAT_STALE_MS = 20_000;
/** How often daemons rewrite their heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Ownership is reclaimed if the primary stops refreshing. */
export const OWNERSHIP_STALE_MS = 25_000;
/** A queued command this old is abandoned rather than executed late. */
export const COMMAND_STALE_MS = 60_000;

export interface HerdAgentSnapshot {
  ref: string;
  terminalId: string;
  agent: string;
  title: string;
  cwd: string;
  status: AgentStatus;
  name: string;
  workspaceId: string;
  workspaceLabel: string;
  replyPosts?: { channel: string; ts: string }[];
  permalink?: string;
}

/** What a peer needs in order to render our New agent form. */
export interface HerdLaunchOptions {
  workspaces: { id: string; label: string }[];
  worktrees: { label: string; path: string; branch?: string }[];
  /** Signed options per workspace; absent in old heartbeats, so omit their directory options. */
  worktreesByWorkspace?: Record<string, HerdLaunchOptions["worktrees"]>;
  kinds: { kind: string; label: string }[];
}

export interface HerdHeartbeat {
  /** Stable across restarts for this daemon+instance. */
  herdId: string;
  label: string;
  pid: number;
  instance: string;
  socketPath: string;
  appId: string;
  teamId: string;
  herdrStatus: TailStatus;
  agents: HerdAgentSnapshot[];
  updatedAt: number;
  role: "primary" | "satellite";
  hostname: string;
  user: string;
  launch?: HerdLaunchOptions;
}

export interface SlackOwnership {
  herdId: string;
  pid: number;
  appId: string;
  updatedAt: number;
}

export type HerdCommandOp =
  | "open_session"
  | "refresh"
  | "end_session"
  | "prompt"
  | "stop"
  | "clear"
  | "launch_agent";

export interface HerdLaunchRequest {
  kind: string;
  workspaceId?: string;
  cwd?: string;
  label?: string;
  firstPrompt?: string;
}

export interface HerdCommand {
  id: string;
  op: HerdCommandOp;
  herdId: string;
  ref: string;
  channel: string;
  threadTs?: string;
  /** Workspace fixed by the primary's bound channel or DM at command time. */
  expectedWorkspaceId?: string;
  userId: string;
  /** Prompt text, when relevant. */
  text?: string;
  launch?: HerdLaunchRequest;
  createdAt: number;
}

export interface HerdCommandResult {
  id: string;
  ok: boolean;
  message?: string;
  completedAt: number;
}

/** Default registry root: per-user, same place as plugin config. */
export function defaultHerdRegistryDir(configDir: string): string {
  return path.join(configDir, "herd-registry");
}

/** Stable id for this OS user + hostname + instance key. */
export function deriveHerdId(
  instance: string,
  hostname = os.hostname(),
  user = os.userInfo().username,
): string {
  return `${hostname}:${user}:${instance}`;
}

/**
 * Encode a Home/Open button value so the primary can route to another herd.
 * Local (primary) agents keep a bare ref for backwards compatibility.
 */
export function encodeHerdRef(herdId: string, ref: string, localHerdId: string): string {
  if (!ref) return "";
  if (herdId === localHerdId) return ref;
  return `${herdId}\u001f${ref}`;
}

export function decodeHerdRef(value: string, localHerdId: string): { herdId: string; ref: string } {
  const separator = value.indexOf("\u001f");
  if (separator <= 0) return { herdId: localHerdId, ref: value };
  return { herdId: value.slice(0, separator), ref: value.slice(separator + 1) };
}

export interface HerdRegistryOptions {
  /**
   * Whether peers running as other OS users must be able to write here.
   *
   * Shared mode widens the directory and file modes, and has to chmod
   * explicitly because the process umask masks the mode passed to mkdir/write.
   * Private mode keeps the 0700/0600 the rest of our state uses.
   */
  shared?: boolean;
}

export class HerdRegistry {
  readonly shared: boolean;

  constructor(
    readonly root: string,
    private readonly key: Buffer,
    options: HerdRegistryOptions = {},
  ) {
    this.shared = options.shared === true;
    for (const dir of [this.root, this.#heartbeatsDir(), this.#commandsDir(), this.#resultsDir()]) {
      this.#ensureDir(dir);
    }
  }

  #dirMode(): number {
    return this.shared ? 0o777 : 0o700;
  }

  #fileMode(): number {
    return this.shared ? 0o666 : 0o600;
  }

  #ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: this.#dirMode() });
    if (this.shared) {
      try {
        chmodSync(dir, this.#dirMode());
      } catch {
        // Someone else created it with workable modes, or we do not own it.
      }
    }
  }

  #write(file: string, record: unknown): void {
    // Recreate the parent every time: a peer (or a reset) can wipe the shared
    // tree between ticks, and a failed heartbeat must never take the daemon down.
    this.#ensureDir(path.dirname(file));
    writeFileSync(file, `${JSON.stringify(seal(this.key, record))}\n`, { mode: this.#fileMode() });
    if (this.shared) {
      try {
        chmodSync(file, this.#fileMode());
      } catch {
        // Not ours to chmod; the write above already succeeded.
      }
    }
  }

  #heartbeatsDir(): string {
    return path.join(this.root, "heartbeats");
  }

  #commandsDir(): string {
    return path.join(this.root, "commands");
  }

  #resultsDir(): string {
    return path.join(this.root, "results");
  }

  #ownershipPath(appId: string): string {
    return path.join(this.root, `ownership-${sanitize(appId)}.json`);
  }

  #ownershipLockPath(appId: string): string {
    return path.join(this.root, `ownership-${sanitize(appId)}.lock`);
  }

  writeHeartbeat(heartbeat: HerdHeartbeat): void {
    const file = path.join(this.#heartbeatsDir(), `${sanitize(heartbeat.herdId)}.json`);
    // Written via rename so a reader never sees a half-written heartbeat.
    const tmp = `${file}.${process.pid}.tmp`;
    this.#write(tmp, heartbeat);
    renameSync(tmp, file);
  }

  /** Live, verified heartbeats for this Slack app, freshest first. */
  listHeartbeats(appId: string, now = Date.now()): HerdHeartbeat[] {
    if (!existsSync(this.#heartbeatsDir())) return [];
    const rows: HerdHeartbeat[] = [];
    for (const name of readdirSync(this.#heartbeatsDir())) {
      if (!name.endsWith(".json")) continue;
      const parsed = this.#read<HerdHeartbeat>(path.join(this.#heartbeatsDir(), name));
      if (!parsed) continue;
      if (parsed.appId !== appId) continue;
      if (now - parsed.updatedAt > HEARTBEAT_STALE_MS) continue;
      rows.push(parsed);
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.label.localeCompare(b.label));
  }

  removeHeartbeat(herdId: string): void {
    const file = path.join(this.#heartbeatsDir(), `${sanitize(herdId)}.json`);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }

  /**
   * Claim or renew Slack ownership for this app.
   *
   * Returns true when this herd is (or becomes) the primary. A live foreign
   * owner blocks the claim; a stale owner is replaced.
   */
  async claimOwnership(input: {
    appId: string;
    herdId: string;
    pid: number;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    const lockTarget = this.#ownershipLockPath(input.appId);
    if (!existsSync(lockTarget)) this.#write(lockTarget, { lock: input.appId });

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(lockTarget, {
        realpath: false,
        stale: OWNERSHIP_STALE_MS,
        update: 5_000,
      });
    } catch {
      // Another claimant holds the lock; read and see if we already own it.
      const current = this.readOwnership(input.appId);
      return current?.herdId === input.herdId;
    }

    try {
      const current = this.readOwnership(input.appId);
      if (
        current &&
        current.herdId !== input.herdId &&
        now - current.updatedAt < OWNERSHIP_STALE_MS &&
        isPidAlive(current.pid, current.herdId, input.herdId)
      ) {
        return false;
      }
      this.#write(this.#ownershipPath(input.appId), {
        herdId: input.herdId,
        pid: input.pid,
        appId: input.appId,
        updatedAt: now,
      } satisfies SlackOwnership);
      return true;
    } finally {
      await release?.();
    }
  }

  /** Refresh the ownership timestamp while remaining primary. */
  renewOwnership(appId: string, herdId: string, pid: number, now = Date.now()): void {
    const current = this.readOwnership(appId);
    // Someone else holds it — leave it alone; election is the only place a
    // claim is taken from another herd. Missing is different: a wipe of the
    // shared tree must not leave Slack ownerless until the next restart.
    if (current && current.herdId !== herdId) return;
    this.#write(this.#ownershipPath(appId), {
      herdId,
      pid,
      appId,
      updatedAt: now,
    } satisfies SlackOwnership);
  }

  readOwnership(appId: string): SlackOwnership | null {
    return this.#read<SlackOwnership>(this.#ownershipPath(appId));
  }

  enqueueCommand(command: HerdCommand): void {
    const dir = path.join(this.#commandsDir(), sanitize(command.herdId));
    this.#ensureDir(dir);
    this.#write(path.join(dir, `${sanitize(command.id)}.json`), command);
  }

  /** Pending, verified commands for a herd, oldest first. */
  listCommands(herdId: string, now = Date.now()): HerdCommand[] {
    const dir = path.join(this.#commandsDir(), sanitize(herdId));
    if (!existsSync(dir)) return [];
    const rows: HerdCommand[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const parsed = this.#read<HerdCommand>(file);
      if (!parsed) {
        // Unverifiable: forged, corrupt, or from a daemon on another app.
        continue;
      }
      // A command that sat through a daemon restart is not worth replaying;
      // the person who pressed the button has long since moved on.
      if (now - parsed.createdAt > COMMAND_STALE_MS) {
        try {
          unlinkSync(file);
        } catch {
          // best effort
        }
        continue;
      }
      rows.push(parsed);
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  completeCommand(command: HerdCommand, result: Omit<HerdCommandResult, "id">): void {
    const file = path.join(
      this.#commandsDir(),
      sanitize(command.herdId),
      `${sanitize(command.id)}.json`,
    );
    try {
      unlinkSync(file);
    } catch {
      // already claimed
    }
    this.#write(path.join(this.#resultsDir(), `${sanitize(command.id)}.json`), {
      id: command.id,
      ...result,
    });
  }

  takeResult(commandId: string): HerdCommandResult | null {
    const file = path.join(this.#resultsDir(), `${sanitize(commandId)}.json`);
    const parsed = this.#read<HerdCommandResult>(file);
    if (!parsed) return null;
    try {
      unlinkSync(file);
    } catch {
      // keep going
    }
    return parsed;
  }

  #read<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
      return unseal<T>(this.key, JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]+/g, "_");
}

/**
 * Whether the recorded owner is still running.
 *
 * `process.kill(pid, 0)` only answers for our own machine, and it answers
 * "no such process" for a pid owned by another user only when it truly is gone
 * — EPERM means alive. A herd on a different host cannot be probed at all, so
 * a foreign host's claim is trusted until its timestamp goes stale.
 */
function isPidAlive(pid: number, ownerHerdId: string, selfHerdId: string): boolean {
  const sameHost = ownerHerdId.split(":")[0] === selfHerdId.split(":")[0];
  if (!sameHost) return true;
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
