import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_CONTENT_CHARS, scanMemoryFiles } from "./memoryFiles.ts";

let root: string;
const previous = { claude: process.env.CLAUDE_HOME, pi: process.env.YARVIS_PI_HOME };

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-import-memory-"));
  process.env.CLAUDE_HOME = join(root, "claude");
  process.env.YARVIS_PI_HOME = join(root, "pi");
});

afterEach(() => {
  process.env.CLAUDE_HOME = previous.claude;
  process.env.YARVIS_PI_HOME = previous.pi;
  rmSync(root, { recursive: true, force: true });
});

const claudeMemory = (project: string, file: string) =>
  join(root, "claude", "projects", project, "memory", file);

describe("scanMemoryFiles", () => {
  it("maps Claude Code memory types to Yarvis kinds, in either frontmatter shape", async () => {
    write(
      claudeMemory("-repo", "feedback_mcp.md"),
      "---\nname: Use MCP tools\ndescription: Prefer MCP over gh\ntype: feedback\n---\nNever use gh.",
    );
    write(
      claudeMemory("-repo", "project_drift.md"),
      "---\nname: drift\ndescription: SSM drift\nmetadata:\n  type: project\n---\nPasswords regenerate.",
    );
    write(claudeMemory("-repo", "user_role.md"), "---\nname: role\ntype: user\n---\nA manager.");
    write(claudeMemory("-repo", "ref.md"), "---\nname: ref\ntype: reference\n---\nSee the wiki.");

    const kinds = Object.fromEntries((await scanMemoryFiles()).map((c) => [c.title, c.kind]));
    expect(kinds).toEqual({
      "Use MCP tools": "agent-feedback",
      drift: "project",
      role: "preference",
      ref: "fact",
    });
  });

  it("composes the stored text with its origin and description", async () => {
    write(
      claudeMemory("-repo", "feedback_mcp.md"),
      "---\nname: Use MCP tools\ndescription: Prefer MCP over gh\ntype: feedback\n---\nNever use gh.",
    );
    const [candidate] = await scanMemoryFiles();
    expect(candidate?.content).toBe(
      "Claude Code memory (-repo): Use MCP tools\n\nPrefer MCP over gh\n\nNever use gh.",
    );
    expect(candidate?.hash).toHaveLength(64);
  });

  it("skips the MEMORY.md index and reads the global memory folder", async () => {
    write(claudeMemory("-repo", "MEMORY.md"), "- [a](a.md) — hook");
    write(join(root, "claude", "memory", "style.md"), "No frontmatter here.");
    const candidates = await scanMemoryFiles();
    expect(candidates.map((c) => [c.scope, c.title, c.kind])).toEqual([
      ["global", "style", "fact"],
    ]);
  });

  it("does not follow a symlink planted among the memory files", async () => {
    const outside = join(root, "secret.txt");
    write(outside, "outside the memory folder");
    mkdirSync(dirname(claudeMemory("-repo", "x")), { recursive: true });
    symlinkSync(outside, claudeMemory("-repo", "linked.md"));
    expect(await scanMemoryFiles()).toEqual([]);
  });

  it("redacts credential shapes and caps the stored length", async () => {
    write(claudeMemory("-repo", "token.md"), `token ghp_${"a".repeat(30)} here`);
    write(claudeMemory("-repo", "long.md"), "x".repeat(MAX_CONTENT_CHARS + 500));
    const byTitle = Object.fromEntries((await scanMemoryFiles()).map((c) => [c.title, c]));
    expect(byTitle.token?.content).toContain("[redacted-token]");
    expect(byTitle.token?.content).not.toContain("ghp_");
    expect(byTitle.long?.truncated).toBe(true);
    expect(byTitle.long?.content.endsWith("…(truncated)")).toBe(true);
  });

  it("reads pi-memory-md files, skipping task templates and the repo's .git", async () => {
    const memory = join(root, "pi", "memory-md");
    write(
      join(memory, "hypercube", "core", "project", "dns.md"),
      '---\ndescription: "DNS fix"\ntags: ["docker"]\n---\n\n# Docker DNS\n\nUse 8.8.8.8.',
    );
    write(join(memory, "hypercube", "core", "USER.md"), "Prefers terse answers.");
    write(join(memory, "hypercube", "core", "TASK.md"), "template");
    write(join(memory, ".git", "notes.md"), "not memory");

    const candidates = await scanMemoryFiles();
    expect(candidates.map((c) => [c.tool, c.scope, c.title, c.kind])).toEqual([
      ["pi", "hypercube", "USER", "preference"],
      ["pi", "hypercube", "Docker DNS", "fact"],
    ]);
    expect(candidates[1]?.description).toBe("DNS fix");
  });

  it("honours pi-memory-md's localPath setting", async () => {
    const custom = join(root, "elsewhere");
    write(
      join(root, "pi", "agent", "settings.json"),
      JSON.stringify({ "pi-memory-md": { memoryDir: { localPath: custom } } }),
    );
    write(join(custom, "global", "MEMORY.md"), "Durable note.");
    const candidates = await scanMemoryFiles();
    expect(candidates.map((c) => [c.scope, c.title])).toEqual([["global", "MEMORY"]]);
  });

  it("tags a clone's memories with its remote's owner/repo, and global ones with nothing", async () => {
    const repo = join(root, "clones", "app-worktree");
    write(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Acme/App.git\n');
    // Named the way Claude Code names it, so the session's cwd is trusted.
    const projectDir = repo.replace(/[^A-Za-z0-9]/g, "-");
    write(
      join(root, "claude", "projects", projectDir, "s.jsonl"),
      `${JSON.stringify({ type: "user", cwd: repo, message: { content: "hi" } })}\n`,
    );
    write(claudeMemory(projectDir, "gotcha.md"), "Run make first.");
    write(join(root, "claude", "memory", "style.md"), "Be terse.");
    write(join(root, "pi", "memory-md", "hypercube", "core", "dns.md"), "Use 8.8.8.8.");

    const projects = Object.fromEntries(
      (await scanMemoryFiles()).map((c) => [c.title, c.projects]),
    );
    expect(projects).toEqual({
      gotcha: ["acme/app", "app", "app-worktree"],
      style: [],
      dns: ["hypercube"],
    });
  });

  it("ignores a session cwd that is not the project's own directory", async () => {
    const repo = join(root, "clones", "app");
    write(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
    const projectDir = repo.replace(/[^A-Za-z0-9]/g, "-");
    write(
      join(root, "claude", "projects", projectDir, "s.jsonl"),
      [root, repo]
        .map((cwd) => JSON.stringify({ type: "user", cwd, message: { content: "x" } }))
        .join("\n"),
    );
    write(claudeMemory(projectDir, "gotcha.md"), "Run make first.");
    const [candidate] = await scanMemoryFiles();
    expect(candidate?.projects).toContain("acme/app");
  });

  it("gives a file the same id on every scan", async () => {
    write(claudeMemory("-repo", "a.md"), "one");
    const [first] = await scanMemoryFiles();
    write(claudeMemory("-repo", "a.md"), "two");
    const [second] = await scanMemoryFiles();
    expect(second?.id).toBe(first?.id as string);
    expect(second?.hash).not.toBe(first?.hash as string);
  });
});
