"use client";
import { ControlledSourceSelector } from "@/components/usagekit/provider-source-control";
import type { ControlledSourceProps } from "@/components/usagekit/provider-source-control";
export type { ControlledSourceProps } from "@/components/usagekit/provider-source-control";
import { useState } from "react";
import { useProviderAction } from "@usagekit/react";
import type { ProviderAction } from "@usagekit/react";
import type { FundingSource } from "@usagekit/core";
import type { ProviderConnection } from "@usagekit/views";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fundingLabel,
  ProviderActionFeedback,
  providerFeedbackLabels,
} from "@/components/usagekit/provider-feedback";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import { UsageStatus, usageMotion } from "@/components/usagekit/usage-motion";
export { providerSourceLabels } from "@/components/usagekit/provider-source-control";
import { providerSourceLabels } from "@/components/usagekit/provider-source-control";
import type { ProviderSourceLabels } from "@/components/usagekit/provider-source-control";
export type { ProviderSourceLabels } from "@/components/usagekit/provider-source-control";
type SourceProps = {
  mode?: "connection";
  connection: ProviderConnection;
  action?: ProviderAction;
  sources: readonly FundingSource[];
  description?: string;
  labels?: Partial<ProviderSourceLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
};
export function ProviderSourceSelector(props: SourceProps | ControlledSourceProps) {
  if (props.mode === "controlled")
    return (
      <ControlledSourceSelector
        key={`${props.identity ?? ""}:${props.value}`}
        {...props}
        labels={{ ...providerSourceLabels, ...props.labels }}
      />
    );
  return <ConnectionSourceSelector {...props} />;
}
function ConnectionSourceSelector({
  connection,
  action: guardedAction,
  sources,
  description,
  labels: custom,
  feedbackLabels,
}: SourceProps) {
  const labels = { ...providerSourceLabels, ...custom };
  const feedback = { ...providerFeedbackLabels, ...feedbackLabels };
  const sharedAction = useProviderAction();
  const action = guardedAction ?? sharedAction;
  const [selected, setSelected] = useState<FundingSource | null>(null);
  const editable =
    action.canWrite &&
    !action.pending &&
    !action.ambiguous &&
    action.state !== "conflict" &&
    connection.capabilities.includes("funding");
  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <CardTitle className="leading-snug">{labels.title}</CardTitle>
        <CardDescription>{description ?? labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="cn-usage-gap-md flex flex-col">
        <p className="cn-usage-body flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{labels.current}</span>
          <UsageStatus key={connection.fundingSource} tone="positive" className={usageMotion.enter}>
            {fundingLabel(connection.fundingSource, feedback)}
          </UsageStatus>
        </p>
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <Button
              key={source}
              type="button"
              variant={
                selected === source
                  ? "secondary"
                  : connection.fundingSource === source
                    ? "secondary"
                    : "outline"
              }
              aria-pressed={connection.fundingSource === source}
              disabled={!editable || source === connection.fundingSource}
              onClick={() => setSelected(source)}
            >
              {fundingLabel(source, feedback)}
            </Button>
          ))}
        </div>
        {selected && (
          <div
            key={selected}
            className={`cn-usage-panel flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/50 ${usageMotion.enter}`}
          >
            <p className="cn-usage-title font-medium">
              {labels.confirmation} {fundingLabel(selected, feedback)}?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!editable}
                onClick={() => {
                  void action.run({
                    kind: "funding",
                    commandId: crypto.randomUUID(),
                    connectionId: connection.id,
                    expectedRevision: connection.revision,
                    fundingSource: selected,
                  });
                  setSelected(null);
                }}
              >
                {labels.confirm}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setSelected(null)}>
                {labels.cancel}
              </Button>
            </div>
          </div>
        )}
        <ProviderActionFeedback action={action} labels={feedback} />
      </CardContent>
    </Card>
  );
}
