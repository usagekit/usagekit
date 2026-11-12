import type {
  BudgetAlertCrossed,
  Cost,
  FundingSource,
  Money,
  Operation,
  Receipt,
  Scope,
  ValidationFailure,
} from "./contracts.js";
import type { BillingLine } from "./providers.js";

/** Trusted historical attribution for calls the application did not observe. */
export type ImportAttribution = {
  fundingSource: FundingSource;
  costOwner: string;
  creditAccountRef?: string;
  customerPriceVersion?: string;
  providerPriceVersion?: string;
  platformPools?: readonly string[];
};

/** A complete export for one connection and half-open window. Never grants dispatch. */
export type BillingImportInput = {
  scope: Scope;
  provider: string;
  /** Lower-case SHA-256 of the original file, computed before the atomic command. */
  fileHash: string;
  window: { from: string; to: string };
  /** null for the first import; the current import id for a revision. Prevents lost updates. */
  expectedPreviousImportId: string | null;
  attribution: ImportAttribution;
  lines: readonly BillingLine[];
};

/** Exact comparison. Unknown ledger cost remains unknown; signed differences are never prorated. */
export type ReconciliationEntry = {
  id: string;
  importId: string;
  scope: Scope;
  provider: string;
  /** Present for operation-specific aggregate evidence. */
  operation?: string;
  window: { from: string; to: string };
  kind: "aggregate" | "import_total";
  ledgerTotal: Cost;
  evidenceTotal: Money;
  /** evidenceTotal - ledgerTotal, or null when any observed cost is unknown. */
  differenceUnits: bigint | null;
  /** Fractional-cent scale of differenceUnits; omitted means 4. */
  differenceScale?: number;
  unknownOperations: bigint;
  evidenceRef: string;
};

export type BillingImportRecord = {
  id: string;
  scope: Scope;
  provider: string;
  fileHash: string;
  window: { from: string; to: string };
  recordedAt: string;
  supersedes?: string;
  /** Projected from the import family pointer; earlier evidence remains available. */
  supersededBy?: string;
  matchedOperationIds: readonly string[];
  unobservedOperationIds: readonly string[];
  reconciliations: readonly ReconciliationEntry[];
  alerts: readonly BudgetAlertCrossed[];
};

export type BillingImportResult =
  | ValidationFailure
  | { outcome: "imported"; replayed: boolean; record: BillingImportRecord }
  | {
      outcome: "rejected";
      reason:
        | "previous_import_conflict"
        | "payload_conflict"
        | "ambiguous_request"
        | "active_operation"
        | "operation_state"
        | "evidence_conflict";
      latestImportId: string | null;
      line?: number;
    };

export type BillingImportsQuery = {
  scope: { namespace: string; principal: string };
  connection: string;
  from: string;
  to: string;
  /** Include superseded import evidence; defaults to false. */
  history?: boolean;
  limit?: number;
};
export type BillingImportsPage = {
  records: readonly BillingImportRecord[];
  asOf: string;
  truncated: boolean;
};

/** Atomic adapter changes prepared against its transaction's operation snapshot. */
export type BillingOperationChange = {
  before: Operation | null;
  after: Operation;
  receipt: Receipt;
};
