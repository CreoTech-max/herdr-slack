import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_VERSION,
  type Config,
  ConfigError,
  defaultInstance,
  migrate,
  readConfigFile,
  resolveInstance,
  upsertInstance,
  validateInstance,
  writeConfigFile,
} from "../../src/config/config.js";
import { envPrefix, instanceKeyForSocket } from "../../src/config/instance.js";

describe("instanceKeyForSocket", () => {
  it("maps the unnamed session to default", () => {
    expect(instanceKeyForSocket("/Users/x/.config/herdr/herdr.sock")).toBe("default");
  });

  it("prefixes named sessions", () => {
    expect(instanceKeyForSocket("/Users/x/.config/herdr/sessions/work/herdr.sock")).toBe(
      "sess-work",
    );
  });

  it("does not let a session named 'default' collide with the unnamed one", () => {
    // The whole reason the prefix exists: a collision here would make setup
    // overwrite the other instance's tokens and pinned team.
    const unnamed = instanceKeyForSocket("/Users/x/.config/herdr/herdr.sock");
    const named = instanceKeyForSocket("/Users/x/.config/herdr/sessions/default/herdr.sock");
    expect(named).not.toBe(unnamed);
    expect(named).toBe("sess-default");
  });

  it("sanitises names that would be awkward as filenames", () => {
    expect(instanceKeyForSocket("/h/.config/herdr/sessions/a b/c.sock")).toBe("sess-a-b");
  });
});

describe("envPrefix", () => {
  it("namespaces per instance so tokens cannot cross over", () => {
    expect(envPrefix("default")).toBe("HERDR_SLACK_DEFAULT_");
    expect(envPrefix("sess-work")).toBe("HERDR_SLACK_SESS_WORK_");
  });
});

describe("config file", () => {
  let dir: string;
  let file: string;

  const complete = () =>
    defaultInstance({
      label: "personal",
      herdrSocketPath: "/tmp/herdr.sock",
      slack: {
        botToken: "xoxb-1",
        appToken: "xapp-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
      },
      allowedUsers: ["U1"],
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-config-"));
    file = path.join(dir, "config.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes 0600 and reads back", () => {
    writeConfigFile({ version: CONFIG_VERSION, instances: { default: complete() } }, file);
    const config = readConfigFile(file);
    expect(config.instances.default?.label).toBe("personal");
  });

  it("refuses a group- or world-readable config", () => {
    writeConfigFile({ version: CONFIG_VERSION, instances: { default: complete() } }, file);
    chmodSync(file, 0o644);
    const error = (() => {
      try {
        readConfigFile(file);
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.fix).toContain("chmod 600");
  });

  it("explains a missing config instead of crashing", () => {
    const error = (() => {
      try {
        readConfigFile(path.join(dir, "nope.json"));
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error?.fix).toContain("setup");
  });

  it("rejects invalid JSON with a fix, not a parse error", () => {
    writeFileSync(file, "{ nope", { mode: 0o600 });
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it("refuses a config written by a newer build rather than guessing", () => {
    // Guessing at an unknown schema is how token files get eaten, and that is
    // unrecoverable for the user.
    const future = { version: CONFIG_VERSION + 1, instances: {} } as Config;
    expect(() => migrate(future, file)).toThrow(/newer herdr-slack/);
  });

  it("carries an older config forward", () => {
    const old = { version: 0, instances: { default: complete() } } as unknown as Config;
    expect(migrate(old, file).version).toBe(CONFIG_VERSION);
  });

  it("adds an instance without disturbing the other", () => {
    upsertInstance("default", complete(), file);
    upsertInstance("sess-work", { ...complete(), label: "work" }, file);
    const config = readConfigFile(file);
    expect(Object.keys(config.instances).sort()).toEqual(["default", "sess-work"]);
    expect(config.instances.default?.label).toBe("personal");
  });

  it("refuses to overwrite a config it cannot read", () => {
    writeFileSync(file, "{ corrupt", { mode: 0o600 });
    expect(() => upsertInstance("default", complete(), file)).toThrow(ConfigError);
  });
});

describe("resolveInstance", () => {
  const base = () =>
    defaultInstance({
      herdrSocketPath: "/tmp/h.sock",
      slack: {
        botToken: "xoxb-file",
        appToken: "xapp-file",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
      },
      allowedUsers: ["U1"],
    });

  it("names a missing instance and lists what exists", () => {
    const config: Config = { version: 1, instances: { default: base() } };
    expect(() => resolveInstance(config, "sess-work")).toThrow(/sess-work/);
  });

  it("prefers an instance-namespaced env override", () => {
    const config: Config = { version: 1, instances: { default: base(), "sess-work": base() } };
    const resolved = resolveInstance(config, "sess-work", {
      HERDR_SLACK_SESS_WORK_BOT_TOKEN: "xoxb-env",
    });
    expect(resolved.slack.botToken).toBe("xoxb-env");
  });

  it("ignores a bare SLACK_BOT_TOKEN when several instances exist", () => {
    // Otherwise a work token exported in a shell silently feeds the personal
    // daemon, which then fails team pinning with a baffling error.
    const config: Config = { version: 1, instances: { default: base(), "sess-work": base() } };
    const resolved = resolveInstance(config, "default", { SLACK_BOT_TOKEN: "xoxb-leaked" });
    expect(resolved.slack.botToken).toBe("xoxb-file");
  });

  it("accepts a bare SLACK_BOT_TOKEN when there is only one instance", () => {
    const config: Config = { version: 1, instances: { default: base() } };
    const resolved = resolveInstance(config, "default", { SLACK_BOT_TOKEN: "xoxb-env" });
    expect(resolved.slack.botToken).toBe("xoxb-env");
  });
});

describe("validateInstance", () => {
  const ok = () =>
    defaultInstance({
      herdrSocketPath: "/tmp/h.sock",
      slack: { botToken: "xoxb-1", appToken: "xapp-1", teamId: "T1", appId: "A1", botUserId: "U1" },
      allowedUsers: ["U1"],
    });

  it("passes a complete instance", () => {
    expect(validateInstance(ok())).toEqual([]);
  });

  it("treats an empty allowlist as a blocker, not a warning", () => {
    expect(validateInstance({ ...ok(), allowedUsers: [] })).toContain("allowedUsers is empty");
  });

  it("catches malformed tokens", () => {
    const problems = validateInstance({
      ...ok(),
      slack: { ...ok().slack, botToken: "nope", appToken: "also-nope" },
    });
    expect(problems).toHaveLength(2);
  });

  it("catches an unpinned team", () => {
    expect(validateInstance({ ...ok(), slack: { ...ok().slack, teamId: "" } })).toContain(
      "teamId is not pinned",
    );
  });

  it("rejects a budget below the minimum", () => {
    expect(validateInstance({ ...ok(), rateBudgetPerMin: 3 })).toHaveLength(1);
  });

  it("permits channel bindings without creOnly and validates context message bounds", () => {
    expect(validateInstance({ ...ok(), channelBindings: { C123: "w1" }, creOnly: false })).toEqual(
      [],
    );
    expect(defaultInstance().contextMessages).toBe(50);
    expect(validateInstance({ ...ok(), contextMessages: 0 })).toContain(
      "contextMessages must be between 1 and 999",
    );
    expect(validateInstance({ ...ok(), contextMessages: 1000 })).toContain(
      "contextMessages must be between 1 and 999",
    );
    expect(validateInstance({ ...ok(), contextMessages: 999 })).toEqual([]);
  });

  it("defaults to full content mode so session cards show responses", () => {
    expect(defaultInstance().contentMode).toBe("full");
    expect(defaultInstance().dmOnly).toBe(true);
  });
});
