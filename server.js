const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = 3000;

/*
====================================================
OFFICE CONFIG (Geofencing)
====================================================
*/
const OFFICE = {
  officeId: 1,
  officeName: "Head Office",
  latitude: 23.79736290271165,
  longitude: 90.37310216902948,
  radiusMeter: 100
};

/*
====================================================
POSTGRESQL DATABASE CONNECTION
====================================================
*/
// Render-এ ডিপ্লয় করলে তারা একটি 'DATABASE_URL' এনভায়রনমেন্ট ভ্যারিয়েবল দেয়।
// লোকালে টেস্ট করার জন্য নিচে তোমার লোকাল পোস্টগ্রেস কানেকশন স্ট্রিং দিতে পারো।
const connectionString = process.env.DATABASE_URL || "postgresql://postgres:password@localhost:5432/hrm_db";

const pool = new Pool({
  connectionString: connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false // Render-এর জন্য SSL অন করা আবশ্যক
});

async function initDatabase() {
  try {
    // বিগিন্ট (BIGINT) ডেটা টাইপকে জাভাস্ক্রিপ্ট স্ট্রিং বা নাম্বারে পার্স করার জন্য (attendanceId-এর জন্য জরুরি)
    const pg = require('pg');
    pg.types.setTypeParser(20, 'text', parseInt);

    // অ্যাটেনডেন্স টেবিল তৈরি (যদি না থাকে)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        attendanceId BIGINT PRIMARY KEY,
        employeeId INTEGER,
        employeeCode TEXT,
        employeeName TEXT,
        date TEXT,
        checkInTime TEXT,
        checkOutTime TEXT,
        checkInLat REAL,
        checkInLng REAL,
        checkOutLat REAL,
        checkOutLng REAL,
        distance REAL,
        accuracy REAL,
        deviceId TEXT,
        status TEXT,
        workingMinutes INTEGER
      )
    `);

    console.log("💾 PostgreSQL Database & Tables Checked/Initialized Successfully.");
  } catch (error) {
    console.error("❌ PostgreSQL Initialization Failed:", error);
  }
}

/*
====================================================
HELPER FUNCTIONS (Timezone & Distance)
====================================================
*/

function getTodayInBangladesh() {
  const options = { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' };
  const formatter = new Intl.DateTimeFormat('en-CA', options);
  return formatter.format(new Date());
}

function getLocalISOTime() {
  const tzoffset = (new Date()).getTimezoneOffset() * 60000;
  return (new Date(Date.now() - tzoffset)).toISOString();
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function validateGps(latitude, longitude) {
  const distance = calculateDistance(
    latitude,
    longitude,
    OFFICE.latitude,
    OFFICE.longitude
  );

  return {
    allowed: distance <= OFFICE.radiusMeter,
    distance: Number(distance.toFixed(2))
  };
}

/*
====================================================
ROOT API
====================================================
*/
app.get("/", async (req, res) => {
  try {
    const countResult = await pool.query("SELECT COUNT(*) as total FROM attendance");
    res.json({
      status: "RUNNING",
      office: OFFICE,
      totalAttendanceRecords: parseInt(countResult.rows[0].total),
      serverTime: getLocalISOTime()
    });
  } catch (e) {
    res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
CHECK-IN API
====================================================
*/
app.post("/api/attendance/checkin", async (req, res) => {
  try {
    const { latitude, longitude, accuracy, deviceId, employeeId } = req.body;
    const empId = Number(employeeId) || 101;

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        status: "FAILED",
        message: "Invalid GPS coordinates received by server."
      });
    }

    const gps = validateGps(lat, lng);
    if (!gps.allowed) {
      return res.status(400).json({
        status: "FAILED",
        message: `Outside Office Radius. You are ${gps.distance} meters away!`,
        distance: gps.distance
      });
    }

    const today = getTodayInBangladesh();

    // 🔍 PostgreSQL Query: অলরেডি চেক-ইন করা আছে কিনা চেক
    const existingResult = await pool.query(
      "SELECT * FROM attendance WHERE employeeId = $1 AND date = $2",
      [empId, today]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        status: "FAILED",
        message: "You have already Checked In for today!"
      });
    }

    const attendance = {
      attendanceId: Date.now(),
      employeeId: empId,
      employeeCode: `EMP${empId}`,
      employeeName: empId === 101 ? "Robiul" : "Employee " + empId,
      date: today,
      checkInTime: getLocalISOTime(),
      checkOutTime: null,
      checkInLat: lat,
      checkInLng: lng,
      checkOutLat: null,
      checkOutLng: null,
      distance: gps.distance,
      accuracy: accuracy || 0,
      deviceId: deviceId || "unknown-device",
      status: "PRESENT",
      workingMinutes: 0
    };

    // 💾 PostgreSQL INSERT
    await pool.query(
      `INSERT INTO attendance (
        attendanceId, employeeId, employeeCode, employeeName, date, 
        checkInTime, checkOutTime, checkInLat, checkInLng, 
        checkOutLat, checkOutLng, distance, accuracy, deviceId, status, workingMinutes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        attendance.attendanceId, attendance.employeeId, attendance.employeeCode, attendance.employeeName, attendance.date,
        attendance.checkInTime, attendance.checkOutTime, attendance.checkInLat, attendance.checkInLng,
        attendance.checkOutLat, attendance.checkOutLng, attendance.distance, attendance.accuracy, attendance.deviceId,
        attendance.status, attendance.workingMinutes
      ]
    );

    return res.json({
      status: "SUCCESS",
      message: "Check-In Successful",
      attendance
    });
  } catch (e) {
    return res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
CHECK-OUT API
====================================================
*/
app.post("/api/attendance/checkout", async (req, res) => {
  try {
    const { latitude, longitude, employeeId } = req.body;
    const empId = Number(employeeId) || 101;

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        status: "FAILED",
        message: "Invalid GPS coordinates for Check-Out."
      });
    }

    const gps = validateGps(lat, lng);
    if (!gps.allowed) {
      return res.status(400).json({
        status: "FAILED",
        message: `Outside Office Radius for Check-Out. Distance: ${gps.distance}m`
      });
    }

    const today = getTodayInBangladesh();

    // 🔍 PostgreSQL Query: আজকের অ্যাটেনডেন্স রেকর্ড খোঁজা
    const result = await pool.query(
      "SELECT * FROM attendance WHERE employeeId = $1 AND date = $2",
      [empId, today]
    );

    const attendance = result.rows[0];

    if (!attendance) {
      return res.status(400).json({
        status: "FAILED",
        message: "No Check-In record found for today. Please Check-In first."
      });
    }

    if (attendance.checkouttime) { // PostgreSQL সব কলাম নেম ছোট হাতের অক্ষরে রিটার্ন করে
      return res.status(400).json({
        status: "FAILED",
        message: "You have already Checked Out for today!"
      });
    }

    const checkOutTime = getLocalISOTime();
    const checkIn = new Date(attendance.checkintime);
    const checkOut = new Date(checkOutTime);
    const workingMinutes = Math.round((checkOut - checkIn) / 60000);

    // 💾 PostgreSQL UPDATE
    await pool.query(
      `UPDATE attendance 
       SET checkOutTime = $1, checkOutLat = $2, checkOutLng = $3, workingMinutes = $4
       WHERE employeeId = $5 AND date = $6`,
      [checkOutTime, lat, lng, workingMinutes, empId, today]
    );

    // ওল্ড অবজেক্ট ফরম্যাট বজায় রেখে ম্যাপ করা ফ্রন্টএন্ড সেফটির জন্য
    const updatedAttendance = {
      attendanceId: attendance.attendanceid,
      employeeId: attendance.employeeid,
      employeeCode: attendance.employeecode,
      employeeName: attendance.employeename,
      date: attendance.date,
      checkInTime: attendance.checkintime,
      checkOutTime,
      checkInLat: attendance.checkinlat,
      checkInLng: attendance.checkinlng,
      checkOutLat: lat,
      checkOutLng: lng,
      distance: attendance.distance,
      accuracy: attendance.accuracy,
      deviceId: attendance.deviceid,
      status: attendance.status,
      workingMinutes
    };

    return res.json({
      status: "SUCCESS",
      message: "Check-Out Successful",
      attendance: updatedAttendance
    });
  } catch (e) {
    return res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
MONTHLY CALENDAR
====================================================
*/
app.get("/api/attendance/calendar/:employeeId/:year/:month", async (req, res) => {
  try {
    const employeeId = Number(req.params.employeeId);
    const year = req.params.year;
    const month = req.params.month;
    const datePrefix = `${year}-${month}%`;

    const result = await pool.query(
      "SELECT * FROM attendance WHERE employeeId = $1 AND date LIKE $2",
      [employeeId, datePrefix]
    );

    // কলাম ম্যাপিং (PostgreSQL লোয়ারকেস অবজেক্ট কি-কে স্ট্যান্ডার্ড ক্যামেলকেসে রূপান্তর)
    const formattedRecords = result.rows.map(row => ({
      attendanceId: row.attendanceid,
      employeeId: row.employeeid,
      employeeCode: row.employeecode,
      employeeName: row.employeename,
      date: row.date,
      checkInTime: row.checkintime,
      checkOutTime: row.checkouttime,
      checkInLat: row.checkinlat,
      checkInLng: row.checkinlng,
      checkOutLat: row.checkoutlat,
      checkOutLng: row.checkoutlng,
      distance: row.distance,
      accuracy: row.accuracy,
      deviceId: row.deviceid,
      status: row.status,
      workingMinutes: row.workingminutes
    }));

    res.json({
      status: "SUCCESS",
      employeeId,
      year,
      month,
      records: formattedRecords
    });
  } catch (e) {
    res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
MONTHLY SUMMARY
====================================================
*/
app.get("/api/attendance/summary/:employeeId", async (req, res) => {
  try {
    const employeeId = Number(req.params.employeeId);

    const result = await pool.query(
      `SELECT COUNT(*) as total_present, SUM(COALESCE(workingMinutes, 0)) as total_minutes 
       FROM attendance WHERE employeeId = $1`,
      [employeeId]
    );

    const totalPresent = parseInt(result.rows[0].total_present) || 0;
    const totalMinutes = parseInt(result.rows[0].total_minutes) || 0;

    res.json({
      status: "SUCCESS",
      employeeId,
      totalPresent,
      totalWorkingMinutes: totalMinutes,
      totalWorkingHours: Number((totalMinutes / 60).toFixed(2))
    });
  } catch (e) {
    res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
ALL ATTENDANCE
====================================================
*/
app.get("/api/attendance/all", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM attendance ORDER BY attendanceId DESC");

    const formattedRecords = result.rows.map(row => ({
      attendanceId: row.attendanceid,
      employeeId: row.employeeid,
      employeeCode: row.employeecode,
      employeeName: row.employeename,
      date: row.date,
      checkInTime: row.checkintime,
      checkOutTime: row.checkouttime,
      checkInLat: row.checkinlat,
      checkInLng: row.checkinlng,
      checkOutLat: row.checkoutlat,
      checkOutLng: row.checkoutlng,
      distance: row.distance,
      accuracy: row.accuracy,
      deviceId: row.deviceid,
      status: row.status,
      workingMinutes: row.workingminutes
    }));

    res.json({
      status: "SUCCESS",
      total: formattedRecords.length,
      records: formattedRecords
    });
  } catch (e) {
    res.status(500).json({ status: "ERROR", message: e.message });
  }
});

/*
====================================================
SERVER START
====================================================
*/
initDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log(`🚀 HRM SERVER RUNNING ON PORT : ${PORT}`);
    console.log(`🏢 DATABASE : PostgreSQL (Connected)`);
    console.log("======================================");
  });
});