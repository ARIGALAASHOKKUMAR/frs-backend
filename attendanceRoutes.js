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
