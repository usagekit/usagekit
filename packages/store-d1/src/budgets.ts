import type { Database } from "./database.js";
import { resolveWindow, defaultBudgetOrder } from "@usagekit/core";
import type {
  Budget,
  BudgetAlertCrossed,
  BudgetStatus,
  ApplicableBudgetsQuery,
  ReserveInput,
  AdmissionPolicy,
  Operation,
  AllowanceExceeded,
  Quantity,
} from "@usagekit/core";
import { settledQuantity, validateBudget, reachedAlerts, alertKey } from "@usagekit/store";
import { decode, encode, integer } from "./serialize.js";
import { canonical, plus, greater, effective } from "./util.js";
/** Rows written before allow existed may carry the deprecated alias; the core type does not. */
export function decodeBudget(json: string): Budget {
  const b = decode<Budget>(json);
  return (b.onExceed as string) === "warn" ? { ...b, onExceed: "allow" } : b;
}
export function insertBudget(db: Database, b: Budget, fixture = false): void {
  db.prepare(
    `INSERT INTO budgets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ${fixture ? "ON CONFLICT(namespace,budget_id,version) DO UPDATE SET scope_json=excluded.scope_json,scope_kind=excluded.scope_kind,scope_key=excluded.scope_key,surface=excluded.surface,unit=excluded.unit,limit_value=excluded.limit_value,limit_scale=excluded.limit_scale,window_json=excluded.window_json,on_exceed=excluded.on_exceed,budget_json=excluded.budget_json" : ""}`,
  ).run(
    b.scope.namespace,
    b.id,
    b.version,
    encode(b.scope),
    b.scope.kind,
    canonical(b.scope),
    b.surface,
    b.unit,
    integer(b.limit?.value ?? null),
    b.limit?.scale ?? null,
    encode(b.window),
    b.onExceed,
    encode(b),
  );
}
export function currentBudgets(
  db: Database,
  namespace?: string,
  scopeKeys?: string[],
  surface?: string,
  source?: string,
): Budget[] {
  const clauses = [
      "NOT EXISTS(SELECT 1 FROM budgets n WHERE n.namespace=b.namespace AND n.budget_id=b.budget_id AND n.version>b.version)",
    ],
    args: string[] = [];
  if (namespace !== undefined) {
    clauses.push("b.namespace=?");
    args.push(namespace);
  }
  if (scopeKeys) {
    clauses.push(`b.scope_key IN (${scopeKeys.map(() => "?").join(",")})`);
    args.push(...scopeKeys);
  }
  if (surface) {
    // "any" matches everything, a surface value its declared surface, a source value exactly that source.
    clauses.push("b.surface IN ('any',?,?)");
    args.push(surface, source ?? surface);
  }
  return (
    db
      .prepare(
        `SELECT b.budget_json FROM budgets b WHERE ${clauses.join(" AND ")} ORDER BY b.rowid`,
      )
      .all(...args) as { budget_json: string }[]
  ).map((r) => decodeBudget(r.budget_json));
}
export function selected(
  db: Database,
  i: Pick<ApplicableBudgetsQuery, "scope" | "surface" | "source" | "platformPools">,
): Budget[] {
  const { namespace, principal, connection, group, accessCredential, tags } = i.scope;
  const scopes: Budget["scope"][] = [
    { kind: "principal", namespace, principal },
    { kind: "connection", namespace, connection },
  ];
  if (group) scopes.push({ kind: "group", namespace, group });
  if (accessCredential) scopes.push({ kind: "access_credential", namespace, accessCredential });
  for (const tag of tags ?? []) scopes.push({ kind: "tag", namespace, tag });
  for (const poolId of i.platformPools ?? [])
    scopes.push({ kind: "platform_pool", namespace, poolId });
  return currentBudgets(db, namespace, scopes.map(canonical), i.surface, i.source);
}
/** Settled use and outstanding reservations of one budget epoch from the admission projection. */
export function usage(
  db: Database,
  b: Budget,
  epoch: string,
): { used: Quantity; reserved: Quantity } {
  const row = db
    .prepare(
      "SELECT settled_value,outstanding_value,scale FROM budget_usage WHERE namespace=? AND budget_id=? AND epoch=?",
    )
    .get(b.scope.namespace, b.id, epoch) as
    | { settled_value: bigint; outstanding_value: bigint; scale: bigint }
    | undefined;
  const used = { unit: b.unit, value: row?.settled_value ?? 0n, scale: Number(row?.scale ?? 0) };
  return { used, reserved: { ...used, value: row?.outstanding_value ?? 0n } };
}
export function status(db: Database, b: Budget, now: Date): BudgetStatus {
  const epoch = resolveWindow(b.window, now);
  const { used, reserved } = usage(db, b, epoch.epoch),
    total = plus(used, reserved);
  return {
    budget: b,
    epoch,
    used,
    reserved,
    remaining: b.limit ? plus(b.limit, { ...total, value: -total.value }) : null,
  };
}
const budgetAt = (
  db: Database,
  namespace: string,
  epoch: Operation["budgetEpochs"][number],
): Budget =>
  decodeBudget(
    (
      db
        .prepare("SELECT budget_json FROM budgets WHERE namespace=? AND budget_id=? AND version=?")
        .get(namespace, epoch.budgetId, epoch.budgetVersion) as { budget_json: string }
    ).budget_json,
  );
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
/** Inserts unseen crossings inside the caller's write transaction and returns only those. */
export function recordAlerts(
  db: Database,
  namespace: string,
  reached: readonly BudgetAlertCrossed[],
  now: Date,
): BudgetAlertCrossed[] {
  const insert = db.prepare("INSERT OR IGNORE INTO budget_alerts VALUES(?,?,?,?,?)");
  return reached.filter(
    (a) =>
      insert.run(namespace, a.budgetId, a.epoch, alertKey(a.at), now.toISOString()).changes === 1,
  );
}
/** Crossings reached by an operation's current figures in its snapshotted epochs. */
export function reachedBySettlement(db: Database, op: Operation): BudgetAlertCrossed[] {
  return op.budgetEpochs.flatMap((e) => {
    const b = budgetAt(db, op.scope.namespace, e);
    if (!b.alerts?.length) return [];
    const { used, reserved } = usage(db, b, e.epoch);
    return candidates(b, e.epoch, used, reserved);
  });
}
export function admission(db: Database, i: ReserveInput, now: Date, p?: AdmissionPolicy) {
  const order = p?.budgetOrder ?? defaultBudgetOrder,
    budgets = selected(db, i).sort(
      (a, b) =>
        order.indexOf(a.scope.kind) - order.indexOf(b.scope.kind) || a.id.localeCompare(b.id),
    ),
    warnings: AllowanceExceeded[] = [],
    epochs: Operation["budgetEpochs"][number][] = [],
    alerts: BudgetAlertCrossed[] = [];
  budgets.forEach(validateBudget);
  for (const b of budgets)
    if (!i.estimate.some((q) => q.unit === b.unit))
      return { invalid: b.unit, warnings, epochs, alerts };
  for (const b of budgets) {
    const s = status(db, b, now);
    epochs.push({ budgetId: b.id, budgetVersion: b.version, ...s.epoch });
    const estimate = i.estimate.find((q) => q.unit === b.unit)!;
    const reserved = plus(s.reserved!, estimate),
      outcome = crossing(b, plus(s.used!, reserved));
    if (outcome) {
      const exceeded: AllowanceExceeded = {
        code: "allowance_exceeded",
        budget: b,
        boundary: outcome.boundary,
        used: s.used!,
        reserved: s.reserved!,
        resetsAt: s.epoch.endsAt,
      };
      if (outcome.denied) return { exceeded, warnings, epochs, alerts };
      warnings.push(exceeded);
    }
    alerts.push(...candidates(b, s.epoch.epoch, s.used!, reserved));
  }
  return { warnings, epochs, alerts };
}
function crossing(
  b: Budget,
  total: { value: bigint; scale: number; unit: string },
): { boundary: AllowanceExceeded["boundary"]; denied: boolean } | null {
  if (!b.limit || !greater(total, b.limit)) return null;
  if (b.onExceed === "block") return { boundary: "limit", denied: true };
  if (b.hardLimit && greater(total, b.hardLimit)) return { boundary: "hardLimit", denied: true };
  return { boundary: "limit", denied: false };
}
/** Apply only this operation's old/new contribution. Caller owns the write transaction. */
export function updateUsage(db: Database, before: Operation | null, after: Operation): void {
  for (const epoch of after.budgetEpochs) {
    const b = budgetAt(db, after.scope.namespace, epoch);
    const zero = { unit: b.unit, value: 0n, scale: 0 };
    const contribution = (op: Operation | null) => ({
      used: op?.state === "settled" ? (settledQuantity(op, b.unit) ?? zero) : zero,
      reserved:
        op && op.state !== "released" && op.state !== "settled"
          ? (op.estimate.find((q) => q.unit === b.unit) ?? zero)
          : zero,
    });
    const old = contribution(before),
      next = contribution(after),
      du = plus(next.used, { ...old.used, value: -old.used.value }),
      dr = plus(next.reserved, { ...old.reserved, value: -old.reserved.value });
    if (du.value === 0n && dr.value === 0n) continue;
    const row = db
      .prepare(
        "SELECT settled_value,outstanding_value,scale FROM budget_usage WHERE namespace=? AND budget_id=? AND epoch=?",
      )
      .get(after.scope.namespace, b.id, epoch.epoch) as
      | { settled_value: bigint; outstanding_value: bigint; scale: bigint }
      | undefined;
    const u = plus(
        { ...zero, value: row?.settled_value ?? 0n, scale: Number(row?.scale ?? 0) },
        du,
      ),
      r = plus(
        { ...zero, value: row?.outstanding_value ?? 0n, scale: Number(row?.scale ?? 0) },
        dr,
      ),
      scale = Math.max(u.scale, r.scale);
    db.prepare(
      "INSERT INTO budget_usage VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,budget_id,epoch) DO UPDATE SET settled_value=excluded.settled_value,outstanding_value=excluded.outstanding_value,scale=excluded.scale",
    ).run(
      after.scope.namespace,
      b.id,
      epoch.epoch,
      integer(u.value * 10n ** BigInt(scale - u.scale)),
      integer(r.value * 10n ** BigInt(scale - r.scale)),
      scale,
    );
  }
}
