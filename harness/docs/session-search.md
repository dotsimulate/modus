---
title: Session Search
audience: user
lastUpdated: 2026-09-11
covers: harness/session-search.ts harness/db.ts harness/index.ts harness/sdk/client.ts harness/sdk/cli.ts harness/ui/src/widgets/session-history.widget.tsx harness/ui/src/components/sidebar/SearchResults.tsx harness/ui/src/session-search-request.ts
---

# Session Search

Search conversations from the session history panel. Typing a query replaces the
grouped session list with ranked full-text hits, and clearing it restores the
list. Search uses the current backend's local SQLite index and the selected
project's visibility scope. The same search is available in the browser and
installed desktop app, with no extra plugin, provider, external search service,
or configuration required.

This searches what was *said*. It is not the list filter it replaced: matching is
over indexed message text and titles, not over the project, agent, model or path
labels on each row. Use the panel's project and agent views to narrow by those.

## Words and phrases

| Input | Matches |
|---|---|
| `auth refactor` | Both word prefixes, in any order, anywhere in the same session's indexed messages or title. |
| `"access token"` | Adjacent words in that order within one indexed message or title. |
| `auth "access token"` | The word prefix and the phrase, possibly in different messages. |
| `refac` | Words beginning with that prefix, such as `refactor`. |

Spaces, tabs and newlines separate words. Matching is case-insensitive and uses
SQLite's `porter unicode61` tokenizer, including its accent handling and English
stemming. A quoted phrase matches token order, not byte-for-byte spelling;
punctuation is a separator. Quoted phrases do not add a trailing prefix wildcard.
An unfinished quote is treated as a phrase through the end of the input so search
continues to work while typing.

All terms are required. Duplicate terms are ignored. FTS operators such as `OR`,
`NOT` and `NEAR` are treated as ordinary words. Punctuation-only and blank queries
return no search hits. Queries accept up to 4096 characters and 32 distinct words
or phrases; exceeding either limit produces a visible error.

## Sorting and opening results

- **Relevance** is the default: text ranking with a recency bonus. Title matches
  receive more weight than message text.
- **Latest** sorts by the session's last conversation activity, newest first.
- **Oldest** uses the same activity timestamp, oldest first.

Sorting applies to all matching sessions before taking a page. Results show one
row per session, a matching text excerpt, project/agent labels and relative time.
Hover over the time for its full date. Activate a result with the mouse or by
tabbing to it and pressing Enter or Space to open that conversation.

The panel loads 20 sessions at a time; **Show more** fetches the next page.
Changing the words, sort or selected project starts over. Clear the search or
press Escape in the input to return to the session list. While a query is up the
view and sort controls are replaced by the search sort, because neither applies
to hits. Failed requests display an error and **Retry**. Superseded requests
cannot overwrite the current search.

## Scope and indexed content

Search includes session titles/previews and indexed user prompts, assistant text
and result summaries. It is not a filesystem search and does not search arbitrary
tool output or attachments. Archived sessions and sessions tagged `internal` are
excluded. Results respect the selected user profile's project paths and agent
visibility. Legacy sessions with no user-profile assignment can still match
within that scope. Different Vaults/backends have separate databases and indexes.

The index is maintained as events and titles are written. Existing installed
databases use the same index with the updated query and ranking logic; this change
does not require a manual reindex or data migration. Install a release containing
these changes to update an installed app. Editing a source checkout does not update
an existing installation.

## API and SDK

`GET /api/sessions/search` accepts `q`, `sort` (`relevance`, `latest`, `oldest`),
`limit` (default 20, bounded to 1–200), `offset` (default 0), and `userProfile`.
Unknown sort values fall back to relevance. Non-finite limits default to 20;
finite limits are truncated and clamped. Invalid or negative offsets become 0.
Oversized queries return HTTP 400. Normal authentication applies.

The response remains a `SearchHit[]`: `session_id`, `preview`, `profile`, `model`,
`cwd`, `last_message_at` (Unix milliseconds), `total_cost_usd`, and `snippet`.
Snippets are plain text, not HTML. Equal sort values use session ID as a stable
tie-breaker. Offset pages are not a snapshot: new activity between requests can
move results; the panel deduplicates already displayed sessions.

```ts
const hits = await client.searchSessions('auth "access token"', {
  sort: "latest",
  limit: 20,
  offset: 0,
  userProfile: "example",
});
```

The SDK CLI accepts the same options:

```sh
bun harness/sdk/cli.ts search auth refactor --sort latest --limit 20 --offset 0 --user-profile example
```

Server-side callers retain `searchSessions(query, limit, scope)` and may pass
`{ sort, offset }` as a fourth argument. A `scope.role` of `user` or `assistant`
requires every term to occur in that role's indexed rows.

## Source verification

From `harness/`, run:

```sh
bun test tests/session-search.test.ts tests/sdk/client.search.test.ts tests/ui/sessionSearch.test.ts
```

These exercise isolated SQLite matching/scope/order/pagination, SDK request
encoding and request cancellation. Desktop packaging stages `harness/docs/`
and the built UI through `desktop/stage-managed-backend.ts`, so this guide ships
in the app's Docs page as `session-search`.
