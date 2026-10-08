# Local SEO Rank Tracker & Heatmaps

An MCP server for [RankTitan.ai](https://ranktitan.ai). It lets you do local SEO
work — Google Business Profile audits, map-pack rank lookups, competitor
checks and review replies — without leaving Claude or ChatGPT.

**Two things work with no account at all:** auditing any business on Google and
seeing who ranks for a local search. Everything that reads _your_ data asks you
to sign in first.

## Connect it

```
https://mcp.ranktitan.ai/mcp
```

In Claude, add it as a custom connector with that URL and choose **"Sign in
when needed"** for authentication and **"Register automatically"** for the
OAuth client. No headers, no keys to paste: you sign in with the same Google
account you use for Rank Titan, and only when you first ask for your own data.

If your client cannot do OAuth, a Rank Titan API key also works, sent as
`Authorization: Bearer <key>` or in an `x-account-key` header.

## Tools

| Tool                     | What it does                                                                              | Account          |
| ------------------------ | ----------------------------------------------------------------------------------------- | ---------------- |
| `audit_public_business`  | Scores any business's Google profile and names what to fix first                          | not needed       |
| `get_local_competitors`  | Who actually ranks for a local search, with ratings and review counts                     | not needed       |
| `list_businesses`        | The locations your account manages, with their ids                                        | sign-in          |
| `get_keyword_rankings`   | Map-pack positions Rank Titan measured, and when                                          | sign-in          |
| `audit_business_profile` | A full audit of a profile you own                                                         | sign-in          |
| `fetch_pending_reviews`  | Reviews still waiting for a reply                                                         | sign-in          |
| `post_review_reply`      | Publishes a reply to Google                                                               | sign-in, metered |
| `get_local_heatmap`      | Runs a 19-point ranking grid for one keyword and shows where you win and where you vanish | sign-in, metered |
| `get_heatmap_result`     | Reads a grid by its report id                                                             | sign-in          |
| `sign_out`               | Ends the session — also how you switch accounts                                           | —                |

Rankings are **stored measurements, not a live scan**, and every answer says
when they were last taken.

## Limits

Reading your own data is unlimited, and so is replying to a review from a chat —
what is sold is automation, Rank Titan replying on its own.

Ranking grids are metered, because each one costs real money to run: one free
scan per account, then the answer says so and carries the link to raise it.

## Privacy

This server holds no database. It reads Rank Titan through one internal bridge
and nothing else. Any tool given a location id checks that the location belongs
to the caller before returning anything — a business is never returned because
a model named it. Sign-in is Google's, so no password ever reaches us, and
signing out revokes the session within seconds rather than when a token
happens to expire.

---

## Development

```bash
cp .env.example .env     # RANKTITAN_API_URL, RANKTITAN_INTERNAL_API_KEY, RANKTITAN_API_KEY
npm install
npm run dev
```

Tests boot the server against a stubbed Rank Titan and speak real JSON-RPC to
it. Run what CI runs before pushing — a formatting failure turns the quality
job red and **skips the deploy**:

```bash
npm run typecheck && npm run format:check && npm run build
node test/smoke.mjs && node test/oauth.mjs
```

Against the live server, with the official client:

```bash
npx @modelcontextprotocol/inspector --cli https://mcp.ranktitan.ai/mcp --method tools/list
```

### Shape of the code

```
src/
├── main.ts              composition root — the only place that picks implementations
├── transport/           HTTP + MCP wiring, rate limiting
├── auth/                API keys and the OAuth provider
├── tools/               one file per tool, plus the registry
├── quota/               allowance enforcement and its storage
├── ranktitan/           the only path to Rank Titan data
└── shared/              config, logger, the contracts everything is written against
```

Adding a tool is one file in `tools/` and one line in `registry.ts`. Quota,
ownership and error handling are applied by the registry wrapper, so a tool
never repeats them.

### Rules this code holds to

- **No database.** All data comes through `RankTitanClient`, over the internal
  bridge. If this service is compromised, the blast radius is those endpoints.
- **Never trust an id from the model.** Any tool taking a `location_id` calls
  `assertOwnership` first. Returning a business because the caller named it is
  how these integrations leak customer data.
- **Narrow mappers.** `ranktitan/models.ts` lists exactly what may reach a
  model, so a field added upstream never leaks into a chat by accident.
- **A 200 is success to a client.** Anything that needs the user to act — sign
  in, upgrade — says so with the status code, not only in prose.
- **Config fails at boot**, not on a user's first call.
- **Nothing secret is logged.** Credentials go through `redact()`.

### Status

Running in production: OAuth 2.1 with PKCE, dynamic client registration, and
quota enforcement.

The ranking grid runs for a location in your own account: the exact listing
name and coordinates come from Rank Titan's own copy, so there is nothing to
type and nothing to get wrong. Running one for a business nobody has connected
is not possible yet — the scan can be started, but there is no way to follow
its result.

Not built: an image of the grid. The heatmap service exposes no map image, so
rendering one means building it from the points — the public report page is
linked instead.

