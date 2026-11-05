const express = require("express");
const { pool } = require("./db");
const { requireAuth, requireAdmin } = require("./auth");
const router = express.Router();

router.use(requireAuth, requireAdmin);

const EMPLOYEE_COLUMNS = `id, name, username, mobile, designation, division, district,
  date_of_joining AS "dateOfJoining", created_at AS "createdAt"`;

router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE role='employee' ORDER BY name`
  );
  res.json({ success: true, employees: rows });
});

router.post("/", async (req, res) => {
  const { id, name, username, password, mobile, designation, dateOfJoining, division, district } = req.body || {};
  if (!id?.trim() || !name?.trim() || !username?.trim() || !password || !designation?.trim() || !dateOfJoining) {
    return res.status(400).json({ success: false, message: "Employee ID, name, username, password, designation, and date of joining are required." });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO employees (id,name,username,password,mobile,designation,date_of_joining,division,district,role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'employee') RETURNING ${EMPLOYEE_COLUMNS}`,
      [id.trim(), name.trim(), username.trim(), password, mobile?.trim() || null, designation.trim(), dateOfJoining, division?.trim() || null, district?.trim() || null]
    );
    res.status(201).json({ success: true, employee: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "Employee ID or username is already in use." });
    throw error;
  }
});

router.put("/:id", async (req, res) => {
  const fields = {
    id: "id", name: "name", username: "username", password: "password", mobile: "mobile",
    designation: "designation", dateOfJoining: "date_of_joining",
    division: "division", district: "district",
  };
  const sets = [];
  const values = [req.params.id];
  for (const [key, column] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
      values.push(key === "password" ? req.body[key] : (req.body[key]?.trim?.() || null));
      sets.push(`${column}=$${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: "No employee fields were provided." });
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(", ")} WHERE id=$1 AND role='employee' RETURNING ${EMPLOYEE_COLUMNS}`,
      values
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Employee not found." });
    res.json({ success: true, employee: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "Employee ID or username is already in use." });
    throw error;
  }
});

router.delete("/:id", async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM employees WHERE id=$1 AND role='employee' RETURNING id",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: "Employee not found." });
  res.json({ success: true, deletedId: rows[0].id });
});

module.exports = router;
