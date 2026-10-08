import axios, { AxiosError, type AxiosInstance } from "axios";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { ForbiddenError } from "../shared/types.js";
import type {
  BusinessSummary,
  HeatmapScan,
  KeywordRanking,
  PendingReview,
  ProfileAudit,
  ProfileCheck,
  PublicBusiness,
  PublicCompetitor,
} from "./models.js";

/**
 * The only way this server reaches Rank Titan data.
 *
 * It talks to the Rank Titan API over the internal bridge — the same
 * shared-secret pattern `InternalApiKeyGuard` already serves for the GSC and
 * GA4 back-channels — and never opens a database connection of its own. If this
 * service is ever compromised, the blast radius is the endpoints below, not
 * Postgres.
 *
 * Every method takes the caller's `userId` and passes it down, so ownership is
 * resolved server-side on each call. Nothing here accepts a business id on
 * trust: see {@link assertOwnership}.
 */
export class RankTitanClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.RANKTITAN_API_URL,
      timeout: 30_000,
      headers: {
        // Data endpoints sit behind ApiKeyGuard (`x-api-key` + API_KEY_SECRET),
        // not InternalApiKeyGuard. Two different secrets and two different
        // headers; mixing them yields a 401 from every data call.
        "x-api-key": config.RANKTITAN_API_KEY,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Businesses the caller owns or has been granted access to.
   *
   * This is also the allow-list every other method checks against, which is why
   * it is resolved from the userId and never from client input.
   */
  async listBusinesses(userId: string): Promise<BusinessSummary[]> {
    // `/businesses/user/:userId/paginated` is the only by-user listing the
    // backend exposes, and it answers `{ data, meta }` rather than an array.
    // The limit is high on purpose: agency accounts hold hundreds of
    // locations, and a truncated list would make the model believe a business
    // the user owns does not exist.
    const response = await this.get<{ data?: unknown[] }>(
      `/businesses/user/${encodeURIComponent(userId)}/paginated`,
      { page: "1", limit: "500" },
    );

    const rows = Array.isArray(response?.data) ? response.data : [];
    return rows.map(toBusinessSummary).filter((b): b is BusinessSummary => b !== null);
  }

  /**
   * Resolve a locationId the model handed us into a business the caller may
   * actually see.
   *
   * The failure mode this exists to prevent: a model passes any locationId —
   * guessed, or copied from another conversation — and the server answers with
   * another customer's data. Every tool that accepts a business id routes
   * through here first.
   */
  async assertOwnership(userId: string, locationId: string): Promise<BusinessSummary> {
    const businesses = await this.listBusinesses(userId);
    const match = businesses.find((business) => business.locationId === locationId);

    if (!match) {
      // Deliberately the same message whether the business does not exist or
      // belongs to someone else — otherwise this doubles as a way to probe
      // which locationIds are real.
      logger.warn("Ownership check failed", { userId, locationId });
      throw new ForbiddenError(
        "That business is not in this Rank Titan account. Run list_businesses to see which ones are.",
      );
    }

    return match;
  }

  /** Keyword rankings already measured and stored. No heatmap call. */
  async getKeywordRankings(locationId: string): Promise<KeywordRanking[]> {
    const data = await this.get<unknown[]>(
      `/scored-keywords/by-location/${encodeURIComponent(locationId)}`,
    );
    return data.map(toKeywordRanking).filter((k): k is KeywordRanking => k !== null);
  }

  /** Reviews still waiting for a reply. */
  async getPendingReviews(locationId: string, limit: number): Promise<PendingReview[]> {
    // `hasReply=false` is what "pending" means here. The endpoint takes no
    // limit, so it is applied after mapping rather than pretended at the query.
    const data = await this.get<unknown[]>("/reviews", {
      locationId,
      hasReply: "false",
    });

    const rows = Array.isArray(data) ? data : [];
    return rows
      .map(toPendingReview)
      .filter((r): r is PendingReview => r !== null)
      .slice(0, limit);
  }

  /**
   * Public Google data for a business nobody has connected to Rank Titan.
   *
   * The internal bridge rather than Places directly: the Places key is
   * restricted and lives on the backend, and this server deliberately holds no
   * credential it does not need.
   */
  async findPublicBusiness(query: string): Promise<PublicBusiness | null> {
    const data = await this.postInternal<{ business?: unknown }>("/internal/mcp/public/business", {
      query,
    });
    return (data?.business as PublicBusiness | undefined) ?? null;
  }

  async findPublicCompetitors(query: string, limit: number): Promise<PublicCompetitor[]> {
    const data = await this.postInternal<{ competitors?: unknown }>(
      "/internal/mcp/public/competitors",
      { query, limit },
    );
    return Array.isArray(data?.competitors) ? (data.competitors as PublicCompetitor[]) : [];
  }

  /**
   * The Caller behind a userId, for a request authenticated by OAuth token.
   *
   * Reuses the same resolver the API key path uses, so both ways in agree about
   * someone's plan and admin status instead of drifting apart.
   */
  async resolveCaller(userId: string) {
    const data = await this.postInternal<{
      userId?: string;
      email?: string | null;
      plan?: string;
      isSuperAdmin?: boolean;
    }>("/internal/mcp/resolve-user", { userId });

    if (!data?.userId) return null;
    const plan = data.plan;
    return {
      userId: data.userId,
      email: data.email ?? null,
      plan: plan === "paid" || plan === "legacy" ? (plan as "paid" | "legacy") : ("free" as const),
      isSuperAdmin: data.isSuperAdmin === true,
    };
  }

  // ── Heatmap ────────────────────────────────────────────────────────────────

  /**
   * Starts a ranking grid. Returns as soon as it is queued, never waits.
   *
   * Through the bridge rather than straight to the heatmap service: its key
   * bills a token per keyword against our account, and a key that spends
   * money does not belong in a service exposed to the internet.
   */
  async startHeatmap(input: {
    locationId: string;
    keyword: string;
  }): Promise<{ taskId: string | null; previousReportId: string | null } | null> {
    const data = await this.postInternal<{
      scan?: { taskId: string | null; previousReportId: string | null };
    }>("/internal/mcp/heatmap/start", input);
    return data?.scan ?? null;
  }

  /**
   * Reads a scan. By location, because that is the key we always have and it
   * survives a rescan; `previousReportId` is what tells a fresh result from
   * the one that was already there.
   */
  async heatmapResult(input: {
    locationId?: string;
    reportId?: string;
    previousReportId?: string | null;
    keyword?: string;
  }): Promise<HeatmapScan | null> {
    const data = await this.postInternal<{ result?: HeatmapScan }>(
      "/internal/mcp/heatmap/result",
      input,
    );
    return data?.result ?? null;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────
  //
  // Storage lives in Rank Titan: this server runs the protocol but keeps no
  // database, so clients and grants have to survive a deploy somewhere else.

  async registerOAuthClient(input: {
    clientName?: string;
    redirectUris: string[];
  }): Promise<{ client_id: string; redirect_uris: string[]; client_id_issued_at: number }> {
    const data = await this.postInternal<{
      client_id: string;
      redirect_uris: string[];
      client_id_issued_at: number;
    }>("/internal/mcp/oauth/register-client", input);
    if (!data) throw new Error("Could not register the client");
    return data;
  }

  async getOAuthClient(clientId: string) {
    const data = await this.postInternal<{ client?: unknown }>("/internal/mcp/oauth/client", {
      clientId,
    });
    return (data?.client as { client_id: string; redirect_uris: string[] } | null) ?? null;
  }

  async createOAuthGrant(userId: string, clientId: string, scopes: string[]) {
    const data = await this.postInternal<{ grant?: { id: string } }>("/internal/mcp/oauth/grant", {
      userId,
      clientId,
      scopes,
    });
    return data?.grant ?? null;
  }

  /** Re-checked on every refresh, which is what makes revocation take effect. */
  /**
   * Ends an authorisation. Scoped by userId on the server, so a session can
   * only ever end itself.
   */
  async revokeGrant(userId: string, grantId: string): Promise<boolean> {
    const data = await this.postInternal<{ revoked?: boolean }>(
      "/internal/mcp/oauth/grant/revoke",
      { userId, grantId },
    );
    return data?.revoked === true;
  }

  async getActiveGrant(grantId: string) {
    const data = await this.postInternal<{
      grant?: { id: string; userId: string; scopes: string[] };
    }>("/internal/mcp/oauth/grant/active", { grantId });
    return data?.grant ?? null;
  }

  /**
   * Turns a Google authorisation code into the Rank Titan user behind it.
   *
   * Done on the backend because the Google client secret belongs there, not in
   * the service exposed to the internet.
   */
  async resolveGoogleIdentity(
    code: string,
    redirectUri: string,
  ): Promise<{ userId: string | null; email: string | null } | null> {
    const data = await this.postInternal<{ userId?: string | null; email?: string | null }>(
      "/internal/mcp/oauth/resolve-google",
      { code, redirectUri },
    );
    if (!data) return null;
    return { userId: data.userId ?? null, email: data.email ?? null };
  }

  /** The internal bridge uses its own header and secret, not the data key. */
  private async postInternal<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const response = await axios.post<T>(`${config.RANKTITAN_API_URL}${path}`, body, {
        timeout: 20_000,
        headers: {
          "x-internal-api-key": config.RANKTITAN_INTERNAL_API_KEY,
          "Content-Type": "application/json",
        },
      });
      return response.data;
    } catch (error) {
      throw this.translate(error, path);
    }
  }

  /**
   * One review by id, used to prove it belongs to the caller before replying.
   *
   * Necessary because the data credential authenticates as an admin and
   * bypasses Rank Titan's own PermissionGuard: without this, any review id a
   * model produced would be answerable, including another customer's.
   */
  async getReview(reviewId: string): Promise<{ reviewId: string; locationId: string } | null> {
    const raw = await this.get<unknown>(`/reviews/${encodeURIComponent(reviewId)}`).catch(
      () => null,
    );
    const record = asRecord(raw);
    const locationId = asString(record?.["locationId"]);
    const id = asString(record?.["id"]);
    return record && locationId && id ? { reviewId: id, locationId } : null;
  }

  /**
   * Publishes a reply to one specific review.
   *
   * NOT `POST /reviews/:businessId/reply`, which takes no body and makes the AI
   * answer every pending review of a business at once. Triggering that from a
   * chat would publish dozens of replies the user never saw. `PATCH /reviews/:id`
   * is the one that pushes a given text to Google and stores it.
   *
   * Metered: the quota guard runs before this is reached.
   */
  async publishReviewReply(reviewId: string, replyText: string): Promise<{ published: boolean }> {
    await this.patch(`/reviews/${encodeURIComponent(reviewId)}`, { replyContent: replyText });
    return { published: true };
  }

  /**
   * Reads the profile checks off a business already resolved by
   * {@link assertOwnership}. Pure, and takes no further call: the paginated
   * listing already carries `gmbData`.
   *
   * `hasGeometry` is included because its absence is why a brand-new business
   * shows every keyword unranked — the heatmap cannot locate it. An owner
   * reading an audit deserves to see that rather than wonder.
   */
  auditProfile(business: BusinessSummary): ProfileAudit {
    const gmb = business.gmb;
    const description = gmb.description ?? "";

    const checks: ProfileCheck[] = [
      {
        label: "Description",
        passed: description.length >= 250,
        detail: description
          ? `${description.length} characters${description.length < 250 ? " — Google allows 750; short descriptions use less of what it reads" : ""}`
          : "Missing",
      },
      {
        label: "Primary category",
        passed: !!gmb.primaryCategory,
        detail: gmb.primaryCategory ?? "Missing — this is the single strongest ranking signal",
      },
      {
        label: "Additional categories",
        passed: gmb.additionalCategories > 0,
        detail:
          gmb.additionalCategories > 0
            ? `${gmb.additionalCategories} set`
            : "None — extra categories add the searches you can appear for",
      },
      {
        label: "Website",
        passed: !!gmb.websiteUri,
        detail: gmb.websiteUri ?? "Missing",
      },
      {
        label: "Phone",
        passed: !!gmb.primaryPhone,
        detail: gmb.primaryPhone ?? "Missing",
      },
      {
        label: "Opening hours",
        passed: gmb.hasHours,
        detail: gmb.hasHours ? "Set" : "Not set — Google hides or downranks listings without hours",
      },
      {
        label: "Map coordinates",
        passed: gmb.hasGeometry,
        detail: gmb.hasGeometry
          ? "Set"
          : "Missing — until these are set, keyword rankings cannot be measured for this location",
      },
    ];

    return { checks, passed: checks.filter((check) => check.passed).length };
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    try {
      const response = await this.http.patch<T>(path, body);
      return response.data;
    } catch (error) {
      throw this.translate(error, path);
    }
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    try {
      const response = await this.http.get<T>(path, params ? { params } : {});
      return response.data;
    } catch (error) {
      throw this.translate(error, path);
    }
  }

  /**
   * Turn an upstream failure into something safe to show in a chat.
   *
   * Backend error bodies can carry internal hostnames, stack traces and owner
   * emails. Those go to the log; the model gets a sentence.
   */
  private translate(error: unknown, path: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      logger.error("Rank Titan API call failed", {
        path,
        status,
        message: error.message,
      });

      if (status === 404) return new Error("Rank Titan has no data for that request.");
      if (status === 424) {
        // GOOGLE_RECONNECT_REQUIRED. Common enough to deserve its own sentence:
        // reviews are read live from Google, so a business whose owner's token
        // has expired fails here and nowhere else. A generic error would send
        // the user to support for something they can fix themselves.
        return new Error(
          "This business's Google connection has expired. Its owner needs to reconnect Google in Rank Titan before reviews can be read.",
        );
      }
      if (status === 401 || status === 403) {
        return new Error("Rank Titan rejected this server's credentials.");
      }
      if (status === 400) {
        // A 400 from the bridge is a refusal with a reason — a business
        // missing its coordinates, say — and the reason is written for the
        // person reading the chat. Replacing it with a house phrase is how a
        // specific, fixable problem gets reported as an outage.
        const explained = backendMessage(error);
        if (explained) return new Error(explained);
      }
      if (status && status >= 500) {
        return new Error("Rank Titan is temporarily unavailable. Try again in a moment.");
      }
      return new Error("The request to Rank Titan could not be completed.");
    }

    logger.error("Unexpected failure calling Rank Titan", {
      path,
      error: String(error),
    });
    return new Error("The request to Rank Titan could not be completed.");
  }
}

// ── mapping ────────────────────────────────────────────────────────────────
//
// The backend returns wide objects carrying tokens, raw GMB payloads and
// internal flags. These mappers pick the handful of fields a tool needs, so
// nothing reaches the model by accident just because the backend started
// returning it.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toBusinessSummary(raw: unknown): BusinessSummary | null {
  const record = asRecord(raw);
  const locationId = asString(record?.["locationId"]);
  if (!record || !locationId) return null;

  const gmbData = asRecord(record["gmbData"]) ?? {};
  const storefront = asRecord(gmbData["storefrontAddress"]);
  const addressLines = Array.isArray(storefront?.["addressLines"])
    ? (storefront["addressLines"] as unknown[]).filter((l): l is string => typeof l === "string")
    : [];

  // Field names below were read off a real record, not assumed: the phone sits
  // under `phoneNumbers.primaryPhone` (the parent is an object, so reading it as
  // a string silently yields null), the description under `profile.description`,
  // and `regularHours` is simply absent when hours were never set.
  const phoneNumbers = asRecord(gmbData["phoneNumbers"]);
  const profile = asRecord(gmbData["profile"]);
  const categories = asRecord(gmbData["categories"]);
  const primaryCategory = asRecord(categories?.["primaryCategory"]);
  const additional = categories?.["additionalCategories"];
  const metadata = asRecord(gmbData["metadata"]);

  return {
    locationId,
    name: asString(record["name"]) ?? "Unnamed business",
    address: addressLines.join(", ") || null,
    phone: asString(phoneNumbers?.["primaryPhone"]),
    website: asString(gmbData["websiteUri"]),
    active: record["active"] === true,
    planType: asString(record["gmbPlanType"]),
    gmb: {
      description: asString(profile?.["description"]),
      primaryCategory: asString(primaryCategory?.["displayName"]),
      additionalCategories: Array.isArray(additional) ? additional.length : 0,
      websiteUri: asString(gmbData["websiteUri"]),
      primaryPhone: asString(phoneNumbers?.["primaryPhone"]),
      hasHours: !!asRecord(gmbData["regularHours"]),
      hasGeometry: !!asRecord(gmbData["geometry"]),
      mapsUri: asString(metadata?.["mapsUri"]),
    },
  };
}

function toKeywordRanking(raw: unknown): KeywordRanking | null {
  const record = asRecord(raw);
  const keyword = asString(record?.["keyword"]);
  if (!record || !keyword) return null;

  const score = Number(record["score"]);
  const status = asString(record["rankingStatus"]) ?? "unknown";

  return {
    keyword,
    // A score of 20 means two very different things depending on the status:
    // measured and nowhere in the grid, or never measured at all. The presenter
    // has to tell them apart, so both travel together.
    score: Number.isFinite(score) ? score : null,
    status,
    measured: status === "ranked",
    // lastManualRankAt when a human asked for it, updatedAt otherwise: both
    // mean "when this number was last established".
    measuredAt: asString(record["lastManualRankAt"]) ?? asString(record["updatedAt"]) ?? null,
  };
}

/**
 * Field names taken from the Review model itself, after an earlier version of
 * this mapper guessed `reviewId`, `starRating`, `comment` and `createTime` —
 * none of which exist. Every review would have been silently dropped.
 */
function toPendingReview(raw: unknown): PendingReview | null {
  const record = asRecord(raw);
  const reviewId = asString(record?.["id"]);
  if (!record || !reviewId) return null;

  const stars = Number(record["stars"]);

  return {
    reviewId,
    author: asString(record["author"]),
    rating: Number.isFinite(stars) && stars > 0 ? stars : null,
    comment: asString(record["reviewContent"]),
    createdAt: asString(record["createdAt"]),
    url: asString(record["reviewUrl"]),
  };
}

/** The message Rank Titan itself wrote, when it bothered to write one. */
function backendMessage(error: AxiosError): string | null {
  const data = error.response?.data as { message?: unknown } | undefined;
  const message = data?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (Array.isArray(message) && typeof message[0] === "string") return message[0];
  return null;
}
