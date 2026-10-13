/**
 * What Surfaces needs from the herd bridge.
 *
 * Stated as a port for the same reason `log` is one: Surfaces should be
 * testable without a registry directory, a lockfile, or a second daemon.
 * `HerdBridge` satisfies this structurally — there is no `implements` to keep
 * in sync.
 */

import type {
  HerdAgentSnapshot,
  HerdCommandOp,
  HerdLaunchOptions,
  HerdLaunchRequest,
} from "../daemon/herd-registry.js";
import type { HomeAgent, HomeHerd } from "./home.js";
import type { SessionController } from "./session-controller.js";

export interface HerdPort {
  /** This daemon's herd id. */
  readonly herdId: string;
  readonly role: "primary" | "satellite";
  /** Every live herd on this Slack app, including this one. */
  homeHerds(): HomeHerd[];
  /** Local agents merged with peers', with Open values routed per herd. */
  homeAgents(localAgents: HomeAgent[]): HomeAgent[];
  /** Verified agents from one live peer heartbeat. */
  peerAgents(herdId: string): HerdAgentSnapshot[];
  /** What a herd can launch into, or null if it is not reporting in. */
  launchOptionsFor(herdId: string): HerdLaunchOptions | null;
  /** Queue work for another herd. Returns the command id. */
  forwardCommand(input: {
    op: HerdCommandOp;
    herdId: string;
    ref: string;
    channel: string;
    threadTs?: string;
    expectedWorkspaceId?: string;
    userId: string;
    text?: string;
    launch?: HerdLaunchRequest;
  }): string;
  attachSessions(sessions: SessionController): void;
}
