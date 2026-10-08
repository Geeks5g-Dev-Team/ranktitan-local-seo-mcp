import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { PublicCompetitor } from "../ranktitan/models.js";
import type { ToolDefinition } from "../shared/types.js";

const inputSchema = {
  search: z
    .string()
    .trim()
    .min(3)
    .describe('What a customer would type, with the place: "locksmith in Eastbourne".'),
  limit: z.number().int().min(1).max(10).default(5).describe("How many rivals to return."),
};

type Input = { search: string; limit: number };
type Output = { search: string; competitors: PublicCompetitor[] };

/**
 * Who Google actually returns for a search, with their ratings and review
 * counts. No account needed.
 *
 * This is not the geo-grid heatmap — it is one ranked list, not a hundred
 * sampled points — and it does not pretend to be. It exists because it can ship
 * now and answers the question an owner really has: who is beating me, and by
 * how much.
 */
export function getLocalCompetitorsTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "get_local_competitors",
    title: "See who ranks for a local search",

    description: [
      "Returns the businesses Google shows for a local search, with their star",
      "rating and how many reviews each has. No Rank Titan account needed.",
      "",
      "Use this when someone asks who their competitors are, who is ranking above",
      "them, or how they compare locally. Pair it with audit_public_business to",
      "show an owner the gap between their listing and the ones beating them.",
      "",
      "This is a single ranked list, not a geographic grid: do not describe it as",
      "a heatmap or claim it measures position across an area.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: true },
    anonymous: true,

    async handler(input: Input): Promise<Output> {
      const competitors = await client.findPublicCompetitors(input.search, input.limit);
      return { search: input.search, competitors };
    },

    present({ search, competitors }: Output): string {
      if (competitors.length === 0) {
        return `Google returned nothing for "${search}". Try naming the town or city.`;
      }

      const rows = competitors
        .map((rival, index) => {
          const stars = rival.rating ? `${rival.rating} ★` : "—";
          return `| ${index + 1} | ${escapeCell(rival.name)} | ${stars} | ${rival.reviewCount} |`;
        })
        .join("\n");

      // The spread between first and last is the sentence an owner remembers,
      // more than any individual number in the table.
      const counts = competitors.map((rival) => rival.reviewCount);
      const most = Math.max(...counts);
      const fewest = Math.min(...counts);

      return [
        `**Top results for "${escapeCell(search)}"**`,
        "",
        "| # | Business | Rating | Reviews |",
        "| --- | --- | --- | ---: |",
        rows,
        "",
        most > 0 && most !== fewest
          ? `_Review counts run from ${fewest} to ${most}. In local search that gap is usually what separates the top of the list from the bottom._`
          : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
