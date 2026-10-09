import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverRepos, piSessionCwd, readOriginUrl, remoteUrl } from "./repos.ts";

let root: string;
const previous = { claude: process.env.CLAUDE_HOME, pi: process.env.YARVIS_PI_HOME };

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function clone(path: string, url: string) {
  write(
    join(path, ".git", "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`,
  );
  return path;
}

function piSession(dirName: string, cwd: string, at: Date) {
  const file = join(root, "pi", "agent", "sessions", dirName, "s.jsonl");
  write(file, `${JSON.stringify({ type: "session", version: 3, cwd })}\n{"type":"model_change"}\n`);
  utimesSync(file, at, at);
}

function claudeSession(cwd: string, at: Date) {
  const file = join(root, "claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "abc.jsonl");
  write(file, `${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  utimesSync(file, at, at);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-import-repos-"));
  process.env.CLAUDE_HOME = join(root, "claude");
  process.env.YARVIS_PI_HOME = join(root, "pi");
});

afterEach(() => {
  process.env.CLAUDE_HOME = previous.claude;
  process.env.YARVIS_PI_HOME = previous.pi;
  rmSync(root, { recursive: true, force: true });
});

describe("remoteUrl", () => {
  it("prefers origin, and otherwise takes the first remote", () => {
    const config = `[remote "upstream"]\n\turl = git@github.com:up/x.git\n[remote "origin"]\n\turl = git@github.com:me/x.git\n`;
    expect(remoteUrl(config)).toBe("git@github.com:me/x.git");
    expect(remoteUrl(`[remote "fork"]\n  url = https://github.com/f/x\n`)).toBe(
      "https://github.com/f/x",
    );
  });

  it("ignores a url outside a remote section", () => {
    expect(remoteUrl(`[submodule "lib"]\n\turl = git@github.com:a/lib.git\n`)).toBeNull();
  });
});

describe("readOriginUrl", () => {
  it("follows a linked worktree to the main clone's config", async () => {
    const main = clone(join(root, "main"), "git@github.com:acme/app.git");
    const gitDir = join(main, ".git", "worktrees", "feature");
    write(join(gitDir, "commondir"), "../..\n");
    const worktree = join(root, "feature");
    write(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(await readOriginUrl(worktree)).toBe("git@github.com:acme/app.git");
  });

  it("is null for a directory that is not a clone", async () => {
    mkdirSync(join(root, "plain"));
    expect(await readOriginUrl(join(root, "plain"))).toBeNull();
  });
});

describe("piSessionCwd", () => {
  it("reads the working directory from the session header", async () => {
    piSession("--x--", "/work/app", new Date());
    expect(await piSessionCwd(join(root, "pi", "agent", "sessions", "--x--", "s.jsonl"))).toBe(
      "/work/app",
    );
  });
});

describe("discoverRepos", () => {
  it("lists session repos first by recency, then folder clones by name", async () => {
    const app = clone(join(root, "src", "app"), "git@github.com:acme/app.git");
    const api = clone(join(root, "src", "api"), "git@github.com:acme/api.git");
    clone(join(root, "src", "acme", "zeta"), "https://github.com/acme/zeta.git");
    clone(join(root, "src", "acme", "beta"), "https://github.com/acme/beta.git");
    piSession("--app--", app, new Date("2026-09-01T00:00:00Z"));
    claudeSession(api, new Date("2026-10-01T00:00:00Z"));

    const repos = await discoverRepos(join(root, "src"));
    expect(repos.map((r) => [`${r.owner}/${r.repo}`, r.sources])).toEqual([
      ["acme/api", ["claude-code", "folder"]],
      ["acme/app", ["pi", "folder"]],
      ["acme/beta", ["folder"]],
      ["acme/zeta", ["folder"]],
    ]);
    expect(repos[0]?.lastUsedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("merges clones and worktrees of one repo into a single candidate", async () => {
    clone(join(root, "src", "one"), "git@github.com:Acme/App.git");
    clone(join(root, "src", "two"), "https://github.com/acme/app");
    const repos = await discoverRepos(join(root, "src"));
    expect(repos).toHaveLength(1);
  });

  it("drops remotes with a transport that can run code", async () => {
    clone(join(root, "src", "evil"), "ext::sh -c touch% /tmp/pwned");
    clone(join(root, "src", "local"), "file:///tmp/repo.git");
    expect(await discoverRepos(join(root, "src"))).toEqual([]);
  });

  it("finds session repos without a folder", async () => {
    const app = clone(join(root, "app"), "git@github.com:acme/app.git");
    piSession("--app--", app, new Date());
    expect((await discoverRepos(null)).map((r) => r.repo)).toEqual(["app"]);
  });
});
