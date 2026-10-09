import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

let root: string;
const previous = {
  claude: process.env.CLAUDE_HOME,
  pi: process.env.YARVIS_PI_HOME,
  settings: process.env.YARVIS_SETTINGS_PATH,
};

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const memoryFile = join("claude", "projects", "-repo", "memory", "feedback_mcp.md");

beforeEach(async () => {
  await sql`TRUNCATE memories, repos RESTART IDENTITY CASCADE`;
  root = mkdtempSync(join(tmpdir(), "yarvis-import-routes-"));
  process.env.CLAUDE_HOME = join(root, "claude");
  process.env.YARVIS_PI_HOME = join(root, "pi");
  process.env.YARVIS_SETTINGS_PATH = join(root, "settings.json");
});

afterEach(() => {
  process.env.CLAUDE_HOME = previous.claude;
  process.env.YARVIS_PI_HOME = previous.pi;
  process.env.YARVIS_SETTINGS_PATH = previous.settings;
  rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

interface Candidate {
  id: string;
  status: string;
}

async function candidates(): Promise<Candidate[]> {
  return (await app.request("/api/import/memories", { headers: auth })).json() as Promise<
    Candidate[]
  >;
}

async function post(path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("import routes: memories", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/import/memories")).status).toBe(401);
  });

  it("imports a file once, then supersedes its memory when the file changes", async () => {
    write(join(root, memoryFile), "---\nname: MCP\ntype: feedback\n---\nUse MCP tools.");
    const [first] = await candidates();
    expect(first?.status).toBe("new");

    expect((await post("/api/import/memories", { ids: [first?.id] })).body).toEqual({
      added: 1,
      updated: 0,
      unchanged: 0,
      missing: 0,
    });
    expect((await candidates())[0]?.status).toBe("imported");
    expect((await post("/api/import/memories", { ids: [first?.id] })).body.unchanged).toBe(1);

    write(join(root, memoryFile), "---\nname: MCP\ntype: feedback\n---\nUse MCP tools, never gh.");
    expect((await candidates())[0]?.status).toBe("changed");
    expect((await post("/api/import/memories", { ids: [first?.id] })).body.updated).toBe(1);

    const rows = await sql<{ content: string; kind: string; superseded: boolean }[]>`
      SELECT content, kind, superseded_at IS NOT NULL AS superseded FROM memories ORDER BY created_at`;
    expect(rows.map((r) => [r.kind, r.superseded])).toEqual([
      ["agent-feedback", true],
      ["agent-feedback", false],
    ]);
    expect(rows[1]?.content).toContain("never gh");
  });

  it("stores the file as it reads on disk, not as the client last saw it", async () => {
    write(join(root, memoryFile), "first version");
    const [candidate] = await candidates();
    write(join(root, memoryFile), "second version");
    await post("/api/import/memories", { ids: [candidate?.id] });
    const [row] = await sql<{ content: string }[]>`SELECT content FROM memories`;
    expect(row?.content).toContain("second version");
  });

  it("counts ids that no longer name a file", async () => {
    expect((await post("/api/import/memories", { ids: ["gone"] })).body.missing).toBe(1);
  });
});

describe("import routes: repos", () => {
  function clone(path: string, cloneUrl: string) {
    write(join(path, ".git", "config"), `[remote "origin"]\n\turl = ${cloneUrl}\n`);
  }

  it("rejects a folder that is relative or missing", async () => {
    const relative = await app.request("/api/import/repos?folder=src", { headers: auth });
    expect(relative.status).toBe(400);
    const missing = await app.request(
      `/api/import/repos?folder=${encodeURIComponent(join(root, "nope"))}`,
      { headers: auth },
    );
    expect(missing.status).toBe(400);
  });

  it("registers chosen repos once and marks them registered", async () => {
    clone(join(root, "src", "app"), "git@github.com:acme/app.git");
    const folder = encodeURIComponent(join(root, "src"));
    const list = async () =>
      (await (
        await app.request(`/api/import/repos?folder=${folder}`, { headers: auth })
      ).json()) as {
        cloneUrl: string;
        registered: boolean;
      }[];

    const [found] = await list();
    expect(found?.registered).toBe(false);

    const urls = [found?.cloneUrl, "https://github.com/ACME/app"];
    expect((await post("/api/import/repos", { cloneUrls: urls })).body).toEqual({
      added: 1,
      skipped: 1,
      errors: [],
    });
    expect((await list())[0]?.registered).toBe(true);
    const repos = await sql<{ owner: string; repo: string }[]>`SELECT owner, repo FROM repos`;
    expect([...repos]).toEqual([{ owner: "acme", repo: "app" }]);
  });

  it("reports a clone URL createRepo refuses", async () => {
    const { body } = await post("/api/import/repos", { cloneUrls: ["ext::sh -c x"] });
    expect(body.added).toBe(0);
    expect((body.errors as unknown[]).length).toBe(1);
  });
});
