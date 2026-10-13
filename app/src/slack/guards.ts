import type { InstanceConfig } from "../config/config.js";
import type { InboundContext } from "./transport.js";

/** Security boundary — every check fails closed. Held at 100% coverage. */

export type DenyReason =
  | "wrong_team"
  | "not_allowed"
  | "throttled"
  | "unknown_ref"
  | "session_ended"
  | "channel_not_permitted"
  | "workspace_mismatch"
  | "cre_root_unverified"
  | "herdr_offline";

export interface Decision {
  allowed: boolean;
  reason?: DenyReason;
  message?: string;
}

const ALLOW: Decision = { allowed: true };

const DENY_TEXT: Record<DenyReason, string> = {
  wrong_team: "This request came from a different Slack workspace.",
  not_allowed: "You are not on the allowlist for this herdr instance.",
  throttled: "Too many actions in a row — wait a moment and try again.",
  unknown_ref: "That button is from an older message and no longer works.",
  session_ended: "That session has ended.",
  channel_not_permitted: "This channel is not bound to a herdr workspace.",
  workspace_mismatch: "Agent belongs to another Herdr workspace.",
  cre_root_unverified: "This is not an operator-verified CRE session.",
  herdr_offline:
    "Your computer is not reachable right now — wake it and keep herdr running to use Slack controls.",
};

function deny(reason: DenyReason): Decision {
  return { allowed: false, reason, message: DENY_TEXT[reason] };
}

/** Per-user throttle — each allowed action becomes terminal I/O. */
export class ActionThrottle {
  #hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(userId: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.#hits.get(userId) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.#hits.set(userId, recent);
      return false;
    }
    recent.push(this.now());
    this.#hits.set(userId, recent);
    return true;
  }
}

export interface GuardDeps {
  config: InstanceConfig;
  throttle: ActionThrottle;
  /** Resolve an opaque ref to a live terminal id, or undefined. */
  resolveRef?: (ref: string) => string | undefined;
  /** Whether a terminal is still live. */
  isLive?: (terminalId: string) => boolean;
  workspaceForTerminal?: (terminalId: string) => string | undefined;
  isApprovedCreRoot?: (terminalId: string) => boolean;
  /**
   * Whether the herdr Unix socket is connected.
   *
   * Absent means "assume connected" so unit tests that do not model the tail
   * stay focused. Production always wires the live EventTail status.
   */
  isHerdrConnected?: () => boolean;
}

/** Gate any inbound interaction: workspace, identity, channel, rate. */
export function checkInbound(deps: GuardDeps, ctx: InboundContext): Decision {
  const { config, throttle } = deps;

  if (!ctx.teamId || ctx.teamId !== config.slack.teamId) return deny("wrong_team");
  if (!ctx.userId || !config.allowedUsers.includes(ctx.userId)) return deny("not_allowed");

  const bound = Object.hasOwn(config.channelBindings ?? {}, ctx.channel);
  if ((ctx.surface ?? "conversation") === "conversation" && config.dmOnly) {
    if (!ctx.channel.startsWith("D") && !bound) return deny("channel_not_permitted");
  }

  if (!throttle.check(ctx.userId)) return deny("throttled");
  return ALLOW;
}

export interface TargetResolution {
  decision: Decision;
  terminalId?: string;
}

/** Resolve opaque ref → terminal_id. Never pane_id — pane.move reassigns those. */
export function resolveTarget(deps: GuardDeps, ref: string): TargetResolution {
  if (!ref) return { decision: deny("unknown_ref") };
  const terminalId = deps.resolveRef?.(ref);
  if (!terminalId) return { decision: deny("unknown_ref") };
  if (deps.isLive && !deps.isLive(terminalId)) return { decision: deny("session_ended") };
  return { decision: ALLOW, terminalId };
}

/**
 * Fail closed when herdr is down.
 *
 * Sleep freezes the whole machine, so Slack cannot be updated then either —
 * this covers the awake-but-herdr-down case (and any stale button that was
 * rendered before a disconnect). Home Refresh stays on `checkInbound` alone
 * so the user can still poke the UI while waiting.
 */
export function requireHerdr(deps: GuardDeps): Decision {
  if (deps.isHerdrConnected && !deps.isHerdrConnected()) return deny("herdr_offline");
  return ALLOW;
}

/** Identity + herdr reachability + ref resolution, in that order. */
export function authorizeAction(
  deps: GuardDeps,
  ctx: InboundContext,
  ref: string,
): TargetResolution {
  const inbound = checkInbound(deps, ctx);
  if (!inbound.allowed) return { decision: inbound };
  const herdr = requireHerdr(deps);
  if (!herdr.allowed) return { decision: herdr };
  const target = resolveTarget(deps, ref);
  if (!target.decision.allowed || !target.terminalId) return target;
  const workspaceId = deps.config.channelBindings?.[ctx.channel];
  if (
    !ctx.channel.startsWith("D") &&
    workspaceId &&
    deps.workspaceForTerminal?.(target.terminalId) !== workspaceId
  ) {
    return { decision: deny("workspace_mismatch") };
  }
  if (deps.config.creOnly && deps.isApprovedCreRoot?.(target.terminalId) !== true) {
    return { decision: deny("cre_root_unverified") };
  }
  return target;
}
