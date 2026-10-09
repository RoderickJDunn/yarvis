import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listProjects } from "../cc/sessions.ts";
import { assertSafeCloneUrl, parseGitUrl } from "../workspaces/service.ts";
import { piHome, resolveProjectDir } from "./paths.ts";

/**
 * Finds the repos the user works in, so registering them for Workspaces is a
 * checklist rather than a form per repo.
 *
 * The strongest signal is where agent sessions ran: Claude Code and Pi both
 * record each session's working directory, and how recently a session ran
 * there orders the list. A parent folder of clones is the fallback for repos
 * no session has touched.
 *
 * A clone's remote is read from its `.git/config` as text. Running `git` in a
 * directory would honour that repo's own config, and these are arbitrary
 * directories found on disk, not repos the user has registered yet.
 */

export type RepoSource = "claude-code" | "pi" | "folder";

export interface RepoCandidate {
  cloneUrl: string;
  owner: string;
  repo: string;
  /** Where it was found, which may be one of several clones or worktrees. */
  localPath: string;
  sources: RepoSource[];
  /** Newest session in it, when a session found it. */
  lastUsedAt: string | null;
}

interface Sighting {
  path: string;
  source: RepoSource;
  at: string | null;
}

/** Ancestors checked when a session ran in a subdirectory of its repo. */
const MAX_ANCESTORS = 6;
/** Directories probed under a parent folder, so pointing it at `~` stays bounded. */
const MAX_FOLDER_PROBES = 2_000;
const MAX_CONFIG_BYTES = 64 * 1024;
/** A Pi session's first line is its header; nothing past this is read. */
const PI_HEADER_BYTES = 4_096;

export async function discoverRepos(folder: string | null): Promise<RepoCandidate[]> {
  const sightings: Sighting[] = [
    ...(await claudeCodeSightings()),
    ...(await piSightings(piHome())),
    ...(folder ? await folderSightings(folder) : []),
  ];

  const byKey = new Map<string, RepoCandidate>();
  for (const sighting of sightings) {
    const cloneUrl = await readOriginUrl(sighting.path);
    if (!cloneUrl) continue;
    const parsed = parseGitUrl(cloneUrl);
    if (!parsed || !isSafeCloneUrl(cloneUrl)) continue;
    const key = repoKey(parsed.owner, parsed.repo);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        cloneUrl,
        owner: parsed.owner,
        repo: parsed.repo,
        localPath: sighting.path,
        sources: [sighting.source],
        lastUsedAt: sighting.at,
      });
      continue;
    }
    if (!existing.sources.includes(sighting.source)) existing.sources.push(sighting.source);
    if (sighting.at && (!existing.lastUsedAt || sighting.at > existing.lastUsedAt)) {
      existing.lastUsedAt = sighting.at;
    }
  }

  // Repos a session ran in first, most recent first; then the rest by name.
  return [...byKey.values()].sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt || b.lastUsedAt) return a.lastUsedAt ? -1 : 1;
    return `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
  });
}

/** How two clone URLs are recognised as the same repo, here and against the registry. */
export function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function isSafeCloneUrl(url: string): boolean {
  try {
    assertSafeCloneUrl(url);
    return true;
  } catch {
    return false;
  }
}

async function claudeCodeSightings(): Promise<Sighting[]> {
  const projects = await listProjects().catch(() => []);
  return projects.flatMap((p) => {
    const path = resolveProjectDir(p.dir, p.path);
    return path ? [{ path, source: "claude-code" as const, at: p.updatedAt }] : [];
  });
}

/**
 * Pi names a session directory after its working directory, as lossily as
 * Claude Code does, but each session file opens with a header recording the
 * real `cwd`.
 */
async function piSightings(piRoot: string): Promise<Sighting[]> {
  const sessionsDir = join(piRoot, "agent", "sessions");
  const sightings: Sighting[] = [];
  for (const dir of await entries(sessionsDir)) {
    if (!dir.isDirectory()) continue;
    const full = join(sessionsDir, dir.name);
    const newest = await newestSession(full);
    if (!newest) continue;
    const cwd = await piSessionCwd(join(full, newest.name));
    if (cwd)
      sightings.push({ path: cwd, source: "pi", at: new Date(newest.mtimeMs).toISOString() });
  }
  return sightings;
}

async function newestSession(dir: string): Promise<{ name: string; mtimeMs: number } | null> {
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const entry of await entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stat = await lstat(join(dir, entry.name)).catch(() => null);
    if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) {
      newest = { name: entry.name, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
}

export async function piSessionCwd(file: string): Promise<string | null> {
  const header = await readHead(file, PI_HEADER_BYTES);
  const firstLine = header?.split("\n")[0];
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine);
    return parsed?.type === "session" &&
      typeof parsed.cwd === "string" &&
      parsed.cwd.startsWith("/")
      ? parsed.cwd
      : null;
  } catch {
    return null;
  }
}

/**
 * Clones directly under the folder, and one level further for a folder of
 * folders (`~/src/<org>/<repo>`). A clone's own subdirectories are not entered.
 */
async function folderSightings(folder: string): Promise<Sighting[]> {
  const sightings: Sighting[] = [];
  let probes = 0;
  const visit = async (dir: string, depth: number) => {
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (++probes > MAX_FOLDER_PROBES) return;
      const path = join(dir, entry.name);
      if (await hasGitEntry(path)) sightings.push({ path, source: "folder", at: null });
      else if (depth > 0) await visit(path, depth - 1);
    }
  };
  await visit(folder, 1);
  return sightings;
}

async function hasGitEntry(dir: string): Promise<boolean> {
  const stat = await lstat(join(dir, ".git")).catch(() => null);
  return Boolean(stat && (stat.isDirectory() || stat.isFile()));
}

/**
 * The URL of `origin` (or the first remote, when there is no `origin`) for the
 * repo containing `path`. Handles a linked worktree, whose `.git` is a file
 * pointing at a gitdir that shares its config with the main clone.
 */
export async function readOriginUrl(path: string): Promise<string | null> {
  const gitDir = await findGitDir(path);
  if (!gitDir) return null;
  const commonDir = await readSmall(join(gitDir, "commondir"));
  const configDir = commonDir ? resolve(gitDir, commonDir.trim()) : gitDir;
  const config = await readSmall(join(configDir, "config"));
  return config ? remoteUrl(config) : null;
}

async function findGitDir(start: string): Promise<string | null> {
  const home = homedir();
  let dir = resolve(start);
  for (let i = 0; i <= MAX_ANCESTORS; i++) {
    const dotGit = join(dir, ".git");
    const stat = await lstat(dotGit).catch(() => null);
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const pointer = (await readSmall(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      return pointer ? resolve(dir, pointer) : null;
    }
    const parent = dirname(dir);
    // A session in a scratch folder under home must not resolve to a dotfiles
    // repo at home itself.
    if (parent === dir || parent === home || !parent.startsWith(`${home}/`)) return null;
    dir = parent;
  }
  return null;
}

export function remoteUrl(config: string): string | null {
  const urls = new Map<string, string>();
  let remote: string | null = null;
  for (const line of config.split("\n")) {
    const section = line.match(/^\s*\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/);
    if (section) {
      remote = section[1]?.toLowerCase() === "remote" ? (section[2] ?? null) : null;
      continue;
    }
    const url = remote ? line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1] : undefined;
    if (remote && url && !urls.has(remote)) urls.set(remote, url);
  }
  return urls.get("origin") ?? urls.values().next().value ?? null;
}

async function readSmall(path: string): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
  return readFile(path, "utf8").catch(() => null);
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
