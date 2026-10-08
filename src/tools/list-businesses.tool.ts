import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { BusinessSummary } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

/**
 * A chat is not a dashboard. Agency accounts hold hundreds of locations and a
 * table that long is unreadable for the person and expensive for the model.
 */
const MAX_ROWS = 25;

const inputSchema = {
  search: z
    .string()
    .trim()
    .min(2)
    .optional()
    .describe(
      "Filter by business name or address. Use it when the account has more locations than fit in one answer and the user named a specific one.",
    ),
};

type Input = { search?: string };
type Output = { businesses: BusinessSummary[]; search: string | null };

/**
 * The entry point of every conversation with this server.
 *
 * Nothing else is callable without a locationId, and the model has no way to
 * invent one, so in practice Claude calls this first and then chains. That is
 * also why the description names the other tools: it tells the model what this
 * unlocks instead of leaving it to guess.
 */
export function listBusinessesTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "list_businesses",
    title: "List the user's businesses",

    description: [
      "Lists the ACTIVE Google Business Profile locations this Rank Titan account",
      "manages, with the locationId each one is identified by. Inactive locations",
      "are not tracked and are only reported as a count.",
      "",
      "Accounts can hold hundreds of locations, so pass `search` with part of the",
      "business name when the user named one. Without it you get the first 25.",
      "",
      "Use this first whenever the user asks about their own business, rankings,",
      "reviews or local SEO without naming a specific location, and whenever another",
      "tool needs a locationId you do not already have from this conversation.",
      "Never guess or construct a locationId: they are opaque 20-digit Google ids",
      "and a wrong one returns an access error.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: false },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      const businesses = await client.listBusinesses(context.caller.userId);
      return { businesses, search: input.search ?? null };
    },

    present({ businesses, search }: Output): string {
      // Only active locations are tracked, so only those can answer any other
      // tool. A real account made this obvious: 500 locations, 112 active.
      const active = businesses.filter((business) => business.active);
      const inactive = businesses.length - active.length;

      if (active.length === 0) {
        return [
          `This account has ${businesses.length} Google Business Profile location${
            businesses.length === 1 ? "" : "s"
          }, but none of them are active, so none are being tracked.`,
          "",
          "Activate one at https://ranktitan.ai to start tracking local rankings.",
        ].join("\n");
      }

      const needle = search?.toLowerCase();
      const matching = needle
        ? active.filter(
            (business) =>
              business.name.toLowerCase().includes(needle) ||
              (business.address ?? "").toLowerCase().includes(needle),
          )
        : active;

      if (needle && matching.length === 0) {
        return [
          `No active business matches "${search}".`,
          "",
          `This account has ${active.length} active locations. Try part of the name, or ask to list them all.`,
        ].join("\n");
      }

      const shown = matching.slice(0, MAX_ROWS);
      const rows = shown
        .map((business) => {
          const plan = business.planType ?? "—";
          return `| ${escapeCell(business.name)} | ${escapeCell(business.address ?? "—")} | ${plan} | \`${business.locationId}\` |`;
        })
        .join("\n");

      const heading = needle
        ? `**${matching.length} active business${matching.length === 1 ? "" : "es"}** matching "${escapeCell(search ?? "")}"`
        : `**${active.length} active business${active.length === 1 ? "" : "es"}**`;

      const lines = [
        heading,
        "",
        "| Business | Address | Plan | Location ID |",
        "| --- | --- | --- | --- |",
        rows,
      ];

      if (matching.length > shown.length) {
        // Phrased as a next step, not a limit. Claude reported the earlier
        // wording to the user as "the MCP only returns the first 25", which
        // reads like a defect rather than a list waiting to be narrowed.
        lines.push(
          "",
          `_Showing ${shown.length} of ${matching.length}. Search by name to find a specific one — for example: list_businesses with search "locksmith"._`,
        );
      }

      if (inactive > 0) {
        lines.push(
          "",
          `_${inactive} inactive location${inactive === 1 ? " is" : "s are"} not listed: inactive locations are not tracked._`,
        );
      }

      return lines.join("\n");
    },
  };
}

/**
 * Keeps a pipe in a business name from splitting the Markdown table, and a
 * newline from ending it early.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Exported so the registry can build the runtime validator from the same shape. */
export const listBusinessesInput = z.object(inputSchema);
