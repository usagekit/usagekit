import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { hash } from "./util.js";
export function migrate(db: Database.Database, target = 7): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)");
    const versions = (
      db.prepare("SELECT version FROM migrations").all() as { version: number | bigint }[]
    ).map((r) => Number(r.version));
    if (![1, 2, 3, 4, 5, 6, 7].includes(target) || versions.some((v) => v > target))
      throw new Error("Downgrade or unsupported schema version");
    if (!versions.includes(1)) {
      db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
      db.prepare("INSERT INTO migrations VALUES(1)").run();
    }
    if (target >= 2 && !versions.includes(2)) {
      db.exec(`ALTER TABLE operations DROP COLUMN scope_json; ALTER TABLE operations DROP COLUMN estimate_json;
    UPDATE operations SET operation_json=json_remove(operation_json,'$.state','$.version','$.createdAt','$.updatedAt','$.budgetEpochs','$.receipts','$.lease');
    UPDATE receipts SET receipt_json=json_remove(receipt_json,'$.id','$.supersedes','$.measurements','$.cost','$.occurredAt','$.recordedAt');
    DROP TABLE cursors;
    CREATE INDEX budgets_scope ON budgets(namespace,scope_key,surface,budget_id,version DESC);
    CREATE INDEX operations_scope ON operations(namespace,principal,operation_id);
    CREATE INDEX receipt_order ON receipts(operation_pk,sequence DESC);
    CREATE TABLE operation_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,operation_pk TEXT NOT NULL REFERENCES operations(operation_pk),namespace TEXT NOT NULL,state TEXT NOT NULL,receipt_pk TEXT REFERENCES receipts(receipt_pk),occurred_at TEXT);
    CREATE INDEX event_operation ON operation_events(operation_pk,event_id DESC);
    CREATE INDEX event_window ON operation_events(namespace,occurred_at,event_id);
    INSERT INTO operation_events(operation_pk,namespace,state,receipt_pk,occurred_at)
     SELECT o.operation_pk,o.namespace,o.state,r.receipt_pk,strftime('%Y-%m-%dT%H:%M:%fZ',r.occurred_at) FROM operations o LEFT JOIN receipts r ON r.receipt_pk=(SELECT x.receipt_pk FROM receipts x WHERE x.operation_pk=o.operation_pk AND NOT EXISTS(SELECT 1 FROM receipts n WHERE n.operation_pk=x.operation_pk AND n.supersedes=x.receipt_id) ORDER BY x.sequence DESC LIMIT 1);
    CREATE TABLE store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      for (const row of db.prepare("SELECT operation_pk,semantic_json FROM operations").all() as {
        operation_pk: string;
        semantic_json: string;
      }[])
        db.prepare("UPDATE operations SET semantic_json=? WHERE operation_pk=?").run(
          hash(row.semantic_json),
          row.operation_pk,
        );
      db.prepare("INSERT INTO store_metadata VALUES('cursor_key',?)").run(
        randomBytes(32).toString("hex"),
      );
      db.prepare("INSERT INTO migrations VALUES(2)").run();
    }
    if (target >= 3 && !versions.includes(3)) {
      db.exec(`ALTER TABLE operations ADD COLUMN reservation_expires_at TEXT;
      UPDATE operations SET reservation_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+5 minutes');
      CREATE INDEX reservation_expiry ON operations(namespace,state,reservation_expires_at,operation_pk);
      UPDATE commands SET result_json=json_set(result_json,'$.operation.reservationExpiresAt',(SELECT reservation_expires_at FROM operations o WHERE o.operation_pk=commands.operation_pk));
      INSERT INTO migrations VALUES(3);`);
    }
    if (target >= 4 && !versions.includes(4)) {
      db.exec(`CREATE TABLE budget_alerts(namespace TEXT NOT NULL,budget_id TEXT NOT NULL,epoch TEXT NOT NULL,threshold_key TEXT NOT NULL,crossed_at TEXT NOT NULL,PRIMARY KEY(namespace,budget_id,epoch,threshold_key));
      ALTER TABLE operations ADD COLUMN alerts_json TEXT NOT NULL DEFAULT '[]';
      UPDATE commands SET result_json=json_set(result_json,'$.alerts',json('[]')) WHERE kind IN ('settle','correct') AND json_extract(result_json,'$.outcome')='settled';
      INSERT INTO migrations VALUES(4);`);
    }
    if (target >= 5 && !versions.includes(5)) {
      db.exec(`CREATE TABLE request_counts(namespace TEXT NOT NULL,principal TEXT NOT NULL,grp TEXT NOT NULL,connection TEXT NOT NULL,pools_json TEXT NOT NULL,day TEXT NOT NULL,provider TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,source TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(namespace,principal,grp,connection,pools_json,day,provider,operation,state,source));
      CREATE INDEX request_counts_window ON request_counts(namespace,day);
      CREATE TABLE request_commands(namespace TEXT NOT NULL,command_id TEXT NOT NULL,identity_hash TEXT NOT NULL,PRIMARY KEY(namespace,command_id));
      INSERT INTO migrations VALUES(5);`);
    }
    if (target >= 6 && !versions.includes(6)) {
      db.exec(`CREATE TABLE billing_import_families(family_id TEXT PRIMARY KEY,latest_import_id TEXT NOT NULL);
      CREATE TABLE billing_imports(import_id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES billing_import_families(family_id),namespace TEXT NOT NULL,principal TEXT NOT NULL,connection TEXT NOT NULL,provider TEXT NOT NULL,window_from TEXT NOT NULL,window_to TEXT NOT NULL,recorded_at TEXT NOT NULL,identity_json TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE INDEX billing_import_family ON billing_imports(family_id,recorded_at,import_id);
      CREATE INDEX billing_import_scope ON billing_imports(namespace,principal,connection,window_from,window_to);
      CREATE INDEX operations_billing_scope ON operations(namespace,principal,json_extract(operation_json,'$.scope.connection'),json_extract(operation_json,'$.provider'));
      INSERT INTO migrations VALUES(6);`);
    }
    if (target >= 7 && !versions.includes(7)) {
      db.exec(`ALTER TABLE receipts ADD COLUMN cost_scale INTEGER NOT NULL DEFAULT 4 CHECK (cost_scale BETWEEN 0 AND 18);
      UPDATE receipts SET cost_scale=COALESCE(json_extract(receipt_json,'$.cost.money.scale'),4);
      UPDATE receipts SET receipt_json=json_remove(receipt_json,'$.cost.money.scale') WHERE cost_scale=4;
      INSERT INTO migrations VALUES(7);`);
    }
  }).immediate();
}
