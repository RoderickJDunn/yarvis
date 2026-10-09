import { basename } from "node:path";

/**
 * The keys a project is matched by, from however it was named: `owner/repo`
 * gives both that and the bare repo name, a path gives its last segment, and
 * case and a trailing `.git` don't count. A memory stores the keys of the
 * project it came from; a recall names the project it is asked from; they
 * match when the two share a key. Imprecise on purpose (two unrelated repos
 * called `infra` will match), because it only decides ranking, never what
 * may be returned.
 */
export function projectKeys(name: string): string[] {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!cleaned) return [];
  const [owner, repo, ...rest] = cleaned.split("/").filter(Boolean);
  const isOwnerRepo = owner && repo && rest.length === 0 && !/^[~./]/.test(cleaned);
  if (isOwnerRepo) return [`${owner}/${repo}`, repo];
  const last = basename(cleaned);
  return last ? [last] : [];
}
