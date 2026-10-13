import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateDir } from "../../src/config/instance.js";
import { loadBindings, saveBindings } from "../../src/registry/bindings.js";

describe("persisted channel bindings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-bindings-"));
    process.env.HERDR_PLUGIN_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes absent from empty, and seeds config entries once", () => {
    expect(loadBindings("default")).toBeUndefined();
    const config = { C1: "w1" };
    saveBindings("default", config);
    expect(loadBindings("default")).toEqual(config);
    saveBindings("default", {});
    expect(loadBindings("default")).toEqual({});
    expect(loadBindings("default")).not.toEqual(config);
  });

  it("keeps a DM binding across restarts and protects file permissions", () => {
    saveBindings("default", { D1: "w1", C1: "w1" });
    const file = path.join(stateDir("default"), "bindings.json");
    expect(loadBindings("default")).toEqual({ D1: "w1", C1: "w1" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    chmodSync(file, 0o644);
    saveBindings("default", { D1: "w2" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects corrupt or unsafe persisted contents", () => {
    const file = path.join(stateDir("default"), "bindings.json");
    mkdirSync(path.dirname(file));
    writeFileSync(file, "{invalid", { mode: 0o600 });
    expect(loadBindings("default")).toEqual({});
    writeFileSync(file, JSON.stringify({ D1: "w1", C1: 1, __proto__: "bad" }));
    expect(loadBindings("default")).toEqual({});
    expect(readFileSync(file, "utf8")).toContain("C1");
  });
});
