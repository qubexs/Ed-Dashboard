import pool from "./db.js";
import { migrate } from "./schema.js";

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

function pick<T>(array: T[]): T {
  return array[rand(0, array.length - 1)] as T;
}

const FIRST_NAMES = [
  "Ahmad", "Aisyah", "Amir", "Anis", "Arif", "Ayu", "Danish", "Farah",
  "Firdaus", "Hafiz", "Hakim", "Hana", "Iman", "Irfan", "Khalid", "Lina",
  "Mei Ling", "Nadia", "Nora", "Rahman", "Ravi", "Siti", "Syafiq", "Wei Jian",
];

const LAST_NAMES = [
  "Abdullah", "Abu Bakar", "Ismail", "Hassan", "Ibrahim", "Yusof", "Rahman",
  "Sulaiman", "Tan", "Lim", "Lee", "Wong", "Kumar", "Raj", "Ng", "Omar",
];

type PatientStatus = "waiting" | "in_treatment" | "waiting_ward" | "discharged" | "cancelled";

interface StatusPlan {
  zone: string;
  status: PatientStatus;
  count: number;
  wait: [number, number];
}

const STATUS_PLAN: StatusPlan[] = [
  { zone: "green", status: "waiting", count: 45, wait: [30, 120] },
  { zone: "green", status: "in_treatment", count: 16, wait: [40, 150] },
  { zone: "yellow", status: "waiting", count: 20, wait: [15, 80] },
  { zone: "yellow", status: "in_treatment", count: 8, wait: [25, 100] },
  { zone: "yellow", status: "waiting_ward", count: 2, wait: [90, 180] },
  { zone: "red", status: "waiting", count: 3, wait: [0, 25] },
  { zone: "red", status: "in_treatment", count: 5, wait: [10, 60] },
  { zone: "green", status: "discharged", count: 30, wait: [60, 240] },
  { zone: "yellow", status: "cancelled", count: 2, wait: [20, 60] },
];

export interface SeedResult {
  skipped: boolean;
  patients: number;
  wardAdmissions?: number;
}

export async function seedDemo({ force = false } = {}): Promise<SeedResult> {
  await migrate();

  const { rows } = await pool.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM patients"
  );
  if (rows[0].count > 0 && !force) {
    return { skipped: true, patients: rows[0].count };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (force) {
      await client.query("TRUNCATE ward_admissions, patients RESTART IDENTITY");
    }

    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const minutesSinceMidnight = Math.max(
      1,
      Math.floor((now.getTime() - midnight.getTime()) / 60_000)
    );

    const activePatients: { id: number; status: PatientStatus }[] = [];
    let index = 0;

    for (const plan of STATUS_PLAN) {
      for (let i = 0; i < plan.count; i += 1) {
        index += 1;
        const wait = Math.min(
          rand(plan.wait[0], plan.wait[1]),
          Math.max(0, minutesSinceMidnight - 2)
        );
        const arrivedAt = minutesAgo(wait);
        const triagedAt = new Date(arrivedAt.getTime() + 4 * 60_000);
        const calledAt =
          plan.status === "waiting"
            ? null
            : new Date(arrivedAt.getTime() + 12 * 60_000);
        const dischargedAt =
          plan.status === "discharged"
            ? new Date(arrivedAt.getTime() + 95 * 60_000)
            : null;

        const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
        const medicalNo = `DEMO-${String(index).padStart(4, "0")}`;

        const result = await client.query<{ id: number }>(
          `INSERT INTO patients
             (medical_no, name, zone_code, status, arrived_at, triaged_at, called_at, discharged_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [medicalNo, name, plan.zone, plan.status, arrivedAt, triagedAt, calledAt, dischargedAt]
        );

        if (["waiting", "in_treatment", "waiting_ward"].includes(plan.status)) {
          activePatients.push({ id: result.rows[0].id, status: plan.status });
        }
      }
    }

    const wardCandidates = activePatients.filter(
      (p) => p.status === "waiting_ward" || p.status === "in_treatment"
    );

    let wardCount = 0;
    for (const patient of wardCandidates) {
      if (wardCount >= 9) break;
      const waiting = wardCount < 6;
      const requestedAt = minutesAgo(rand(75, 215));
      const ward = pick(["Wad Perubatan 1", "Wad Bedah 2", "Wad Ortopedik", "Wad ICU"]);
      await client.query(
        `INSERT INTO ward_admissions
           (patient_id, ward, status, requested_at, admitted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          patient.id,
          ward,
          waiting ? "waiting" : "admitted",
          requestedAt,
          waiting ? null : new Date(requestedAt.getTime() + 45 * 60_000),
        ]
      );
      wardCount += 1;
    }

    await client.query("COMMIT");

    return { skipped: false, patients: index, wardAdmissions: wardCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
