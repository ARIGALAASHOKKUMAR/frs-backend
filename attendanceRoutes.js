const express = require("express");
const { pool } = require("./db");
const { requireAuth } = require("./auth");
const router = express.Router();

router.use(requireAuth);
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
            (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance WHERE employee_id=$1 ORDER BY clock_in DESC LIMIT 180`,
    [req.employeeId]
  );
  res.json({ success: true, records: rows });
});
async function markAttendance(employeeId, action) {
  if (action === "clock-in") {
    const { rows } = await pool.query(
      `WITH active AS MATERIALIZED (
         SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
                (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
         FROM attendance
         WHERE employee_id=$1 AND clock_out IS NULL
         ORDER BY clock_in DESC LIMIT 1
       ), today AS MATERIALIZED (
         SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
                (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
         FROM attendance
         WHERE employee_id=$1
           AND (clock_in AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
         ORDER BY clock_in DESC LIMIT 1
       ), created AS (
         INSERT INTO attendance(employee_id, created_at)
         SELECT $1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date
         WHERE NOT EXISTS (SELECT 1 FROM active)
           AND NOT EXISTS (SELECT 1 FROM today)
         RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
                   (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
       )
       SELECT 'created'::text AS outcome, id, "clockIn", "clockOut", date FROM created
       UNION ALL
       SELECT 'active', id, "clockIn", "clockOut", date FROM active
       UNION ALL
       SELECT 'today', id, "clockIn", "clockOut", date FROM today
       WHERE NOT EXISTS (SELECT 1 FROM active)`,
      [employeeId]
    );
    const outcome = rows[0];
    if (outcome?.outcome === "created") {
      return { status: 201, body: { success: true, record: outcome } };
    }
    if (outcome?.outcome === "active") {
      return { status: 409, body: { success: false, message: "You already have an active clock-in.", record: outcome } };
    }
    if (outcome?.outcome === "today") {
      return { status: 409, body: { success: false, message: "Attendance has already been recorded today.", record: outcome } };
    }
    throw new Error("Unable to determine clock-in status.");
  }

  if (action !== "clock-out") {
    return { status: 400, body: { success: false, message: "Invalid attendance action." } };
  }
  const { rows } = await pool.query(
    `UPDATE attendance SET clock_out=NOW()
     WHERE id=(SELECT id FROM attendance WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1)
     RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
               (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date`,
    [employeeId]
  );
  if (!rows.length) return { status: 409, body: { success: false, message: "No active clock-in was found." } };
  return { status: 200, body: { success: true, record: rows[0] } };
}

router.post("/clock-in", async (req, res) => {
  const result = await markAttendance(req.employeeId, "clock-in");
  res.status(result.status).json(result.body);
});
router.post("/clock-out", async (req, res) => {
  const result = await markAttendance(req.employeeId, "clock-out");
  res.status(result.status).json(result.body);
});

module.exports = router;
module.exports.markAttendance = markAttendance;
