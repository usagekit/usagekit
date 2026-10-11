"use client";
import { ProjectChainEditor } from "@/components/usagekit/provider-project-chain";
import type { ProjectChainProps } from "@/components/usagekit/provider-project-chain";
export { useProjectChainController } from "@/components/usagekit/provider-project-chain";
export type {
  ProjectChainProps,
  ProjectChainSnapshot,
  ProjectChainCommand,
  ProjectChainResult,
} from "@/components/usagekit/provider-project-chain";
import { useLayoutEffect, useRef, useState } from "react";
import { useProviderAction } from "@usagekit/react";
import type { ProviderAction } from "@usagekit/react";
import type { ProviderConnection } from "@usagekit/views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ProviderActionFeedback,
  providerFeedbackLabels,
} from "@/components/usagekit/provider-feedback";
import { retainMovedRowFocus, usageMotion } from "@/components/usagekit/usage-motion";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import { providerChainLabels } from "@/components/usagekit/provider-project-controller";
import type { ProviderChainLabels } from "@/components/usagekit/provider-project-controller";
export { providerChainLabels } from "@/components/usagekit/provider-project-controller";
export type { ProviderChainLabels } from "@/components/usagekit/provider-project-controller";

/** Slides reordered items from their previous position; skipped for reduced motion. */
function useReorderMotion(order: readonly string[]) {
  const items = useRef(new Map<string, HTMLElement>());
  const before = useRef<Map<string, number> | null>(null);
  const capture = () => {
    before.current = new Map(
      [...items.current].map(([id, item]) => [id, item.getBoundingClientRect().top]),
    );
  };
  const orderKey = order.join("\n");
  const committedOrder = useRef(orderKey);
  useLayoutEffect(() => {
    if (committedOrder.current === orderKey) return;
    committedOrder.current = orderKey;
    const previous = before.current;
    before.current = null;
    if (!previous || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const [id, item] of items.current) {
      const top = previous.get(id);
      const delta = top === undefined ? 0 : top - item.getBoundingClientRect().top;
      if (delta && typeof item.animate === "function")
        item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 320,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        });
    }
  }, [orderKey]);
  const ref = (id: string) => (item: HTMLElement | null) => {
    if (item) items.current.set(id, item);
    else items.current.delete(id);
  };
  return { capture, ref };
}

type ConnectionChainProps = {
  mode?: "connection";
  connection: ProviderConnection;
  action?: ProviderAction;
  connections: readonly ProviderConnection[];
  labels?: Partial<ProviderChainLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
  showMembershipControls?: boolean;
};
export function ProviderChainEditor(props: ConnectionChainProps | ProjectChainProps) {
  if (props.mode === "project")
    return <ProjectChainEditor {...props} labels={{ ...providerChainLabels, ...props.labels }} />;
  return <ConnectionChainEditor {...props} />;
}
function ConnectionChainEditor({
  connection,
  action: guardedAction,
  connections,
  labels: custom,
  feedbackLabels,
  showMembershipControls = true,
}: ConnectionChainProps) {
  const labels = { ...providerChainLabels, ...custom };
  const feedback = { ...providerFeedbackLabels, ...feedbackLabels };
  const sharedAction = useProviderAction();
  const action = guardedAction ?? sharedAction;
  const [chain, setChain] = useState<readonly string[]>([...connection.fallbackChain]);
  const editable =
    action.canWrite &&
    !action.pending &&
    !action.ambiguous &&
    action.state !== "conflict" &&
    connection.capabilities.includes("settings");
  const submitted = action.submittedCommand;
  const shown =
    (action.pending || action.ambiguous) &&
    submitted?.kind === "settings" &&
    submitted.connectionId === connection.id &&
    submitted.changes.fallbackChain
      ? submitted.changes.fallbackChain
      : chain;
  const motion = useReorderMotion(shown);
  const move = (index: number, delta: number) => {
    const next = [...chain];
    const other = index + delta;
    [next[index], next[other]] = [next[other]!, next[index]!];
    motion.capture();
    setChain(next);
  };
  const changed = shown.join("\n") !== connection.fallbackChain.join("\n");
  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <CardTitle className="leading-snug">{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="cn-usage-gap-md flex flex-col">
        {shown.length > 0 ? (
          <ol className="m-0 list-none space-y-2 p-0">
            {shown.map((id, index) => {
              const item = connections.find((value) => value.id === id);
              const name = item?.label ?? id;
              return (
                <li
                  key={id}
                  ref={motion.ref(id)}
                  className={`cn-usage-item cn-usage-gap-sm relative flex min-w-0 flex-col border-border bg-card ${usageMotion.enter}`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <span
                      aria-hidden
                      className="cn-usage-index flex shrink-0 items-center justify-center bg-muted font-semibold tabular-nums"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 break-all font-medium">{name}</span>
                    <Badge variant="outline" className="cn-usage-tag font-normal">
                      {item?.enabled ? labels.enabled : labels.disabled}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`${labels.up}: ${name}`}
                      disabled={!editable || index === 0}
                      onClick={(event) => {
                        move(index, -1);
                        retainMovedRowFocus(event.currentTarget);
                      }}
                    >
                      <svg
                        aria-hidden
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
                      </svg>
                      {labels.up}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`${labels.down}: ${name}`}
                      disabled={!editable || index === shown.length - 1}
                      onClick={(event) => {
                        move(index, 1);
                        retainMovedRowFocus(event.currentTarget);
                      }}
                    >
                      <svg
                        aria-hidden
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8 3.5v9M4 8.5l4 4 4-4" />
                      </svg>
                      {labels.down}
                    </Button>
                    {showMembershipControls && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`${labels.remove}: ${name}`}
                        disabled={!editable}
                        onClick={() => setChain(chain.filter((value) => value !== id))}
                      >
                        {labels.remove}
                      </Button>
                    )}
                    {item && item.capabilities.includes("settings") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!editable}
                        onClick={() =>
                          void action.run({
                            kind: "settings",
                            commandId: crypto.randomUUID(),
                            connectionId: item.id,
                            expectedRevision: item.revision,
                            changes: { enabled: !item.enabled },
                          })
                        }
                      >
                        {item.enabled ? labels.disable : labels.enable} {item.label}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="cn-usage-empty cn-usage-body border-border text-muted-foreground">
            {labels.empty}
          </p>
        )}
        {showMembershipControls &&
          connections.some((item) => item.id !== connection.id && !shown.includes(item.id)) && (
            <div className="flex flex-wrap gap-2">
              {connections
                .filter((item) => item.id !== connection.id && !shown.includes(item.id))
                .map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!editable}
                    onClick={() => setChain([...chain, item.id])}
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
                    {labels.add}: {item.label}
                  </Button>
                ))}
            </div>
          )}
        <div className="border-t border-border pt-4">
          <Button
            type="button"
            disabled={!editable || !changed}
            onClick={() =>
              void action.run({
                kind: "settings",
                commandId: crypto.randomUUID(),
                connectionId: connection.id,
                expectedRevision: connection.revision,
                changes: { fallbackChain: [...chain] },
              })
            }
          >
            {labels.save}
          </Button>
        </div>
        <ProviderActionFeedback action={action} labels={feedback} />
      </CardContent>
    </Card>
  );
}
