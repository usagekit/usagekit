"use client";
import {
  CredentialDisconnect,
  CredentialFields,
  CredentialIdentity,
} from "@/components/usagekit/provider-credential-controls";
import type { ConnectProps } from "@/components/usagekit/provider-credential-controls";
export type { ConnectProps } from "@/components/usagekit/provider-credential-controls";
import { useState } from "react";
import { useProviderManagementBinding } from "@usagekit/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ProviderActionFeedback,
  providerFeedbackLabels,
} from "@/components/usagekit/provider-feedback";
import { useCredentialForm } from "@/components/usagekit/provider-credential-state";
import { UsageNotice } from "@/components/usagekit/usage-motion";
import { providerConnectLabels } from "@/components/usagekit/provider-credential-controls";
export { providerConnectLabels } from "@/components/usagekit/provider-credential-controls";
export type { ProviderConnectLabels } from "@/components/usagekit/provider-credential-controls";
export function ProviderConnectForm(props: ConnectProps) {
  const context = useProviderManagementBinding();
  const identity = JSON.stringify([
    context?.binding,
    props.provider.id,
    props.connection?.id,
    props.connection?.fundingSource,
    props.fundingSource,
    props.requireTest,
    props.reuseStoredCredentials,
    props.requireNewCredentials,
    props.readOnlyCredentials,
  ]);
  const [retained, setRetained] = useState({ port: context?.port, identity, epoch: 0 });
  if (retained.port !== context?.port || retained.identity !== identity)
    setRetained({ port: context?.port, identity, epoch: retained.epoch + 1 });
  return <CredentialForm key={retained.epoch} {...props} />;
}
function CredentialForm({
  action: guardedAction,
  provider,
  connection,
  fundingSource,
  oauth,
  onConnected,
  labels: custom,
  feedbackLabels,
  requireTest = false,
  reuseStoredCredentials = false,
  requireNewCredentials = false,
  readOnlyCredentials = false,
  formId,
  renderFooter,
  renderTestFeedback,
  onPendingChange,
  onDismissalBlockedChange,
  renderFields,
  validateCredentials,
}: ConnectProps) {
  const labels = { ...providerConnectLabels, ...custom };
  const feedback = { ...providerFeedbackLabels, ...feedbackLabels };
  const {
    action,
    id,
    secrets,
    label,
    source,
    error,
    testResult,
    canSave,
    editable,
    capabilities,
    fields,
    submit,
    clear,
    changeSource,
    change,
    setLabel,
  } = useCredentialForm({
    action: guardedAction,
    provider,
    connection,
    fundingSource,
    onConnected,
    requireTest,
    reuseStoredCredentials,
    requireNewCredentials,
    readOnlyCredentials,
    formId,
    onPendingChange,
    onDismissalBlockedChange,
    validateCredentials,
    labels,
    feedback,
  });
  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <CardTitle className="leading-snug">{labels.title}</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{provider.label}</span> {labels.secretHint}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-4 flex flex-col">
        <form
          id={id}
          aria-label={`${provider.label} ${labels.form}`}
          className="gap-4 flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(connection ? "reconnect" : "connect");
          }}
        >
          {!connection && (
            <CredentialIdentity
              id={id}
              provider={provider}
              label={label}
              source={source}
              editable={editable}
              labels={labels}
              feedback={feedback}
              changeLabel={setLabel}
              changeSource={changeSource}
            />
          )}
          <CredentialFields
            id={id}
            source={source}
            fields={fields}
            values={secrets}
            editable={editable}
            renderFields={renderFields}
            change={change}
          />
          <p className="text-xs/relaxed text-muted-foreground">{labels.testHint}</p>
          {requireTest && !capabilities.includes("test") && (
            <UsageNotice tone="error" role="alert">
              {labels.testUnavailable}
            </UsageNotice>
          )}
          {error && (
            <UsageNotice key={error} tone="error" role="alert">
              {error}
            </UsageNotice>
          )}
          <div className="flex flex-wrap gap-2">
            {!renderFooter && capabilities.includes(connection ? "reconnect" : "connect") && (
              <Button type="submit" disabled={!editable || !canSave}>
                {connection ? labels.reconnect : labels.connect}
              </Button>
            )}
            {capabilities.includes("test") && (
              <Button
                type="button"
                variant="outline"
                disabled={!editable}
                onClick={() => void submit("test")}
              >
                {labels.test}
              </Button>
            )}
          </div>
        </form>
        {oauth}
        {testResult && renderTestFeedback?.(testResult)}
        {renderFooter?.({
          formId: id,
          canSave:
            editable && canSave && capabilities.includes(connection ? "reconnect" : "connect"),
          pending: action.pending,
          dismissalBlocked: action.pending || action.ambiguous,
        })}
        {connection && capabilities.includes("disconnect") && (
          <CredentialDisconnect
            connection={connection}
            action={action}
            labels={labels}
            editable={editable}
            clear={clear}
          />
        )}
        <ProviderActionFeedback action={action} labels={feedback} />
      </CardContent>
    </Card>
  );
}
