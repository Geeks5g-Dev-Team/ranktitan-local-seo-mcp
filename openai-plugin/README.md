# ChatGPT plugin package

What OpenAI's directory takes: a folder, zipped, that points at the MCP server
rather than containing it. The server itself lives one directory up and is
deployed separately — this is only the wrapper the directory lists.

    plugin.json      listing text, category, URLs, example prompts
    mcp.json         points at https://mcp.ranktitan.ai/mcp
    assets/icon.png  512x512
    assets/logo.png  1024x316

To build the upload:

    cd openai-plugin && zip -r ../ranktitan-local-seo-plugin.zip . -x '.*'

Then upload it at https://platform.openai.com/plugins.

Changing the server needs no new ZIP — the package names a URL, and the server
behind it is deployed on its own. Re-upload only when this listing text, the
icons or the server URL change.
