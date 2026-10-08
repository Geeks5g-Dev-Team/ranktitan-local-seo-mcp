import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { ProfileAudit } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

const inputSchema = {
  location_id: z.string().min(1).describe("The locationId from list_businesses. Never invent one."),
};

type Input = { location_id: string };
type Output = { businessName: string; audit: ProfileAudit };

/**
 * Checks what a Google Business Profile is missing, from the data Rank Titan
 * already stores. No heatmap call, so this ships without waiting on anyone.
 *
 * An incomplete profile is the most common and most fixable reason a local
 * business underperforms, which makes this the tool most likely to produce an
 * action the owner can take in the same conversation.
 */
export function auditBusinessProfileTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "audit_business_profile",
    title: "Audit a Google Business Profile",

    description: [
      "Checks a business's Google Business Profile for the things Google uses to rank",
      "and display it: description, categories, website, phone, opening hours, photos",
      "and whether the listing is verified.",
      "",
      "Use this when the user asks what is wrong with their listing, why they are not",
      "showing up, how to improve their local SEO, or asks for an audit or a checkup.",
      "Call list_businesses first if you do not already have the locationId.",
      "",
      "Report the misses as concrete actions the owner can take, and do not invent",
      "findings beyond what the result contains.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: true },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      // Ownership before data, always: the locationId came from a model.
      const business = await client.assertOwnership(context.caller.userId, input.location_id);
      return { businessName: business.name, audit: client.auditProfile(business) };
    },

    present({ businessName, audit }: Output): string {
      const rows = audit.checks
        .map((check) => {
          const mark = check.passed ? "✅" : "⚠️";
          return `| ${mark} | ${escapeCell(check.label)} | ${escapeCell(check.detail)} |`;
        })
        .join("\n");

      const failed = audit.checks.filter((check) => !check.passed);

      const lines = [
        `**${businessName}** — profile score ${audit.passed}/${audit.checks.length}`,
        "",
        "| | Check | Detail |",
        "| --- | --- | --- |",
        rows,
      ];

      if (failed.length === 0) {
        lines.push("", "Nothing missing. Every checked field is filled in.");
      } else {
        lines.push(
          "",
          `**${failed.length} thing${failed.length === 1 ? "" : "s"} to fix:** ` +
            failed.map((check) => check.label.toLowerCase()).join(", ") +
            ".",
        );
      }

      return lines.join("\n");
    },
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
