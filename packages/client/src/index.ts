import type { Meter } from "@usagekit/core";
import { transport } from "./transport.js";
import type { RemoteOptions } from "./transport.js";
export { RemoteUnavailable, RemoteHttpError } from "./transport.js";
export type { RemoteOptions } from "./transport.js";
/**
 * Implements the core Meter over HTTP. AccessContext is never sent as authorization.
 * The server derives it from the bearer token. No command is automatically retried.
 * After RemoteUnavailable, replay the same commandId (or operationId for reserve).
 * Renewal, recovery and expiry sweeps have no command journal: inspect the operation before retrying.
 * Billing imports are never retried automatically. After RemoteUnavailable, explicitly resend the
 * identical input, including fileHash and expectedPreviousImportId, to replay its durable result.
 */
export function createRemoteMeter(options: RemoteOptions): Meter {
  const request = transport(options);
  return {
    quote: (_access, q) => request("quote", q, true),
    importBilling: (_access, i) => request("importBilling", i),
    billingImports: (_access, q) => request("billingImports", q, true),
    expireReservations: (i) => request("expire", i),
    reserve: (i) => request("reserve", i),
    markDispatchIntent: (i) => request("intent", i),
    renewLease: (i) => request("renew", i),
    claimForRecovery: (i) => request("claim", i),
    settle: (i) => request("settle", i),
    correct: (i) => request("correct", i),
    releaseUndispatched: (i) => request("release", i),
    countRequest: (i) => request("count", i),
    requestCounts: (_access, q) => request("counts", q, true),
    getOperation: (_access, i) => request("operation", i, true),
    usage: (_access, q) => request("usage", q, true),
    listOperations: (_access, q) => request("operations", q, true),
    definedBudgets: (_access, q) => request("defined", q, true),
    applicableBudgets: (_access, q) => request("applicable", q, true),
  };
}
