import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { QuotaExceededError, type Caller, type QuotaCounter } from "../shared/types.js";

/**
 * Where usage counters live.
 *
 * Behind an interface because v1 counts in memory to get the server moving,
 * while anything real has to survive a restart and be shared across instances.
 * Swapping in the Postgres-backed store is a one-line change at the composition
 * root, and no tool knows the difference.
 */
/** A finished tool call, as it is handed to the store. */
export interface ToolCallRecord {
  userId: string;
  tool: string;
  requestId: string;
  status: "ok" | "error" | "refused";
  counter?: QuotaCounter | null;
  cost?: number;
  locationId?: string | null;
  detail?: string | null;
  durationMs?: number | null;
}

export interface QuotaStore {
  /** Allowance already spent in the relevant period. */
  get(userId: string, counter: QuotaCounter): Promise<number>;
  /**
   * Records a finished call: the audit row, and the cost when it earned one.
   *
   * Deliberately not an "increment". Usage is written AFTER the tool ran, so a
   * failure never spends a credit, and every call — refusals included — leaves
   * a trace.
   */
  record(call: ToolCallRecord): Promise<void>;
}

/**
 * Enforces the allowance before a tool spends anything.
 *
 * The message on refusal is not an error string — it is shown verbatim inside
 * the chat and carries the upgrade link, which is the entire conversion
 * mechanism Daniel is after. It says what was used, out of what, and where to
 * go next.
 */
export class QuotaService {
  constructor(private readonly store: QuotaStore) {}

  /** Limit for this caller and counter. Admins are handled before we get here. */
  limitFor(caller: Caller, counter: QuotaCounter): number {
    if (counter === "heatmaps") {
      // Paid plans are not capped on heatmaps today; that is a product decision
      // and lives in config so it can change without a deploy.
      return caller.plan === "free" ? config.QUOTA_FREE_HEATMAPS : Number.POSITIVE_INFINITY;
    }

    const allowance =
      caller.plan === "free" ? config.QUOTA_FREE_REVIEW_REPLIES : config.QUOTA_PAID_REVIEW_REPLIES;
    return allowance === "unlimited" ? Number.POSITIVE_INFINITY : allowance;
  }

  /**
   * Charges `cost` against the caller's allowance, or throws
   * {@link QuotaExceededError} without charging anything.
   */
  async check(caller: Caller, counter: QuotaCounter, cost: number): Promise<void> {
    const limit = this.limitFor(caller, counter);
    if (limit === Number.POSITIVE_INFINITY) return;

    const used = await this.store.get(caller.userId, counter);

    if (used + cost > limit) {
      logger.info("Quota refused", {
        userId: caller.userId,
        counter,
        used,
        limit,
      });
      throw new QuotaExceededError(this.message(counter, used, limit), counter, used, limit);
    }
  }

  /** Passes the finished call through to the store. */
  async record(call: ToolCallRecord): Promise<void> {
    await this.store.record(call);
  }

  private message(counter: QuotaCounter, used: number, limit: number): string {
    if (counter === "heatmaps") {
      return [
        `Free quota reached (${used}/${limit} heatmaps used).`,
        `Upgrade at ${config.UPGRADE_URL} to run unlimited competitor heatmaps.`,
      ].join(" ");
    }

    if (limit === 0) {
      return [
        "Publishing review replies is not included in the free plan.",
        `Upgrade at ${config.UPGRADE_URL} to let Rank Titan reply to your reviews.`,
      ].join(" ");
    }

    return [
      `Monthly reply allowance reached (${used}/${limit} used).`,
      `Refill credits at ${config.BILLING_URL}.`,
    ].join(" ");
  }
}

/**
 * Counts in process memory. Development and the first demo only.
 *
 * Two reasons it must not ship as the real store: it resets on every deploy,
 * handing everyone their free heatmap back, and with more than one instance
 * each would keep its own count. Replaced by a Postgres-backed store before
 * anything is metered for real.
 */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly counts = new Map<string, number>();

  async get(userId: string, counter: QuotaCounter): Promise<number> {
    return this.counts.get(key(userId, counter)) ?? 0;
  }

  /** Only a successful metered call moves a counter, same rule as the real store. */
  async record(call: ToolCallRecord): Promise<void> {
    if (call.status !== "ok" || !call.counter || !call.cost) return;
    const k = key(call.userId, call.counter);
    this.counts.set(k, (this.counts.get(k) ?? 0) + call.cost);
  }
}

const key = (userId: string, counter: QuotaCounter): string => `${userId}:${counter}`;
