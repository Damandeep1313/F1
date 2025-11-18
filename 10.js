// Combined F1 Server - OpenF1 Proxy + Chart Generation
require('dotenv').config();
const express = require("express");
const axios = require("axios");
const bodyParser = require('body-parser');
const cloudinary = require('cloudinary').v2;
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Base URL for OpenF1 API
const OPENF1_BASE = "https://api.openf1.org";

// Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// Chart.js Config (for server-side rendering)
const width = 1000;
const height = 600;
const chartCallback = (ChartJS) => {
    ChartJS.defaults.responsive = false;
    ChartJS.defaults.maintainAspectRatio = false;
};
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback });

// ============================================
// HELPER FUNCTIONS FROM CODE 1
// ============================================

// Utility to proxy requests
async function fetchFromOpenF1(path, query) {
  try {
    const url = `${OPENF1_BASE}${path}`;
    const res = await axios.get(url, { params: query }); 
    return res.data;
  } catch (err) {
    console.error("OpenF1 API error:", err.message);
    throw err;
  }
}

// Generic handler generator
function createRoute(path) {
  return async (req, res) => {
    try {
      const data = await fetchFromOpenF1(path, req.query);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch from OpenF1" });
    }
  };
}

const sanitizeOpenF1Date = (dateString) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    return date.toISOString().slice(0, 23) + 'Z';
};

// ============================================
// HELPER FUNCTIONS FROM CODE 2
// ============================================

// Helper to map user input (e.g., "R") to OpenF1 Session Names
const mapSessionType = (type) => {
    const map = {
        'R': 'Race',
        'Q': 'Qualifying',
        'FP1': 'Practice 1',
        'FP2': 'Practice 2',
        'FP3': 'Practice 3',
        'S': 'Sprint'
    };
    return map[type] || 'Race';
};

// Helper to find Session Key
const getSessionKey = async (year, country, sessionType) => {
    try {
        const openF1Type = mapSessionType(sessionType);
        const response = await axios.get(`https://api.openf1.org/v1/sessions?year=${year}&country_name=${country}&session_name=${openF1Type}`);
        
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
                resource_type: "image"
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
        'VER': '#0600ef', 'PER': '#0600ef', // RBR
        'LEC': '#dc0000', 'SAI': '#dc0000', // Ferrari
        'HAM': '#00d2be', 'RUS': '#00d2be', // Merc
        'NOR': '#ff8700', 'PIA': '#ff8700', // McLaren
        'ALO': '#006f62', 'STR': '#006f62', // Aston
    };
    return colors[driver] || '#808080';
};

// ============================================
// ENDPOINTS FROM CODE 1 (OpenF1 Proxy)
// ============================================

// *** NEW UNIFIED ENDPOINT - /f1_info ***
app.get("/f1_info", async (req, res) => {
  const { type, name, year, country_name, session_name } = req.query;

  if (!type) {
    return res.status(400).json({ 
      error: "Missing 'type' parameter. Valid types: 'drivers', 'sessions', 'meetings'" 
    });
  }

  try {
    switch(type.toLowerCase()) {
      case 'drivers': {
        const drivers = await fetchFromOpenF1("/v1/drivers");
        const uniqueDriversMap = new Map();
        
        drivers.forEach(driver => {
          const driverNumber = driver.driver_number;
          const currentEntryKey = driver.session_key;
          
          if (!uniqueDriversMap.has(driverNumber) || currentEntryKey > uniqueDriversMap.get(driverNumber).session_key) {
            uniqueDriversMap.set(driverNumber, driver);
          }
        });

        let resultDrivers = Array.from(uniqueDriversMap.values());
        
        if (name) {
          const searchNeedle = name.toLowerCase();
          resultDrivers = resultDrivers.filter(driver => {
            const fullName = (driver.full_name || "").toLowerCase();
            const broadcastName = (driver.broadcast_name || "").toLowerCase();
            return fullName.includes(searchNeedle) || broadcastName.includes(searchNeedle);
          });
        }

        return res.json({
          type: "drivers",
          count: resultDrivers.length,
          data: resultDrivers
        });
      }

      case 'sessions': {
        const queryParams = {};
        if (year) queryParams.year = year;
        if (country_name) queryParams.country_name = country_name;
        if (session_name) queryParams.session_name = session_name;

        const sessions = await fetchFromOpenF1("/v1/sessions", queryParams);
        return res.json({
          type: "sessions",
          count: sessions.length,
          data: sessions
        });
      }

      case 'meetings': {
        const queryParams = {};
        if (year) queryParams.year = year;
        if (country_name) queryParams.country_name = country_name;

        const meetings = await fetchFromOpenF1("/v1/meetings", queryParams);
        return res.json({
          type: "meetings",
          count: meetings.length,
          data: meetings
        });
      }

      default:
        return res.status(400).json({ 
          error: "Invalid type. Valid types: 'drivers', 'sessions', 'meetings'" 
        });
    }
  } catch (err) {
    console.error("F1 Info API error:", err.message);
    res.status(500).json({ error: "Failed to fetch F1 information" });
  }
});

// Keep individual endpoints for backward compatibility
app.get("/drivers", async (req, res) => {
  try {
    const drivers = await fetchFromOpenF1("/v1/drivers");
    const filterName = req.query.name;

    const uniqueDriversMap = new Map();
    
    drivers.forEach(driver => {
      const driverNumber = driver.driver_number;
      const currentEntryKey = driver.session_key;
      
      if (!uniqueDriversMap.has(driverNumber) || currentEntryKey > uniqueDriversMap.get(driverNumber).session_key) {
        uniqueDriversMap.set(driverNumber, driver);
      }
    });

    let resultDrivers = Array.from(uniqueDriversMap.values());
    
    if (filterName) {
      const searchNeedle = filterName.toLowerCase();
      
      resultDrivers = resultDrivers.filter(driver => {
        const fullName = (driver.full_name || "").toLowerCase();
        const broadcastName = (driver.broadcast_name || "").toLowerCase();
        
        return fullName.includes(searchNeedle) || broadcastName.includes(searchNeedle);
      });
    }

    res.json(resultDrivers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch or filter drivers" });
  }
});

// Car Data Route
app.get("/car_data", async (req, res) => {
  const { session_key, driver_number, lap_number, date } = req.query;

  if (!session_key || !driver_number) {
    return res.status(400).json({ 
      error: "Missing required query parameters: session_key and driver_number." 
    });
  }

  let carDataQuery = req.query;

  if (lap_number) {
    try {
      const lapData = await fetchFromOpenF1("/v1/laps", {
        session_key: session_key,
        driver_number: driver_number,
        lap_number: lap_number
      });

      if (!lapData || lapData.length === 0) {
        console.warn(`Lap data not found for S:${session_key} D:${driver_number} L:${lap_number}`);
        return res.status(404).json({ error: `Lap ${lap_number} not found for driver ${driver_number} in session ${session_key}` });
      }

      const lap = lapData[0];
      const rawStartTime = lap.date_start; 
      const duration = lap.lap_duration; 
      
      const startTime = sanitizeOpenF1Date(rawStartTime);
      
      const startDateTime = new Date(startTime);
      const bufferMs = 2000; 
      const endDateTime = new Date(startDateTime.getTime() + (duration * 1000) + bufferMs); 

      const endTime = sanitizeOpenF1Date(endDateTime.toISOString());
      
      console.log('--- Car Data Debug ---');
      console.log(`Lap Duration: ${duration}s`);
      console.log(`Start Time (Sanitized): ${startTime}`);
      console.log(`End Time (Calculated & Sanitized): ${endTime}`);
      console.log('----------------------');

      carDataQuery = {
        session_key: session_key,
        driver_number: driver_number,
        'date>=': startTime, 
        'date<=': endTime
      };

    } catch (err) {
      console.error("Error fetching lap data for car_data:", err.message);
      return res.status(500).json({ error: "Failed to fetch lap time data." });
    }
  } else if (!date) {
    return res.status(400).json({ 
        error: "For /car_data, you must provide either a 'lap_number' or a precise 'date' filter." 
    });
  }
  
  try {
    const data = await fetchFromOpenF1("/v1/car_data", carDataQuery);
    const limitedData = data.slice(0, 5);
    res.json(limitedData); 
  } catch (err) {
    console.error("OpenF1 API error in /car_data:", err.message);
    res.status(500).json({ error: "Failed to fetch car data from OpenF1" });
  }
});

// Lap Intervals Route
app.get("/lap_intervals", async (req, res) => {
  const { session_key, driver_number, lap_number } = req.query;

  if (!session_key || !driver_number || !lap_number) {
    return res.status(400).json({ 
      error: "Please specify the required parameters: 'session_key', 'driver_number', and 'lap_number'." 
    });
  }

  try {
    const lapData = await fetchFromOpenF1("/v1/laps", {
      session_key: session_key,
      driver_number: driver_number,
      lap_number: lap_number
    });

    if (!lapData || lapData.length === 0 || !lapData[0].date_start || !lapData[0].lap_duration) {
      return res.status(404).json({ error: `Valid lap duration data not found for Lap ${lap_number}.` });
    }

    const lap = lapData[0];
    const rawStartTime = lap.date_start; 
    const duration = lap.lap_duration; 
    
    const startTime = sanitizeOpenF1Date(rawStartTime);
    const startDateTime = new Date(startTime);
    const lapEndTimeMs = startDateTime.getTime() + (duration * 1000);
    
    const wideWindowMs = 10000;

    const windowStart = sanitizeOpenF1Date(new Date(lapEndTimeMs - wideWindowMs).toISOString());
    const windowEnd = sanitizeOpenF1Date(new Date(lapEndTimeMs + wideWindowMs).toISOString());

    const intervalData = await fetchFromOpenF1("/v1/intervals", {
        session_key: session_key,
        driver_number: driver_number,
        'date>=': windowStart,
        'date<=': windowEnd
    });
    
    if (intervalData.length === 0) {
        return res.status(200).json({ 
            error: "Interval data is missing for this lap. Try a different lap.",
            data: []
        });
    }

    let closestRecord = intervalData.reduce((closest, current) => {
        const currentDiff = Math.abs(new Date(current.date).getTime() - lapEndTimeMs);
        const closestDiff = Math.abs(new Date(closest.date).getTime() - lapEndTimeMs);
        
        return (currentDiff < closestDiff) ? current : closest;
    }, intervalData[0]);

    res.json([closestRecord]);

  } catch (err) {
    console.error("Error in /lap_intervals:", err.message);
    res.status(500).json({ error: "Failed to process interval data request." });
  }
});

// Session Result Route
app.get("/session_result", async (req, res) => {
  const { session_key, driver_number } = req.query;

  if (!session_key) {
    return res.status(400).json({ 
      error: "The /session_result endpoint requires a 'session_key' parameter to filter the results. Please specify a session ID." 
    });
  }

  const query = {
    session_key: session_key,
    ...(driver_number && { driver_number: driver_number })
  };
  
  try {
    const data = await fetchFromOpenF1("/v1/session_result", query);
    res.json(data);
  } catch (err) {
    console.error("OpenF1 API error in /session_result:", err.message);
    res.status(500).json({ error: "Failed to fetch session results from OpenF1" });
  }
});

// Core REST endpoints (Generic routes)
app.get("/laps", createRoute("/v1/laps"));
app.get("/meetings", createRoute("/v1/meetings")); // Kept for backward compatibility
app.get("/overtakes", createRoute("/v1/overtakes"));
app.get("/pit", createRoute("/v1/pit"));
app.get("/position", createRoute("/v1/position"));
app.get("/race_control", createRoute("/v1/race_control"));
app.get("/sessions", createRoute("/v1/sessions")); // Kept for backward compatibility
app.get("/starting_grid", createRoute("/v1/starting_grid"));
app.get("/stints", createRoute("/v1/stints"));
app.get("/team_radio", createRoute("/v1/team_radio"));
app.get("/weather", createRoute("/v1/weather"));

// ============================================
// ENDPOINTS FROM CODE 2 (Chart Generation)
// ============================================

// 1. /fastest_lap_summary (Fastest Lap Summary) - RENAMED from /laps
app.post('/fastest_lap_summary', async (req, res) => {
    try {
        const { year, gp, session_type, driver } = req.body;
        const sessionKey = await getSessionKey(year, gp, session_type);

        const url = `https://api.openf1.org/v1/laps?session_key=${sessionKey}`;
        const { data: laps } = await axios.get(url);

        let filteredLaps = laps.filter(l => l.lap_duration !== null);

        if (driver) {
            const driverUpper = driver.toUpperCase();
            const driverInfoUrl = `https://api.openf1.org/v1/drivers?session_key=${sessionKey}&name_acronym=${driverUpper}`;
            const driverRes = await axios.get(driverInfoUrl);
            
            if(driverRes.data.length === 0) return res.status(404).json({ detail: "Driver not found" });
            
            const driverNumber = driverRes.data[0].driver_number;
            filteredLaps = filteredLaps.filter(l => l.driver_number === driverNumber);
        }

        if (filteredLaps.length === 0) return res.status(404).json({ detail: "No valid laps found." });

        filteredLaps.sort((a, b) => a.lap_duration - b.lap_duration);
        const fastLap = filteredLaps[0];

        const allLapsUrl = `https://api.openf1.org/v1/laps?session_key=${sessionKey}`;
        const allLapsRes = await axios.get(allLapsUrl);
        const globalFastest = allLapsRes.data
            .filter(l => l.lap_duration)
            .sort((a, b) => a.lap_duration - b.lap_duration)[0];

        const driverDetail = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`);
        const driverAcronym = driverDetail.data[0]?.name_acronym || "UNK";

        res.json({
            status: "Success",
            data_type: "Fastest Lap Summary",
            driver: driverAcronym,
            lap_time_seconds: fastLap.lap_duration,
            lap_number: fastLap.lap_number,
            compound: "N/A",
            tyre_age_at_lap_end: 0,
            session_fastest: fastLap.lap_duration === globalFastest.lap_duration
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ detail: e.message });
    }
});

// 2. /telemetry_chart (Speed Trace)
app.post('/telemetry_chart', async (req, res) => {
    try {
        const { year, gp, session_type, driver, lap_number } = req.body;
        if (!driver || !lap_number) return res.status(400).json({ detail: "Driver and Lap Number required." });

        const sessionKey = await getSessionKey(year, gp, session_type);

        const driverRes = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}&name_acronym=${driver.toUpperCase()}`);
        if (!driverRes.data.length) return res.status(404).json({ detail: "Driver not found" });
        const driverNumber = driverRes.data[0].driver_number;

        const lapsRes = await axios.get(`https://api.openf1.org/v1/laps?session_key=${sessionKey}&driver_number=${driverNumber}&lap_number=${lap_number}`);
        if (!lapsRes.data.length) return res.status(404).json({ detail: "Lap not found" });
        
        const lapData = lapsRes.data[0];
        const startTime = lapData.date_start;
        const endTime = new Date(new Date(startTime).getTime() + (lapData.lap_duration * 1000)).toISOString();

        const carDataUrl = `https://api.openf1.org/v1/car_data?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${startTime}&date<=${endTime}`;
        const { data: telemetry } = await axios.get(carDataUrl);

        const labels = telemetry.map((_, i) => i);
        const speeds = telemetry.map(t => t.speed);

        const configuration = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Speed (km/h)',
                    data: speeds,
                    borderColor: 'red',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                }]
            },
            options: {
                scales: {
                    y: { beginAtZero: false, title: { display: true, text: 'Speed (km/h)' } },
                    x: { display: false, title: { display: true, text: 'Distance (approx)' } }
                },
                plugins: {
                    title: { display: true, text: `${driver} - Lap ${lap_number} Speed Trace` },
                    legend: { display: false }
                }
            }
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const publicId = `${year}-${gp}-${session_type}-${driver}-lap${lap_number}-speed`;
        const url = await uploadImageToCloudinary(imageBuffer, publicId);

        res.json({
            status: "Success",
            data_type: "Image URL (Speed Trace)",
            driver: driver,
            lap_number: lap_number,
            image_url: url
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ detail: e.message });
    }
});

// 3. /pitstops_chart
app.post('/pitstops_chart', async (req, res) => {
    try {
        const { year, gp, session_type } = req.body;
        const sessionKey = await getSessionKey(year, gp, session_type);

        const pitsRes = await axios.get(`https://api.openf1.org/v1/pit?session_key=${sessionKey}`);
        const pitStops = pitsRes.data;

        if (pitStops.length === 0) return res.status(404).json({ detail: "No pit stops found" });

        const driversRes = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`);
        const driverMap = {};
        driversRes.data.forEach(d => driverMap[d.driver_number] = d.name_acronym);

        const counts = {};
        pitStops.forEach(stop => {
            const name = driverMap[stop.driver_number] || stop.driver_number;
            counts[name] = (counts[name] || 0) + 1;
        });

        const sortedDrivers = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        const sortedCounts = sortedDrivers.map(d => counts[d]);

        const configuration = {
            type: 'bar',
            data: {
                labels: sortedDrivers,
                datasets: [{
                    label: 'Pit Stops',
                    data: sortedCounts,
                    backgroundColor: 'coral'
                }]
            },
            options: {
                plugins: {
                    title: { display: true, text: `Total Pit Stops - ${year} ${gp}` }
                }
            }
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const publicId = `${year}-${gp}-${session_type}-pit-count`;
        const url = await uploadImageToCloudinary(imageBuffer, publicId);

        res.json({
            status: "Success",
            data_type: "Image URL (Pit Stop Count Chart)",
            session: `${year} ${gp} ${session_type}`,
            image_url: url
        });

    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// ============================================
// ROOT ENDPOINT
// ============================================

app.get("/", (req, res) => {
  res.send("Combined OpenF1 REST Proxy + Chart Generation Server is running 🚦🏎️");
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🏁 Combined F1 Server running at http://localhost:${PORT}`);
  console.log(`✨ NEW: Unified endpoint /f1_info?type=[drivers|sessions|meetings]`);
  console.log(`📊 Chart endpoints ready (POST): /fastest_lap_summary, /telemetry_chart, /pitstops_chart, /gap_chart, /weather_chart, /telemetry_summary, /pitstops_summary`);
  console.log(`🔌 Proxy endpoints ready (GET): /drivers, /car_data, /laps, /meetings, /sessions, etc.`);
});

// 4. /gap_chart (Gap Intervals)
app.post('/gap_chart', async (req, res) => {
    try {
        const { year, gp, session_type } = req.body;
        const sessionKey = await getSessionKey(year, gp, session_type);

        const { data: allLaps } = await axios.get(`https://api.openf1.org/v1/laps?session_key=${sessionKey}`);
        const { data: drivers } = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`);
        
        const driverMap = {};
        drivers.forEach(d => driverMap[d.driver_number] = d.name_acronym);

        const topDrivers = drivers.slice(0, 5).map(d => d.driver_number); 

        const driverTimes = {};

        allLaps.forEach(lap => {
            if (!driverTimes[lap.driver_number]) driverTimes[lap.driver_number] = [];
            driverTimes[lap.driver_number].push({ lap: lap.lap_number, time: lap.lap_duration || 100 });
        });

        Object.keys(driverTimes).forEach(d => {
            driverTimes[d].sort((a, b) => a.lap - b.lap);
        });

        const cumulative = {};
        Object.keys(driverTimes).forEach(d => {
            cumulative[d] = [];
            let total = 0;
            driverTimes[d].forEach(l => {
                total += l.time;
                cumulative[d].push({ lap: l.lap, total });
            });
        });

        const referenceDriver = topDrivers[0];
        if(!cumulative[referenceDriver]) return res.status(404).json({detail: "Data insufficient"});

        const datasets = [];
        
        topDrivers.forEach(dNum => {
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
                pointRadius: 0
            });
        });

        const configuration = {
            type: 'line',
            data: { labels: cumulative[referenceDriver].map(l => l.lap), datasets },
            options: {
                scales: { y: { reverse: true, title: { display: true, text: "Gap (s)" } } },
                plugins: { title: { display: true, text: `Gap to Leader - ${year} ${gp}` } }
            }
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const publicId = `${year}-${gp}-${session_type}-gap-to-leader`;
        const url = await uploadImageToCloudinary(imageBuffer, publicId);

        res.json({
            status: "Success",
            data_type: "Image URL (Gap to Leader Chart)",
            session: `${year} ${gp} ${session_type}`,
            image_url: url
        });

    } catch (e) {
        console.log(e);
        res.status(500).json({ detail: e.message });
    }
});

// 5. /weather_chart
app.post('/weather_chart', async (req, res) => {
    try {
        const { year, gp, session_type } = req.body;
        const sessionKey = await getSessionKey(year, gp, session_type);

        const { data: weather } = await axios.get(`https://api.openf1.org/v1/weather?session_key=${sessionKey}`);
        
        if(weather.length === 0) return res.status(404).json({ detail: "No weather data." });

        const labels = weather.map((_, i) => i);
        const trackTemp = weather.map(w => w.track_temperature);
        const airTemp = weather.map(w => w.air_temperature);

        const configuration = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Track Temp', data: trackTemp, borderColor: 'red', fill: false, pointRadius: 0 },
                    { label: 'Air Temp', data: airTemp, borderColor: 'skyblue', fill: false, pointRadius: 0 }
                ]
            },
            options: {
                plugins: { title: { display: true, text: `Temperatures - ${year} ${gp}` } }
            }
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const publicId = `${year}-${gp}-${session_type}-temperature-trace`;
        const url = await uploadImageToCloudinary(imageBuffer, publicId);

        res.json({
            status: "Success",
            data_type: "Image URL (Temperature Chart)",
            session: `${year} ${gp} ${session_type}`,
            image_url: url
        });

    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 6. /telemetry_summary
app.post('/telemetry_summary', async (req, res) => {
    try {
        const { year, gp, session_type, driver, lap_number } = req.body;
        if (!driver || !lap_number) return res.status(400).json({ detail: "Required fields missing" });

        const sessionKey = await getSessionKey(year, gp, session_type);
        
        const driverRes = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}&name_acronym=${driver.toUpperCase()}`);
        if (!driverRes.data.length) return res.status(404).json({ detail: "Driver not found" });
        const driverNumber = driverRes.data[0].driver_number;

        const lapsRes = await axios.get(`https://api.openf1.org/v1/laps?session_key=${sessionKey}&driver_number=${driverNumber}&lap_number=${lap_number}`);
        const lapData = lapsRes.data[0];
        const startTime = lapData.date_start;
        const endTime = new Date(new Date(startTime).getTime() + (lapData.lap_duration * 1000)).toISOString();

        const { data: telemetry } = await axios.get(`https://api.openf1.org/v1/car_data?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${startTime}&date<=${endTime}`);

        const speeds = telemetry.map(t => t.speed);
        const throttles = telemetry.map(t => t.throttle);
        
        const maxSpeed = Math.max(...speeds);
        const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        const avgThrottle = throttles.reduce((a, b) => a + b, 0) / throttles.length;
        
        const brakingPoints = throttles.filter(t => t < 5).length;
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
                avg_throttle_percent: parseFloat(avgThrottle.toFixed(1))
            }
        });

    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 7. /pitstops_summary (Raw Data) - RENAMED from /pitstops
app.post('/pitstops_summary', async (req, res) => {
    try {
        const { year, gp, session_type } = req.body;
        const sessionKey = await getSessionKey(year, gp, session_type);

        const { data: pitStops } = await axios.get(`https://api.openf1.org/v1/pit?session_key=${sessionKey}`);
        const { data: drivers } = await axios.get(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`);
        const driverMap = {};
        drivers.forEach(d => driverMap[d.driver_number] = d.name_acronym);

        const formattedPits = pitStops.map(stop => ({
            driver: driverMap[stop.driver_number] || stop.driver_number,
            lap_number: stop.lap_number,
            pit_duration_seconds: stop.pit_duration,
            tyres_fitted: "Unknown"
        }));

        res.json({
            status: "Success",
            data_type: "Pit Stop Summary",
            pit_stops: formattedPits
        });

    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});
