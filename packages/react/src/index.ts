"use client";

/** React hooks over the usagekit view models. No fetch and no primitives: hosts render the data. */
export { MeterProvider, useMeterBinding } from "./context.js";
export type { MeterBinding, SharedMeterBinding } from "./context.js";
export {
  useUsageView,
  useBudgetsView,
  useCoverageView,
  useExceptionsView,
  useHeaderStatus,
  useUsageSummary,
  useDefinedBudgets,
} from "./hooks.js";
export { useView, serialize } from "./use-view.js";
export type { Binding, HookState, ViewResult } from "./use-view.js";
export { createMeterQueryClient, MeterQueryClient } from "./query-client.js";
export type { QueryClientOptions } from "./query-client.js";
export type { BudgetWriter, BudgetSaveResult, BudgetReconciliation } from "./writer.js";
export { useBudgetMutation } from "./budget-mutation.js";
export type { BudgetMutationOptions, BudgetMutation } from "./budget-mutation.js";
export type { BudgetMutationState } from "./mutation-state.js";
export { useBudgetEditor } from "./budget-editor.js";
export type { BudgetEditorOptions, BudgetEditor, BudgetEditorError } from "./budget-editor.js";
export { ProviderManagementProvider, useProviderManagementBinding } from "./provider-context.js";
export type {
  ProviderManagementBinding,
  SharedProviderManagementBinding,
} from "./provider-context.js";
export { ProviderQueryClient, createProviderQueryClient } from "./provider-read-client.js";
export {
  useProviderRead,
  useProviderConnections,
  useProviderConnection,
  useProviderBalance,
  useProviderProjection,
  useProviderAllocations,
} from "./provider-hooks.js";
export type { ProviderHookBinding, ProviderViewResult } from "./provider-hooks.js";
export { useProviderAction } from "./provider-action.js";
export type { ProviderAction, ProviderActionOptions } from "./provider-action.js";
export type { ProviderActionState } from "./provider-action-state.js";
export { useProviderEditor } from "./provider-editor.js";
export type {
  ProviderEditor,
  ProviderEditorOptions,
  ProviderEditorRefreshKind,
} from "./provider-editor.js";
export { useBudgetProjection } from "./budget-projection.js";
