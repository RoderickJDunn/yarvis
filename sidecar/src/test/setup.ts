import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the whole suite off the user's ~/.yarvis, so a test that forgets its own
// override can't write their settings.json or load their agent definitions.
const dir = mkdtempSync(join(tmpdir(), "yarvis-sidecar-test-"));
process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
process.env.YARVIS_AGENTS_DIR = join(dir, "agents");
// Likewise the other agents' homes, which the import scanners read.
process.env.CLAUDE_HOME = join(dir, "claude");
process.env.YARVIS_PI_HOME = join(dir, "pi");

// A top-level afterAll in a preload runs once, after every test file.
// process.on("exit") never fires under bun test.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
