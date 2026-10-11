import type {
  BalanceSnapshot,
  BillingLine,
  PriceRow,
  ProviderDescriptor,
  ProviderOperation,
  Quantity,
  Receipt,
} from "@usagekit/core";

/**
 * A provider request as data. The body is already parsed (JSON value or text), so extractors
 * stay synchronous and never consume a stream.
 */
export type ProviderRequest = {
  method: string;
  /** Absolute URL, or a path resolved against the descriptor's upstream. */
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
};
export type ProviderResponse = { status: number; headers?: Readonly<Record<string, string>> };

/** A receipt without identity and timestamps; the host wrapper adds id, occurredAt, recordedAt. */
export type ReceiptDraft = Omit<Receipt, "id" | "supersedes" | "occurredAt" | "recordedAt">;

export type EstimateInput = {
  operation: ProviderOperation;
  options: Readonly<Record<string, string>>;
  plan?: string;
  /** Past the plan allowance: only overage rows apply. */
  overage?: boolean;
  /** Rows valid at the catalog date, in descriptor order. */
  prices: readonly PriceRow[];
};

/** The only code in a descriptor. Every function is pure and synchronous. */
export type Extractors = {
  /** False means request uncertainty cannot be overridden by a host or BYOK price. */
  canEstimate?(options: Readonly<Record<string, string>>): boolean;
  /** True when documented surcharges require the list upper bound even with an override. */
  requiresListPriceFloor?(options: Readonly<Record<string, string>>): boolean;
  /** Estimate before the call from the matched operation, options and connection plan. Empty means no price. */
  estimate(input: EstimateInput): Quantity[];
  /** Options that select a price row, read from the request. Options are request data, never guessed. */
  options(operation: ProviderOperation, request: ProviderRequest): Record<string, string>;
  /** Receipt from the response; body is fully read. Returns unknown cost when evidence is absent. */
  extract(
    operation: ProviderOperation,
    request: ProviderRequest,
    response: ProviderResponse,
    body: unknown,
  ): ReceiptDraft;
  /** Provider request id for replay and reconciliation, when present. */
  requestId(body: unknown): string | undefined;
  /** Parse the balance probe body; without it the catalog reads the declared JSON pointers. */
  balance?(body: unknown): BalanceSnapshot;
  /** Parse a price-list endpoint body into PriceRow[] (for priceList.kind endpoint). */
  priceList?(body: unknown, checkedAt: string): PriceRow[];
  /** Parse a billing export into matchable lines. */
  billingExport?(input: unknown): BillingLine[];
};

export type ProviderModule = { descriptor: ProviderDescriptor; extractors: Extractors };
