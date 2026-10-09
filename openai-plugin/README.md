# ChatGPT plugin package

What OpenAI's directory takes: a folder, zipped, that points at the MCP server
rather than containing it. The server itself lives one directory up and is
deployed separately — this is only the wrapper the directory lists.

    plugin.json        listing text, category, URLs, example prompts
    mcp.json           points at https://mcp.ranktitan.ai/mcp
    assets/icon.png    512x512, square
    assets/logo.png    1024x1024, square

To build the upload:

    cd openai-plugin && zip -r ../ranktitan-local-seo-plugin.zip . -x '.*'

Then upload it at https://platform.openai.com/plugins.

Changing the server needs no new ZIP — the package names a URL, and the server
behind it is deployed on its own. Re-upload only when this listing text, the
icons or the server URL change.

## Limits the upload is checked against

The portal validates the package and stops at the first error, so a value that
looks merely long is a rejected upload. The first submission failed five of
these at once. Full list: https://developers.openai.com/plugins/deploy/submission-errors

| Field               | Rule                                                  |
| ------------------- | ----------------------------------------------------- |
| `displayName`       | ≤ 30 characters, one line                              |
| `shortDescription`  | ≤ 30 characters — a subtitle, not a sentence           |
| `longDescription`   | ≤ 4,000 characters                                     |
| `developerName`     | ≤ 80 characters                                        |
| `defaultPrompt`     | at most **3**, each ≤ 128 chars, unique, no `@mentions`|
| all four URLs       | absolute `https://` — `mailto:` is rejected            |
| `logo`, `composerIcon` | square, 48–4096 px, ≤ 5 MiB                         |
| `brandColor`        | six-digit hex, ≥ 2:1 against **both** white and `#212121` |
| `screenshots`       | only allowed if the tool scan reports a UI template    |

`brandColor` is the trap: the brand navy `#101722` reads 18:1 against white but
1.1:1 against the dark background, so it fails. `#b89d6d` is the Rank Titan gold
(`--gold`) darkened enough to clear both sides — 2.6:1 and 6.2:1.

Beyond the ZIP, the portal itself asks for: domain verification at
`/.well-known/openai-apps-challenge`, five positive and three negative test
cases, release notes, reviewer demo credentials (the server uses OAuth), and a
demo recording. Every tool must also declare `readOnlyHint`, `destructiveHint`
and `openWorldHint` — enforced in `src/shared/types.ts` and asserted by the
smoke test against the `tools/list` response.
