// index.js
// Combined F1 Server - OpenF1 Proxy + Chart Generation (CONSOLIDATED & FINAL FIX)
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cloudinary = require("cloudinary").v2;
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Base URL for OpenF1 API
const OPENF1_BASE = "https://api.openf1.org";

// Cloudinary Config (Assumes environment variables are loaded via dotenv)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Chart.js Config (for server-side rendering)
const width = 1000;
const height = 600;
const chartCallback = (ChartJS) => {
  ChartJS.defaults.responsive = false;
  ChartJS.defaults.maintainAspectRatio = false;
};
const chartJSNodeCanvas = new ChartJSNodeCanvas({
  width,
  height,
  chartCallback,
});

// ============================================
// CORE HELPERS
// ============================================

// Utility to proxy requests
async function fetchFromOpenF1(path, query) {
  try {
    const url = `${OPENF1_BASE}${path}`;
    const res = await axios.get(url, { params: query });
    return res.data;
  } catch (err) {
    console.error(`OpenF1 API error on ${path}:`, err.message);
    throw new Error(
      `OpenF1 Request Failed for ${path}: ${
        err.response?.statusText || err.message
      }`
    );
  }
}

const sanitizeOpenF1Date = (dateString) => {
  if (!dateString) return null;
  const date = new Date(dateString);
  return date.toISOString().slice(0, 23) + "Z";
};

// Helper to map user input (e.g., "R") to OpenF1 Session Names
const mapSessionType = (type) => {
  const map = {
    R: "Race",
    Q: "Qualifying",
    FP1: "Practice 1",
    FP2: "Practice 2",
    FP3: "Practice 3",
    S: "Sprint",
  };
  return map[type] || "Race";
};

// Helper to find Session Key
const getSessionKey = async (year, country, sessionType) => {
  try {
    const openF1Type = mapSessionType(sessionType);
    const response = await axios.get(
      `${OPENF1_BASE}/v1/sessions?year=${year}&country_name=${country}&session_name=${openF1Type}`
    );
    if (response.data.length === 0) throw new Error("Session not found");
    return response.data[0].session_key;
  } catch (error) {
    throw new Error(`Failed to locate session: ${error.message}`);
  }
};

// Helper to Upload Buffer to Cloudinary
const uploadImageToCloudinary = async (buffer, publicId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "f1_charts",
        public_id: `f1_visuals/${publicId}`,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
};

// Helper to convert drivers to colors
const getDriverColor = (driver) => {
  const colors = {
    VER: "#0600ef",
    PER: "#0600ef",
    LEC: "#dc0000",
    SAI: "#dc0000",
    HAM: "#00d2be",
    RUS: "#00d2be",
    NOR: "#ff8700",
    PIA: "#ff8700",
    ALO: "#006f62",
    STR: "#006f62",
  };
  return colors[driver] || "#808080";
};
// ----------------------------------------------------

// ============================================
// 🎯 CONSOLIDATED PROXY ROUTE (FIXED)
// ============================================

const CONSOLIDATED_RESOURCES = [
  "laps",
  "meetings",
  "sessions",
  "pit",
  "weather",
  "starting_grid",
  "stints",
  "position",
  "race_control",
  "team_radio",
  "overtakes",
  // Custom Logic Resources
  "car_data",
  "lap_intervals",
  "session_result",
];

app.get("/raw_data_proxy", async (req, res) => {
  const resource = req.query.resource;
  let queryParams = { ...req.query };

  if (!resource || !CONSOLIDATED_RESOURCES.includes(resource)) {
    return res.status(400).json({
      error: "Missing or invalid 'resource' parameter.",
      valid_resources: CONSOLIDATED_RESOURCES,
    });
  }

  // CRITICAL FIX: The resource parameter must be removed from the query sent to OpenF1
  delete queryParams.resource;

  // 2. Route to the appropriate handler (custom logic or generic proxy)

  if (resource === "car_data") {
    // --- Special Handling for car_data (Custom Lap Logic) ---
    const { session_key, driver_number, lap_number, date } = req.query;

    if (!session_key || !driver_number) {
      return res
        .status(400)
        .json({
          error:
            "Missing required query parameters: session_key and driver_number.",
        });
    }

    if (lap_number) {
      try {
        // Fetch the target lap directly
        const targetLapNum = parseInt(lap_number);
        const lapsSurrounding = await fetchFromOpenF1("/v1/laps", {
          session_key,
          driver_number,
          lap_number: targetLapNum,
        });

        // If we only got one lap, fetch previous lap separately
        let targetLapData = lapsSurrounding.find(
          (l) => l.lap_number === targetLapNum
        );

        if (!targetLapData && lapsSurrounding.length === 1) {
          targetLapData = lapsSurrounding[0];
        }

        if (lapsSurrounding.length === 0 || !targetLapData) {
          return res.status(404).json({
            error: `Lap ${lap_number} not found for driver ${driver_number} in session ${session_key}.`,
            hint:
              "Try checking available laps with: /raw_data_proxy?resource=laps&session_key=" +
              session_key +
              "&driver_number=" +
              driver_number,
          });
        }

        if (!targetLapData.lap_duration) {
          return res.status(404).json({
            error: `Lap ${lap_number} exists but has no valid lap_duration (likely an outlap/inlap).`,
            lap_data: targetLapData,
          });
        }

        // Fetch the previous lap separately if needed
        let prevLap = null;
        if (targetLapNum > 1) {
          const prevLapData = await fetchFromOpenF1("/v1/laps", {
            session_key,
            driver_number,
            lap_number: targetLapNum - 1,
          });
          if (prevLapData && prevLapData.length > 0) {
            prevLap = prevLapData[0];
          }
        }

        // Use whichever lap has date_start for the start time
        let startLap = prevLap && prevLap.date_start ? prevLap : targetLapData;

        if (!startLap || !startLap.date_start) {
          return res.status(404).json({
            error: `No valid date_start found for lap ${lap_number} or its previous lap.`,
          });
        }

        if (!targetLapData.date_start) {
          return res.status(404).json({
            error: `Target lap ${lap_number} is missing date_start field.`,
          });
        }

        // Calculate time window
        const startTime = sanitizeOpenF1Date(startLap.date_start);
        const targetLapEndTimeMs =
          new Date(sanitizeOpenF1Date(targetLapData.date_start)).getTime() +
          targetLapData.lap_duration * 1000;
        const endTime = sanitizeOpenF1Date(
          new Date(targetLapEndTimeMs + 2000).toISOString()
        );

        console.log(
          `[DEBUG] Lap ${lap_number} time window: ${startTime} to ${endTime}`
        );

        // Apply dynamic date filters to the clean queryParams
        queryParams["date>="] = startTime;
        queryParams["date<="] = endTime;
        delete queryParams.lap_number;
      } catch (err) {
        return res
          .status(500)
          .json({
            error: "Failed to fetch lap time data for car_data logic.",
            details: err.message,
          });
      }
    }

    try {
      console.log(`[DEBUG] Fetching car_data with params:`, queryParams);
      const data = await fetchFromOpenF1("/v1/car_data", queryParams);
      console.log(`[DEBUG] Got ${data.length} car_data records`);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    // End Special Handling for car_data
  } else if (resource === "lap_intervals") {
    // --- Special Handling for lap_intervals (Custom Proximity Logic) ---
    const { session_key, driver_number, lap_number } = req.query;

    if (!session_key || !driver_number || !lap_number) {
      return res
        .status(400)
        .json({ error: "Missing required parameters for lap_intervals." });
    }

    try {
      const lapData = await fetchFromOpenF1("/v1/laps", {
        session_key,
        driver_number,
        lap_number,
      });
      if (
        !lapData ||
        lapData.length === 0 ||
        !lapData[0].date_start ||
        !lapData[0].lap_duration
      ) {
        return res
          .status(404)
          .json({
            error: `Valid lap duration data not found for Lap ${lap_number}.`,
          });
      }

      const lap = lapData[0];
      const lapEndTimeMs =
        new Date(sanitizeOpenF1Date(lap.date_start)).getTime() +
        lap.lap_duration * 1000;

      // FIX: Increased search window to 30s to mitigate data sparsity
      const wideWindowMs = 30000;

      const windowStart = sanitizeOpenF1Date(
        new Date(lapEndTimeMs - wideWindowMs).toISOString()
      );
      const windowEnd = sanitizeOpenF1Date(
        new Date(lapEndTimeMs + wideWindowMs).toISOString()
      );

      const intervalData = await fetchFromOpenF1("/v1/intervals", {
        session_key,
        driver_number,
        "date>=": windowStart,
        "date<=": windowEnd,
      });

      if (intervalData.length === 0) {
        // FIX: Changed 200 to 404/error when data is definitively missing.
        return res
          .status(404)
          .json({
            error:
              "Interval data is missing for this lap. Try a different lap.",
            data: [],
          });
      }

      // Find the single record whose timestamp is closest to the exact lap end time
      let closestRecord = intervalData.reduce((closest, current) => {
        const currentDiff = Math.abs(
          new Date(current.date).getTime() - lapEndTimeMs
        );
        const closestDiff =
          closest && closest.date
            ? Math.abs(new Date(closest.date).getTime() - lapEndTimeMs)
            : Infinity;
        return currentDiff < closestDiff ? current : closest;
      }, intervalData[0]);

      return res.json([closestRecord]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    // End Special Handling for lap_intervals
  } else if (resource === "session_result") {
    // --- Special Handling for session_result (Custom Required Key Logic) ---
    const { session_key } = req.query;

    if (!session_key) {
      return res
        .status(400)
        .json({
          error:
            "The session_result endpoint requires a 'session_key' parameter.",
        });
    }

    try {
      const data = await fetchFromOpenF1("/v1/session_result", queryParams);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    // End Special Handling for session_result
  } else {
    // 3. Handle Generic Resources (e.g., /laps, /meetings, /pit, /weather, etc.)
    const openF1Path = `/v1/${resource}`;
    try {
      const data = await fetchFromOpenF1(openF1Path, queryParams);
      return res.json(data);
    } catch (err) {
      const status = err.response ? err.response.status : 500;
      return res.status(status).json({ error: err.message });
    }
  }
});

// ============================================
// ⚡ KEEP SEPARATE GET ROUTE (Drivers)
// ============================================
app.get("/drivers", async (req, res) => {
  try {
    const drivers = await fetchFromOpenF1("/v1/drivers");
    const filterName = req.query.name;

    const uniqueDriversMap = new Map();
    drivers.forEach((driver) => {
      const driverNumber = driver.driver_number;
      const currentEntryKey = driver.session_key;
      if (
        !uniqueDriversMap.has(driverNumber) ||
        currentEntryKey > uniqueDriversMap.get(driverNumber).session_key
      ) {
        uniqueDriversMap.set(driverNumber, driver);
      }
    });

    let resultDrivers = Array.from(uniqueDriversMap.values());
    if (filterName) {
      const searchNeedle = filterName.toLowerCase();
      resultDrivers = resultDrivers.filter((driver) => {
        const fullName = (driver.full_name || "").toLowerCase();
        const broadcastName = (driver.broadcast_name || "").toLowerCase();
        return (
          fullName.includes(searchNeedle) ||
          broadcastName.includes(searchNeedle)
        );
      });
    }

    res.json(resultDrivers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch or filter drivers" });
  }
});

// ============================================
// 📊 CHART & ANALYSIS POST ROUTES (8 Paths)
// ============================================

// 1. /fastest_lap_summary
app.post("/fastest_lap_summary", async (req, res) => {
  try {
    const { year, gp, session_type, driver } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const url = `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`;
    const { data: laps } = await axios.get(url);

    let filteredLaps = laps.filter((l) => l.lap_duration !== null);

    if (driver) {
      const driverUpper = driver.toUpperCase();
      const driverInfoUrl = `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&name_acronym=${driverUpper}`;
      const driverRes = await axios.get(driverInfoUrl);

      if (driverRes.data.length === 0)
        return res.status(404).json({ detail: "Driver not found" });

      const driverNumber = driverRes.data[0].driver_number;
      filteredLaps = filteredLaps.filter(
        (l) => l.driver_number === driverNumber
      );
    }

    if (filteredLaps.length === 0)
      return res.status(404).json({ detail: "No valid laps found." });

    filteredLaps.sort((a, b) => a.lap_duration - b.lap_duration);
    const fastLap = filteredLaps[0];

    const allLapsUrl = `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`;
    const allLapsRes = await axios.get(allLapsUrl);
    const globalFastest = allLapsRes.data
      .filter((l) => l.lap_duration)
      .sort((a, b) => a.lap_duration - b.lap_duration)[0];

    const driverDetail = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`
    );
    const driverAcronym = driverDetail.data[0]?.name_acronym || "UNK";

    res.json({
      status: "Success",
      data_type: "Fastest Lap Summary",
      driver: driverAcronym,
      lap_time_seconds: fastLap.lap_duration,
      lap_number: fastLap.lap_number,
      compound: "N/A",
      tyre_age_at_lap_end: 0,
      session_fastest: fastLap.lap_duration === globalFastest.lap_duration,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: e.message });
  }
});

// 2. /telemetry_chart
app.post("/telemetry_chart", async (req, res) => {
  try {
    const { year, gp, session_type, driver, lap_number } = req.body;
    if (!driver || !lap_number)
      return res
        .status(400)
        .json({ detail: "Driver and Lap Number required." });

    const sessionKey = await getSessionKey(year, gp, session_type);

    const driverRes = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&name_acronym=${driver.toUpperCase()}`
    );
    if (!driverRes.data.length)
      return res.status(404).json({ detail: "Driver not found" });
    const driverNumber = driverRes.data[0].driver_number;

    const lapsRes = await axios.get(
      `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${driverNumber}&lap_number=${lap_number}`
    );
    if (!lapsRes.data.length)
      return res.status(404).json({ detail: "Lap not found" });

    const lapData = lapsRes.data[0];
    const startTime = lapData.date_start;
    const endTime = new Date(
      new Date(startTime).getTime() + lapData.lap_duration * 1000
    ).toISOString();

    const carDataUrl = `${OPENF1_BASE}/v1/car_data?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${startTime}&date<=${endTime}`;
    const { data: telemetry } = await axios.get(carDataUrl);

    const labels = telemetry.map((_, i) => i);
    const speeds = telemetry.map((t) => t.speed);

    const configuration = {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Speed (km/h)",
            data: speeds,
            borderColor: "red",
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        scales: {
          y: {
            beginAtZero: false,
            title: { display: true, text: "Speed (km/h)" },
          },
          x: {
            display: false,
            title: { display: true, text: "Distance (approx)" },
          },
        },
        plugins: {
          title: {
            display: true,
            text: `${driver} - Lap ${lap_number} Speed Trace`,
          },
          legend: { display: false },
        },
      },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const publicId = `${year}-${gp}-${session_type}-${driver}-lap${lap_number}-speed`;
    const url = await uploadImageToCloudinary(imageBuffer, publicId);

    res.json({
      status: "Success",
      data_type: "Image URL (Speed Trace)",
      driver: driver,
      lap_number: lap_number,
      image_url: url,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: e.message });
  }
});

// 3. /pitstops_chart
app.post("/pitstops_chart", async (req, res) => {
  try {
    const { year, gp, session_type } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const pitsRes = await axios.get(
      `${OPENF1_BASE}/v1/pit?session_key=${sessionKey}`
    );
    const pitStops = pitsRes.data;

    if (pitStops.length === 0)
      return res.status(404).json({ detail: "No pit stops found" });

    const driversRes = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`
    );
    const driverMap = {};
    driversRes.data.forEach(
      (d) => (driverMap[d.driver_number] = d.name_acronym)
    );

    const counts = {};
    pitStops.forEach((stop) => {
      const name = driverMap[stop.driver_number] || stop.driver_number;
      counts[name] = (counts[name] || 0) + 1;
    });

    const sortedDrivers = Object.keys(counts).sort(
      (a, b) => counts[b] - counts[a]
    );
    const sortedCounts = sortedDrivers.map((d) => counts[d]);

    const configuration = {
      type: "bar",
      data: {
        labels: sortedDrivers,
        datasets: [
          {
            label: "Pit Stops",
            data: sortedCounts,
            backgroundColor: "coral",
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: `Total Pit Stops - ${year} ${gp}` },
        },
      },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const publicId = `${year}-${gp}-${session_type}-pit-count`;
    const url = await uploadImageToCloudinary(imageBuffer, publicId);

    res.json({
      status: "Success",
      data_type: "Image URL (Pit Stop Count Chart)",
      session: `${year} ${gp} ${session_type}`,
      image_url: url,
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

// 4. /gap_chart
app.post("/gap_chart", async (req, res) => {
  try {
    const { year, gp, session_type } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const { data: allLaps } = await axios.get(
      `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`
    );
    const { data: drivers } = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`
    );

    const driverMap = {};
    drivers.forEach((d) => (driverMap[d.driver_number] = d.name_acronym));

    const topDrivers = drivers.slice(0, 5).map((d) => d.driver_number);

    const driverTimes = {};

    allLaps.forEach((lap) => {
      if (!driverTimes[lap.driver_number]) driverTimes[lap.driver_number] = [];
      driverTimes[lap.driver_number].push({
        lap: lap.lap_number,
        time: lap.lap_duration || 100,
      });
    });

    Object.keys(driverTimes).forEach((d) => {
      driverTimes[d].sort((a, b) => a.lap - b.lap);
    });

    const cumulative = {};
    Object.keys(driverTimes).forEach((d) => {
      cumulative[d] = [];
      let total = 0;
      driverTimes[d].forEach((l) => {
        total += l.time;
        cumulative[d].push({ lap: l.lap, total });
      });
    });

    const referenceDriver = topDrivers[0];
    if (!cumulative[referenceDriver])
      return res.status(404).json({ detail: "Data insufficient" });

    const datasets = [];

    topDrivers.forEach((dNum) => {
      if (!cumulative[dNum]) return;
      const name = driverMap[dNum];
      const dataPoints = [];

      cumulative[dNum].forEach((lapData, index) => {
        if (cumulative[referenceDriver][index]) {
          const gap = lapData.total - cumulative[referenceDriver][index].total;
          dataPoints.push(gap);
        }
      });

      datasets.push({
        label: name,
        data: dataPoints,
        borderColor: getDriverColor(name),
        fill: false,
        pointRadius: 0,
      });
    });

    const configuration = {
      type: "line",
      data: { labels: cumulative[referenceDriver].map((l) => l.lap), datasets },
      options: {
        scales: {
          y: { reverse: true, title: { display: true, text: "Gap (s)" } },
        },
        plugins: {
          title: { display: true, text: `Gap to Leader - ${year} ${gp}` },
        },
      },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const publicId = `${year}-${gp}-${session_type}-gap-to-leader`;
    const url = await uploadImageToCloudinary(imageBuffer, publicId);

    res.json({
      status: "Success",
      data_type: "Image URL (Gap to Leader Chart)",
      session: `${year} ${gp} ${session_type}`,
      image_url: url,
    });
  } catch (e) {
    console.log(e);
    res.status(500).json({ detail: e.message });
  }
});

// 5. /weather_chart
app.post("/weather_chart", async (req, res) => {
  try {
    const { year, gp, session_type } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const { data: weather } = await axios.get(
      `${OPENF1_BASE}/v1/weather?session_key=${sessionKey}`
    );

    if (weather.length === 0)
      return res.status(404).json({ detail: "No weather data." });

    const labels = weather.map((_, i) => i);
    const trackTemp = weather.map((w) => w.track_temperature);
    const airTemp = weather.map((w) => w.air_temperature);

    const configuration = {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Track Temp",
            data: trackTemp,
            borderColor: "red",
            fill: false,
            pointRadius: 0,
          },
          {
            label: "Air Temp",
            data: airTemp,
            borderColor: "skyblue",
            fill: false,
            pointRadius: 0,
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: `Temperatures - ${year} ${gp}` },
        },
      },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const publicId = `${year}-${gp}-${session_type}-temperature-trace`;
    const url = await uploadImageToCloudinary(imageBuffer, publicId);

    res.json({
      status: "Success",
      data_type: "Image URL (Temperature Chart)",
      session: `${year} ${gp} ${session_type}`,
      image_url: url,
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

// 6. /telemetry_summary
app.post("/telemetry_summary", async (req, res) => {
  try {
    const { year, gp, session_type, driver, lap_number } = req.body;
    if (!driver || !lap_number)
      return res.status(400).json({ detail: "Required fields missing" });

    const sessionKey = await getSessionKey(year, gp, session_type);

    const driverRes = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&name_acronym=${driver.toUpperCase()}`
    );
    if (!driverRes.data.length)
      return res.status(404).json({ detail: "Driver not found" });
    const driverNumber = driverRes.data[0].driver_number;

    const lapsRes = await axios.get(
      `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${driverNumber}&lap_number=${lap_number}`
    );
    const lapData = lapsRes.data[0];
    const startTime = lapData.date_start;
    const endTime = new Date(
      new Date(startTime).getTime() + lapData.lap_duration * 1000
    ).toISOString();

    const { data: telemetry } = await axios.get(
      `${OPENF1_BASE}/v1/car_data?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${startTime}&date<=${endTime}`
    );

    const speeds = telemetry.map((t) => t.speed);
    const throttles = telemetry.map((t) => t.throttle);

    const maxSpeed = Math.max(...speeds);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const avgThrottle = throttles.reduce((a, b) => a + b, 0) / throttles.length;

    const brakingPoints = throttles.filter((t) => t < 5).length;
    const totalPoints = throttles.length;
    const brakingPercent = (brakingPoints / totalPoints) * 100;

    res.json({
      status: "Success",
      data_type: "Telemetry Summary",
      driver: driver,
      lap_number: lap_number,
      summary: {
        max_speed_kph: parseFloat(maxSpeed.toFixed(1)),
        avg_speed_kph: parseFloat(avgSpeed.toFixed(1)),
        braking_percent_of_lap_distance: parseFloat(brakingPercent.toFixed(1)),
        avg_throttle_percent: parseFloat(avgThrottle.toFixed(1)),
      },
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

// 7. /pitstops_summary
app.post("/pitstops_summary", async (req, res) => {
  try {
    const { year, gp, session_type } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const { data: pitStops } = await axios.get(
      `${OPENF1_BASE}/v1/pit?session_key=${sessionKey}`
    );
    const { data: drivers } = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`
    );
    const driverMap = {};
    drivers.forEach((d) => (driverMap[d.driver_number] = d.name_acronym));

    const formattedPits = pitStops.map((stop) => ({
      driver: driverMap[stop.driver_number] || stop.driver_number,
      lap_number: stop.lap_number,
      pit_duration_seconds: stop.pit_duration,
      tyres_fitted: "Unknown",
    }));

    res.json({
      status: "Success",
      data_type: "Pit Stop Summary",
      pit_stops: formattedPits,
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

// 8. /lap_analysis (NEW - Replaces root endpoint)
app.post("/lap_analysis", async (req, res) => {
  try {
    const { year, gp, session_type, driver } = req.body;
    const sessionKey = await getSessionKey(year, gp, session_type);

    const { data: allLaps } = await axios.get(
      `${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`
    );
    const { data: drivers } = await axios.get(
      `${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`
    );

    const driverMap = {};
    drivers.forEach((d) => (driverMap[d.driver_number] = d.name_acronym));

    // Filter by driver if specified
    let filteredLaps = allLaps.filter((l) => l.lap_duration !== null);
    let targetDriverNumber = null;

    if (driver) {
      const driverUpper = driver.toUpperCase();
      const driverInfo = drivers.find((d) => d.name_acronym === driverUpper);
      if (!driverInfo)
        return res.status(404).json({ detail: "Driver not found" });
      targetDriverNumber = driverInfo.driver_number;
      filteredLaps = filteredLaps.filter(
        (l) => l.driver_number === targetDriverNumber
      );
    }

    if (filteredLaps.length === 0)
      return res.status(404).json({ detail: "No valid laps found" });

    // Calculate stats
    const sortedLaps = [...filteredLaps].sort(
      (a, b) => a.lap_duration - b.lap_duration
    );
    const fastestLap = sortedLaps[0];
    const lapTimes = filteredLaps.map((l) => l.lap_duration);
    const avgLap = lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length;
    const stdDev = Math.sqrt(
      lapTimes.reduce((sum, time) => sum + Math.pow(time - avgLap, 2), 0) /
        lapTimes.length
    );
    const consistency = ((1 - stdDev / avgLap) * 100).toFixed(1);

    // Prepare chart data - lap progression for top 5 or single driver
    let chartDrivers = [];
    if (driver) {
      chartDrivers = [targetDriverNumber];
    } else {
      const driverLapCounts = {};
      allLaps.forEach((l) => {
        driverLapCounts[l.driver_number] =
          (driverLapCounts[l.driver_number] || 0) + 1;
      });
      chartDrivers = Object.keys(driverLapCounts)
        .sort((a, b) => driverLapCounts[b] - driverLapCounts[a])
        .slice(0, 5)
        .map((d) => parseInt(d));
    }

    const datasets = [];
    chartDrivers.forEach((dNum) => {
      const driverLaps = allLaps
        .filter((l) => l.driver_number === dNum && l.lap_duration)
        .sort((a, b) => a.lap_number - b.lap_number);

      if (driverLaps.length > 0) {
        datasets.push({
          label: driverMap[dNum] || dNum,
          data: driverLaps.map((l) => l.lap_duration),
          borderColor: getDriverColor(driverMap[dNum]),
          fill: false,
          pointRadius: 1,
        });
      }
    });

    const maxLaps = Math.max(...datasets.map((d) => d.data.length));
    const labels = Array.from({ length: maxLaps }, (_, i) => i + 1);

    const configuration = {
      type: "line",
      data: { labels, datasets },
      options: {
        scales: {
          y: {
            beginAtZero: false,
            title: { display: true, text: "Lap Time (s)" },
          },
          x: { title: { display: true, text: "Lap Number" } },
        },
        plugins: {
          title: {
            display: true,
            text: driver
              ? `${driver} Lap Progression - ${year} ${gp}`
              : `Lap Progression - ${year} ${gp}`,
          },
        },
      },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const publicId = `${year}-${gp}-${session_type}-${
      driver || "all"
    }-lap-progression`;
    const chartUrl = await uploadImageToCloudinary(imageBuffer, publicId);

    res.json({
      status: "Success",
      data_type: "Lap Analysis",
      session: `${year} ${gp} ${mapSessionType(session_type)}`,
      summary: {
        total_laps: filteredLaps.length,
        fastest_lap: {
          driver: driverMap[fastestLap.driver_number],
          time_seconds: parseFloat(fastestLap.lap_duration.toFixed(3)),
          lap_number: fastestLap.lap_number,
        },
        average_lap_time: parseFloat(avgLap.toFixed(3)),
        consistency_percent: parseFloat(consistency),
        std_deviation: parseFloat(stdDev.toFixed(3)),
      },
      chart_url: chartUrl,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: e.message });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🏁 Consolidated F1 Server running at http://localhost:${PORT}`);
  console.log(`TOTAL ENDPOINTS: 10`);
  console.log(
    `   8 POST (Charts/Analysis): /fastest_lap_summary, /telemetry_chart, /pitstops_chart, /gap_chart, /weather_chart, /telemetry_summary, /pitstops_summary, /lap_analysis`
  );
  console.log(
    `   2 GET (Core): /drivers, /raw_data_proxy (Handles 14 OpenF1 resources)`
  );
});
