import type { Db } from "../db/client.ts";
import type { EventRow } from "../db/schema.ts";
import { type EventType, listEvents, recordEventOnce } from "../events/service.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { refKey } from "../pr/types.ts";
import { GitHubClient, type ReviewContribution } from "./client.ts";

/**
 * Copies the review verdicts the user gave on github.com into the event log.
 *
 * Reviews submitted in Yarvis are logged as they happen, but ones given in the
 * browser never were, so the weekly summary, the review-cadence nudge and the
 * activity summaries all undercounted them. This reads GitHub's record of the
 * user's reviews and logs the ones the log doesn't hold yet. A review is
 * identified by its GitHub node id (`externalId`), which the in-app submit path
 * records too, so the same approval is never logged twice.
 *
 * Only approvals and change requests are synced. A COMMENTED review is also
 * what GitHub creates for a single inline comment, which the app logs as
 * `pr.commented` with no review id to match on.
 */

/** The event a synced verdict becomes, matching what the in-app submit logs. */
const EVENT_BY_STATE: Partial<Record<ReviewContribution["state"], EventType>> = {
  approved: "pr.approved",
  changes_requested: "pr.changes_requested",
};

/** How far back the first sync reads, before there is a cursor. */
const BACKFILL_DAYS = 14;

/**
 * Each run re-reads this much before its cursor, since GitHub can take a while
 * to list a contribution. Already-logged reviews are skipped by id.
 */
const OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * An unkeyed event this close to a review's submit time is taken to be that
 * review. Covers in-app reviews logged before reviews carried an id.
 */
const UNKEYED_MATCH_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `externalId` a GitHub review is logged under. */
export function reviewExternalId(nodeId: string): string {
  return `github:review:${nodeId}`;
}

export interface SyncCursor {
  /** The end of the last window read, as an ISO timestamp. */
  syncedThrough: string;
}

function parseCursor(cursor: unknown): Date | null {
  const value = (cursor as Partial<SyncCursor> | null)?.syncedThrough;
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The window a run reads, from its cursor or, on a first run, the backfill. */
export function syncWindow(cursor: unknown, now: Date): { from: Date; to: Date } {
  const last = parseCursor(cursor);
  const from = last
    ? new Date(last.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  return { from, to: now };
}

function payloadRef(event: EventRow): string | null {
  const ref = (event.payload as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : null;
}

/**
 * Whether the log already holds this review as an event with no id: the same
 * verdict on the same PR, logged within a few minutes of GitHub's timestamp.
 */
function matchesUnkeyed(
  unkeyed: EventRow[],
  type: EventType,
  ref: string,
  submittedAt: Date,
): boolean {
  return unkeyed.some(
    (event) =>
      event.type === type &&
      payloadRef(event) === ref &&
      Math.abs(event.occurredAt.getTime() - submittedAt.getTime()) <= UNKEYED_MATCH_MS,
  );
}

/** Logs the given reviews that the log doesn't already hold. Returns how many were added. */
export async function recordReviewContributions(
  db: Db,
  contributions: ReviewContribution[],
  window: { from: Date; to: Date },
): Promise<number> {
  const unkeyed = (
    await listEvents(db, {
      types: Object.values(EVENT_BY_STATE),
      // Widened by the match tolerance so an event logged just before the
      // window's start can still claim a review just inside it.
      since: new Date(window.from.getTime() - UNKEYED_MATCH_MS),
      until: new Date(window.to.getTime() + UNKEYED_MATCH_MS),
      limit: 500,
    })
  ).filter((event) => event.externalId === null);

  let added = 0;
  for (const contribution of contributions) {
    const type = EVENT_BY_STATE[contribution.state];
    if (!type) continue;
    const submittedAt = new Date(contribution.submittedAt);
    if (Number.isNaN(submittedAt.getTime())) continue;
    const ref = refKey({
      provider: "github",
      owner: contribution.owner,
      repo: contribution.repo,
      number: contribution.number,
    });
    if (matchesUnkeyed(unkeyed, type, ref, submittedAt)) continue;
    const row = await recordEventOnce(db, {
      type,
      source: "github-sync",
      payload: { ref },
      occurredAt: submittedAt,
      externalId: reviewExternalId(contribution.reviewId),
    });
    if (row) added++;
  }
  return added;
}

export const githubReviewSyncJob: JobDefinition = {
  name: "github-review-sync",
  description:
    "Every 30 minutes, log the approvals and change requests you gave on github.com, so they count alongside the ones given in Yarvis.",
  schedule: { kind: "interval", everyMs: 30 * 60 * 1000 },
  run: async ({ db, config, cursor, now }) => {
    const token = config.secrets?.githubToken;
    if (!token) return { skipped: true, detail: "no GitHub token configured" };
    const window = syncWindow(cursor, now);
    const contributions = await new GitHubClient(token).reviewContributions(window.from, window.to);
    const added = await recordReviewContributions(db, contributions, window);
    const next: SyncCursor = { syncedThrough: window.to.toISOString() };
    return {
      cursor: next,
      skipped: added === 0,
      detail: `logged ${added} of ${contributions.length} GitHub review(s) since ${window.from.toISOString()}`,
    };
  },
};
