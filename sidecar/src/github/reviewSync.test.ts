import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { listEvents, recordEvent } from "../events/service.ts";
import type { ReviewContribution } from "./client.ts";
import {
  githubReviewSyncJob,
  recordReviewContributions,
  reviewExternalId,
  syncWindow,
} from "./reviewSync.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const window = {
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date("2026-10-02T00:00:00Z"),
};

function contribution(over: Partial<ReviewContribution> = {}): ReviewContribution {
  return {
    reviewId: "R_1",
    state: "approved",
    submittedAt: "2026-10-01T12:00:00Z",
    owner: "o",
    repo: "r",
    number: 7,
    title: "Some PR",
    url: "https://github.com/o/r/pull/7",
    ...over,
  };
}

describe("recording synced reviews", () => {
  it("logs approvals and change requests at their submit time, and nothing else", async () => {
    const added = await recordReviewContributions(
      db,
      [
        contribution(),
        contribution({ reviewId: "R_2", state: "changes_requested", number: 8 }),
        contribution({ reviewId: "R_3", state: "commented", number: 9 }),
      ],
      window,
    );
    expect(added).toBe(2);
    const rows = await listEvents(db, { oldestFirst: true });
    expect(rows.map((r) => [r.type, r.source, r.payload, r.externalId])).toEqual([
      ["pr.approved", "github-sync", { ref: "gh:o/r/7" }, reviewExternalId("R_1")],
      ["pr.changes_requested", "github-sync", { ref: "gh:o/r/8" }, reviewExternalId("R_2")],
    ]);
    expect(rows[0]!.occurredAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("skips a review the app already logged with its id", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { ref: "gh:o/r/7", hasBody: false },
      externalId: reviewExternalId("R_1"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
    expect((await listEvents(db)).length).toBe(1);
  });

  it("treats an unkeyed in-app event a few minutes from the review as the same review", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { ref: "gh:o/r/7", hasBody: false },
      occurredAt: new Date("2026-10-01T12:02:00Z"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
  });

  it("still logs a second approval of the same PR given well after the first", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { ref: "gh:o/r/7" },
      occurredAt: new Date("2026-10-01T09:00:00Z"),
    });
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(1);
  });

  it("is safe to run over the same window twice", async () => {
    await recordReviewContributions(db, [contribution()], window);
    expect(await recordReviewContributions(db, [contribution()], window)).toBe(0);
    expect((await listEvents(db)).length).toBe(1);
  });
});

describe("the sync window", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  it("backfills two weeks on a first run", () => {
    expect(syncWindow(null, now)).toEqual({ from: new Date("2026-09-21T12:00:00Z"), to: now });
  });

  it("re-reads a day before the cursor, for contributions GitHub listed late", () => {
    const cursor = { syncedThrough: "2026-10-05T11:30:00Z" };
    expect(syncWindow(cursor, now).from).toEqual(new Date("2026-10-04T11:30:00Z"));
  });

  it("falls back to the backfill on a cursor it can't read", () => {
    expect(syncWindow({ syncedThrough: "not a date" }, now).from).toEqual(
      new Date("2026-09-21T12:00:00Z"),
    );
  });
});

describe("the sync job", () => {
  it("skips without a GitHub token", async () => {
    const result = await githubReviewSyncJob.run({
      db,
      config: { secrets: {} } as Config,
      cursor: null,
      now: new Date(),
      trigger: "manual",
    });
    expect(result.skipped).toBe(true);
  });
});
