"use client";
import { useRef, useState } from "react";
import { useProviderEditor } from "@usagekit/react";
import type { ProviderEditorRefreshKind } from "@usagekit/react";
import { Button } from "@/components/ui/button";
import {
  ProviderAllocationEditor,
  providerAllocationLabels,
} from "@/components/usagekit/provider-allocation-form";
import type { AllocationProps } from "@/components/usagekit/provider-allocation-policy";
import { allocationDraftValue } from "@/components/usagekit/provider-allocation-policy";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import type { ProviderAllocationLabels } from "@/components/usagekit/provider-allocation-row";
import { ProviderReadFeedback } from "@/components/usagekit/provider-feedback";
import { UsageSpinner } from "@/components/usagekit/usage-motion";
export function ProviderAllocationPanel({
  connectionIds,
  fresh = false,
  labels,
  feedbackLabels,
  onReload,
  evidenceAvailable = true,
  canEdit = true,
  onRefreshPendingChange,
  onReadRefreshChange,
  ...presentation
}: {
  connectionIds: readonly string[];
  /** Runs first on every explicit reload to reverify host access. */
  onReload?: () => void;
  fresh?: boolean;
  labels?: Partial<ProviderAllocationLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
  /** A composing panel may withdraw evidence without discarding this editor's draft. */
  evidenceAvailable?: boolean;
  canEdit?: boolean;
  /** Explicit Reload versus background read revalidation; null when settled. */
  onReadRefreshChange?: (kind: ProviderEditorRefreshKind) => void;
} & Omit<
  AllocationProps,
  "rows" | "evidenceRows" | "action" | "revision" | "fresh" | "labels" | "feedbackLabels"
>) {
  const [refreshing, setRefreshing] = useState(false);
  const pendingEditors = useRef(0);
  const notify = useRef(onRefreshPendingChange);
  notify.current = onRefreshPendingChange;
  const result = useProviderEditor(
    { kind: "allocations", connectionIds },
    {
      ...(onReadRefreshChange ? { onReadRefreshChange } : {}),
      onRebase: (snapshot) => {
        presentation.formAdapter?.rebase?.(
          Object.fromEntries(
            snapshot.rows.map((row) => [
              row.id,
              allocationDraftValue(
                row,
                typeof presentation.inputPolicy === "function"
                  ? presentation.inputPolicy(row)
                  : presentation.inputPolicy,
              ),
            ]),
          ),
        );
      },
    },
  );
  const action = {
    ...result.action,
    canWrite: result.canEdit && canEdit && evidenceAvailable,
  };
  const reloadDisabled =
    refreshing || action.pending || action.ambiguous || result.refreshing || !evidenceAvailable;
  const reload = () => {
    onReload?.();
    result.reload();
  };
  const repeated = action.state === "forbidden" && result.state === "forbidden";
  if (!result.editorData)
    return (
      <ProviderReadFeedback
        message={presentation.feedbackMessage}
        formatMessage={presentation.formatFeedback}
        state={result.state}
        error={result.error}
        refresh={reload}
        disabled={reloadDisabled}
        {...(feedbackLabels ? { labels: feedbackLabels } : {})}
      />
    );
  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" size="sm" disabled={reloadDisabled} onClick={reload}>
        {result.refreshing && <UsageSpinner />}
        {labels?.reload ?? providerAllocationLabels.reload}
      </Button>
      {!result.evidence && !repeated && (
        <ProviderReadFeedback
          message={presentation.feedbackMessage}
          formatMessage={presentation.formatFeedback}
          state={result.state}
          error={result.error}
          refresh={reload}
          disabled={reloadDisabled}
          {...(feedbackLabels ? { labels: feedbackLabels } : {})}
        />
      )}
      <ProviderAllocationEditor
        {...presentation}
        key={result.editorEpoch}
        onRefreshPendingChange={(pending) => {
          pendingEditors.current += pending ? 1 : -1;
          if (pendingEditors.current === (pending ? 1 : 0)) {
            setRefreshing(pending);
            notify.current?.(pending);
          }
        }}
        rows={result.editorData.rows}
        revision={result.editorData.revision}
        evidenceRows={evidenceAvailable ? (result.evidence?.rows ?? null) : null}
        action={action}
        fresh={fresh}
        {...(labels ? { labels } : {})}
        {...(feedbackLabels ? { feedbackLabels } : {})}
      />
    </div>
  );
}
