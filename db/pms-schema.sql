-- Patient Management System (PMS) storage.
-- Lives in its own Postgres schema so the PMS behaves like a separate system
-- even though it shares the database instance with the dashboard in local dev.
-- {{schema}} is replaced by the configured schema name before execution.

CREATE SCHEMA IF NOT EXISTS {{schema}};

CREATE SEQUENCE IF NOT EXISTS {{schema}}.patient_no_seq;
CREATE SEQUENCE IF NOT EXISTS {{schema}}.ward_no_seq;

CREATE TABLE IF NOT EXISTS {{schema}}.patients (
  id             bigserial PRIMARY KEY,
  external_id    text NOT NULL UNIQUE,
  medical_no     text,
  name           text NOT NULL,
  triage_level   text NOT NULL DEFAULT 'green'
                 CHECK (triage_level IN ('green', 'yellow', 'red')),
  status         text NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting', 'in_treatment', 'waiting_ward', 'discharged', 'cancelled')),
  arrived_at     timestamptz NOT NULL DEFAULT now(),
  triaged_at     timestamptz,
  called_at      timestamptz,
  discharged_at  timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pms_patients_status_idx
  ON {{schema}}.patients (status);
CREATE INDEX IF NOT EXISTS pms_patients_arrived_idx
  ON {{schema}}.patients (arrived_at DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.ward_requests (
  id                  bigserial PRIMARY KEY,
  external_id         text NOT NULL UNIQUE,
  patient_external_id text NOT NULL
                      REFERENCES {{schema}}.patients (external_id) ON DELETE CASCADE,
  ward                text NOT NULL,
  status              text NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'admitted', 'cancelled')),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  admitted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pms_ward_status_idx
  ON {{schema}}.ward_requests (status);
