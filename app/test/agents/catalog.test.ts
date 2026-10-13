import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  configuredKinds,
  findEntry,
  findMode,
  loadCatalog,
  readUserCatalog,
  writeExampleCatalog,
} from "../../src/agents/catalog.js";

describe("catalog", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hs-cat-"));
    file = path.join(dir, "agents.toml");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("offers every kind herdr can start", () => {
    const catalog = loadCatalog(file);
    // + the typed `cre` entry, which herdr cannot start itself.
    expect(catalog).toHaveLength(AGENT_KINDS.length + 1);
    expect(catalog.map((e) => e.kind)).toContain("claude");
    expect(catalog.map((e) => e.kind)).toContain("qodercli");
  });

  it("gives unverified kinds a bare default rather than guessed flags", () => {
    // A mode that fails at launch is worse than no mode.
    const entry = findEntry(loadCatalog(file), "kimi");
    expect(entry?.modes).toHaveLength(1);
    expect(entry?.modes[0]?.args).toEqual([]);
  });

  it("seeds the modes that have been verified", () => {
    const claude = findEntry(loadCatalog(file), "claude");
    expect(claude?.modes.map((m) => m.id)).toContain("plan");
    expect(findMode(claude, "plan")?.args).toEqual(["--permission-mode", "plan"]);
  });

  it("lets a user override a seeded kind", () => {
    writeFileSync(
      file,
      [
        "[claude]",
        'label = "Mine"',
        "modes = [",
        '  { id = "custom", label = "Custom", args = ["--x"] },',
        "]",
      ].join("\n"),
    );
    const claude = findEntry(loadCatalog(file), "claude");
    expect(claude?.label).toBe("Mine");
    expect(claude?.modes.map((m) => m.id)).toEqual(["custom"]);
  });

  it("lets a user add modes for an unseeded kind", () => {
    writeFileSync(
      file,
      ["[gemini]", "modes = [", '  { id = "fast", label = "Fast", args = ["--fast"] },', "]"].join(
        "\n",
      ),
    );
    expect(findMode(findEntry(loadCatalog(file), "gemini"), "fast")?.args).toEqual(["--fast"]);
  });

  it("degrades to the seeded catalog on a malformed file", () => {
    // A typo in an optional config must not stop the daemon.
    writeFileSync(file, "this is not [ valid toml");
    expect(readUserCatalog(file)).toEqual([]);
    expect(findMode(findEntry(loadCatalog(file), "claude"), "plan")).toBeDefined();
  });

  it("ignores modes missing an id", () => {
    writeFileSync(file, ["[claude]", "modes = [", '  { label = "No id" },', "]"].join("\n"));
    const claude = findEntry(loadCatalog(file), "claude");
    expect(claude?.modes).toHaveLength(1);
    expect(claude?.modes[0]?.id).toBe("default");
  });

  it("drops non-string args rather than passing them to herdr", () => {
    writeFileSync(
      file,
      ["[claude]", "modes = [", '  { id = "odd", args = ["--ok", 42] },', "]"].join("\n"),
    );
    expect(findMode(findEntry(loadCatalog(file), "claude"), "odd")?.args).toEqual(["--ok"]);
  });

  it("lists only kinds worth offering a mode choice", () => {
    const kinds = configuredKinds(loadCatalog(file)).map((e) => e.kind);
    expect(kinds).toContain("claude");
    expect(kinds).not.toContain("kimi");
  });

  it("writes an example file that parses back", () => {
    writeExampleCatalog(file);
    expect(findMode(findEntry(loadCatalog(file), "claude"), "plan")?.args).toEqual([
      "--permission-mode",
      "plan",
    ]);
  });

  it("offers cre, launched by typing its command", () => {
    expect(findEntry(loadCatalog(file), "cre")).toMatchObject({ kind: "cre", command: "cre" });
  });

  it("keeps cre's command when agents.toml overrides its label", () => {
    // The command is not read from TOML; a user entry must not erase it.
    writeFileSync(file, '[cre]\nlabel = "My CRE"\ncommand = "rm -rf /"\n');
    expect(findEntry(loadCatalog(file), "cre")).toMatchObject({ label: "My CRE", command: "cre" });
  });

  it("gives herdr-native kinds no command", () => {
    expect(findEntry(loadCatalog(file), "claude")?.command).toBeUndefined();
  });

  it("does not overwrite an existing catalog", () => {
    writeFileSync(file, '[claude]\nlabel = "Kept"\n');
    writeExampleCatalog(file);
    expect(findEntry(loadCatalog(file), "claude")?.label).toBe("Kept");
  });
});
