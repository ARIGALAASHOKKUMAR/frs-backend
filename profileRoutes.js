const express = require("express");
const { pool } = require("./db");
const { requireAuth } = require("./auth");
const router = express.Router();
router.use(requireAuth);
router.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT id, name, username, mobile, designation, division, district, role, date_of_joining AS \"dateOfJoining\", created_at AS \"createdAt\" FROM employees WHERE id=$1", [req.employeeId]);
  if (!rows.length) return res.status(404).json({ success: false, message: "Employee not found." });
  res.json({ success: true, employee: rows[0] });
});
module.exports = router;
