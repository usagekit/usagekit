"use client";

import { useId } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const usageFiltersLabels = {
  period: "Period",
  scope: "Scope",
  choosePeriod: "Choose a period",
  chooseScope: "Choose a scope",
};
export type UsageFiltersLabels = typeof usageFiltersLabels;
export type FilterOption = { value: string; label: string };

/** UTC calendar month containing date, shifted by offset months: the usual period presets. */
export function monthWindow(date: Date, offset = 0): { from: string; to: string } {
  const year = date.getUTCFullYear(),
    month = date.getUTCMonth() + offset;
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

export type UsageFiltersProps = {
  period: string;
  periods: readonly FilterOption[];
  onPeriodChange: (value: string) => void;
  scope: string;
  scopes: readonly FilterOption[];
  onScopeChange: (value: string) => void;
  labels?: Partial<UsageFiltersLabels>;
};

function Filter({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="cn-usage-label font-medium text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} className="min-w-40">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/** Period and scope controls. The host maps the chosen values to a query and its access rules. */
export function UsageFilters({ labels: custom, ...props }: UsageFiltersProps) {
  const labels = { ...usageFiltersLabels, ...custom };
  return (
    <div className="flex flex-wrap items-end gap-4">
      <Filter
        label={labels.period}
        placeholder={labels.choosePeriod}
        value={props.period}
        options={props.periods}
        onChange={props.onPeriodChange}
      />
      <Filter
        label={labels.scope}
        placeholder={labels.chooseScope}
        value={props.scope}
        options={props.scopes}
        onChange={props.onScopeChange}
      />
    </div>
  );
}
