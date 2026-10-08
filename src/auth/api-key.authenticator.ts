import { timingSafeEqual, createHash } from "node:crypto";
import axios, { AxiosError } from "axios";
import { config } from "../shared/config.js";
import { logger, redact } from "../shared/logger.js";
import { AuthError, type Authenticator, type Caller } from "../shared/types.js";

/**
 * v1 authentication: the user copies an API key from their Rank Titan dashboard
 * and pastes it into Claude or ChatGPT.
 *
 * This is deliberately the first strategy rather than OAuth. It identifies the
 * user just as well and enforces quotas just as well, while OAuth 2.1 + PKCE is
 * two weeks of security-critical work. `OAuthAuthenticator` implements this same
 * interface later and the composition root picks between them; no tool changes.
 *
 * The key is never logged, never returned and never compared with `===`.
 */
export class ApiKeyAuthenticator implements Authenticator {
  readonly strategy = "api_key";

  /**
   * Resolved callers, keyed by a hash of the credential.
   *
   * Without this every tool call would be a round trip to Rank Titan just to
   * learn who is calling. The TTL is short because it also caches the user's
   * plan, and someone who just paid should not wait an hour to stop seeing the
   * free-tier limit.
   */
  private readonly cache = new Map<string, { caller: Caller; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 60_000;

  async authenticate(credential: string | undefined): Promise<Caller> {
    const key = extractBearer(credential);
    if (!key) throw new AuthError();

    const cacheKey = hash(key);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.caller;

    const caller = await this.resolveFromBackend(key);
    this.cache.set(cacheKey, {
      caller,
      expiresAt: Date.now() + ApiKeyAuthenticator.CACHE_TTL_MS,
    });
    return caller;
  }

  /**
   * Ask Rank Titan who this key belongs to.
   *
   * The lookup runs on the backend so the key never has to be stored here, and
   * revoking one in the dashboard takes effect within the cache TTL.
   */
  private async resolveFromBackend(key: string): Promise<Caller> {
    try {
      const { data } = await axios.post<unknown>(
        `${config.RANKTITAN_API_URL}/internal/mcp/resolve-api-key`,
        { apiKey: key },
        {
          timeout: 10_000,
          // InternalApiKeyGuard reads `x-internal-api-key`. `x-api-key` is a
          // different guard (ApiKeyGuard) with different semantics — sending the
          // wrong one here fails every authentication with a 401 that looks like
          // the user's key is bad.
          headers: { "x-internal-api-key": config.RANKTITAN_INTERNAL_API_KEY },
        },
      );

      const caller = toCaller(data);
      if (!caller) {
        logger.warn("Key resolved to an unusable payload", {
          key: redact(key),
        });
        throw new AuthError();
      }

      logger.info("Caller authenticated", {
        userId: caller.userId,
        plan: caller.plan,
        key: redact(key),
      });
      return caller;
    } catch (error) {
      if (error instanceof AuthError) throw error;

      if (
        error instanceof AxiosError &&
        (error.response?.status === 404 || error.response?.status === 401)
      ) {
        // An unknown key is not a server problem; say nothing more than that.
        throw new AuthError();
      }

      logger.error("Could not verify the API key", {
        key: redact(key),
        error: error instanceof Error ? error.message : String(error),
      });
      // Not an AuthError: the credential may be perfectly valid and the backend
      // down. Telling the user their key is invalid would send them to support
      // for the wrong reason.
      throw new Error("Authentication is temporarily unavailable. Try again in a moment.");
    }
  }
}

/** Accepts `Bearer <key>` and a bare key, which is what some clients send. */
function extractBearer(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const match = /^Bearer\s+(.+)$/i.exec(value);
  const key = (match?.[1] ?? value).trim();
  return key.length >= 20 ? key : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Constant-time comparison, exported for the strategies that need to compare a
 * secret directly. Length is compared first because `timingSafeEqual` throws on
 * mismatched buffers, and that throw is itself a length oracle.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toCaller(raw: unknown): Caller | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const userId = typeof record["userId"] === "string" ? record["userId"] : null;
  if (!userId) return null;

  const plan = record["plan"];
  return {
    userId,
    email: typeof record["email"] === "string" ? record["email"] : null,
    plan: plan === "paid" || plan === "legacy" ? plan : "free",
    isSuperAdmin: record["isSuperAdmin"] === true,
  };
}
