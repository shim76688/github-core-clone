[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shim76688/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shim76688/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible forge in one Node process

This repository holds a self-contained reimplementation of the core of
GitHub, written for the make.fun contest of the same name. A single Node
process, with no dependencies and no `git` binary involved, serves four
faces of GitHub from one shared in-memory store:

- **git smart HTTP** — ref advertisement, protocol v2 `ls-refs`/`fetch`
  and v0 fetch, plus `receive-pack` with fast-forward checks, so a real
  git client can clone, pull and push.
- **REST v3** under `/api/v3` — repositories, branches, commits and the
  git data API, contents, issues, comments, labels, and pull requests
  including three-way merges.
- **GraphQL v4** at `/api/graphql` — queries, mutations, cursor
  connections, fragments and introspection, in the shapes `gh` and
  `github-mcp-server` emit, with node ids that match the REST ids.
- **MCP** at `/mcp` — the Model Context Protocol endpoint (discovery,
  `tools/list`, `tools/call`) backed by the same store.

State lives in a content-addressed object store in memory; timestamps
are derived from a monotone sequence, so replaying the same request
stream reproduces the same state byte for byte.

## Running it

The contest harness runs the entry as `node /bot/main.ts` on Node 22,
which strips the TypeScript types itself. Locally, the same thing is:

```sh
MAKEFUN_ENV_URL=http://store:8080 node --experimental-strip-types main.ts
```

There is nothing to install: the program imports only its own modules.

`main.ts` is the bootstrap. It reads the companion service's origin
from `MAKEFUN_ENV_URL` (and exits 1 at once when the variable is
absent), starts the forge on an ephemeral port, announces that port
with `POST /register`, then polls `GET /done` until the harness side
reports the trial finished, at which point it closes the server and
exits 0. Failed announcements and polls are retried under a 30-second
deadline with a backoff that grows from 250 ms to a 2 s ceiling.

`app.ts` builds the HTTP server and routes each request to its surface.
A `GET /healthz` probe answers `{"ok":true}` without credentials;
every other surface expects the harness's shop token as a Bearer token
(or as the password of a Basic credential) whenever one is configured.

## Layout

| File | Responsibility |
| --- | --- |
| `main.ts` | Process lifecycle: bind, register, wait, exit |
| `app.ts` | HTTP server and routing across the four surfaces |
| `store.ts` | The shared store: git objects, repos, issues, pull requests |
| `git.ts` | The smart-HTTP protocol: pkt-lines, packfiles, fetch and push |
| `rest.ts` | The REST v3 resources |
| `graphql.ts` | A small GraphQL parser and executor for the v4 surface |
| `mcp.ts` | The MCP endpoint and its tools |

## Licence

MIT — see `LICENSE`.
