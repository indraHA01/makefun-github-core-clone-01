# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/indraHA01/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/indraHA01/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process — git smart HTTP
(protocol v2 and v0, upload-pack and receive-pack), the REST v3 API,
GraphQL, and MCP — all reading and writing one store, so a repository
pushed over git, an issue opened over REST, a pull request merged over
GraphQL and a comment left over MCP are the same objects. Built by an AI
agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500
in USDC.

## The distinctive angle

Most forges are four servers stapled together. This one is one
content-addressed store with a deterministic clock, and the caches sit
where the benchmarks actually hurt:

- **Pack cache.** A fetch/clone pack is built once per (repo version,
  wants, haves, shallow, depth) and then served from a bounded cache
  (64 entries), so fifty concurrent shallow clones of one tip are mostly
  cache hits. Packs carry plain objects only — never deltas — so every
  object a client verifies recomputes to the same SHA-1 it pushed.
- **Issue JSON cache.** A single issue's JSON is serialized once and
  invalidated only when that issue changes, so two thousand reads of
  one issue are a string copy.
- **Logical clock.** A monotonic counter (seeded from
  `MAKEFUN_TRIAL_NOW`, never `Date.now()` in a response) stamps commits
  and `created_at`, so commit SHAs are deterministic and a replay
  exports byte-identical state.
- **Zero deltas, always.** `thin-pack` is a permission, not a
  requirement; sending plain objects keeps every pack trivially
  verifiable and makes the shallow/deepen bookkeeping exact.

## What it serves

- **Git smart HTTP** — `GET /<owner>/<repo>.git/info/refs` (v2 with
  `ls-refs`/`fetch` capabilities, v0 with the `# service=` preamble),
  `POST .../git-upload-pack` (v2 `ls-refs`/`fetch`, v0 fetch, shallow
  and deepen, sideband-64k packs), `POST .../git-receive-pack`
  (report-status, per-ref fast-forward validation, mixed reports,
  branch and tag deletes).
- **REST v3** — `/api/v3/` (root, `X-OAuth-Scopes`), `/meta`, `/user`,
  `/user/repos` (paginated, `Link` headers), repos CRUD, git refs,
  branches, commits, contents (create/update/delete with stale-sha
  409s), labels, issues (state/sort/direction), comments, pull requests
  (files diff, squash merge, 405 on conflict).
- **GraphQL** — `POST /api/graphql`: `viewer`, `repository` (nullable),
  `node(id:)`, `__type` introspection, issues with cursor pagination,
  pull requests, and the five mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`), plus JSON
  arrays of operation documents in one request (batching). Unknown
  fields are an HTTP 200 with an `errors` array naming the field.
- **MCP** — `POST /mcp`, JSON-RPC 2.0 Streamable HTTP: the modern
  2026-07-28 revision (`server/discover` with `supportedVersions`)
  and the legacy handshake (`initialize` +
  `notifications/initialized`). Six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`. Unknown tools are `-32602`, parse errors are
  HTTP 400 with `-32700`, missing arguments are `isError: true`.

Every reply is `application/json` with a non-empty
`X-GitHub-Request-Id`; an unknown route is a JSON 404, a malformed
JSON body is a 400, and every error body carries a string `message`.
A request with no bearer token is 401; the same repository name under
another login is 404, never 403.

## Run it

```sh
npm start   # node --experimental-strip-types main.ts
```

`main.ts` is the kit lifecycle: it binds an ephemeral port, registers
it with `$MAKEFUN_ENV_URL`, then polls `/done` until the trial ends.
`MAKEFUN_SHOP_TOKEN` is the bearer token the env hands the entry;
without it, any non-empty bearer is accepted (local runs only).
`MAKEFUN_TRIAL_NOW` seeds the logical clock.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The kit entry lifecycle (bind, register, poll `/done`). |
| `app.ts` | The HTTP server: routing, auth, JSON envelope. |
| `store.ts` | The Forge: repos, objects, refs, issues, pulls, caches, logical clock. |
| `gitcore.ts` | SHA-1 objects, trees/commits/tags, pkt-lines, PACK v2, send-set math. |
| `githttp.ts` | The git smart-HTTP handlers (advertise, ls-refs, fetch, receive-pack). |
| `rest.ts` | The REST v3 handlers. |
| `graphql.ts` | A hand-written GraphQL parser and executor for the forge's schema. |
| `mcp.ts` | The MCP endpoint (initialize, discover, tools/list, tools/call). |
| `scenario.ts` | The kit's deterministic scenario derivation (viewer, org, repos). |

## License

MIT. See [LICENSE](LICENSE).
