import { z } from "zod";
import { config } from "../shared/config.js";
import type { RankTitanClient } from "../ranktitan/client.js";
import { ForbiddenError, type ToolContext, type ToolDefinition } from "../shared/types.js";

const inputSchema = {
  review_id: z
    .string()
    .min(1)
    .describe("A review_id returned by fetch_pending_reviews. Never construct one."),
  reply_text: z
    .string()
    .trim()
    .min(10, "A reply this short will read as dismissive to the customer.")
    .max(4000)
    .describe("The reply to publish, exactly as the user approved it."),
};

type Input = { review_id: string; reply_text: string };
type Output = {
  published: boolean;
  businessName: string;
  characters: number; /** True only when the caller is on the free plan. */
  suggestAutomation: boolean;
};

/**
 * Publishes a reply to a Google review. Metered, and the only tool here that
 * changes anything the public can see.
 *
 * Two safeguards matter more than the happy path:
 *
 * 1. The reply is public and effectively permanent. The description tells the
 *    model to show the exact text and get the user's approval first, because
 *    nothing in MCP forces a confirmation step.
 * 2. The review id is verified to belong to the caller before anything is sent.
 *    The data credential is an admin identity that bypasses Rank Titan's
 *    PermissionGuard, so a made-up id would otherwise post to a stranger's
 *    listing under their business name.
 */
export function postReviewReplyTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "post_review_reply",
    title: "Publish a reply to a review",

    description: [
      "Publishes a reply to a single Google review, under the business's name.",
      "",
      "This is public and immediate: it appears on the business's Google listing and",
      "cannot be taken back from here. Before calling it, show the user the exact",
      "reply text and wait for them to approve it. Never call it with text you",
      "composed but did not show them, and never call it to 'try' anything.",
      "",
      "The review_id must come from fetch_pending_reviews.",
    ].join(" "),

    inputSchema,
    // One credit per published reply. The guard runs before the handler, so a
    // refusal never reaches Google.
    quota: { kind: "metered", counter: "review_replies", cost: 1 },
    // Destructive on purpose, so a client stops and asks first. It publishes
    // on a customer's public Google listing and cannot be taken back from
    // here — undoing it means going into Google Business Profile by hand.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      const review = await client.getReview(input.review_id);
      if (!review) {
        throw new ForbiddenError("No review with that id on this account.");
      }

      // Resolve the owning business and check it against the caller. Identical
      // refusal whether the review is missing or someone else's, so this cannot
      // be used to discover which ids are real.
      const business = await client.assertOwnership(context.caller.userId, review.locationId);

      await client.publishReviewReply(review.reviewId, input.reply_text);

      return {
        published: true,
        businessName: business.name,
        characters: input.reply_text.length,
        // Only for someone who is not already paying. An upsell shown to a
        // customer who bought the thing is noise, and it is the kind of noise
        // that gets a tool switched off.
        suggestAutomation: context.caller.plan === "free",
      };
    },

    present({ businessName, characters, suggestAutomation }: Output): string {
      const lines = [
        `✅ Reply published for **${businessName}** (${characters} characters).`,
        "",
        "It is live on the Google listing now. Editing it afterwards has to be done",
        "from Google Business Profile directly.",
      ];

      // The upsell lands here, after the thing worked, because that is when it
      // is an offer rather than a toll gate. Replying by hand stays free on
      // every plan; what is sold is not having to.
      if (suggestAutomation) {
        lines.push(
          "",
          `Rank Titan can write and publish these on its own, for every new review, without you asking. That is on the paid plans: ${config.UPGRADE_URL}`,
        );
      }

      return lines.join("\n");
    },
  };
}
