import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { configDir } from "../config/instance.js";

/**
 * Agent kinds herdr 0.8.0 knows how to start. Verified against
 * `herdr agent start --help`.
 */
export const AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "maki",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentMode {
  id: string;
  label: string;
  /** Passed to herdr after `--`; empty means the agent's own default. */
  args: string[];
}

export interface AgentEntry {
  kind: string;
  label: string;
  modes: AgentMode[];
  /**
   * Typed into a fresh shell instead of `agent.start`, for agents herdr cannot
   * start itself. Seeded only; never read from agents.toml, since it is a
   * command line run in the user's terminal.
   */
  command?: string;
}

const DEFAULT_MODE: AgentMode = { id: "default", label: "Default", args: [] };

/**
 * Modes we consider "auto", best first.
 *
 * Launching from Slack means nobody is at the terminal to answer a permission
 * prompt, so an agent that stops to ask has stalled until someone opens the
 * thread. The mode picker is gone from the form for the same reason: it was a
 * cascade that rendered empty until an agent was chosen, to set a value that
 * only ever had one sensible answer from a phone.
 *
 * Deliberately not "yolo" — skipping permissions entirely is a different
 * decision, and one nobody should make by opening a form.
 */
const AUTO_MODE_IDS = ["accept-edits", "full-auto", "auto"] as const;

/** The mode Slack launches in: auto where the kind has one, else its default. */
export function autoModeFor(entry: AgentEntry | undefined): AgentMode {
  if (!entry) return DEFAULT_MODE;
  for (const id of AUTO_MODE_IDS) {
    const found = entry.modes.find((mode) => mode.id === id);
    if (found) return found;
  }
  return entry.modes[0] ?? DEFAULT_MODE;
}

/**
 * Seeded catalog.
 *
 * Only kinds whose launch flags have actually been checked get modes; every
 * other kind falls through to "Default (no flags)". Guessing at 21 agents'
 * command lines would produce a menu that looks complete and fails at launch,
 * which is worse than a short menu that works.
 */
export const SEED_CATALOG: AgentEntry[] = [
  {
    kind: "claude",
    label: "Claude Code",
    modes: [
      DEFAULT_MODE,
      { id: "plan", label: "Plan mode", args: ["--permission-mode", "plan"] },
      // This *is* Claude's auto mode — the "⏵⏵ auto-accept edits" state that
      // shift+tab cycles to. --permission-mode acceptEdits is how you start in
      // it non-interactively; there is no separate "auto" flag.
      {
        id: "accept-edits",
        label: "Auto (accept edits)",
        args: ["--permission-mode", "acceptEdits"],
      },
      {
        id: "yolo",
        label: "Skip permissions ⚠",
        args: ["--dangerously-skip-permissions"],
      },
    ],
  },
  {
    kind: "codex",
    label: "Codex",
    modes: [DEFAULT_MODE, { id: "full-auto", label: "Full auto", args: ["--full-auto"] }],
  },
  // herdr detects it as `pi` once running (T0 spike, herdr 0.9.3).
  { kind: "cre", label: "CRE", modes: [DEFAULT_MODE], command: "cre" },
];

export function catalogPath(): string {
  return path.join(configDir(), "agents.toml");
}

/** Every known kind, with user-defined modes where they exist. */
export function loadCatalog(file = catalogPath()): AgentEntry[] {
  const overrides = new Map<string, AgentEntry>();

  for (const entry of readUserCatalog(file)) overrides.set(entry.kind, entry);
  for (const entry of SEED_CATALOG) {
    if (!overrides.has(entry.kind)) overrides.set(entry.kind, entry);
  }

  const catalog: AgentEntry[] = AGENT_KINDS.map(
    (kind) => overrides.get(kind) ?? { kind, label: kind, modes: [DEFAULT_MODE] },
  );
  for (const seed of SEED_CATALOG) {
    if (!seed.command || (AGENT_KINDS as readonly string[]).includes(seed.kind)) continue;
    catalog.push({ ...(overrides.get(seed.kind) ?? seed), command: seed.command });
  }
  return catalog;
}

/**
 * Parse the user's agents.toml.
 *
 * A malformed file must not stop the daemon — it degrades to the seeded catalog,
 * because the alternative is a bridge that will not start over a typo in an
 * optional config.
 */
export function readUserCatalog(file = catalogPath()): AgentEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const entries: AgentEntry[] = [];
    for (const [kind, raw] of Object.entries(parsed)) {
      const value = raw as { label?: unknown; modes?: unknown };
      const modes = Array.isArray(value.modes)
        ? value.modes
            .map((mode) => normaliseMode(mode))
            .filter((mode): mode is AgentMode => mode !== null)
        : [];
      entries.push({
        kind,
        label: typeof value.label === "string" ? value.label : kind,
        modes: modes.length > 0 ? modes : [DEFAULT_MODE],
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function normaliseMode(raw: unknown): AgentMode | null {
  const mode = raw as { id?: unknown; label?: unknown; args?: unknown };
  if (typeof mode.id !== "string" || !mode.id) return null;
  const args = Array.isArray(mode.args)
    ? mode.args.filter((a): a is string => typeof a === "string")
    : [];
  return {
    id: mode.id,
    label: typeof mode.label === "string" ? mode.label : mode.id,
    args,
  };
}

export function findEntry(catalog: AgentEntry[], kind: string): AgentEntry | undefined {
  return catalog.find((entry) => entry.kind === kind);
}

export function findMode(entry: AgentEntry | undefined, modeId: string): AgentMode | undefined {
  return entry?.modes.find((mode) => mode.id === modeId);
}

/** Kinds worth offering first: those with more than a bare default. */
export function configuredKinds(catalog: AgentEntry[]): AgentEntry[] {
  return catalog.filter((entry) => entry.modes.length > 1);
}

/** Written by setup so the file is discoverable and editable. */
export function writeExampleCatalog(file = catalogPath()): void {
  if (existsSync(file)) return;
  const lines = [
    "# Agent launch modes for herdr-slack.",
    "#",
    "# Only kinds listed here get mode choices in the New agent modal; anything else",
    "# starts with its own defaults. Add a kind when you have verified its flags",
    "# actually work — a mode that fails at launch is worse than no mode.",
    "",
  ];
  for (const entry of SEED_CATALOG) {
    lines.push(`[${entry.kind}]`, `label = ${JSON.stringify(entry.label)}`, "modes = [");
    for (const mode of entry.modes) {
      lines.push(
        `  { id = ${JSON.stringify(mode.id)}, label = ${JSON.stringify(mode.label)}, args = ${JSON.stringify(mode.args)} },`,
      );
    }
    lines.push("]", "");
  }
  writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}
