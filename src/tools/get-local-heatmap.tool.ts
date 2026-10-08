import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { HeatmapScan } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

/**
 * How long to wait before handing back a link instead of an answer.
 *
 * A scan is dominated by DataForSEO polling and runs from tens of seconds to
 * minutes. Holding a chat open for that is worse than saying "it is running,
 * here is where to watch it" — so this waits only as long as a person will
 * sit still for, then gets out of the way.
 */
const PATIENCE_MS = 45_000;
const POLL_EVERY_MS = 5_000;

const inputSchema = {
  location_id: z.string().min(1).describe("The locationId from list_businesses. Never invent one."),
  keyword: z
    .string()
    .trim()
    .min(2)
    .describe('One search phrase a customer would type, like "emergency plumber".'),
};

type Input = { location_id: string; keyword: string };

type Output = { scan: HeatmapScan };

/**
 * The tool the whole integration was asked for.
 *
 * A 7x7 grid over the area, one search, and the business's position at each
 * point — the thing an agency owner pays for, run from inside a chat.
 *
 * Note the grid is 19 measured points, not 49: a CIRCLE grid is the disc
 * inscribed in the square. That is the heatmap service's own geometry, worth
 * knowing before anyone reports the count as a bug.
 */
export function getLocalHeatmapTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "get_local_heatmap",
    title: "Generate a local ranking heatmap",

    description: [
      "Runs a live ranking grid: searches one keyword from 19 points spread across the",
      "area around a business and reports where it ranks at each one. This is what",
      "reveals that a business is first at its own door and invisible three miles away.",
      "",
      "Use it when someone asks how visible they are on Google Maps across a city, where",
      "they rank for a search, or wants to see a heatmap or geo-grid.",
      "",
      "The business name must match its Google listing exactly. Call audit_public_business",
      "first if you are unsure of the exact name or the coordinates.",
      "",
      "A scan takes from under a minute to several; if it is still running you get a link",
      "to watch it and can fetch the numbers later with get_heatmap_result.",
    ].join(" "),

    inputSchema,
    quota: { kind: "metered", counter: "heatmaps", cost: 1 },
    // Not read-only: it starts real work and spends a token, so a client
    // should be able to tell the user before running it. Nothing is undone,
    // so not destructive — two scans just cost two tokens.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      // Ownership before anything is spent: a grid costs a real token, and a
      // locationId from a model is not evidence that it belongs to the caller.
      const business = await client.assertOwnership(context.caller.userId, input.location_id);

      const started = await client.startHeatmap({
        locationId: business.locationId,
        keyword: input.keyword,
      });
      if (!started) throw new Error("The heatmap service did not accept the scan.");

      // Poll for as long as a person will wait, then hand back the link. The
      // token is spent either way: the grid is running whether or not we
      // stayed to watch it finish.
      const deadline = Date.now() + PATIENCE_MS;
      const read = () =>
        client.heatmapResult({
          locationId: business.locationId,
          previousReportId: started.previousReportId,
          keyword: input.keyword,
        });

      let scan = await read();
      while ((scan === null || scan.state === "pending") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
        scan = await read();
      }

      return {
        scan: scan ?? {
          state: "pending",
          reportId: started.previousReportId ?? "",
          reportUrl: "",
          keyword: input.keyword,
          businessName: business.name,
          averageRank: null,
          gridPoints: 0,
          highRelevance: 0,
          mediumRelevance: 0,
          lowRelevance: 0,
          competitors: [],
        },
      };
    },

    present({ scan }: Output): string {
      return presentScan(scan);
    },
  };
}

/**
 * Shared with get_heatmap_result so a finished scan reads the same however it
 * was reached.
 */
export function presentScan(scan: HeatmapScan): string {
  const title = `**${scan.businessName ?? "Business"}** — "${scan.keyword ?? "keyword"}"`;

  if (scan.state === "pending") {
    return [
      title,
      "",
      "The scan is running. It usually takes a minute or two.",
      "",
      `Watch it here: ${scan.reportUrl}`,
      "",
      "Or ask me again in a minute and I will fetch it with get_heatmap_result,",
      "using this business and the same keyword.",
    ].join("\n");
  }

  if (scan.gridPoints === 0) {
    // Almost always the name: the grid matches on exact equality with the
    // Google listing, so "Joe's Plumbing" and "Joe's Plumbing LLC" are
    // different businesses as far as it is concerned.
    return [
      title,
      "",
      "The grid ran but found nothing to report for that keyword. Check it is the",
      "phrase you meant, and that the business name matches its Google listing.",
      "",
      scan.reportUrl,
    ].join("\n");
  }

  const share = (count: number) => Math.round((count / scan.gridPoints) * 100);

  const lines = [
    title,
    "",
    "| | |",
    "| --- | ---: |",
    `| Points measured | ${scan.gridPoints} |`,
    `| Average position | ${scan.averageRank !== null ? scan.averageRank.toFixed(1) : "—"} |`,
    `| Strong coverage | ${scan.highRelevance} (${share(scan.highRelevance)}%) |`,
    `| Weak or absent | ${scan.mediumRelevance + scan.lowRelevance} (${share(scan.mediumRelevance + scan.lowRelevance)}%) |`,
  ];

  if (scan.competitors.length > 0) {
    // The three strongest the scan actually saw. This is the part an owner
    // reads twice: it names who is taking the space they are not holding.
    lines.push(
      "",
      "**Who else holds this search**",
      "",
      "| Business | Rating | Reviews |",
      "| --- | ---: | ---: |",
      ...scan.competitors
        .slice(0, 3)
        .map(
          (rival) =>
            `| ${rival.name.replace(/\|/g, "\\|")} | ${rival.rating !== null ? `${rival.rating} ★` : "—"} | ${rival.reviews ?? "—"} |`,
        ),
    );
  }

  const weak = scan.mediumRelevance + scan.lowRelevance;
  if (weak > 0) {
    lines.push(
      "",
      `It is weak or missing from ${weak} of the ${scan.gridPoints} points. That is the area a competitor owns.`,
    );
  }

  lines.push("", `See the map: ${scan.reportUrl}`);
  return lines.join("\n");
}
