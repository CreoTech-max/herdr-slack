import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../config/instance.js";
import type { AgentStatus } from "../herdr/types.js";

export type TurnStatus = "working" | "done" | "blocked" | "stopped" | "failed";

export interface SessionTurn {
  id: string;
  prompt: string;
  response?: string;
  status: TurnStatus;
  createdAt: number;
  completedAt?: number;
  /** Terminal tail captured before the prompt, used only to isolate its response. */
  baseline?: string;
  /**
   * When the "agent replied" ping was posted for this turn.
   *
   * Editing the card is silent in Slack, so a reply needs a real message to
   * raise a notification. This is what keeps it to exactly one per turn — an
   * earlier design re-announced settled agents on a loop.
   */
  notifiedAt?: number;
}

export interface SessionRecord {
  /**
   * The opaque handle that travels in Block Kit payloads.
   *
   * MUST persist. Without it every live button in every existing thread fails
   * closed the moment the daemon restarts, which for a user looks like the bot
   * silently breaking.
   */
  ref: string;
  slackThreadTs?: string;
  slackChannel?: string;
  /** Deep link to the thread, so Home can jump straight to it. */
  slackPermalink?: string;
  /** Last title pushed to Slack, so we do not re-title on every repaint. */
  threadTitle?: string;
  lastKnownPaneId: string;
  agentKind: string;
  title: string;
  cwd: string;
  workspaceId: string;
  tabId: string;
  firstSeen: number;
  lastStatus: AgentStatus;
  /** Set by the orphan sweep; keeps "session ended" once-only across restarts. */
  ended: boolean;
  endedNotifiedAt: number | null;
  /** The remote-control history. Kept intentionally short and newest-last. */
  turns?: SessionTurn[];
  /** Latest manually refreshed response, including sessions started on the computer. */
  latestResponse?: string;
  /**
   * Scrollback already accounted for by a recorded turn.
   *
   * Turns driven from Slack diff against the baseline captured when the prompt
   * was sent. Turns that started at the keyboard have no such moment, so
   * without this each one would re-report the entire visible buffer and history
   * would read as the same conversation growing longer every time.
   */
  responseBaseline?: string;
  /** A user-ended remote session must not be revived just because the pane still exists. */
  closedByUser?: boolean;
}

export function registryPath(instance: string): string {
  return path.join(stateDir(instance), "sessions.json");
}

/**
 * terminal_id → session, persisted per instance.
 *
 * Namespaced like the lock and log: a shared file would let two instances
 * corrupt each other's threads.
 */
export class SessionRegistry {
  #byTerminal = new Map<string, SessionRecord>();
  #byRef = new Map<string, string>();

  constructor(private readonly instance: string) {}

  load(): void {
    const file = registryPath(this.instance);
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, SessionRecord>;
      for (const [terminalId, record] of Object.entries(parsed)) {
        this.#byTerminal.set(terminalId, record);
        this.#byRef.set(record.ref, terminalId);
      }
    } catch {
      // A corrupt registry costs thread continuity, not correctness — every ref
      // simply fails closed. Losing the daemon over it would be worse.
    }
  }

  save(): void {
    const file = registryPath(this.instance);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(this.#byTerminal), null, 2)}\n`, {
      mode: 0o600,
    });
  }

  get size(): number {
    return this.#byTerminal.size;
  }

  all(): SessionRecord[] {
    return [...this.#byTerminal.values()];
  }

  entries(): [string, SessionRecord][] {
    return [...this.#byTerminal.entries()];
  }

  get(terminalId: string): SessionRecord | undefined {
    return this.#byTerminal.get(terminalId);
  }

  /** Resolve an opaque ref. Returns undefined for anything we did not mint. */
  terminalForRef(ref: string): string | undefined {
    return this.#byRef.get(ref);
  }

  /** Record a terminal, minting a ref the first time we see it. */
  upsert(
    terminalId: string,
    fields: Omit<SessionRecord, "ref" | "firstSeen" | "ended" | "endedNotifiedAt">,
    now = Date.now(),
  ): SessionRecord {
    const existing = this.#byTerminal.get(terminalId);
    const record: SessionRecord = existing
      ? { ...existing, ...fields }
      : {
          ref: randomBytes(16).toString("hex"),
          firstSeen: now,
          ended: false,
          endedNotifiedAt: null,
          ...fields,
        };
    this.#byTerminal.set(terminalId, record);
    this.#byRef.set(record.ref, terminalId);
    return record;
  }

  setThreadTitle(terminalId: string, title: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (record) record.threadTitle = title;
  }

  setPermalink(terminalId: string, permalink: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (record) record.slackPermalink = permalink;
  }

  turns(terminalId: string): SessionTurn[] {
    return this.#byTerminal.get(terminalId)?.turns ?? [];
  }

  startTurn(
    terminalId: string,
    prompt: string,
    baseline: string,
    now = Date.now(),
  ): SessionTurn | undefined {
    const record = this.#byTerminal.get(terminalId);
    if (!record || record.ended) return undefined;
    const turn: SessionTurn = {
      id: randomBytes(12).toString("hex"),
      prompt,
      status: "working",
      createdAt: now,
      ...(baseline ? { baseline } : {}),
    };
    record.turns = [...(record.turns ?? []), turn].slice(-20);
    return turn;
  }

  activeTurn(terminalId: string): SessionTurn | undefined {
    return this.#byTerminal.get(terminalId)?.turns?.findLast((turn) => turn.status === "working");
  }

  updateTurn(
    terminalId: string,
    turnId: string,
    fields: Partial<Pick<SessionTurn, "response" | "status" | "completedAt">>,
  ): void {
    const turns = this.#byTerminal.get(terminalId)?.turns;
    const index = turns?.findIndex((item) => item.id === turnId) ?? -1;
    const turn = turns?.[index];
    if (!turn || !turns) return;
    const updated = { ...turn, ...fields };
    turns[index] =
      fields.status && fields.status !== "working"
        ? {
            id: updated.id,
            prompt: updated.prompt,
            status: updated.status,
            createdAt: updated.createdAt,
            ...(updated.response === undefined ? {} : { response: updated.response }),
            ...(updated.completedAt === undefined ? {} : { completedAt: updated.completedAt }),
            // Dropping this would re-announce the turn on the next settle.
            ...(updated.notifiedAt === undefined ? {} : { notifiedAt: updated.notifiedAt }),
          }
        : updated;
  }

  /** Claim the single "agent replied" ping for a turn; false if already sent. */
  claimTurnNotification(terminalId: string, turnId: string, now = Date.now()): boolean {
    const turn = this.#byTerminal.get(terminalId)?.turns?.find((item) => item.id === turnId);
    if (!turn || turn.notifiedAt !== undefined) return false;
    turn.notifiedAt = now;
    return true;
  }

  setLatestResponse(terminalId: string, response: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (record) record.latestResponse = response;
  }

  setResponseBaseline(terminalId: string, screen: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (record) record.responseBaseline = screen;
  }

  setThread(terminalId: string, channel: string, threadTs: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (!record) return;
    record.slackChannel = channel;
    record.slackThreadTs = threadTs;
  }

  clearThread(terminalId: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (!record) return;
    Reflect.deleteProperty(record, "slackChannel");
    Reflect.deleteProperty(record, "slackThreadTs");
    Reflect.deleteProperty(record, "slackPermalink");
    Reflect.deleteProperty(record, "threadTitle");
  }

  markEnded(terminalId: string, now = Date.now(), closedByUser = false): SessionRecord | undefined {
    const record = this.#byTerminal.get(terminalId);
    if (!record || record.ended) return undefined;
    record.ended = true;
    record.endedNotifiedAt = now;
    record.closedByUser = closedByUser;
    return record;
  }

  /** A terminal that reappeared is not ended after all. */
  revive(terminalId: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (!record || record.closedByUser) return;
    record.ended = false;
    record.endedNotifiedAt = null;
  }

  /** Opening a closed session from Home is a deliberate undo of the close. */
  reopen(terminalId: string): void {
    const record = this.#byTerminal.get(terminalId);
    if (!record) return;
    record.ended = false;
    record.endedNotifiedAt = null;
    record.closedByUser = false;
  }
}

export interface SweepResult {
  /** Threads to post "session ended" into, exactly once each. */
  orphaned: SessionRecord[];
  skipped: boolean;
}

/**
 * Reconcile the registry against live terminals after connecting.
 *
 * Needed because the daemon outlives herdr: after a reboot the registry holds
 * terminals from a server that no longer exists, and every Slack thread still
 * shows live-looking buttons.
 *
 * The zero-workspace guard matters. "Absent from the snapshot" cannot
 * distinguish *this terminal is gone* from *we caught herdr mid-restore and it
 * has nothing yet*, and because `ended` is persisted a wrong firing is
 * unrecoverable. Sweeping late is harmless; sweeping wrongly kills live threads.
 */
export function sweepOrphans(
  registry: SessionRegistry,
  liveTerminalIds: Set<string>,
  workspaceCount: number,
  now = Date.now(),
): SweepResult {
  if (workspaceCount === 0) return { orphaned: [], skipped: true };

  const orphaned: SessionRecord[] = [];
  for (const [terminalId, record] of registry.entries()) {
    if (liveTerminalIds.has(terminalId)) {
      registry.revive(terminalId);
      continue;
    }
    if (record.ended) continue;
    const ended = registry.markEnded(terminalId, now);
    if (ended) orphaned.push(ended);
  }
  return { orphaned, skipped: false };
}
