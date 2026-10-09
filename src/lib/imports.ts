import { sidecarFetch } from "./api";
import type { MemoryKind } from "./memory";

/** Mirrors the sidecar's `imports/service.ts` views. */
export type ImportTool = "claude-code" | "pi";
export type ImportStatus = "new" | "changed" | "imported";

export interface MemoryCandidate {
  id: string;
  tool: ImportTool;
  path: string;
  scope: string;
  title: string;
  description: string | null;
  kind: MemoryKind;
  content: string;
  hash: string;
  truncated: boolean;
  status: ImportStatus;
}

export interface MemoryImportResult {
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
}

export type RepoSource = "claude-code" | "pi" | "folder";

export interface RepoCandidate {
  cloneUrl: string;
  owner: string;
  repo: string;
  localPath: string;
  sources: RepoSource[];
  lastUsedAt: string | null;
  registered: boolean;
}

export interface RepoImportResult {
  added: number;
  skipped: number;
  errors: { cloneUrl: string; error: string }[];
}

async function request<T>(path: string, action: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const detail =
      payload && typeof payload === "object" && "error" in payload ? payload.error : res.status;
    throw new Error(
      `${action} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
    );
  }
  return res.json();
}

export const listMemoryCandidates = () =>
  request<MemoryCandidate[]>("/api/import/memories", "scan memory files");

export const importMemories = (ids: string[]) =>
  request<MemoryImportResult>("/api/import/memories", "import memories", { ids });

export const listRepoCandidates = (folder: string) =>
  request<RepoCandidate[]>(
    `/api/import/repos${folder.trim() ? `?folder=${encodeURIComponent(folder.trim())}` : ""}`,
    "find repos",
  );

export const importRepos = (cloneUrls: string[]) =>
  request<RepoImportResult>("/api/import/repos", "import repos", { cloneUrls });

/** Where the parent-folder field starts, remembered across opens. */
export const IMPORT_FOLDER_KEY = "yarvis.import.folder";
