import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configPath, envPrefix } from "./instance.js";
import { command } from "./invocation.js";
import type { SecretStore } from "./secrets.js";

export const CONFIG_VERSION = 1;

/** How much terminal content is allowed to leave the machine. See SECURITY.md. */
export type ContentMode = "full" | "summary" | "titles";

export interface SlackCredentials {
  botToken: string;
  appToken: string;
  teamId: string;
  appId: string;
  botUserId: string;
}

/** Native Pi session that an operator verified was launched with the CRE executable. */
export interface CreRootBinding {
  workspaceId: string;
  terminalId: string;
  sessionId: string;
}

export interface InstanceConfig {
  label: string;
  /** Where the tokens actually live. "keychain" means they are not in this file. */
  credentialStore: "keychain" | "file";
  /** Absolute. Never read from env at runtime — under launchd there is none. */
  herdrSocketPath: string;
  slack: SlackCredentials;
  /** Empty means the daemon refuses to start. */
  allowedUsers: string[];
  /** Slack channel ID (C/G...) -> stable local herdr workspace_id. */
  channelBindings?: Record<string, string>;
  /** Attach-only mode: Slack cannot launch CLI agents. */
  creOnly?: boolean;
  /** Explicit pinned workspace, stable terminal and native Pi session tuples. */
  creRoots?: CreRootBinding[];
  /** Conversations are refused outside DMs. Always true for new installs. */
  dmOnly: boolean;
  contentMode: ContentMode;
  excludePaths: string[];
  rateBudgetPerMin: number;
  /**
   * Shared directory where every daemon for this Slack app writes heartbeats.
   *
   * Absolute path. Same-user herds can omit this (defaults under the plugin
   * config dir). Cross-account or remote herds must point every side at one
   * writable place (e.g. `/Users/Shared/herdr-slack/registry`).
   */
  herdRegistryDir?: string;
}

export interface Config {
  version: number;
  instances: Record<string, InstanceConfig>;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultInstance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    label: "",
    credentialStore: "file",
    herdrSocketPath: "",
    slack: { botToken: "", appToken: "", teamId: "", appId: "", botUserId: "" },
    allowedUsers: [],
    channelBindings: {},
    creOnly: false,
    creRoots: [],
    dmOnly: true,
    contentMode: "full",
    excludePaths: [],
    rateBudgetPerMin: 18,
    ...overrides,
  };
}

/** 0600 or refuse. A readable config is a readable bot token. */
export function assertPrivateFile(file: string): void {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new ConfigError(
      `${file} is readable by other users (mode ${mode.toString(8)})`,
      `chmod 600 ${file}`,
    );
  }
}

export function readConfigFile(file = configPath()): Config {
  if (!existsSync(file)) {
    throw new ConfigError(`no config at ${file}`, command("setup"));
  }
  assertPrivateFile(file);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(
      `${file} is not valid JSON`,
      `inspect or delete ${file}, then re-run setup`,
    );
  }
  return migrate(parsed as Config, file);
}

/**
 * Bring a config forward, or refuse.
 *
 * A *newer* version means the user downgraded herdr-slack; guessing at a schema
 * we do not know is how token files get eaten, and that is unrecoverable for the
 * user. Refusing is the kind thing.
 */
export function migrate(config: Config, file = configPath()): Config {
  const version = Number(config?.version ?? 0);
  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      `${file} was written by a newer herdr-slack (config version ${version}, this build understands ${CONFIG_VERSION})`,
      "upgrade herdr-slack, or restore a backup of the older config",
    );
  }
  if (!config?.instances || typeof config.instances !== "object") {
    throw new ConfigError(`${file} has no instances`, command("setup"));
  }
  // v1 is the first schema; future migrations chain here, each writing
  // config.json.bak-<version> before mutating.
  return { version: CONFIG_VERSION, instances: config.instances };
}

/**
 * Resolve one instance, applying env overrides.
 *
 * Env names are instance-namespaced. A bare SLACK_BOT_TOKEN exported in a shell
 * would otherwise be inherited by every daemon spawned from it — so a work token
 * in your terminal would silently feed the personal instance, which then fails
 * team pinning with a baffling error. Unprefixed names are accepted only when
 * exactly one instance exists, where there is nothing to confuse it with.
 */
export function resolveInstance(
  config: Config,
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): InstanceConfig {
  const found = config.instances[instance];
  if (!found) {
    const known = Object.keys(config.instances).join(", ") || "none";
    throw new ConfigError(
      `no configuration for instance "${instance}" (configured: ${known})`,
      command("setup"),
    );
  }

  const prefix = envPrefix(instance);
  const single = Object.keys(config.instances).length === 1;
  const pick = (field: string, bare: string): string | undefined =>
    env[`${prefix}${field}`] ?? (single ? env[bare] : undefined);

  const botToken = pick("BOT_TOKEN", "SLACK_BOT_TOKEN") ?? found.slack.botToken;
  const appToken = pick("APP_TOKEN", "SLACK_APP_TOKEN") ?? found.slack.appToken;

  return {
    ...defaultInstance(),
    ...found,
    slack: { ...found.slack, botToken, appToken },
  };
}

/**
 * Fill in credentials from the keychain.
 *
 * Kept separate from resolveInstance so config reading stays synchronous and
 * testable; only the callers that actually need to talk to Slack pay for the
 * keychain lookup. Env overrides already applied by resolveInstance win, so a
 * secrets manager can still take precedence over both.
 */
export async function withCredentials(
  instance: string,
  resolved: InstanceConfig,
  store: SecretStore,
): Promise<InstanceConfig> {
  if (resolved.credentialStore !== "keychain") return resolved;
  const botToken = resolved.slack.botToken || (await store.get(instance, "botToken")) || "";
  const appToken = resolved.slack.appToken || (await store.get(instance, "appToken")) || "";
  return { ...resolved, slack: { ...resolved.slack, botToken, appToken } };
}

/** Validate an instance is safe to run. Returns problems rather than throwing. */
export function validateInstance(instance: InstanceConfig): string[] {
  const problems: string[] = [];
  if (!instance.herdrSocketPath) problems.push("herdrSocketPath is not set");
  if (!instance.slack.botToken.startsWith("xoxb-"))
    problems.push("bot token is missing or malformed");
  if (!instance.slack.appToken.startsWith("xapp-"))
    problems.push("app-level token is missing or malformed");
  if (!instance.slack.teamId) problems.push("teamId is not pinned");
  // Not a warning. Slack access is terminal access; an open bot is a shell for
  // anyone who can DM it.
  if (instance.allowedUsers.length === 0) problems.push("allowedUsers is empty");
  const usedWorkspaces = new Set<string>();
  for (const [channel, workspaceId] of Object.entries(instance.channelBindings ?? {})) {
    if (
      !/^[CG][A-Z0-9]+$/.test(channel) ||
      typeof workspaceId !== "string" ||
      !workspaceId.trim()
    ) {
      problems.push(`invalid channel binding: ${channel}`);
    }
    if (usedWorkspaces.has(workspaceId)) {
      problems.push(`workspace bound to multiple channels: ${workspaceId}`);
    }
    usedWorkspaces.add(workspaceId);
  }
  const bound = Object.values(instance.channelBindings ?? {});
  if (bound.length && !instance.creOnly) problems.push("channelBindings requires creOnly=true");
  if (instance.creOnly && !instance.creRoots?.length)
    problems.push("creOnly requires at least one pinned creRoots entry");
  validateCreRoots(instance, bound, problems);
  if (instance.rateBudgetPerMin < 6) problems.push("rateBudgetPerMin is below the minimum (6/min)");
  return problems;
}

function validateCreRoots(instance: InstanceConfig, bound: string[], problems: string[]): void {
  const terminals = new Set<string>();
  for (const root of instance.creRoots ?? []) {
    if (
      !root ||
      typeof root.workspaceId !== "string" ||
      !root.workspaceId.trim() ||
      typeof root.terminalId !== "string" ||
      !root.terminalId.trim() ||
      typeof root.sessionId !== "string" ||
      !root.sessionId.trim()
    ) {
      problems.push("creRoots contains an incomplete binding");
      continue;
    }
    if (bound.length && !bound.includes(root.workspaceId))
      problems.push(`creRoot refers to an unbound workspace: ${root.workspaceId}`);
    if (terminals.has(root.terminalId))
      problems.push(`duplicate creRoot terminal: ${root.terminalId}`);
    terminals.add(root.terminalId);
  }
}

export function writeConfigFile(config: Config, file = configPath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // Explicit: an existing file keeps its old mode otherwise.
}

export function upsertInstance(
  instance: string,
  value: InstanceConfig,
  file = configPath(),
): Config {
  let config: Config = { version: CONFIG_VERSION, instances: {} };
  if (existsSync(file)) {
    try {
      config = readConfigFile(file);
    } catch {
      // A corrupt or unreadable config must not silently lose the other
      // instance's tokens — refuse rather than overwrite.
      throw new ConfigError(
        `${file} exists but could not be read`,
        "back it up and remove it, then re-run setup",
      );
    }
  }
  config.instances[instance] = value;
  writeConfigFile(config, file);
  return config;
}
