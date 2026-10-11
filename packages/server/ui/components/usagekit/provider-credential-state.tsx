"use client";
import { useId, useRef, useState } from "react";
import { useProviderAction } from "@usagekit/react";
import type { ProviderAction } from "@usagekit/react";
import type { ProviderActionResult, ProviderCommand } from "@usagekit/views";
import type { FundingSource } from "@usagekit/core";
import type { ConnectProps } from "@/components/usagekit/provider-credential-controls";
import type { ProviderConnectLabels } from "@/components/usagekit/provider-credential-controls";
import type { ProviderFeedbackLabels } from "@/components/usagekit/provider-feedback";
function useCredentialAction(
  action: ProviderAction,
  onPending?: ConnectProps["onPendingChange"],
  onBlocked?: ConnectProps["onDismissalBlockedChange"],
): ProviderAction {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const notify = (value: boolean, blocked: boolean) => {
    lock.current = value;
    setPending(value);
    onPending?.(value);
    onBlocked?.(blocked);
  };
  return {
    ...action,
    // Handlers can read the lock before React has rendered the pending state.
    get pending() {
      return action.pending || lock.current || pending;
    },
    run: async (command, secrets) => {
      notify(true, true);
      let blocked = true;
      try {
        const result = await action.run(command, secrets);
        blocked =
          result.commandId !== command.commandId ||
          (result.outcome === "unavailable" && result.ambiguous);
        return result;
      } finally {
        notify(false, blocked);
      }
    },
    reconcile: async () => {
      notify(true, true);
      let blocked = true;
      try {
        const result = await action.reconcile();
        blocked = !["success", "conflict", "not_applied"].includes(result.outcome);
        return result;
      } finally {
        notify(false, blocked);
      }
    },
  };
}
export function useCredentialForm({
  action: guardedAction,
  provider,
  connection,
  fundingSource,
  onConnected,
  requireTest = false,
  reuseStoredCredentials = false,
  requireNewCredentials = false,
  readOnlyCredentials = false,
  formId,
  onPendingChange,
  onDismissalBlockedChange,
  validateCredentials,
  labels,
  feedback,
}: ConnectProps & { labels: ProviderConnectLabels; feedback: ProviderFeedbackLabels }) {
  const sharedAction = useProviderAction();
  const action = useCredentialAction(
    guardedAction ?? sharedAction,
    onPendingChange,
    onDismissalBlockedChange,
  );
  const generatedId = useId();
  const id = formId ?? generatedId;
  const baseRevision = useRef(connection?.revision ?? "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(connection?.label ?? provider.label);
  const [source, setSource] = useState<FundingSource>(
    fundingSource ?? connection?.fundingSource ?? "byok",
  );
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<{
    values: Record<string, string>;
    source: FundingSource;
  } | null>(null);
  const [testResult, setTestResult] = useState<ProviderActionResult | null>(null);
  const version = useRef(0);
  const testCurrent =
    !!tested &&
    tested.source === source &&
    JSON.stringify(tested.values) === JSON.stringify(secrets);
  const canSave = !requireTest || testCurrent;
  const editable =
    !readOnlyCredentials &&
    action.canWrite &&
    !action.pending &&
    !action.ambiguous &&
    action.state !== "conflict";
  const capabilities = connection?.capabilities ?? provider.capabilities;
  const fields = provider.credentialFields.filter((field) =>
    (field.fundingSources ?? ["byok"]).includes(source),
  );
  const submit = async (kind: "test" | "connect" | "reconnect") => {
    if (
      action.pending ||
      !editable ||
      !capabilities.includes(kind === "test" ? "test" : connection ? "reconnect" : "connect")
    )
      return;
    if (kind !== "test" && !canSave) return;
    const reusing =
      reuseStoredCredentials &&
      !requireNewCredentials &&
      connection?.hasStoredCredentials &&
      connection.fundingSource === source &&
      Object.values(secrets).every((value) => !value.trim());
    const customError = validateCredentials?.(secrets);
    if (
      customError ||
      (!reusing && fields.some((field) => field.required && !secrets[field.name]?.trim()))
    ) {
      setError(customError ?? labels.required);
      return;
    }
    setError(null);
    // Credential values are an ephemeral execute argument, never part of the command or read cache.
    const token = ++version.current;
    const ephemeral = { ...secrets };
    const commandId = crypto.randomUUID();
    const command: ProviderCommand = connection
      ? kind === "test"
        ? {
            kind: "test",
            commandId,
            connectionId: connection.id,
            expectedRevision: baseRevision.current,
          }
        : {
            kind: "reconnect",
            commandId,
            connectionId: connection.id,
            expectedRevision: baseRevision.current,
          }
      : kind === "test"
        ? { kind: "test", commandId, provider: provider.id, fundingSource: source }
        : { kind: "connect", commandId, provider: provider.id, fundingSource: source, label };
    try {
      const result = await action.run(command, ephemeral);
      // Only this form's own confirmed test can advance its compare-and-set base.
      if (
        connection &&
        kind === "test" &&
        result.outcome === "success" &&
        result.commandId === commandId &&
        result.revision !== null
      )
        baseRevision.current = result.revision;
      if (version.current !== token) return;
      if (kind === "test") {
        setTestResult(result);
        // Changes during an in-flight test never acquire a tested signature.
        setTested(
          result.outcome === "success" &&
            result.commandId === commandId &&
            version.current === token
            ? { values: { ...secrets }, source }
            : null,
        );
      }
      if (kind !== "test" || result.outcome !== "success") {
        setSecrets({});
        setTested(null);
      }
      if (
        kind !== "test" &&
        result.outcome === "success" &&
        result.commandId === commandId &&
        result.connection
      )
        onConnected?.(result.connection);
    } catch {
      if (version.current === token) {
        setError(feedback.unavailable);
        setSecrets({});
        setTested(null);
      }
    } finally {
      for (const name of Object.keys(ephemeral)) delete ephemeral[name];
    }
  };
  const clear = () => {
    ++version.current;
    setSecrets({});
    setTested(null);
    setTestResult(null);
  };
  const changeSource = (value: FundingSource) => {
    setSource(value);
    clear();
  };
  const change = (name: string, value: string) => {
    if (!editable) return;
    ++version.current;
    setSecrets({ ...secrets, [name]: value });
    setTested(null);
    setTestResult(null);
  };
  return {
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
  };
}
