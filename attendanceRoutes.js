const express = require("express");
const { pool } = require("./db");
const { requireAuth } = require("./auth");
const { requireAdmin } = require("./auth");
const router = express.Router();

router.use(requireAuth);
const ATTENDANCE_RADIUS_METERS = 200;
const ATTENDANCE_SITES = [
  { name: "Office of the Commissioner of Labour", latitude: 16.513973, longitude: 80.639791 },
  { name: "Nidhi Bhavan, Mangalagiri", latitude: 16.420984, longitude: 80.558304 },
];


function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateAttendanceLocation(req, res, next) {
  const { latitude, longitude, accuracy } = req.body || {};
  const lat = Number(latitude);
  const lon = Number(longitude);
  const precision = Number(accuracy);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ success: false, message: "Enable location and try again to record attendance." });
  }
  if (!Number.isFinite(precision) || precision < 0 || precision > 200) {
    return res.status(400).json({ success: false, message: "Your GPS accuracy is too low. Move to an open area and try again." });
  }
  const nearest = ATTENDANCE_SITES
    .map((site) => ({ ...site, distance: distanceMeters(lat, lon, site.latitude, site.longitude) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (nearest.distance + precision > ATTENDANCE_RADIUS_METERS) {
    return res.status(403).json({ success: false, message: `You must be within 200 m of an approved office to record attendance. Nearest site: ${nearest.name}.` });
  }
  req.attendanceLocation = { latitude: lat, longitude: lon, site: nearest.name, distance: Math.round(nearest.distance) };
  next();
}

async function getPreviousDayEligibility(employeeId) {
  const { rows } = await pool.query(
    `WITH previous_day AS (
       SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1 AS day
     )
     SELECT TO_CHAR(p.day, 'YYYY-MM-DD') AS date,
       EXISTS (
         SELECT 1 FROM attendance a
         WHERE a.employee_id=$1
           AND (a.clock_in AT TIME ZONE 'Asia/Kolkata')::date=p.day
           AND a.clock_in IS NOT NULL AND a.clock_out IS NOT NULL
       ) AS "completeAttendance",
       EXISTS (
         SELECT 1 FROM attendance a
         WHERE a.employee_id=$1
           AND (a.clock_in AT TIME ZONE 'Asia/Kolkata')::date=p.day
           AND a.clock_in IS NOT NULL
       ) AS "hasClockIn",
       EXISTS (
         SELECT 1 FROM leave_requests l
         WHERE l.employee_id=$1 AND l.status IN ('Pending', 'Approved')
           AND l.from_date <= p.day AND l.to_date >= p.day
       ) AS "hasRequest"
     FROM previous_day p`,
    [employeeId]
  );
  return rows[0];
}

router.get("/clock-in-eligibility", async (req, res) => {
  const previousDay = await getPreviousDayEligibility(req.employeeId);
  const eligible = previousDay.completeAttendance || previousDay.hasRequest;
  const reason = eligible ? null : previousDay.hasClockIn ? "missed_clock_out" : "missed_clock_in";
  res.json({
    success: true,
    eligible,
    previousDate: previousDay.date,
    reason,
    message: eligible ? null : reason === "missed_clock_out"
      ? `You clocked in on ${previousDay.date} but did not clock out. Submit an attendance regularization to continue.`
      : `No clock-in was recorded on ${previousDay.date}. Submit a leave request to continue.`,
  });
});

router.get("/team-status", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `WITH today AS (
       SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS day
     ), attendance_today AS (
       SELECT DISTINCT ON (a.employee_id) a.employee_id,
              a.clock_in AS "clockIn", a.clock_out AS "clockOut"
       FROM attendance a, today t
       WHERE (a.clock_in AT TIME ZONE 'Asia/Kolkata')::date = t.day
       ORDER BY a.employee_id, a.clock_in DESC
     ), approved_status AS (
       SELECT DISTINCT ON (l.employee_id) l.employee_id,
              l.leave_type AS "leaveType"
       FROM leave_requests l, today t
       WHERE l.status='Approved' AND l.leave_type NOT ILIKE '%regularization%'
         AND l.from_date <= t.day AND l.to_date >= t.day
       ORDER BY l.employee_id, l.reviewed_at DESC NULLS LAST, l.created_at DESC
     )
     SELECT e.id AS "employeeId", e.name, a."clockIn", a."clockOut",
            s."leaveType",
            CASE
              WHEN s.employee_id IS NOT NULL AND (s."leaveType" ILIKE '%work from home%' OR s."leaveType" ILIKE '%wfh%') THEN 'WFH'
              WHEN s.employee_id IS NOT NULL THEN 'Leave'
              WHEN a.employee_id IS NOT NULL THEN 'In Office'
              ELSE 'Not Clocked In'
            END AS status,
            TO_CHAR(t.day, 'YYYY-MM-DD') AS date
     FROM employees e
     CROSS JOIN today t
     LEFT JOIN attendance_today a ON a.employee_id=e.id
     LEFT JOIN approved_status s ON s.employee_id=e.id
     WHERE e.role='employee'
     ORDER BY e.name`
  );
  res.json({ success: true, date: rows[0]?.date || null, employees: rows });
});

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
router.post("/clock-in", validateAttendanceLocation, async (req, res) => {
  const { rows: open } = await pool.query(
    `SELECT id, clock_in AS "clockIn", clock_out AS "clockOut",
            (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date
     FROM attendance WHERE employee_id=$1 AND clock_out IS NULL
       AND (clock_in AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY clock_in DESC LIMIT 1`,
    [req.employeeId]
  );
  if (open.length) return res.status(409).json({ success: false, message: "You already have an active clock-in.", record: open[0] });
  const previousDay = await getPreviousDayEligibility(req.employeeId);
  if (!previousDay.completeAttendance && !previousDay.hasRequest) {
    return res.status(409).json({
      success: false,
      message: previousDay.hasClockIn
        ? `You clocked in on ${previousDay.date} but did not clock out. Submit an attendance regularization to continue.`
        : `No clock-in was recorded on ${previousDay.date}. Submit a leave request to continue.`,
    });
  }
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
    `INSERT INTO attendance(employee_id, created_at, clock_in_latitude, clock_in_longitude)
     VALUES($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, $3)
     RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
               (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date`,
    [req.employeeId, req.attendanceLocation.latitude, req.attendanceLocation.longitude]
  );
  res.status(201).json({ success: true, record: rows[0], site: req.attendanceLocation.site, distanceMeters: req.attendanceLocation.distance });
});
router.post("/clock-out", validateAttendanceLocation, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE attendance SET clock_out=NOW(), clock_out_latitude=$2, clock_out_longitude=$3
     WHERE id=(SELECT id FROM attendance WHERE employee_id=$1 AND clock_out IS NULL
       AND (clock_in AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       ORDER BY clock_in DESC LIMIT 1)
     RETURNING id, clock_in AS "clockIn", clock_out AS "clockOut",
               (clock_in AT TIME ZONE 'Asia/Kolkata')::date AS date`,
    [req.employeeId, req.attendanceLocation.latitude, req.attendanceLocation.longitude]
  );
  if (!rows.length) return res.status(409).json({ success: false, message: "No active clock-in was found." });
  res.json({ success: true, record: rows[0], site: req.attendanceLocation.site, distanceMeters: req.attendanceLocation.distance });
});
module.exports = router;
