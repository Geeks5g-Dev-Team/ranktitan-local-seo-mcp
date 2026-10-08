import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { KeywordRanking } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

const inputSchema = {
  location_id: z.string().min(1).describe("The locationId from list_businesses. Never invent one."),
};

type Input = { location_id: string };
type Output = {
  businessName: string;
  rankings: KeywordRanking[];
};

/**
 * Reads rankings already stored by Rank Titan. It does NOT run a new grid.
 *
 * That distinction is what makes this tool shippable today: a live heatmap run
 * depends on the heatmap service, this one only reads what the ranking cron has
 * already measured. Same data the customer sees in the dashboard.
 */
export function getKeywordRankingsTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "get_keyword_rankings",
    title: "Get measured keyword rankings",

    description: [
      "Returns the local map-pack position Rank Titan last measured for each tracked",
      "keyword of a business, where 1 is the best possible position and 20 means the",
      "business did not appear anywhere in the search grid.",
      "",
      "Use this when the user asks how their business is ranking, which keywords are",
      "working, or how visible they are on Google Maps. Call list_businesses first if",
      "you do not already have the locationId.",
      "",
      "These are stored measurements, not a fresh scan, and the answer says when",
      "they were last taken — repeat that date rather than implying they are live.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    // Stored measurements, read from Rank Titan. No scan is run.
    annotations: { readOnlyHint: true, openWorldHint: false },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      // Resolve ownership before touching any ranking data: the locationId came
      // from a model and must never be trusted on its face.
      const business = await client.assertOwnership(context.caller.userId, input.location_id);
      const rankings = await client.getKeywordRankings(business.locationId);

      return { businessName: business.name, rankings };
    },

    present({ businessName, rankings }: Output): string {
      if (rankings.length === 0) {
        return `**${businessName}** has no keywords being tracked yet.`;
      }

      const measured = rankings.filter((r) => r.measured);
      const unmeasured = rankings.filter((r) => !r.measured);

      // Nothing measured at all is a real and common state — a business whose
      // ranking job has never succeeded. Falling through to the table below
      // would print "0 keywords measured" above an empty table, which reads as
      // "this business has no keywords" when it has a full set of them and no
      // position for any. Said plainly instead, naming them, because the
      // keywords are the part the owner recognises.
      if (measured.length === 0) {
        const names = unmeasured.map((ranking) => `- ${ranking.keyword}`).join("\n");
        return [
          `**${businessName}** tracks ${unmeasured.length} keyword${unmeasured.length === 1 ? "" : "s"}, ` +
            `but ${unmeasured.length === 1 ? "it has" : "none of them has"} a measured position yet.`,
          "",
          names,
          "",
          "_Their ranking has not completed, so there is nothing to report on visibility._",
        ].join("\n");
      }

      // Best (lowest) first; keywords that were measured but found nowhere sort
      // last among the measured ones.
      const sorted = [...measured].sort((a, b) => (a.score ?? 99) - (b.score ?? 99));

      // Stated once, from the most recent measurement, rather than per row: a
      // date in every row is noise, but no date at all lets a month-old
      // position read as today's.
      const asOf = latestDate(measured);

      const rows = sorted
        .map((ranking) => {
          const position = ranking.score === null ? "—" : ranking.score.toFixed(1);
          const note = ranking.score !== null && ranking.score >= 20 ? "not in the grid" : "";
          return `| ${escapeCell(ranking.keyword)} | ${position} | ${note} |`;
        })
        .join("\n");

      const inTop3 = sorted.filter((r) => r.score !== null && r.score <= 3).length;

      const lines = [
        `**${businessName}** — ${measured.length} keyword${measured.length === 1 ? "" : "s"} measured` +
          (asOf ? `, last on ${asOf}` : ""),
        inTop3 > 0 ? `${inTop3} of them average a top-3 position.` : "",
        "",
        "| Keyword | Avg. position | |",
        "| --- | ---: | --- |",
        rows,
        "",
        "_Lower is better: 1 means the business shows first across the search grid._",
        "_Stored measurements, not a live scan._",
      ];

      if (unmeasured.length > 0) {
        // Worth surfacing rather than hiding: these are the ones sitting at the
        // placeholder score because their ranking attempt failed, which is a real
        // state customers hit and would otherwise read as "position 20".
        lines.push(
          "",
          `⚠️ ${unmeasured.length} keyword${unmeasured.length === 1 ? " is" : "s are"} still waiting to be measured and ${unmeasured.length === 1 ? "has" : "have"} no position yet.`,
        );
      }

      return lines.filter((line) => line !== "").join("\n");
    },
  };
}

/** The most recent measurement in a set, as a plain date, or null. */
function latestDate(rankings: KeywordRanking[]): string | null {
  const times = rankings
    .map((ranking) => (ranking.measuredAt ? Date.parse(ranking.measuredAt) : NaN))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString().slice(0, 10);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
