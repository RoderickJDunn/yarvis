import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IMPORT_FOLDER_KEY,
  type ImportStatus,
  type ImportTool,
  importMemories,
  importRepos,
  listMemoryCandidates,
  listRepoCandidates,
  type MemoryCandidate,
  type RepoCandidate,
  type RepoSource,
} from "../lib/imports";
import { GITHUB_ISSUES_PREFIX } from "../lib/issues/cacheKeys";
import { invalidatePrefix } from "../lib/resourceCache";

export type ImportTab = "memories" | "repos";

const TOOL_LABEL: Record<ImportTool, string> = { "claude-code": "Claude Code", pi: "Pi" };
const SOURCE_LABEL: Record<RepoSource, string> = {
  "claude-code": "Claude Code",
  pi: "Pi",
  folder: "folder",
};
const STATUS_STYLE: Record<ImportStatus, string> = {
  new: "bg-emerald-900 text-emerald-200",
  changed: "bg-amber-900 text-amber-200",
  imported: "bg-zinc-800 text-zinc-500",
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function countLabel(count: number, noun: "memory" | "repo"): string {
  const plural = noun === "memory" ? "memories" : "repos";
  return `${count} ${count === 1 ? noun : plural}`;
}

type Selection = [Set<string>, (update: (s: Set<string>) => Set<string>) => void];

function useMemoryImport(onImported: () => void) {
  const [candidates, setCandidates] = useState<MemoryCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listMemoryCandidates();
      setCandidates(next);
      // What is already in memory as it reads today has nothing to import.
      setSelected(new Set(next.filter((c) => c.status !== "imported").map((c) => c.id)));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (): Promise<boolean> => {
    setStatus(null);
    setError(null);
    try {
      const result = await importMemories([...selected]);
      setStatus(
        `Memories: added ${result.added}, updated ${result.updated}` +
          (result.unchanged ? `, ${result.unchanged} already up to date` : "") +
          (result.missing ? `, ${result.missing} no longer on disk` : "") +
          ".",
      );
      onImported();
      await load();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }, [selected, load, onImported]);

  return {
    candidates,
    selection: [selected, setSelected] as Selection,
    status,
    error,
    run,
  };
}

function useRepoImport(onImported: () => void) {
  const [folder, setFolder] = useState(() => localStorage.getItem(IMPORT_FOLDER_KEY) ?? "");
  const [candidates, setCandidates] = useState<RepoCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async (from: string) => {
    setScanning(true);
    try {
      const next = await listRepoCandidates(from);
      setCandidates(next);
      // Repos an agent session ran in are the ones the user actually works in;
      // a clone that only sits in the folder is offered but not assumed.
      setSelected(
        new Set(
          next
            .filter((c) => !c.registered && c.sources.some((s) => s !== "folder"))
            .map((c) => c.cloneUrl),
        ),
      );
      setError(null);
      if (from.trim()) localStorage.setItem(IMPORT_FOLDER_KEY, from.trim());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanning(false);
    }
  }, []);

  // Only the first scan reads the remembered folder; later ones are the button's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately runs once.
  useEffect(() => {
    void scan(folder);
  }, [scan]);

  const run = useCallback(async (): Promise<boolean> => {
    setStatus(null);
    setError(null);
    try {
      const result = await importRepos([...selected]);
      setStatus(
        `Repos: registered ${result.added}` +
          (result.skipped ? `, ${result.skipped} already registered` : "") +
          (result.errors.length ? `, ${result.errors.length} failed` : "") +
          ".",
      );
      if (result.errors.length) {
        setError(result.errors.map((e) => `${e.cloneUrl}: ${e.error}`).join("\n"));
      }
      // Same reason as ReposSection: the Issues tab's cached view of the repo
      // list would otherwise outlive the change.
      invalidatePrefix(GITHUB_ISSUES_PREFIX);
      onImported();
      await scan(folder);
      return result.errors.length === 0;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }, [selected, scan, folder, onImported]);

  return {
    candidates,
    selection: [selected, setSelected] as Selection,
    folder,
    setFolder,
    scanning,
    scan,
    status,
    error,
    run,
  };
}

export type ImportState = ReturnType<typeof useImport>;

/**
 * Both halves of an import and the tab between them, held by whoever owns the
 * button that starts it: the dialog's footer, or the setup guide's own.
 */
export function useImport(initialTab: ImportTab, onImported?: (tab: ImportTab) => void) {
  const [tab, setTab] = useState<ImportTab>(initialTab);
  const [busy, setBusy] = useState(false);
  // A ref, so a caller passing a fresh arrow each render doesn't hand the setup
  // guide a new action every render (each of which re-renders the step).
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const memoriesDone = useCallback(() => onImportedRef.current?.("memories"), []);
  const reposDone = useCallback(() => onImportedRef.current?.("repos"), []);
  const memories = useMemoryImport(memoriesDone);
  const repos = useRepoImport(reposDone);

  const withBusy = useCallback(async (work: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  }, []);

  const memoryCount = memories.selection[0].size;
  const repoCount = repos.selection[0].size;

  /** Imports what is ticked on both tabs; true only when nothing failed. */
  const runAll = useCallback(
    () =>
      withBusy(async () => {
        const memoriesOk = memoryCount ? await memories.run() : true;
        const reposOk = repoCount ? await repos.run() : true;
        return memoriesOk && reposOk;
      }),
    [withBusy, memoryCount, repoCount, memories.run, repos.run],
  );

  const runTab = useCallback(
    () => withBusy(tab === "memories" ? memories.run : repos.run),
    [withBusy, tab, memories.run, repos.run],
  );

  return { tab, setTab, busy, memories, repos, memoryCount, repoCount, runAll, runTab };
}

/**
 * Imports from the other agents on this machine: Claude Code and Pi memory
 * files into memory, and the repos their sessions ran in into the Workspaces
 * registry. Opened from Memory and from Settings → Repositories, which each
 * pick the tab they care about. Its button imports the tab on screen only, so
 * opening it for repos can't also import the memories ticked on the other tab.
 */
export default function ImportDialog({
  initialTab,
  onClose,
  onImported,
}: {
  initialTab: ImportTab;
  onClose: () => void;
  onImported?: (tab: ImportTab) => void;
}) {
  const state = useImport(initialTab, onImported);
  const count = state.tab === "memories" ? state.memoryCount : state.repoCount;
  const noun = state.tab === "memories" ? "memory" : "repo";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import from Claude Code and Pi"
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-medium text-zinc-100">Import from Claude Code and Pi</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ImportTabs state={state} />
        </div>
        <div className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-xs text-zinc-500">{countLabel(count, noun)} selected</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void state.runTab()}
              disabled={state.busy || count === 0}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              {state.busy ? "Importing…" : `Import ${countLabel(count, noun)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The two tabs and what each would import, without the button that starts it:
 * that belongs to the frame around them.
 */
export function ImportTabs({ state }: { state: ImportState }) {
  const { tab, setTab, memories, repos } = state;
  const messages = [memories.status, repos.status].filter(Boolean);
  const errors = [memories.error, repos.error].filter(Boolean);
  return (
    <>
      <div className="flex gap-1 border-b border-zinc-800 px-3 pt-2">
        <TabButton active={tab === "memories"} onClick={() => setTab("memories")}>
          Memories{state.memoryCount ? ` (${state.memoryCount})` : ""}
        </TabButton>
        <TabButton active={tab === "repos"} onClick={() => setTab("repos")}>
          Repos{state.repoCount ? ` (${state.repoCount})` : ""}
        </TabButton>
      </div>
      <div className="space-y-4 p-4">
        {/* Shown above either tab, so the outcome of importing both is never on the hidden one. */}
        {messages.map((m) => (
          <p key={m} className="text-xs text-emerald-300">
            {m}
          </p>
        ))}
        {errors.map((e) => (
          <p key={e} className="whitespace-pre-wrap text-xs text-red-400">
            {e}
          </p>
        ))}
        {tab === "memories" ? <MemoriesList memories={memories} /> : <ReposList repos={repos} />}
      </div>
    </>
  );
}

function MemoriesList({ memories }: { memories: ImportState["memories"] }) {
  const { candidates, selection } = memories;
  const [selected, setSelected] = selection;

  const groups = useMemo(() => {
    const byGroup = new Map<string, MemoryCandidate[]>();
    for (const c of candidates ?? []) {
      const key = `${TOOL_LABEL[c.tool]} · ${c.scope}`;
      byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
    }
    return [...byGroup.entries()];
  }, [candidates]);

  const imported = (candidates ?? []).filter((c) => c.status === "imported").length;

  if (!candidates) {
    return memories.error ? null : <p className="text-xs text-zinc-500">Scanning memory files…</p>;
  }
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        No memory files found under ~/.claude or ~/.pi/memory-md.
      </p>
    );
  }

  return (
    <>
      <p className="text-xs text-zinc-500">
        Curated memory files from Claude Code (<code>~/.claude/projects/*/memory</code>) and Pi
        (pi-memory-md). Imported memories are embedded with your embeddings provider and can be
        recalled by the assistant, by Claude Code sessions over MCP, and by the Telegram bot.
        Re-importing a file you have edited replaces its old memory.
      </p>
      {imported > 0 && (
        <p className="text-xs text-zinc-400">
          {imported === candidates.length
            ? `All ${imported} are already imported and up to date.`
            : `${imported} of ${candidates.length} are already imported and up to date.`}
        </p>
      )}
      {groups.map(([group, items]) => (
        <CheckGroup
          key={group}
          label={group}
          ids={items.filter((c) => c.status !== "imported").map((c) => c.id)}
          selected={selected}
          setSelected={setSelected}
        >
          {items.map((c) => (
            <li key={c.id} className="flex items-start gap-2 py-1.5">
              <input
                type="checkbox"
                className="mt-1"
                // Already in memory as it reads today: done, like a registered repo.
                disabled={c.status === "imported"}
                checked={c.status === "imported" || selected.has(c.id)}
                onChange={() => setSelected((s) => toggled(s, c.id))}
                aria-label={c.title}
              />
              <details className="min-w-0 flex-1">
                <summary className="cursor-pointer text-sm text-zinc-200">
                  {c.title}{" "}
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                    {c.kind}
                  </span>{" "}
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[c.status]}`}>
                    {c.status}
                  </span>
                  {c.truncated && <span className="ml-1 text-xs text-zinc-500">truncated</span>}
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-400">
                  {c.content}
                </pre>
              </details>
            </li>
          ))}
        </CheckGroup>
      ))}
    </>
  );
}

function ReposList({ repos }: { repos: ImportState["repos"] }) {
  const { candidates, selection, folder, setFolder, scanning, scan } = repos;
  const [selected, setSelected] = selection;
  const fromSessions = (candidates ?? []).filter((c) => c.lastUsedAt);
  const fromFolder = (candidates ?? []).filter((c) => !c.lastUsedAt);

  const renderRepo = (c: RepoCandidate) => (
    <li key={c.cloneUrl} className="flex items-start gap-2 py-1.5">
      <input
        type="checkbox"
        className="mt-1"
        disabled={c.registered}
        checked={c.registered || selected.has(c.cloneUrl)}
        onChange={() => setSelected((s) => toggled(s, c.cloneUrl))}
        aria-label={`${c.owner}/${c.repo}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200">
          {c.owner}/{c.repo}{" "}
          {c.registered && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">
              registered
            </span>
          )}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {c.sources.map((s) => SOURCE_LABEL[s]).join(", ")}
          {c.lastUsedAt ? ` · last session ${new Date(c.lastUsedAt).toLocaleDateString()}` : ""}
          {` · ${c.localPath}`}
        </div>
      </div>
    </li>
  );

  return (
    <>
      <p className="text-xs text-zinc-500">
        Repos your Claude Code and Pi sessions ran in come first. Add a parent folder to also list
        the clones under it. Registering saves the clone URL only: Workspaces makes its own clone
        the first time you open one.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void scan(folder);
        }}
      >
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="Parent folder of your clones, e.g. ~/src"
          aria-label="Parent folder"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={scanning}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </form>
      {!candidates && !repos.error && <p className="text-xs text-zinc-500">Looking for repos…</p>}
      {candidates && candidates.length === 0 && (
        <p className="text-xs text-zinc-500">No git clones found.</p>
      )}
      {fromSessions.length > 0 && (
        <CheckGroup
          label="From agent sessions"
          ids={fromSessions.filter((c) => !c.registered).map((c) => c.cloneUrl)}
          selected={selected}
          setSelected={setSelected}
        >
          {fromSessions.map(renderRepo)}
        </CheckGroup>
      )}
      {fromFolder.length > 0 && (
        <CheckGroup
          label="From the folder"
          ids={fromFolder.filter((c) => !c.registered).map((c) => c.cloneUrl)}
          selected={selected}
          setSelected={setSelected}
        >
          {fromFolder.map(renderRepo)}
        </CheckGroup>
      )}
    </>
  );
}

function CheckGroup({
  label,
  ids,
  selected,
  setSelected,
  children,
}: {
  label: string;
  ids: string[];
  selected: Set<string>;
  setSelected: (update: (s: Set<string>) => Set<string>) => void;
  children: React.ReactNode;
}) {
  // `ids` are the rows still to choose; a group with none left is all done.
  const allOn = ids.every((id) => selected.has(id));
  return (
    <section>
      <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        <input
          type="checkbox"
          checked={allOn}
          disabled={ids.length === 0}
          onChange={() =>
            setSelected((s) => {
              const next = new Set(s);
              for (const id of ids) {
                if (allOn) next.delete(id);
                else next.add(id);
              }
              return next;
            })
          }
        />
        {label}
      </label>
      <ul className="ml-1 mt-1 divide-y divide-zinc-800/60">{children}</ul>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t-md px-3 py-1.5 text-xs ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
