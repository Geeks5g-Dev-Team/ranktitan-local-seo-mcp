import axios, { type AxiosInstance } from "axios";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { QuotaCounter } from "../shared/types.js";
import type { QuotaStore } from "./quota.service.js";

/** One finished tool call, as reported to Rank Titan. */
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

/**
 * Quotas and the audit trail, kept in Rank Titan's database.
 *
 * Replaces InMemoryQuotaStore, which reset on every deploy — handing every user
 * their free heatmap back — and counted separately per instance.
 *
 * This server still owns no database. Both operations go over the internal
 * bridge, the same shared-secret hop everything else here uses.
 */
export class RankTitanQuotaStore implements QuotaStore {
  private readonly http: AxiosInstance;

  /**
   * Usage read once per request rather than once per check.
   *
   * Short enough that a user who just paid is not told to wait, long enough
   * that a conversation with several tool calls does not re-ask every time.
   */
  private readonly cache = new Map<string, { usage: Usage; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 5_000;

  constructor() {
    this.http = axios.create({
      baseURL: config.RANKTITAN_API_URL,
      timeout: 10_000,
      headers: {
        "x-internal-api-key": config.RANKTITAN_INTERNAL_API_KEY,
        "Content-Type": "application/json",
      },
    });
  }

  async get(userId: string, counter: QuotaCounter): Promise<number> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.usage[counter] ?? 0;

    const { data } = await this.http.post<Usage>("/internal/mcp/usage", { userId });
    const usage: Usage = {
      heatmaps: Number(data?.heatmaps) || 0,
      review_replies: Number(data?.review_replies) || 0,
    };

    this.cache.set(userId, { usage, expiresAt: Date.now() + RankTitanQuotaStore.CACHE_TTL_MS });
    return usage[counter] ?? 0;
  }

  /**
   * Part of the QuotaStore contract, but nothing calls it: usage is written by
   * {@link record} once the call has finished, so a failed tool never spends a
   * credit. Throwing beats pretending it worked.
   */
  async increment(): Promise<number> {
    throw new Error(
      "Usage is recorded after the call via record(), not incremented up front. See RankTitanQuotaStore.",
    );
  }

  /**
   * Writes the audit row and, when the call succeeded and was metered, the cost.
   *
   * Never throws. The tool has already run by the time this is called, and
   * failing the user's request because the audit write failed would turn a
   * bookkeeping problem into a broken product. A dropped row is logged loudly
   * instead — it means someone used something we did not charge for.
   */
  async record(call: ToolCallRecord): Promise<void> {
    // Clear the cache first: the next check in this conversation must see the
    // credit that was just spent, not the value read moments ago.
    this.cache.delete(call.userId);

    try {
      await this.http.post("/internal/mcp/tool-call", call);
    } catch (error) {
      logger.error("Could not record a tool call — usage may be undercounted", {
        tool: call.tool,
        userId: call.userId,
        requestId: call.requestId,
        cost: call.cost ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface Usage {
  heatmaps: number;
  review_replies: number;
}
