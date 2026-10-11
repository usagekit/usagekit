"use client";
import type { ProviderManagerChildProps } from "@/components/usagekit/provider-manager-types";
export type { ProviderManagerChildProps } from "@/components/usagekit/provider-manager-types";
import { useCallback, useState } from "react";
import { useProviderEditor } from "@usagekit/react";
import type { ProviderConnection, ProviderDefinition } from "@usagekit/views";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProviderCard } from "@/components/usagekit/provider-card";
import { ProviderConnectForm } from "@/components/usagekit/provider-connect-form";
import { ProviderSourceSelector } from "@/components/usagekit/provider-source-selector";
import { ProviderRateEditor } from "@/components/usagekit/provider-rate-editor";
import { ProviderChainEditor } from "@/components/usagekit/provider-chain-editor";
import { ProviderBalancePanel } from "@/components/usagekit/provider-balance-card";
import { ProviderAllocationPanel } from "@/components/usagekit/provider-allocation-editor";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import { ProviderReadFeedback } from "@/components/usagekit/provider-feedback";
import { UsageSpinner, usageMotion } from "@/components/usagekit/usage-motion";
export const providerManagerLabels = {
  title: "Provider connections",
  connect: "New connection",
  reload: "Reload connections",
  close: "Close editor",
  empty: "No provider connections yet.",
  choose: "Choose a provider",
  manage: "Manage",
  add: "Add a connection",
};
export type ProviderManagerLabels = typeof providerManagerLabels;
export function ProviderManagerPanel({
  provider: filter,
  oauth,
  labels: custom,
  feedbackLabels,
  onReload,
  childProps,
}: {
  provider?: string;
  oauth?: (provider: ProviderDefinition, connection?: ProviderConnection) => ReactNode;
  labels?: Partial<ProviderManagerLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
  /** Runs first on every explicit reload, including composed panels. */
  onReload?: () => void;
  childProps?: ProviderManagerChildProps;
}) {
  const labels = { ...providerManagerLabels, ...custom };
  const result = useProviderEditor({
    kind: "connections",
    ...(filter ? { provider: filter } : {}),
  });
  const action = { ...result.action, canWrite: result.canEdit };
  const [selected, setSelected] = useState<{
    connection: ProviderConnection;
    definition: ProviderDefinition;
    epoch: string;
  } | null>(null);
  const [creating, setCreating] = useState<{
    definition: ProviderDefinition;
    epoch: string;
  } | null>(null);
  // An opened editor takes focus so keyboard users land in it; it scrolls into view gently.
  const reveal = useCallback((heading: HTMLElement | null) => {
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({
      block: "nearest",
      behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, []);
  const reloadDisabled = result.refreshing || action.pending || action.ambiguous;
  const reload = () => {
    onReload?.();
    result.reload();
  };
  if (!result.editorData)
    return (
      <ProviderReadFeedback
        state={result.state}
        error={result.error}
        refresh={reload}
        disabled={reloadDisabled}
        {...(feedbackLabels ? { labels: feedbackLabels } : {})}
      />
    );
  const connections = result.evidence?.connections ?? [];
  const providers = result.evidence?.providers ?? [];
  const connectable = providers.filter((item) => item.capabilities.includes("connect"));
  const connection = selected?.epoch === result.editorEpoch ? selected.connection : undefined;
  const current = connections.find((item) => item.id === connection?.id) ?? null;
  const creation = creating?.epoch === result.editorEpoch ? creating.definition : null;
  const create = creation?.id ?? null;
  const definition =
    providers.find((item) => item.id === (create ?? connection?.provider)) ??
    (connection ? selected?.definition : creation);
  return (
    <section aria-label={labels.title} className="cn-usage-gap-lg flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="cn-usage-section font-semibold">{labels.title}</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={reloadDisabled}
          onClick={reload}
        >
          {result.refreshing && <UsageSpinner />}
          {labels.reload}
        </Button>
      </div>
      {!result.evidence && (
        <ProviderReadFeedback
          state={result.state}
          error={result.error}
          refresh={reload}
          disabled={reloadDisabled}
          {...(feedbackLabels ? { labels: feedbackLabels } : {})}
        />
      )}
      {connections.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connections.map((item) => (
            <ProviderCard
              {...childProps?.card}
              {...(feedbackLabels ? { feedbackLabels } : {})}
              key={item.id}
              connection={item}
              action={action}
              selected={connection?.id === item.id}
              onManage={() => {
                const definition = providers.find((value) => value.id === item.provider);
                if (!definition) return;
                setSelected((prior) =>
                  prior?.epoch === result.editorEpoch && prior.connection.id === item.id
                    ? prior
                    : {
                        connection: structuredClone(item),
                        definition: structuredClone(definition),
                        epoch: result.editorEpoch,
                      },
                );
                setCreating(null);
              }}
            />
          ))}
        </div>
      )}
      {result.evidence && !connections.length && (
        <p className="cn-usage-empty cn-usage-body border-border text-muted-foreground">
          {labels.empty}
        </p>
      )}
      {connectable.length > 0 && (
        <div className="space-y-2">
          <p className="cn-usage-title font-medium">{labels.add}</p>
          <fieldset
            className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
            aria-label={labels.choose}
          >
            {connectable.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={creation?.id === item.id ? "secondary" : "outline"}
                disabled={!result.canEdit}
                onClick={() => {
                  setCreating({ definition: structuredClone(item), epoch: result.editorEpoch });
                  setSelected(null);
                }}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
                </svg>
                {labels.connect}: {item.label}
              </Button>
            ))}
          </fieldset>
        </div>
      )}
      {definition && (create || connection) && (
        <section
          key={`${result.editorEpoch}:${create ?? connection?.id}`}
          aria-labelledby={`${result.editorEpoch}:${create ?? connection?.id}:title`}
          className={`cn-usage-frame cn-usage-tile cn-usage-gap-md flex min-w-0 flex-col border-border bg-muted/30 ${usageMotion.enter}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3
              id={`${result.editorEpoch}:${create ?? connection?.id}:title`}
              ref={reveal}
              tabIndex={-1}
              className="cn-usage-title font-semibold outline-none"
            >
              {labels.manage}: {connection?.label ?? definition.label}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(null);
                setCreating(null);
              }}
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
              {labels.close}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {result.evidence && (!connection || current) && (
              <ProviderConnectForm
                {...childProps?.connect}
                {...(feedbackLabels ? { feedbackLabels } : {})}
                key={`${create ?? connection?.id}:${connection?.revision ?? "new"}`}
                provider={definition}
                action={action}
                {...(current ? { connection: current } : {})}
                {...(oauth ? { oauth: oauth(definition, current ?? undefined) } : {})}
                onConnected={(item) => {
                  setSelected((prior) =>
                    prior?.epoch === result.editorEpoch && prior.connection.id === item.id
                      ? prior
                      : {
                          connection: structuredClone(item),
                          definition: structuredClone(definition),
                          epoch: result.editorEpoch,
                        },
                  );
                  setCreating(null);
                }}
              />
            )}
            {connection && (
              <>
                {current && (
                  <ProviderSourceSelector
                    {...childProps?.source}
                    {...(feedbackLabels ? { feedbackLabels } : {})}
                    connection={current}
                    action={action}
                    sources={definition.fundingSources}
                  />
                )}
                {current && (
                  <ProviderBalancePanel
                    {...childProps?.balance}
                    connectionId={connection.id}
                    {...(feedbackLabels ? { feedbackLabels } : {})}
                    {...(onReload ? { onReload } : {})}
                  />
                )}
                <ProviderRateEditor
                  {...childProps?.rate}
                  {...(feedbackLabels ? { feedbackLabels } : {})}
                  connection={connection}
                  evidence={current}
                  action={{ ...action, canWrite: action.canWrite && !!current }}
                />
                {current && (
                  <ProviderChainEditor
                    {...childProps?.chain}
                    {...(feedbackLabels ? { feedbackLabels } : {})}
                    key={`chain:${connection.revision}`}
                    connection={current}
                    action={action}
                    connections={connections}
                  />
                )}
              </>
            )}
          </div>
          {connection && (
            <ProviderAllocationPanel
              {...childProps?.allocation}
              {...(onReload ? { onReload } : {})}
              {...(feedbackLabels ? { feedbackLabels } : {})}
              connectionIds={[connection.id]}
              evidenceAvailable={!!current}
              canEdit={result.canEdit && !!current}
              fresh={!!current && !current.freshness.stale && !!current.freshness.observedAt}
            />
          )}
        </section>
      )}
    </section>
  );
}
