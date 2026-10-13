export const RESERVED = ["bind", "unbind", "agents", "new", "help"] as const;

export type MentionCommand =
  | { kind: (typeof RESERVED)[number] }
  | { kind: "agent"; name: string; verb: "prompt" | "context" | "stop" | "clear"; text: string }
  | { kind: "unknown" };

export function parseMention(text: string, botUserId: string): MentionCommand {
  const body = text
    .trim()
    .replace(new RegExp(`^<@${botUserId}>\\s*`), "")
    .trim();
  const match = /^([^\s]+)(?:\s+([\s\S]+))?$/.exec(body);
  const name = match?.[1];
  if (!name) return { kind: "unknown" };
  if (RESERVED.some((word) => word === name)) return { kind: name as (typeof RESERVED)[number] };
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return { kind: "unknown" };
  const remainder = match[2]?.trim() ?? "";
  if (remainder === "stop" || remainder === "clear") {
    return { kind: "agent", name, verb: remainder, text: "" };
  }
  if (remainder.startsWith("stop ") || remainder.startsWith("clear ")) return { kind: "unknown" };
  if (remainder.startsWith("context ")) {
    const request = remainder.slice("context ".length).trim();
    return request ? { kind: "agent", name, verb: "context", text: request } : { kind: "unknown" };
  }
  if (!remainder || remainder === "context") return { kind: "unknown" };
  return { kind: "agent", name, verb: "prompt", text: remainder };
}
