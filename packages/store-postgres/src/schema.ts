export const schemaStatements = [
  `CREATE TABLE metering_operation (
  operation_pk text PRIMARY KEY,
  namespace text NOT NULL,
  principal text NOT NULL,
  operation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','dispatch_intended','pending','settled','released')),
  version integer NOT NULL,
  semantic_hash text NOT NULL,
  budget_epochs jsonb NOT NULL,
  reservation_expires_at timestamptz NOT NULL,
  lease_id text,
  lease_holder text,
  lease_expires_at timestamptz,
  lease_kind text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  input jsonb NOT NULL,
  warnings jsonb NOT NULL,
  UNIQUE(namespace,operation_id)
)`,
  `CREATE INDEX metering_operation_expiry_idx ON metering_operation(namespace,state,reservation_expires_at)`,
  `CREATE TABLE metering_receipt (
  receipt_pk text PRIMARY KEY,
  operation_pk text NOT NULL REFERENCES metering_operation(operation_pk),
  receipt_id text NOT NULL,
  supersedes text,
  body jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  cost_units bigint,
  cost_certainty text NOT NULL,
  sequence integer NOT NULL,
  UNIQUE(operation_pk,receipt_id),
  UNIQUE(operation_pk,sequence)
)`,
  `CREATE TABLE metering_measurement (
  receipt_pk text NOT NULL REFERENCES metering_receipt(receipt_pk),
  unit text NOT NULL,
  value numeric(38,0),
  scale integer,
  certainty text NOT NULL,
  PRIMARY KEY(receipt_pk,unit)
)`,
  `CREATE TABLE metering_command (
  operation_pk text NOT NULL REFERENCES metering_operation(operation_pk),
  command_id text NOT NULL,
  kind text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(operation_pk,command_id)
)`,
  `CREATE TABLE metering_budget (
  sequence bigserial NOT NULL,
  namespace text NOT NULL,
  budget_id text NOT NULL,
  version integer NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  surface text NOT NULL,
  unit text NOT NULL,
  limit_value numeric(38,0),
  limit_scale integer,
  "window" jsonb NOT NULL,
  on_exceed text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY(namespace,budget_id,version)
)`,
  `CREATE INDEX metering_budget_scope_idx ON metering_budget(namespace,scope_key,surface)`,
  `CREATE TABLE metering_budget_usage (
  namespace text NOT NULL,
  budget_id text NOT NULL,
  epoch text NOT NULL,
  settled_value numeric(38,0) NOT NULL,
  outstanding_value numeric(38,0) NOT NULL,
  scale integer NOT NULL,
  PRIMARY KEY(namespace,budget_id,epoch)
)`,
  `CREATE TABLE metering_event (
  event_id bigserial PRIMARY KEY,
  operation_pk text NOT NULL REFERENCES metering_operation(operation_pk),
  namespace text NOT NULL,
  state text NOT NULL,
  receipt_pk text REFERENCES metering_receipt(receipt_pk),
  occurred_at timestamptz
)`,
  `CREATE INDEX metering_event_time_idx ON metering_event(namespace,occurred_at,event_id)`,
  `CREATE INDEX metering_event_operation_idx ON metering_event(operation_pk,event_id DESC)`,
  `CREATE TABLE metering_metadata (key text PRIMARY KEY,value text NOT NULL)`,
  `ALTER TABLE metering_operation ADD COLUMN alerts jsonb NOT NULL DEFAULT '[]'`,
  `CREATE TABLE metering_alert (
  alert_key text PRIMARY KEY,
  namespace text NOT NULL,
  budget_id text NOT NULL,
  epoch text NOT NULL,
  threshold text NOT NULL,
  UNIQUE(namespace, budget_id, epoch, threshold)
)`,
  `CREATE INDEX metering_alert_budget_idx ON metering_alert(namespace, budget_id, epoch)`,
  `CREATE TABLE metering_request_command (
  namespace text NOT NULL,
  command_id text NOT NULL,
  identity_hash text NOT NULL,
  PRIMARY KEY(namespace, command_id)
)`,
  `CREATE TABLE metering_request_count (
  bucket_key text PRIMARY KEY,
  namespace text NOT NULL,
  day date NOT NULL,
  body jsonb NOT NULL,
  count numeric(38,0) NOT NULL CHECK (count > 0)
)`,
  `CREATE INDEX metering_request_count_window_idx ON metering_request_count(namespace, day)`,
  `-- Immutable content-free invoice journal and serialized revision pointer.
CREATE TABLE metering_import_family (
  family_id TEXT PRIMARY KEY,
  latest_import_id TEXT NOT NULL
)`,
  `CREATE TABLE metering_import (
  import_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES metering_import_family(family_id),
  namespace TEXT NOT NULL,
  principal TEXT NOT NULL,
  connection TEXT NOT NULL,
  provider TEXT NOT NULL,
  file_hash TEXT NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  window_from TIMESTAMPTZ NOT NULL,
  window_to TIMESTAMPTZ NOT NULL CHECK (window_to > window_from),
  recorded_at TIMESTAMPTZ NOT NULL,
  identity TEXT NOT NULL,
  body JSONB NOT NULL,
  UNIQUE (family_id, file_hash)
)`,
  `ALTER TABLE metering_import_family ADD CONSTRAINT metering_import_latest_fk
  FOREIGN KEY (latest_import_id) REFERENCES metering_import(import_id)
  DEFERRABLE INITIALLY DEFERRED`,
  `CREATE INDEX metering_import_scope_window_idx
  ON metering_import(namespace,principal,connection,window_from,window_to)`,
  `CREATE INDEX metering_operation_connection_created_idx
  ON metering_operation(namespace,principal,(input->'scope'->>'connection'),created_at)`,
  `CREATE INDEX metering_receipt_native_id_idx
  ON metering_receipt((body->>'providerRequestId'))
  WHERE body->>'providerRequestId' IS NOT NULL`,
  `CREATE FUNCTION metering_import_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meter billing imports are immutable' USING ERRCODE='23514';
END;
$$`,
  `CREATE TRIGGER metering_import_immutable BEFORE UPDATE OR DELETE ON metering_import
  FOR EACH ROW EXECUTE FUNCTION metering_import_immutable()`,
];

export const moneyScaleStatements = [
  `ALTER TABLE metering_receipt ADD COLUMN cost_scale integer NOT NULL DEFAULT 4 CHECK (cost_scale BETWEEN 0 AND 18)`,
  `UPDATE metering_receipt SET cost_scale=COALESCE((body->'cost'->'money'->>'scale')::integer,4)`,
  `UPDATE metering_receipt SET body=body #- '{cost,money,scale}' WHERE cost_scale=4`,
];
