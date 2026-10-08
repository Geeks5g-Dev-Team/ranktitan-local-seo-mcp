import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { PublicBusiness } from "../ranktitan/models.js";
import type { ToolDefinition } from "../shared/types.js";

const inputSchema = {
  business: z
    .string()
    .trim()
    .min(3)
    .describe(
      'The business name with its city, as a person would say it: "Harbour Street Locksmiths, Eastbourne". A Google Maps link also works.',
    ),
};

type Input = { business: string };
type Output = { query: string; business: PublicBusiness | null };

/**
 * The cold-start tool, and the only one that needs no account.
 *
 * Every other tool here reads a customer's own records, so a stranger who finds
 * this server in a public directory and connects has nothing to ask. This one
 * answers for any business on Google, instantly, which is what makes a first
 * conversation worth having — and what turns into a reason to sign up.
 */
export function auditPublicBusinessTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "audit_public_business",
    title: "Audit any business on Google",

    description: [
      "Audits the public Google Business Profile of ANY business — no Rank Titan",
      "account needed. Returns its category, website, phone, opening hours, rating",
      "and review count, and flags what is missing or weak.",
      "",
      "Use this whenever someone asks about a business that is not in their own",
      "account: their own before signing up, a prospect, or a competitor. This is",
      "the right tool when list_businesses returns nothing.",
      "",
      "Report the gaps as actions the owner can take today, and do not invent",
      "findings beyond what the result contains.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: true },
    anonymous: true,

    async handler(input: Input): Promise<Output> {
      const business = await client.findPublicBusiness(input.business);
      return { query: input.business, business };
    },

    present({ query, business }: Output): string {
      if (!business) {
        return [
          `Google has no business matching "${query}".`,
          "",
          'Try the full name with the city, for example: "Joe\'s Plumbing, Austin TX".',
        ].join("\n");
      }

      const checks: { label: string; ok: boolean; detail: string }[] = [
        {
          label: "Category",
          ok: !!business.primaryCategory,
          detail: business.primaryCategory ?? "Missing — the strongest ranking signal there is",
        },
        {
          label: "Website",
          ok: !!business.website,
          detail: business.website ?? "Missing",
        },
        {
          label: "Phone",
          ok: !!business.phone,
          detail: business.phone ?? "Missing",
        },
        {
          label: "Opening hours",
          ok: business.hasHours,
          detail: business.hasHours
            ? "Set"
            : "Not set — Google downranks and sometimes hides listings without hours",
        },
        {
          label: "Reviews",
          // Below roughly fifty reviews a local business is usually outgunned by
          // anyone established nearby, which is the point worth making.
          ok: business.reviewCount >= 50,
          detail:
            business.reviewCount === 0
              ? "No reviews at all"
              : `${business.reviewCount} review${business.reviewCount === 1 ? "" : "s"}${
                  business.rating ? `, averaging ${business.rating}` : ""
                }${business.reviewCount < 50 ? " — thin for local search" : ""}`,
        },
      ];

      const rows = checks
        .map(
          (check) => `| ${check.ok ? "✅" : "⚠️"} | ${check.label} | ${escapeCell(check.detail)} |`,
        )
        .join("\n");

      const missing = checks.filter((check) => !check.ok);

      const lines = [
        `**${escapeCell(business.name)}**`,
        business.address ? `_${escapeCell(business.address)}_` : "",
        "",
        `Profile score: **${checks.length - missing.length}/${checks.length}**`,
        "",
        "| | Check | Detail |",
        "| --- | --- | --- |",
        rows,
      ];

      if (missing.length > 0) {
        lines.push(
          "",
          `**Fix first:** ${missing.map((check) => check.label.toLowerCase()).join(", ")}.`,
        );
      }

      if (business.mapsUri) {
        lines.push("", `[View on Google Maps](${business.mapsUri})`);
      }

      return lines.filter((line) => line !== "").join("\n");
    },
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
