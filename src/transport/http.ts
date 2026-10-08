import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { AuthError, type Authenticator, type Caller } from "../shared/types.js";

/**
 * Where the MCP endpoint lives, and therefore what the OAuth layer must call
 * the protected resource. One constant because the two must never drift: the
 * discovery path is derived from this, and a mismatch is invisible until a
 * client silently decides the server has no sign-in.
 */
const MCP_ENDPOINT_PATH = "/mcp";

/**
 * The WWW-Authenticate challenge for a rejected call.
 *
 * `error="invalid_token"` is the difference between a client offering the user
 * a way back in and reporting a server error: RFC 6750 defines it as "the
 * token is expired, revoked or invalid", which is an instruction to
 * re-authenticate. Without it a client that believes it is signed in has no
 * reason to think signing in again would help.
 *
 * It is only sent when a token of ours was actually presented and refused.
 * Claiming it for a caller who sent nothing would be telling them to renew
 * something they never had.
 */
function challenge(error: AuthError): string {
  const base = `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`;
  if (!error.tokenRejected) return base;
  return `${base}, error="invalid_token", error_description="${error.message.replace(/"/g, "'")}"`;
}

/**
 * Whether a JSON-RPC body calls a tool that needs an account.
 *
 * Accepts a batch as well as a single message, because the spec allows an
 * array and one private call in it is enough to need a signed-in user.
 */
function callsPrivateTool(body: unknown, needsAccount: ReadonlySet<string>): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    const call = message as { method?: unknown; params?: { name?: unknown } };
    return (
      call?.method === "tools/call" &&
      typeof call.params?.name === "string" &&
      needsAccount.has(call.params.name)
    );
  });
}

/** The URL a client is told to read to learn how to sign in (RFC 9728). */
const protectedResourceMetadataUrl = (): string =>
  new URL(`/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`, config.PUBLIC_URL).href;

/**
 * Stands in for nobody. Only tools marked `anonymous` accept it, and the quota
 * never applies because there is no account to charge.
 */
const ANONYMOUS_CALLER: Caller = {
  userId: "anonymous",
  email: null,
  plan: "free",
  isSuperAdmin: false,
  isAnonymous: true,
};
import type { RankTitanClient } from "../ranktitan/client.js";
import type { QuotaService } from "../quota/quota.service.js";
import { privateToolNames, registerTools } from "../tools/registry.js";
import { rateLimiter } from "./rate-limit.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RankTitanOAuthProvider } from "../auth/oauth.provider.js";

export interface ServerDeps {
  authenticator: Authenticator;
  /** Absent when Google OAuth is not configured; API keys still work. */
  oauth?: RankTitanOAuthProvider;
  /**
   * Turns a userId from a verified OAuth token into a Caller.
   *
   * Needed because the token says who, not what plan they are on, and the plan
   * decides the quota. Read per request rather than baked into the token, so a
   * customer who just upgraded is not told to wait an hour.
   */
  resolveUser(userId: string): Promise<Caller | null>;
  client: RankTitanClient;
  quota: QuotaService;
}

/**
 * Remote MCP over Streamable HTTP.
 *
 * Stateless by design: a transport and an `McpServer` are built per request and
 * thrown away. It costs a little per call and buys two things that matter more —
 * the authenticated caller is captured in a closure rather than shared mutable
 * state, and the service scales horizontally without sticky sessions.
 */
export function createHttpServer(deps: ServerDeps): Express {
  const app = express();

  // Exactly one proxy hop: a reverse proxy sits in front and records the
  // real client.
  //
  // Without this Express reports the PROXY's address as `request.ip`, so every
  // anonymous visitor on the internet shares a single rate-limit bucket — the
  // first few would spend it and everyone else would get 429. A limiter that
  // turns public traffic into an outage is worse than none.
  //
  // `1`, never `true`: trusting the whole chain would let a caller forge
  // X-Forwarded-For and land in a bucket of their choosing, which is the limit
  // being optional.
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  // Liveness. Deliberately says nothing about configuration or versions.
  app.get("/health", (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  });

  // ── OAuth ──────────────────────────────────────────────────────────────────
  //
  // Mounted before /mcp so the discovery documents a client fetches first are
  // served without authentication, which is what turns "paste a key into a
  // header called x-account-key" into a Connect button.
  if (deps.oauth) {
    app.use(
      mcpAuthRouter({
        provider: deps.oauth as never,
        issuerUrl: new URL(config.PUBLIC_URL),
        baseUrl: new URL(config.PUBLIC_URL),
        // The protected resource is the MCP endpoint, not the site root, and
        // saying so is what makes the sign-in discoverable at all: RFC 9728
        // puts a resource's metadata at a path built from ITS path, so a
        // client connecting to /mcp looks under
        // /.well-known/oauth-protected-resource/mcp. Left at the default the
        // SDK publishes at the root instead, the client gets a 404 there,
        // concludes the server has no OAuth, and never offers to sign in.
        resourceServerUrl: new URL(MCP_ENDPOINT_PATH, config.PUBLIC_URL),
        resourceName: "Rank Titan Local SEO",
        scopesSupported: ["mcp"],
      }),
    );

    /**
     * Where Google sends the user back. Not part of the MCP spec — it is the
     * second half of our own authorize step, and the only reason the user never
     * has to see a key.
     */
    app.get("/oauth/google/callback", async (request: Request, response: Response) => {
      const code = typeof request.query["code"] === "string" ? request.query["code"] : null;
      const state = typeof request.query["state"] === "string" ? request.query["state"] : null;

      if (!code || !state) {
        response
          .status(400)
          .send(page("Sign-in failed", "The link was incomplete. Try connecting again."));
        return;
      }

      try {
        const result = await deps.oauth!.handleGoogleCallback(code, state);
        if ("error" in result) {
          response.status(400).send(page("Not connected", result.error));
          return;
        }
        response.redirect(result.redirectTo);
      } catch (error) {
        logger.error("Google callback failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        response.status(500).send(page("Sign-in failed", "Something went wrong. Try again."));
      }
    });
  }

  app.use("/mcp", rateLimiter());

  // Computed once: the list is static, and rebuilding it per request would be
  // work done on every single call to answer a question that never changes.
  const needsAccount = privateToolNames(deps.client);

  app.post(MCP_ENDPOINT_PATH, async (request: Request, response: Response) => {
    let transport: StreamableHTTPServerTransport | undefined;
    let server: McpServer | undefined;

    try {
      // Claude's connector UI will NOT let a user set an `Authorization` header:
      // custom header names need Anthropic's approval, and the dropdown offers a
      // fixed list. `x-account-key` is on that list and is meant for exactly
      // this, so the key is accepted there too. Authorization still works for
      // every other client (Cursor, the MCP Inspector, plain curl).
      const credential =
        request.headers.authorization ??
        headerValue(request.headers["x-account-key"]) ??
        headerValue(request.headers["x-project-key"]);

      // NO credential means a stranger: give them the public tools, because
      // answering their first question is the whole point of having them.
      //
      // A credential that is present but does not work is a different thing
      // entirely — a typo, or a revoked key — and silently downgrading that
      // user to anonymous would tell someone who HAS an account to go create
      // one. They get a 401 so the real problem is visible.
      // Two ways in, tried in order. An OAuth token is what the Connect button
      // produces; an API key is what a client that cannot do OAuth pastes.
      // Both end at the same Caller, so nothing downstream knows the difference.
      const caller: Caller = credential?.trim()
        ? await resolveCaller(credential, deps)
        : ANONYMOUS_CALLER;

      // A stranger reaching for someone's own data is asked to sign in HERE,
      // with a 401, rather than inside the tool with a polite sentence.
      //
      // The sentence is a 200, and a 200 is indistinguishable from success to
      // an MCP client: it connects anonymously, never learns a login exists,
      // and the user is left pasting API keys. The status code is the only
      // part of the answer a client acts on.
      //
      // It has to happen before the transport writes anything, which is why it
      // reads the request body rather than living in the tool wrapper — by the
      // time a tool runs the response has already begun.
      if (caller.isAnonymous && callsPrivateTool(request.body, needsAccount)) {
        throw new AuthError(
          "That needs a Rank Titan account — it reads your own businesses, rankings and reviews. " +
            "Sign in, or create an account free at https://ranktitan.ai.",
        );
      }

      server = new McpServer(
        { name: "ranktitan-local-seo", version: "0.1.0" },
        {
          instructions: [
            "Rank Titan tracks how local businesses rank on Google Maps.",
            "Call list_businesses first to find the locationId for a business;",
            "never invent one.",
          ].join(" "),
        },
      );

      registerTools(server, caller, { client: deps.client, quota: deps.quota });

      // Omitting sessionIdGenerator is the SDK's stateless mode: no session ids
      // to track, so nothing can leak between callers.
      transport = new StreamableHTTPServerTransport({});

      // Close the per-request objects whenever the HTTP response ends, however
      // it ends. Without this a dropped connection leaks a transport per call.
      response.on("close", () => {
        void transport?.close();
        void server?.close();
      });

      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      void transport?.close();
      void server?.close();

      if (error instanceof AuthError) {
        // Logged because its absence cost an afternoon: a 401 left no trace, so
        // "did the request even arrive?" could only be answered from the
        // proxy's access log.
        logger.info("Rejected an unauthenticated call", {
          tokenRejected: error.tokenRejected,
          reason: error.message,
        });
        // The challenge that turns "this connector failed" into a Connect
        // button: it is how a client learns the server speaks OAuth and where
        // to read the details (RFC 9728).
        //
        // It was deliberately absent while OAuth was not implemented — Claude
        // acted on the challenge, attempted dynamic client registration
        // against endpoints that did not exist, and the connector died with
        // "could not register with the login service" before the user could
        // even paste a key. Both halves now exist, so advertising them is what
        // makes the sign-in flow discoverable instead of a dead end.
        //
        // The API key path is untouched: a client that ignores the challenge
        // and sends a key still authenticates exactly as before.
        response
          .status(401)
          .set("WWW-Authenticate", challenge(error))
          .json(
            jsonRpcError(
              -32001,
              // The thrower's own wording when it bothered to be specific: a
              // stranger reaching for private data and a typo'd key are
              // different problems, and the second must not read as an
              // invitation to create an account.
              error.message ||
                "Authentication required. Sign in with Google, or send your Rank Titan API key as `Authorization: Bearer <key>` (or in the `x-account-key` header if your client cannot set Authorization).",
            ),
          );
        return;
      }

      logger.error("MCP request failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (!response.headersSent) {
        response.status(500).json(jsonRpcError(-32603, "Internal server error."));
      }
    }
  });

  // GET and DELETE belong to the stateful session flow, which this server does
  // not use. Answering explicitly beats a confusing 404 from the router.
  const notSupported = (_request: Request, response: Response): void => {
    response.status(405).json(jsonRpcError(-32000, "This server is stateless; use POST /mcp."));
  };
  app.get("/mcp", notSupported);
  app.delete("/mcp", notSupported);

  return app;
}

/**
 * Resolves whichever credential arrived.
 *
 * An OAuth token is tried first because it is the flow a user goes through
 * deliberately; a bad one should say so rather than fall through and be
 * reported as a bad API key, which would send somebody looking in the wrong
 * place entirely.
 */
async function resolveCaller(credential: string, deps: ServerDeps): Promise<Caller> {
  const bearer = /^Bearer\s+(.+)$/i.exec(credential.trim())?.[1]?.trim();
  // Whether what was presented was one of our tokens, rather than something
  // else sent with a Bearer prefix. It decides what the 401 tells the client.
  let ourTokenRejected = false;

  if (deps.oauth && bearer) {
    try {
      const info = await deps.oauth.verifyAccessToken(bearer);
      const resolved = await deps.resolveUser(info.extra.userId);
      // Carried through so sign_out knows which authorisation to end. An API
      // key caller never gets one, which is what makes the tool able to say
      // there is no session rather than failing obscurely.
      if (resolved) return { ...resolved, grantId: info.extra.grantId };
      logger.warn("OAuth token for a user that no longer resolves", {
        userId: info.extra.userId,
      });
      ourTokenRejected = true;
    } catch {
      // Not one of ours, or expired. Fall through to the API key path: the
      // same header carries both, and a user pasting a key may well send it
      // with a Bearer prefix.
      ourTokenRejected = looksLikeOurToken(bearer);
    }
  }

  try {
    return await deps.authenticator.authenticate(credential);
  } catch (error) {
    if (ourTokenRejected) {
      // Said precisely, because this is the case where the user has an account
      // and a client that thinks it is signed in. Anything vaguer and the
      // client reports a server error instead of offering to sign in again.
      throw new AuthError("Your Rank Titan session has ended. Sign in again.", true);
    }
    throw error;
  }
}

/**
 * Our access tokens are a base64url payload and its signature, joined by a dot.
 *
 * Checked by shape rather than by verifying, because the point is to tell "a
 * session of ours that is over" apart from "some other credential sent with a
 * Bearer prefix" — and a token whose signature fails is exactly the first
 * thing, not the second.
 */
function looksLikeOurToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** Node gives a repeated header as an array; take the first value. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * A plain page for the handful of moments a human looks at this server directly:
 * the end of a sign-in that did not work. Deliberately tiny and self-contained —
 * no stylesheet, no script, nothing to load from anywhere.
 */
function page(title: string, message: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#111">
<h1 style="font-size:1.25rem">${escape(title)}</h1>
<p>${escape(message)}</p>
</body></html>`;
}

/** JSON-RPC error envelope. MCP clients expect this shape, not a bare body. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

export function startHttpServer(deps: ServerDeps): void {
  createHttpServer(deps).listen(config.PORT, () => {
    logger.info("MCP server listening", {
      port: config.PORT,
      url: `${config.PUBLIC_URL}/mcp`,
      auth: deps.authenticator.strategy,
      env: config.NODE_ENV,
    });
  });
}
