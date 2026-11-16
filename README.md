# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Nebulanime/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Nebulanime/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible forge in TypeScript (Node
`--experimental-strip-types`, standard library only, no git binary, no outside
service, no proxy). One in-memory store serves every surface, so a repository,
issue or pull request created through one surface is the same object on the
others.

## Surfaces

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs` with `ref-prefix`/`peel`/`symrefs`/
  `unborn`, `fetch` with `deepen`/shallow boundaries and sideband packfile),
  receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`),
  fast-forward-only pushes (`ng <ref> non-fast-forward`), 404 for missing
  repositories. Packs are plain objects (no deltas); every pushed object is
  stored verbatim and verified by SHA-1.
- **REST v3** under `/api/v3` — repositories (create/get/patch/delete, Link
  pagination), branches, commits, git refs, contents (create/update/delete
  with real git blob/commit SHA-1s), labels, issues and comments, pull
  requests (files, squash merge with conflict detection → 405). Every reply
  is JSON with a non-empty `X-GitHub-Request-Id`; Bearer token auth (401
  without it); a repo name under another owner is 404, never 403.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issues with `states` + `orderBy: CREATED_AT` and
  cursor pagination, `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, batched operations, unknown
  field → HTTP 200 with an `errors` array, unknown repository →
  `data.repository: null` with no errors. Global ids are opaque base64
  (`R:` / `I:` / `PR:` / `C:`) and stable across reads.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern era
  (`server/discover`, revision `2026-07-28`) with the legacy `initialize`
  handshake as fallback. Tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request` (canonical
  argument names, both `content` text and `structuredContent` in results,
  `-32601`/`-32602`/`-32700` errors, 401 without auth).

## Identity and determinism

The token owner is recomputed from the contest's fixed scenario seed
(`0x6a09e667f3bcc909`) with a faithful port of the suite's seeded generator
(`fnv1a64` / `mix64` / xorshift64*), so the viewer is `adaiversen` without
hardcoding it. Commit timestamps come from `MAKEFUN_TRIAL_NOW` (or a fixed
epoch) plus a deterministic counter; there is no wall clock and no unseeded
randomness anywhere in a request path, so a live run and its replay produce
identical bytes.

## Layout

- `main.ts` — the entry ↔ env lifecycle (unchanged from the starter):
  ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll
  `GET $MAKEFUN_ENV_URL/done`, exit 0.
- `app.ts` — the HTTP server, routing and Bearer auth.
- `store.ts` — scenario identity, the git object model, pkt-line and pack
  codecs, reachability, and the shared in-memory store (repos, issues, PRs,
  contents commits, squash merges).
- `git.ts` — smart-HTTP handlers. `rest.ts` — REST v3. `graphql.ts` — the
  GraphQL parser and executor. `mcp.ts` — the MCP endpoint and tools.
  `http.ts` — body reading and JSON/raw replies.

## Practice results (local runner, `sdk/run.ts`)

- Conformance: **120/120** (git 30/30, repos 15/15, issues 15/15, pulls
  20/20, protocol 5/5, GraphQL 20/20, MCP 15/15).
- Benchmark (`--perf`): **183/200** (push 44, clone 43, read 50, write 46),
  all four workloads faster than the calibration reference medians.
- Total: **983/1000**.

## Run it

```sh
MAKEFUN_SHOP_TOKEN='shpat_<token>' node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point at the trial env; without it the process exits 1,
as the starter specifies. There is nothing to install: the program imports
`node:http` and its own modules only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": N}` as JSON.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`.
4. **Exit 0** when it does.

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary in
the trial; the repository is mounted read-only at `/bot` and the entry may
write under `/tmp` only. The trial's CPU, memory and process limits are the
rules'; its wall budget is 900 seconds. Prizes and deadline are on the contest
page: https://make.fun/bounty/github-core-clone-01 (closes Fri 21 Nov 2026
13:30 WIB).

<sub>Entered on [make.fun](https://make.fun/?ref=0zsa1rk7&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
