"use client";
import { useId, useState } from "react";
import type { ProviderAction } from "@usagekit/react";
import { parseProviderDecimal } from "@usagekit/views";
import type { Figure, ProviderConnection, ProviderRate } from "@usagekit/views";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  centsFromUsd,
  fundingLabel,
  ProviderTime,
  usdInput,
  usdText,
} from "@/components/usagekit/provider-feedback";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import {
  UsageChevron,
  UsageNotice,
  UsageReveal,
  UsageSpinner,
  UsageStatus,
  usageMotion,
} from "@/components/usagekit/usage-motion";
import type { UsageTone } from "@/components/usagekit/usage-motion";
/** One rate: a summary row that opens its provenance and, when editable, the price form. */
type RateSource = ProviderRate["provenance"]["source"];
const sourceTone: Record<RateSource, UsageTone> = {
  manual: "ok",
  measured: "positive",
  list: "neutral",
  unknown: "unknown",
};
const known = (price: Figure): price is Exclude<Figure, "unavailable"> =>
  price !== "unavailable" && price.certainty !== "unknown";
/** Usagekit money is USD cents, so it reads and edits as dollars; other units stay native. */
const isMoney = (unit: string) => unit === "cents" || unit === "customer_cents";
function priceText(price: Figure) {
  if (!known(price)) return null;
  return isMoney(price.unit) ? (usdText(price.text) ?? price.text) : `${price.text} ${price.unit}`;
}
function sourceLabel(source: RateSource, labels: ProviderRateLabels) {
  return source === "unknown" ? labels.noRate : labels[source];
}
export function ProviderRateRow({
  connection,
  rate,
  evidence,
  action,
  labels,
  feedback,
}: {
  connection: ProviderConnection;
  rate: ProviderRate;
  evidence: ProviderRate | null;
  action: ProviderAction;
  labels: ProviderRateLabels;
  feedback: ProviderFeedbackLabels;
}) {
  const id = useId();
  const money = isMoney(rate.priceUnit);
  // Drafts and pending prices read in the unit the form edits.
  const editText = (native: string) => (money ? (usdInput(native) ?? native) : native);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const editable =
    action.canWrite &&
    !action.pending &&
    !action.ambiguous &&
    action.state !== "conflict" &&
    rate.editable &&
    evidence?.editable === true &&
    connection.capabilities.includes("rates");
  const submitted = action.submittedCommand;
  const pendingRate =
    (action.pending || action.ambiguous) &&
    submitted?.kind === "rates" &&
    submitted.connectionId === connection.id
      ? submitted.rates.find((value) => value.rateId === rate.id)
      : null;
  const shown = pendingRate
    ? pendingRate.price === null
      ? ""
      : editText(pendingRate.price)
    : dirty
      ? draft
      : evidence && known(evidence.price)
        ? editText(evidence.price.text)
        : "";
  const save = (text: string | null) => {
    if (!editable) return;
    let price: string | null = null;
    if (text !== null) {
      price = money
        ? centsFromUsd(text)
        : parseProviderDecimal(text, rate.priceUnit).outcome === "valid"
          ? text.trim()
          : null;
      if (price === null) {
        setError(labels.invalid);
        return;
      }
    }
    setError(null);
    void action.run({
      kind: "rates",
      commandId: crypto.randomUUID(),
      connectionId: connection.id,
      expectedRevision: connection.revision,
      rates: [{ rateId: rate.id, price }],
    });
  };
  const current = evidence ? priceText(evidence.price) : null;
  // Only a manual rate can be cleared, and only then does its fallback matter.
  const fallback = evidence?.provenance.source === "manual" ? evidence.fallback : undefined;
  const manual = evidence?.provenance.source === "manual";
  const reset =
    fallback?.provenance.source === "measured"
      ? labels.useMeasured
      : fallback?.provenance.source === "list"
        ? labels.useList
        : labels.reset;
  if (rate.fundingSource === "platform")
    return (
      <li className="rounded-md py-3.5 hover:bg-muted/60 min-w-0 space-y-1">
        <p className="text-sm font-semibold">{rate.label}</p>
        {evidence && evidence.price !== "unavailable" && (
          <p className="text-sm tabular-nums">
            {priceText(evidence.price) ?? labels.unknown} {labels.per} {rate.unit}
          </p>
        )}
      </li>
    );
  return (
    <li className="min-w-0" data-open={open}>
      <div className="-mx-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-details`}
          onClick={() => setOpen(!open)}
          className={`rounded-md py-3.5 hover:bg-muted/60 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 text-left ${usageMotion.respond}`}
        >
          {/* Spaces between the parts keep the accessible name readable in every engine. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-sm min-w-0 flex-1 basis-40 break-words font-semibold">
              {rate.label}
            </span>{" "}
            {evidence && (
              <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
                {current && (
                  <span className="text-sm tabular-nums">
                    <span className="font-medium">{current}</span>{" "}
                    <span className="text-muted-foreground">
                      {labels.per} {rate.unit}
                    </span>
                  </span>
                )}{" "}
                <UsageStatus tone={sourceTone[evidence.provenance.source]}>
                  {sourceLabel(evidence.provenance.source, labels)}
                </UsageStatus>
              </span>
            )}
          </span>
          <UsageChevron open={open} className="text-muted-foreground" />
        </button>
      </div>
      <UsageReveal open={open} id={`${id}-details`}>
        <div className="gap-4 flex min-w-0 flex-col pb-5 pt-1">
          {evidence && (
            <dl className="rounded-lg bg-muted/50 px-3.5 py-3 text-xs/relaxed grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-x-4 gap-y-3">
              {fallback && (
                <div className="col-span-full min-w-0">
                  <dt className="text-muted-foreground">{labels.fallback}</dt>
                  <dd className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                    <span className="font-medium">
                      {priceText(fallback.price) ?? labels.notSet}
                    </span>{" "}
                    <UsageStatus tone={sourceTone[fallback.provenance.source]}>
                      {sourceLabel(fallback.provenance.source, labels)}
                    </UsageStatus>
                  </dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">{labels.checked}</dt>
                <dd className="mt-0.5 break-words tabular-nums">
                  {evidence.provenance.checkedAt ? (
                    <ProviderTime value={evidence.provenance.checkedAt} />
                  ) : (
                    labels.unknown
                  )}
                </dd>
              </div>
              {evidence.provenance.sampleSize !== null && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{labels.samples}</dt>
                  <dd className="mt-0.5 tabular-nums">{evidence.provenance.sampleSize}</dd>
                </div>
              )}
              {evidence.provenance.version !== null && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{labels.version}</dt>
                  <dd className="mt-0.5 break-all">{evidence.provenance.version}</dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">{labels.operation}</dt>
                <dd className="mt-0.5 break-all">{rate.operation}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{labels.funding}</dt>
                <dd className="mt-0.5 break-words">{fundingLabel(rate.fundingSource, feedback)}</dd>
              </div>
            </dl>
          )}
          {rate.editable && (
            <form
              className="gap-3 flex min-w-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                save(shown);
              }}
            >
              <Label htmlFor={id}>
                {labels.price} <span className="sr-only">{rate.label}</span>{" "}
                <span className="font-normal text-muted-foreground">
                  ({money ? labels.currency : rate.priceUnit})
                </span>
              </Label>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                  id={id}
                  type="text"
                  inputMode="decimal"
                  value={shown}
                  readOnly={!editable}
                  className="min-w-0 flex-1 basis-40 tabular-nums"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setDirty(true);
                  }}
                  aria-invalid={!!error}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
                <Button type="submit" disabled={!editable}>
                  {pendingRate && action.pending && <UsageSpinner />}
                  {labels.save}
                </Button>
                {manual && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!editable}
                    onClick={() => save(null)}
                  >
                    {reset}
                  </Button>
                )}
              </div>
              {error && (
                <UsageNotice key={error} id={`${id}-error`} tone="error" role="alert">
                  {error}
                </UsageNotice>
              )}
            </form>
          )}
        </div>
      </UsageReveal>
    </li>
  );
}

export const providerRateLabels = {
  title: "Provider rates",
  platformTitle: "Credits prices",
  platformNote: "Prices are set by the host.",
  description: "Rates retain their source and version. Changing a rate does not change a balance.",
  save: "Save rate",
  /** Clears a manual rate when the host does not say what applies instead. */
  reset: "Clear your rate",
  useMeasured: "Use measured rate",
  useList: "Use list price",
  price: "Price",
  currency: "USD",
  version: "Version",
  checked: "Checked",
  samples: "Samples",
  operation: "Operation",
  funding: "Funding",
  fallback: "Without your rate",
  unknown: "Unknown",
  notSet: "Not set",
  empty: "No rates are available.",
  manual: "Your rate",
  measured: "Measured",
  list: "List price",
  noRate: "No rate yet",
  invalid: "Enter an exact nonnegative price.",
  per: "per",
  reload: "Reload rates",
};
export type ProviderRateLabels = typeof providerRateLabels;
