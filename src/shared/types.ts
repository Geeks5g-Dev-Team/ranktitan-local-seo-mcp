import type { ZodRawShape } from "zod";

/**
 * The contracts every other module is written against.
 *
 * Tools depend on these types and never on a concrete authenticator, store or
 * HTTP client. That is what lets the API key of v1 become OAuth later, and the
 * stubbed heatmap become Sebas's real service, without reopening a single tool.
 */

/** Who is calling, resolved from the credential before any tool runs. */
export interface Caller {
  /** Rank Titan userId. Already a Google subject id for accounts created with Google. */
  userId: string;
  email: string | null;
  /** Drives which quota applies. Never trust a value the client sends. */
  plan: "free" | "paid" | "legacy";
  /** Admins skip quota checks; everything else still applies. */
  isSuperAdmin: boolean;
  /**
   * True when nobody authenticated. Only tools marked `anonymous` run for this
   * caller — it exists so a stranger's first question can be answered at all,
   * which is the whole cold-start problem.
   */
  isAnonymous?: boolean;
  /**
   * The authorisation behind this call, when it came from a signed-in session
   * rather than an API key. It is what `sign_out` revokes, and a key has none
   * because there is no session to end — you stop using the key.
   */
  grantId?: string;
}

/**
 * Resolves a credential into a Caller, or throws {@link AuthError}.
 *
 * v1 ships `ApiKeyAuthenticator`. OAuth 2.1 + PKCE implements this same
 * interface, so swapping it is a one-line change in the composition root.
 */
export interface Authenticator {
  /** Short name for logs and the audit trail: "api_key", "oauth". */
  readonly strategy: string;
  /** @param credential Raw value of the Authorization header, scheme included. */
  authenticate(credential: string | undefined): Promise<Caller>;
}

/**
 * What a tool costs the caller, in quota terms.
 *
 * `none` is for reads that are free forever. Anything that spends money
 * downstream — a heatmap run, a published reply — declares a counter and a
 * cost, and the quota guard enforces it before the handler is reached.
 */
export type QuotaCost = { kind: "none" } | { kind: "metered"; counter: QuotaCounter; cost: number };

export type QuotaCounter = "heatmaps" | "review_replies";

/** Everything a handler is given. Nothing is read from module scope. */
export interface ToolContext {
  caller: Caller;
  /** Correlates the audit row, the logs and the MCP response. */
  requestId: string;
}

/**
 * One capability exposed to Claude or ChatGPT.
 *
 * Adding a tool means adding one file that exports this shape and listing it in
 * the registry. The day the heatmap contract lands, that is the whole change.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable id the model calls. snake_case, never renamed once published. */
  name: string;
  /** Short label for humans, shown in client UIs. */
  title: string;
  /**
   * Written FOR THE MODEL, not for a person. It has to say when to reach for
   * this tool, because that sentence is what decides whether Claude uses it at
   * all. See docs/tool-descriptions.md before editing one.
   */
  description: string;
  /** Zod shape. The only layer allowed to trust what the model sent. */
  inputSchema: ZodRawShape;
  quota: QuotaCost;
  /**
   * Callable without an account. Reserved for tools that read only public
   * Google data — never for anything that touches a customer's own records or
   * publishes on their behalf.
   */
  anonymous?: boolean;
  /**
   * What this tool does to the world, for the client to show before running it.
   *
   * Required by the Claude directory, and useful regardless: a client that
   * knows a tool only reads can call it without asking, and one that knows a
   * tool publishes to a customer's public profile can stop and confirm.
   */
  annotations: {
    /** True when the tool changes nothing. */
    readOnlyHint: boolean;
    /** True when its effect cannot be undone from here. */
    destructiveHint?: boolean;
    /** True when calling it twice is the same as calling it once. */
    idempotentHint?: boolean;
    /** True when it reaches services outside Rank Titan. */
    openWorldHint?: boolean;
  };
  /** Returns the payload; formatting for the chat happens in the presenter. */
  handler(input: TInput, context: ToolContext): Promise<TOutput>;
  /** Renders the result as Markdown. Local SEO is visual; plain JSON reads badly. */
  present(output: TOutput): string;
}

/** Authentication failed. Carries no detail that helps an attacker. */
export class AuthError extends Error {
  /**
   * True when the caller presented one of OUR tokens and it is no longer good
   * — expired, or its session was signed out.
   *
   * It changes what the client is told to do. RFC 6750 makes a client act on
   * `error="invalid_token"` by re-authenticating, where a bare challenge only
   * says "you are not authenticated" — which a client that believes it IS
   * authenticated reads as a plain failure, reports as an error, and never
   * offers the user a way back in.
   */
  readonly tokenRejected: boolean;

  constructor(message = "Invalid or missing credentials", tokenRejected = false) {
    super(message);
    this.name = "AuthError";
    this.tokenRejected = tokenRejected;
  }
}

/**
 * The tool needs an account and nobody is signed in.
 *
 * Its message is the conversion moment: it says what the user would get and
 * where to get it, rather than simply refusing.
 */
export class SignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/**
 * The caller is who they say, but may not reach this resource.
 *
 * Kept separate from AuthError on purpose: the most common way these
 * integrations leak is accepting an id from the model and returning it without
 * checking who owns it.
 */
export class ForbiddenError extends Error {
  constructor(message = "You do not have access to this business") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * The allowance is spent. The message is shown verbatim in the chat, so it
 * carries the upgrade link — this is the conversion moment, not an error page.
 */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly counter: QuotaCounter,
    readonly used: number,
    readonly limit: number,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}
