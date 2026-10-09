import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { MemoryCandidate, RepoCandidate } from "../lib/imports";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";

const memory = (over: Partial<MemoryCandidate>): MemoryCandidate => ({
  id: "m",
  tool: "claude-code",
  path: "/x.md",
  scope: "~/Work/app",
  title: "A memory",
  description: null,
  kind: "fact",
  content: "text",
  hash: "h",
  truncated: false,
  status: "new",
  ...over,
});

const repo = (over: Partial<RepoCandidate>): RepoCandidate => ({
  cloneUrl: "git@github.com:acme/app.git",
  owner: "acme",
  repo: "app",
  localPath: "/src/app",
  sources: ["folder"],
  lastUsedAt: null,
  registered: false,
  ...over,
});

mock.module("../lib/imports", () => ({
  IMPORT_FOLDER_KEY: "yarvis.import.folder",
  listMemoryCandidates: async () => [
    memory({ id: "a", title: "Use MCP tools", kind: "agent-feedback" }),
    memory({ id: "b", title: "Old fact", status: "imported" }),
    memory({ id: "c", tool: "pi", scope: "hypercube", title: "DNS fix", status: "changed" }),
    memory({ id: "d", scope: "~/Work/done", title: "Done one", status: "imported" }),
  ],
  listRepoCandidates: async () => [
    repo({
      cloneUrl: "git@github.com:acme/api.git",
      repo: "api",
      sources: ["claude-code"],
      lastUsedAt: "2026-10-01T00:00:00.000Z",
    }),
    repo({ cloneUrl: "git@github.com:acme/web.git", repo: "web", registered: true }),
    repo({}),
  ],
  importMemories: async (ids: string[]) => {
    calls.memories.push(ids);
    return { added: ids.length, updated: 0, unchanged: 0, missing: 0 };
  },
  importRepos: async (urls: string[]) => {
    calls.repos.push(urls);
    return { added: urls.length, skipped: 0, errors: [] };
  },
}));

const calls: { memories: string[][]; repos: string[][] } = { memories: [], repos: [] };

const { default: ImportDialog } = await import("./ImportDialog");
const { default: SetupGuide } = await import("./onboarding/SetupGuide");

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  calls.memories = [];
  calls.repos = [];
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
}

describe("ImportDialog", () => {
  it("groups memories by tool and project and preselects only what is not imported", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(ImportDialog, { initialTab: "memories", onClose: () => {} }),
      ),
    );
    expect(text).toContain("Claude Code · ~/Work/app");
    expect(text).toContain("Pi · hypercube");
    expect(text).toContain("Memories (2)");
    expect(text).toContain("Import 2 memories");
  });

  it("shows imported memories, and a group of only those, as done rather than unticked", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(ImportDialog, { initialTab: "memories", onClose: () => {} }),
    );
    cleanup = unmount;
    const box = (label: string) =>
      host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) as HTMLInputElement;
    expect([box("Old fact").checked, box("Old fact").disabled]).toEqual([true, true]);
    expect([box("DNS fix").checked, box("DNS fix").disabled]).toEqual([true, false]);

    const groupBox = [...host.querySelectorAll("label")]
      .find((l) => l.textContent?.includes("~/Work/done"))
      ?.querySelector("input") as HTMLInputElement;
    expect([groupBox.checked, groupBox.disabled]).toEqual([true, true]);
    expect(host.textContent).toContain("2 of 4 are already imported and up to date.");
  });

  it("preselects repos from agent sessions but not folder-only or registered ones", async () => {
    const text = textOf(
      await renderToHtml(createElement(ImportDialog, { initialTab: "repos", onClose: () => {} })),
    );
    expect(text).toContain("From agent sessions");
    expect(text).toContain("From the folder");
    expect(text).toContain("registered");
    expect(text).toContain("Import 1 repo");
  });

  it("imports only the tab on screen, so opening it for repos leaves memories alone", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(ImportDialog, { initialTab: "repos", onClose: () => {} }),
    );
    cleanup = unmount;
    button(host, "Import 1 repo").click();
    await settle();
    expect(calls.repos).toEqual([["git@github.com:acme/api.git"]]);
    expect(calls.memories).toEqual([]);
  });
});

describe("the setup guide's import step", () => {
  it("makes its own primary button import both tabs and move on", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(SetupGuide, {
        open: true,
        onClose: () => {},
        onNavigate: () => {},
        onStartTour: () => {},
      }),
    );
    cleanup = unmount;
    host.querySelector<HTMLButtonElement>('[aria-label="Import"]')?.click();
    await settle();

    expect(host.textContent).toContain("2 memories · 1 repo selected");
    expect(host.textContent).not.toContain("Next");
    button(host, "Import and continue").click();
    await settle();

    expect(calls.memories).toEqual([["a", "c"]]);
    expect(calls.repos).toEqual([["git@github.com:acme/api.git"]]);
    expect(host.textContent).toContain("You're set up");
  });

  it("moves on without importing when Skip is pressed", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(SetupGuide, {
        open: true,
        onClose: () => {},
        onNavigate: () => {},
        onStartTour: () => {},
      }),
    );
    cleanup = unmount;
    host.querySelector<HTMLButtonElement>('[aria-label="Import"]')?.click();
    await settle();
    button(host, "Skip").click();
    await settle();

    expect(calls.memories).toEqual([]);
    expect(host.textContent).toContain("You're set up");
  });
});
