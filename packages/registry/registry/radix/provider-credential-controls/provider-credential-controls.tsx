"use client";
import { useState } from "react";
import type { ReactNode } from "react";
import type { ProviderAction } from "@usagekit/react";
import type { ProviderActionResult, ProviderConnection, ProviderDefinition } from "@usagekit/views";
import type { FundingSource } from "@usagekit/core";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { fundingLabel } from "@/components/usagekit/provider-feedback";
import { UsageSegmented, usageMotion } from "@/components/usagekit/usage-motion";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
export type ConnectProps = {
  action?: ProviderAction;
  provider: ProviderDefinition;
  connection?: ProviderConnection;
  fundingSource?: FundingSource;
  oauth?: ReactNode;
  onConnected?: (connection: ProviderConnection) => void;
  labels?: Partial<ProviderConnectLabels>;
  feedbackLabels?: Partial<ProviderFeedbackLabels>;
  requireTest?: boolean;
  reuseStoredCredentials?: boolean;
  requireNewCredentials?: boolean;
  readOnlyCredentials?: boolean;
  /** Host-owned form ID allows a sheet footer to submit without nesting forms. */
  formId?: string;
  renderFooter?: (context: {
    formId: string;
    canSave: boolean;
    pending: boolean;
    dismissalBlocked: boolean;
  }) => ReactNode;
  renderTestFeedback?: (result: ProviderActionResult) => ReactNode;
  /** Event notifications from submit, disconnect and explicit reconciliation. */
  onPendingChange?: (pending: boolean) => void;
  /** True for pending or ambiguous work; hosts fence dismissal with this value. */
  onDismissalBlockedChange?: (blocked: boolean) => void;
  /** Form adapters (including RHF/Zod) can replace fields without replacing execution policy. */
  renderFields?: (context: {
    fields: ProviderDefinition["credentialFields"];
    values: Readonly<Record<string, string>>;
    change: (name: string, value: string) => void;
    readOnly: boolean;
  }) => ReactNode;
  validateCredentials?: (values: Readonly<Record<string, string>>) => string | null;
};

export function CredentialDisconnect({
  connection,
  action,
  labels,
  editable,
  clear,
}: {
  connection: ProviderConnection;
  action: ProviderAction;
  labels: ProviderConnectLabels;
  editable: boolean;
  clear: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="border-t border-border pt-4">
      {confirm ? (
        <div
          className={`cn-usage-panel flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 ${usageMotion.enter}`}
        >
          <p className="cn-usage-title font-medium">{labels.disconnectHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!editable}
              onClick={() => {
                if (!editable || action.pending || action.ambiguous) return;
                setConfirm(false);
                clear();
                void action.run({
                  kind: "disconnect",
                  commandId: crypto.randomUUID(),
                  connectionId: connection.id,
                  expectedRevision: connection.revision,
                });
              }}
            >
              {labels.confirmDisconnect}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirm(false)}>
              {labels.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={!editable}
          onClick={() => {
            if (editable && !action.pending && !action.ambiguous) setConfirm(true);
          }}
        >
          {labels.disconnect}
        </Button>
      )}
    </div>
  );
}

export function CredentialFields({
  id,
  source,
  fields,
  values,
  editable,
  change,
  renderFields,
}: {
  id: string;
  source: FundingSource;
  fields: ProviderDefinition["credentialFields"];
  values: Readonly<Record<string, string>>;
  editable: boolean;
  change: (name: string, value: string) => void;
  renderFields?: ConnectProps["renderFields"];
}) {
  return renderFields ? (
    renderFields({ fields, values, change, readOnly: !editable })
  ) : (
    <>
      {fields.map((field) => (
        <div key={`${source}:${field.name}`} className={`space-y-2 ${usageMotion.enter}`}>
          <Label htmlFor={`${id}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.name}`}
            type={field.kind === "secret" ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[field.name] ?? ""}
            readOnly={!editable}
            placeholder={field.placeholder}
            onChange={(event) => change(field.name, event.target.value)}
          />
        </div>
      ))}
    </>
  );
}

export function CredentialIdentity({
  id,
  provider,
  label,
  source,
  editable,
  labels,
  feedback,
  changeLabel,
  changeSource,
}: {
  id: string;
  provider: ProviderDefinition;
  label: string;
  source: FundingSource;
  editable: boolean;
  labels: ProviderConnectLabels;
  feedback: ProviderFeedbackLabels;
  changeLabel: (value: string) => void;
  changeSource: (value: FundingSource) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${id}-label`}>{labels.label}</Label>
        <Input
          id={`${id}-label`}
          value={label}
          readOnly={!editable}
          onChange={(event) => {
            if (editable) changeLabel(event.target.value);
          }}
        />
      </div>
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="cn-usage-title mb-2 font-medium">{labels.funding}</legend>
        <UsageSegmented
          value={source}
          disabled={!editable}
          options={provider.fundingSources.map((value) => ({
            value,
            label: fundingLabel(value, feedback),
          }))}
          onChange={(value) => {
            if (editable) changeSource(value);
          }}
        />
      </fieldset>
    </>
  );
}

export const providerConnectLabels = {
  connect: "Connect",
  reconnect: "Replace credentials",
  test: "Test credentials",
  disconnect: "Disconnect",
  confirmDisconnect: "Confirm disconnect",
  cancel: "Cancel",
  disconnectHint: "Disconnect this connection?",
  title: "Connection credentials",
  secretHint: "Enter new credentials. Stored credentials are never displayed.",
  testHint: "Testing makes an explicit request to the provider. Saving is a separate action.",
  testUnavailable: "A credential test is required, but testing is unavailable for this connection.",
  label: "Connection name",
  required: "Enter the required credentials.",
  funding: "Funding source",
  form: "credentials",
};
export type ProviderConnectLabels = typeof providerConnectLabels;
