const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Load backend/.env without another dependency; shell variables take precedence.
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

// Replace these development defaults with DATABASE_URL or your own values.
const configuredHost = process.env.PGHOST || process.env.SUPABASE_URL || "localhost";
const parsedHost = new URL(configuredHost.includes("://") ? configuredHost : `postgres://${configuredHost}`).hostname;
const databaseHost = parsedHost.endsWith(".supabase.co") && !parsedHost.startsWith("db.")
  ? `db.${parsedHost}`
  : parsedHost;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: databaseHost,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "frs_demo",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, mobile TEXT, designation TEXT NOT NULL DEFAULT 'Forest Range Officer',
      division TEXT NOT NULL DEFAULT 'Guntur Division', district TEXT NOT NULL DEFAULT 'Guntur',
      role TEXT NOT NULL DEFAULT 'employee', date_of_joining DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'employee';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_joining DATE;
    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      clock_in TIMESTAMPTZ NOT NULL DEFAULT NOW(), clock_out TIMESTAMPTZ,
      created_at DATE NOT NULL DEFAULT CURRENT_DATE
    );
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_latitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_in_longitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_latitude DOUBLE PRECISION;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS clock_out_longitude DOUBLE PRECISION;
    CREATE INDEX IF NOT EXISTS attendance_employee_date_idx ON attendance(employee_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS leave_requests (
      id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type TEXT NOT NULL, from_date DATE NOT NULL, to_date DATE NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (to_date >= from_date)
    );
    ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES employees(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS face_templates (
      employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      descriptor DOUBLE PRECISION[] NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (cardinality(descriptor) = 128)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_employee_id_fkey;
    ALTER TABLE attendance ADD CONSTRAINT attendance_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_employee_id_fkey;
    ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_reviewed_by_fkey;
    ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_reviewed_by_fkey
      FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE face_templates DROP CONSTRAINT IF EXISTS face_templates_employee_id_fkey;
    ALTER TABLE face_templates ADD CONSTRAINT face_templates_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE;
    INSERT INTO employees (id, name, username, password, mobile)
    SELECT 'EMP001', 'Ashok Kumar', 'employee', '123456', '9876543210'
    WHERE NOT EXISTS (SELECT 1 FROM employees)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO employees (id, name, username, password, role, designation, division, district)
    VALUES ('ADMIN001', 'FRS Administrator', 'admin', 'admin123', 'admin', 'System Administrator', 'Administration', 'Guntur')
    ON CONFLICT (username) DO UPDATE SET role='admin';
  `);

  // Migrate the existing demo descriptor once, leaving faces.json untouched.
  const facesPath = path.join(__dirname, "faces.json");
  if (fs.existsSync(facesPath)) {
    try {
      const legacyFace = JSON.parse(fs.readFileSync(facesPath, "utf8"));
      if (Array.isArray(legacyFace?.descriptor) && legacyFace.descriptor.length === 128) {
        await pool.query(
          `INSERT INTO face_templates (employee_id, descriptor, registered_at)
           VALUES ('EMP001', $1::DOUBLE PRECISION[], COALESCE($2::TIMESTAMPTZ, NOW()))
           ON CONFLICT (employee_id) DO NOTHING`,
          [legacyFace.descriptor, legacyFace.registeredAt || null]
        );
      }
    } catch (error) {
      console.warn("Legacy face descriptor was not imported:", error.message);
    }
  }
}

module.exports = { pool, initializeDatabase };
