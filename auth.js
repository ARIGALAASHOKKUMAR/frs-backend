const crypto = require("crypto");
const { pool } = require("./db");

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ success: false, message: "Please sign in again." });
  try {
    const { rows } = await pool.query(
      `SELECT s.employee_id AS "employeeId", e.role
       FROM auth_sessions s JOIN employees e ON e.id=s.employee_id
       WHERE s.token=$1`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ success: false, message: "Your session expired. Please sign in again." });
    req.employeeId = rows[0].employeeId;
    req.role = rows[0].role;
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error("Session lookup error:", error.message);
    res.status(503).json({ success: false, message: "Unable to verify your session. Check the backend database connection." });
  }
}

function requireAdmin(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ success: false, message: "Administrator access is required." });
  next();
}

async function login(req, res) {
  const { username, password } = req.body || {};
  const result = await pool.query(
    `SELECT id, name, username, mobile, designation, division, district, role,
            date_of_joining AS "dateOfJoining"
     FROM employees WHERE (username = $1 OR id = $1) AND password = $2`,
    [String(username || "").trim(), String(password || "")]
  );
  if (!result.rowCount) return res.status(401).json({ success: false, message: "Invalid username or password." });
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("INSERT INTO auth_sessions(token, employee_id) VALUES($1,$2)", [token, result.rows[0].id]);
  res.json({ success: true, token, employee: result.rows[0] });
}

module.exports = { requireAuth, requireAdmin, login };
