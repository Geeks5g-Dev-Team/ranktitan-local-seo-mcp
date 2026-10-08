import { z } from "zod";
import type { RankTitanClient } from "../ranktitan/client.js";
import type { HeatmapScan } from "../ranktitan/models.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";
import { presentScan } from "./get-local-heatmap.tool.js";

const inputSchema = {
  location_id: z
    .string()
    .min(1)
    .describe("The locationId from list_businesses. The same one the scan was started for."),
  keyword: z.string().trim().min(2).describe("The exact keyword the scan was started for."),
};

type Input = { location_id: string; keyword: string };
type Output = { scan: HeatmapScan };

/**
 * Picks up a scan that was still running.
 *
 * It asks for the business and the keyword rather than a report id, because
 * an id is the one thing that goes wrong here: while a scan is running the
 * newest report for a location is still the PREVIOUS one, so an id handed out
 * mid-flight reads back somebody else's search. Business plus keyword always
 * names the thing the user actually asked about.
 *
 * Free: the token was spent when the grid ran. Charging to look at a result
 * already paid for would punish the user for the scan being slow.
 */
export function getHeatmapResultTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "get_heatmap_result",
    title: "Read a ranking heatmap",

    description: [
      "Fetches the results of a ranking grid: average position across the area, how many",
      "points hold strong coverage, and the competitors that hold the rest.",
      "",
      "Use it after get_local_heatmap said a scan was still running. Pass the same",
      "locationId and the same keyword. If the scan has not finished it says so.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    annotations: { readOnlyHint: true, openWorldHint: true },

    async handler(input: Input, context: ToolContext): Promise<Output> {
      const business = await client.assertOwnership(context.caller.userId, input.location_id);
      const scan = await client.heatmapResult({
        locationId: business.locationId,
        keyword: input.keyword,
      });
      if (!scan) throw new Error(`No heatmap report for ${business.name} yet.`);
      return { scan };
    },

    present({ scan }: Output): string {
      return presentScan(scan);
    },
  };
}
