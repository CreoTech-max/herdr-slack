import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchAgent, sanitizeAgentName } from "../../src/agents/launcher.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { FakeHerdr } from "../helpers/fake-herdr.js";

const noSleep = async () => undefined;

describe("sanitizeAgentName", () => {
  it.each([
    ["Fix Auth", "fix-auth"],
    ["FIX_AUTH", "fix_auth"],
    ["123-start", "start"],
    ["ok-name", "ok-name"],
  ])("turns %o into a name herdr accepts", (input, expected) => {
    const result = sanitizeAgentName(input);
    expect(result).toBe(expected);
    expect(result).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("invents a name when nothing usable remains", () => {
    expect(sanitizeAgentName("!!!")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("truncates to herdr's limit", () => {
    expect(sanitizeAgentName("a".repeat(100)).length).toBeLessThanOrEqual(32);
  });
});

describe("launchAgent", () => {
  let fake: FakeHerdr;
  let client: HerdrClient;

  const request = (overrides = {}) => ({
    kind: "claude",
    name: "worker",
    mode: { id: "plan", label: "Plan", args: ["--permission-mode", "plan"] },
    ...overrides,
  });

  beforeEach(async () => {
    fake = await FakeHerdr.start();
    client = new HerdrClient(fake.socketPath, 1_000);
  });

  afterEach(async () => {
    await fake.stop();
  });

  const tabCreates = () =>
    fake.on("tab.create", () => ({
      tab: { tab_id: "w1:t9" },
      root_pane: { pane_id: "w1:p9" },
    }));

  it("creates a tab, waits for the shell, then starts the agent", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));

    const result = await launchAgent(client, request(), { sleep: noSleep });

    // paneId comes from root_pane, not the tab id — only root_pane is startable.
    expect(result).toMatchObject({ ok: true, paneId: "w1:p9", tabId: "w1:t9" });
    const started = fake.requests.find((r) => r.method === "agent.start");
    expect(started?.params).toMatchObject({
      name: "worker",
      kind: "claude",
      pane_id: "w1:p9",
      args: ["--permission-mode", "plan"],
    });
  });

  it("omits args entirely for a default mode", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));

    await launchAgent(client, request({ mode: { id: "default", label: "Default", args: [] } }), {
      sleep: noSleep,
    });

    expect(fake.requests.find((r) => r.method === "agent.start")?.params).not.toHaveProperty(
      "args",
    );
  });

  it("waits while the shell is still busy, then starts", async () => {
    tabCreates();
    let calls = 0;
    fake.on("pane.process_info", () => ({
      process: { foreground_command: ++calls < 3 ? "zsh-startup" : null },
    }));
    fake.on("agent.start", () => ({ ok: true }));

    const result = await launchAgent(client, request(), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("retries once when the shell was a beat slower than the poll", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    let attempts = 0;
    fake.on("agent.start", () => (++attempts === 1 ? new Error("pane is busy") : { ok: true }));

    const result = await launchAgent(client, request(), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("gives up after the retry with a readable message", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => new Error("pane is busy"));

    const result = await launchAgent(client, request(), { sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not start claude");
    expect(result.message).not.toContain("Error:");
  });

  it("reports a failure to create the tab", async () => {
    fake.on("tab.create", () => new Error("no such workspace"));
    const result = await launchAgent(client, request({ workspaceId: "w99" }), { sleep: noSleep });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("could not create a tab");
  });

  it("reports a tab with no pane rather than starting nothing", async () => {
    fake.on("tab.create", () => ({ tab: { tab_id: "w1:t1" } }));
    const result = await launchAgent(client, request(), { sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no pane");
  });

  it("captures the Pi boundary before a fast first reply and never prompts when capture fails", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "pi" } }));
    fake.on("agent.prompt", () => ({ ok: true }));
    const seen: string[] = [];
    const captured = await launchAgent(
      client,
      request({
        firstPrompt: "fast",
        beforeFirstPrompt: async (paneId: string) => {
          seen.push(`capture:${paneId}`);
          expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(0);
          return { path: "/trusted/file.jsonl", sessionId: "EXAMPLE", entryId: null };
        },
      }),
      { sleep: noSleep },
    );
    expect(captured).toMatchObject({ promptDelivered: true, piBoundary: { sessionId: "EXAMPLE" } });
    expect(seen).toEqual(["capture:w1:p9"]);
    fake.requests.length = 0;
    const rejected = await launchAgent(
      client,
      request({
        firstPrompt: "do not send",
        beforeFirstPrompt: async () => {
          throw new Error("unsafe path");
        },
      }),
      { sleep: noSleep },
    );
    expect(rejected).toMatchObject({ ok: true, promptDelivered: false });
    expect(fake.requests.filter((row) => row.method === "agent.prompt")).toHaveLength(0);
    expect(rejected.message).not.toContain("unsafe path");
  });

  it("sends the first prompt after the agent is up", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    fake.on("agent.prompt", () => ({ ok: true }));

    await launchAgent(client, request({ firstPrompt: "do the thing" }), { sleep: noSleep });

    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      target: "w1:p9",
      text: "do the thing",
    });
  });

  it("waits for the agent to settle and makes herdr confirm the prompt took", async () => {
    // A registered agent can still be on a welcome or trust screen, which eats
    // anything typed: the launch looks fine and the input box stays empty.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    fake.on("agent.wait", () => ({ ok: true }));
    fake.on("agent.prompt", () => ({ ok: true }));

    const result = await launchAgent(client, request({ firstPrompt: "do the thing" }), {
      sleep: noSleep,
    });

    expect(fake.requests.find((r) => r.method === "agent.wait")?.params).toMatchObject({
      target: "w1:p9",
      until: ["idle", "blocked", "done"],
    });
    expect(fake.requests.find((r) => r.method === "agent.prompt")?.params).toMatchObject({
      target: "w1:p9",
      text: "do the thing",
      wait: { until: ["working", "done"] },
    });
    expect(result.promptDelivered).toBe(true);
  });

  it("resends once when the agent never reacts, then gives up", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    fake.on("agent.wait", () => ({ ok: true }));
    fake.on("agent.prompt", () =>
      Object.assign(new Error("agent did not react"), { code: "agent_prompt_stalled" }),
    );

    const result = await launchAgent(client, request({ firstPrompt: "go" }), { sleep: noSleep });

    // Twice, not five times: a resend risks typing the prompt into a merely
    // slow agent a second time.
    expect(fake.requests.filter((r) => r.method === "agent.prompt")).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.promptDelivered).toBe(false);
    expect(result.message).toContain("did not land");
  });

  it("still reports success when only the first prompt failed", async () => {
    // The agent is running; saying "launch failed" would be wrong and would
    // send the user hunting for a tab that exists.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    fake.on("agent.prompt", () => new Error("stalled"));

    const result = await launchAgent(client, request({ firstPrompt: "hi" }), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("first prompt did not land");
  });

  it("waits for herdr to register the agent before prompting it", async () => {
    // agent.start returning is not the same as the agent being resolvable:
    // prompting straight away fails with "is not an active named agent",
    // because agent.prompt resolves through the agent registry.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    let gets = 0;
    fake.on("agent.get", () => {
      gets += 1;
      // Not registered for the first two polls, as in the real race.
      return gets < 3 ? new Error("not an active named agent") : { agent: { agent: "claude" } };
    });
    fake.on("agent.prompt", () => ({ ok: true }));

    const result = await launchAgent(client, request({ firstPrompt: "go" }), {
      sleep: noSleep,
      agentReadyTimeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    expect(gets).toBeGreaterThanOrEqual(3);
    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(true);
  });

  it("prompts anyway if registration never shows up, rather than inventing a failure", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => new Error("never registers"));
    fake.on("agent.prompt", () => ({ ok: true }));

    const result = await launchAgent(client, request({ firstPrompt: "go" }), {
      sleep: noSleep,
      readyTimeoutMs: 20,
      agentReadyTimeoutMs: 20,
    });

    expect(result.ok).toBe(true);
    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(true);
  });

  it("finds a free name when the label is already taken", async () => {
    // herdr requires unique names among live agents and exposes no way to list
    // them, so reusing a label failed the entire launch.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    const tried: string[] = [];
    fake.on("agent.start", (params) => {
      const name = String(params.name);
      tried.push(name);
      return name === "build" ? new Error("agent name build is already used") : { ok: true };
    });

    const result = await launchAgent(client, request({ name: "build" }), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(tried).toEqual(["build", "build-2"]);
  });

  it("gives up rather than trying names forever", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    let tries = 0;
    fake.on("agent.start", () => {
      tries += 1;
      return new Error("agent name build is already used");
    });

    const result = await launchAgent(client, request({ name: "build" }), { sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already used");
    expect(tries).toBeLessThanOrEqual(6);
  });

  it("keeps a suffixed name inside herdr's length limit", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    const tried: string[] = [];
    fake.on("agent.start", (params) => {
      const name = String(params.name);
      tried.push(name);
      return tried.length === 1 ? new Error("agent name is already used") : { ok: true };
    });

    await launchAgent(client, request({ name: "a".repeat(32) }), { sleep: noSleep });

    expect(tried[1]?.length).toBeLessThanOrEqual(32);
    expect(tried[1]?.endsWith("-2")).toBe(true);
  });

  it("does not treat an ordinary failure as a name clash", async () => {
    // A slow shell gets one retry with the *same* name; cycling through names
    // would just start the same agent under a different label.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    const tried: string[] = [];
    fake.on("agent.start", (params) => {
      tried.push(String(params.name));
      return new Error("pane is not at a shell prompt");
    });

    const result = await launchAgent(client, request({ name: "build" }), { sleep: noSleep });

    expect(result.ok).toBe(false);
    expect(new Set(tried)).toEqual(new Set(["build"]));
  });

  it("retries a first prompt that lands before herdr resolves the agent", async () => {
    // agent.get answering is not quite agent.prompt accepting the target, and
    // that gap reported failure for an agent sitting there perfectly alive.
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    let prompts = 0;
    fake.on("agent.prompt", () => {
      prompts += 1;
      return prompts < 3 ? new Error("agent w2:p3 is not an active named agent") : { ok: true };
    });

    const result = await launchAgent(client, request({ firstPrompt: "go" }), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    expect(prompts).toBe(3);
  });

  it("does not retry a prompt that failed for some other reason", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));
    fake.on("agent.get", () => ({ agent: { agent: "claude" } }));
    let prompts = 0;
    fake.on("agent.prompt", () => {
      prompts += 1;
      return new Error("agent prompt must not be empty");
    });

    const result = await launchAgent(client, request({ firstPrompt: "go" }), { sleep: noSleep });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("first prompt did not land");
    expect(prompts).toBe(1);
  });

  it("skips an empty first prompt", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));

    await launchAgent(client, request({ firstPrompt: "   " }), { sleep: noSleep });

    expect(fake.requests.some((r) => r.method === "agent.prompt")).toBe(false);
  });

  it("proceeds when herdr cannot answer process_info", async () => {
    tabCreates();
    fake.on("agent.start", () => ({ ok: true }));
    const result = await launchAgent(client, request(), { sleep: noSleep });
    expect(result.ok).toBe(true);
  });

  it("passes cwd and workspace through to tab.create", async () => {
    tabCreates();
    fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
    fake.on("agent.start", () => ({ ok: true }));

    await launchAgent(client, request({ workspaceId: "w2", cwd: "/work/app", label: "fix auth" }), {
      sleep: noSleep,
    });

    expect(fake.requests.find((r) => r.method === "tab.create")?.params).toMatchObject({
      workspace_id: "w2",
      cwd: "/work/app",
      label: "fix auth",
      focus: false,
    });
  });

  /**
   * herdr cannot start cre (`agent.start` has no command override), so it is
   * typed into the fresh shell, detected as `pi`, then named with agent.rename.
   * Verified live in the T0 spike against herdr 0.9.3.
   */
  describe("typed launch", () => {
    const typed = (overrides = {}) =>
      request({
        kind: "cre",
        command: "cre",
        mode: { id: "default", label: "D", args: [] },
        ...overrides,
      });
    const methods = () => fake.requests.map((r) => r.method);

    beforeEach(() => {
      tabCreates();
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("pane.send_text", () => ({ ok: true }));
      fake.on("agent.get", () => ({ agent: { agent: "pi" } }));
      fake.on("agent.wait", () => ({ ok: true }));
      fake.on("agent.prompt", () => ({ ok: true }));
    });

    it("types the command, then names the agent, and never calls agent.start", async () => {
      fake.on("agent.rename", () => ({ agent: { name: "worker" } }));

      const result = await launchAgent(client, typed(), { sleep: noSleep });

      expect(result).toMatchObject({ ok: true, paneId: "w1:p9", tabId: "w1:t9" });
      expect(fake.requests.find((r) => r.method === "pane.send_text")?.params).toEqual({
        pane_id: "w1:p9",
        text: "cre\n",
      });
      expect(fake.requests.find((r) => r.method === "agent.rename")?.params).toEqual({
        target: "w1:p9",
        name: "worker",
      });
      expect(methods()).not.toContain("agent.start");
      const order = methods();
      expect(order.indexOf("pane.send_text")).toBeLessThan(order.indexOf("agent.get"));
      expect(order.indexOf("agent.get")).toBeLessThan(order.indexOf("agent.rename"));
    });

    it("walks to a free name when the requested one is taken", async () => {
      const tried: string[] = [];
      fake.on("agent.rename", (params) => {
        tried.push(String(params.name));
        return params.name === "build"
          ? Object.assign(new Error("refused"), { code: "agent_name_taken" })
          : { agent: { name: params.name } };
      });

      const result = await launchAgent(client, typed({ name: "build" }), { sleep: noSleep });

      expect(result.ok).toBe(true);
      expect(tried).toEqual(["build", "build-2"]);
    });

    it("sends the first prompt only after the agent has its name", async () => {
      fake.on("agent.rename", () => ({ agent: { name: "worker" } }));

      const result = await launchAgent(client, typed({ firstPrompt: "go" }), { sleep: noSleep });

      expect(result.promptDelivered).toBe(true);
      expect(methods().indexOf("agent.rename")).toBeLessThan(methods().indexOf("agent.prompt"));
    });

    it("reports a shell that will not take the command", async () => {
      fake.on("pane.send_text", () => new Error("pane is gone"));

      const result = await launchAgent(client, typed(), { sleep: noSleep });

      expect(result).toMatchObject({ ok: false, paneId: "w1:p9" });
      expect(result.message).toContain("could not start cre");
      expect(methods()).not.toContain("agent.rename");
    });
  });

  it.each(["bind", "unbind", "agents", "new", "help"])(
    "refuses the command word %s as a name before creating a tab",
    async (name) => {
      tabCreates();
      const result = await launchAgent(client, request({ name }), { sleep: noSleep });

      expect(result).toEqual({
        ok: false,
        message: `${name} is a command word; pick another name.`,
      });
      expect(fake.requests.some((r) => r.method === "tab.create")).toBe(false);
    },
  );

  /**
   * herdr accepts a duplicate label without complaint, and two tabs with the
   * same name are indistinguishable in Home, in the terminal, and in thread
   * titles. Unlike agent names, nothing else catches this.
   */
  describe("tab labels", () => {
    const createdLabel = (): unknown =>
      (fake.requests.find((r) => r.method === "tab.create")?.params as { label?: unknown })?.label;

    const launchWithLabel = async (label: string, existing: string[]): Promise<void> => {
      tabCreates();
      fake.on("tab.list", () => ({
        tabs: existing.map((l, i) => ({ tab_id: `t${i}`, label: l })),
      }));
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("agent.start", () => ({ ok: true }));
      await launchAgent(client, request({ label }), { sleep: noSleep });
    };

    it("keeps the asked-for label when nothing else has it", async () => {
      await launchWithLabel("review", ["build", "deploy"]);
      expect(createdLabel()).toBe("review");
    });

    it("numbers a label a live tab is already using", async () => {
      await launchWithLabel("review", ["review"]);
      expect(createdLabel()).toBe("review 2");
    });

    it("keeps counting past the numbered ones", async () => {
      await launchWithLabel("review", ["review", "review 2", "review 3"]);
      expect(createdLabel()).toBe("review 4");
    });

    it("treats a label as taken whatever its case", async () => {
      await launchWithLabel("Review", ["review"]);
      expect(createdLabel()).toBe("Review 2");
    });

    it("launches anyway when herdr will not list tabs", async () => {
      // A duplicate label is a far smaller problem than refusing to start.
      // tab.list is deliberately left unanswered.
      tabCreates();
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("agent.start", () => ({ ok: true }));

      const result = await launchAgent(client, request({ label: "review" }), { sleep: noSleep });
      expect(result.ok).toBe(true);
      expect(createdLabel()).toBe("review");
    });

    it("does not ask herdr for tabs when no label was given", async () => {
      tabCreates();
      fake.on("pane.process_info", () => ({ process: { foreground_command: null } }));
      fake.on("agent.start", () => ({ ok: true }));
      await launchAgent(client, request(), { sleep: noSleep });
      expect(fake.requests.some((r) => r.method === "tab.list")).toBe(false);
    });
  });
});
