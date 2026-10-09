import { describe, expect, it } from "bun:test";
import { projectKeys } from "./projects.ts";

describe("projectKeys", () => {
  it("keys owner/repo by both the pair and the repo", () => {
    expect(projectKeys("Wealthsimple/Hypercube.git")).toEqual([
      "wealthsimple/hypercube",
      "hypercube",
    ]);
  });

  it("keys a path by its last segment", () => {
    expect(projectKeys("~/Work/data-vault")).toEqual(["data-vault"]);
    expect(projectKeys("/Users/me/src/acme/api/")).toEqual(["api"]);
  });

  it("keys a bare name by itself, and nothing by nothing", () => {
    expect(projectKeys("hypercube")).toEqual(["hypercube"]);
    expect(projectKeys("  ")).toEqual([]);
  });
});
