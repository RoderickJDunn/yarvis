import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceFileName, writeDiscovery } from "./discovery.ts";

let dir: string | undefined;

async function useTempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "yarvis-discovery-"));
  const instances = join(dir, "nested", "instances");
  process.env.YARVIS_BROWSER_INSTANCES_DIR = instances;
  return instances;
}

afterEach(async () => {
  delete process.env.YARVIS_BROWSER_INSTANCES_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const entry = { name: "main", port: 4321, token: "tok", pid: 99 };

describe("writeDiscovery", () => {
  it("writes one file per instance where only the user can read it", async () => {
    const instances = await useTempDir();
    const path = await writeDiscovery(entry);
    await writeDiscovery({ ...entry, name: "my-branch", port: 5555 });

    expect(path).toBe(join(instances, "main.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(entry);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(instances, "my-branch.json"), "utf8")).port).toBe(5555);
  });

  it("tightens a file left readable by an earlier version", async () => {
    const instances = await useTempDir();
    await mkdir(instances, { recursive: true });
    const path = join(instances, "main.json");
    await writeFile(path, "{}");
    await chmod(path, 0o644);

    await writeDiscovery(entry);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("instanceFileName", () => {
  it("keeps a name that is already safe and slugs the rest", () => {
    expect(instanceFileName("migration-test")).toBe("migration-test.json");
    expect(instanceFileName("My Branch/../x")).toBe("my-branch-x.json");
    expect(instanceFileName("///")).toBe("instance.json");
  });
});
