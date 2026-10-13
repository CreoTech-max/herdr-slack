import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const openHook = vi.hoisted(() => ({
  before: undefined as (() => void) | undefined,
  after: undefined as (() => void) | undefined,
  wrongOwnerPath: undefined as string | undefined,
  appendDuringRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      if (args[0] === openHook.wrongOwnerPath)
        Object.assign(info, { uid: (process.getuid?.() ?? 0) + 1 });
      return info;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      openHook.before?.();
      let handle: Awaited<ReturnType<typeof actual.open>>;
      try {
        handle = await actual.open(...args);
      } finally {
        openHook.after?.();
      }
      if (!openHook.appendDuringRead) return handle;
      let appended = false;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "read")
            return async (...readArgs: Parameters<typeof target.read>) => {
              const result = await target.read(...readArgs);
              if (!appended) {
                appended = true;
                openHook.appendDuringRead?.();
              }
              return result;
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
import { readPiSession } from "../../src/agents/pi-session.js";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/w" };
const user = (entryId: string, parentId: string | null, content: string) => ({
  type: "message",
  id: entryId,
  parentId,
  timestamp: new Date().toISOString(),
  message: { role: "user", content, timestamp: Date.now() },
});
const assistant = (entryId: string, parentId: string, stopReason: string, text: string) => ({
  type: "message",
  id: entryId,
  parentId,
  timestamp: new Date().toISOString(),
  message: {
    role: "assistant",
    stopReason,
    timestamp: Date.now(),
    content: [
      { type: "thinking", thinking: "EXAMPLE hidden thought" },
      { type: "toolCall", id: "tool1", name: "bash", arguments: { text: "EXAMPLE hidden tool" } },
      { type: "text", text },
    ],
  },
});

describe("local Pi session reader", () => {
  let dir: string;
  let file: string;
  const put = (...entries: unknown[]) =>
    writeFileSync(
      file,
      `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-reader-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = dir;
    file = path.join(dir, `2026-10-13T00-00-00_${id}.jsonl`);
  });
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures a missing new file and reads only the complete assistant text after the turn", async () => {
    const first = await readPiSession(file);
    expect(first.kind).toBe("boundary");
    if (first.kind !== "boundary") return;
    put(
      user("u1", null, "same as reply"),
      assistant("a1", "u1", "stop", "same as reply\n\n  const x = 1;"),
    );
    const created = await readPiSession(file, first.boundary);
    expect(created).toMatchObject({
      kind: "ready",
      identity: `${id}:a1`,
      text: "same as reply\n\n  const x = 1;",
      boundary: { fileIdentity: { ino: expect.any(Number) } },
    });
    if (created.kind !== "ready") throw new Error("creation was not bound");
    const next = path.join(dir, "replacement");
    writeFileSync(
      next,
      `${[header, user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE replacement")].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    renameSync(next, file);
    expect((await readPiSession(file, created.boundary)).kind).toBe("unavailable");
  });

  it("binds the first verified incomplete file before the final reply", async () => {
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    put(user("u1", null, "waiting"));
    const pending = await readPiSession(file, captured.boundary);
    expect(pending.kind).toBe("pending");
    if (pending.kind !== "pending") return;
    expect(pending.boundary.fileIdentity).toMatchObject({ ino: expect.any(Number) });
    const replacement = path.join(dir, "replacement");
    writeFileSync(
      replacement,
      `${[header, user("u1", null, "waiting"), assistant("a1", "u1", "stop", "EXAMPLE replacement")].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    renameSync(replacement, file);
    expect((await readPiSession(file, pending.boundary)).kind).toBe("unavailable");
  });

  it.each(["error", "aborted", "length", "deferred", "toolUse"])(
    "does not reuse an earlier answer after %s",
    async (reason) => {
      put(user("u1", null, "first"), assistant("a1", "u1", "stop", "Old success"));
      const first = await readPiSession(file);
      if (first.kind !== "boundary") throw new Error("missing boundary");
      put(
        user("u1", null, "first"),
        assistant("a1", "u1", "stop", "Old success"),
        user("u2", "a1", "second"),
        assistant("a2", "u2", reason, "Partial EXAMPLE content"),
      );
      const latest = await readPiSession(file, first.boundary);
      expect(latest.kind).toBe(reason === "toolUse" ? "pending" : "failed");
      expect(JSON.stringify(latest)).not.toContain("Old success");
      expect(JSON.stringify(latest)).not.toContain("Partial EXAMPLE");
    },
  );

  it("reads the final answer after a blocked tool-use assistant entry", async () => {
    put();
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    put(
      user("u1", null, "first"),
      assistant("a1", "u1", "toolUse", "I need approval"),
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: new Date().toISOString(),
        message: { role: "toolResult", content: [{ type: "text", text: "EXAMPLE tool result" }] },
      },
      assistant("a2", "t1", "stop", "Finished after approval"),
    );
    expect(await readPiSession(file, captured.boundary)).toMatchObject({
      kind: "ready",
      identity: `${id}:a2`,
      text: "Finished after approval",
    });
  });

  it("refuses a branch that no longer contains the sent turn", async () => {
    put(user("u1", null, "first"), assistant("a1", "u1", "stop", "Old success"));
    const first = await readPiSession(file);
    if (first.kind !== "boundary") throw new Error("missing boundary");
    put(
      user("u1", null, "first"),
      assistant("a1", "u1", "stop", "Old success"),
      user("u2", "u1", "other branch"),
      assistant("a2", "u2", "stop", "Other branch answer"),
    );
    expect((await readPiSession(file, first.boundary)).kind).toBe("unavailable");
  });

  it("refuses symlinks, other locations, changed headers, and malformed complete entries", async () => {
    put(user("u1", null, "first"), assistant("a1", "u1", "stop", "answer"));
    const boundary = await readPiSession(file);
    expect(boundary.kind).toBe("boundary");
    const link = path.join(dir, `linked_${id}.jsonl`);
    symlinkSync(file, link);
    expect((await readPiSession(link)).kind).toBe("unavailable");
    expect((await readPiSession(path.join(tmpdir(), `elsewhere_${id}.jsonl`))).kind).toBe(
      "unavailable",
    );
    put({ type: "message", id: "u1", parentId: null, timestamp: "bad", message: { role: "user" } });
    expect((await readPiSession(file)).kind).toBe("unavailable");
    writeFileSync(file, `${JSON.stringify({ ...header, id: "another" })}\n`);
    expect((await readPiSession(file)).kind).toBe("unavailable");
  });

  it("rejects replacement at the same path with the same session UUID", async () => {
    put();
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    const next = path.join(dir, "next");
    writeFileSync(
      next,
      `${[header, user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE replacement")].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    renameSync(next, file);
    expect((await readPiSession(file, captured.boundary)).kind).toBe("unavailable");
  });

  it("rejects a temporary parent symlink during the real open", async () => {
    put();
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    const outside = path.join(`${dir}-outside`);
    mkdirSync(outside);
    writeFileSync(
      path.join(outside, path.basename(file)),
      `${[header, user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE outside text")].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    openHook.before = () => {
      renameSync(dir, `${dir}-held`);
      symlinkSync(outside, dir);
    };
    openHook.after = () => {
      rmSync(dir, { force: true });
      renameSync(`${dir}-held`, dir);
    };
    try {
      expect((await readPiSession(file, captured.boundary)).kind).toBe("unavailable");
    } finally {
      openHook.before = undefined;
      openHook.after = undefined;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked session outside the trusted root", async () => {
    const outside = path.join(tmpdir(), `external_${id}.jsonl`);
    put(user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE secret"));
    renameSync(file, outside);
    try {
      linkSync(outside, file);
      expect((await readPiSession(file)).kind).toBe("unavailable");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("rejects a symlinked session directory even with a valid session file", async () => {
    put(user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE secret"));
    const original = `${dir}-original`;
    renameSync(dir, original);
    symlinkSync(original, dir);
    try {
      expect((await readPiSession(file)).kind).toBe("unavailable");
    } finally {
      rmSync(dir, { force: true });
      renameSync(original, dir);
    }
  });

  it("refuses traversal, wrong owner, and an oversized header", async () => {
    expect(
      (await readPiSession(`${dir}/../${path.basename(dir)}/${path.basename(file)}`)).kind,
    ).toBe("unavailable");
    put();
    openHook.wrongOwnerPath = file;
    try {
      expect((await readPiSession(file)).kind).toBe("unavailable");
    } finally {
      openHook.wrongOwnerPath = undefined;
    }
    writeFileSync(file, `${JSON.stringify({ ...header, cwd: `/w/${"x".repeat(70_000)}` })}\n`);
    expect((await readPiSession(file)).kind).toBe("unavailable");
  });

  it("keeps a physical boundary through ordinary append but rejects append during read", async () => {
    put();
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    appendFileSync(
      file,
      `${[user("u1", null, "first"), assistant("a1", "u1", "stop", "EXAMPLE answer")].map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    expect((await readPiSession(file, captured.boundary)).kind).toBe("ready");
    openHook.appendDuringRead = () =>
      appendFileSync(
        file,
        `${JSON.stringify({ type: "label", id: "note", parentId: "a1", timestamp: new Date().toISOString() })}\n`,
      );
    try {
      expect((await readPiSession(file, captured.boundary)).kind).toBe("unavailable");
    } finally {
      openHook.appendDuringRead = undefined;
    }
  });

  it("refuses an oversized tail without complete branch ancestry", async () => {
    put();
    const captured = await readPiSession(file);
    if (captured.kind !== "boundary") throw new Error("missing boundary");
    appendFileSync(
      file,
      `${JSON.stringify(user("u1", null, "x".repeat(2 * 1024 * 1024)))}\n${JSON.stringify(assistant("a1", "u1", "stop", "EXAMPLE answer"))}\n`,
    );
    expect((await readPiSession(file, captured.boundary)).kind).toBe("unavailable");
  });

  it("ignores only the last incomplete record and rejects a malformed complete record", async () => {
    put(user("u1", null, "first"), assistant("a1", "u1", "stop", "complete answer"));
    const first = await readPiSession(file);
    if (first.kind !== "boundary") throw new Error("missing boundary");
    writeFileSync(
      file,
      `${JSON.stringify(header)}\n${JSON.stringify(user("u1", null, "first"))}\n${JSON.stringify(assistant("a1", "u1", "stop", "complete answer"))}\n${JSON.stringify(user("u2", "a1", "second"))}\n${JSON.stringify(assistant("a2", "u2", "stop", "new complete answer"))}\n{partial`,
    );
    expect((await readPiSession(file, first.boundary)).kind).toBe("ready");
    writeFileSync(
      file,
      `${JSON.stringify(header)}\n{bad complete}\n${JSON.stringify(user("u1", null, "first"))}\n`,
    );
    expect((await readPiSession(file)).kind).toBe("unavailable");
  });
});
