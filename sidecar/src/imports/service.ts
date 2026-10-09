import { and, isNull, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type MemorySourceRef, memories } from "../db/schema.ts";
import type { MemoryInput, MemoryService } from "../memory/index.ts";
import { createRepo, listRepos, parseGitUrl } from "../workspaces/service.ts";
import { type ImportTool, type MemoryCandidate, scanMemoryFiles } from "./memoryFiles.ts";
import { discoverRepos, type RepoCandidate, repoKey } from "./repos.ts";

/** Whether a file is already in memory as it reads today. */
export type ImportStatus = "new" | "changed" | "imported";

export interface MemoryCandidateView extends MemoryCandidate {
  status: ImportStatus;
}

export interface RepoCandidateView extends RepoCandidate {
  registered: boolean;
}

type ImportRef = Extract<MemorySourceRef, { type: "import" }>;

const SOURCE_LABEL: Record<ImportTool, string> = { "claude-code": "Claude Code", pi: "Pi" };

const fileKey = (tool: string, path: string) => `${tool}:${path}`;

/** Live memories an earlier import wrote, keyed by the file they came from. */
async function importedMemories(db: Db): Promise<Map<string, { id: string; hash: string }>> {
  const rows = await db
    .select({ id: memories.id, sourceRef: memories.sourceRef })
    .from(memories)
    .where(and(sql`${memories.sourceRef}->>'type' = 'import'`, isNull(memories.supersededAt)));
  const byFile = new Map<string, { id: string; hash: string }>();
  for (const row of rows) {
    const ref = row.sourceRef as ImportRef;
    byFile.set(fileKey(ref.tool, ref.path), { id: row.id, hash: ref.hash });
  }
  return byFile;
}

function statusOf(
  candidate: MemoryCandidate,
  existing: Map<string, { id: string; hash: string }>,
): ImportStatus {
  const prior = existing.get(fileKey(candidate.tool, candidate.path));
  if (!prior) return "new";
  return prior.hash === candidate.hash ? "imported" : "changed";
}

export async function listMemoryCandidates(db: Db): Promise<MemoryCandidateView[]> {
  const [candidates, existing] = await Promise.all([scanMemoryFiles(), importedMemories(db)]);
  return candidates.map((c) => ({ ...c, status: statusOf(c, existing) }));
}

export interface MemoryImportResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Ids the client sent that no longer name a file on disk. */
  missing: number;
}

/**
 * Stores the chosen files. The ids are looked up in a fresh scan rather than
 * accepted with content, so what lands in memory is what is on disk now. A
 * file that changed since its last import supersedes the memory it wrote,
 * which keeps the old text for the trail and out of recall.
 */
export async function importMemories(
  db: Db,
  memory: MemoryService,
  ids: string[],
): Promise<MemoryImportResult> {
  const wanted = new Set(ids);
  const [candidates, existing] = await Promise.all([scanMemoryFiles(), importedMemories(db)]);
  const chosen = candidates.filter((c) => wanted.has(c.id));

  const toAdd: MemoryInput[] = [];
  let updated = 0;
  let unchanged = 0;
  for (const candidate of chosen) {
    const write = {
      content: candidate.content,
      kind: candidate.kind,
      sourceRef: {
        type: "import",
        tool: candidate.tool,
        path: candidate.path,
        hash: candidate.hash,
      } satisfies ImportRef,
      metadata: {
        source: `${SOURCE_LABEL[candidate.tool]} import`,
        scope: candidate.scope,
        title: candidate.title,
        ...(candidate.projects.length ? { projects: candidate.projects } : {}),
      },
    };
    const prior = existing.get(fileKey(candidate.tool, candidate.path));
    if (!prior) {
      toAdd.push(write);
    } else if (prior.hash === candidate.hash) {
      unchanged += 1;
    } else {
      await memory.supersede(prior.id, write.content, write);
      updated += 1;
    }
  }
  // One embedding call for the batch rather than one per file.
  await memory.addMany(toAdd);
  return { added: toAdd.length, updated, unchanged, missing: wanted.size - chosen.length };
}

async function registeredKeys(db: Db): Promise<Set<string>> {
  return new Set((await listRepos(db)).map((r) => repoKey(r.owner, r.repo)));
}

export async function listRepoCandidates(
  db: Db,
  folder: string | null,
): Promise<RepoCandidateView[]> {
  const [candidates, registered] = await Promise.all([discoverRepos(folder), registeredKeys(db)]);
  return candidates.map((c) => ({ ...c, registered: registered.has(repoKey(c.owner, c.repo)) }));
}

export interface RepoImportResult {
  added: number;
  /** Already registered, or named twice in one request. */
  skipped: number;
  errors: { cloneUrl: string; error: string }[];
}

/** Registers each clone URL through `createRepo`, so the form's validation applies. */
export async function importRepos(
  db: Db,
  config: Config,
  cloneUrls: string[],
): Promise<RepoImportResult> {
  const seen = await registeredKeys(db);
  const result: RepoImportResult = { added: 0, skipped: 0, errors: [] };
  for (const cloneUrl of cloneUrls) {
    const parsed = parseGitUrl(cloneUrl);
    const key = parsed ? repoKey(parsed.owner, parsed.repo) : null;
    if (key && seen.has(key)) {
      result.skipped += 1;
      continue;
    }
    try {
      await createRepo(db, config, { cloneUrl });
      if (key) seen.add(key);
      result.added += 1;
    } catch (e) {
      result.errors.push({ cloneUrl, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
