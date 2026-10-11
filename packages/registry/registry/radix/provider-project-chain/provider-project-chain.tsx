"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { providerFeedbackLabels } from "@/components/usagekit/provider-feedback";
import { retainMovedRowFocus } from "@/components/usagekit/usage-motion";
import type { ProviderChainLabels } from "@/components/usagekit/provider-project-controller";
import { useProjectChainController } from "@/components/usagekit/provider-project-controller";
import type { ProjectChainProps } from "@/components/usagekit/provider-project-controller";
export { useProjectChainController } from "@/components/usagekit/provider-project-controller";
export type {
  ProjectChainEntry,
  ProjectChainSnapshot,
  ProjectChainCommand,
  ProjectChainResult,
  ProjectChainProps,
} from "@/components/usagekit/provider-project-controller";
export function ProjectChainEditor(props: ProjectChainProps & { labels: ProviderChainLabels }) {
  const state = useProjectChainController(props);
  const labels = props.labels;
  const feedback = { ...providerFeedbackLabels, ...props.feedbackLabels };
  const Surface = props.variant === "plain" ? "div" : Card;
  const changed = JSON.stringify(state.draft) !== JSON.stringify(state.base.entries);
  const move = (i: number, delta: number) => {
    const rows = [...state.draft];
    const other = i + delta;
    if (!rows[other] || rows[other]!.enabled !== rows[i]!.enabled) return;
    [rows[i], rows[other]] = [rows[other]!, rows[i]!];
    state.change(rows);
  };
  const outcome = state.result?.outcome ?? state.notice;
  const message = state.ambiguous
    ? feedback.unknown
    : outcome === "conflict"
      ? feedback.conflict
      : outcome === "forbidden"
        ? feedback.forbidden
        : outcome === "success"
          ? feedback.success
          : outcome === "unavailable"
            ? feedback.unavailable
            : outcome === "not_applied"
              ? feedback.notApplied
              : outcome === "invalid"
                ? labels.invalid
                : null;
  return (
    <Surface className="min-w-0" aria-busy={state.pending || undefined}>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.formatCount?.(state.draft.filter((row) => row.enabled).length)}
        <ol className="space-y-2">
          {state.draft.map((row, i) => (
            <li key={row.id} className="cn-usage-item space-y-2">
              <p>
                {row.label} · {row.enabled ? (i === 0 ? labels.first : labels.next) : labels.paused}
                {props.formatPosition?.(row, i, state.draft.length)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  aria-label={`${labels.up}: ${row.label}`}
                  disabled={
                    !state.editable || i === 0 || state.draft[i - 1]?.enabled !== row.enabled
                  }
                  onClick={(event) => {
                    move(i, -1);
                    retainMovedRowFocus(event.currentTarget);
                  }}
                >
                  {labels.up}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`${labels.down}: ${row.label}`}
                  disabled={
                    !state.editable ||
                    i === state.draft.length - 1 ||
                    state.draft[i + 1]?.enabled !== row.enabled
                  }
                  onClick={(event) => {
                    move(i, 1);
                    retainMovedRowFocus(event.currentTarget);
                  }}
                >
                  {labels.down}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`${row.enabled ? labels.disable : labels.enable}: ${row.label}`}
                  disabled={!state.editable}
                  onClick={() => {
                    const rows = state.draft.map((r) =>
                      r.id === row.id ? { ...r, enabled: !r.enabled } : r,
                    );
                    state.change([
                      ...rows.filter((r) => r.enabled),
                      ...rows.filter((r) => !r.enabled),
                    ]);
                  }}
                >
                  {row.enabled ? labels.disable : labels.enable}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          disabled={!state.editable || !changed}
          onClick={() => void state.save()}
        >
          {labels.save}
        </Button>
        {props.onReload && (
          <Button
            type="button"
            disabled={state.pending || state.ambiguous}
            onClick={() => void state.reload()}
          >
            {labels.reload}
          </Button>
        )}
        {state.pending ? (
          <p role="status">{feedback.pending}</p>
        ) : (
          message && <p role="status">{message}</p>
        )}
        {state.ambiguous && props.onReconcile && (
          <Button type="button" disabled={state.pending} onClick={() => void state.reconcile()}>
            {feedback.reconcile}
          </Button>
        )}
      </CardContent>
    </Surface>
  );
}
