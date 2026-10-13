import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../config/instance.js";

function bindingsPath(instance: string): string {
  return path.join(stateDir(instance), "bindings.json");
}

export function loadBindings(instance: string): Record<string, string> | undefined {
  const file = bindingsPath(instance);
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed);
    if (
      entries.some(
        ([key, value]) =>
          !/^[CGD][A-Z0-9]+$/.test(key) || typeof value !== "string" || !value.trim(),
      )
    )
      return {};
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveBindings(instance: string, map: Record<string, string>): void {
  const file = bindingsPath(instance);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
