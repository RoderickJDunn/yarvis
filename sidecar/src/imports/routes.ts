import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { expandHome } from "./paths.ts";
import {
  importMemories,
  importRepos,
  listMemoryCandidates,
  listRepoCandidates,
} from "./service.ts";

const importMemoriesSchema = z.object({ ids: z.array(z.string().min(1)).max(1_000) });
const importReposSchema = z.object({ cloneUrls: z.array(z.string().min(1)).max(500) });

/**
 * Importing from the other agents on this machine, mounted under /api/import:
 * Claude Code and Pi memory files into memory, and the repos their sessions ran
 * in (or that sit under a folder the user names) into the Workspaces registry.
 */
export function createImportRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/memories", async (c) => c.json(await listMemoryCandidates(db())));

  router.post("/memories", async (c) => {
    const parsed = importMemoriesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const memory = new PgVectorMemoryStore(db(), await chooseEmbedder(config, db()));
    return c.json(await importMemories(db(), memory, parsed.data.ids));
  });

  router.get("/repos", async (c) => {
    const raw = c.req.query("folder")?.trim();
    let folder: string | null = null;
    if (raw) {
      const expanded = expandHome(raw);
      if (!isAbsolute(expanded)) return c.json({ error: "folder must be an absolute path" }, 400);
      folder = resolve(expanded);
      const info = await stat(folder).catch(() => null);
      if (!info?.isDirectory()) return c.json({ error: `not a folder: ${raw}` }, 400);
    }
    return c.json(await listRepoCandidates(db(), folder));
  });

  router.post("/repos", async (c) => {
    const parsed = importReposSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await importRepos(db(), config, parsed.data.cloneUrls));
  });

  return router;
}
