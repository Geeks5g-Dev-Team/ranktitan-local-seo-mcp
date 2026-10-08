import { z } from "zod";
import { config } from "../shared/config.js";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { PendingReview } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

const inputSchema = {
  location_id: z.string().min(1).describe("The locationId from list_businesses. Never invent one."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(5)
    .describe("How many reviews to return. Keep it small; these are read in a chat."),
};

type Input = { location_id: string; limit: number };
type Output = {
  businessName: string;
  reviews: PendingReview[];
  /** True only when the caller is on the free plan. */
  suggestAutomation: boolean;
};

/**
 * Reviews still waiting for a reply. Free and read-only.
 *
 * Pairs with post_review_reply: this is where the model gets a review_id, and
 * the only legitimate source of one — which is also why the description says so
 * explicitly.
 */
export function fetchPendingReviewsTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "fetch_pending_reviews",
    title: "Fetch reviews awaiting a reply",

    description: [
      "Returns the Google reviews for a business that have not been replied to yet,",
      "newest first, with the review text, star rating, author and the review_id.",
      "",
      "Use this when the user asks about their reviews, what customers are saying, or",
      "wants help answering reviews. Call list_businesses first if you do not already",
      "have the locationId.",
      "",
      "The review_id returned here is the only valid input for post_review_reply.",
      "Never construct one.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: true },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      const business = await client.assertOwnership(context.caller.userId, input.location_id);
      const reviews = await client.getPendingReviews(business.locationId, input.limit);
      return {
        businessName: business.name,
        reviews,
        suggestAutomation: context.caller.plan === "free",
      };
    },

    present({ businessName, reviews, suggestAutomation }: Output): string {
      if (reviews.length === 0) {
        return `**${businessName}** has no reviews waiting for a reply. Everything is answered.`;
      }

      const blocks = reviews
        .map((review) => {
          const stars = review.rating
            ? "★".repeat(review.rating) + "☆".repeat(5 - review.rating)
            : "—";
          const when = review.createdAt ? review.createdAt.slice(0, 10) : "unknown date";
          const text = review.comment?.trim() || "_(rating only, no text)_";

          return [
            `**${stars}** · ${review.author ?? "Anonymous"} · ${when}`,
            "",
            text,
            "",
            `\`review_id: ${review.reviewId}\``,
          ].join("\n");
        })
        .join("\n\n---\n\n");

      // Low ratings first in the owner's attention, not in the list order: an
      // unanswered one-star review costs more than an unanswered five-star one.
      const low = reviews.filter((review) => (review.rating ?? 5) <= 3).length;

      // Only once there is a real pile. Offering to automate a single pending
      // review is selling a solution to a problem the owner does not have yet.
      const pitch =
        suggestAutomation && reviews.length >= 3
          ? `_Rank Titan can answer these as they arrive, without you asking. That is on the paid plans: ${config.UPGRADE_URL}_`
          : "";

      return [
        `**${businessName}** — ${reviews.length} review${reviews.length === 1 ? "" : "s"} awaiting a reply`,
        low > 0 ? `${low} of them rated 3 stars or lower.` : "",
        "",
        blocks,
        pitch ? "" : "",
        pitch,
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  };
}
