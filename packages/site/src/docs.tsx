import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import {
  ArrowUpRight,
  FileText,
  Info,
  Lightbulb,
  Link as LinkIcon,
  ShieldCheck,
} from "lucide-react";
import { Code, Install } from "./code.js";
import {
  installPackages,
  npmPackage,
  publishedPackages,
  providerHooks,
  readHooks,
  reactPackages,
  registryBlocks,
  runtimeVersion,
} from "./content.js";

/** Section ids are public deep links (/docs/#hooks); keep them stable. */
const sections = [
  { id: "getting-started", label: "Install the runtime" },
  { id: "packages", label: "Published packages" },
  { id: "storage", label: "Storage adapters" },
  { id: "checkout", label: "React installation" },
  { id: "local-server", label: "Local server" },
  { id: "hooks", label: "Headless hooks" },
  { id: "components", label: "Components" },
  { id: "budget-editing", label: "Budget editing" },
  { id: "providers", label: "Providers" },
  { id: "architecture", label: "Architecture" },
] as const;
type SectionId = (typeof sections)[number]["id"];
const firstSection: SectionId = "getting-started";
const lastSection: SectionId = "architecture";
/** Matches the CSS breakpoint where the chip bar becomes the sticky sidebar. */
const sidebarQuery = "(min-width: 1100px)";
/** The reading line sits this far below the sticky chrome, inside a section reached by a link. */
const readingOffset = 56;

const checkoutCommands = `nvm use\nnpm ci\nnpm run build\nnpm run registry:build`;
const serveCommands = `# Terminal 1, from the repository root after the checkout build:
export PATH="$PWD/node_modules/.bin:$PATH"
usagekit serve

# Terminal 2: the token printed once by the first start, then a key and a limit.
export PATH="$PWD/node_modules/.bin:$PATH"
read -rs USAGEKIT_TOKEN && export USAGEKIT_TOKEN
read -rs PROVIDER_KEY && export PROVIDER_KEY
usagekit provider add serpapi --connection c1 --secret-env PROVIDER_KEY
unset PROVIDER_KEY
usagekit budget set --id agent --scope connection --connection c1 \\
  --limit 500:requests --alert 80`;
const proxyCommand = `curl --fail-with-body \\
  -H "Authorization: Bearer $USAGEKIT_TOKEN" \\
  -H "Idempotency-Key: search-job-001" \\
  "http://127.0.0.1:4242/proxy/c1/search.json?q=example&engine=google"`;
const showcaseCommands = `node packages/registry/consumers/prepare.mjs\n# Run the Vite command printed by the script.`;
const registryCommands = `# In the Usagekit checkout:
npm run registry:build

# In your configured consumer app, with local UI packages available:
R=/absolute/path/to/usagekit/packages/registry/dist
npx shadcn add $R/r/radix/budget-manager-panel.json
npx shadcn add $R/r/base/usage-summary-cards.json`;
const hooksSample = `import { MeterProvider, useUsageSummary } from "@usagekit/react";

// meter, verifiedAccess and verifiedScope come from your host.
<MeterProvider meter={meter} access={verifiedAccess}>
  <Overview />
</MeterProvider>

function Overview() {
  const { data, state, error, refresh } = useUsageSummary({
    scope: verifiedScope,
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
    units: ["requests", "tokens", "customer_cents"],
  });

  return renderYourDesign({ data, state, error, refresh });
}`;
const writerSample = `import type { BudgetWriter } from "@usagekit/react";

const budgetWriter: BudgetWriter = {
  save: saveAuthorizedBudget,
  reconcile: reconcileAuthorizedBudget,
};

<MeterProvider
  meter={meter}
  access={verifiedAccess}
  budgetWriter={budgetWriter}
>
  {children}
</MeterProvider>`;
const providerSample = `import {
  ProviderManagementProvider,
  useProviderConnections,
} from "@usagekit/react";

// Stable host adapter and identity verified by your application.
<ProviderManagementProvider port={providerPort} binding={verifiedBinding}>
  <Connections />
</ProviderManagementProvider>

function Connections() {
  const { data, state, refresh } = useProviderConnections();
  return renderConnections({ data, state, refresh });
}`;
const conformanceSample = `import { runStoreConformance } from "@usagekit/store/conformance";
// Illustrative: resolves { store, clock, budgets, close, restart }.
import { createPostgresFixture } from "./postgres-fixture.js";

// The values the SQLite adapter declares. Declare what yours guarantees.
runStoreConformance(createPostgresFixture, {
  durable: true, // restart() must reopen the same database
  rollingWindows: false, // reported as a skipped guarantee
  maxMoneyUnits: 2n ** 63n - 1n,
  maxQuantityScale: 18,
});`;

const layers = [
  ["Runtime", "The Meter contract, exact quantities, atomic accounting, admission and receipts."],
  ["Views", "Pure authorized models of usage, costs, budgets, coverage and exceptions."],
  ["React", "Shared reads, explicit states and host-owned administrative mutations."],
  ["Registry", "Copyable blocks composed into your application's pages."],
] as const;
const sourceDocs = [
  "docs/PLAN.md",
  "docs/UI.md",
  "docs/BILLING-IMPORTS.md",
  "docs/LOCAL-SERVER.md",
] as const;

type Follow = (event: MouseEvent<HTMLAnchorElement>, id: SectionId) => void;

/** Inline code: identifiers, file paths and commands inside prose. Short phrases never break. */
function C({ children }: { children: string }) {
  const keep = children.includes(" ") && children.length <= 24;
  return <code className={keep ? "docs-c docs-c-keep" : "docs-c"}>{children}</code>;
}

function Section({
  id,
  title,
  onFollow,
  children,
}: {
  id: SectionId;
  title: string;
  onFollow: Follow;
  children: ReactNode;
}) {
  return (
    <section id={id} className="docs-section">
      <div className="docs-section-head">
        <h2 className="docs-h2">{title}</h2>
        <a className="docs-anchor" href={`#${id}`} onClick={(event) => onFollow(event, id)}>
          <LinkIcon size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">Link to {title}</span>
        </a>
      </div>
      {children}
    </section>
  );
}

function Note({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="docs-note docs-block" role="note">
      {icon}
      <div>
        <p className="docs-note-title">{title}</p>
        <p className="docs-note-text">{children}</p>
      </div>
    </div>
  );
}

function Chips({ items, labelledBy }: { items: readonly string[]; labelledBy: string }) {
  return (
    <ul className="docs-chips docs-block" role="list" aria-labelledby={labelledBy}>
      {items.map((item) => (
        <li key={item} className="docs-chip">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Published durable storage and the remaining repository adapters. */
function Adapters() {
  const adapters: { name: string; where: string; entry: string; text: ReactNode }[] = [
    {
      name: "In-memory",
      where: "On npm",
      entry: "createMemoryStore({ clock, budgets })",
      text: (
        <>
          From <C>@usagekit/store</C>. The reference rules, for tests and demos. Not durable; the
          sample on the home page runs on it.
        </>
      ),
    },
    {
      name: "SQLite",
      where: "Repository, not on npm",
      entry: "createSqliteStore({ path, clock })",
      text: (
        <>
          Workspace <C>packages/store-sqlite</C>. WAL journal, <C>synchronous = FULL</C> and one{" "}
          <C>BEGIN IMMEDIATE</C> transaction per command. It backs the local server,{" "}
          <C>usagekit serve</C>; a restart keeps operations, receipts, command replays, reservations
          and expired leases.
        </>
      ),
    },
    {
      name: "Cloudflare Durable Objects",
      where: "Repository, not on npm",
      entry: "createDurableObjectStore({ storage: ctx.storage, clock })",
      text: (
        <>
          Workspace <C>packages/store-d1</C>. Every command runs inside{" "}
          <C>storage.transactionSync</C> on SQLite-backed Durable Object storage. Route all
          principals of a namespace to one object with <C>getByName(namespace)</C>: shared budgets
          need one serial authority. It does not write to D1.
        </>
      ),
    },
    {
      name: "Postgres",
      where: "On npm",
      entry: 'import { createPostgresStore } from "@usagekit/store-postgres"',
      text: (
        <>
          Durable accounting through pg or Prisma. Run <C>migratePostgresStore</C> explicitly before
          starting the application; runtime creation never applies DDL. Use{" "}
          <C>createTransactionBoundStore</C> when accounting must commit with a host ledger. See{" "}
          <a href="https://github.com/usagekit/usagekit/blob/main/docs/POSTGRES.md">
            the Postgres guide
          </a>
          .
        </>
      ),
    },
    {
      name: "Any transactional database",
      where: "Your repository",
      entry: 'import type { Store } from "@usagekit/store"',
      text: <>Implement the interface and prove it with the conformance suite below.</>,
    },
  ];
  return (
    <dl className="docs-adapters docs-block">
      {adapters.map(({ name, where, entry, text }) => (
        <div key={name} className="docs-adapter">
          <dt className="docs-adapter-name">{name}</dt>
          <dd className="docs-adapter-where">{where}</dd>
          <dd className="docs-adapter-entry">
            <code>{entry}</code>
          </dd>
          <dd className="docs-adapter-text">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The section crossing a reading line just below the sticky chrome is active; between sections,
 * the last one that started above the line. Once the end of the page shows, the last section is.
 * A click holds its section until the smooth scroll settles, so the nav does not flicker.
 */
function useActiveSection(nav: RefObject<HTMLElement | null>, end: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState<SectionId | null>(null);
  const follow = useRef<((id: SectionId) => void) | null>(null);
  useEffect(() => {
    const targets = sections.map(({ id }) => document.getElementById(id));
    const sentinel = end.current;
    if (typeof IntersectionObserver !== "function" || !sentinel) return;
    if (!targets.every((target): target is HTMLElement => target !== null)) return;
    const crossing = new Set<string>();
    let lineTop = 0;
    let atEnd = false;
    let held: SectionId | null = null;
    let idle = 0;
    const pick = () => {
      if (held) return;
      let next: SectionId = firstSection;
      const crossed = sections.find(({ id }) => crossing.has(id));
      if (atEnd) next = lastSection;
      else if (crossed) next = crossed.id;
      else
        sections.forEach(({ id }, index) => {
          if ((targets[index]?.getBoundingClientRect().top ?? Infinity) <= lineTop) next = id;
        });
      setActive(next);
    };
    const release = () => {
      held = null;
      pick();
    };
    follow.current = (id) => {
      held = id;
      setActive(id);
      window.clearTimeout(idle);
      idle = window.setTimeout(release, 400);
    };
    const onScroll = () => {
      if (!held) return;
      window.clearTimeout(idle);
      idle = window.setTimeout(release, 160);
    };
    let line: IntersectionObserver | null = null;
    const observeLine = () => {
      line?.disconnect();
      crossing.clear();
      const header =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 60;
      // Below 1100px the chip bar sticks under the header and covers the top of the page too.
      const bar = window.matchMedia(sidebarQuery).matches ? 0 : (nav.current?.offsetHeight ?? 0);
      const top = Math.round(header + bar + readingOffset);
      const bottom = Math.max(0, window.innerHeight - top - 2);
      lineTop = top;
      line = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) crossing.add(entry.target.id);
            else crossing.delete(entry.target.id);
          }
          pick();
        },
        { rootMargin: `-${top}px 0px -${bottom}px 0px` },
      );
      for (const target of targets) line.observe(target);
    };
    const endObserver = new IntersectionObserver(([entry]) => {
      atEnd = entry?.isIntersecting ?? false;
      pick();
    });
    endObserver.observe(sentinel);
    observeLine();
    let resized = 0;
    const onResize = () => {
      window.clearTimeout(resized);
      resized = window.setTimeout(observeLine, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    // A client-rendered page cannot be scrolled to its fragment before the sections exist.
    const linked = targets.find((target) => `#${target.id}` === window.location.hash);
    if (linked && window.scrollY === 0 && linked.getBoundingClientRect().top > 160)
      linked.scrollIntoView({ block: "start", behavior: "instant" });
    return () => {
      line?.disconnect();
      endObserver.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(idle);
      window.clearTimeout(resized);
      follow.current = null;
    };
  }, [nav, end]);
  return { active, follow };
}

/** Places the sidebar indicator on the active link and keeps the active chip in view. */
function useNavPosition(list: RefObject<HTMLOListElement | null>, active: SectionId | null) {
  useEffect(() => {
    const element = list.current;
    if (!element || !active) return;
    const place = (smooth: boolean) => {
      const link = element.querySelector<HTMLAnchorElement>(`a[href="#${active}"]`);
      if (!link) return;
      element.style.setProperty("--docs-indicator-y", `${link.offsetTop}px`);
      element.style.setProperty("--docs-indicator-h", `${link.offsetHeight}px`);
      // Chip bar: center the active chip only when it is not fully in view.
      const inset = parseFloat(getComputedStyle(element).paddingLeft) || 0;
      const start = link.offsetLeft - inset;
      const finish = link.offsetLeft + link.offsetWidth + inset;
      const view = element.scrollLeft + element.clientWidth;
      if (
        element.scrollWidth > element.clientWidth + 1 &&
        (start < element.scrollLeft || finish > view)
      ) {
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        element.scrollTo({
          left: Math.max(0, link.offsetLeft - (element.clientWidth - link.offsetWidth) / 2),
          behavior: smooth && !still ? "smooth" : "auto",
        });
      }
    };
    // The first placement jumps; later ones slide once the indicator is ready.
    const ready = element.dataset.indicator === "ready";
    place(ready);
    let frame = 0;
    if (!ready) {
      element.dataset.indicator = "placed";
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          element.dataset.indicator = "ready";
        });
      });
    }
    const onResize = () => place(false);
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [list, active]);
}

export function Docs() {
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const { active, follow } = useActiveSection(nav, end);
  useNavPosition(list, active);
  const onFollow: Follow = (event, id) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    follow.current?.(id);
  };
  return (
    <main id="main" className="docs">
      <div className="container docs-shell">
        <header className="docs-intro">
          <h1 className="docs-title">Get started with Usagekit</h1>
          <p className="docs-lede">
            Use the metering runtime on its own, or add views, hooks and a UI that fits your
            product.
          </p>
        </header>

        <nav className="docs-nav" ref={nav} aria-labelledby="docs-nav-label">
          <p className="docs-nav-label" id="docs-nav-label">
            On this page
          </p>
          <ol className="docs-nav-list" ref={list} role="list">
            {sections.map(({ id, label }) => (
              <li key={id}>
                <a
                  className="docs-nav-link"
                  href={`#${id}`}
                  aria-current={active === id ? "true" : undefined}
                  onClick={(event) => onFollow(event, id)}
                >
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="docs-content">
          <Section id="getting-started" title="Install the runtime" onFollow={onFollow}>
            <p>
              Choose the layer you need. All seven packages are published on npm at{" "}
              <strong>{runtimeVersion}</strong>: the runtime, headless views, React hooks and
              durable Postgres storage. Release {runtimeVersion} adds <C>ProviderRate.fallback</C>{" "}
              to the views package for the dollar rate editor. Start with the runtime below.
            </p>
            <div className="docs-block">
              <Install packages={installPackages} label="Install the runtime" />
            </div>
            <Note
              icon={<Lightbulb size={16} strokeWidth={1.75} aria-hidden="true" />}
              title="Start with the runtime. Add UI when you need it."
            >
              A backend-only integration needs no React, registry or CSS dependencies.
            </Note>
          </Section>

          <Section id="packages" title="Published packages" onFollow={onFollow}>
            <ul className="docs-packages docs-block" role="list">
              {publishedPackages.map(({ name, description }) => (
                <li key={name}>
                  <a className="docs-package" href={npmPackage(name)}>
                    <span className="docs-package-name">
                      @usagekit/{name}
                      <span className="sr-only"> on npm</span>
                    </span>
                    <span className="docs-package-text">{description}</span>
                    <ArrowUpRight
                      className="docs-package-icon"
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </a>
                </li>
              ))}
            </ul>
            <p>
              Custom Stores and Meters upgrading to {runtimeVersion} should follow{" "}
              <C>docs/MIGRATING-0.5.md</C> in the checkout.
            </p>
          </Section>

          <Section id="storage" title="Storage adapters" onFollow={onFollow}>
            <p>
              The Meter validates input and resolves policy; it never writes rows itself. Its{" "}
              <C>Store</C> executes each accounting command atomically and re-checks everything that
              depends on concurrent state inside that command: operation state and version, lease
              ownership, budget headroom including outstanding reservations, and command replay
              identity. Expected rejections come back as typed outcomes, not exceptions.
            </p>
            <p>
              In the durable adapters, everything one command writes commits or rolls back together:
              the operation with its receipts and measurements, budget usage, the idempotency
              journal, alert crossings and the event history that readers page from. There are no
              callback locks and no external writes inside the transaction.
            </p>
            <ul className="docs-list docs-block" role="list">
              <li>
                Commands on an operation carry <C>expectedVersion</C>: reserve creates version 1,
                and dispatch intent and settlement each bump it. A stale version is a{" "}
                <C>version_conflict</C>, never a silent overwrite.
              </li>
              <li>
                An identical command returns its stored result with <C>replayed: true</C> and writes
                nothing new. The same command id with a different payload is a conflict, and reserve
                deduplicates by operation id.
              </li>
              <li>
                Money is a bigint in ten-thousandths of a cent, and quantities are integers with an
                explicit scale. Nothing passes through floating point.
              </li>
            </ul>
            <h3 className="docs-h3">Adapters</h3>
            <Adapters />
            <h3 className="docs-h3">Conformance suite</h3>
            <p>
              <C>@usagekit/store/conformance</C> on npm exports <C>runStoreConformance</C> and{" "}
              <C>runStoreScalingConformance</C>. Both run in vitest, so add vitest 5 and fast-check
              4 as dev dependencies. The same suite runs unchanged against the in-memory Store, the
              embedded Meter, SQLite, Postgres, the remote Meter over HTTP and the Cloudflare
              adapter.
            </p>
            <p>
              Capabilities state what an adapter guarantees: <C>durable</C>, <C>rollingWindows</C>,{" "}
              <C>maxMoneyUnits</C> and <C>maxQuantityScale</C>. A capability you declare false is
              reported as skipped, never as passed.
            </p>
            <Code lang="tsx" title="postgres.conformance.test.ts" className="docs-block">
              {conformanceSample}
            </Code>
            <p>
              For SQL adapters, <C>runStoreScalingConformance</C> reads statement and row counters.
              With 5,000 stored operations, reserve, dispatch intent and settle must do exactly the
              work they do on an empty ledger: on SQLite, 25 statements, 8 rows read and 12 changed.
            </p>
          </Section>

          <Section id="checkout" title="React installation" onFollow={onFollow}>
            <Note
              icon={<Info size={16} strokeWidth={1.75} aria-hidden="true" />}
              title="Keep the runtime and UI on the same release cohort."
            >
              <C>@usagekit/react</C>, <C>@usagekit/views</C> and <C>@usagekit/store-postgres</C>
              are published at {runtimeVersion}. Install matching versions together. Registry JSON
              is distributed from the project website; the registry tooling itself stays private.
            </Note>
            <Code lang="shell" title={`Published ${runtimeVersion} cohort`} className="docs-block">
              {`npm install --save-exact ${reactPackages.join(" ")}\n# Optional durable Postgres adapter:\nnpm install --save-exact @usagekit/store-postgres@${runtimeVersion}`}
            </Code>
            <p>
              Release {runtimeVersion} adds <C>ProviderRate.fallback</C> to <C>@usagekit/views</C>;
              the other six packages moved to {runtimeVersion} in lockstep. Registry blocks request
              exact {runtimeVersion} package versions, which resolve anonymously from npm. For an
              unpublished candidate, install the reviewed cohort tarballs together before copying
              blocks, as described in <C>docs/CONSUMING.md</C>.
            </p>
            <p>
              To build an unreleased source checkout, from the repository root with Node{" "}
              <strong>22.23.4</strong> and npm <strong>10.9.3</strong>, install and build the local
              workspaces. This links the React and view packages locally; it does not publish them.
            </p>
            <Code lang="shell" title="Terminal" className="docs-block">
              {checkoutCommands}
            </Code>
            <p>
              To review every block in each shadcn style with an in-memory Meter and a sample budget
              writer, prepare the local showcase:
            </p>
            <Code lang="shell" title="Local showcase" className="docs-block">
              {showcaseCommands}
            </Code>
            <p>
              <a href="/examples/">Try the hosted showcase</a> to explore every style without a
              checkout. Both showcases use local fixtures and make no provider calls. To consume the
              UI workspaces in another application, follow <C>docs/CONSUMING.md</C> in the checkout
              for the local package source and peer dependencies.
            </p>
          </Section>

          <Section id="local-server" title="Run the local server" onFollow={onFollow}>
            <p>
              <C>usagekit serve</C> runs a single-owner server on <C>127.0.0.1:4242</C>: a SQLite
              ledger, an encrypted key vault, the API proxy and the dashboard. The first start asks
              for a vault passphrase and prints the bearer token once. It runs from the checkout;
              the server, proxy and CLI are not on npm.
            </p>
            <Code lang="shell" title="Start, add a key, set a limit" className="docs-block">
              {serveCommands}
            </Code>
            <p>
              Agents call providers through the proxy with the local token. The vault injects the
              provider key. Metered calls reserve budget before dispatch; a blocking budget answers{" "}
              <C>429</C> with <C>allowance_exceeded</C> when there is no headroom. An{" "}
              <C>Idempotency-Key</C> admits one call; a repeat returns <C>409</C>. Known free
              operations and configured passthrough calls are counted without spend enforcement.
            </p>
            <Code lang="shell" title="Agent request" className="docs-block">
              {proxyCommand}
            </Code>
            <p>
              Open <C>http://127.0.0.1:4242/</C> and enter the token to see usage, budgets,
              exceptions and connections. Only calls through the proxy are metered. Tokens, vault
              recovery and restart behaviour are in <C>docs/LOCAL-SERVER.md</C> and{" "}
              <C>docs/PROXY.md</C> in the checkout.
            </p>
          </Section>

          <Section id="hooks" title="Headless hooks" onFollow={onFollow}>
            <p>
              Wrap related panels in one <C>MeterProvider</C>. Equal reads share a cache. Keys
              include Meter identity, verified access and query input, so a scope or account change
              isolates the rendered state. The TypeScript samples on this page are illustrative.
            </p>
            <Code lang="tsx" title="Application wiring" className="docs-block">
              {hooksSample}
            </Code>
            <h3 className="docs-h3" id="docs-read-hooks">
              Read hooks
            </h3>
            <Chips items={readHooks} labelledBy="docs-read-hooks" />
            <p>
              Read hooks expose <C>data</C>, <C>state</C>, <C>error</C>, <C>refresh()</C> and{" "}
              <C>refreshing</C>. <C>useBudgetEditor</C> and <C>useBudgetMutation</C> handle
              administrative editing through a host-supplied writer.
            </p>
            <p>
              Pure loaders in <C>@usagekit/views</C> also run without React. Exact amount models
              contain text, unit and certainty. Keep their decimal text intact rather than
              converting it to a JavaScript number.
            </p>
          </Section>

          <Section id="components" title="Copyable components" onFollow={onFollow}>
            <p>
              Every block follows each shadcn style: New York, and Vega, Nova, Maia, Lyra, Mira,
              Luma, Sera and Rhea on Radix and Base UI. Blocks use your application's semantic
              tokens and primitives; they do not bring a second theme.
            </p>
            <p>
              Point a registry at <C>{"/r/styles/{style}/{name}.json"}</C> in <C>components.json</C>{" "}
              and the shadcn CLI fills in your style. <C>/r/radix</C> stays New York and{" "}
              <C>/r/base</C> stays Base UI Vega. Blocks request exact {runtimeVersion} package
              versions from npm; install them first with the React installation commands above.
            </p>
            <p>
              <a href="/examples/">Open the public registry</a> to try every block in each style and
              copy an install command for any block. Commands use the origin of the preview you are
              viewing. For a local registry build, use the checkout commands below.
            </p>
            <dl className="docs-index docs-block">
              {registryBlocks.map(([name, description]) => (
                <div key={name} className="docs-index-row">
                  <dt>{name}</dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
            <Code lang="shell" title="Local registry" className="docs-block">
              {registryCommands}
            </Code>
            <p>
              Run these commands from a configured consumer with the local UI packages available as
              described in <C>docs/CONSUMING.md</C>. shadcn installs into{" "}
              <C>@/components/usagekit/</C>; copied blocks reference your <C>@/components/ui/*</C>{" "}
              primitives. Registry commands copy components; npm publication is a separate step.
            </p>
            <p>
              Budget status shows used and reserved amounts separately. Measurement cards
              distinguish measured, estimated, unknown and unavailable values. A forbidden or failed
              read must not display stale figures.
            </p>
          </Section>

          <Section id="budget-editing" title="Budget editing" onFollow={onFollow}>
            <p>
              Supply an existing Budget or a host-authored template to <C>useBudgetEditor</C>. The
              draft contains exact decimal strings for the limit, optional hard limit and alert
              quantities. The trusted scope, unit and window come from your host.
            </p>
            <p>
              Supply your host writer through <C>MeterProvider</C> and keep it stable across
              renders.
            </p>
            <Code lang="tsx" title="Host budget writer" className="docs-block">
              {writerSample}
            </Code>
            <Note
              icon={<ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />}
              title="A UI permission flag is not server authorization."
            >
              Your server must independently authorize, validate and persist each save with a
              version check.
            </Note>
            <ul className="docs-list docs-block" role="list">
              <li>Conflicts keep the draft.</li>
              <li>
                An ambiguous save freezes duplicate writes until reconciliation confirms the result.
              </li>
              <li>There is no automatic write retry, budget deletion or wallet mutation.</li>
            </ul>
          </Section>

          <Section id="providers" title="Provider management" onFollow={onFollow}>
            <p>
              Provider hooks and blocks use a separate <C>ProviderManagementPort</C> supplied by
              your application. They expose stored connection evidence, balances, request quotes and
              allocations. Reads never implicitly test credentials or call a provider.
            </p>
            <h3 className="docs-h3" id="docs-provider-hooks">
              Provider hooks
            </h3>
            <Chips items={providerHooks} labelledBy="docs-provider-hooks" />
            <Code lang="tsx" title="Provider host wiring" className="docs-block">
              {providerSample}
            </Code>
            <p>
              The verified binding contains <C>scopeKey</C>, <C>principalKey</C> and{" "}
              <C>authRevision</C>. Management is disabled by default. Your server must authorize
              every action independently, check revisions and persist the command result.
            </p>
            <p>
              <C>useProviderAction</C> supports explicit actions and reconciliation. Credential
              material travels separately from the content-free command, stays out of read
              snapshots, and is not automatically retried. A pending or ambiguous operation prevents
              duplicate writes.
            </p>
            <p>
              <C>useProviderEditor</C>, in the React package since 0.7.0, keeps a draft base
              separate from current evidence and rebases only after an explicit successful reload.
              The provider rate, allocation and manager blocks use it.
            </p>
            <p>
              <C>useProviderProjection</C> quotes one proposed request. <C>useBudgetProjection</C>{" "}
              models budget exhaustion from trusted input. Quotes, forecasts and balances keep their
              certainty, freshness and authority explicit.
            </p>
          </Section>

          <Section id="architecture" title="Architecture and ownership" onFollow={onFollow}>
            <p>Each layer builds on the layers before it.</p>
            <ol className="docs-layers docs-block" role="list">
              {layers.map(([name, text], index) => (
                <li key={name} className="docs-layer">
                  <span className="docs-layer-step num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <p className="docs-layer-name">{name}</p>
                    <p className="docs-layer-text">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p>
              Your host owns authentication, verified access, routes, provider credentials,
              persistence and customer balance authority.{" "}
              <strong>Query scope is not authorization.</strong> Provider cost and customer charge
              are distinct values.
            </p>
            <p id="docs-source-docs">
              For the full contract and integration mechanics, read these files in the source
              checkout:
            </p>
            <ul className="docs-chips docs-block" role="list" aria-labelledby="docs-source-docs">
              {sourceDocs.map((file) => (
                <li key={file} className="docs-chip">
                  <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                  {file}
                </li>
              ))}
            </ul>
          </Section>
          <div ref={end} className="docs-end" aria-hidden="true" />
        </div>
      </div>
    </main>
  );
}
