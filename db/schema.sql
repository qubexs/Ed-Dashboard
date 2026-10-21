BEGIN;

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  name_en    text,
  color      text NOT NULL DEFAULT '#5FE3D6',
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patients (
  id          bigserial PRIMARY KEY,
  external_id text,
  medical_no  text,
  name        text,
  zone_code   text REFERENCES zones(code) ON UPDATE CASCADE,
  status      text NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'in_treatment', 'waiting_ward', 'discharged', 'cancelled')),
  arrived_at  timestamptz NOT NULL DEFAULT now(),
  triaged_at  timestamptz,
  called_at   timestamptz,
  discharged_at timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patients_status_idx ON patients (status);
CREATE INDEX IF NOT EXISTS patients_arrived_at_idx ON patients (arrived_at DESC);
CREATE INDEX IF NOT EXISTS patients_zone_idx ON patients (zone_code);

ALTER TABLE patients ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS patients_external_id_key
  ON patients (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ward_admissions (
  id           bigserial PRIMARY KEY,
  patient_id   bigint REFERENCES patients(id) ON DELETE CASCADE,
  patient_name text,
  ward         text,
  status       text NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'admitted', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  admitted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ward_admissions_status_idx ON ward_admissions (status);

INSERT INTO zones (code, name, name_en, color, sort_order) VALUES
  ('green',  'Zon Hijau',  'Green Zone',  '#5FE3B0', 1),
  ('yellow', 'Zon Kuning', 'Yellow Zone', '#FDE68A', 2),
  ('red',    'Zon Merah',  'Red Zone',    '#FCA5A5', 3)
ON CONFLICT (code) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('hospital_name', 'Hospital Ampang'),
  ('hospital_subtitle', 'Jabatan Kecemasan & Trauma / Emergency & Trauma Department — Hulu Langat'),
  ('logo_url', '/img/logo.svg'),
  ('footer_message', 'Menunggu terlalu lama? Anda boleh mendapatkan rawatan di fasiliti kesihatan berdekatan.'),
  ('footer_message_en', 'Waiting too long? You may seek treatment at a nearby health facility.'),
  ('qr_url', 'https://hospitalampang.moh.gov.my'),
  ('qr_caption', 'Imbas untuk maklumat lanjut / Scan for more info'),
  ('timezone', 'Asia/Kuala_Lumpur'),
  ('refresh_seconds', '10'),
  ('waiting_buffer_minutes', '0'),
  ('waiting_fallback_minutes', '0')
ON CONFLICT (key) DO NOTHING;

COMMIT;
