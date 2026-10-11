"use client";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FundingSource } from "@usagekit/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fundingLabel, providerFeedbackLabels } from "@/components/usagekit/provider-feedback";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
export const providerSourceLabels = {
  title: "Funding source",
  description: "Provider account charges and host credit charges remain separate.",
  confirm: "Confirm funding change",
  cancel: "Cancel",
  confirmation: "Change the funding source to",
  current: "Current",
};
export type ProviderSourceLabels = typeof providerSourceLabels;

export type ControlledSourceProps = {
  mode: "controlled";
  /** Include host authorization/connection identity; changing it fences late completion. */
  identity?: string;
  value: FundingSource;
  choices: readonly { source: FundingSource; disabled?: boolean; description?: ReactNode }[];
  onSelect: (source: FundingSource) => Promise<void>;
  confirmTransition?: (from: FundingSource, to: FundingSource) => ReactNode | null;
  canEdit?: boolean;
  busy?: boolean;
  error?: ReactNode;
  variant?: "card" | "plain";
  labels?: Partial<ProviderSourceLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
};
export function ControlledSourceSelector({
  value,
  choices,
  onSelect,
  confirmTransition,
  canEdit = true,
  busy = false,
  error,
  variant = "card",
  labels,
  feedbackLabels,
}: ControlledSourceProps & { labels: ProviderSourceLabels }) {
  const feedback = { ...providerFeedbackLabels, ...feedbackLabels };
  const [selected, setSelected] = useState<{ source: FundingSource; body: ReactNode } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const enabled = (source: FundingSource) =>
    canEdit &&
    !busy &&
    !pending &&
    source !== value &&
    choices.some((choice) => choice.source === source && !choice.disabled);
  const select = async (source: FundingSource) => {
    if (!enabled(source) || lock.current) return;
    lock.current = true;
    setPending(true);
    setFailed(false);
    setSelected(null);
    try {
      await onSelect(source);
    } catch {
      setFailed(true);
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const Surface = variant === "plain" ? "div" : Card;
  return (
    <Surface aria-busy={busy || pending || undefined} className="min-w-0">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p>
          {labels.current}: {fundingLabel(value, feedback)}
        </p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <div key={choice.source}>
              <Button
                type="button"
                aria-pressed={value === choice.source}
                disabled={!enabled(choice.source)}
                onClick={() => {
                  const body = confirmTransition?.(value, choice.source);
                  if (body === null || body === undefined) void select(choice.source);
                  else setSelected({ source: choice.source, body });
                }}
              >
                {fundingLabel(choice.source, feedback)}
              </Button>
              {choice.description && <p>{choice.description}</p>}
            </div>
          ))}
        </div>
        {selected && (
          <fieldset className="m-0 min-w-0 border-0 p-0" aria-label={labels.confirmation}>
            {selected.body}
            <Button
              type="button"
              disabled={!enabled(selected.source)}
              onClick={() => void select(selected.source)}
            >
              {labels.confirm}
            </Button>
            <Button type="button" onClick={() => setSelected(null)}>
              {labels.cancel}
            </Button>
          </fieldset>
        )}
        {(error || failed) && <p role="alert">{error ?? feedback.unavailable}</p>}
        {pending && <p role="status">{feedback.pending}</p>}
      </CardContent>
    </Surface>
  );
}
