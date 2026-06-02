const express = require("express");
const cors = require("cors");

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
  radiusMeter: 200 // ২০০ মিটারের ভেতর থাকতে হবে
};

/*
====================================================
IN-MEMORY DATABASE
====================================================
*/
const attendanceRecords = [];

/*
====================================================
HELPER FUNCTIONS (Timezone & Distance)
====================================================
*/

// 💡 Senior Dev Note: Local Timezone (Asia/Dhaka) অনুযায়ী নিখুঁত Date পাওয়ার উপায়
function getTodayInBangladesh() {
  const options = { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' };
  const formatter = new Intl.DateTimeFormat('en-CA', options); // Outputs YYYY-MM-DD
  return formatter.format(new Date());
}

function getLocalISOTime() {
  // বাংলাদেশের লোকাল টাইম ISO ফরম্যাটে জেনারেট করার জন্য
  const tzoffset = (new Date()).getTimezoneOffset() * 60000; // offset in milliseconds
  return (new Date(Date.now() - tzoffset)).toISOString();
}

// Haversine Formula: দুটি GPS স্থানাঙ্কের দূরত্ব মিটারে বের করার জন্য
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters

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
app.get("/", (req, res) => {
  res.json({
    status: "RUNNING",
    office: OFFICE,
    totalAttendanceRecords: attendanceRecords.length,
    serverTime: getLocalISOTime()
  });
});

/*
====================================================
CHECK-IN API (Updated with dynamic employee handling)
====================================================
*/
app.post("/api/attendance/checkin", (req, res) => {
  try {
    const {
      latitude,
      longitude,
      accuracy,
      deviceId,
      employeeId // 🚀 ফ্লাটার থেকে ডাইনামিক আইডি পাস করার স্কোপ রাখা হলো
    } = req.body;

    // যদি ফ্লাটার থেকে আইডি না আসে তবে ডিফল্ট ১০১ (টেস্টিং সেফটি)
    const empId = Number(employeeId) || 101; 

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        status: "FAILED",
        message: "Invalid GPS coordinates received by server."
      });
    }

    // জিপিএস রেডিয়াস ভ্যালিডেশন
    const gps = validateGps(lat, lng);
    if (!gps.allowed) {
      return res.status(400).json({
        status: "FAILED",
        message: `Outside Office Radius. You are ${gps.distance} meters away!`,
        distance: gps.distance
      });
    }

    const today = getTodayInBangladesh();

    // অলরেডি চেক-ইন করা আছে কিনা চেক
    const existing = attendanceRecords.find(
      a => a.employeeId === empId && a.date === today
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

    attendanceRecords.push(attendance);

    return res.json({
      status: "SUCCESS",
      message: "Check-In Successful",
      attendance
    });
  } catch (e) {
    return res.status(500).json({
      status: "ERROR",
      message: e.message
    });
  }
});

/*
====================================================
CHECK-OUT API (Fixed bugs & dynamic matching)
====================================================
*/
app.post("/api/attendance/checkout", (req, res) => {
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

    // 🚀 BUG FIX: পার্স করা lat, lng পাঠানো হচ্ছে ভ্যালিডেশনে
    const gps = validateGps(lat, lng);
    if (!gps.allowed) {
      return res.status(400).json({
        status: "FAILED",
        message: `Outside Office Radius for Check-Out. Distance: ${gps.distance}m`
      });
    }

    const today = getTodayInBangladesh();

    // আজকের এটেনডেন্স রেকর্ড খোঁজা
    const attendance = attendanceRecords.find(
      a => a.employeeId === empId && a.date === today
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

    // ডাটা আপডেট
    attendance.checkOutTime = getLocalISOTime();
    attendance.checkOutLat = lat;
    attendance.checkOutLng = lng;

    const checkIn = new Date(attendance.checkInTime);
    const checkOut = new Date(attendance.checkOutTime);

    // মিনিট ক্যালকুলেশন
    attendance.workingMinutes = Math.round((checkOut - checkIn) / 60000);

    return res.json({
      status: "SUCCESS",
      message: "Check-Out Successful",
      attendance
    });
  } catch (e) {
    return res.status(500).json({
      status: "ERROR",
      message: e.message
    });
  }
});

/*
====================================================
MONTHLY CALENDAR
====================================================
*/
app.get("/api/attendance/calendar/:employeeId/:year/:month", (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const year = req.params.year;
  const month = req.params.month;

  const records = attendanceRecords.filter(
    a => a.employeeId === employeeId && a.date.startsWith(`${year}-${month}`)
  );

  res.json({
    status: "SUCCESS",
    employeeId,
    year,
    month,
    records
  });
});

/*
====================================================
MONTHLY SUMMARY (Optimized for Flutter UI Blocks)
====================================================
*/
app.get("/api/attendance/summary/:employeeId", (req, res) => {
  const employeeId = Number(req.params.employeeId);

  const records = attendanceRecords.filter(
    a => a.employeeId === employeeId
  );

  const totalPresent = records.length;
  const totalMinutes = records.reduce((sum, item) => sum + (item.workingMinutes || 0), 0);

  res.json({
    status: "SUCCESS",
    employeeId,
    totalPresent,
    totalWorkingMinutes: totalMinutes,
    totalWorkingHours: Number((totalMinutes / 60).toFixed(2))
  });
});

/*
====================================================
ALL ATTENDANCE (For Flutter List View & Refresh Indicators)
====================================================
*/
app.get("/api/attendance/all", (req, res) => {
  // লেটেস্ট এটেনডেন্সগুলো লিস্টের প্রথমে রাখার জন্য সর্ট করা হয়েছে
  const sortedRecords = [...attendanceRecords].sort((a, b) => b.attendanceId - a.attendanceId);
  
  res.json({
    status: "SUCCESS",
    total: sortedRecords.length,
    records: sortedRecords
  });
});

/*
====================================================
SERVER START
====================================================
*/
app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log(`🚀 HRM SERVER RUNNING ON PORT : ${PORT}`);
  console.log(`🏢 OFFICE : ${OFFICE.officeName}`);
  console.log(`📍 TARGET GPS : ${OFFICE.latitude}, ${OFFICE.longitude}`);
  console.log(`🎯 SAFE RADIUS : ${OFFICE.radiusMeter} meters`);
  console.log("======================================");
});