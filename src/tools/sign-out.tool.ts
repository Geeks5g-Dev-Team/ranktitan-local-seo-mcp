import type { RankTitanClient } from "../ranktitan/client.js";
import type { ToolContext, ToolDefinition } from "../shared/types.js";

const inputSchema = {};

type Input = Record<string, never>;
type Output = { endedSession: boolean; reason: "signed_out" | "api_key" | "already_gone" };

/**
 * Ends the signed-in session, so the next question asks who you are again.
 *
 * It exists because without it there is no way to stop, or to switch accounts:
 * a client holds its token and reuses it, and removing the connector in the UI
 * does not throw that token away. "Sign me out" is the one instruction a person
 * can give that the client cannot ignore.
 *
 * Revoking is only half of it. The other half is that the session is checked on
 * every call rather than only when a token is refreshed — otherwise this tool
 * would answer "done" and the next question would still work for the rest of
 * the hour, which is the kind of answer that teaches people not to trust the
 * product.
 */
export function signOutTool(client: RankTitanClient): ToolDefinition<Input, Output> {
  return {
    name: "sign_out",
    title: "Sign out of Rank Titan",

    description: [
      "Ends this Rank Titan session. Use it when the user asks to sign out, log out,",
      "disconnect, or to switch to a different Rank Titan account.",
      "",
      "After this the user is signed out and will be asked to sign in again the next",
      "time they ask for their own data — which is how they switch accounts.",
    ].join(" "),

    inputSchema,
    quota: { kind: "none" },
    // Changes state, but signing in again undoes it, and ending an ended
    // session is the same as ending it once.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Signing out is something you can always do, including when the session
    // has already gone. Refusing it would be refusing to say what is true.
    anonymous: true,

    async handler(_input: Input, context: ToolContext): Promise<Output> {
      const { caller } = context;

      if (caller.isAnonymous) return { endedSession: false, reason: "already_gone" };

      // An API key is not a session: it is a credential the user pastes and
      // removes themselves, and revoking it here would be deleting something
      // they did not ask to delete.
      if (!caller.grantId) return { endedSession: false, reason: "api_key" };

      const revoked = await client.revokeGrant(caller.userId, caller.grantId);
      return {
        endedSession: revoked,
        reason: revoked ? "signed_out" : "already_gone",
      };
    },

    present({ endedSession, reason }: Output): string {
      if (endedSession) {
        return [
          "Signed out of Rank Titan.",
          "",
          "The next time you ask for your own businesses, rankings or reviews you will be",
          "asked to sign in — pick a different Google account there to switch accounts.",
        ].join("\n");
      }

      if (reason === "api_key") {
        return [
          "This connection uses an API key, not a sign-in, so there is no session to end.",
          "Remove the key from the connector's headers to disconnect it.",
        ].join(" ");
      }

      return "You are already signed out — nothing to end.";
    },
  };
}
