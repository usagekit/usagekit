import type {
  Meter,
  MeterQuoteInput,
  AccessContext,
  OperationRef,
  UsageQuery,
  OperationsQuery,
  DefinedBudgetsQuery,
  ApplicableBudgetsQuery,
  RequestCountsQuery,
  BillingImportsQuery,
} from "@usagekit/core";
import type { RouteName } from "../schemas/index.js";
export function dispatchRead(meter: Meter, access: AccessContext, name: RouteName, input: unknown) {
  switch (name) {
    case "quote":
      return meter.quote(access, input as MeterQuoteInput);
    case "billingImports":
      return meter.billingImports(access, input as BillingImportsQuery);
    case "operation":
      return meter.getOperation(access, input as OperationRef);
    case "usage":
      return meter.usage(access, input as UsageQuery);
    case "operations":
      return meter.listOperations(access, input as OperationsQuery);
    case "defined":
      return meter.definedBudgets(access, input as DefinedBudgetsQuery);
    case "applicable":
      return meter.applicableBudgets(access, input as ApplicableBudgetsQuery);
    case "counts":
      return meter.requestCounts(access, input as RequestCountsQuery);
    default:
      throw new Error("Unknown read");
  }
}
