# Usagekit project website

`packages/site` is the private, Apache-2.0 website workspace. It introduces the
project, demonstrates the metering runtime and the React layer, and provides a
getting-started guide.

From the repository root:

```sh
npm run site:build
npm run site:preview
# http://127.0.0.1:5180
```

For development use `npm run site:dev`. All three scripts delegate to the site
workspace. The preview binds only to loopback and requires port 5180 to be free.

## Pages and audiences

The site has one page per audience, each prerendered with its own title and
description in `build.mjs`:

- `/` explains usagekit for everyone: the live console, the two ways to use it,
  the reserve, dispatch and settle lifecycle, storage adapters, the public runtime
  packages, an example host integration and a general FAQ, including how usagekit
  differs from usage-based billing.
- `/components/` is for product engineers: shadcn blocks and headless React hooks
  for usage, costs and budgets, as live previews and code.
- `/agents/` is for people running AI agents against paid APIs: the local proxy,
  encrypted key vault, CLI budgets that answer 429 before metered dispatch, the usage
  dashboard and an agents FAQ. The local server, proxy and CLI are described as
  repository workspaces, and only the bundled DataForSEO and SerpApi descriptors
  are named. Known free operations and configured passthrough calls are counted
  without spend enforcement.
- `/docs/` covers installation, storage adapters, the published React packages and checkout
  workflow, hooks, components, budget editing, provider management and
  architecture.
- `/examples/` links the showcase in every Radix and Base UI style and the public registry.
  This route is supplied by `npm run preview:build`, alongside the four site pages.

Titles and descriptions follow measured search demand (for example "usage
metering", "shadcn blocks", "api proxy") and avoid rate-limiting wording.

## Demonstrations

The homepage and the components page each run one real in-memory Store and Meter
(`@usagekit/store`, `@usagekit/meter`) wrapped in one `MeterProvider`; every
section reads it through the actual hooks. No provider calls, credentials or
charges are involved; the console is labeled as a sample workspace.

- **Console.** A $25.00 monthly spend budget that blocks at the limit and alerts
  at 80%, seeded with whole-cent October history ($18.12). Sending a request
  reserves $1.50, takes the single dispatch grant and settles an exact receipt;
  after about five requests the next one is blocked before dispatch. A simulated
  timeout settles with an unknown cost, so its reservation stays held and it
  appears as pending work until it is settled from late evidence.
- **Blocks.** Previews of seven registry blocks read the same Meter as the rest of
  the page. A code tab shows the registry composition and local `npx shadcn add`
  commands.
- **Storage.** One transaction per command, the adapter tables, the latest
  operation record read with `meter.getOperation`, and the adapters (in-memory on
  npm; SQLite and Durable Objects in the repository; published Postgres storage with
  pg and Prisma drivers; other databases through the Store interface and conformance suite).
- **Agents.** An illustration of the local dashboard and two illustrative proxy
  responses, next to the real CLI commands.

Money is displayed as exact decimal text (`$19.3074`), never rounded; digits past
the cent are set lighter. `seed-views.test.ts` proves that the prerendered seed
views equal the live views of the seeded Meter and replays the sample story.

The site uses self-hosted Plausible analytics: `index.html` loads one deferred script
for the `usagekit.dev` domain, and that is the only external script. There are no
network data dependencies, fabricated testimonials or unpublished-package installation
claims. Mona Sans and Geist Mono are bundled from
their `@fontsource-variable` packages (OFL-1.1); there are no external font
requests. Runtime packages link to their npm pages. Source links point to
<https://github.com/usagekit/usagekit>; the website is <https://usagekit.dev>.
All seven packages, including React, views and Postgres storage, are published at 0.8.0;
installation commands pin that cohort.
Registry tooling, SQLite and Cloudflare adapters remain repository workspaces.

## Build and accessibility

The Vite client build goes to `packages/site/dist/site`. `build.mjs` prerenders
the home, components, agents and docs pages as HTML with React server rendering,
then hydrates them in the browser. Each page contains its headings and content
without running JavaScript. `LICENSE`, `NOTICE`, the local favicon and `robots.txt` ship with the
artifact. TypeScript declarations remain separately under `dist/types`.

Light and dark themes follow the system until a visitor chooses one; an inline
script applies the stored choice before first paint and keeps `theme-color` in
sync. The only entrance motion is the hero meter filling once; other motion
answers a visitor's action. `prefers-reduced-motion` removes it, and forced-colors
mode keeps meter bars and certainty marks visible. Navigation, tabs, accordions,
copy controls, code scrolling and every console control are keyboard accessible,
with a skip link, explicit labels, one polite live region for sample commands and
40px touch targets on small screens.

The artifact is suitable for a static host serving each page directory through
its `index.html` (`/components/`, `/agents/` and `/docs/`). Every page carries its canonical
link and `og:url` at `https://usagekit.dev`; `sitemap.xml` lists those pages and is linked from
`robots.txt`. The hosting artifact with interactive examples and registry JSON is described
in [preview deployment](PREVIEW.md). A deployment needs its own reviewed target and
authorization. No social image is supplied yet.

## Review evidence

Strict TypeScript, Prettier, the workspace boundary check, the site unit tests
and the production build pass. Browser review used agent-browser at 1440, 1280,
1024, 768, 390 and 360px in light and dark, with overflow probes at each width.
The full console story (sends until the alert crosses and the next request is
blocked, three requests in flight, timeout, settlement from evidence, reset) kept
the hero, blocks, hooks readout and storage record consistent. Axe audits covered
both pages in both themes, including the pending and blocked states.
