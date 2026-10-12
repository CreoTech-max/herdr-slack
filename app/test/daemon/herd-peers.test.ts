import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PEER_STALE_MS,
  PeerDirectory,
  type PeerPointer,
  hashId,
  machineSharedRoot,
  peersDir,
  pointerFor,
  resolveRegistryDir,
  sharedRegistryDir,
  splitWith,
} from "../../src/daemon/herd-peers.js";
import { registryKey, seal } from "../../src/daemon/herd-signing.js";
import { FAKE } from "../helpers/fake-credentials.js";

const KEY = registryKey(FAKE.slackBot);
/** Anything that does not hold this Slack app's bot token. */
const FOREIGN_KEY = registryKey("xoxb-EXAMPLE-999999999");
const APP = "A1";
const APP_HASH = hashId(APP);

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "herd-peers-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pointer = (overrides: Partial<PeerPointer> = {}): PeerPointer => ({
  herdId: "mac:them:default",
  appIdHash: APP_HASH,
  registryDirHash: hashId("/their/registry"),
  updatedAt: Date.now(),
  pid: 42,
  ...overrides,
});

describe("machine-wide paths", () => {
  it("puts the shared root somewhere every account can reach", () => {
    expect(machineSharedRoot("darwin")).toBe("/Users/Shared/herdr-slack");
    expect(machineSharedRoot("linux")).toBe("/var/tmp/herdr-slack");
    expect(sharedRegistryDir("darwin")).toBe("/Users/Shared/herdr-slack/registry");
    expect(peersDir("darwin")).toBe("/Users/Shared/herdr-slack/peers");
  });

  it("names pointer files by hash, not by user", () => {
    const dir = scratch();
    new PeerDirectory(KEY, dir).publish(pointer({ herdId: "mac:alice:default" }));
    const [name] = readdirSync(dir);
    expect(name).toBe(`${hashId("mac:alice:default")}.json`);
    expect(name).not.toContain("alice");
  });
});

describe("PeerDirectory", () => {
  it("round-trips a pointer and excludes our own herd from peers", () => {
    const peers = new PeerDirectory(KEY, scratch());
    peers.publish(pointer({ herdId: "mac:me:default" }));
    peers.publish(pointer({ herdId: "mac:them:default" }));

    expect(peers.peers(APP_HASH, "mac:me:default").map((p) => p.herdId)).toEqual([
      "mac:them:default",
    ]);
    expect(peers.self(APP_HASH, "mac:me:default")?.herdId).toBe("mac:me:default");
  });

  it("ignores pointers for a different Slack app", () => {
    const peers = new PeerDirectory(KEY, scratch());
    peers.publish(pointer({ herdId: "other-app", appIdHash: hashId("A2") }));
    expect(peers.peers(APP_HASH, "mac:me:default")).toEqual([]);
  });

  it("ignores a pointer left behind by a daemon that is long gone", () => {
    const peers = new PeerDirectory(KEY, scratch());
    peers.publish(pointer({ updatedAt: Date.now() - PEER_STALE_MS - 1 }));
    expect(peers.peers(APP_HASH, "mac:me:default")).toEqual([]);
  });

  it("forgets us on stop, so a stopped daemon stops looking like a peer", () => {
    const peers = new PeerDirectory(KEY, scratch());
    peers.publish(pointer({ herdId: "mac:them:default" }));
    peers.remove("mac:them:default");
    expect(peers.peers(APP_HASH, "mac:me:default")).toEqual([]);
  });

  it("stays writable by other accounts despite the umask", () => {
    const dir = path.join(scratch(), "peers");
    new PeerDirectory(KEY, dir).publish(pointer({ herdId: "mac:me:default" }));
    expect(statSync(dir).mode & 0o777).toBe(0o777);
    expect(statSync(path.join(dir, `${hashId("mac:me:default")}.json`)).mode & 0o777).toBe(0o666);
  });

  it("never throws when the machine will not have it", () => {
    // A locked-down /Users/Shared must degrade to "no discovery", not to a
    // daemon that cannot boot.
    const blocked = path.join(scratch(), "not-a-directory");
    writeFileSync(blocked, "");
    const peers = new PeerDirectory(KEY, path.join(blocked, "peers"));
    expect(peers.publish(pointer())).toBe(false);
    expect(peers.peers(APP_HASH, "mac:me:default")).toEqual([]);
  });
});

/**
 * The pointer directory is writable by any local account, and a pointer steers
 * where a daemon puts its heartbeats. Only daemons holding the app's bot token
 * may be heard.
 */
describe("a peers directory other accounts can write to", () => {
  it("ignores a pointer forged without the app's token", () => {
    const dir = scratch();
    writeFileSync(
      path.join(dir, `${hashId("impostor")}.json`),
      `${JSON.stringify(seal(FOREIGN_KEY, pointer({ herdId: "impostor" })))}\n`,
    );
    expect(new PeerDirectory(KEY, dir).peers(APP_HASH, "mac:me:default")).toEqual([]);
  });

  it("ignores a pointer that was signed and then edited", () => {
    const dir = scratch();
    const peers = new PeerDirectory(KEY, dir);
    peers.publish(pointer({ herdId: "mac:them:default" }));
    const file = path.join(dir, `${hashId("mac:them:default")}.json`);
    const envelope = JSON.parse(readFileSync(file, "utf8")) as { record: PeerPointer };
    envelope.record.registryDirHash = hashId("/somewhere/else");
    writeFileSync(file, `${JSON.stringify(envelope)}\n`);
    expect(peers.peers(APP_HASH, "mac:me:default")).toEqual([]);
  });

  it("never migrates to a directory named by a pointer", () => {
    // Even a pointer we accepted only answers "someone else is here". The
    // destination is a constant, so it cannot aim us at the author's directory.
    const choice = resolveRegistryDir({
      privateDefault: "/home/me/private",
      peers: [pointer({ registryDirHash: hashId("/tmp/attacker-owned") })],
      self: null,
      platform: "darwin",
    });
    expect(choice.dir).toBe(sharedRegistryDir("darwin"));
  });
});

describe("resolveRegistryDir", () => {
  const privateDefault = "/home/me/private";

  it("honours an explicit setting above everything else", () => {
    const choice = resolveRegistryDir({
      configured: "/somewhere/agreed",
      privateDefault,
      peers: [pointer()],
      self: null,
    });
    expect(choice).toMatchObject({ dir: "/somewhere/agreed", shared: true, reason: "configured" });
  });

  it("keeps a lone machine private, so other accounts cannot read agent titles", () => {
    const choice = resolveRegistryDir({ privateDefault, peers: [], self: null });
    expect(choice).toMatchObject({ dir: privateDefault, shared: false, reason: "alone" });
  });

  it("moves to the shared registry as soon as another herd appears", () => {
    const choice = resolveRegistryDir({
      privateDefault,
      peers: [pointer()],
      self: null,
      platform: "darwin",
    });
    expect(choice).toMatchObject({ dir: sharedRegistryDir("darwin"), shared: true });
    expect(choice.reason).toBe("peer-detected");
  });

  it("stays shared once it has been, even while the peer is asleep", () => {
    // Falling back to a private directory the peer cannot read would split the
    // herds again the moment it woke up.
    const choice = resolveRegistryDir({
      privateDefault,
      peers: [],
      self: pointer({ registryDirHash: hashId(sharedRegistryDir("darwin")) }),
      platform: "darwin",
    });
    expect(choice).toMatchObject({ dir: sharedRegistryDir("darwin"), reason: "was-shared" });
  });
});

describe("splitWith", () => {
  it("reports only peers that are on a different registry", () => {
    const ours = "/Users/Shared/herdr-slack/registry";
    const together = pointer({ herdId: "together", registryDirHash: hashId(ours) });
    const apart = pointer({ herdId: "apart", registryDirHash: hashId("/elsewhere") });
    expect(splitWith([together, apart], ours).map((p) => p.herdId)).toEqual(["apart"]);
  });

  it("sees no split when everyone agrees", () => {
    const ours = "/shared";
    expect(splitWith([pointer({ registryDirHash: hashId(ours) })], ours)).toEqual([]);
  });
});

describe("pointerFor", () => {
  it("carries hashes rather than the app id and path", () => {
    const p = pointerFor({ herdId: "mac:me:default", appId: APP, registryDir: "/home/me/private" });
    expect(p.appIdHash).toBe(hashId(APP));
    expect(JSON.stringify(p)).not.toContain(APP);
    expect(JSON.stringify(p)).not.toContain("/home/me/private");
  });
});
