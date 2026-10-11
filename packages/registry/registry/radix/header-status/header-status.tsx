"use client";

import type { ReactNode } from "react";
import type { Figure } from "@usagekit/views";
import type { BudgetAlertCrossed } from "@usagekit/core";
import { useHeaderStatus } from "@usagekit/react";
import type { BudgetsInput, HeaderBound, HeaderStatus, Limit } from "@usagekit/views";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { usageMotion } from "@/components/usagekit/usage-motion";

export const headerStatusLabels = {
  of: "of",
  left: "left",
  resets: "Resets",
  noReset: "No reset",
  warningAt: "Warning at",
  hidden: "hidden bounds",
  unlimited: "unlimited",
  unavailable: "unavailable",
  unknown: "unknown",
  empty: "No budgets apply.",
  loading: "Loading status",
  failed: "Status unavailable",
  forbidden: "Status hidden",
};
export type HeaderStatusLabels = typeof headerStatusLabels;

const pill =
  "cn-usage-pill cn-usage-pill-fill cn-usage-pill-md inline-flex max-w-full items-center tabular-nums text-foreground";
const levelClass = {
  ok: "border-border",
  warning: "border-chart-4/70",
  exceeded: "border-destructive/50 text-destructive",
} as const;
const dotClass = { ok: "bg-chart-2", warning: "bg-chart-4", exceeded: "bg-destructive" } as const;

function amount(
  value: Limit,
  labels: HeaderStatusLabels,
  formatFigure?: HeaderStatusBarProps["formatFigure"],
): string {
  if (value === "unavailable") return labels.unavailable;
  if (value === "unlimited") return labels.unlimited;
  if (value.certainty === "unknown") return labels.unknown;
  return formatFigure?.(value) ?? value.text;
}
function Pill({
  bound,
  labels,
  formatTime,
  formatFigure,
  formatUnit,
  formatBound,
  boundHref,
  renderLink,
}: {
  bound: HeaderBound;
  labels: HeaderStatusLabels;
  formatTime: (iso: string) => string;
} & Omit<HeaderStatusBarProps, "status" | "labels">) {
  const warning = bound.warningAt
    ? "percent" in bound.warningAt
      ? `${bound.warningAt.percent}%`
      : `${formatFigure?.({ ...bound.warningAt, certainty: "measured" }) ?? bound.warningAt.text} ${formatUnit?.(bound.warningAt.unit) ?? bound.warningAt.unit}`
    : null;
  const text = `${amount(bound.remaining, labels, formatFigure)} ${labels.of} ${amount(bound.of, labels, formatFigure)} ${formatUnit?.(bound.unit) ?? bound.unit} ${labels.left}`;
  const name = formatBound?.(bound) ?? `${bound.kind} ${bound.target}`;
  const content = (
    <>
      <span
        aria-hidden
        className={`cn-usage-dot shrink-0 transition-colors duration-300 motion-reduce:transition-none ${dotClass[bound.level]}`}
      />
      <span key={text} className={`min-w-0 break-words ${usageMotion.enter}`}>
        {text}
      </span>
    </>
  );
  const href = boundHref?.(bound);
  const triggerProps = {
    "aria-label": `${name}: ${text}`,
    "data-level": bound.level,
    className: `${pill} ${levelClass[bound.level]} cn-usage-pill-link cn-usage-focus ${usageMotion.respond}`,
    children: content,
  };
  const trigger = href ? (
    (renderLink?.({ ...triggerProps, href }) ?? <a {...triggerProps} href={href} />)
  ) : (
    <button {...triggerProps} type="button" style={{ textAlign: "inherit" }} />
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{name}</span>
          <span>
            {bound.resetsAt ? `${labels.resets} ${formatTime(bound.resetsAt)}` : labels.noReset}
          </span>
          {warning && <span>{`${labels.warningAt} ${warning}`}</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export type HeaderStatusBarProps = {
  status: HeaderStatus | null;
  labels?: Partial<HeaderStatusLabels>;
  formatTime?: (iso: string) => string;
  formatFigure?: (value: Exclude<Figure, "unavailable">) => string;
  formatUnit?: (unit: string) => string;
  formatBound?: (bound: HeaderBound) => string;
  boundHref?: (bound: HeaderBound) => string | undefined;
  renderLink?: (props: {
    href: string;
    "aria-label": string;
    "data-level": HeaderBound["level"];
    className: string;
    children: ReactNode;
  }) => ReactNode;
};

/** Compact inline status: one pill per visible bound, with its level in words and color. */
export function HeaderStatusBar({
  status,
  labels: custom,
  formatTime = (t) => t,
  formatFigure,
  formatUnit,
  formatBound,
  boundHref,
  renderLink,
}: HeaderStatusBarProps) {
  const labels = { ...headerStatusLabels, ...custom };
  if (!status)
    return (
      <span role="status" className="inline-flex w-40 max-w-full">
        <span className="sr-only">{labels.loading}</span>
        <span
          aria-hidden
          className="cn-usage-pill-skeleton cn-usage-pill-md block w-full animate-pulse motion-reduce:animate-none"
        />
      </span>
    );
  if (status.state === "unavailable" || status.state === "forbidden" || status.state === "empty")
    return (
      <span
        role="status"
        className={`${pill} border-dashed border-border text-muted-foreground ${usageMotion.enter}`}
      >
        {status.state === "forbidden"
          ? labels.forbidden
          : status.state === "empty"
            ? labels.empty
            : labels.failed}
      </span>
    );
  return (
    <TooltipProvider>
      <div
        className="flex min-w-0 max-w-full flex-wrap items-center gap-2"
        data-level={status.level}
      >
        {status.bounds.map((bound) => (
          <Pill
            key={bound.budgetId}
            bound={bound}
            labels={labels}
            formatTime={formatTime}
            formatFigure={formatFigure}
            formatUnit={formatUnit}
            formatBound={formatBound}
            boundHref={boundHref}
            renderLink={renderLink}
          />
        ))}
        {status.hidden > 0 && (
          <span className={`${pill} border-dashed border-border text-muted-foreground`}>
            {`${status.hidden} ${labels.hidden}`}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}

/** Reads the status with useHeaderStatus; pass the last command's crossings to refresh it. */
export function HeaderStatusPanel({
  labels,
  formatTime,
  formatFigure,
  formatUnit,
  formatBound,
  boundHref,
  renderLink,
  crossings,
  ...input
}: Omit<BudgetsInput, "crossings"> & {
  crossings?: readonly BudgetAlertCrossed[];
} & Omit<HeaderStatusBarProps, "status">) {
  const result = useHeaderStatus(crossings ? { ...input, crossings } : input);
  if (result.state === "unavailable" || result.state === "forbidden")
    return (
      <p
        role="alert"
        className={`${pill} border-dashed border-border text-muted-foreground ${usageMotion.enter}`}
      >
        {result.state === "forbidden"
          ? (labels?.forbidden ?? headerStatusLabels.forbidden)
          : (labels?.failed ?? headerStatusLabels.failed)}
      </p>
    );
  return (
    <HeaderStatusBar
      status={result.data}
      labels={labels}
      formatTime={formatTime}
      formatFigure={formatFigure}
      formatUnit={formatUnit}
      formatBound={formatBound}
      boundHref={boundHref}
      renderLink={renderLink}
    />
  );
}
