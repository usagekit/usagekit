import type { AdmissionPolicy } from "@usagekit/core";
import type {
  BillingImportInput,
  BillingImportResult,
  BillingImportsQuery,
  BillingImportsPage,
} from "@usagekit/core";
import type {
  ExpireReservationsInput,
  ExpireReservationsResult,
  Budget,
  ApplicableBudgetsQuery,
  BudgetStatus,
  DefinedBudgetsQuery,
  CorrectionInput,
  DispatchGrant,
  DispatchIntentInput,
  LeaseRenewal,
  LeaseRenewalInput,
  Operation,
  OperationRef,
  RecoveryClaim,
  RecoveryClaimInput,
  ReleaseInput,
  ReleaseResult,
  ReserveInput,
  ReserveResult,
  SettleInput,
  SettleResult,
  UsagePage,
  UsageQuery,
  OperationsQuery,
  OperationsPage,
  CountRequestInput,
  CountRequestResult,
  RequestCountsQuery,
  RequestCountsPage,
} from "@usagekit/core";

/**
 * Authorization is the Meter's job; atomic condition checks are the Store's job.
 * Store does not take AccessContext. Meter resolves applicable budgets, funding and price policy.
 * Each command atomically re-checks state, version, lease ownership, budget headroom
 * including outstanding reservations, and command replay identity.
 * A Meter-side check is never sufficient. Expected rejections return typed outcomes, not exceptions.
 * Admission includes unsettled reservations across all applicable bounds.
 * Reserve selects current budgets atomically by namespace, scope, surface, units and pools.
 * Host ownership resolution, authorization and pool-figure redaction belong to Meter.
 * Adapters prove these guarantees through one conformance suite, without callback locks.
 */
export interface Store {
  importBilling(input: BillingImportInput): Promise<BillingImportResult>;
  billingImports(query: BillingImportsQuery): Promise<BillingImportsPage>;
  expireReservations(input: ExpireReservationsInput): Promise<ExpireReservationsResult>;
  reserve(input: ReserveInput, policy?: AdmissionPolicy): Promise<ReserveResult>;
  markDispatchIntent(input: DispatchIntentInput): Promise<DispatchGrant>;
  renewLease(input: LeaseRenewalInput): Promise<LeaseRenewal>;
  claimForRecovery(input: RecoveryClaimInput): Promise<RecoveryClaim>;
  settle(input: SettleInput): Promise<SettleResult>;
  correct(input: CorrectionInput): Promise<SettleResult>;
  releaseUndispatched(input: ReleaseInput): Promise<ReleaseResult>;
  /** Atomic, replay-safe count of one non-operation request; never reserves or touches budgets. */
  countRequest(input: CountRequestInput): Promise<CountRequestResult>;
  getOperation(input: OperationRef): Promise<Operation | null>;
  aggregate(query: UsageQuery): Promise<UsagePage>;
  listOperations(query: OperationsQuery): Promise<OperationsPage>;
  requestCounts(query: RequestCountsQuery): Promise<RequestCountsPage>;
  definedBudgets(query: DefinedBudgetsQuery): Promise<readonly Budget[]>;
  applicableBudgets(query: ApplicableBudgetsQuery): Promise<readonly BudgetStatus[]>;
}

export { createMemoryStore } from "./memory/memory-store.js";
export { createManualClock } from "./clock.js";
export type { Clock, ManualClock } from "./clock.js";
export { InvalidInput } from "./memory/state.js";
export { validateBudget, reachedAlerts, alertKey } from "./memory/admission.js";
export {
  validateCountRequest,
  validateRequestCountsQuery,
  countIdentity,
  countRows,
  bucketOf,
  requestCountDimensions,
} from "./memory/counters.js";
export type { CountBucket } from "./memory/counters.js";

export {
  prepareBillingImport,
  billingFamilyId,
  readBillingImports,
  validateBillingImportInput,
  validateBillingImportsQuery,
} from "./billing.js";
export type { StoredBillingImport, BillingSnapshot, BillingPreparation } from "./billing.js";

export {
  validateSettlementPolicy,
  validSettlementLink,
  settlementState,
  settledQuantity,
  validateMoneyPolicy,
} from "./memory/settlement.js";
