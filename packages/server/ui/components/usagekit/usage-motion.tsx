"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Shared motion vocabulary. Entries run from @starting-style, so they play once when an element
 * appears; keyed elements replay when their content changes. Reduced motion removes every
 * transition, which also skips the starting styles.
 */
export const usageMotion = {
  /** Messages, revealed fields and changed figures: fade in while rising a few pixels. */
  enter:
    "transition-[opacity,translate] duration-300 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none",
  /** Control feedback such as hover and selection. */
  respond: "transition-colors duration-150 ease-out motion-reduce:transition-none",
  /** Dims content that is about to be replaced by a newer reading. */
  settle: "transition-opacity duration-200 ease-out motion-reduce:transition-none",
} as const;

/** Height and opacity reveal that keeps collapsed content out of focus and assistive tech. */
export function UsageReveal({
  open,
  id,
  className = "",
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      inert={!open}
      data-state={open ? "open" : "closed"}
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"} ${className}`}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Disclosure caret that turns with its region. */
export function UsageChevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none ${open ? "rotate-180" : ""} ${className}`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Pending indicator for the control that started the work; text still states the pending state. */
export function UsageSpinner({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className={`size-3.5 shrink-0 animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type UsageTone = "ok" | "warning" | "exceeded" | "positive" | "neutral" | "unknown";

const dotClass: Record<UsageTone, string> = {
  ok: "bg-primary",
  positive: "bg-chart-2",
  warning: "bg-chart-4",
  exceeded: "bg-destructive",
  neutral: "bg-muted-foreground/50",
  unknown: "border border-muted-foreground/60 bg-transparent",
};

/** Status in words with a colored dot; color only reinforces the text. */
export function UsageStatus({
  tone,
  children,
  className = "",
}: {
  tone: UsageTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={`text-xs inline-flex min-w-0 items-center gap-1.5 ${tone === "exceeded" ? "text-destructive" : "text-foreground"} ${className}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full shrink-0 transition-colors duration-300 motion-reduce:transition-none ${dotClass[tone]}`}
      />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

export type UsageSegmentOption<T extends string> = { value: T; label: string };

/** Choice between a few options; the selection indicator slides to the chosen one. */
export function UsageSegmented<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  label,
  className = "",
}: {
  value: T | null;
  options: readonly UsageSegmentOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Accessible group name when no surrounding legend names the choice. */
  label?: string;
  className?: string;
}) {
  const index = options.findIndex((option) => option.value === value);
  // Equal segments keep the indicator's geometry simple; a choice wider than its container
  // scrolls sideways instead of cutting labels short.
  return (
    <div
      role={label ? "group" : undefined}
      aria-label={label}
      className={`rounded-lg bg-muted w-fit max-w-full overflow-x-auto [scrollbar-width:thin] ${disabled ? "opacity-60" : ""} ${className}`}
    >
      <div
        className="p-[3px] relative grid min-w-max auto-cols-fr grid-flow-col"
        style={{ "--count": options.length, "--index": Math.max(index, 0) } as CSSProperties}
      >
        {index >= 0 && (
          <span
            aria-hidden
            className="inset-y-[3px] left-[3px] w-[calc((100%_-_6px)/var(--count))] rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30 absolute translate-x-[calc(100%_*_var(--index))] transition-transform duration-300 ease-out motion-reduce:transition-none"
          />
        )}
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2 py-1 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 relative whitespace-nowrap disabled:cursor-not-allowed ${option.value === value ? "text-foreground" : "text-foreground/70 hover:text-foreground"} ${usageMotion.respond}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Keep focus on the moved row when its triggering button becomes disabled. */
export function retainMovedRowFocus(button: HTMLButtonElement) {
  requestAnimationFrame(() => {
    if (
      !button.isConnected ||
      !button.disabled ||
      (document.activeElement !== document.body && document.activeElement !== button)
    )
      return;
    button.closest("li")?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
}

export type UsageNoticeTone = "positive" | "warning" | "error" | "neutral";

const noticeClass: Record<UsageNoticeTone, string> = {
  positive: "text-foreground",
  warning: "text-foreground",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};
const noticeIcon: Record<UsageNoticeTone, string> = {
  positive: "text-chart-2",
  warning: "text-chart-4",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};

/** Result feedback that rises in; keyed by its text so each new outcome replays the entry. */
export function UsageNotice({
  tone,
  role = "status",
  id,
  children,
  className = "",
}: {
  tone: UsageNoticeTone;
  role?: "status" | "alert";
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      id={id}
      role={role}
      data-tone={tone}
      className={`text-sm flex min-w-0 items-start gap-[0.5em] ${noticeClass[tone]} ${usageMotion.enter} ${className}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`mt-[0.1em] size-[1.15em] shrink-0 ${noticeIcon[tone]}`}
      >
        {tone === "positive" ? (
          <path d="m3.5 8.5 3 3 6-7" />
        ) : tone === "neutral" ? (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 7.5V11M8 5v.01" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.75v3.75M8 11v.01" />
          </>
        )}
      </svg>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
