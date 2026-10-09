import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piHome(): string {
  return process.env.YARVIS_PI_HOME ?? join(homedir(), ".pi");
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The directory a Claude Code project folder stands for. Its name is the path
 * with every character other than a letter or digit turned into `-`, which
 * can't be decoded when a directory name has a dash or a dot in it. A session's
 * recorded working directory settles it, but only when it encodes back to the
 * folder's name: a session that ran a command from somewhere else records that
 * directory too, and may record it first.
 */
export function resolveProjectDir(dir: string, sessionCwd: string | null): string | null {
  if (sessionCwd && sessionCwd.replace(/[^A-Za-z0-9]/g, "-") === dir) return sessionCwd;
  return decodeProjectDir(dir);
}

/**
 * For a project with no session left to ask, rebuilds the path by trying, at
 * each step, the longest run of name pieces that exists on disk, joined as the
 * dashes or dots they may have been (`roderick.dunn`, `aurora-cyan-upgrade`).
 * Null when the directory is gone, rather than guessing at where the dashes were.
 */
export function decodeProjectDir(dir: string): string | null {
  const pieces = dir.replace(/^-/, "").split("-");
  let path = "/";
  let i = 0;
  while (i < pieces.length) {
    let next: string | null = null;
    for (let end = pieces.length; end > i && !next; end--) {
      const run = pieces.slice(i, end);
      for (const name of [run.join("-"), run.join(".")]) {
        if (name && existsSync(join(path, name))) {
          next = name;
          i = end;
          break;
        }
      }
    }
    if (!next) return null;
    path = join(path, next);
  }
  return path;
}
