import type { HerdAgentSnapshot, HerdLaunchOptions } from "../../src/daemon/herd-registry.js";
import type { HerdPort } from "../../src/slack/herd-port.js";
import type { HomeAgent, HomeHerd } from "../../src/slack/home.js";
import type { SessionController } from "../../src/slack/session-controller.js";

export interface ForwardedCommand {
  op: string;
  herdId: string;
  ref: string;
  channel: string;
  threadTs?: string;
  expectedWorkspaceId?: string;
  userId: string;
  text?: string;
  launch?: Record<string, unknown>;
}

const herd = (overrides: Partial<HomeHerd> = {}): HomeHerd => ({
  herdId: "host:me:default",
  label: "work",
  pid: 1,
  instance: "default",
  socketPath: "/tmp/a.sock",
  herdrStatus: "connected",
  role: "primary",
  hostname: "host",
  user: "me",
  agentCount: 0,
  isLocal: true,
  updatedAt: Date.now(),
  ...overrides,
});

/**
 * A herd bridge with no registry behind it.
 *
 * Surfaces only needs the port, so the multi-herd paths can be exercised
 * without a second daemon, a lockfile, or a shared directory.
 */
export class FakeHerd implements HerdPort {
  readonly forwarded: ForwardedCommand[] = [];
  attached: SessionController | null = null;
  role: "primary" | "satellite" = "primary";

  constructor(
    readonly herdId = "host:me:default",
    private herds: HomeHerd[] = [herd()],
    private foreignAgents: HomeAgent[] = [],
    private launch: Record<string, HerdLaunchOptions> = {},
    private snapshots: Record<string, HerdAgentSnapshot[]> = {},
  ) {}

  static withPeer(peerId = "host:them:default"): FakeHerd {
    return new FakeHerd(
      "host:me:default",
      [
        herd({ agentCount: 1 }),
        herd({
          herdId: peerId,
          label: "personal",
          pid: 2,
          isLocal: false,
          user: "them",
          role: "satellite",
          agentCount: 1,
          socketPath: "/tmp/b.sock",
        }),
      ],
      [
        {
          ref: "peer-ref",
          actionValue: `${peerId}\u001fpeer-ref`,
          terminalId: "term_peer",
          agent: "claude",
          title: "peer task",
          cwd: "/them/app",
          status: "idle",
          workspaceId: "",
          workspaceLabel: "their project",
          herdId: peerId,
          herdLabel: "personal",
        },
      ],
      {
        [peerId]: {
          workspaces: [{ id: "w9", label: "their workspace" }],
          worktrees: [{ label: "their-tree", path: "/them/tree", branch: "main" }],
          worktreesByWorkspace: {
            w9: [{ label: "their-tree", path: "/them/tree", branch: "main" }],
          },
          kinds: [{ kind: "claude", label: "Claude Code" }],
        },
      },
    );
  }

  setUnreachable(herdId: string): void {
    this.herds = this.herds.map((row) =>
      row.herdId === herdId ? { ...row, herdrStatus: "waiting" } : row,
    );
  }

  homeHerds(): HomeHerd[] {
    return this.herds;
  }

  homeAgents(localAgents: HomeAgent[]): HomeAgent[] {
    return [...localAgents, ...this.foreignAgents];
  }

  setPeerAgents(herdId: string, agents: HerdAgentSnapshot[]): void {
    this.snapshots[herdId] = agents;
  }

  peerAgents(herdId: string): HerdAgentSnapshot[] {
    return this.herds.find((row) => row.herdId === herdId && row.herdrStatus === "connected")
      ? (this.snapshots[herdId] ?? [])
      : [];
  }

  launchOptionsFor(herdId: string): HerdLaunchOptions | null {
    return this.launch[herdId] ?? null;
  }

  forwardCommand(input: ForwardedCommand): string {
    this.forwarded.push(input);
    return "cmd-1";
  }

  attachSessions(sessions: SessionController): void {
    this.attached = sessions;
  }
}
