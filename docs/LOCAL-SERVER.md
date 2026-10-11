# Local server

P2 supports one developer. It stores accounting in SQLite and provider keys in an encrypted vault.
It includes the provider catalog, authenticated local proxy, encrypted vault and reference UI.
Proxy crash recovery preserves unknown exposure; it does not fetch provider evidence or redispatch.
It is a single-owner loopback server, not a hosted multi-user service.

## Install and start

From this checkout, use Node 22.23.1 and npm 10.9.3:

```sh
nvm use
npm ci
npm run build
export PATH="$PWD/node_modules/.bin:$PATH"
usagekit serve
```

The default address is `http://127.0.0.1:4242`. Override with `--port` or loopback `--host`.
Non-loopback binding is refused. `--allow-remote` reports unsupported TLS; it does not expose the service.
The default directory is `$XDG_CONFIG_HOME/usagekit`, or `~/.config/usagekit`.
Use `--config-dir <directory>` for another instance. Use the same directory after restart.
`config.json`, `usage.db`, SQLite side files and `vault.enc` have mode 0600.

The first start prints the local bearer token once. Save it outside shell history in a password manager.
Subsequent starts do not print it. The config stores only its SHA-256 hash.
Startup errors distinguish occupied ports, invalid config and failed vault unlock without printing sensitive details.

One server owns a config directory at a time. The private `.server-lock` directory is acquired
before loading the vault. A live owner rejects a second server; a proven exited owner can be
recovered. Malformed ownership and interrupted recovery fail closed. Inspect those cases locally
instead of removing a live server's lock. Normal shutdown releases ownership.
In a second terminal, read it without echo and export it:

```sh
read -rs USAGEKIT_TOKEN
export USAGEKIT_TOKEN
usagekit token show-path
usagekit usage --json
```

Set `USAGEKIT_URL`, or pass `--url`, when using another port.
`usagekit token rotate --json` returns a new token and immediately invalidates the old token.
Update `USAGEKIT_TOKEN` after rotation. There is no unauthenticated token recovery endpoint.

## Vault and provider connections

Interactive `serve` confirms a new hidden passphrase before creating the vault. Empty input leaves it locked.
Automation supplies `USAGEKIT_VAULT_PASSPHRASE` once, without confirmation. Keep it outside logs and shell history.
The vault uses scrypt and AES-256-GCM. OS keychain integration remains a follow-up.
A locked vault permits accounting and connection listing. It refuses key changes and provider tests.
Restart with the passphrase to unlock. Keep a secure passphrase backup; there is no recovery key.

```sh
read -rs PROVIDER_KEY
export PROVIDER_KEY
usagekit provider add serpapi --connection c1 --secret-env PROVIDER_KEY
unset PROVIDER_KEY
usagekit provider list
usagekit provider test --connection c1
```

Alternatively, pipe the secret into `provider add`; do not pass it as an argument.
Provider tests validate format only. `network: false` means no provider authentication or balance was checked.
`usagekit provider remove --connection c1` removes the stored key, preserving accounting history.
Secret plaintext is absent from responses, logs, SQLite, config and encrypted vault bytes.
An existing connection ID cannot silently change provider; same-provider key rotation remains supported.

## Dashboard controls

Open `/` on the local server and enter its bearer token. The dashboard keeps the token in
tab memory, verifies its administrative binding with the server and shares `MeterProvider`
and `ProviderManagementProvider` across pages. It uses the same Base UI registry blocks as
other applications, with no provider requests on page load.

Connections supports own-key connect, rotation, disconnect, explicit format checks and exact
manual prices. A format check does not authenticate with the provider. Unsupported hosted
wallets, allocation matrices, enable controls and fallback policies are not offered.
Budgets supports existing definitions and new monthly principal or connection limits, including
exact amounts, overage, hard limits and alerts. Usage is preserved when a limit changes.

The administrative provider API has four authenticated routes:

- `GET /providers/management/binding` supplies a persisted host-qualified scope and token revision.
- `POST /providers/management/read` accepts `{query}` and reads retained, content-free evidence.
- `POST /providers/management/commands` accepts `{command,secrets?}` once, with a stable command ID.
- `POST /providers/management/reconcile` accepts the original `{command}`, without credentials.

Connection revisions change on both dashboard and legacy CLI mutations. Provider commands
commit an intent into `usage.db` before touching the encrypted vault, then retain the neutral
result. Repeating the original command returns its stored result. Changing its body under the
same ID is rejected. Credential material never enters the command journal.

If a crash occurs between the vault write and journal completion, the result stays unknown
after restart. The server blocks additional provider mutations, including legacy routes;
reconciliation never retries the write or infers failure from an absent connection. There is
currently no automatic repair for an incomplete administrative intent. Keep the instance for
operator investigation instead of deleting journal rows or resubmitting with a new command ID.

`POST /budgets/reconcile` accepts the original budget definition. Its immutable stored version
proves an exact saved definition or a version conflict, even if newer edits exist. An absent
version leaves the result unknown. Reads and reconciliation perform no provider I/O.

## Budget and cooperating scripts

```sh
usagekit budget set --id monthly --limit 10:requests
usagekit budget list
operation=$(usagekit report reserve --provider serpapi --connection c1 \
  --estimate 1:requests --command-id job-001) || exit $?
# Call the provider only after this command exits 0. Never repeat it on an accounting retry.
usagekit report settle --operation "$operation" --quantity 1:requests \
  --cost 0.0100 --command-id job-001-settle
usagekit usage --window month --group provider,day --unit requests
```

`--cost` is cents, with at most four decimal places; `0.0100` is 100 internal money units.
Quantities accept `amount:unit`; comma-separated estimates cover multiple bounded units.
Reserve returns an operation ID only after obtaining the first dispatch grant.
A replay refuses dispatch and exits 1, even when it finds an existing reserved operation.
The default lease is 60 seconds. `--lease-ms` sets another duration; SDK callers can renew long calls.
`report release --operation <id>` applies only to reservations without dispatch intent, such as SDK-created reservations.
Expired or uncertain dispatched work requires recovery evidence, never release or a repeated provider call.

Pass a stable `--command-id` on retries. Without one, commands generate new UUIDs.
Settle and release save exact request bodies under `<config-dir>/requests/`, mode 0600, before sending.
Keep these files for retries: they preserve receipt timestamps and expected versions across CLI restarts.
A changed payload under the same command ID is a usage error. Request files contain no authentication secrets.
`--occurred-at` supplies the actual UTC event time; otherwise settlement uses the current time.
Every command accepts `--json`. Monetary and quantity integers become decimal strings.
Exit codes: 0 success; 1 denied, exceeded or replayed dispatch; 2 usage error; 3 remote unavailable.
An exceeded result includes `resetsAt`. On transport failure inspect or replay accounting; never repeat the provider call blindly.

Budget scopes: `principal` (default local), `connection`, `group`, `tag`, `access_credential`, `platform_pool`.
Use `--scope` with `--connection`, `--group`, `--tag`, `--credential-kind`/`--credential-id`, or `--pool`.
Budget windows: `month`; `cycle --epoch <id> --from <UTC> --to <UTC>`; `reset --epoch <id> --from <UTC>`.
`budget set` creates the next version. `--allow` (alias `--warn`) admits past the limit with a warning; `--unlimited --unit requests` removes a bound.
`--surface app|programmatic|any` bounds a source group; `--source cli|mcp|api|sdk|proxy|app|worker` bounds exactly one source. CLI reservations are `programmatic` from source `cli`.
`--hard-limit <amount:unit>` requires `--allow` and denies past that amount. Repeat `--alert <percent>` or `--alert <amount:unit>` for up to eight ascending thresholds; each crossing is returned once per window in `alerts`.
`provider add` accepts repeatable `--tag <tag>` (lowercase `[a-z0-9][a-z0-9_.:-]*`, up to 16); `report reserve` snapshots the connection's tags into the reservation.
Usage accepts `--window cycle|reset`, using matching budget windows. Select `--id` when windows differ.
`--group-by` (alias `--group`) accepts `funding_source` and `tag` next to the other dimensions; tag rows repeat an operation once per tag.
Use `--cursor` from the previous JSON usage page; cursor snapshots expire after five minutes.

## Restart and enforcement boundary

SQLite uses WAL, FULL synchronization and one IMMEDIATE transaction per command.
Restart preserves operations, receipts, command replays, reservations and expired leases.
A new worker claims expired work through `Meter.claimForRecovery`, then settles from provider evidence.
Recovery never grants dispatch again. No provider evidence worker runs automatically in P2.
Only undispatched reservations expire: five minutes by default, with an SDK override from 1 ms to one day.
Dispatch after the reservation deadline atomically releases the hold and fails. Replay never extends the deadline or grants another call.
Startup and thirty-second sweeps release overdue `reserved` operations. Admission cleans at most one default batch.
`usagekit report expire --json` runs one maintenance batch; repeat while `hasMore` is true.
Dispatch-intended work never expires into release, even when its dispatch lease expires.
SQLite commands update one operation and its budget counters. Reads use read-only transactions and signed snapshot cursors.
Upgrading a pre-event database invalidates old cursors; restart those usage queries.
The local token is a fully trusted owner credential. Multi-user write permissions require a separate host policy.
Calls bypassing this API remain unmetered. P2 blocks cooperating scripts; routed provider blocking follows in P4.

## Provider catalog (P5)

The server enables the bundled DataForSEO and SerpApi descriptors by default. Embedders may set
`enabledProviders` on `startServer`; disabled providers cannot be recorded. Existing explicit
estimates continue working for uncatalogued integrations.

```sh
usagekit provider add serpapi --connection search --plan starter --secret-env SERPAPI_KEY
usagekit report reserve --connection search --provider serpapi --feature search --json
usagekit provider add serpapi --connection search --secret-env SERPAPI_KEY --tracking search=passthrough
```

The local pricing resolver accepts connections only in the `local` namespace and reports
`fundingSource: "byok"`. Embedded hosts must resolve `{ namespace, connection }` to the actual
connection funding; request funding must match.

`report reserve` can omit `--estimate` for catalogued connections. Repeat `--option key=value`
for pricing options. Explicit estimates still override catalog prices on metered calls.
Free/passthrough outcomes never grant a lease; the reporting CLI exits nonzero so existing
shell scripts cannot mistake them for metered dispatch permission.

`provider add` accepts `--plan` and repeated `--tracking operation=metered|passthrough` flags.
The HTTP connection endpoint accepts the same `plan` and `tracking` fields; unknown plans,
operations and policy values are rejected. Omitted policy fields survive credential rotation;
an empty HTTP `tracking` object resets tracking overrides. Restart preserves the metadata.
The metadata is also in the vault's public connection index, so metering works with a locked
vault; recording requires it unlocked. Local config-directory integrity remains required.

See [contributing providers](CONTRIBUTING-PROVIDERS.md) for `provider record`, its one-call cost
semantics and fixture review. Neither installing nor testing this feature calls a provider.

### Local resource ownership

Vault writes remain owned by connection add/remove and key rotation; startup unlocks, shutdown
locks, and restart reloads. Policy fields share that lifecycle. The SQLite store remains the
sole writer for reservations, dispatch, receipts and counters; the recorder uses Meter only.
Its failed dispatches remain recoverable and the existing reservation sweep only expires work
that was not dispatched. Fixtures have one writer (the recorder), UUID filenames and private
permissions. They persist across restart; no automated cleanup or synchronization is introduced.
This local-only change adds no workflows, production environment variables or migrations.

### Connection price overrides

```sh
usagekit provider add dataforseo --connection research --plan prepaid \
  --price serp.google.organic.live.advanced=0.25:cents --overage false
```

The secret is read from standard input as with other `provider add` calls. `--price` is
repeatable and keyed by catalog operation. `--overage true|false` explicitly selects the
known allowance state. Omitted flags preserve the connection policy during key rotation.
The server resolves manual prices before measured receipt history and catalog list prices.
The HTTP connection endpoint accepts `manualPrices: {}` to clear all overrides.

## Routed provider requests (P6)

The server also accepts `/proxy/<connection-id>/<upstream-path>` with its bearer token.
Use `usagekit serve --providers dataforseo,serpapi` and optionally `--strict-proxy`.
See [local proxy](PROXY.md) for the full request, budget, replay, streaming, recording and
restart contract. Requests routed here are enforced before dispatch; reporting clients still
must honor their own admission results. Traffic sent directly to providers bypasses the proxy.
