const express = require("express");
const { pool } = require("./db");
const { requireAuth } = require("./auth");
const { requireAdmin } = require("./auth");
const router = express.Router();

router.use(requireAuth);
router.get("/admin-history", requireAdmin, async (req, res) => {
  const { employeeId, from, to } = req.query;
  const validDate = (value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) {
    return res.status(400).json({ success: false, message: "Choose a valid date range." });
  }
  const values = [];
  const filters = [];
  if (employeeId) { values.push(employeeId); filters.push(`a.employee_id=$${values.length}`); }
  if (from) { values.push(from); filters.push(`(a.clock_in AT TIME ZONE 'Asia/Kolkata')::date >= $${values.length}::date`); }
  if (to) { values.push(to); filters.push(`(a.clock_in AT TIME ZONE 'Asia/Kolkata')::date <= $${values.length}::date`); }
  const { rows } = await pool.query(
    `SELECT a.id, a.employee_id AS "employeeId", e.name, e.designation,
            a.clock_in AS "clockIn", a.clock_out AS "clockOut",
            (a.clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance a JOIN employees e ON e.id=a.employee_id
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY a.clock_in DESC`, values
  );
  res.json({ success: true, records: rows });
});
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
            (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance WHERE employee_id=$1 ORDER BY clock_in DESC LIMIT 180`,
    [req.employeeId]
  );
  res.json({ success: true, records: rows });
});
router.post("/clock-in", async (req, res) => {
  const { rows: open } = await pool.query(
    `SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
            (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
    [req.employeeId]
  );
  if (open.length) return res.status(409).json({ success: false, message: "You already have an active clock-in.", record: open[0] });
  const { rows: today } = await pool.query(
    `SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
            (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance
     WHERE employee_id=$1
       AND (clock_in AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY clock_in DESC LIMIT 1`,
    [req.employeeId]
  );
  if (today.length) return res.status(409).json({ success: false, message: "Attendance has already been recorded today.", record: today[0] });
  const { rows } = await pool.query(
    `INSERT INTO attendance(employee_id, created_at)
     VALUES($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
     RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
               (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date`,
    [req.employeeId]
  );
  res.status(201).json({ success: true, record: rows[0] });
});
router.post("/clock-out", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE attendance SET clock_out=NOW()
     WHERE id=(SELECT id FROM attendance WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1)
     RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
               (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date`,
    [req.employeeId]
  );
  if (!rows.length) return res.status(409).json({ success: false, message: "No active clock-in was found." });
  res.json({ success: true, record: rows[0] });
});
module.exports = router;
