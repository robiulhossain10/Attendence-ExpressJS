const express = require("express");
const cors = require("cors");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const path = require("path");

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
SQLITE DATABASE INITIALIZATION
====================================================
*/
let db;

async function initDatabase() {
  try {
    // database.db ফাইলে ডেটা সেভ হবে
    db = await open({
      filename: path.join(__dirname, "database.db"),
      driver: sqlite3.Database
    });

    // অ্যাটেনডেন্স টেবিল তৈরি (যদি না থাকে)
    await db.exec(`
      CREATE TABLE IF NOT EXISTS attendance (
        attendanceId INTEGER PRIMARY KEY,
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
    
    console.log("📁 SQLite Database & Tables Initialized Successfully.");
  } catch (error) {
    console.error("❌ Database Initialization Failed:", error);
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
    const countResult = await db.get("SELECT COUNT(*) as total FROM attendance");
    res.json({
      status: "RUNNING",
      office: OFFICE,
      totalAttendanceRecords: countResult.total,
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

    // 🔍 SQLite Query: আজকের দিনে অলরেডি চেক-ইন করা আছে কিনা চেক
    const existing = await db.get(
      "SELECT * FROM attendance WHERE employeeId = ? AND date = ?",
      [empId, today]
    );

    if (existing) {
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

    // 💾 SQLite INSERT
    await db.run(
      `INSERT INTO attendance (
        attendanceId, employeeId, employeeCode, employeeName, date, 
        checkInTime, checkOutTime, checkInLat, checkInLng, 
        checkOutLat, checkOutLng, distance, accuracy, deviceId, status, workingMinutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )`,
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

    // 🔍 SQLite Query: আজকের অ্যাটেনডেন্স রেকর্ড খোঁজা
    const attendance = await db.get(
      "SELECT * FROM attendance WHERE employeeId = ? AND date = ?",
      [empId, today]
    );

    if (!attendance) {
      return res.status(400).json({
        status: "FAILED",
        message: "No Check-In record found for today. Please Check-In first."
      });
    }

    if (attendance.checkOutTime) {
      return res.status(400).json({
        status: "FAILED",
        message: "You have already Checked Out for today!"
      });
    }

    const checkOutTime = getLocalISOTime();
    const checkIn = new Date(attendance.checkInTime);
    const checkOut = new Date(checkOutTime);
    const workingMinutes = Math.round((checkOut - checkIn) / 60000);

    // 💾 SQLite UPDATE
    await db.run(
      `UPDATE attendance 
       SET checkOutTime = ?, checkOutLat = ?, checkOutLng = ?, workingMinutes = ?
       WHERE employeeId = ? AND date = ?`,
      [checkOutTime, lat, lng, workingMinutes, empId, today]
    );

    // আপডেটেড ডেটা ফ্রন্টএন্ডে রেসপন্স পাঠানোর জন্য অবজেক্ট রি-বিল্ড
    const updatedAttendance = {
      ...attendance,
      checkOutTime,
      checkOutLat: lat,
      checkOutLng: lng,
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
    const datePrefix = `${year}-${month}%`; // LIKE কোয়েরির জন্য ওয়াইল্ডকার্ড

    // 🔍 SQLite Query: নির্দিষ্ট মাস এবং বছরের রেকর্ড ফিল্টার
    const records = await db.all(
      "SELECT * FROM attendance WHERE employeeId = ? AND date LIKE ?",
      [employeeId, datePrefix]
    );

    res.json({
      status: "SUCCESS",
      employeeId,
      year,
      month,
      records
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

    // 🔍 SQLite Query: টোটাল দিন এবং ওয়ার্কিং মিনিটস এগ্রিগেশন
    const summaryData = await db.get(
      `SELECT COUNT(*) as totalPresent, SUM(COALESCE(workingMinutes, 0)) as totalMinutes 
       FROM attendance WHERE employeeId = ?`,
      [employeeId]
    );

    const totalPresent = summaryData.totalPresent || 0;
    const totalMinutes = summaryData.totalMinutes || 0;

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
    // 🔍 SQLite Query: লেটেস্ট রেকর্ড আগে দেখানোর জন্য ORDER BY ব্যবহার করা হয়েছে
    const sortedRecords = await db.all("SELECT * FROM attendance ORDER BY attendanceId DESC");
    
    res.json({
      status: "SUCCESS",
      total: sortedRecords.length,
      records: sortedRecords
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
// ডাটাবেজ রেডি হওয়ার পর এক্সপ্রেস সার্ভার লিসেন করবে
initDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log(`🚀 HRM SERVER RUNNING ON PORT : ${PORT}`);
    console.log(`🏢 OFFICE : ${OFFICE.officeName}`);
    console.log(`📍 TARGET GPS : ${OFFICE.latitude}, ${OFFICE.longitude}`);
    console.log(`🎯 SAFE RADIUS : ${OFFICE.radiusMeter} meters`);
    console.log("======================================");
  });
});