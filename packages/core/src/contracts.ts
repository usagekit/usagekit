import type {
  BillingImportInput,
  BillingImportResult,
  BillingImportsQuery,
  BillingImportsPage,
} from "./billing.js";

export type ValidationFailure = { outcome: "invalid"; field: string; reason: string };

/** Exact USD units: 1 unit = 1/10000 cent. */
export type Money = { units: bigint; currency: "USD" };

/** Amount = value * 10^-scale. Scale is a nonnegative integer. */
export type Quantity = { value: bigint; scale: number; unit: string };

export type AccessCredential = {
  /** Host-defined kind, for example "api_key" | "personal_token" | "oauth_client" | "session". */
  kind: string;
  /** Stable identifier of that credential in the host. Never the secret. */
  id: string;
};

/**
 * Two separate identities: accessCredential authenticates the caller to the host and
 * remains stable across provider rotation. providerCredentialVersion identifies the
 * provider connection's secret version at dispatch, never the caller.
 */
export type Scope = {
  namespace: string;
  /** Budget owner: user, team, or the platform's own principal. */
  principal: string;
  /** Initiating identity when it differs from the owner: a member, a guest session, a worker. */
  actor?: string;
  group?: string;
  connection: string;
  /** Who called the host application. Used for per-token budgets and attribution. */
  accessCredential?: AccessCredential;
  /** Which provider secret version was used. Rotation identity, not caller identity. */
  providerCredentialVersion?: string;
  /**
   * Connection labels snapshotted at reservation: 1..16 unique entries, each 1..64 characters
   * matching [a-z0-9][a-z0-9_.:-]*, sorted before storage. Attribution only: excluded from
   * reserve identity, so a replay keeps the first reservation's tags.
   */
  tags?: readonly string[];
};

export type FundingSource = "byok" | "platform";
export type Surface = "app" | "programmatic";
export type Source = "app" | "worker" | "api" | "sdk" | "cli" | "mcp" | "proxy" | "import";

/** Timestamps are UTC ISO strings. Resolved reservation epochs remain immutable. */
export type BudgetWindow =
  | { kind: "calendar_month"; timezone: "UTC" }
  | { kind: "provider_cycle"; cycleId: string; startsAt: string; endsAt: string }
  | { kind: "rolling"; days: number }
  | { kind: "since_reset"; epoch: string; startsAt: string };

/**
 * Each variant names one constraint in a namespace.
 * A platform_pool bounds spend shared by many principals and applies to operations
 * naming that pool in ReserveInput. It is not the platform principal's own budget.
 * A tag bounds every operation whose scope.tags contains it, across principals.
 * A wallet is not a budget: the host ledger owns balances, holds and charges,
 * coordinated through the host credit bridge. A wallet-level monthly cap may still
 * be a principal Budget because the cap is a constraint, not a balance.
 */
export type BudgetScope =
  | { kind: "principal"; namespace: string; principal: string }
  | { kind: "group"; namespace: string; group: string }
  | { kind: "connection"; namespace: string; connection: string }
  | { kind: "access_credential"; namespace: string; accessCredential: AccessCredential }
  | { kind: "platform_pool"; namespace: string; poolId: string }
  | { kind: "tag"; namespace: string; tag: string };

/**
 * surface selects the traffic a budget bounds: "any" matches every operation, a Surface
 * matches operations whose source belongs to that surface group (see sourcesOf), and a
 * Source matches exactly that source. Hosts set surface and source at authentication.
 */
export type Budget = {
  id: string;
  version: number;
  scope: BudgetScope;
  surface: Surface | Source | "any";
  unit: string;
  limit: Quantity | null;
  window: BudgetWindow;
  /** block denies past limit. allow admits with a warning; wire and stored rows may still say the deprecated alias for allow. */
  onExceed: "block" | "allow";
  /** Only with onExceed allow: same unit as limit and greater than it. Exceeding it denies admission. */
  hardLimit?: Quantity;
  /** At most eight thresholds in ascending order; each crossing is reported once per epoch. */
  alerts?: readonly BudgetAlert[];
};

/** percent is an integer 1..100 of limit; a Quantity threshold is in the budget unit. */
export type BudgetAlert = { at: { percent: number } | Quantity };

/**
 * Reported by the command whose admitted or settled figures first reach the threshold.
 * The store records each crossing atomically per budget id, epoch and threshold, so a
 * replay returns the stored crossings and no later command reports the same one again.
 */
export type BudgetAlertCrossed = {
  budgetId: string;
  budgetVersion: number;
  epoch: string;
  at: BudgetAlert["at"];
  used: Quantity;
  reserved: Quantity;
};

export type LifecycleState = "reserved" | "dispatch_intended" | "pending" | "settled" | "released";
export type Certainty = "measured" | "estimated" | "unknown";

export type Measurement =
  | { unit: string; quantity: Quantity; certainty: "measured" | "estimated" }
  | { unit: string; quantity: null; certainty: "unknown" };

export type Cost =
  | { certainty: "measured" | "estimated"; money: Money }
  | { certainty: "unknown"; money: null };

/**
 * Receipt certainty is derived from its measurements and cost, never stored separately.
 * Corrections append a receipt whose supersedes ID names an existing receipt.
 * Effective evidence is the latest receipt not superseded by another receipt.
 * Superseded receipts remain in the operation's history.
 */
export type Receipt = {
  id: string;
  /** Existing receipts without this field are dispatch evidence. */
  source?: "dispatch" | "probe" | "import";
  supersedes?: string;
  measurements: readonly Measurement[];
  cost: Cost;
  providerRequestId?: string;
  providerPriceVersion?: string;
  evidenceRef?: string;
  occurredAt: string;
  recordedAt: string;
  cached: boolean;
  failed: boolean;
};

/**
 * Store selects all applying budgets atomically inside reserve; Meter's pre-resolution
 * is advisory and never sufficient for admission.
 * Match namespace and the bound: principal, group, connection, accessCredential by
 * kind and id, or poolId listed in platformPools. Match "any", the surface or the source.
 * Each applicable budget's unit must appear in estimate. A missing bounded unit is
 * a Meter validation error, not permission to bypass the bound. Store re-checks this
 * against current budgets. Units without budgets are recorded without a bound.
 * Use the current budget version at reservation time; snapshot its resolved epoch
 * and version into budgetEpochs. Check every applying budget in one atomic command.
 * Return the first exceeded bound in deterministic host-policy order; the default
 * is defaultBudgetOrder: platform_pool, principal, group, tag, connection, access_credential.
 * A guest session is actor, not budget owner. The platform or a dedicated guest
 * principal owns the operation; its pool and host-enforced session limit both apply.
 */
export type ReserveInput = {
  /** Durable dispatch identity. Reuse with different semantics is a conflict. */
  operationId: string;
  /** Undispatched lifetime, 1..86400000 ms; defaults to five minutes. Replay never extends it.
   * Queued hosts must take dispatch intent at enqueue and carry the lease, or cover queue delay with this lifetime.
   */
  reservationTtlMs?: number;
  scope: Scope;
  fundingSource: FundingSource;
  /** Platform pools this operation draws from, when the provider key is platform-funded. */
  platformPools?: readonly string[];
  costOwner: string;
  creditAccountRef?: string;
  customerPriceVersion?: string;
  surface: Surface;
  source: Source;
  provider: string;
  operation: string;
  estimate: readonly Quantity[];
  /** Set by a Meter that resolved the estimate from a catalog; hosts may set it themselves. */
  estimateSource?: EstimateSource;
  /** "<provider>:<validFrom>" of the list price row behind the estimate. */
  providerPriceVersion?: string;
  correlationId?: string;
  parentOperationId?: string;
};

/** Expiry fences dispatch. Explicit release or expiry maintenance changes state; reads never mutate. */
export type Operation = ReserveInput & {
  reservationExpiresAt: string;
  state: LifecycleState;
  version: number;
  createdAt: string;
  updatedAt: string;
  budgetEpochs: readonly {
    budgetId: string;
    budgetVersion: number;
    epoch: string;
    startsAt: string;
    endsAt: string | null;
  }[];
  /** Append-only, oldest first. Corrections never remove historical receipts. */
  receipts: readonly Receipt[];
  /** Dispatch or recovery lease. Expired leases remain visible until replaced. */
  lease: Lease | null;
};

/**
 * Identical operationId and semantic fields return replayed: true in any lifecycle state.
 * A replay never authorizes dispatch. Different semantic fields return semantic_mismatch.
 * Budget denial returns AllowanceExceeded data, not an expected-outcome exception.
 */
export type ReserveResult =
  | ValidationFailure
  | { outcome: "invalid"; reason: "missing_estimate_unit"; unit: string; operation: null }
  | {
      outcome: "reserved";
      replayed: false;
      operation: Operation;
      warnings: readonly AllowanceExceeded[];
      alerts: readonly BudgetAlertCrossed[];
    }
  | {
      outcome: "reserved";
      replayed: true;
      operation: Operation;
      warnings: readonly AllowanceExceeded[];
      alerts: readonly BudgetAlertCrossed[];
    }
  | { outcome: "exceeded"; exceeded: AllowanceExceeded; operation: null }
  | { outcome: "conflict"; reason: "semantic_mismatch"; operation: Operation }
  /**
   * The BYOK connection's tracking policy is passthrough for this operation, or the catalog
   * marks it free: counted with state passthrough, never reserved. The caller may forward the call.
   */
  | { outcome: "passthrough"; replayed: boolean; operation: null }
  /**
   * No estimate was given and the catalog does not know the operation: counted with state
   * unpriced, never reserved. Host policy decides whether to forward the call.
   */
  | { outcome: "unpriced"; replayed: boolean; operation: null };

/** Where a reserve estimate came from, in resolution order. */
export type EstimateSource = "manual" | "measured" | "list" | "unknown";

/**
 * Meter reserve input. For BYOK with a catalog, estimate may be omitted: the Meter resolves it
 * for the connection and request options. Billable platform-funded calls require a host
 * customer-price estimate; catalog-declared nonbillable calls are counted without a reservation.
 * Store reservations always receive a ReserveInput.
 */
export type MeterReserveInput = Omit<ReserveInput, "estimate"> & {
  /** BYOK may omit for catalog resolution; billable platform calls require host customer pricing. */
  estimate?: readonly Quantity[];
  /** Request options that move the price, read from the request by the descriptor. */
  options?: Readonly<Record<string, string>>;
};

/** Authorized advisory estimate. No operation identity or accounting side effects. */
export type MeterQuoteInput = Omit<
  MeterReserveInput,
  "operationId" | "reservationTtlMs" | "correlationId" | "parentOperationId"
>;
export type MeterQuote = {
  quantities: readonly Quantity[];
  /** Matches stored reservation provenance; omitted when none was supplied or resolved. */
  estimateSource?: EstimateSource;
  providerPriceVersion?: string;
  checkedAt?: string;
  sampleSize?: number;
  tracking: "metered" | "passthrough" | "unpriced";
  budgets: readonly BudgetStatus[];
  asOf: string;
};

/**
 * Non-operation outcomes, counted per state and never reserved. Metered requests are the
 * operations themselves and are not counted here.
 */
export type RequestState = "passthrough" | "unpriced" | "cached" | "rate_limited";
/**
 * One counted request. commandId is the replay key: an identical replay counts once and returns
 * replayed: true; a changed payload under the same commandId is a conflict. Counts carry no
 * content and never touch budgets.
 */
export type CountRequestInput = {
  commandId: string;
  scope: Scope;
  surface: Surface;
  source: Source;
  provider: string;
  operation: string;
  state: RequestState;
  platformPools?: readonly string[];
};
export type CountRequestResult =
  | ValidationFailure
  | { outcome: "counted"; replayed: boolean }
  | { outcome: "conflict"; reason: "command_mismatch" };
/** Requests counted at store time in [from, to), with the scope and access rules of usage. */
export type RequestCountsQuery = {
  scope: UsageScope;
  from: string;
  to: string;
  connection?: string;
  groupBy: readonly ("provider" | "operation" | "connection" | "source" | "day")[];
  /** Rows per page, 1..1000, default 1000; truncated reports more rows. */
  limit?: number;
};
/** One row per dimension combination and state, ordered by dimensions then state. */
export type RequestCountRow = {
  dimensions: Readonly<Record<string, string>>;
  state: RequestState;
  count: bigint;
};
export type RequestCountsPage = {
  rows: readonly RequestCountRow[];
  asOf: string;
  truncated: boolean;
};

export type OperationRef = Pick<Scope, "namespace" | "principal"> & { operationId: string };
export type OperationCommand = OperationRef & {
  /** Replay key for this mutation; checked before optimistic version validation. */
  commandId: string;
  expectedVersion: number;
};
/**
 * An active dispatch lease permits the first upstream call and settlement by its holder.
 * Renew for long calls. Expiry changes no operation state and never permits redispatch.
 * Each recovery claim issues a new leaseId and fences the previous holder out.
 * Implementations bind the caller to the authenticated holder, not a caller-supplied assertion.
 */
export type Lease = { leaseId: string; holder: string; expiresAt: string };

/**
 * Only the first intent returns granted: true. Replaying its commandId returns
 * already_dispatched, as does another commandId on an already intended operation.
 * Neither replay nor lease expiry grants another upstream call.
 */
export type DispatchGrant =
  | ValidationFailure
  | { granted: true; operation: Operation; lease: Lease }
  | {
      granted: false;
      operation: Operation | null;
      reason:
        | "already_dispatched"
        | "version_conflict"
        | "not_reserved"
        | "released"
        | "reservation_expired";
    };

export type DispatchIntentInput = OperationCommand & {
  /** Opaque worker identity used for fencing and diagnostics. */
  holder: string;
  leaseTtlMs: number;
};
/**
 * No command journal or commandId. Renewal uses max(current expiry, now + TTL).
 * Repeating at the same clock instant is idempotent; a later retry can extend expiry.
 * It never shortens the lease, changes the operation version, or regrants dispatch.
 */
export type LeaseRenewalInput = OperationRef & { leaseId: string; leaseTtlMs: number };

/**
 * Only the current holder may renew an active lease. Renewal after expiry fails.
 * A rejected holder must stop work and hand over to recovery.
 */
export type LeaseRenewal =
  | ValidationFailure
  | { renewed: true; lease: Lease }
  | { renewed: false; reason: "expired" | "not_holder" | "not_active" };

export type RecoveryClaimInput = OperationRef & { holder: string; leaseTtlMs: number };

/**
 * Claim only dispatch_intended or pending operations with no active lease.
 * Issue a new leaseId; the previous holder is fenced out.
 * Recovery never redispatches. It resolves provider evidence or supported upstream
 * idempotency evidence, then settles, corrects, or leaves pending uncertain exposure.
 */
export type RecoveryClaim =
  | ValidationFailure
  | { claimed: true; operation: Operation; lease: Lease }
  | {
      claimed: false;
      operation: Operation | null;
      reason: "lease_active" | "not_recoverable" | "not_found";
    };

/**
 * Lease authority requires an active dispatch lease held by the caller.
 * Recovery authority requires the active lease issued by claimForRecovery.
 * Late evidence requires host authorization and no active lease. Settle accepts pending
 * only; correcting settled work requires replacesReceiptId and reason. Every new command
 * checks expectedVersion. Identical successful replays return the recorded result.
 * The store records source. This path needs no dispatch lease.
 */
export type Authority =
  | { kind: "lease"; leaseId: string }
  | { kind: "recovery"; leaseId: string }
  | { kind: "late_evidence"; source: string };

export type SettleInput = OperationCommand & { authority: Authority; receipt: Receipt };
/**
 * Host-authorized cancellation needs reserved state and an atomic version check, not a lease.
 * After dispatch intent, release always rejects with not_reserved.
 */
export type ReleaseInput = OperationCommand & { reason: string };
/** Same authority rules as settle; append only, with an existing receipt as the target. */
export type CorrectionInput = OperationCommand & {
  authority: Authority;
  receipt: Receipt;
  replacesReceiptId: string;
  reason: string;
};

/**
 * Identical command replay returns the stored result with replayed: true.
 * Reusing commandId with a different receipt returns receipt_conflict.
 * Successful accounting may retain pending state when exposure remains unknown.
 */
export type SettleResult =
  | ValidationFailure
  | {
      outcome: "settled";
      replayed: boolean;
      operation: Operation;
      alerts: readonly BudgetAlertCrossed[];
    }
  | {
      outcome: "rejected";
      reason:
        | "not_holder"
        | "lease_expired"
        | "version_conflict"
        | "invalid_state"
        | "receipt_conflict";
      operation: Operation | null;
    };

/** Identical successful command replay returns the stored result with replayed: true. */
export type ReleaseResult =
  | ValidationFailure
  | { outcome: "released"; replayed: boolean; operation: Operation }
  | {
      outcome: "rejected";
      reason: "not_reserved" | "version_conflict";
      operation: Operation | null;
    };

/** Requested data scope only; this is not authorization. Pool reads follow AccessContext pool rules. */
export type UsageScope =
  | { kind: "principal"; namespace: string; principal: string }
  | { kind: "group"; namespace: string; group: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "platform_pool"; namespace: string; poolId: string };

/**
 * Built by the host from its verified session or token.
 * HTTP builds this context from authentication, never the request body or query string.
 * Namespace must match. Principal and group scopes require their corresponding
 * readable list or "*". Connection and access-credential scopes require a readable
 * owning principal or group: the host resolver supplies ownership to Meter for authorization.
 * A pool scope requires readablePools membership, "*", or canManageBudgets.
 */
export type AccessContext = {
  namespace: string;
  /** Principals the caller may read. "*" means the whole namespace. */
  readablePrincipals: readonly string[] | "*";
  readableGroups: readonly string[] | "*";
  readablePools: readonly string[] | "*";
  canReadBillingDetail: boolean;
  canManageBudgets: boolean;
  /** Explicit billing write permission. Read access or budget management does not imply it. */
  canImportBilling?: boolean;
};

/**
 * groupBy: "principal" is allowed only for group or namespace scope.
 * "platform_pool" and "tag" explode one row per pool or tag of an operation, with an
 * empty dimension when the operation has none; those rows are not additive across tags.
 */
export type UsageQuery = {
  scope: UsageScope;
  from: string;
  to: string;
  connection?: string;
  units: readonly string[];
  groupBy: readonly (
    | "principal"
    | "provider"
    | "operation"
    | "surface"
    | "source"
    | "connection"
    | "day"
    | "access_credential"
    | "platform_pool"
    | "funding_source"
    | "tag"
  )[];
  cursor?: string;
  limit?: number;
};
export type UsageRow = {
  dimensions: Readonly<Record<string, string>>;
  measurements: readonly Measurement[];
  cost: Cost;
  fundingSource: FundingSource;
  costOwner: string;
  unknownOperations: bigint;
};
export type UsagePage = {
  rows: readonly UsageRow[];
  asOf: string;
  watermark: string;
  nextCursor?: string;
};
/**
 * Operations whose createdAt lies in [from, to), in one lifecycle state of states (all when
 * omitted), ordered by createdAt then operationId. Same scope and access rules as usage.
 * Pagination mirrors usage: the first page fixes membership and order at its watermark; later
 * pages take the cursor with the unchanged query and return each operation as currently stored.
 */
export type OperationsQuery = {
  scope: UsageScope;
  from: string;
  to: string;
  states?: readonly LifecycleState[];
  connection?: string;
  cursor?: string;
  limit?: number;
};
export type OperationsPage = {
  operations: readonly Operation[];
  asOf: string;
  watermark: string;
  nextCursor?: string;
};
/** Budgets defined for exactly this scope, regardless of any operation. */
export type DefinedBudgetsQuery = { scope: BudgetScope };

/**
 * All budgets that would apply to the operation's scope, surface, units and pools.
 * Requires the operation's principal to be readable. Statuses for unreadable pools
 * must redact budget.limit, used, reserved and remaining to null, with redacted: true.
 * Listing does not reserve capacity or replace the atomic admission check.
 */
export type ApplicableBudgetsQuery = {
  scope: Scope;
  surface: Surface;
  /** Include budgets bound to exactly this source. Omitted lists surface and any budgets only. */
  source?: Source;
  units: readonly string[];
  platformPools?: readonly string[];
};

export type BudgetStatus = {
  budget: Budget;
  epoch: { epoch: string; startsAt: string; endsAt: string | null };
  used: Quantity | null;
  reserved: Quantity | null;
  remaining: Quantity | null;
  /** Set when the caller may see that a bound applies but not its figures. */
  redacted?: true;
};

/** A scope wider than AccessContext is forbidden; never silently widen or narrow it. */
export type ReadResult<T> =
  | ValidationFailure
  | { outcome: "ok"; value: T }
  | { outcome: "forbidden" };

/** Data-only budget denial or warning. A P1 implementation may wrap it in a runtime error class. */
export interface AllowanceExceeded {
  readonly code: "allowance_exceeded";
  readonly budget: Budget;
  /** Which bound was crossed: limit warns on allow budgets and denies on block budgets; hardLimit always denies. */
  readonly boundary: "limit" | "hardLimit";
  readonly used: Quantity;
  readonly reserved: Quantity;
  readonly resetsAt: string | null;
}

/** Trusted maintenance command. Host authorizes namespace-wide cleanup; no provider call or charge is undone. */
export type ExpireReservationsInput = { namespace: string; limit?: number };
export type ExpireReservationsResult =
  | ValidationFailure
  | { outcome: "expired"; count: number; hasMore: boolean };

/**
 * One interface for embedded and remote implementations.
 * All reads require verified server context and return forbidden for unauthorized scope.
 * Meter validates inputs and resolves host policy; Store repeats all concurrent checks atomically.
 * Embedded hosts must schedule expireReservations themselves; the local server does so every thirty seconds.
 * Admission sweeps at most one default batch. Maintenance owns the remaining expired backlog.
 */
export interface Meter {
  quote(access: AccessContext, input: MeterQuoteInput): Promise<ReadResult<MeterQuote>>;
  importBilling(
    access: AccessContext,
    input: BillingImportInput,
  ): Promise<BillingImportResult | { outcome: "forbidden" }>;
  billingImports(
    access: AccessContext,
    query: BillingImportsQuery,
  ): Promise<ReadResult<BillingImportsPage>>;
  expireReservations(input: ExpireReservationsInput): Promise<ExpireReservationsResult>;
  reserve(input: MeterReserveInput): Promise<ReserveResult>;
  countRequest(input: CountRequestInput): Promise<CountRequestResult>;
  markDispatchIntent(input: DispatchIntentInput): Promise<DispatchGrant>;
  renewLease(input: LeaseRenewalInput): Promise<LeaseRenewal>;
  claimForRecovery(input: RecoveryClaimInput): Promise<RecoveryClaim>;
  settle(input: SettleInput): Promise<SettleResult>;
  correct(input: CorrectionInput): Promise<SettleResult>;
  releaseUndispatched(input: ReleaseInput): Promise<ReleaseResult>;
  getOperation(access: AccessContext, input: OperationRef): Promise<ReadResult<Operation | null>>;
  usage(access: AccessContext, query: UsageQuery): Promise<ReadResult<UsagePage>>;
  listOperations(
    access: AccessContext,
    query: OperationsQuery,
  ): Promise<ReadResult<OperationsPage>>;
  requestCounts(
    access: AccessContext,
    query: RequestCountsQuery,
  ): Promise<ReadResult<RequestCountsPage>>;
  definedBudgets(
    access: AccessContext,
    query: DefinedBudgetsQuery,
  ): Promise<ReadResult<readonly Budget[]>>;
  applicableBudgets(
    access: AccessContext,
    query: ApplicableBudgetsQuery,
  ): Promise<ReadResult<readonly BudgetStatus[]>>;
}

/** Trusted host admission policy; Store applies order in the atomic command. */
export type AdmissionPolicy = { budgetOrder: readonly BudgetScope["kind"][] };
export type BudgetOwner = Extract<BudgetScope, { kind: "principal" | "group" }>;
