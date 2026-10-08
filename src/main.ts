/**
 * Composition root.
 *
 * The only place that chooses concrete implementations. Everything downstream
 * depends on the interfaces in shared/types.ts, which is what makes the two
 * swaps this project has coming — API key to OAuth, in-memory quota to Postgres
 * — a change here and nowhere else.
 */
import { ApiKeyAuthenticator } from "./auth/api-key.authenticator.js";
import { QuotaService, InMemoryQuotaStore } from "./quota/quota.service.js";
import { RankTitanQuotaStore } from "./quota/ranktitan-quota.store.js";
import { RankTitanClient } from "./ranktitan/client.js";
import { config, isProduction } from "./shared/config.js";
import { logger } from "./shared/logger.js";
import { startHttpServer } from "./transport/http.js";
import { RankTitanOAuthProvider } from "./auth/oauth.provider.js";
import type { Authenticator } from "./shared/types.js";

function buildAuthenticator(): Authenticator {
  switch (config.AUTH_STRATEGY) {
    case "api_key":
      return new ApiKeyAuthenticator();
    case "oauth":
      // Lands in phase 2. Failing loudly beats silently falling back to a
      // different strategy than the one the deployment asked for.
      throw new Error("AUTH_STRATEGY=oauth is not implemented yet. Use api_key.");
  }
}

/**
 * Rank Titan's database in production; in-memory only for a local run without a
 * backend to talk to.
 *
 * The in-memory one must never reach production: it resets on every deploy —
 * handing every user their free heatmap back — and separate instances count
 * separately.
 */
function buildQuotaStore() {
  if (config.QUOTA_STORE === "memory") {
    if (isProduction) {
      throw new Error(
        "QUOTA_STORE=memory refuses to start in production: counters would reset on every deploy and differ per instance.",
      );
    }
    logger.warn("Quota counters are in memory. Usage is not persisted and nothing is audited.");
    return new InMemoryQuotaStore();
  }

  return new RankTitanQuotaStore();
}

/**
 * A predictable signing key lets anyone mint a token for any account, so this
 * is a refusal to start rather than a warning in a log nobody reads.
 */
function assertOAuthIsSafe(): void {
  if (!isProduction) return;
  if (config.OAUTH_SIGNING_SECRET.startsWith("development-only")) {
    throw new Error(
      "OAUTH_SIGNING_SECRET is still the development default. Set a real one before serving production traffic.",
    );
  }
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    logger.warn(
      "Google OAuth is not configured; the Connect button will not work (API keys still do).",
    );
  }
}

function main(): void {
  assertOAuthIsSafe();
  const store = buildQuotaStore();

  const client = new RankTitanClient();

  // OAuth is optional: without Google credentials the server still runs and API
  // keys still work. Degrading to a usable product beats refusing to start.
  const oauth =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? new RankTitanOAuthProvider(client)
      : undefined;

  startHttpServer({
    authenticator: buildAuthenticator(),
    client,
    quota: new QuotaService(store),
    ...(oauth ? { oauth } : {}),
    /**
     * A verified token says WHO, not what plan they are on, and the plan
     * decides the quota. Resolved per request rather than baked into the token,
     * so somebody who just upgraded is not told to wait an hour for it.
     */
    resolveUser: async (userId: string) => client.resolveCaller(userId),
  });
}

main();
