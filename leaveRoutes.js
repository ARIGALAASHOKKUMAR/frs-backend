const express = require("express");
const { pool } = require("./db");
const { requireAuth, requireAdmin } = require("./auth");
const router = express.Router();
router.use(requireAuth);
router.get("/", async (req, res) => {
  const admin = req.role === "admin";
  const { rows } = await pool.query(
    `SELECT l.id, l.employee_id AS "employeeId", e.name AS "employeeName",
            l.leave_type AS "leaveType", l.from_date AS "fromDate", l.to_date AS "toDate",
            l.reason, l.status, l.created_at AS "createdAt", l.reviewed_at AS "reviewedAt"
     FROM leave_requests l JOIN employees e ON e.id=l.employee_id
     ${admin ? "" : "WHERE l.employee_id=$1"}
     ORDER BY l.created_at DESC`,
    admin ? [] : [req.employeeId]
  );
  res.json({ success: true, requests: rows });
});
router.post("/", async (req, res) => {
  if (req.role !== "employee") return res.status(403).json({ success: false, message: "Only employees can submit leave requests." });
  const { leaveType, fromDate, toDate, reason } = req.body || {};
  if (!leaveType || !fromDate || !toDate || !reason?.trim() || new Date(toDate) < new Date(fromDate)) {
    return res.status(400).json({ success: false, message: "Enter a leave type, valid date range, and reason." });
  }
  const { rows } = await pool.query("INSERT INTO leave_requests(employee_id,leave_type,from_date,to_date,reason) VALUES($1,$2,$3,$4,$5) RETURNING id, leave_type AS \"leaveType\", from_date AS \"fromDate\", to_date AS \"toDate\", reason,status,created_at AS \"createdAt\"", [req.employeeId, leaveType, fromDate, toDate, reason.trim()]);
  res.status(201).json({ success: true, request: rows[0] });
});

router.patch("/:id/status", requireAdmin, async (req, res) => {
  const status = String(req.body?.status || "");
  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: "Status must be Approved or Rejected." });
  }
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status=$1, reviewed_at=NOW(), reviewed_by=$2
     WHERE id=$3 RETURNING id, status, reviewed_at AS "reviewedAt"`,
    [status, req.employeeId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: "Leave request not found." });
  res.json({ success: true, request: rows[0] });
});
module.exports = router;
