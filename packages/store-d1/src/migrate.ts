import type { Database } from "./database.js";
const schema = `CREATE TABLE IF NOT EXISTS operations (
 operation_pk TEXT PRIMARY KEY, namespace TEXT NOT NULL, principal TEXT NOT NULL,
 operation_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
 semantic_json TEXT NOT NULL,
 budget_epochs_json TEXT NOT NULL, lease_id TEXT, lease_holder TEXT, lease_expires_at TEXT,
 lease_kind TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 operation_json TEXT NOT NULL, warnings_json TEXT NOT NULL, reservation_expires_at TEXT NOT NULL, alerts_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(namespace,principal,operation_id), UNIQUE(namespace,operation_id)
);
CREATE TABLE IF NOT EXISTS receipts (
 receipt_pk TEXT PRIMARY KEY, operation_pk TEXT NOT NULL REFERENCES operations(operation_pk),
 receipt_id TEXT NOT NULL, supersedes TEXT, receipt_json TEXT NOT NULL,
 occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, cost_units TEXT, cost_certainty TEXT NOT NULL,
 sequence INTEGER NOT NULL, UNIQUE(operation_pk,receipt_id)
);
CREATE TABLE IF NOT EXISTS measurements (
 receipt_pk TEXT NOT NULL REFERENCES receipts(receipt_pk), unit TEXT NOT NULL,
 value TEXT, scale INTEGER, certainty TEXT NOT NULL, PRIMARY KEY(receipt_pk,unit)
);
CREATE TABLE IF NOT EXISTS commands (
 operation_pk TEXT NOT NULL REFERENCES operations(operation_pk), command_id TEXT NOT NULL,
 kind TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(operation_pk,command_id)
);
CREATE TABLE IF NOT EXISTS budgets (
 namespace TEXT NOT NULL, budget_id TEXT NOT NULL, version INTEGER NOT NULL,
 scope_json TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL,
 surface TEXT NOT NULL, unit TEXT NOT NULL, limit_value TEXT, limit_scale INTEGER,
 window_json TEXT NOT NULL, on_exceed TEXT NOT NULL, budget_json TEXT NOT NULL,
 PRIMARY KEY(namespace,budget_id,version)
);
CREATE TABLE IF NOT EXISTS budget_usage (
 namespace TEXT NOT NULL, budget_id TEXT NOT NULL, epoch TEXT NOT NULL,
 settled_value TEXT NOT NULL, outstanding_value TEXT NOT NULL, scale INTEGER NOT NULL,
 PRIMARY KEY(namespace,budget_id,epoch)
);

CREATE INDEX budgets_scope ON budgets(namespace,scope_key,surface,budget_id,version DESC);
CREATE INDEX operations_scope ON operations(namespace,principal,operation_id);
CREATE INDEX receipt_order ON receipts(operation_pk,sequence DESC);
CREATE INDEX reservation_expiry ON operations(namespace,state,reservation_expires_at,operation_pk);
CREATE TABLE operation_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,operation_pk TEXT NOT NULL REFERENCES operations(operation_pk),namespace TEXT NOT NULL,state TEXT NOT NULL,receipt_pk TEXT REFERENCES receipts(receipt_pk),occurred_at TEXT);
CREATE INDEX event_operation ON operation_events(operation_pk,event_id DESC);
CREATE INDEX event_window ON operation_events(namespace,occurred_at,event_id);
CREATE TABLE store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE budget_alerts(namespace TEXT NOT NULL,budget_id TEXT NOT NULL,epoch TEXT NOT NULL,threshold_key TEXT NOT NULL,crossed_at TEXT NOT NULL,PRIMARY KEY(namespace,budget_id,epoch,threshold_key));
CREATE TABLE request_counts(namespace TEXT NOT NULL,principal TEXT NOT NULL,grp TEXT NOT NULL,connection TEXT NOT NULL,pools_json TEXT NOT NULL,day TEXT NOT NULL,provider TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,source TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(namespace,principal,grp,connection,pools_json,day,provider,operation,state,source));
CREATE INDEX request_counts_window ON request_counts(namespace,day);
CREATE TABLE request_commands(namespace TEXT NOT NULL,command_id TEXT NOT NULL,identity_hash TEXT NOT NULL,PRIMARY KEY(namespace,command_id));
`;
export function migrate(db: Database, target = 3): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)");
    const versions = db.prepare("SELECT version FROM migrations").all() as { version: number }[];
    if (
      ![1, 2, 3].includes(target) ||
      versions.some((v) => v.version > target || ![1, 2, 3].includes(v.version))
    )
      throw new Error("Unsupported Cloudflare schema version");
    if (versions.length === 0) {
      db.exec(schema);
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      db.prepare("INSERT INTO store_metadata VALUES('cursor_key',?)").run(secret);
      db.prepare("INSERT INTO migrations VALUES(1)").run();
    }
    if (target >= 2 && !versions.some((v) => v.version === 2)) {
      db.exec(`CREATE TABLE billing_import_families(family_id TEXT PRIMARY KEY,latest_import_id TEXT NOT NULL);
      CREATE TABLE billing_imports(import_id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES billing_import_families(family_id),namespace TEXT NOT NULL,principal TEXT NOT NULL,connection TEXT NOT NULL,provider TEXT NOT NULL,window_from TEXT NOT NULL,window_to TEXT NOT NULL,recorded_at TEXT NOT NULL,identity_json TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE INDEX billing_import_family ON billing_imports(family_id,recorded_at,import_id);
      CREATE INDEX billing_import_scope ON billing_imports(namespace,principal,connection,window_from,window_to);
      CREATE INDEX operations_billing_scope ON operations(namespace,principal,json_extract(operation_json,'$.scope.connection'),json_extract(operation_json,'$.provider'));
      INSERT INTO migrations VALUES(2);`);
    }
    if (target >= 3 && !versions.some((v) => v.version === 3)) {
      db.exec(`ALTER TABLE receipts ADD COLUMN cost_scale INTEGER NOT NULL DEFAULT 4 CHECK (cost_scale BETWEEN 0 AND 18);
      UPDATE receipts SET cost_scale=COALESCE(json_extract(receipt_json,'$.cost.money.scale'),4);
      UPDATE receipts SET receipt_json=json_remove(receipt_json,'$.cost.money.scale') WHERE cost_scale=4;
      INSERT INTO migrations VALUES(3);`);
    }
  }).immediate();
}
