// Combined F1 Server - OpenF1 Proxy + Consolidated Insights
// INCLUDES: 
// 1. Hybrid Session Key Fix & Static Map Defaults
// 2. SMART PROXY FIX
// 3. HISTORICAL LOOKBACK & DATE FILTERING
// 4. AUTHENTICATION LAYER (Env Vars preferred over Headers)
// 5. ROBUST MAPPING
// 6. CONSOLIDATED INSIGHTS
// 7. RICH RESPONSE
// 8. SMART DRIVER RESOLVER
// 9. FUZZY TYPE RESOLVER
// 10. STARTUP DIAGNOSTICS (New!)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cloudinary = require("cloudinary").v2;
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const app = express();
const PORT = process.env.PORT || 3000;

// Base URL for OpenF1 API
const OPENF1_BASE = "https://api.openf1.org";

// Caches
const meetingsCache = {};
const tokenCache = {}; 

// Middleware
app.use(bodyParser.json());

// Cloudinary Config
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudApiKey = process.env.CLOUDINARY_API_KEY;
const cloudApiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && cloudApiKey && cloudApiSecret) {
    cloudinary.config({
        cloud_name: cloudName,
        api_key: cloudApiKey,
        api_secret: cloudApiSecret,
        secure: true,
    });
}

// Chart.js Config
const width = 1000;
const height = 600;
const chartCallback = (ChartJS) => {
  ChartJS.defaults.responsive = false;
  ChartJS.defaults.maintainAspectRatio = false;
};
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback });

// ============================================
// 🔐 AUTHENTICATION HELPERS (UPDATED)
// ============================================
async function getAccessToken(username, password) {
    if (!username || !password) return null;
    const now = Date.now();
    // Cache key combines username to support multiple credentials if needed
    if (tokenCache[username] && tokenCache[username].expiresAt > (now + 60000)) {
        return tokenCache[username].token;
    }
    console.log(`[Auth] Fetching new token for user: ${username}`);
    try {
        const params = new URLSearchParams();
        params.append("username", username);
        params.append("password", password);
        const response = await axios.post(`${OPENF1_BASE}/token`, params, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        tokenCache[username] = { token: response.data.access_token, expiresAt: now + (response.data.expires_in * 1000) };
        return response.data.access_token;
    } catch (err) {
        console.error("[Auth] Token fetch failed:", err.response ? err.response.data : err.message);
        return null;
    }
}

async function resolveTokenFromRequest(req) {
    // 1. PRIORITY: Environment Variables (Server-Side Auth)
    const envUser = process.env.OPENF1_USERNAME;
    const envPass = process.env.OPENF1_PASSWORD;

    if (envUser && envPass) {
        // Don't log on every request to keep noise down, but we know it's working from startup logs
        return await getAccessToken(envUser, envPass);
    }

    // 2. FALLBACK: Request Headers (Client-Side Auth)
    const headerUser = req.headers['openf1-username'];
    const headerPass = req.headers['openf1-password'];
    
    if (headerUser && headerPass) {
        return await getAccessToken(headerUser, headerPass);
    }
    
    return null;
}

// ============================================
// CORE HELPERS
// ============================================
const filterByMonth = (data, monthInput) => {
    if (!monthInput || !Array.isArray(data)) return data;
    const monthMap = { "jan": 0, "january": 0, "01": 0, "1": 0, "feb": 1, "february": 1, "02": 1, "2": 1, "mar": 2, "march": 2, "03": 2, "3": 2, "apr": 3, "april": 3, "04": 3, "4": 3, "may": 4, "05": 4, "5": 4, "jun": 5, "june": 5, "06": 5, "6": 5, "jul": 6, "july": 6, "07": 6, "7": 6, "aug": 7, "august": 7, "08": 7, "8": 7, "sep": 8, "september": 8, "09": 8, "9": 8, "oct": 9, "october": 9, "10": 9, "nov": 10, "november": 10, "11": 10, "dec": 11, "december": 11, "12": 11 };
    const targetMonth = monthMap[monthInput.toString().toLowerCase().trim()];
    if (targetMonth === undefined) return data;
    return data.filter(item => item.date_start && new Date(item.date_start).getUTCMonth() === targetMonth);
};

async function fetchFromOpenF1(path, query, token = null) {
  try {
    const config = { params: query, headers: {} };
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    const res = await axios.get(`${OPENF1_BASE}${path}`, config);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status !== 404) console.error(`OpenF1 API error on ${path}:`, err.message);
    throw err;
  }
}

const sanitizeOpenF1Date = (dateString) => dateString ? new Date(dateString).toISOString().slice(0, 23) + "Z" : null;

const mapSessionType = (type) => {
  if (!type) return "Race";
  const map = { R: "Race", Q: "Qualifying", FP1: "Practice 1", FP2: "Practice 2", FP3: "Practice 3", S: "Sprint", RACE: "Race", QUALIFYING: "Qualifying" };
  return map[type.toUpperCase().trim()] || "Race";
};

const uploadImageToCloudinary = async (buffer, publicId) => {
  if (!cloudinary.config().cloud_name) throw new Error("Cloudinary credentials missing");
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "f1_charts", public_id: `f1_visuals/${publicId}`, resource_type: "image" },
      (error, result) => error ? reject(error) : resolve(result.secure_url)
    );
    uploadStream.end(buffer);
  });
};

const getDriverColor = (driver) => {
  const colors = { VER: "#0600ef", PER: "#0600ef", LEC: "#dc0000", SAI: "#dc0000", HAM: "#00d2be", RUS: "#00d2be", NOR: "#ff8700", PIA: "#ff8700", ALO: "#006f62", STR: "#006f62" };
  return colors[driver] || "#808080";
};

// ============================================
// DYNAMIC MAPPING & RESOLVER LOGIC
// ============================================
const normalizeString = (str) => str ? str.replace(/[_\-]/g, " ").toUpperCase().replace(/[^A-Z\s]/g, "").trim() : "";

const fetchAndBuildLocationMap = async (year, token = null) => {
  if (meetingsCache[year]) return meetingsCache[year];
  const map = new Map([
    ["ABU DHABI", "United Arab Emirates"], ["ABUDHABI", "United Arab Emirates"], ["YAS MARINA", "United Arab Emirates"], ["YASMARINA", "United Arab Emirates"], ["UAE", "United Arab Emirates"],
    ["SILVERSTONE", "Great Britain"], ["BRITISH", "Great Britain"], ["UK", "Great Britain"],
    ["SPA", "Belgium"], ["SPA FRANCORCHAMPS", "Belgium"], ["MONZA", "Italy"], ["IMOLA", "Italy"], ["MONACO", "Monaco"], ["BAKU", "Azerbaijan"], ["AZERBAIJAN", "Azerbaijan"],
    ["COTA", "United States"], ["AUSTIN", "United States"], ["MIAMI", "United States"], ["LAS VEGAS", "United States"], ["LASVEGAS", "United States"], ["VEGAS", "United States"], ["USA", "United States"], ["US", "United States"],
    ["MEXICO", "Mexico"], ["MEXICO CITY", "Mexico"], ["MEXICOCITY", "Mexico"], ["INTERLAGOS", "Brazil"], ["SAO PAULO", "Brazil"], ["SAOPAULO", "Brazil"], ["BRAZIL", "Brazil"],
    ["SUZUKA", "Japan"], ["JAPAN", "Japan"], ["JEDDAH", "Saudi Arabia"], ["SAUDI", "Saudi Arabia"], ["BAHRAIN", "Bahrain"], ["SAKHIR", "Bahrain"],
    ["MELBOURNE", "Australia"], ["AUSTRALIA", "Australia"], ["MONTREAL", "Canada"], ["CANADA", "Canada"], ["BARCELONA", "Spain"], ["SPAIN", "Spain"],
    ["ZANDVOORT", "Netherlands"], ["DUTCH", "Netherlands"], ["HUNGARORING", "Hungary"], ["HUNGARY", "Hungary"],
    ["RED BULL RING", "Austria"], ["REDBULLRING", "Austria"], ["AUSTRIA", "Austria"], ["SPIELBERG", "Austria"],
    ["SINGAPORE", "Singapore"], ["MARINA BAY", "Singapore"], ["MARINABAY", "Singapore"], ["QATAR", "Qatar"], ["LUSAIL", "Qatar"], ["CHINA", "China"], ["SHANGHAI", "China"]
  ]);

  try {
    const config = { params: { year }, timeout: 3000, headers: token ? { 'Authorization': `Bearer ${token}` } : {} };
    const response = await axios.get(`${OPENF1_BASE}/v1/meetings`, config);
    if (response.data && response.data.length > 0) {
      response.data.forEach((m) => {
        const country = m.country_name;
        map.set(normalizeString(country), country);
        if (m.location) map.set(normalizeString(m.location), country);
        if (m.meeting_name) {
            map.set(normalizeString(m.meeting_name), country);
            if (m.meeting_name.split(/\s+/)[0]) map.set(normalizeString(m.meeting_name.split(/\s+/)[0]), country);
        }
      });
      meetingsCache[year] = map;
    }
    return map;
  } catch (err) { return map; }
};

const resolveCountryFromHistory = async (fuzzyName, token = null) => {
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
    const normalized = normalizeString(fuzzyName);
    for (const year of years) {
        try {
            const map = await fetchAndBuildLocationMap(year, token);
            const resolved = map.get(normalized) || map.get(normalized.split(/\s+/)[0]);
            if (resolved) return resolved;
        } catch (e) { }
    }
    return null;
};

const getSessionKey = async (year, location, sessionType, token = null, month = null) => {
  let countryToQuery = await resolveCountryFromHistory(location, token) || location;
  try {
    const openF1Type = mapSessionType(sessionType);
    const config = { params: { year, country_name: countryToQuery, session_name: openF1Type }, headers: token ? { 'Authorization': `Bearer ${token}` } : {} };
    const response = await axios.get(`${OPENF1_BASE}/v1/sessions`, config);
    let sessions = response.data;
    
    if (sessions.length === 0) throw new Error(`Session not found for '${countryToQuery}' and '${openF1Type}' in year ${year}.`);
    
    if (month) {
        sessions = filterByMonth(sessions, month);
        if (sessions.length === 0) throw new Error(`No sessions found in ${month} for ${countryToQuery} in year ${year}.`);
    }
    sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    return sessions[sessions.length - 1].session_key;
  } catch (error) {
    throw new Error(`Failed to locate session: ${error.response ? error.response.data.error : error.message}`);
  }
};

// NEW: Smart Driver Resolver
const resolveDriverNumber = async (sessionKey, driverInput, token) => {
    if (!driverInput) return null;
    
    const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
    
    const needle = driverInput.toString().toLowerCase().trim();
    const match = drivers.find(d => {
        return (
            (d.name_acronym && d.name_acronym.toLowerCase() === needle) ||
            (d.driver_number && d.driver_number.toString() === needle) ||
            (d.last_name && d.last_name.toLowerCase().includes(needle)) ||
            (d.full_name && d.full_name.toLowerCase().includes(needle))
        );
    });

    if (match) {
        console.log(`[Driver Resolver] Resolved '${driverInput}' -> #${match.driver_number} (${match.name_acronym})`);
        return match.driver_number;
    }
    
    console.warn(`[Driver Resolver] Could not find driver '${driverInput}'.`);
    return null;
}

// NEW: Fuzzy Insight Type Resolver
const resolveInsightType = (inputType) => {
    if (!inputType) return null;
    const normalizedInput = inputType.toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = Object.keys(INSIGHT_HANDLERS);
    const match = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedInput);
    if (match) console.log(`[Type Resolver] '${inputType}' -> '${match}'`);
    return match || null;
};

// ============================================
// 🧩 INSIGHT HANDLERS
// ============================================
const INSIGHT_HANDLERS = {
    fastest_lap_summary: async (sessionKey, body, token) => {
        const { data: laps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        let filtered = laps.filter((l) => l.lap_duration);
        
        if (body.driver) {
            const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (driverNum) filtered = filtered.filter(l => l.driver_number === driverNum);
            else throw new Error(`Driver '${body.driver}' not found.`);
        }
        if (!filtered.length) throw new Error("No valid laps found for this criteria.");
        
        filtered.sort((a, b) => a.lap_duration - b.lap_duration);
        const fastLap = filtered[0];
        
        const dDetail = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        
        let compound = "N/A";
        let tyreAge = 0;
        try {
            const { data: stints } = await axios.get(`${OPENF1_BASE}/v1/stints?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const matchingStint = stints.find(s => fastLap.lap_number >= s.lap_start && fastLap.lap_number <= s.lap_end);
            if (matchingStint) {
                compound = matchingStint.compound || "Unknown";
                tyreAge = fastLap.lap_number - matchingStint.lap_start + 1; 
            }
        } catch(e) { }

        return { 
            driver: dDetail.data[0]?.name_acronym || "UNK", 
            full_name: dDetail.data[0]?.full_name,
            lap_time: fastLap.lap_duration, 
            lap_number: fastLap.lap_number,
            compound: compound,
            tyre_age_laps: tyreAge
        };
    },

    telemetry_chart: async (sessionKey, body, token) => {
        if (!body.driver || !body.lap_number) throw new Error("Driver and Lap Number required.");
        
        const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
        if (!driverNum) throw new Error(`Driver '${body.driver}' not found.`);

        const lRes = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${driverNum}&lap_number=${body.lap_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!lRes.data.length) throw new Error("Lap not found.");
        
        const lap = lRes.data[0];
        const start = lap.date_start;
        const end = new Date(new Date(start).getTime() + lap.lap_duration * 1000).toISOString();
        const { data: tel } = await axios.get(`${OPENF1_BASE}/v1/car_data?session_key=${sessionKey}&driver_number=${driverNum}&date>=${start}&date<=${end}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        
        const config = {
            type: "line", data: { labels: tel.map((_, i) => i), datasets: [{ label: "Speed", data: tel.map(t => t.speed), borderColor: "red", borderWidth: 1, pointRadius: 0, fill: false }] },
            options: { scales: { y: { title: { display: true, text: "Speed (km/h)" } }, x: { display: false } }, plugins: { title: { display: true, text: `${body.driver} Lap ${body.lap_number} Speed` }, legend: { display: false } } }
        };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-${body.driver}-lap${body.lap_number}-speed`);
        return { image_url: url, data_type: "Speed Trace" };
    },

    pitstops_summary: async (sessionKey, body, token) => {
        const { data: pits } = await axios.get(`${OPENF1_BASE}/v1/pit?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        
        let targetPits = pits;
        if (body.driver) {
            const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (driverNum) targetPits = pits.filter(p => p.driver_number === driverNum);
        }

        let enhancedPits = targetPits;
        try {
            const { data: stints } = await axios.get(`${OPENF1_BASE}/v1/stints?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            enhancedPits = targetPits.map(p => {
                const stint = stints.find(s => s.driver_number === p.driver_number && Math.abs(s.lap_start - p.lap_number) <= 1);
                return { ...p, tyre_fitted: stint ? stint.compound : "Unknown" };
            });
        } catch(e) {}

        return { 
            pit_stops: enhancedPits.map(p => ({ 
                driver: dMap[p.driver_number] || p.driver_number, 
                lap: p.lap_number, 
                duration: p.pit_duration,
                tyres_fitted: p.tyre_fitted || "Unknown"
            })),
            count: enhancedPits.length 
        };
    },

    pitstops_chart: async (sessionKey, body, token) => {
        const { data: pits } = await axios.get(`${OPENF1_BASE}/v1/pit?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        const counts = {};
        pits.forEach(p => { const n = dMap[p.driver_number] || p.driver_number; counts[n] = (counts[n] || 0) + 1; });
        const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        
        const config = { type: "bar", data: { labels: sorted, datasets: [{ label: "Stops", data: sorted.map(d => counts[d]), backgroundColor: "coral" }] }, options: { plugins: { title: { display: true, text: "Pit Stops" } } } };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-pit-count`);
        return { image_url: url, data_type: "Pit Count Chart" };
    },

    gap_chart: async (sessionKey, body, token) => {
        const { data: laps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        const top5 = drivers.slice(0, 5).map(d => d.driver_number);
        const dTimes = {};
        laps.forEach(l => { if (!dTimes[l.driver_number]) dTimes[l.driver_number] = []; dTimes[l.driver_number].push({ lap: l.lap_number, time: l.lap_duration || 100 }); });
        const cumulative = {};
        Object.keys(dTimes).forEach(d => { dTimes[d].sort((a,b) => a.lap - b.lap); cumulative[d] = []; let tot = 0; dTimes[d].forEach(l => { tot += l.time; cumulative[d].push({lap: l.lap, total: tot}); }); });
        const ref = top5[0];
        if (!cumulative[ref]) throw new Error("Insufficient data for gap analysis.");
        const datasets = top5.map(dNum => { if (!cumulative[dNum]) return null; const data = []; cumulative[dNum].forEach((l, i) => { if(cumulative[ref][i]) data.push(l.total - cumulative[ref][i].total); }); return { label: dMap[dNum], data, borderColor: getDriverColor(dMap[dNum]), fill: false, pointRadius: 0 }; }).filter(Boolean);
        const config = { type: "line", data: { labels: cumulative[ref].map(l => l.lap), datasets }, options: { scales: { y: { reverse: true, title: { display: true, text: "Gap (s)" } } }, plugins: { title: { display: true, text: "Gap to Leader" } } } };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-gap-chart`);
        return { image_url: url, data_type: "Gap Chart" };
    },

    weather_chart: async (sessionKey, body, token) => {
        const { data: w } = await axios.get(`${OPENF1_BASE}/v1/weather?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!w.length) throw new Error("No weather data.");
        const config = { type: "line", data: { labels: w.map((_,i) => i), datasets: [{ label: "Track Temp", data: w.map(x => x.track_temperature), borderColor: "red", fill: false, pointRadius: 0 }, { label: "Air Temp", data: w.map(x => x.air_temperature), borderColor: "skyblue", fill: false, pointRadius: 0 }] }, options: { plugins: { title: { display: true, text: "Temperatures" } } } };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-weather`);
        return { image_url: url, data_type: "Weather Chart" };
    },

    lap_analysis: async (sessionKey, body, token) => {
        const { data: laps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        
        let targetLaps = laps.filter(l => l.lap_duration);
        
        if (body.driver) {
            const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (driverNum) {
                targetLaps = targetLaps.filter(l => l.driver_number === driverNum);
            } else {
                throw new Error(`Driver '${body.driver}' not found.`);
            }
        }
        
        if (!targetLaps.length) throw new Error("No laps found.");
        const times = targetLaps.map(l => l.lap_duration);
        const avg = times.reduce((a,b)=>a+b,0) / times.length;
        const std = Math.sqrt(times.reduce((s,t) => s + Math.pow(t-avg, 2), 0) / times.length);
        const dNums = body.driver ? [targetLaps[0].driver_number] : [...new Set(targetLaps.map(l => l.driver_number))].slice(0,5);
        const datasets = dNums.map(dn => ({ label: dMap[dn] || dn, data: laps.filter(l => l.driver_number === dn && l.lap_duration).map(l => l.lap_duration), borderColor: getDriverColor(dMap[dn]), fill: false, pointRadius: 1 }));
        const config = { type: "line", data: { labels: datasets[0].data.map((_,i)=>i+1), datasets }, options: { scales: { y: { title: { display: true, text: "Lap Time" } } }, plugins: { title: { display: true, text: "Lap Consistency" } } } };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-lap-analysis`);
        return { summary: { average_lap: parseFloat(avg.toFixed(3)), std_dev: parseFloat(std.toFixed(3)), count: targetLaps.length }, chart_url: url };
    },
    
    telemetry_summary: async (sessionKey, body, token) => {
        if (!body.driver || !body.lap_number) throw new Error("Driver and Lap Number required.");
        const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
        if (!driverNum) throw new Error(`Driver '${body.driver}' not found.`);
        const lRes = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${driverNum}&lap_number=${body.lap_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!lRes.data.length) throw new Error("Lap not found.");
        const lap = lRes.data[0];
        const start = lap.date_start;
        const end = new Date(new Date(start).getTime() + lap.lap_duration * 1000).toISOString();
        const { data: tel } = await axios.get(`${OPENF1_BASE}/v1/car_data?session_key=${sessionKey}&driver_number=${driverNum}&date>=${start}&date<=${end}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        
        const speeds = tel.map(t => t.speed);
        const maxSpeed = Math.max(...speeds);
        const avgSpeed = speeds.reduce((a,b) => a+b, 0) / speeds.length;
        const throttles = tel.map(t => t.throttle);
        const avgThrottle = throttles.reduce((a,b) => a+b, 0) / throttles.length;
        
        return {
            max_speed_kph: parseFloat(maxSpeed.toFixed(1)),
            avg_speed_kph: parseFloat(avgSpeed.toFixed(1)),
            avg_throttle_percent: parseFloat(avgThrottle.toFixed(1))
        };
    }
};

// ============================================
// 🚀 MAIN ROUTES
// ============================================

app.post("/generate_insight", async (req, res) => {
    const { type, year, gp, location, session_type, month } = req.body;
    const loc = location || gp;

    const validKey = resolveInsightType(type);

    if (!validKey) {
        return res.status(400).json({ error: `Invalid type '${type}'. Available: ${Object.keys(INSIGHT_HANDLERS).join(", ")}` });
    }
    if (!year || !loc) return res.status(400).json({ error: "Missing year or location/gp." });

    try {
        const token = await resolveTokenFromRequest(req);
        const sessionKey = await getSessionKey(year, loc, session_type, token, month);
        
        console.log(`[Insight] Generating ${validKey} for session ${sessionKey}...`);
        const result = await INSIGHT_HANDLERS[validKey](sessionKey, req.body, token);
        
        res.json({
            status: "Success",
            request: { type: validKey, year, location: loc, session_type: session_type || "R" },
            result
        });
    } catch (e) {
        console.error(`[Insight Error] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.get("/raw_data_proxy", async (req, res) => {
  const resource = req.query.resource;
  let queryParams = { ...req.query };
  let token = null;
  try { token = await resolveTokenFromRequest(req); } catch (e) {}

  if (!resource) return res.status(400).json({ error: "Missing resource." });
  delete queryParams.resource;

  if (queryParams.extra_query) {
      try { new URLSearchParams(queryParams.extra_query).forEach((v, k) => queryParams[k] = v); delete queryParams.extra_query; } catch(e){}
  }
  
  const monthFilter = queryParams.month || queryParams.date;
  if (queryParams.month) delete queryParams.month;
  if (queryParams.date && !queryParams.date.includes('-')) delete queryParams.date;
  
  const ALIAS = { 'circuit_id': 'circuit_key', 'meeting_id': 'meeting_key', 'session_id': 'session_key', 'driver_id': 'driver_number' };
  Object.entries(ALIAS).forEach(([b,g]) => { if(queryParams[b]) { queryParams[g] = queryParams[b]; delete queryParams[b]; }});
  
  const fuzzy = queryParams.country_name || queryParams.location || queryParams.gp;
  if (fuzzy) {
      const resolved = await resolveCountryFromHistory(fuzzy, token);
      if (resolved) { queryParams.country_name = resolved; delete queryParams.location; delete queryParams.gp; }
  }

  try {
      let data = await fetchFromOpenF1(`/v1/${resource}`, queryParams, token);
      if (['meetings', 'sessions'].includes(resource) && Array.isArray(data)) {
          if (monthFilter) data = filterByMonth(data, monthFilter);
          data.sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
          if (data.length > 5 && !queryParams.country_name) data = data.slice(0, 5);
      }
      res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/find_session_key", async (req, res) => {
  const { year, location, session_type, month } = req.query;
  if (!year || !location) return res.status(400).json({ error: "Missing params." });
  
  try {
    const token = await resolveTokenFromRequest(req);
    const key = await getSessionKey(year, location, session_type, token, month);
    
    const sessionDataArr = await fetchFromOpenF1("/v1/sessions", { session_key: key }, token);
    const sessionData = sessionDataArr[0];

    res.json({ 
        status: "Success", 
        session_key: key,
        openf1_resolved_name: { 
            country: sessionData.country_name, 
            session: sessionData.session_name 
        },
        session_info: sessionData
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/drivers", async (req, res) => {
    try {
        const token = await resolveTokenFromRequest(req);
        const drivers = await fetchFromOpenF1("/v1/drivers", {}, token);
        res.json(drivers.slice(0, 20));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// STARTUP DIAGNOSTICS (Run Once)
// ============================================
app.listen(PORT, () => {
    console.log(`\n🏁 Consolidated F1 Server (Authenticated & Date-Aware) running at http://localhost:${PORT}`);
    
    // 1. Check Auth
    if (process.env.OPENF1_USERNAME && process.env.OPENF1_PASSWORD) {
        console.log("✅ OpenF1 Credentials detected in .env");
    } else {
        console.warn("⚠️  OpenF1 Credentials NOT found. Requests will be unauthenticated (Rate Limited).");
    }

    // 2. Check Cloudinary
    if (process.env.CLOUDINARY_CLOUD_NAME) {
        console.log("✅ Cloudinary Config detected.");
    } else {
        console.warn("⚠️  Cloudinary Config missing. Charts will fail.");
    }
    console.log("\n");
});
