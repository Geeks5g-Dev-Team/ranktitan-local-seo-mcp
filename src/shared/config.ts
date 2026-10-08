import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

/**
 * Configuration is parsed once, at boot, and the process refuses to start when
 * something required is missing or malformed.
 *
 * The alternative — reading `process.env` where it is needed — turns a missing
 * secret into a 500 on a user's first call instead of a failure on deploy.
 */
/** A number of uses, or `unlimited` — written as the word, so it reads as a decision. */
const allowance = z.union([z.literal("unlimited"), z.coerce.number().int().nonnegative()]);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3070),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_URL: z.string().url().default("http://localhost:3070"),

  RANKTITAN_API_URL: z.string().url(),

  /** `x-internal-api-key`, for the /internal/* back-channel only. */
  RANKTITAN_INTERNAL_API_KEY: z
    .string()
    .min(16, "the internal key is too short to be the real one"),

  /**
   * `x-api-key`, for the data endpoints (/businesses, /reviews,
   * /scored-keywords). A DIFFERENT secret read by a different guard — Rank
   * Titan's API_KEY_SECRET. Sending the internal key to a data endpoint returns
   * a 401 that reads as though the user's own key were bad.
   *
   * It authenticates as an ADMIN identity, which bypasses Rank Titan's
   * PermissionGuard. That is precisely why RankTitanClient.assertOwnership
   * exists and must run before any business data is read.
   */
  RANKTITAN_API_KEY: z.string().min(8, "API_KEY_SECRET is missing"),

  AUTH_STRATEGY: z.enum(["api_key", "oauth"]).default("api_key"),

  /**
   * Where usage and the audit trail live. "ranktitan" is the only acceptable
   * value in production; "memory" exists for a local run with no backend and
   * refuses to boot in production.
   */
  QUOTA_STORE: z.enum(["ranktitan", "memory"]).default("ranktitan"),

  /**
   * Google OAuth, used only to learn who the user is. Rank Titan's userIds are
   * Google subject ids, so this resolves straight to their account with no
   * linking step and no password for us to hold.
   */
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  /**
   * Signs the access and refresh tokens. Changing it invalidates every live
   * token at once, which is the emergency lever if one ever leaks.
   *
   * Refuses to boot in production with the development default: a predictable
   * signing key means anyone can mint a token for any account.
   */
  OAUTH_SIGNING_SECRET: z.string().min(32).default("development-only-signing-secret-change-me"),

  QUOTA_FREE_HEATMAPS: z.coerce.number().int().nonnegative().default(1),

  /**
   * Replying from a chat is free on every plan, which is a product decision,
   * not an oversight: it is the moment someone tries the product, and charging
   * for it closes the funnel it was built to open. What is sold is automation —
   * Rank Titan replying on its own — and that lives elsewhere.
   *
   * Still a number so a cap can come back from the environment, without a
   * deploy, if it is ever abused.
   */
  QUOTA_FREE_REVIEW_REPLIES: allowance.default("unlimited"),
  QUOTA_PAID_REVIEW_REPLIES: allowance.default("unlimited"),

  UPGRADE_URL: z.string().url().default("https://ranktitan.ai/pricing"),
  BILLING_URL: z.string().url().default("https://ranktitan.ai/billing"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_PER_KEY: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_PER_IP: z.coerce.number().int().positive().default(120),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}\n\nSee .env.example.`);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

export const isProduction = config.NODE_ENV === "production";
