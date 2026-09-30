import { unlinkSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The sidecar's port is picked fresh each launch, so the native host cannot be
 * configured with it. Each running instance writes its own file here — name,
 * port, the bridge's scoped token and its pid — readable by the user alone, and
 * the host connects to every live one. Nothing about the browser is singular to
 * the machine, so every instance writes one, not just the one that owns
 * background work.
 */

export interface InstanceDiscovery {
  name: string;
  port: number;
  token: string;
  pid: number;
}

export function instancesDir(): string {
  return (
    process.env.YARVIS_BROWSER_INSTANCES_DIR ?? join(homedir(), ".yarvis", "browser", "instances")
  );
}

/** Instance names are free text; the file name only needs to be unique and safe. */
export function instanceFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "instance"}.json`;
}

export async function writeDiscovery(entry: InstanceDiscovery): Promise<string> {
  const dir = instancesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, instanceFileName(entry.name));
  await writeFile(path, JSON.stringify(entry), { mode: 0o600 });
  // `mode` only applies when the file is created; an older file keeps its bits.
  await chmod(path, 0o600);
  return path;
}

/**
 * Removes this instance's file on the way out, so the popup stops listing it.
 * Best effort: a crash leaves the file, and the host skips it once the pid is
 * gone.
 */
export function removeDiscoveryOnExit(path: string): void {
  process.on("exit", () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  });
}
