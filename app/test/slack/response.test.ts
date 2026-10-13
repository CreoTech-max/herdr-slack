import { describe, expect, it } from "vitest";
import { extractAgentResponse } from "../../src/slack/response.js";

describe("extractAgentResponse", () => {
  it("returns only content added after the prompt baseline", () => {
    expect(
      extractAgentResponse(
        "previous answer\nImplemented the new remote session card.",
        "previous answer",
      ),
    ).toBe("Implemented the new remote session card.");
  });

  it("finds a line overlap when the terminal window has scrolled", () => {
    expect(
      extractAgentResponse(
        "second old line\nfirst new line\nsecond new line",
        "first old line\nsecond old line",
      ),
    ).toBe("first new line\nsecond new line");
  });

  it("falls back to the current screen when there is no baseline overlap", () => {
    expect(extractAgentResponse("a completely new response", "unrelated old screen")).toBe(
      "a completely new response",
    );
  });

  it("removes Cursor input chrome from the response tail", () => {
    const raw = `
The tests pass and the card now updates in place.
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  → Add a follow-up
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Composer 2.5 · 82.5% · 52 files edited
  ~/ws/herdr-slack · feat/rewrite
`;
    const response = extractAgentResponse(raw);
    expect(response).toContain("tests pass");
    expect(response).not.toContain("Add a follow-up");
    expect(response).not.toContain("Composer");
    expect(response).not.toContain("▄▄");
  });

  it("returns empty rather than presenting chrome as an answer", () => {
    expect(extractAgentResponse("▄▄▄▄▄▄▄▄▄▄\n→ Add a follow-up\n▀▀▀▀▀▀▀▀▀▀\nComposer 2.5")).toBe(
      "",
    );
  });

  it("keeps a long response line even when it begins with an arrow", () => {
    const line = `→ ${"This is response content, not an input prompt. ".repeat(3)}`;
    expect(extractAgentResponse(line)).toBe(line.trim());
  });

  it("drops Cursor's collapsed-output and expander affordances", () => {
    const raw = `
$ npm run check
... 22 output lines hidden · ctrl+o to expand
Show less
Done. The reset flow now reopens a fresh pane.
`;
    const response = extractAgentResponse(raw);
    expect(response).toContain("Done. The reset flow");
    expect(response).not.toContain("lines hidden");
    expect(response).not.toContain("ctrl+o");
    expect(response).not.toContain("Show less");
  });

  it("prefers the trailing prose block over diff and command output", () => {
    const raw = `
      }

      // Herdr could not reopen the pane — clear this TTY and continue in place.
-     io.print(\`\${dim("Could not refresh the pane")}\\n\`);
+     io.print(
+       \`\${dim("Could not refresh the pane")}\\n\`,
+     );
      clearPaneScreen(io);
      return (options.runSetupFn ?? runSetup)({
$ npm run check 2>&1 | tail -20 && npm run build 2>&1 | tail -5 10s
Done. Choosing Continue or Reset now reopens a fresh setup popup.
• Continues with resume (after admin approval) or fresh (in-progress)
• Reset wipes local setup first, then opens a clean fresh pane
`;
    const response = extractAgentResponse(raw);
    expect(response).toContain("Done. Choosing Continue or Reset");
    expect(response).toContain("• Continues with resume");
    expect(response).not.toContain("io.print");
    expect(response).not.toContain("npm run check");
    expect(response).not.toContain("clearPaneScreen");
  });

  it("falls back to the cleaned tail when a turn is only code", () => {
    const raw = "const x = 1;\nreturn x + 2;";
    expect(extractAgentResponse(raw)).toBe("const x = 1;\nreturn x + 2;");
  });

  it("keeps the first line of a reply that wraps past thirty lines", () => {
    const body = Array.from({ length: 60 }, (_, i) => `wrapped reply line ${i + 1}`).join("\n");
    const raw = `$ npm run check\nDone. Here is the summary you asked for.\n${body}`;
    const response = extractAgentResponse(raw);
    expect(response.split("\n")[0]).toBe("Done. Here is the summary you asked for.");
    expect(response).toContain("wrapped reply line 1");
    expect(response).toContain("wrapped reply line 60");
  });

  it("drops a command's output but keeps the multi-paragraph reply after it", () => {
    const raw =
      "$ npm test\n3 passed\n\nFirst paragraph of the reply.\n\nSecond paragraph of the reply.";
    expect(extractAgentResponse(raw)).toBe(
      "First paragraph of the reply.\n\nSecond paragraph of the reply.",
    );
  });

  it("keeps a reply that only mentions shell operators in prose", () => {
    const raw = [
      "Fixed. Two changes landed.",
      "",
      "• A line containing `&&` or `||` now counts as a command boundary.",
      "• A command's output region is dropped.",
      "",
      "One honest caveat: extraction still works from raw scrollback.",
    ].join("\n");
    const response = extractAgentResponse(raw);
    expect(response.startsWith("Fixed. Two changes landed.")).toBe(true);
    expect(response).toContain("command boundary");
    expect(response).toContain("One honest caveat");
  });

  it("strips a chained shell command and its output above the reply", () => {
    const raw = [
      "&& sleep 2 && node app/dist/cli.js daemon status 3.9s",
      "  started (instance default)",
      "  instance default: running (pid 60489)",
      "",
      "Implemented.",
      "• Replies now span multiple Slack section blocks.",
    ].join("\n");
    const response = extractAgentResponse(raw);
    expect(response).toBe("Implemented.\n• Replies now span multiple Slack section blocks.");
    expect(response).not.toContain("sleep 2");
    expect(response).not.toContain("pid 60489");
  });

  it("keeps the whole new region when there is a baseline, not just its last paragraph", () => {
    // A reply that ends in a list or a file reference used to lose everything
    // above its final paragraph, because trailing-prose selection walked up from
    // the bottom and stopped at the first code-looking line.
    const reply = [
      "Fixed both problems. Here is what changed.",
      "",
      "The extraction now returns the whole delta:",
      "- app/src/slack/response.ts",
      "- app/src/slack/session-controller.ts",
      "",
      "One caveat: history is not retroactive.",
    ].join("\n");

    const response = extractAgentResponse(`old screen\n${reply}`, "old screen");

    expect(response).toBe(reply);
    expect(response.startsWith("Fixed both problems.")).toBe(true);
  });

  it("keeps a command and its output when they are part of the new region", () => {
    // With a baseline the region is known to be this turn, so showing it whole
    // is right — the user asked to see the thread since the last message.
    const response = extractAgentResponse("before\n$ npm test\n3 passed\n\nAll green.", "before");
    expect(response).toContain("npm test");
    expect(response).toContain("All green.");
  });

  it("does not truncate a long extracted reply", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const response = extractAgentResponse(body);
    expect(response.startsWith("line 1\n")).toBe(true);
    expect(response).toContain("line 400");
  });
});
