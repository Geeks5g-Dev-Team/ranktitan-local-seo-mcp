import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { RankTitanClient } from "../ranktitan/client.js";

/** What a client receives after exchanging a code or a refresh token. */
export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Everything about a code, held only for the seconds it is alive. */
interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  grantId: string;
  scopes: string[];
  expiresAt: number;
}

/** The authorisation a user has not completed yet, carried through Google. */
interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string | undefined;
  scopes: string[];
  expiresAt: number;
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Long enough for a redirect chain, short enough that a leaked code is dead. */
const CODE_TTL_MS = 2 * 60 * 1000;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
/**
 * How long a revocation can go unnoticed. Short enough that signing out feels
 * immediate, long enough that a burst of tool calls is one database read.
 */
const REVOCATION_CHECK_TTL_MS = 15 * 1000;

/**
 * The OAuth flow for the MCP server.
 *
 * It replaces asking a user to paste an API key into a header named
 * `x-account-key` with a Connect button, which is the difference between a
 * product an agency owner adopts and one they close the tab on.
 *
 * Identity is delegated to Google rather than reimplemented: Rank Titan's own
 * userIds ARE Google subject ids, so the account a user already signs in with
 * resolves to their Rank Titan account with no linking step, no password, and
 * no new credential for us to store.
 *
 * Tokens are signed and self-contained, so verifying one is a signature check
 * rather than a database read on every single tool call. What IS stored is the
 * grant behind them, which is what makes Disconnect mean something.
 */
export class RankTitanOAuthProvider {
  /**
   * Codes and in-flight authorisations live in memory on purpose: both die in
   * minutes, so persisting them would buy nothing but writes. The cost is that
   * a deploy mid-login makes that one login fail, and the user presses Connect
   * again.
   */
  private readonly codes = new Map<string, PendingCode>();
  private readonly pending = new Map<string, PendingAuthorization>();
  /** Whether a grant is still live, remembered briefly. See verifyAccessToken. */
  private readonly liveGrants = new Map<string, { active: boolean; until: number }>();

  constructor(private readonly client: RankTitanClient) {
    // Both maps are bounded by their own expiry; this just stops a long-lived
    // process from holding dead entries.
    const sweep = setInterval(() => this.sweep(), 60_000);
    sweep.unref();
  }

  // ── client registration ────────────────────────────────────────────────────

  readonly clientsStore = {
    getClient: async (clientId: string) => {
      const client = await this.client.getOAuthClient(clientId);
      return client ?? undefined;
    },
    registerClient: async (client: { client_name?: string; redirect_uris: string[] }) => {
      return this.client.registerOAuthClient({
        ...(client.client_name ? { clientName: client.client_name } : {}),
        redirectUris: client.redirect_uris,
      });
    },
  };

  // ── authorize ──────────────────────────────────────────────────────────────

  /**
   * Sends the user to Google to prove who they are.
   *
   * The client's own state never reaches Google. It is held here against an
   * opaque key, so nothing about the MCP client leaks into a third party's
   * logs, and the value that comes back cannot have been chosen by an attacker.
   */
  async authorize(
    client: { client_id: string },
    params: {
      state?: string;
      scopes?: string[];
      codeChallenge: string;
      redirectUri: string;
    },
    res: Response,
  ): Promise<void> {
    const key = randomBytes(24).toString("base64url");

    this.pending.set(key, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes ?? ["mcp"],
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    });

    const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    google.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
    google.searchParams.set("redirect_uri", `${config.PUBLIC_URL}/oauth/google/callback`);
    google.searchParams.set("response_type", "code");
    // Identity only. This flow needs to know who the user is, nothing more —
    // their Google Business Profile access already lives in Rank Titan.
    google.searchParams.set("scope", "openid email profile");
    google.searchParams.set("state", key);
    // The account chooser, so somebody with two Google accounts can pick the
    // one their Rank Titan account belongs to instead of silently using the
    // wrong one and being told they have no businesses.
    google.searchParams.set("prompt", "select_account");

    res.redirect(google.toString());
  }

  /**
   * Google sends the user back here. Resolves them to a Rank Titan account and
   * hands the MCP client its authorisation code.
   *
   * Returns the URL to send the browser to, or an error to show.
   */
  async handleGoogleCallback(
    googleCode: string,
    stateKey: string,
  ): Promise<{ redirectTo: string } | { error: string }> {
    const pending = this.pending.get(stateKey);
    this.pending.delete(stateKey);

    if (!pending || pending.expiresAt <= Date.now()) {
      return { error: "This sign-in link has expired. Add the connector again to retry." };
    }

    const identity = await this.client.resolveGoogleIdentity(
      googleCode,
      `${config.PUBLIC_URL}/oauth/google/callback`,
    );

    if (!identity) {
      return { error: "Google sign-in failed. Try again." };
    }

    if (!identity.userId) {
      // Signed in to Google, but no Rank Titan account behind it. Said plainly,
      // because the alternative is a connector that "works" and then reports
      // the user has no businesses.
      return {
        error: `No Rank Titan account found for ${identity.email ?? "that Google account"}. Create one free at https://ranktitan.ai, then add the connector again.`,
      };
    }

    const grant = await this.client.createOAuthGrant(
      identity.userId,
      pending.clientId,
      pending.scopes,
    );

    if (!grant) return { error: "Could not complete the authorisation. Try again." };

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      userId: identity.userId,
      grantId: grant.id,
      scopes: pending.scopes,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const back = new URL(pending.redirectUri);
    back.searchParams.set("code", code);
    if (pending.clientState) back.searchParams.set("state", pending.clientState);

    logger.info("OAuth authorisation completed", {
      userId: identity.userId,
      clientId: pending.clientId,
    });

    return { redirectTo: back.toString() };
  }

  // ── token exchange ─────────────────────────────────────────────────────────

  async challengeForAuthorizationCode(
    _client: { client_id: string },
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    return pending.codeChallenge;
  }

  /**
   * Codes are single use: taken out of the map before anything else can fail.
   * A code that could be replayed is a credential anyone who saw the redirect
   * can use.
   */
  async exchangeAuthorizationCode(
    client: { client_id: string },
    authorizationCode: string,
  ): Promise<IssuedTokens> {
    const pending = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode);

    if (!pending || pending.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }

    if (pending.clientId !== client.client_id) {
      logger.warn("Authorization code presented by the wrong client", {
        expected: pending.clientId,
        got: client.client_id,
      });
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }

    return this.issue(pending.userId, pending.grantId, pending.scopes);
  }

  /**
   * Refresh is where revocation takes effect: the grant is re-checked every
   * time, so "Disconnect" stops working credentials within the hour rather
   * than whenever a stored token happens to be looked at.
   */
  async exchangeRefreshToken(
    _client: { client_id: string },
    refreshToken: string,
  ): Promise<IssuedTokens> {
    const claims = this.verify(refreshToken, "refresh");
    if (!claims) throw new InvalidGrantError("Invalid or expired refresh token");

    const grant = await this.client.getActiveGrant(claims.grantId);
    // invalid_grant, not a 500: it is the answer that tells a client its
    // refresh token is dead and a NEW authorisation is what gets it back in.
    // Anything else and the client reports a broken server and stops, which
    // is a signed-out user with no way to sign in.
    if (!grant) throw new InvalidGrantError("This authorisation has been revoked. Sign in again.");

    return this.issue(grant.userId, grant.id, grant.scopes);
  }

  /**
   * Verifies a token and that the authorisation behind it still stands.
   *
   * The signature alone would be cheaper, but then "sign out" would be a lie:
   * a revoked session would keep working for the full hour of its access
   * token, because nothing would ask about the grant until the next refresh.
   * A disconnect that takes an hour is not a disconnect.
   *
   * The cost is kept off the hot path by remembering the answer for a few
   * seconds, so a burst of tool calls costs one check rather than one each.
   * That caps how stale a revocation can be at REVOCATION_CHECK_TTL_MS — a
   * few seconds, not an hour.
   */
  async verifyAccessToken(token: string): Promise<{
    token: string;
    clientId: string;
    scopes: string[];
    expiresAt: number;
    extra: { userId: string; grantId: string };
  }> {
    const claims = this.verify(token, "access");
    if (!claims) throw new InvalidTokenError("Invalid or expired access token");

    if (!(await this.grantStillStands(claims.grantId))) {
      throw new InvalidTokenError("This session has been signed out");
    }

    return {
      token,
      clientId: "",
      scopes: claims.scopes,
      expiresAt: claims.exp,
      extra: { userId: claims.userId, grantId: claims.grantId },
    };
  }

  /** Forgets a grant's cached verdict, so a sign-out is felt immediately. */
  forget(grantId: string): void {
    this.liveGrants.delete(grantId);
  }

  private async grantStillStands(grantId: string): Promise<boolean> {
    const cached = this.liveGrants.get(grantId);
    if (cached && cached.until > Date.now()) return cached.active;

    const grant = await this.client.getActiveGrant(grantId);
    const active = grant !== null;
    this.liveGrants.set(grantId, { active, until: Date.now() + REVOCATION_CHECK_TTL_MS });
    return active;
  }

  // ── signing ────────────────────────────────────────────────────────────────

  private issue(userId: string, grantId: string, scopes: string[]): IssuedTokens {
    return {
      access_token: this.sign("access", userId, grantId, scopes, ACCESS_TOKEN_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: this.sign("refresh", userId, grantId, scopes, REFRESH_TOKEN_TTL_SECONDS),
      scope: scopes.join(" "),
    };
  }

  /**
   * A compact signed token: payload and HMAC, nothing standing between them.
   *
   * Not a JWT, because a JWT's header invites the algorithm-confusion family of
   * bugs (`alg: none`, HS256 verified with an RSA public key) and nothing here
   * needs a third party to read these tokens. One algorithm, no negotiation.
   */
  private sign(
    kind: "access" | "refresh",
    userId: string,
    grantId: string,
    scopes: string[],
    ttlSeconds: number,
  ): string {
    const payload = {
      k: kind,
      userId,
      grantId,
      scopes,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      jti: randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  private verify(
    token: string,
    kind: "access" | "refresh",
  ): { userId: string; grantId: string; scopes: string[]; exp: number } | null {
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;

    // Constant time: a comparison that returns early leaks, byte by byte, how
    // much of a forged signature was right.
    const expected = this.mac(body);
    if (!safeEquals(signature, expected)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (payload.k !== kind) return null;
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
      if (typeof payload.userId !== "string" || typeof payload.grantId !== "string") return null;
      return {
        userId: payload.userId,
        grantId: payload.grantId,
        scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
        exp: payload.exp,
      };
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", config.OAUTH_SIGNING_SECRET).update(body).digest("base64url");
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.liveGrants) if (value.until <= now) this.liveGrants.delete(key);
  }
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Exported for the PKCE check the SDK performs. */
export const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");
