# Static website and component preview

The preview combines the project home, component and agent pages, prerendered docs, the interactive
registry showcase and the shadcn JSON artifacts. It does not deploy a backend or publish
npm packages. The blocks request the 0.9.0 React and views packages, which await publication;
check registry availability separately from hosting. The server and registry tooling remain
private.

From the repository root, with the pinned Node/npm runtime:

```sh
npm ci
npm run preview:build
```

The helper produces Vercel Build Output API v3 files in `.vercel/output`, with all public
files under `.vercel/output/static`. It preserves `.vercel/project.json` and any local
Vercel environment files. The output is ignored by Git. The root `vercel.json` supplies
the installation and build commands; no functions, middleware, cron or deployment action
are included. See the [Build Output API documentation](https://vercel.com/docs/build-output-api).

| Route                             | Content                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `/`                               | Usagekit project home                                        |
| `/components/`                    | shadcn blocks and headless React hooks                       |
| `/agents/`                        | Local API proxy and agent spend controls                     |
| `/docs/`                          | Existing prerendered checkout documentation                  |
| `/examples/`                      | Style links, block index and origin-derived install commands |
| `/examples/showcase/`             | Every block in every shadcn style, switched in place         |
| `/r/styles/<style>/<block>.json`  | shadcn block with that style baked in                        |
| `/r/radix/<block>.json`           | New York/Radix shadcn block                                  |
| `/r/base/<block>.json`            | Base UI/Vega shadcn block                                    |
| `/r/<block>.json`                 | New York/Radix default alias                                 |
| `/r/registry.json`                | Default registry index                                       |
| `/r/{radix,base}/registry.json`   | Variant registry index                                       |
| `/r/styles/<style>/registry.json` | Registry index for one style                                 |
| `/preview-manifest.json`          | Source revision, dirty state and artifact boundaries         |

The showcase builds from an ignored host prepared by the registry consumer helper; the earlier
`/examples/new-york/`, `/examples/base/` and per-style addresses redirect to it with their
style. Tracked website and consumer sources are not rewritten. The showcase uses the actual
React hooks and all 22 blocks. Metering, budget editing and provider controls use in-memory
fixtures: changes reset on reload, there are no provider calls, and credential inputs are
for demo values only. The registry's host primitive dependencies remain shadcn names;
there is no invented production origin. Copy commands use the current preview's origin.

A configured consumer installs `@usagekit/react`, `@usagekit/views` and their dependencies
from the 0.9.0 cohort that the blocks request once it is published, or reviewed tarballs before
then, as described in [consuming packages](CONSUMING.md). Hosting the JSON does not publish
those dependencies. The public source is <https://github.com/usagekit/usagekit>;
the project website is <https://usagekit.dev>.

For a local static check, use a separate free port:

```sh
python3 -m http.server 5190 --bind 127.0.0.1 --directory .vercel/output/static
```

Open `/examples/` and the showcase, exercise a fixture mutation and reload to confirm
it resets. Check the JSON links and the host-derived install command. The Vercel config
adds explicit directory redirects and serves files without a blanket SPA fallback, so
unknown routes remain 404. The Python server is only a local file server; it does not
emulate Vercel headers or routing configuration.

Building is separate from deployment. Verify the target Vercel project and obtain explicit
deployment authorization. Exact-SHA promotion to main requires separate approval.
A preview can host this static artifact; the production provider-management server still
requires its own authenticated, authorized and durable host integration. A host's
React adoption is verified locally and stays separate from its production metering
integration.
