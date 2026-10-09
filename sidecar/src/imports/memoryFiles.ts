import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { FrontmatterError, parseDocument } from "../agents/frontmatter.ts";
import { ccHome, listProjects } from "../cc/sessions.ts";
import type { MemoryKind } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";
import { projectKeys } from "../memory/projects.ts";
import { parseGitUrl } from "../workspaces/service.ts";
import { expandHome, piHome, resolveProjectDir, tildify } from "./paths.ts";
import { readOriginUrl } from "./repos.ts";

/**
 * Finds the memory files other agents keep on this machine and turns each into
 * the memory Yarvis would store for it. Nothing here writes: the import routes
 * decide what is new, and they re-scan rather than trusting a client's copy of
 * the content, so what is stored is always what is on disk.
 *
 * Only curated memory is read. Transcripts have the digest job, instruction
 * files (`CLAUDE.md`, `AGENTS.md`) are instructions rather than memories and
 * are already loaded by the agents that own them, and agent or skill
 * definitions never become Yarvis's (see `~/.yarvis/agents`).
 */

export type ImportTool = "claude-code" | "pi";

export interface MemoryCandidate {
  /** Stable across scans: derived from the tool and the file's path. */
  id: string;
  tool: ImportTool;
  path: string;
  /** The project the file belongs to (`~/Work/hypercube`), or `global`. */
  scope: string;
  title: string;
  description: string | null;
  kind: MemoryKind;
  /** Exactly what would be stored: redacted and capped. */
  content: string;
  /** Hash of `content`, so a re-import can tell an edited file from an unchanged one. */
  hash: string;
  /** Keys of the project it belongs to, for recall to rank by. Empty when global. */
  projects: string[];
  truncated: boolean;
}

/** Files above this are not memories anyone curated, and are skipped unread. */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Ceiling on a stored memory. Embedders cap their input (Gemini's at about 2k
 * tokens), and a memory past that is recalled by whatever its opening says.
 */
export const MAX_CONTENT_CHARS = 6_000;

/** pi-memory-md nests project memory a few levels down; nothing curated is deeper. */
const MAX_PI_DEPTH = 6;

const TOOL_LABEL: Record<ImportTool, string> = { "claude-code": "Claude Code", pi: "Pi" };

/** Claude Code's memory `type` → the Yarvis kind that reads the same way. */
const CLAUDE_KINDS: Record<string, MemoryKind> = {
  feedback: "agent-feedback",
  project: "project",
  user: "preference",
  reference: "fact",
};

export async function scanMemoryFiles(): Promise<MemoryCandidate[]> {
  const [claude, pi] = await Promise.all([scanClaudeCode(ccHome()), scanPi(piHome())]);
  return [...claude, ...pi];
}

async function scanClaudeCode(root: string): Promise<MemoryCandidate[]> {
  const candidates: MemoryCandidate[] = [];
  const globalDir = join(root, "memory");
  for (const file of await markdownFiles(globalDir)) {
    const candidate = await claudeCandidate(join(globalDir, file), "global", []);
    if (candidate) candidates.push(candidate);
  }

  const projectsDir = join(root, "projects");
  const projectPaths = await projectPathsByDir();
  for (const dir of await subdirectories(projectsDir)) {
    const memoryDir = join(projectsDir, dir, "memory");
    const projectPath = resolveProjectDir(dir, projectPaths.get(dir) ?? null);
    const scope = tildify(projectPath ?? dir);
    const projects = await projectKeysFor(projectPath);
    for (const file of await markdownFiles(memoryDir)) {
      // MEMORY.md is Claude Code's index of the files beside it, not a memory.
      if (file === "MEMORY.md") continue;
      const candidate = await claudeCandidate(join(memoryDir, file), scope, projects);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

async function projectPathsByDir(): Promise<Map<string, string>> {
  const projects = await listProjects().catch(() => []);
  return new Map(projects.flatMap((p) => (p.path ? [[p.dir, p.path] as const] : [])));
}

/**
 * A project directory that is a clone is keyed by its remote's `owner/repo`,
 * which is what stays the same between a clone in `~/Work` and the one a
 * workspace makes. Home itself is where general sessions start, not a project.
 */
async function projectKeysFor(path: string | null): Promise<string[]> {
  if (!path || path === homedir()) return [];
  const origin = await readOriginUrl(path);
  const parsed = origin ? parseGitUrl(origin) : null;
  return [
    ...new Set([
      ...(parsed ? projectKeys(`${parsed.owner}/${parsed.repo}`) : []),
      ...projectKeys(path),
    ]),
  ];
}

async function claudeCandidate(
  path: string,
  scope: string,
  projects: string[],
): Promise<MemoryCandidate | null> {
  const text = await readSmallFile(path);
  if (text === null) return null;
  const { data, body } = splitFrontmatter(path, text);
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const type = stringField(data.type) ?? stringField(metadata.type);
  return candidate({
    tool: "claude-code",
    path,
    scope,
    title: stringField(data.name) ?? stem(path),
    description: stringField(data.description),
    kind: (type && CLAUDE_KINDS[type]) || "fact",
    body,
    projects,
  });
}

async function scanPi(root: string): Promise<MemoryCandidate[]> {
  const memoryRoot = await piMemoryRoot(root);
  const candidates: MemoryCandidate[] = [];
  for (const path of await walkMarkdown(memoryRoot, MAX_PI_DEPTH)) {
    const name = basename(path);
    // TASK.md is pi-memory-md's template for a task, not something learned.
    if (name === "TASK.md") continue;
    const text = await readSmallFile(path);
    if (text === null) continue;
    const { data, body } = splitFrontmatter(path, text);
    const scope = relative(memoryRoot, path).split("/")[0] ?? "global";
    candidates.push(
      candidate({
        tool: "pi",
        path,
        scope,
        title: firstHeading(body) ?? stem(path),
        description: stringField(data.description),
        kind: name === "USER.md" ? "preference" : "fact",
        body,
        // pi-memory-md names a project after its git toplevel, so a session
        // started at home files its memory under the home folder's name.
        projects: scope === "global" || scope === basename(homedir()) ? [] : projectKeys(scope),
      }),
    );
  }
  return candidates;
}

/** pi-memory-md's `localPath` setting, falling back to its default location. */
async function piMemoryRoot(root: string): Promise<string> {
  const fallback = join(root, "memory-md");
  try {
    const settings = JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8"));
    const localPath = settings?.["pi-memory-md"]?.memoryDir?.localPath;
    if (typeof localPath === "string" && localPath.trim()) {
      const expanded = expandHome(localPath.trim());
      if (isAbsolute(expanded)) return expanded;
    }
  } catch {
    // No settings file, or one this can't read: the default location applies.
  }
  return fallback;
}

function candidate(input: {
  tool: ImportTool;
  path: string;
  scope: string;
  title: string;
  description: string | null;
  kind: MemoryKind;
  body: string;
  projects: string[];
}): MemoryCandidate {
  // The origin line keeps a project's memory recognisable as that project's
  // when it is recalled somewhere else.
  const composed = [
    `${TOOL_LABEL[input.tool]} memory (${input.scope}): ${input.title}`,
    input.description,
    input.body.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const redacted = redactSecrets(composed);
  const truncated = redacted.length > MAX_CONTENT_CHARS;
  const content = truncated ? `${redacted.slice(0, MAX_CONTENT_CHARS)}\n\n…(truncated)` : redacted;
  return {
    id: sha256(`${input.tool}:${input.path}`).slice(0, 16),
    tool: input.tool,
    path: input.path,
    scope: input.scope,
    title: input.title,
    description: input.description,
    kind: input.kind,
    content,
    hash: sha256(content),
    projects: input.projects,
    truncated,
  };
}

/** Frontmatter is optional in both tools' files: without it, the whole file is the body. */
function splitFrontmatter(
  path: string,
  text: string,
): { data: Record<string, unknown>; body: string } {
  try {
    return parseDocument(path, text);
  } catch (e) {
    if (e instanceof FrontmatterError) return { data: {}, body: text.trim() };
    throw e;
  }
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    // lstat, so a symlink planted among the memory files is not followed.
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Dirents report a symlink as a symlink, so neither of these follows one. */
async function markdownFiles(dir: string): Promise<string[]> {
  return (await entries(dir))
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

async function subdirectories(dir: string): Promise<string[]> {
  return (await entries(dir)).filter((e) => e.isDirectory()).map((e) => e.name);
}

async function walkMarkdown(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const found: string[] = [];
  for (const entry of await entries(dir)) {
    // Dot directories are the memory repo's `.git` and editor state.
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkMarkdown(path, depth - 1)));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

function firstHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function stem(path: string): string {
  return basename(path).replace(/\.md$/, "");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
