"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import type { Certainty, Meter, UsageQuery } from "@usagekit/core";
import { serialize, useMeterBinding, useUsageView } from "@usagekit/react";
import type { Amount, Figure, UsageView } from "@usagekit/views";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UsageSpinner, UsageStatus, usageMotion } from "@/components/usagekit/usage-motion";
import type { UsageTone } from "@/components/usagekit/usage-motion";

export const usageTableLabels = {
  title: "Usage detail",
  funding: "Funding source",
  byok: "Own key",
  platform: "Platform funded",
  cost: "Cost",
  customerCharges: "Customer charges",
  cents: "cents",
  certainty: "Certainty",
  unknownOperations: "Unknown operations",
  measured: "Measured",
  estimated: "Estimated",
  unknown: "Unknown",
  unavailable: "Unavailable",
  loading: "Loading usage.",
  empty: "No usage in this period.",
  forbidden: "You cannot view usage for this scope.",
  failed: "Usage is unavailable right now.",
  next: "Next page",
  first: "First page",
};
export type UsageTableLabels = typeof usageTableLabels;

const certaintyTone: Record<Certainty, UsageTone> = {
  measured: "positive",
  estimated: "neutral",
  unknown: "unknown",
};
const frame = "cn-usage-frame min-w-0 overflow-hidden border-border";
const head = "cn-usage-head font-medium text-muted-foreground";
const cell = "cn-usage-cell";

function figure(
  value: Figure | Amount,
  labels: UsageTableLabels,
  props: Pick<UsageTableProps, "formatFigure" | "formatUnit">,
): string {
  if (value === "unavailable") return labels.unavailable;
  if (value.certainty === "unknown") return labels.unknown;
  return `${props.formatFigure?.(value) ?? value.text} ${props.formatUnit?.(value.unit) ?? (value.unit === "customer_cents" || value.unit === "cents" ? labels.cents : value.unit)}`;
}

export type UsageTableProps = {
  view: UsageView | null;
  labels?: Partial<UsageTableLabels>;
  /** Column headings per dimension; the dimension name is the default. */
  dimensionLabels?: Partial<Record<string, string>>;
  onNextPage?: (cursor: string) => void;
  onFirstPage?: () => void;
  /** A newer page is loading; the current rows stay visible but dimmed. */
  busy?: boolean;
  formatFigure?: (value: Exclude<Figure, "unavailable">) => string;
  formatUnit?: (unit: string) => string;
  formatDimension?: (dimension: string, value: string, row: UsageView["rows"][number]) => ReactNode;
  showFunding?: boolean;
  formatFunding?: (source: UsageView["rows"][number]["fundingSource"]) => ReactNode;
  metadata?: ReactNode;
  details?: ReactNode;
};

/** Renders one UsageView page. Amounts are the view model's exact text, never recomputed. */
export function UsageTable({
  view,
  labels: custom,
  dimensionLabels = {},
  onNextPage,
  onFirstPage,
  busy = false,
  formatFigure,
  formatUnit,
  formatDimension,
  showFunding = false,
  formatFunding,
  metadata,
  details,
}: UsageTableProps) {
  const labels = { ...usageTableLabels, ...custom };
  if (!view)
    return (
      <div role="status" className={frame}>
        <span className="sr-only">{labels.loading}</span>
        {[0, 1, 2].map((row) => (
          <span
            key={row}
            aria-hidden
            className="cn-usage-cell block border-b border-border last:border-0"
          >
            <span className="block h-4 w-full max-w-md cn-usage-skeleton animate-pulse motion-reduce:animate-none" />
          </span>
        ))}
      </div>
    );
  if (view.state === "forbidden" || view.state === "unavailable")
    return (
      <p
        role="status"
        className={`cn-usage-empty cn-usage-body border-border text-muted-foreground ${usageMotion.enter}`}
      >
        {view.state === "forbidden" ? labels.forbidden : labels.failed}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {metadata}
      <div className={frame}>
        <Table
          tabIndex={0}
          aria-label={labels.title}
          aria-busy={busy || undefined}
          className={`focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${busy ? "opacity-60" : ""} ${usageMotion.settle}`}
        >
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {view.groupBy.map((d) => (
                <TableHead key={d} className={head}>
                  {dimensionLabels[d] ?? d}
                </TableHead>
              ))}
              {showFunding && <TableHead className={head}>{labels.funding}</TableHead>}
              {view.units.map((unit) => (
                <TableHead key={unit} className={`${head} text-right`}>
                  {formatUnit?.(unit) ??
                    (unit === "customer_cents" ? labels.customerCharges : unit)}
                </TableHead>
              ))}
              <TableHead className={`${head} text-right`}>{labels.cost}</TableHead>
              <TableHead className={head}>{labels.certainty}</TableHead>
              <TableHead className={`${head} text-right`}>{labels.unknownOperations}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.state === "empty" ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={view.groupBy.length + view.units.length + 3 + (showFunding ? 1 : 0)}
                  className="cn-usage-body px-4 py-8 text-center text-muted-foreground"
                >
                  {labels.empty}
                </TableCell>
              </TableRow>
            ) : (
              view.rows.map((row) => (
                <TableRow
                  key={row.key}
                  className="transition-[background-color,opacity] duration-300 starting:opacity-0 motion-reduce:transition-none"
                >
                  {view.groupBy.map((d) => (
                    <TableCell key={d} className={`${cell} font-medium`}>
                      {formatDimension?.(d, row.dimensions[d] ?? "", row) ??
                        row.dimensions[d] ??
                        ""}
                    </TableCell>
                  ))}
                  {showFunding && (
                    <TableCell className={cell}>
                      {formatFunding?.(row.fundingSource) ?? labels[row.fundingSource]}
                    </TableCell>
                  )}
                  {view.units.map((unit) => (
                    <TableCell key={unit} className={`${cell} text-right tabular-nums`}>
                      {figure(row.units[unit] ?? "unavailable", labels, {
                        formatFigure,
                        formatUnit,
                      })}
                    </TableCell>
                  ))}
                  <TableCell className={`${cell} text-right tabular-nums`}>
                    {figure(row.cost, labels, { formatFigure, formatUnit })}
                  </TableCell>
                  <TableCell className={cell}>
                    <UsageStatus tone={certaintyTone[row.certainty]}>
                      {labels[row.certainty]}
                    </UsageStatus>
                  </TableCell>
                  <TableCell
                    className={`${cell} text-right tabular-nums ${row.unknownOperations === "0" ? "text-muted-foreground" : "font-medium"}`}
                  >
                    {row.unknownOperations}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {details}
      {(onFirstPage || (onNextPage && view.nextCursor)) && (
        <div className="flex justify-end gap-2">
          {onFirstPage && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onFirstPage}>
              {labels.first}
            </Button>
          )}
          {onNextPage && view.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onNextPage(view.nextCursor!)}
            >
              {busy && <UsageSpinner />}
              {labels.next}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Reads the view with useUsageView inside a MeterProvider and pages with the cursor. */
export function UsageTablePanel({
  labels,
  dimensionLabels,
  formatFigure,
  formatUnit,
  formatDimension,
  showFunding,
  formatFunding,
  metadata,
  details,
  ...query
}: Omit<UsageQuery, "cursor"> &
  Omit<UsageTableProps, "view" | "onNextPage" | "onFirstPage" | "busy">) {
  const binding = useMeterBinding();
  const key = serialize([query, binding?.access]);
  const [page, setPage] = useState<{
    key: string;
    meter: Meter | undefined;
    cursor: string;
  } | null>(null);
  const cursor = page?.key === key && page.meter === binding?.meter ? page.cursor : undefined;
  const setCursor = (cursor: string) => setPage({ key, meter: binding?.meter, cursor });
  const result = useUsageView(cursor ? { ...query, cursor } : query);
  // The last readable page of this query and binding stays visible while another page loads.
  const [last, setLast] = useState<{
    key: string;
    meter: Meter | undefined;
    view: UsageView;
  } | null>(null);
  const failed = result.state === "forbidden" || result.state === "unavailable";
  // A failed read drops the retained page, so a later reload never shows data it superseded.
  if (failed && last) setLast(null);
  else if (result.data && !failed && last?.view !== result.data)
    setLast({ key, meter: binding?.meter, view: result.data });
  const retained =
    !result.data && result.state === "loading" && last?.key === key && last.meter === binding?.meter
      ? last.view
      : null;
  if (failed)
    return (
      <div className="space-y-3">
        <p
          role="alert"
          className={`cn-usage-empty cn-usage-body border-border text-muted-foreground ${usageMotion.enter}`}
        >
          {result.state === "forbidden"
            ? (labels?.forbidden ?? usageTableLabels.forbidden)
            : (labels?.failed ?? usageTableLabels.failed)}
        </p>
        {cursor && result.state === "unavailable" && (
          <Button variant="outline" size="sm" onClick={() => setPage(null)}>
            {labels?.first ?? usageTableLabels.first}
          </Button>
        )}
      </div>
    );
  return (
    <UsageTable
      view={result.data ?? retained}
      busy={retained !== null}
      labels={labels}
      dimensionLabels={dimensionLabels}
      formatFigure={formatFigure}
      formatUnit={formatUnit}
      formatDimension={formatDimension}
      showFunding={showFunding}
      formatFunding={formatFunding}
      metadata={metadata}
      details={details}
      onNextPage={setCursor}
      onFirstPage={cursor ? () => setPage(null) : undefined}
    />
  );
}
