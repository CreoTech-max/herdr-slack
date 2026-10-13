import { describe, expect, it } from "vitest";
import { RESERVED, parseMention } from "../../src/slack/commands.js";

describe("parseMention", () => {
  it("recognizes each reserved command before agent names", () => {
    expect(RESERVED).toEqual(["bind", "unbind", "agents", "new", "help"]);
    for (const kind of RESERVED) {
      expect(parseMention(`<@UBOT> ${kind} me`, "UBOT")).toEqual({ kind });
    }
  });

  it("parses prompt, context, stop and clear for valid agent names", () => {
    expect(parseMention("<@UBOT> build fix it", "UBOT")).toEqual({
      kind: "agent",
      name: "build",
      verb: "prompt",
      text: "fix it",
    });
    expect(parseMention("<@UBOT> build context fix it", "UBOT")).toEqual({
      kind: "agent",
      name: "build",
      verb: "context",
      text: "fix it",
    });
    expect(parseMention("<@UBOT> build stop", "UBOT")).toEqual({
      kind: "agent",
      name: "build",
      verb: "stop",
      text: "",
    });
    expect(parseMention("build clear", "UBOT")).toEqual({
      kind: "agent",
      name: "build",
      verb: "clear",
      text: "",
    });
    expect(parseMention("what needs my attention", "UBOT")).toEqual({
      kind: "agent",
      name: "what",
      verb: "prompt",
      text: "needs my attention",
    });
  });

  it("rejects missing prompt text and invalid names", () => {
    expect(parseMention("<@UBOT> build", "UBOT")).toEqual({ kind: "unknown" });
    expect(parseMention("build context", "UBOT")).toEqual({ kind: "unknown" });
    expect(parseMention("Bad hi", "UBOT")).toEqual({ kind: "unknown" });
    expect(parseMention(`${"a".repeat(33)} hi`, "UBOT")).toEqual({ kind: "unknown" });
    expect(parseMention("build stop extra", "UBOT")).toEqual({ kind: "unknown" });
  });
});
