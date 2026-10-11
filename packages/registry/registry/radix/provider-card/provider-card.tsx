"use client";
import type { ReactNode } from "react";
import { useProviderAction } from "@usagekit/react";
import type { ProviderAction } from "@usagekit/react";
import type { ProviderConnection } from "@usagekit/views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fundingLabel,
  ProviderActionFeedback,
  providerFeedbackLabels,
  ProviderTime,
} from "@/components/usagekit/provider-feedback";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
import { UsageStatus } from "@/components/usagekit/usage-motion";
import type { UsageTone } from "@/components/usagekit/usage-motion";
export const providerCardLabels = {
  enabled: "Enabled",
  disabled: "Disabled",
  enable: "Enable connection",
  disable: "Disable connection",
  manage: "Manage connection",
  test: "Test stored credentials",
  disconnect: "Disconnect",
  confirm: "Confirm disconnect",
  cancel: "Cancel",
  disconnectHint: "Disconnect this connection?",
  credential: "Credentials",
  stored: "Stored securely",
  missing: "Not configured",
  stale: "Stale evidence",
  observed: "Last observed",
  unknown: "Unknown",
  statusUnknown: "Status unknown",
  available: "Available",
  availabilityUnknown: "Availability unknown",
  unavailable: "Unavailable",
  connected: "Connected",
  disconnected: "Disconnected",
  needs_reauth: "Needs reconnection",
  pending: "Pending",
  error: "Error",
};
export type ProviderCardLabels = typeof providerCardLabels;
const statusTone: Record<ProviderConnection["status"]["state"], UsageTone> = {
  connected: "positive",
  disconnected: "neutral",
  needs_reauth: "exceeded",
  pending: "unknown",
  unknown: "unknown",
  error: "exceeded",
};
export function ProviderCard({
  connection,
  action: guardedAction,
  onManage,
  selected = false,
  labels: custom,
  feedbackLabels,
  identity,
  description,
  metadata,
  body,
  source,
  actions,
  onTest,
  onToggle,
  canEdit = true,
  formatTime,
}: {
  connection: ProviderConnection;
  action?: ProviderAction;
  onManage?: () => void;
  /** The connection currently open in an editor. */
  selected?: boolean;
  labels?: Partial<ProviderCardLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
  identity?: ReactNode;
  description?: ReactNode;
  metadata?: ReactNode;
  body?: ReactNode;
  source?: ReactNode;
  /** Receives a current write fence; hosts must apply it to their controls. */
  actions?:
    | ReactNode
    | ((context: { connection: ProviderConnection; canEdit: boolean }) => ReactNode);
  onTest?: (connection: ProviderConnection) => void | Promise<void>;
  onToggle?: (connection: ProviderConnection, enabled: boolean) => void | Promise<void>;
  canEdit?: boolean;
  formatTime?: (iso: string) => string;
}) {
  const labels = { ...providerCardLabels, ...custom };
  const feedback = { ...providerFeedbackLabels, ...feedbackLabels };
  const sharedAction = useProviderAction();
  const action = guardedAction ?? sharedAction;
  const writable = canEdit && action.canWrite && !action.pending && !action.ambiguous;
  const command = { connectionId: connection.id, expectedRevision: connection.revision };
  const test = () =>
    onTest
      ? onTest(connection)
      : action.run({ ...command, commandId: crypto.randomUUID(), kind: "test" });
  return (
    <Card
      data-selected={selected}
      className={`w-full min-w-0 transition-[box-shadow,border-color] duration-200 motion-reduce:transition-none ${selected ? "border-foreground/40 ring-1 ring-foreground/20" : ""}`}
    >
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <CardTitle className="min-w-0 break-words leading-snug">
            {identity}
            {connection.label}
          </CardTitle>
          <Badge variant="outline">{fundingLabel(connection.fundingSource, feedback)}</Badge>
        </div>
        <CardDescription className="flex flex-wrap gap-x-2">
          {description ?? <span>{connection.provider}</span>}
          {connection.plan && <span>{connection.plan}</span>}
        </CardDescription>
        {metadata}
      </CardHeader>
      <CardContent className="cn-usage-gap-md flex flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <UsageStatus tone={statusTone[connection.status.state]}>
            {connection.status.state === "unknown"
              ? labels.statusUnknown
              : labels[connection.status.state]}
          </UsageStatus>
          <UsageStatus tone={connection.enabled ? "positive" : "neutral"}>
            {connection.enabled ? labels.enabled : labels.disabled}
          </UsageStatus>
          <UsageStatus
            tone={
              connection.availability.state === "available"
                ? "positive"
                : connection.availability.state === "unavailable"
                  ? "exceeded"
                  : "unknown"
            }
          >
            {connection.availability.state === "unknown"
              ? labels.availabilityUnknown
              : labels[connection.availability.state]}
          </UsageStatus>
        </div>
        {connection.status.message && (
          <p className="cn-usage-body break-words">{connection.status.message}</p>
        )}
        {connection.availability.reason && (
          <p className="cn-usage-body break-words text-muted-foreground">
            {connection.availability.reason}
          </p>
        )}
        <dl className="cn-usage-body grid min-w-0 gap-3 border-t border-border pt-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="cn-usage-label text-muted-foreground">{labels.credential}</dt>
            <dd className="mt-1 break-words">
              {connection.credentialLabel ??
                (connection.hasStoredCredentials ? labels.stored : labels.missing)}
              {connection.credentialIssue && (
                <span className="cn-usage-meta block text-destructive">
                  {connection.credentialIssue}
                </span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="cn-usage-label text-muted-foreground">{labels.observed}</dt>
            <dd className="mt-1 break-words tabular-nums">
              {connection.freshness.observedAt ? (
                <ProviderTime value={connection.freshness.observedAt} formatTime={formatTime} />
              ) : (
                labels.unknown
              )}
              {connection.freshness.stale && (
                <span className="cn-usage-meta block text-muted-foreground">{labels.stale}</span>
              )}
            </dd>
          </div>
        </dl>
        {body}
        {source}
        <div className="flex flex-wrap gap-1.5">
          {onManage && (
            <Button
              type="button"
              size="sm"
              variant={selected ? "secondary" : "outline"}
              aria-pressed={selected}
              onClick={onManage}
            >
              {labels.manage}
            </Button>
          )}
          {connection.capabilities.includes("settings") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!writable}
              onClick={() =>
                void (onToggle
                  ? onToggle(connection, !connection.enabled)
                  : action.run({
                      kind: "settings",
                      ...command,
                      commandId: crypto.randomUUID(),
                      changes: { enabled: !connection.enabled },
                    }))
              }
            >
              {connection.enabled ? labels.disable : labels.enable}
            </Button>
          )}
          {connection.capabilities.includes("test") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!writable || !connection.hasStoredCredentials}
              onClick={() => void test()}
            >
              {labels.test}
            </Button>
          )}
        </div>
        {typeof actions === "function" ? actions({ connection, canEdit: writable }) : actions}
        <ProviderActionFeedback action={action} labels={feedback} />
      </CardContent>
    </Card>
  );
}
