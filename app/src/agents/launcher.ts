import type { HerdrClient } from "../herdr/client.js";
import { HerdrError } from "../herdr/types.js";
import { RESERVED } from "../slack/commands.js";
import type { AgentMode } from "./catalog.js";

/** How long to wait for a freshly created tab's shell to settle. */
export const SHELL_READY_TIMEOUT_MS = 5_000;
/** Wait for herdr agent registration before the first prompt. */
export const AGENT_READY_TIMEOUT_MS = 45_000;
/** How long herdr should wait for the agent to react to the first prompt. */
export const PROMPT_REACTION_TIMEOUT_MS = 15_000;
const SHELL_POLL_MS = 250;

export interface LaunchRequest {
  workspaceId?: string;
  cwd?: string;
  label?: string;
  kind: string;
  mode: AgentMode;
  /** Unique among live agents; herdr enforces [a-z][a-z0-9_-]{0,31}. */
  name: string;
  firstPrompt?: string;
  /** Typed into the shell instead of `agent.start` (catalog `command`). */
  command?: string | undefined;
}

export interface LaunchResult {
  ok: boolean;
  paneId?: string;
  tabId?: string;
  message?: string;
  /** Present only when a first prompt was asked for; false means it was lost. */
  promptDelivered?: boolean;
}

/** How many names to try before giving up on finding a free one. */
const NAME_ATTEMPTS = 5;
/** herdr's cap on an agent name. */
const NAME_LIMIT = 32;
/** How many tab labels to try before falling back to something unique. */
const LABEL_ATTEMPTS = 50;

/** Whether herdr refused because the name is already taken by a live agent. */
function isNameTaken(error: unknown): boolean {
  if (error instanceof HerdrError && error.code === "agent_name_taken") return true;
  const message = error instanceof HerdrError ? error.message : "";
  return /already used|already in use|name.*taken/i.test(message);
}

/** `build` → `build-2`, keeping inside herdr's length limit. */
function suffixed(name: string, n: number): string {
  const tail = `-${n}`;
  return `${name.slice(0, NAME_LIMIT - tail.length)}${tail}`;
}

/**
 * A tab label no live tab is already using.
 *
 * herdr accepts duplicates happily, and the result is two tabs called "review"
 * — in the terminal, in Home, and in the thread titles — with nothing to tell
 * them apart. Agent *names* are deduplicated by herdr refusing them, but labels
 * have no such backstop, so the check is ours to make.
 *
 * Comparison is case-insensitive because "Review" and "review" are the same tab
 * to anyone reading the list.
 */
export async function freeTabLabel(client: HerdrClient, wanted: string): Promise<string> {
  const label = wanted.trim();
  if (!label) return label;

  let taken: Set<string>;
  try {
    taken = new Set(
      (await client.tabList())
        .map((tab) => tab.label?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value)),
    );
  } catch {
    // herdr did not answer. A duplicate label is a much smaller problem than
    // refusing to launch over one, so take the name as asked.
    return label;
  }

  if (!taken.has(label.toLowerCase())) return label;
  for (let n = 2; n <= LABEL_ATTEMPTS; n += 1) {
    const candidate = `${label} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${label} ${Date.now().toString(36).slice(-4)}`;
}

/** herdr's own constraint on agent names. */
export function sanitizeAgentName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
  return cleaned || `agent-${Date.now().toString(36).slice(-6)}`;
}

/** Create a tab, wait for shell readiness, then start the agent. */
export async function launchAgent(
  client: HerdrClient,
  request: LaunchRequest,
  options: {
    readyTimeoutMs?: number;
    agentReadyTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LaunchResult> {
  const {
    readyTimeoutMs = SHELL_READY_TIMEOUT_MS,
    agentReadyTimeoutMs = AGENT_READY_TIMEOUT_MS,
    sleep = defaultSleep,
  } = options;

  // A name equal to a mention command could never be addressed as an agent.
  if ((RESERVED as readonly string[]).includes(request.name)) {
    return { ok: false, message: `${request.name} is a command word; pick another name.` };
  }

  const label = request.label ? await freeTabLabel(client, request.label) : "";

  let paneId: string;
  let tabId: string;
  try {
    const created = await client.request<{
      tab?: { tab_id?: string };
      root_pane?: { pane_id?: string };
    }>("tab.create", {
      ...(request.workspaceId ? { workspace_id: request.workspaceId } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(label ? { label } : {}),
      focus: false,
    });
    // agent.start needs root_pane from tab.create.
    paneId = created.root_pane?.pane_id ?? "";
    tabId = created.tab?.tab_id ?? "";
    if (!paneId) return { ok: false, message: "herdr created a tab but reported no pane." };
  } catch (error) {
    return { ok: false, message: explain(error, "could not create a tab") };
  }

  await waitForShell(client, paneId, readyTimeoutMs, sleep);

  let start: (name: string) => Promise<unknown>;
  if (request.command) {
    try {
      await client.request("pane.send_text", { pane_id: paneId, text: `${request.command}\n` });
    } catch (error) {
      return {
        ok: false,
        paneId,
        tabId,
        message: explain(error, `could not start ${request.kind}`),
      };
    }
    // A typed agent has no name until herdr detects it and we rename it.
    await waitForAgentReady(client, paneId, agentReadyTimeoutMs, sleep);
    start = (name) => client.request("agent.rename", { target: paneId, name });
  } else {
    start = (name) =>
      client.request("agent.start", {
        name,
        kind: request.kind,
        pane_id: paneId,
        ...(request.mode.args.length > 0 ? { args: request.mode.args } : {}),
      });
  }

  const attempt = await startWithFreeName(start, request.name, sleep);
  if (!attempt.name) {
    return {
      ok: false,
      paneId,
      tabId,
      message: explain(attempt.error, `could not start ${request.kind}`),
    };
  }

  if (request.firstPrompt?.trim()) {
    // agent.start returning does not mean the agent registry is ready yet.
    await waitForAgentReady(client, paneId, agentReadyTimeoutMs, sleep);
    // Nor does registration mean the TUI accepts input: a first-run agent can
    // still be on a welcome or trust screen, which swallows anything typed.
    await waitForInputReady(client, paneId, agentReadyTimeoutMs);
    try {
      await promptWithRetry(client, paneId, request.firstPrompt.trim(), sleep);
    } catch (error) {
      // Agent is running; report prompt failure separately.
      return {
        ok: true,
        paneId,
        tabId,
        promptDelivered: false,
        message: `Started, but the first prompt did not land: ${explain(error, "prompt failed")}`,
      };
    }
    return { ok: true, paneId, tabId, promptDelivered: true };
  }

  return { ok: true, paneId, tabId };
}

/** Retry with suffixed names when the base name is already taken. */
async function startWithFreeName(
  start: (name: string) => Promise<unknown>,
  base: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ name: string; error?: unknown }> {
  let error: unknown;
  for (let i = 0; i < NAME_ATTEMPTS; i += 1) {
    const name = i === 0 ? base : suffixed(base, i + 1);
    try {
      await start(name);
      return { name };
    } catch (first) {
      error = first;
      if (isNameTaken(first)) continue;

      // Non-name errors may be a shell-readiness race; retry once.
      await sleep(500);
      try {
        await start(name);
        return { name };
      } catch (second) {
        return { name: "", error: second };
      }
    }
  }
  return { name: "", error };
}

/**
 * Send the first prompt and make herdr confirm the agent reacted to it.
 *
 * Without the `wait`, a prompt typed into an agent that is not listening yet
 * reports success and vanishes — the launch looks fine and the agent sits at an
 * empty input box. A stall means the keystrokes went nowhere, so it is worth one
 * resend; more than that risks typing the prompt twice into a merely slow agent.
 */
async function promptWithRetry(
  client: HerdrClient,
  paneId: string,
  text: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  let stalls = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await client.prompt(paneId, text, {
        until: ["working", "done"],
        timeout_ms: PROMPT_REACTION_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
      const stalled = error instanceof HerdrError && error.code === "agent_prompt_stalled";
      if (stalled) {
        stalls += 1;
        if (stalls > 1) throw error;
        await sleep(1_000);
        continue;
      }
      const message = error instanceof HerdrError ? error.message : "";
      if (!/not an active named agent|not found|no agent/i.test(message)) throw error;
      await sleep(1_000);
    }
  }
  throw lastError;
}

/**
 * Block until the agent is settled enough to accept typing.
 *
 * `agent.wait` is herdr's own readiness signal; a failure here is not fatal
 * because the prompt below verifies delivery on its own.
 */
async function waitForInputReady(
  client: HerdrClient,
  paneId: string,
  timeoutMs: number,
): Promise<void> {
  await client
    .request("agent.wait", {
      target: paneId,
      until: ["idle", "blocked", "done"],
      timeout_ms: timeoutMs,
    })
    .catch(() => undefined);
}

/** Poll agent.get until herdr registers the agent, or time out. */
async function waitForAgentReady(
  client: HerdrClient,
  paneId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await client.request<{ agent?: { agent?: string } }>("agent.get", {
        target: paneId,
      });
      if (info.agent?.agent) return;
    } catch {
      // Not registered yet.
    }
    await sleep(SHELL_POLL_MS);
  }
}

/** Poll pane.process_info until the shell is in the foreground. */
async function waitForShell(
  client: HerdrClient,
  paneId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await client.request<{ process?: { foreground_command?: string | null } }>(
        "pane.process_info",
        { pane_id: paneId },
      );
      const foreground = info.process?.foreground_command ?? "";
      // Empty foreground command means the shell prompt is active.
      if (!foreground) return;
    } catch {
      return;
    }
    await sleep(SHELL_POLL_MS);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function explain(error: unknown, context: string): string {
  if (error instanceof HerdrError) {
    if (error.code === "agent_prompt_stalled") {
      return "the agent started but did not react to the prompt";
    }
    return `${context}: ${error.message}`;
  }
  return context;
}
