import { defaultBudgetOrder, surfaceMatches } from "@usagekit/core";
import type { AdmissionPolicy } from "@usagekit/core";
import { resolveWindow } from "@usagekit/core";
import type {
  Budget,
  BudgetAlert,
  BudgetAlertCrossed,
  ReserveInput,
  ApplicableBudgetsQuery,
  Quantity,
  BudgetStatus,
  AllowanceExceeded,
  Operation,
} from "@usagekit/core";
import { canonical, InvalidInput, validateQuantity } from "./state.js";
import type { State } from "./state.js";
export function plus(a: Quantity, b: Quantity): Quantity {
  const scale = Math.max(a.scale, b.scale);
  return {
    unit: a.unit,
    scale,
    value: a.value * 10n ** BigInt(scale - a.scale) + b.value * 10n ** BigInt(scale - b.scale),
  };
}
export const greater = (a: Quantity, b: Quantity) =>
  a.value * 10n ** BigInt(b.scale) > b.value * 10n ** BigInt(a.scale);
/** Absolute threshold of one alert; percent thresholds need the limit. */
export function alertThreshold(b: Budget, at: BudgetAlert["at"]): Quantity {
  if (!("percent" in at)) return at;
  return { unit: b.unit, value: b.limit!.value * BigInt(at.percent), scale: b.limit!.scale + 2 };
}
export const alertKey = (at: BudgetAlert["at"]) => canonical(at);
/** Thresholds at or below used plus reserved, in declaration order. Callers drop recorded ones. */
export function reachedAlerts(b: Budget, used: Quantity, reserved: Quantity): BudgetAlert["at"][] {
  const total = plus(used, reserved);
  return (b.alerts ?? []).map((a) => a.at).filter((at) => !greater(alertThreshold(b, at), total));
}
/** Definition rules every adapter applies before a budget takes part in admission. */
export function validateBudget(b: Budget): void {
  if (b.onExceed !== "block" && b.onExceed !== "allow")
    throw new InvalidInput("budget.onExceed", "expected block or allow");
  if (b.limit) validateQuantity(b.limit);
  if (b.hardLimit !== undefined) {
    validateQuantity(b.hardLimit);
    if (b.onExceed !== "allow")
      throw new InvalidInput("budget.hardLimit", "requires onExceed allow");
    if (!b.limit || b.hardLimit.unit !== b.limit.unit || !greater(b.hardLimit, b.limit))
      throw new InvalidInput("budget.hardLimit", "must exceed limit in the same unit");
  }
  const alerts = b.alerts ?? [];
  if (alerts.length > 8) throw new InvalidInput("budget.alerts", "at most eight thresholds");
  let previous: Quantity | null = null;
  for (const { at } of alerts) {
    if ("percent" in at) {
      if (!Number.isSafeInteger(at.percent) || at.percent < 1 || at.percent > 100)
        throw new InvalidInput("budget.alerts", "percent must be an integer from 1 to 100");
      if (!b.limit) throw new InvalidInput("budget.alerts", "percent requires a limit");
    } else {
      validateQuantity(at);
      if (at.unit !== b.unit) throw new InvalidInput("budget.alerts", "unit must match the budget");
    }
    const threshold = alertThreshold(b, at);
    if (previous && !greater(threshold, previous))
      throw new InvalidInput("budget.alerts", "thresholds must ascend");
    previous = threshold;
  }
}

export function currentBudgets(s: State): Budget[] {
  const map = new Map<string, Budget>();
  for (const b of s.budgets) {
    const k = canonical([b.scope.namespace, b.id]);
    if ((map.get(k)?.version ?? -1) < b.version) map.set(k, b);
  }
  return [...map.values()];
}
/** The budget version an operation snapshotted, or its current definition when that version is gone. */
export function budgetAt(
  s: State,
  namespace: string,
  epoch: Operation["budgetEpochs"][number],
): Budget | undefined {
  return (
    s.budgets.find(
      (b) =>
        b.scope.namespace === namespace &&
        b.id === epoch.budgetId &&
        b.version === epoch.budgetVersion,
    ) ?? currentBudgets(s).find((b) => b.scope.namespace === namespace && b.id === epoch.budgetId)
  );
}
export function matches(
  b: Budget,
  i: Pick<ReserveInput, "scope" | "surface" | "platformPools"> &
    Pick<ApplicableBudgetsQuery, "source">,
): boolean {
  if (b.scope.namespace !== i.scope.namespace || !surfaceMatches(b.surface, i.surface, i.source))
    return false;
  switch (b.scope.kind) {
    case "principal":
      return b.scope.principal === i.scope.principal;
    case "group":
      return b.scope.group === i.scope.group;
    case "connection":
      return b.scope.connection === i.scope.connection;
    case "access_credential":
      return canonical(b.scope.accessCredential) === canonical(i.scope.accessCredential);
    case "platform_pool":
      return i.platformPools?.includes(b.scope.poolId) ?? false;
    case "tag":
      return i.scope.tags?.includes(b.scope.tag) ?? false;
  }
}
export function effective(op: Operation) {
  return [...op.receipts]
    .reverse()
    .find((r) => !op.receipts.some((next) => next.supersedes === r.id));
}
/** Settled use and outstanding reservations of one budget epoch. */
export function usage(s: State, b: Budget, epoch: string): { used: Quantity; reserved: Quantity } {
  const projected = s.readBudgetUsage?.(b, epoch);
  if (projected) return projected;
  let used: Quantity = { value: 0n, scale: 0, unit: b.unit },
    reserved = { ...used };
  for (const op of s.operations.values()) {
    if (
      op.scope.namespace !== b.scope.namespace ||
      !op.budgetEpochs.some((e) => e.budgetId === b.id && e.epoch === epoch)
    )
      continue;
    if (op.state === "settled") {
      const receipt = effective(op);
      const m = receipt?.canonicalOperationId
        ? undefined
        : receipt?.measurements.find((m) => m.unit === b.unit);
      if (m?.quantity) used = plus(used, m.quantity);
    } else if (op.state !== "released") {
      const q = op.estimate.find((q) => q.unit === b.unit);
      if (q) reserved = plus(reserved, q);
    }
  }
  return { used, reserved };
}
export function status(s: State, b: Budget): BudgetStatus {
  const epoch = resolveWindow(b.window, s.clock.now());
  const { used, reserved } = usage(s, b, epoch.epoch);
  const total = plus(used, reserved);
  const remaining = b.limit ? plus(b.limit, { ...total, value: -total.value }) : null;
  return { budget: b, epoch, used, reserved, remaining };
}
export function applicable(s: State, i: ApplicableBudgetsQuery): BudgetStatus[] {
  return currentBudgets(s)
    .filter((b) => matches(b, i))
    .map((b) => status(s, b));
}
/** Which bound a projected total crosses and whether that denies admission. */
export function crossing(
  b: Budget,
  total: Quantity,
): { boundary: AllowanceExceeded["boundary"]; denied: boolean } | null {
  if (!b.limit || !greater(total, b.limit)) return null;
  if (b.onExceed === "block") return { boundary: "limit", denied: true };
  if (b.hardLimit && greater(total, b.hardLimit)) return { boundary: "hardLimit", denied: true };
  return { boundary: "limit", denied: false };
}
const candidates = (
  b: Budget,
  epoch: string,
  used: Quantity,
  reserved: Quantity,
): BudgetAlertCrossed[] =>
  reachedAlerts(b, used, reserved).map((at) => ({
    budgetId: b.id,
    budgetVersion: b.version,
    epoch,
    at,
    used,
    reserved,
  }));
/** Records unseen crossings atomically with the calling command and returns only those. */
export function recordAlerts(
  s: State,
  namespace: string,
  reached: readonly BudgetAlertCrossed[],
): BudgetAlertCrossed[] {
  const recorded: BudgetAlertCrossed[] = [];
  for (const a of reached) {
    const k = canonical([namespace, a.budgetId, a.epoch, alertKey(a.at)]);
    if (s.alerts.has(k)) continue;
    s.alerts.add(k);
    recorded.push(a);
  }
  return recorded;
}
/** Crossings reached by an operation's current figures in its snapshotted epochs. */
export function reachedBySettlement(s: State, op: Operation): BudgetAlertCrossed[] {
  return op.budgetEpochs.flatMap((e) => {
    const b = budgetAt(s, op.scope.namespace, e);
    if (!b?.alerts?.length) return [];
    const { used, reserved } = usage(s, b, e.epoch);
    return candidates(b, e.epoch, used, reserved);
  });
}
export function admission(s: State, i: ReserveInput, policy?: AdmissionPolicy) {
  const order = policy?.budgetOrder ?? defaultBudgetOrder;
  const budgets = currentBudgets(s)
    .filter((b) => matches(b, i))
    .sort(
      (a, b) =>
        order.indexOf(a.scope.kind) - order.indexOf(b.scope.kind) || a.id.localeCompare(b.id),
    );
  const warnings: AllowanceExceeded[] = [],
    epochs: Operation["budgetEpochs"][number][] = [],
    alerts: BudgetAlertCrossed[] = [];
  budgets.forEach(validateBudget);
  for (const b of budgets) {
    const estimate = i.estimate.find((q) => q.unit === b.unit);
    if (!estimate) return { invalid: b.unit, warnings, epochs, alerts };
  }
  for (const b of budgets) {
    const st = status(s, b);
    epochs.push({ budgetId: b.id, budgetVersion: b.version, ...st.epoch });
    const estimate = i.estimate.find((q) => q.unit === b.unit)!;
    const reserved = plus(st.reserved!, estimate),
      outcome = crossing(b, plus(st.used!, reserved));
    if (outcome) {
      const exceeded: AllowanceExceeded = {
        code: "allowance_exceeded",
        budget: b,
        boundary: outcome.boundary,
        used: st.used!,
        reserved: st.reserved!,
        resetsAt: st.epoch.endsAt,
      };
      if (outcome.denied) return { exceeded, warnings, epochs, alerts };
      warnings.push(exceeded);
    }
    alerts.push(...candidates(b, st.epoch.epoch, st.used!, reserved));
  }
  return { warnings, epochs, alerts };
}
