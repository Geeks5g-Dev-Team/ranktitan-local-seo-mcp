import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RankTitanClient } from "../ranktitan/client.js";
import { logger } from "../shared/logger.js";
import {
  ForbiddenError,
  SignInRequiredError,
  QuotaExceededError,
  type Caller,
  type ToolDefinition,
} from "../shared/types.js";
import type { QuotaService } from "../quota/quota.service.js";
import { listBusinessesTool } from "./list-businesses.tool.js";
import { getKeywordRankingsTool } from "./get-keyword-rankings.tool.js";
import { auditPublicBusinessTool } from "./audit-public-business.tool.js";
import { getLocalHeatmapTool } from "./get-local-heatmap.tool.js";
import { getHeatmapResultTool } from "./get-heatmap-result.tool.js";
import { signOutTool } from "./sign-out.tool.js";
import { getLocalCompetitorsTool } from "./get-local-competitors.tool.js";
import { auditBusinessProfileTool } from "./audit-business-profile.tool.js";
import { fetchPendingReviewsTool } from "./fetch-pending-reviews.tool.js";
import { postReviewReplyTool } from "./post-review-reply.tool.js";

/**
 * Every tool this server exposes.
 *
 * Adding one is a file plus a line here. When the heatmap contract lands, the
 * live-grid tool joins this list and nothing else changes — which is the whole
 * reason the quota, ownership and error handling live in the wrapper below
 * rather than inside each tool.
 */
export function buildTools(client: RankTitanClient): ToolDefinition<never, never>[] {
  return [
    listBusinessesTool(client),
    getKeywordRankingsTool(client),
    auditBusinessProfileTool(client),
    fetchPendingReviewsTool(client),
    postReviewReplyTool(client),
    // Public, no account needed. Listed last so the account-backed tools are
    // what a signed-in user sees first.
    auditPublicBusinessTool(client),
    getLocalHeatmapTool(client),
    getHeatmapResultTool(client),
    signOutTool(client),
    getLocalCompetitorsTool(client),
  ] as unknown as ToolDefinition<never, never>[];
}

/**
 * The tools that read a customer's own data, and so need an account.
 *
 * The transport needs this BEFORE a call runs: answering "sign in" with a 200
 * and a polite sentence is indistinguishable from success to a client, which
 * is why Claude connects anonymously and never offers the login. A 401 at the
 * door is the only answer it understands as "ask this person to sign in".
 */
export function privateToolNames(client: RankTitanClient): ReadonlySet<string> {
  return new Set(
    buildTools(client)
      .filter((tool) => !tool.anonymous)
      .map((tool) => tool.name),
  );
}

/**
 * Binds the tools to an MCP server instance for one authenticated caller.
 *
 * A server instance is built per request rather than shared, so the caller is
 * captured in a closure instead of living in mutable module state. With
 * concurrent requests from different accounts, shared state is how one user's
 * tool call ends up answering with another user's data.
 */
export function registerTools(
  server: McpServer,
  caller: Caller,
  deps: { client: RankTitanClient; quota: QuotaService },
): void {
  for (const tool of buildTools(deps.client)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // The title goes inside annotations as well as beside them: the
        // directory reads annotations.title for the listing, and flags a tool
        // without one even when the tool itself is titled.
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: unknown) => {
        const requestId = randomUUID();
        const startedAt = Date.now();

        const metered = tool.quota.kind === "metered" && !caller.isSuperAdmin;
        // Best effort: handlers do not report which business they touched, so
        // this is read off the input when the tool takes one. Good enough for an
        // audit row, and never trusted for anything else.
        const locationId =
          typeof (args as { location_id?: unknown })?.location_id === "string"
            ? (args as { location_id: string }).location_id
            : null;

        try {
          // 0. Anonymous callers get the public tools and nothing else. The
          //    refusal names what an account would add, because this is the
          //    moment someone decides whether to create one.
          if (caller.isAnonymous && !tool.anonymous) {
            throw new SignInRequiredError(
              "That needs a Rank Titan account — it reads your own businesses, rankings and reviews. " +
                "If you have one, reconnect this server and sign in with Google. " +
                "If you do not, create one free at https://ranktitan.ai. " +
                "Meanwhile I can audit any business on Google and show you who ranks for a local search.",
            );
          }

          // 1. Check the allowance BEFORE the work. Nothing is charged here:
          //    the cost is written once the tool has actually run, so a failure
          //    never costs the user a credit.
          if (tool.quota.kind === "metered" && !caller.isSuperAdmin) {
            await deps.quota.check(caller, tool.quota.counter, tool.quota.cost);
          }

          // 2. Run. Ownership checks live inside the handlers, against the
          //    caller, because only they know which argument is a business id.
          const output = await tool.handler(args as never, {
            caller,
            requestId,
          });

          const durationMs = Date.now() - startedAt;
          logger.info("Tool call succeeded", {
            tool: tool.name,
            userId: caller.userId,
            requestId,
            ms: durationMs,
          });

          // 3. Audit, and charge only now. Awaited so a credit is never lost to
          //    a process that exits first; the store swallows its own failures
          //    rather than turning a bookkeeping problem into a broken tool.
          // Anonymous calls are not audited: the row hangs off a user and there
          // is none. They are bounded by the per-IP rate limit instead.
          if (!caller.isAnonymous) {
            await deps.quota.record({
              userId: caller.userId,
              tool: tool.name,
              requestId,
              status: "ok",
              counter: metered && tool.quota.kind === "metered" ? tool.quota.counter : null,
              cost: metered && tool.quota.kind === "metered" ? tool.quota.cost : 0,
              locationId,
              durationMs,
            });
          }

          return {
            content: [{ type: "text" as const, text: tool.present(output as never) }],
          };
        } catch (error) {
          // Refusals are audited too, not just successes: a spike of them is
          // what abuse looks like from the outside. Cost is always zero here.
          if (!caller.isAnonymous) {
            await deps.quota.record({
              userId: caller.userId,
              tool: tool.name,
              requestId,
              status:
                error instanceof QuotaExceededError || error instanceof ForbiddenError
                  ? "refused"
                  : "error",
              counter: null,
              cost: 0,
              locationId,
              detail: error instanceof Error ? error.message : String(error),
              durationMs: Date.now() - startedAt,
            });
          }

          return toToolError(error, {
            tool: tool.name,
            userId: caller.userId,
            requestId,
            ms: Date.now() - startedAt,
          });
        }
      },
    );
  }
}

/**
 * Turns a thrown error into something the model can read out loud.
 *
 * `isError: true` matters: it tells the client this is a failed call rather
 * than a result, so the model does not present the message as data.
 *
 * Only messages written here reach the user. Upstream errors were already
 * reduced to a safe sentence by the Rank Titan client, and anything unexpected
 * is logged in full and replaced with a generic line — a stack trace in a chat
 * window is both useless to the user and a gift to anyone probing the server.
 */
function toToolError(
  error: unknown,
  meta: { tool: string; userId: string; requestId: string; ms: number },
): { content: { type: "text"; text: string }[]; isError: true } {
  const text = (() => {
    if (error instanceof QuotaExceededError) {
      logger.info("Tool call blocked by quota", {
        ...meta,
        counter: error.counter,
      });
      return error.message;
    }

    if (error instanceof SignInRequiredError) {
      logger.info("Anonymous caller refused a private tool", meta);
      return error.message;
    }

    if (error instanceof ForbiddenError) {
      logger.warn("Tool call blocked by ownership check", meta);
      // Keep the thrower's own wording when it bothered to be specific: a
      // missing review and a business belonging to someone else are different
      // things to the user, even though both are refusals.
      return error.message || "That business is not in this Rank Titan account.";
    }

    if (error instanceof Error) {
      logger.error("Tool call failed", { ...meta, error: error.message });
      return error.message;
    }

    logger.error("Tool call failed with a non-error", {
      ...meta,
      error: String(error),
    });
    return "Something went wrong running that tool.";
  })();

  return { content: [{ type: "text" as const, text }], isError: true };
}
