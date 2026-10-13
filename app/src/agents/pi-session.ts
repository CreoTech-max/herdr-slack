import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const TAIL_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const SESSION_ID = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export interface PiBoundary {
  path: string;
  sessionId: string;
  entryId: string | null;
  directory: { dev: number; ino: number };
  fileIdentity?: { dev: number; ino: number };
  /** Only a file absent at capture may bind to its first verified creation. */
  newFile?: true;
}

export type PiRead =
  | { kind: "ready"; boundary: PiBoundary; identity: string; text: string }
  | { kind: "failed"; reason: "failed" | "stopped" }
  | { kind: "pending"; boundary: PiBoundary }
  | { kind: "unavailable"; reason: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionRoot(): string | undefined {
  // cre's personal-entry.mjs exports an explicit override after it resolves that path.
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (configured && (!path.isAbsolute(configured) || path.normalize(configured) !== configured))
    return undefined;
  return configured || path.join(homedir(), ".pi", "cre", "sessions");
}

/** Only the local herdr pane's path may enter here, never a Slack or peer payload. */
export async function readPiSession(
  file: string | undefined,
  boundary?: PiBoundary,
): Promise<PiRead | { kind: "boundary"; boundary: PiBoundary }> {
  const root = sessionRoot();
  const sessionId = file && SESSION_ID.exec(file)?.[1];
  if (
    !root ||
    !file ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    path.dirname(file) !== root ||
    !sessionId
  )
    return { kind: "unavailable", reason: "Unsupported Pi session location." };
  try {
    const directory = await lstat(root);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (await realpath(root)) !== root ||
      (boundary &&
        (directory.dev !== boundary.directory?.dev || directory.ino !== boundary.directory?.ino))
    )
      return { kind: "unavailable", reason: "Unsupported Pi session location." };
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size < 1)
        return { kind: "unavailable", reason: "Pi session is unavailable." };
      const physical = { dev: info.dev, ino: info.ino };
      const matchesPath = async () => {
        const currentDirectory = await lstat(root);
        const currentFile = await lstat(file);
        return (
          currentDirectory.isDirectory() &&
          currentDirectory.uid === process.getuid?.() &&
          currentDirectory.dev === directory.dev &&
          currentDirectory.ino === directory.ino &&
          (await realpath(root)) === root &&
          currentFile.isFile() &&
          currentFile.nlink === 1 &&
          currentFile.uid === process.getuid?.() &&
          currentFile.dev === physical.dev &&
          currentFile.ino === physical.ino
        );
      };
      if (
        (boundary &&
          ((!boundary.fileIdentity && (boundary.newFile !== true || boundary.entryId !== null)) ||
            (boundary.fileIdentity &&
              (boundary.fileIdentity.dev !== physical.dev ||
                boundary.fileIdentity.ino !== physical.ino)))) ||
        !(await matchesPath())
      )
        return { kind: "unavailable", reason: "Pi session source changed." };
      const verifiedBoundary: PiBoundary = {
        path: file,
        sessionId,
        entryId: boundary?.entryId ?? null,
        directory: { dev: directory.dev, ino: directory.ino },
        fileIdentity: physical,
      };
      const header = Buffer.alloc(Math.min(info.size, HEADER_BYTES));
      if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length)
        return { kind: "unavailable", reason: "Pi session header is unavailable." };
      const firstLine = header.toString("utf8").split("\n", 1)[0];
      if (!firstLine || !header.includes(10))
        return { kind: "unavailable", reason: "Pi session header is unavailable." };
      const parsedHeader: unknown = JSON.parse(firstLine);
      if (
        !object(parsedHeader) ||
        parsedHeader.type !== "session" ||
        parsedHeader.version !== 3 ||
        parsedHeader.id !== sessionId ||
        typeof parsedHeader.timestamp !== "string" ||
        !Number.isFinite(Date.parse(parsedHeader.timestamp)) ||
        typeof parsedHeader.cwd !== "string" ||
        !path.isAbsolute(parsedHeader.cwd)
      )
        return { kind: "unavailable", reason: "Pi session identity is invalid." };
      const start = Math.max(0, info.size - TAIL_BYTES);
      const tail = Buffer.alloc(info.size - start);
      if ((await handle.read(tail, 0, tail.length, start)).bytesRead !== tail.length)
        return { kind: "unavailable", reason: "Pi session tail is unavailable." };
      const after = await handle.stat();
      if (
        info.dev !== after.dev ||
        info.ino !== after.ino ||
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ctimeMs !== after.ctimeMs ||
        !(await matchesPath())
      )
        return { kind: "unavailable", reason: "Pi session changed during the read." };
      let data = tail.toString("utf8");
      if (start > 0) data = data.slice(data.indexOf("\n") + 1);
      const lines = data.split("\n");
      if (lines.at(-1) !== "") lines.pop(); // Pi can still be appending the last record.
      const entries = new Map<string, Record<string, unknown>>();
      let last: Record<string, unknown> | undefined;
      for (const line of lines) {
        if (!line) continue;
        const entry: unknown = JSON.parse(line);
        if (!object(entry)) throw new Error("invalid record");
        if (entry.type === "session") continue;
        if (
          typeof entry.id !== "string" ||
          !entry.id ||
          (entry.parentId !== null && typeof entry.parentId !== "string") ||
          typeof entry.timestamp !== "string" ||
          !Number.isFinite(Date.parse(entry.timestamp)) ||
          entries.has(entry.id)
        )
          throw new Error("invalid entry");
        entries.set(entry.id, entry);
        last = entry;
      }
      if (!boundary)
        return {
          kind: "boundary",
          boundary: { ...verifiedBoundary, entryId: (last?.id as string | undefined) ?? null },
        };
      if (boundary.path !== file || boundary.sessionId !== sessionId)
        return { kind: "unavailable", reason: "Pi session changed." };
      let current = last;
      let assistant: Record<string, unknown> | undefined;
      let userSeen = false;
      const visited = new Set<string>();
      while (current) {
        const id = current.id;
        if (typeof id !== "string" || visited.has(id)) throw new Error("invalid tree");
        if (id === boundary.entryId) break;
        visited.add(id);
        if (current.type === "message") {
          if (!object(current.message) || typeof current.message.role !== "string")
            throw new Error("invalid message");
          if (
            current.message.role === "user" &&
            typeof current.message.content !== "string" &&
            !Array.isArray(current.message.content)
          )
            throw new Error("invalid user");
          if (current.message.role === "assistant" && !assistant) assistant = current;
          if (current.message.role === "user") userSeen = true;
        }
        const parent = current.parentId;
        if (parent === null) {
          if (boundary.entryId !== null) throw new Error("boundary missing");
          break;
        }
        if (typeof parent !== "string") throw new Error("invalid parent");
        current = entries.get(parent);
        if (!current) throw new Error("incomplete branch");
      }
      if (boundary.entryId !== null && current?.id !== boundary.entryId)
        return { kind: "unavailable", reason: "Pi turn boundary is unavailable." };
      if (!assistant || !userSeen) return { kind: "pending", boundary: verifiedBoundary };
      const message = assistant.message;
      if (!object(message) || !Array.isArray(message.content)) throw new Error("invalid assistant");
      if (
        message.stopReason === "error" ||
        message.stopReason === "length" ||
        message.stopReason === "deferred"
      )
        return { kind: "failed", reason: "failed" };
      if (message.stopReason === "aborted") return { kind: "failed", reason: "stopped" };
      if (message.stopReason === "toolUse" || message.stopReason === undefined)
        return { kind: "pending", boundary: verifiedBoundary };
      if (message.stopReason !== "stop")
        return { kind: "unavailable", reason: "Unsupported Pi reply status." };
      const blocks: string[] = [];
      for (const block of message.content) {
        if (!object(block) || typeof block.type !== "string") throw new Error("invalid block");
        if (block.type === "text") {
          if (typeof block.text !== "string") throw new Error("invalid text");
          blocks.push(block.text);
        }
      }
      if (!blocks.some((text) => text.trim()))
        return { kind: "unavailable", reason: "No textual Pi reply for this turn." };
      return {
        kind: "ready",
        boundary: verifiedBoundary,
        identity: `${sessionId}:${assistant.id}`,
        text: blocks.join("\n"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (object(error) && error.code === "ENOENT" && !boundary) {
      try {
        const directory = await lstat(root);
        if (
          directory.isDirectory() &&
          directory.uid === process.getuid?.() &&
          (await realpath(root)) === root
        )
          return {
            kind: "boundary",
            boundary: {
              path: file,
              sessionId,
              entryId: null,
              newFile: true,
              directory: { dev: directory.dev, ino: directory.ino },
            },
          };
      } catch {
        /* Directory no longer exists. */
      }
    }
    return { kind: "unavailable", reason: "Pi session is unavailable or invalid." };
  }
}
