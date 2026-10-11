# usagekit

Local metering for provider usage and costs, with required admin views of usage,
costs and application credits. Both BYOK and platform-funded keys are in scope.
Host A uses Postgres and Prisma. Host B adds team-owned connections.
Host C targets Cloudflare D1. A local server shares the embedded Meter contract.

**Release lines: 0.8.0 is published. The 0.9.0 source cohort adds pricing formulas, authorized `Meter.quote` and host-priced credits calls to `core`, `meter` and `providers`, and draft rebase signals to `@usagekit/react` for the host composition blocks; `store`, `views` and `store-postgres` move to 0.9.0 in lockstep. See [what 0.9.0 adds](docs/CONSUMING.md#what-090-adds).**
Licensed under Apache-2.0. `@usagekit/core`, `store`, `meter`, `providers`, `views`, `react` and `store-postgres` 0.8.0 are published on registry.npmjs.org.
The 0.9.0 release allow-list contains `core`, `store`, `meter`, `providers`, `views`, `react` and `store-postgres`. Other workspaces remain private. See [consuming packages](docs/CONSUMING.md) for registry availability and candidate validation. Candidate publication needs exact-source owner approval.

[Project website](https://usagekit.dev) · [Source](https://github.com/usagekit/usagekit) · [Issues](https://github.com/usagekit/usagekit/issues) · [Roadmap](docs/ROADMAP.md)

## Start here

Use Node **22.23.1** from `.nvmrc` and npm **10.9.3** as the baseline.
Supported ranges are Node `>=22.23.1 <23` and npm `>=10.9.3 <11`.
The lockfile pins dependencies. `@types/node` is pinned to the Node 22 line.

```sh
nvm use
npm ci
npm run check
npm run build
export PATH="$PWD/node_modules/.bin:$PATH"
usagekit serve
```

See [local server operation](docs/LOCAL-SERVER.md) for tokens, the vault, budgets, scripts and restart recovery.
See [billing imports](docs/BILLING-IMPORTS.md) for P8 evidence, revisions and reconciliation.
Consumers upgrading custom Stores or Meters must follow the [0.5.0 migration guide](docs/MIGRATING-0.5.md).

`npm ci` installs local hooks through `prepare`. Use `npm run setup` if scripts were disabled.
Hooks prefer the pinned NVM binary. Otherwise PATH must satisfy the supported range.

| Command                  | Purpose                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `npm run check`          | Runtime, workspace/privacy checks, formatting, TypeScript, unit and policy tests                               |
| `npm run format`         | Format source and documentation, excluding local ADRs                                                          |
| `npm run typecheck`      | Check references and emit declarations into ignored `dist/`                                                    |
| `npm run build`          | Build every workspace and the local server UI                                                                  |
| `npm run check:consumer` | Install the seven local tarballs without registry credentials; check declarations, exports and React rendering |
| `npm run registry:build` | Build the shadcn registry into `packages/registry/dist/r`                                                      |
| `npm run test:postgres`  | Real Postgres conformance, atomicity, scaling and restart checks in an owned fixture                           |
| `npm run site:dev`       | Run the project website locally at `http://127.0.0.1:5180`                                                     |
| `npm run site:build`     | Build and prerender the static project website and documentation                                               |
| `npm test`               | Policy tests in disposable local repositories                                                                  |
| `npm run setup`          | Install repository-local hooks and Git defaults                                                                |

## Working agreement

This README is the single source of workflow rules. Keep one root README.
`AGENTS.md` points agents here. Do not create competing package instructions.

1. Work on task branches such as `feat/meter-contract`. Never develop on `main` or detached HEAD.
2. Preserve unrelated work. Use dedicated worktrees for concurrent tasks; `.wt/` is ignored.
   Keep local reports and scratch artifacts under ignored `.local/` inside this repository, never in the parent `Projects` directory.
   Bootstrap stays on `chore/bootstrap-workspace` for review.
3. Author Usagekit commits as `Michał Śnieżyński <27588547+msniezynski@users.noreply.github.com>`.
   Use short, clear Conventional Commit titles. Do not add `Co-Authored-By` or tool/AI attribution to commits, descriptions or review text.
4. Run `npm run check` before handoff. Review the staged diff before committing.
5. Integrate only by squash through `npm run approve:main`. Rebase task branches; never create merge commits.
   Main contains stable, reviewed, explicitly owner-approved versions only.
6. Passing checks or implementing work does not authorize promotion, push, publication, deployment or release.
   Agents must never supply owner approval themselves.
7. Publication of the seven allow-listed packages runs only through `npm run release`; the packages are public after the approved release.
   Public access follows the P3 exit gate. GitHub hosting still requires an explicit repository target.
   Do not publish a candidate before separate exact-SHA and version approval. Do not publish other workspaces or deploy services without separate authorization.
8. Never bypass hooks. Fix the cause of a failure. Local guards are not a tamper-proof security boundary.

The approved bootstrap is on local `main`. New work stays on task branches for review.
For an initial bootstrap commit, the workflow is:

```sh
git add .
git commit -m "chore(repo): scaffold local workspace"
```

Only after separate approval of the exact committed version:

```sh
git rev-parse HEAD
npm run approve:main -- --approved-sha <full-reviewed-head-sha> --subject "feat: describe the approved result"
```

Promotion requires a clean task branch, active hooks and passing full checks.
Present the proposed squash title when requesting owner approval. `--subject` accepts one Conventional Commit title.
It creates one squash commit with the reviewed tree and previous main as its sole parent.
The first approval creates a root commit. The current task branch stays checked out.
Rebase and obtain new approval if main advances. Nothing is pushed by promotion.
Expired local approval markers are removed. Active markers report their path and remaining lifetime.

The command cannot verify human intent. `--approved-sha` asserts prior owner approval.
Future hosting requires separate authorization and server-side branch protection.
No-remote and no-push rules are owner instructions, not technical hook restrictions.

## Automated package releases

The `release.yml` GitHub Actions workflow publishes the seven-package cohort through
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). Configure each
package's npm Trusted Publisher as GitHub Actions, owner `usagekit`, repository
`usagekit`, workflow `release.yml`, environment `npm-publish`, with **Allow npm publish**.
The GitHub environment permits deployments from the `main` branch only. It does not
require a separate reviewer for every package.

After exact-SHA and version owner approval, promote through `npm run approve:main`,
push main, and require its latest CI run to pass. Create and push a signed version tag
on that exact main using an authorized key in `.github/release-allowed-signers`.
Run **Publish packages** from main with the approved full SHA and version. Start with
`dry_run=true`; choose `false` only for the approved publication. A live run requires
the signed tag, unchanged approved main, successful Postgres/Cloudflare/consumer CI
and absence of every target package version. An existing or partial cohort stops for
inspection instead of being republished.

The workflow uses baseline npm 10.9.3 for installation and all repository checks.
Only the OIDC publishing subprocess uses isolated npm 11.16.0, satisfying npm's
Trusted Publishing requirement without changing the development runtime. It calls
the existing `npm run release -- --trusted-publishing` process; hooks, package audits
and all release checks remain active. npm receives short-lived workflow credentials,
so no npm token, passkey or per-package browser confirmation is needed.

After publication, `npm run check:consumer -- --registry` waits up to 15 minutes for
registry propagation, verifies manifests and compiled contents against the checkout,
then installs anonymously outside the monorepo and checks declarations and React SSR.

A new npm Trusted Publisher remains pending until its first successful OIDC publish.
npm requires that first publish within two days of configuration; otherwise recreate
the expired connection. A dry-run does not validate npm's trust relationship or
authorize another version.

## Git hooks

Hooks live in `.githooks/`, installed as local `core.hooksPath`.

| Hook                    | Behavior                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `pre-commit`            | Requires a task branch and no merge state; runs runtime, workspace, format and type checks      |
| `commit-msg`            | Requires Conventional Commits and rejects coauthor attribution                                  |
| `pre-merge-commit`      | Rejects ordinary merge commits                                                                  |
| `reference-transaction` | Protects main and rejects merge history or forbidden commit messages                            |
| `post-commit`           | Writes last-commit metadata inside `.git/usagekit/`; never modifies source or contacts services |
| `post-checkout`         | Copies the ignored `docs/adr/private-terms.txt` from the main checkout into a new worktree      |

Pre-commit permits partial staging and untracked files. It does not run policy tests.
It checks current files; the privacy guard also scans indexed content. Review staged changes independently.
Full tests run through `npm run check` and during approved main promotion.
`npm run test:unit` runs Vitest; `npm run test:unit:watch` watches changes.
`npx vitest run --coverage` enforces 90% lines for reference Store and Meter, and 85% for SQLite, HTTP, client, server, proxy, views and react.
Conformance runs unchanged against memory, embedded Meter, SQLite and the remote Meter over HTTP.
The adapter converts typed validation failures to Store exceptions; other outcomes stay unchanged.
Memory and remote-memory skip `durable` and `rollingWindows`. SQLite and Cloudflare skip only `rollingWindows`. Each run reports its skips.
There is no pre-push hook. The release allow-list and publish guard restrict publication to the seven explicitly allow-listed packages. Release preparation does not grant publication authority.

## Workspace layout

`usagekit.workspace.json` defines the existing inventory and allowed dependencies.

| Workspace                 | Current contents                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`           | Meter interface, exact quantities and domain DTO types                                                                           |
| `packages/store`          | Atomic commands, in-memory store and factory-based conformance                                                                   |
| `packages/meter`          | Embedded Meter with validation, policy and authorized reads                                                                      |
| `packages/store-sqlite`   | Durable transactions, migrations and admission projection                                                                        |
| `packages/store-postgres` | Postgres transactions, explicit migrations, pg/Prisma drivers and host transaction composition; see [Postgres](docs/POSTGRES.md) |
| `packages/store-d1`       | Cloudflare Store with authoritative Durable Object SQLite storage; see [Cloudflare](docs/CLOUDFLARE.md)                          |
| `packages/http`           | Web handlers, strict Valibot wire schemas and generated OpenAPI                                                                  |
| `packages/client`         | Remote Meter with explicit accounting retries                                                                                    |
| `packages/server`         | Loopback API, token auth, encrypted vault and the UI at `/`                                                                      |
| `packages/proxy`          | Authenticated provider routing, budget enforcement, streamed receipts and crash recovery                                         |
| `packages/cli`            | Serve, provider, budget, reporting and usage commands                                                                            |
| `packages/providers`      | Provider catalog, fixture conformance and wrapper-boundary lint rule                                                             |
| `packages/views`          | View models over the Meter: usage, budgets, header, coverage                                                                     |
| `packages/react`          | React hooks and `MeterProvider` over the view models                                                                             |
| `packages/registry`       | shadcn blocks for Radix and Base UI in every shadcn style, see [UI](docs/UI.md)                                                  |
| `packages/site`           | Static project website, React examples and getting-started documentation, see [site](docs/SITE.md)                               |

Future packages are listed in the [plan](docs/PLAN.md#4-package-grid), without placeholder directories.
Host schema mappings stay in host repositories. Shared adapters provide mechanics only.
The npm organization is `usagekit`. Registry authentication belongs outside consumer repositories.

Web projects extend `tsconfig.base.json`; Node projects extend `tsconfig.node.json`.
Checks reject unknown directories, dependency cycles and imports bypassing package boundaries.
The local terms file `docs/adr/private-terms.txt` protects private names in indexed and scanned project files.
A line `term allow: packages/site/ docs/SITE.md` permits that term only under the listed paths; a trailing slash allows a directory.
Without that ignored file, checks print `private-terms check skipped` and continue.
Tracked ADR files remain forbidden even when the terms file is absent.

## Design direction for review

The owner agreed to own metering/admin composition, existing host credit authorities and optional downstream export.
The [plan](docs/PLAN.md) defines delivery gates. Detailed architecture remains proposed.

- Some connections belong to groups; principal is a trusted host projection.
- Windows include calendar month, provider cycle, rolling and since-reset epochs.
- Paid wrappers are only part of the provider call inventory.
- Each adapter proves atomic commands without callback locks, including shared budgets and reservations.
- Unknown is not zero. Timeouts do not justify releasing possible charges.
- Certainty is separate from lifecycle state.
- Operation identity differs from correlation identity. Paid retries and accounting replays differ.
- Exact amounts respect Decimal(10,4), Decimal(18,6) and Decimal(12,4) adapter bounds.
- BYOK and platform funding retain separate cost owners and customer charges.
- Accounting is content-free. Every credit balance has one authority, composed into authorized admin views.
- Only the first dispatch grant may call the provider. Replay and lease expiry never grant it again.
  Recovery claims lease-free work with fencing and settles from evidence.
  Undispatched reservations expire after five minutes by default; atomic cleanup restores headroom without releasing intended dispatches.
- Query scope is not authorization. Access comes from verified server context.
  Budgets are constraints; ledgers are balance authorities.
  Caller credential and provider secret version are two different identities.

## Local architecture decisions

Draft ADRs are deliberately **ignored** under `docs/adr/`. They remain visible on
this machine but do not travel in Git, commits, clones or future releases. Do not
force-add them. Essential accepted workflow rules stay in this tracked README so
the repository does not depend on files another developer cannot obtain. The portable
design proposal is `docs/PLAN.md`; it is not ignored. ADR details explain that plan
locally and must stay consistent with it.

Start with [the local ADR index](docs/adr/0000-index.md). It distinguishes requested
repository rules from architecture proposals still awaiting review, and links the
three-consumer validation. The ignore list otherwise covers dependencies, generated
output, environment files, OS metadata and local worktrees. Source, lockfile, hooks,
tests and build configuration belong in Git.

The root [LICENSE](LICENSE) and [NOTICE](NOTICE) ship with each published package.
Live release requires clean main, a verified signed version tag, passing checks and tarball inspection.
`npm run release -- --dry-run` verifies a clean task branch without publishing or asserting that tag and registry gates passed.
