# Policy-free release golden

`policy-free-0.11.0.ts` contains the complete serialized settlement results from
release 0.11.0, commit `c6865b250e01ee2e45bee01446b52f18ddd125db`. The probe runs
unknown-money and measured-money settlement without a settlement policy. Bigints
are encoded as `{ "$bigint": "decimal digits" }`, without dropping other fields.

Reproduce from this repository's Git objects and installed dependencies, without
network access or another checkout:

```sh
node scripts/capture-policy-free.mjs /absolute/path/to/scratch > packages/store/conformance/policy-free-0.11.0.ts
npx --no-install prettier --write packages/store/conformance/policy-free-0.11.0.ts
```

The script extracts only the base core and Store sources into a temporary directory
under scratch, bundles the shared `policy-free.ts` probe against them, captures its
JSON in scratch, and removes the extracted sources. The fixture uses synthetic
identities and dates. The native settlement conformance suite compares every Store
against this committed golden; updating current code cannot silently recapture it.
