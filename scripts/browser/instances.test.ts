import { describe, expect, it } from "bun:test";
import { ownedByMe, parseInstance } from "./instances.ts";

const TOKEN = "a".repeat(64);

describe("parseInstance", () => {
  it("accepts a complete entry", () => {
    const entry = { name: "main", port: 8765, token: TOKEN, pid: 42 };
    expect(parseInstance(entry)).toEqual(entry);
  });

  it("refuses an entry with a bad port, pid or missing field", () => {
    expect(parseInstance({ name: "a", port: 0, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 70000, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 1, token: TOKEN, pid: -1 })).toBeNull();
    expect(parseInstance({ port: 1, token: TOKEN, pid: 1 })).toBeNull();
    expect(parseInstance(null)).toBeNull();
  });
});

describe("parseInstance tokens and ports", () => {
  const entry = { name: "main", port: 8765, token: TOKEN, pid: 42 };

  it("refuses a token that isn't what a sidecar mints", () => {
    expect(parseInstance({ ...entry, token: "short" })).toBeNull();
    expect(parseInstance({ ...entry, token: `${TOKEN}\r\nX-Evil: 1` })).toBeNull();
    expect(parseInstance({ ...entry, token: "A".repeat(64) })).toBeNull();
  });

  it("refuses a privileged port", () => {
    expect(parseInstance({ ...entry, port: 80 })).toBeNull();
    expect(parseInstance({ ...entry, port: 1024 })).not.toBeNull();
  });
});

describe("ownedByMe", () => {
  it("trusts only this user's files that no one else can write", () => {
    expect(ownedByMe({ uid: 501, mode: 0o100600 }, 501)).toBe(true);
    expect(ownedByMe({ uid: 501, mode: 0o40700 }, 501)).toBe(true);
    expect(ownedByMe({ uid: 502, mode: 0o100600 }, 501)).toBe(false);
    expect(ownedByMe({ uid: 501, mode: 0o100620 }, 501)).toBe(false);
    expect(ownedByMe({ uid: 501, mode: 0o100602 }, 501)).toBe(false);
  });
});
