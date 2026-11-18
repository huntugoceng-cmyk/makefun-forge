# makefun-forge

A standalone, GitHub-compatible git forge in one Node 22 process and one store: no
UI, no outside service, no git binary.

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (ls-refs,
  fetch, shallow) and receive-pack v0 with `report-status`, `side-band-64k` and
  `delete-refs`, fast-forward checks per ref.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels,
  issues, comments and pull requests, with GitHub's status codes, pagination and
  JSON error bodies.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server`
  send, plus introspection for `Issue`, `PullRequest` and `Repository`.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP: discover/initialize,
  `tools/list` and `tools/call`, acting on the same store REST reads.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry lifecycle: bind an ephemeral port, POST it to
`$MAKEFUN_ENV_URL/register`, poll `/done`, exit 0. `app.ts` builds the server and
`src/` holds the store, the git codec, the protocol surfaces and the REST routes.

## Layout

- `src/git.ts` — object hashing, loose objects, trees, commits, packfile read/write
- `src/githttp.ts` — pkt-line framing, v2 upload-pack, v0 receive-pack
- `src/store.ts` — repositories, refs, issues, labels, pull requests
- `src/rest.ts` — REST v3 routes and JSON shapes
- `src/graphql.ts` — document parser and resolver
- `src/mcp.ts` — MCP server
- `tools/smoke.ts` — the local surface test (`npm run smoke`)

MIT licensed.
