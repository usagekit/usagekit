import { StrictMode, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MeterProvider, ProviderManagementProvider } from "@usagekit/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UsageCapPill } from "@/components/usagekit/usage-cap-pill";
import { HeaderStatusPanel } from "@/components/usagekit/header-status";
import { UsageFilters } from "@/components/usagekit/usage-filters";
import { UsageSummaryCardsPanel } from "@/components/usagekit/usage-summary-cards";
import { CostSummaryCardPanel } from "@/components/usagekit/cost-summary-card";
import { MeasurementCard } from "@/components/usagekit/measurement-card";
import { UsageTablePanel } from "@/components/usagekit/usage-table";
import { BudgetCardsPanel } from "@/components/usagekit/budget-card";
import { BudgetEditor } from "@/components/usagekit/budget-editor";
import { BudgetManagerPanel } from "@/components/usagekit/budget-manager-panel";
import { CoverageSummaryPanel } from "@/components/usagekit/coverage-summary";
import { ExceptionsListPanel } from "@/components/usagekit/exceptions-list";
import { ConnectionList } from "@/components/usagekit/connection-list";
import { access, createDemoState, initialBudget, owner, period, scope } from "./demo-meter";
import type { DemoState } from "./demo-meter";
import { ProviderManagerPanel } from "@/components/usagekit/provider-manager-panel";
import { ProviderRequestQuotePanel } from "@/components/usagekit/provider-balance-card";
import { createDemoProviderPort, providerBinding } from "./demo-providers";
import { NativeUsage, scenarios } from "./native-usage";
import { setShowcaseStyle, showcaseStyles, useShowcaseStyle } from "./showcase-style";
import "./index.css";
import { ComponentExample } from "./component-example";

const libraries = [
  { key: "radix", label: "Radix" },
  { key: "base", label: "Base UI" },
] as const;
/** The consumer test hosts have one style, which the header names instead of a picker. */
const hostStyle = "Radix / New York";
const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** The style with this sheet in that library, else that library's Vega. */
function styleIn(variant: string, sheet: string) {
  const options = showcaseStyles.filter((style) => style.variant === variant);
  return (options.find((style) => style.sheet === sheet) ??
    options.find((style) => style.sheet === "vega"))!.name;
}

/**
 * Switches the library and the shadcn style in place with the host Select, so the picker takes
 * the current style as well. A prepared showcase loads every style; the consumer test hosts have
 * one style and no picker.
 */
function StylePicker() {
  const current = useShowcaseStyle();
  // Whether keys drive the open list: the key that makes a choice is still down when it lands.
  const byKey = useRef(false);
  const selected = showcaseStyles.find((style) => style.name === current);
  if (!selected) return null;
  const list = {
    onKeyDownCapture: () => {
      byKey.current = true;
    },
    onPointerDownCapture: () => {
      byKey.current = false;
    },
  };
  const choose = (name: string, control: string) => {
    setShowcaseStyle(name);
    // The new style renders its own controls, so focus moves to them as on a native select, once
    // the choosing key is up so that its release cannot press the new trigger.
    const focus = () => requestAnimationFrame(() => document.getElementById(control)?.focus());
    if (byKey.current) addEventListener("keyup", focus, { once: true });
    else focus();
  };
  return (
    <div className="flex items-center gap-2">
      <Select
        value={selected.variant}
        onValueChange={(value: string | null) => {
          if (value) choose(styleIn(value, selected.sheet), "library-picker");
        }}
      >
        <SelectTrigger id="library-picker" size="sm" aria-label="Library">
          <SelectValue>
            {libraries.find((library) => library.key === selected.variant)!.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent {...list}>
          {libraries.map((library) => (
            <SelectItem key={library.key} value={library.key}>
              {library.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selected.name}
        onValueChange={(value: string | null) => {
          if (value) choose(value, "style-picker");
        }}
      >
        <SelectTrigger id="style-picker" size="sm" aria-label="Style" className="min-w-28">
          <SelectValue>{selected.label}</SelectValue>
        </SelectTrigger>
        <SelectContent {...list}>
          {showcaseStyles
            .filter((style) => style.variant === selected.variant)
            .map((style) => (
              <SelectItem key={style.name} value={style.name}>
                {style.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h2 id={id ? `${id}-title` : undefined} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Showcase() {
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [failed, setFailed] = useState(false);
  // The view state lives in the address, so another style opens the same view.
  const [dark, setDark] = useState(
    () => new URLSearchParams(location.search).get("theme") === "dark",
  );
  const [readOnly, setReadOnly] = useState(false);
  const [selectedPeriod, setPeriod] = useState("this");
  const [scenarioKey, setScenario] = useState(() => {
    const requested = new URLSearchParams(location.search).get("state");
    return scenarios.find((item) => item.key === requested)?.key ?? scenarios[0]!.key;
  });
  const [replay, setReplay] = useState(0);
  const [providers] = useState(createDemoProviderPort);
  useEffect(() => {
    // Host portals mount under body and must inherit the same semantic theme tokens.
    document.documentElement.classList.toggle("dark", dark);
    return () => document.documentElement.classList.remove("dark");
  }, [dark]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.set("state", scenarioKey);
    if (dark) params.set("theme", "dark");
    else params.delete("theme");
    history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
  }, [scenarioKey, dark]);
  useEffect(() => {
    let active = true;
    createDemoState().then(
      (value) => {
        if (active) setDemo(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const scenario = scenarios.find((item) => item.key === scenarioKey) ?? scenarios[0]!;
  const range =
    selectedPeriod === "this"
      ? period
      : { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
  const query = { scope: owner, ...range, units: ["requests", "tokens", "customer_cents"] };
  const bounds = {
    scope,
    surface: "app" as const,
    units: ["requests"],
    platformPools: ["shared-pool"],
  };
  if (!demo)
    return (
      <p role="status" className="p-6">
        {failed ? "Sample dashboard unavailable." : "Loading sample dashboard…"}
      </p>
    );
  return (
    <MeterProvider
      meter={demo.meter}
      access={access}
      {...(!readOnly ? { budgetWriter: demo.writer } : {})}
    >
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5 sm:px-8">
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className="size-6 shrink-0 rounded-md bg-foreground" />
              <span className="truncate text-sm font-semibold">Acme workspace</span>
              {showcaseStyles.length === 0 && (
                <Badge variant="outline" className="hidden sm:inline-flex">
                  {hostStyle}
                </Badge>
              )}
            </div>
            {/* On phones the theme toggle stays beside the name and the pickers take a row. */}
            <div className="order-last flex w-full flex-wrap items-center gap-2 sm:order-none sm:ml-auto sm:w-auto sm:justify-end">
              <StylePicker />
              <UsageCapPill key={replay} href="#native-usage" {...scenario.pill} />
            </div>
            <Button variant="ghost" size="sm" aria-pressed={dark} onClick={() => setDark(!dark)}>
              {dark ? "Light" : "Dark"}
            </Button>
          </div>
        </header>
        <main className="mx-auto max-w-6xl space-y-14 px-4 py-8 sm:px-8 sm:py-12">
          <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-1.5">
                <h1 className="text-2xl font-semibold tracking-tight">Usage and budgets</h1>
                <p className="max-w-prose text-sm text-muted-foreground">
                  A host adapter feeds the shared card with its own accounting. Pick a state to see
                  how each reading is presented.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setReplay(replay + 1)}>
                  Replay first load
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={readOnly}
                  onClick={() => setReadOnly(!readOnly)}
                >
                  {readOnly ? "Enable editing" : "View only"}
                </Button>
              </div>
            </div>
            <div role="group" aria-label="Sample state" className="flex flex-wrap gap-1.5">
              {scenarios.map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={item.key === scenario.key ? "secondary" : "ghost"}
                  aria-pressed={item.key === scenario.key}
                  onClick={() => setScenario(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <NativeUsage key={replay} id="native-usage" scenario={scenario} />
          </div>
          <Section
            title="Meter-backed sample"
            description="The same building blocks reading an in-memory Meter through the React hooks."
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <UsageFilters
                period={selectedPeriod}
                periods={[
                  { value: "this", label: "October 2026" },
                  { value: "last", label: "September 2026" },
                ]}
                onPeriodChange={setPeriod}
                scope="workspace"
                scopes={[{ value: "workspace", label: "Acme workspace" }]}
                onScopeChange={() => {}}
              />
              <HeaderStatusPanel {...bounds} formatTime={formatTime} />
            </div>
            <UsageSummaryCardsPanel
              {...query}
              unitLabels={{
                requests: "Requests",
                tokens: "Tokens",
                customer_cents: "Customer charges",
              }}
            />
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <CostSummaryCardPanel {...query} />
              <MeasurementCard
                title="Delayed provider proof"
                description="A receipt has not arrived yet."
                value={{ text: "", unit: "requests", certainty: "unknown" }}
              />
            </div>
          </Section>
          <Section title="Usage detail">
            <UsageTablePanel
              {...query}
              groupBy={["provider"]}
              dimensionLabels={{ provider: "Provider" }}
              limit={2}
            />
          </Section>
          <Section title="Budget status">
            <BudgetCardsPanel {...bounds} formatTime={formatTime} />
          </Section>
          <Section title="Budget editing">
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              <BudgetEditor
                budget={initialBudget}
                title="Monthly requests"
                description="Current limit, resets November 1"
              />
              <BudgetManagerPanel
                scope={owner}
                budgetTitles={{
                  "monthly-requests": "Monthly requests",
                  "monthly-tokens": "Monthly tokens",
                }}
                templates={[
                  {
                    title: "Monthly tokens",
                    description: "Token limit, calendar month",
                    budget: {
                      id: "monthly-tokens",
                      version: 0,
                      scope: owner,
                      surface: "any",
                      unit: "tokens",
                      window: { kind: "calendar_month", timezone: "UTC" },
                    },
                  },
                ]}
              />
            </div>
          </Section>
          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2 lg:gap-6">
            <CoverageSummaryPanel scope={owner} {...range} />
            <Section title="Needs attention">
              <ExceptionsListPanel scope={owner} {...range} />
            </Section>
          </div>
          <Section title="Connections">
            <ConnectionList
              connections={[
                {
                  id: "search-key",
                  provider: "search",
                  label: "Search production",
                  fundingSource: "byok",
                  tags: ["production"],
                },
                {
                  id: "language-key",
                  provider: "language",
                  label: "Language platform",
                  fundingSource: "platform",
                  plan: "Team",
                },
              ]}
            />
          </Section>
          <ProviderManagementProvider
            port={providers.port}
            binding={{ ...providerBinding, canManage: !readOnly }}
          >
            <section aria-label="Provider management" className="min-w-0 space-y-6">
              <ProviderManagerPanel />
              <ProviderRequestQuotePanel
                query={{
                  kind: "projection",
                  connectionId: "search-own",
                  operation: "request",
                  quantity: "1",
                  unit: "requests",
                  surface: "app",
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => providers.setNextOutcome("conflict")}
                >
                  Simulate next conflict
                </Button>
                <Button
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => providers.setNextOutcome("unknown")}
                >
                  Simulate next unknown result
                </Button>
              </div>
            </section>
          </ProviderManagementProvider>
          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Sample data. Changes stay in this local dashboard.
          </p>
        </main>
      </div>
    </MeterProvider>
  );
}
const embedded = new URLSearchParams(location.search).get("embed");
createRoot(document.getElementById("root")!).render(
  <StrictMode>{embedded ? <ComponentExample name={embedded} /> : <Showcase />}</StrictMode>,
);
