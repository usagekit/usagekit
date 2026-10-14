import { useEffect, useRef, useState } from "react";
import { MeterProvider, ProviderManagementProvider, useProviderConnections } from "@usagekit/react";
import { BudgetCardsPanel } from "@/components/usagekit/budget-card";
import { BudgetEditor } from "@/components/usagekit/budget-editor";
import { BudgetManagerPanel } from "@/components/usagekit/budget-manager-panel";
import { ConnectionList } from "@/components/usagekit/connection-list";
import { CostSummaryCardPanel } from "@/components/usagekit/cost-summary-card";
import { CoverageSummaryPanel } from "@/components/usagekit/coverage-summary";
import { ExceptionsListPanel } from "@/components/usagekit/exceptions-list";
import { HeaderStatusPanel } from "@/components/usagekit/header-status";
import { MeasurementCard } from "@/components/usagekit/measurement-card";
import { ProviderAllocationPanel } from "@/components/usagekit/provider-allocation-editor";
import { ProviderBalancePanel } from "@/components/usagekit/provider-balance-card";
import { ProviderCard } from "@/components/usagekit/provider-card";
import { ProviderChainEditor } from "@/components/usagekit/provider-chain-editor";
import { ProviderConnectForm } from "@/components/usagekit/provider-connect-form";
import { ProviderManagerPanel } from "@/components/usagekit/provider-manager-panel";
import { ProviderRateEditor } from "@/components/usagekit/provider-rate-editor";
import { ProviderSourceSelector } from "@/components/usagekit/provider-source-selector";
import { UsageCapPill } from "@/components/usagekit/usage-cap-pill";
import { UsageFilters } from "@/components/usagekit/usage-filters";
import { UsageSummaryCardsPanel } from "@/components/usagekit/usage-summary-cards";
import { UsageTablePanel } from "@/components/usagekit/usage-table";
import { access, createDemoState, initialBudget, owner, period, scope } from "./demo-meter";
import type { DemoState } from "./demo-meter";
import { createDemoProviderPort, demoProviders, providerBinding } from "./demo-providers";
import { NativeUsage, scenarios } from "./native-usage";

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Only local fixture ports are available here; the catalog never accepts a provider or host URL. */
export function ComponentExample({ name }: { name: string }) {
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [failed, setFailed] = useState(false);
  const [providers] = useState(createDemoProviderPort);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "dark",
      new URLSearchParams(location.search).get("theme") === "dark",
    );
    // Resize only to measured content, with the parent's origin as the explicit target.
    const observer = new ResizeObserver(() => {
      parent.postMessage(
        {
          type: "usagekit-example-size",
          block: name,
          height: surface.current?.getBoundingClientRect().height,
        },
        location.origin,
      );
    });
    if (surface.current) observer.observe(surface.current);
    return () => observer.disconnect();
  }, [name]);
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
  return (
    <div ref={surface} className="example-surface p-1">
      {!demo ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          {failed ? "Sample unavailable. Reload to try again." : "Loading example…"}
        </p>
      ) : (
        <MeterProvider meter={demo.meter} access={access} budgetWriter={demo.writer}>
          <ProviderManagementProvider port={providers.port} binding={providerBinding}>
            <ExampleBlock name={name} />
          </ProviderManagementProvider>
        </MeterProvider>
      )}
    </div>
  );
}

function ExampleBlock({ name }: { name: string }) {
  const [selectedPeriod, setPeriod] = useState("this");
  const connections = useProviderConnections();
  const connection = connections.data?.connections[0];
  const requestedState = new URLSearchParams(location.search).get("state");
  const scenario = scenarios.find((item) => item.key === requestedState) ?? scenarios[0]!;
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
  switch (name) {
    case "usage-overview-card":
      return <NativeUsage scenario={scenario} />;
    case "usage-cap-pill":
      return (
        <div className="flex min-h-48 items-center justify-center">
          <UsageCapPill {...scenario.pill} />
        </div>
      );
    case "usage-table":
      return (
        <UsageTablePanel
          {...query}
          groupBy={["provider"]}
          dimensionLabels={{ provider: "Provider" }}
          limit={2}
        />
      );
    case "usage-summary-cards":
      return (
        <UsageSummaryCardsPanel
          {...query}
          unitLabels={{
            requests: "Requests",
            tokens: "Tokens",
            customer_cents: "Customer charges",
          }}
        />
      );
    case "cost-summary-card":
      return <CostSummaryCardPanel {...query} />;
    case "measurement-card":
      return (
        <MeasurementCard
          title="Provider requests"
          description="Confirmed requests this month"
          value={{ text: "12480", unit: "requests", certainty: "measured" }}
        />
      );
    case "usage-filters":
      return (
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
      );
    case "header-status":
      return <HeaderStatusPanel {...bounds} formatTime={formatTime} />;
    case "budget-card":
      return <BudgetCardsPanel {...bounds} formatTime={formatTime} />;
    case "budget-editor":
      return (
        <BudgetEditor
          budget={initialBudget}
          title="Monthly requests"
          description="Current limit, resets November 1"
        />
      );
    case "budget-manager-panel":
      return (
        <BudgetManagerPanel
          scope={owner}
          budgetTitles={{ "monthly-requests": "Monthly requests" }}
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
      );
    case "coverage-summary":
      return <CoverageSummaryPanel scope={owner} {...range} />;
    case "exceptions-list":
      return <ExceptionsListPanel scope={owner} {...range} />;
    case "connection-list":
      return (
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
      );
    case "provider-manager-panel":
      return <ProviderManagerPanel />;
    case "provider-connect-form":
      return <ProviderConnectForm provider={demoProviders[0]!} fundingSource="byok" requireTest />;
    case "provider-balance-card":
      return <ProviderBalancePanel connectionId="search-own" />;
    case "provider-allocation-editor":
      return <ProviderAllocationPanel connectionIds={["search-own"]} />;
    case "provider-card":
    case "provider-source-selector":
    case "provider-rate-editor":
    case "provider-chain-editor": {
      if (!connection)
        return (
          <p role="status" className="p-6 text-sm">
            Loading sample connection…
          </p>
        );
      if (name === "provider-card") return <ProviderCard connection={connection} />;
      if (name === "provider-source-selector")
        return <ProviderSourceSelector connection={connection} sources={["byok", "platform"]} />;
      if (name === "provider-rate-editor") return <ProviderRateEditor connection={connection} />;
      return (
        <ProviderChainEditor connection={connection} connections={connections.data!.connections} />
      );
    }
    default:
      return (
        <p role="status" className="p-6 text-sm">
          This example is unavailable. Choose a component from the library.
        </p>
      );
  }
}
