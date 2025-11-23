// Combined F1 Server - OpenF1 Proxy + Consolidated Insights
// 🏎️ MERCEDES DEMO EDITION: "Global Search" + Full Original Logic
// INCLUDES: Complex Charts, Stint Logic, Auth, Smart Session Resolver, and Fuzzy Query Handling

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cloudinary = require("cloudinary").v2;
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const app = express();
const PORT = process.env.PORT || 3000;
const OPENF1_BASE = "https://api.openf1.org";

// ============================================
// 🎯 DEMO CONFIGURATION (DEFAULTS)
// ============================================
const DEMO_DEFAULTS = {
    YEAR: 2025,
    // LOCATION REMOVED: We search globally if not provided!
    SESSION_TYPE: "Race",       
    FALLBACK_TO_LATEST: true    
};

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
// 🔐 AUTHENTICATION HELPERS
// ============================================
async function getAccessToken(username, password) {
    if (!username || !password) return null;
    const now = Date.now();
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
        console.log(`[Auth] ✅ Login Success`);
        return response.data.access_token;
    } catch (err) {
        console.error("[Auth] ❌ Login Failed:", err.response ? err.response.data : err.message);
        return null;
    }
}

async function resolveTokenFromRequest(req) {
    const envUser = process.env.OPENF1_USERNAME;
    const envPass = process.env.OPENF1_PASSWORD;
    if (envUser && envPass) return await getAccessToken(envUser, envPass);

    const headerUser = req.headers['openf1-username'];
    const headerPass = req.headers['openf1-password'];
    if (headerUser && headerPass) return await getAccessToken(headerUser, headerPass);
    
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
    if (err.response && err.response.status === 429) {
        console.error("🛑 [CRITICAL] RATE LIMIT HIT (429). PAUSE REQUESTS.");
    } else if (err.response && err.response.status !== 404) {
        console.error(`OpenF1 API error on ${path}:`, err.message);
    }
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

function formatDuration(seconds) {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(3);
    return `${mins}:${secs.padStart(6, '0')}`;
}

// ============================================
// DYNAMIC MAPPING & RESOLVER LOGIC
// ============================================
const normalizeString = (str) => str ? str.replace(/[_\-]/g, " ").toUpperCase().replace(/[^A-Z\s]/g, "").trim() : "";

// 🛡️ UPDATED: Robust Map Builder with Hardcoded Defaults
const fetchAndBuildLocationMap = async (year, token = null) => {
  if (meetingsCache[year]) return meetingsCache[year];
  
  // HARDCODED DEFAULTS (Safety Net)
  const map = new Map([
    ["ABU DHABI", "United Arab Emirates"], ["ABUDHABI", "United Arab Emirates"], ["YAS MARINA", "United Arab Emirates"], ["UAE", "United Arab Emirates"],
    ["SILVERSTONE", "Great Britain"], ["UK", "Great Britain"],
    ["SPA", "Belgium"], ["MONZA", "Italy"], ["IMOLA", "Italy"], ["MONACO", "Monaco"], 
    ["BAKU", "Azerbaijan"],
    ["COTA", "United States"], ["AUSTIN", "United States"], ["MIAMI", "United States"], 
    ["LAS VEGAS", "United States"], ["VEGAS", "United States"], ["USA", "United States"],
    ["MEXICO", "Mexico"], ["INTERLAGOS", "Brazil"], ["BRAZIL", "Brazil"],
    ["SUZUKA", "Japan"], ["JEDDAH", "Saudi Arabia"], ["BAHRAIN", "Bahrain"],
    ["MELBOURNE", "Australia"], ["MONTREAL", "Canada"], ["BARCELONA", "Spain"],
    ["ZANDVOORT", "Netherlands"], ["HUNGARORING", "Hungary"], 
    ["RED BULL RING", "Austria"], ["SPIELBERG", "Austria"],
    ["SINGAPORE", "Singapore"], ["QATAR", "Qatar"], ["SHANGHAI", "China"]
  ]);

  try {
    // Try fetching dynamic updates
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
    }
  } catch (err) { console.warn(`[Map Warning] Failed to refresh map for ${year}. Using defaults.`); }
  
  meetingsCache[year] = map;
  return map;
};

const resolveCountryFromHistory = async (fuzzyName, token = null) => {
    if (!fuzzyName) return null; // Allow null for global search
    const map = await fetchAndBuildLocationMap(2025, token); // Default to 2025 map
    const normalized = normalizeString(fuzzyName);
    return map.get(normalized) || map.get(normalized.split(/\s+/)[0]);
};

// ============================================
// 🛡️ THE "BULLETPROOF" SESSION KEY LOGIC
// ============================================

// Helper: Safely get key regardless of object structure
function safeGetSessionKey(sessionObj) {
    if (!sessionObj) return null;
    if (sessionObj.session_key) return sessionObj.session_key;
    if (sessionObj.session_id) return sessionObj.session_id; 
    return null;
}

// 🛡️ SMART SELECTOR (Recency > Name)
function selectBestSession(sessionsList, targetName) {
    if (!sessionsList || sessionsList.length === 0) return null;

    // 1. Sort EVERYTHING by Date (Newest First)
    const sorted = [...sessionsList].sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
    const latestSession = sorted[0]; // The absolute newest session
    
    // 2. Find the LATEST session that matches the requested name (e.g. "Race")
    const targetMatch = sorted.find(s => s.session_name === targetName);

    // 3. DECISION TIME:
    if (targetMatch) {
        const latestTime = new Date(latestSession.date_start).getTime();
        const targetTime = new Date(targetMatch.date_start).getTime();
        const diffDays = (latestTime - targetTime) / (1000 * 3600 * 24);

        // If "Race" is within 5 days of the "Latest Thing", it's the current event.
        // If it's 200 days old (Miami), we ignore it.
        if (diffDays < 5) { 
            console.log(`[Session Resolver] Found recent '${targetName}' (Key: ${safeGetSessionKey(targetMatch)})`);
            return targetMatch; 
        }
        
        console.warn(`[Session Resolver] Found '${targetName}' but it's ${Math.floor(diffDays)} days old. Ignoring.`);
    }

    console.warn(`[Session Resolver] Falling back to ABSOLUTE LATEST available session: ${latestSession.session_name}`);
    return latestSession;
}

const getSessionKey = async (year, location, sessionType, token = null, month = null) => {
  const locRaw = location || DEMO_DEFAULTS.LOCATION; // Might be undefined (Global Search)
  const targetYear = year || DEMO_DEFAULTS.YEAR;
  
  let countryToQuery = await resolveCountryFromHistory(locRaw, token) || locRaw;
  
  const reqType = sessionType || DEMO_DEFAULTS.SESSION_TYPE;
  const targetName = mapSessionType(reqType);

  try {
    // 1. Primary Search
    let sessions = [];
    try {
        const params = { year: targetYear };
        if (countryToQuery) params.country_name = countryToQuery;
        
        console.log(`[Session Resolver] Fetching sessions for Year: ${targetYear} ${countryToQuery ? `Location: ${countryToQuery}` : '(GLOBAL SEARCH)'}`);
        
        const config = { params, headers: token ? { 'Authorization': `Bearer ${token}` } : {} };
        const response = await axios.get(`${OPENF1_BASE}/v1/sessions`, config);
        sessions = response.data;
    } catch(e) { console.warn("Primary search failed."); }

    if (month && sessions.length > 0) sessions = filterByMonth(sessions, month);

    // 2. Select Best (Using Date Sorting)
    let match = selectBestSession(sessions, targetName);

    // 3. Latest Fallback
    if (!match && DEMO_DEFAULTS.FALLBACK_TO_LATEST) {
        try {
            const latestRes = await axios.get(`${OPENF1_BASE}/v1/sessions?session_key=latest`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            if (latestRes.data && Array.isArray(latestRes.data) && latestRes.data.length > 0) {
                match = selectBestSession(latestRes.data, targetName);
            }
        } catch (err) {}
    }

    // 4. Nuclear Fallback
    if (!match) {
        try {
            const nucRes = await axios.get(`${OPENF1_BASE}/v1/sessions`, { params: { year: targetYear }, headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            match = selectBestSession(nucRes.data, targetName);
        } catch(e) {}
    }

    if (!match) throw new Error(`CRITICAL: Could not resolve session key.`);
    
    const finalKey = safeGetSessionKey(match);
    if (!finalKey) throw new Error("Session found but key is missing.");

    console.log(`[Session Resolver] Selected: ${match.session_name} (Key: ${finalKey})`);
    return finalKey;

  } catch (error) { throw new Error(`Failed to locate session: ${error.message}`); }
};

const resolveDriverNumber = async (sessionKey, driverInput, token) => {
    if (!driverInput) return null;
    const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
    const needle = driverInput.toString().toLowerCase().trim();
    const match = drivers.find(d => ((d.name_acronym && d.name_acronym.toLowerCase() === needle) || (d.driver_number && d.driver_number.toString() === needle) || (d.last_name && d.last_name.toLowerCase().includes(needle)) || (d.full_name && d.full_name.toLowerCase().includes(needle))));
    return match ? match.driver_number : null;
}

const resolveInsightType = (inputType) => {
    if (!inputType) return null;
    const normalizedInput = inputType.toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = Object.keys(INSIGHT_HANDLERS);
    const match = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedInput);
    return match || null;
};

// ============================================
// 🧩 INSIGHT HANDLERS (ORIGINAL LOGIC RESTORED)
// ============================================
const INSIGHT_HANDLERS = {
    race_results: async (sessionKey, body, token) => {
        const { data: results } = await axios.get(`${OPENF1_BASE}/v1/session_result?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        // LIVE CHECK
        if (!results || results.length === 0) {
            console.log("[Insight] No final results. Checking LIVE positions...");
            const { data: livePos } = await axios.get(`${OPENF1_BASE}/v1/position?session_key=${sessionKey}&date=>${new Date(Date.now() - 60000).toISOString()}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            if (livePos && livePos.length > 0) {
                const latestPositions = {};
                livePos.forEach(p => { if (!latestPositions[p.driver_number] || new Date(p.date) > new Date(latestPositions[p.driver_number].date)) latestPositions[p.driver_number] = p; });
                const sortedPos = Object.values(latestPositions).sort((a, b) => a.position - b.position);
                return { data_type: "Live Leaderboard", status: "Race In Progress", leader: `#${sortedPos[0].driver_number}`, top_3_drivers: sortedPos.slice(0,3).map(p => `#${p.driver_number}`) };
            }
        }
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.full_name || d.name_acronym);
        const teamMap = {}; drivers.forEach(d => teamMap[d.driver_number] = d.team_name);
        const leaderboard = results.map(r => {
            let status = "Finished";
            if (r.is_dnf || r.dnf) status = "DNF"; 
            if (r.is_dns || r.dns) status = "DNS";
            if (r.is_dsq || r.dsq) status = "DSQ";
            let timeOrGap = status;
            if (r.position === 1) timeOrGap = formatDuration(r.duration);
            else if (r.gap_to_leader !== null && r.gap_to_leader !== undefined) {
                if (typeof r.gap_to_leader === 'number') timeOrGap = `+${r.gap_to_leader.toFixed(3)}s`;
                else timeOrGap = r.gap_to_leader;
            }
            return { position: r.position || 999, driver: dMap[r.driver_number] || r.name_acronym, team: r.team_name || teamMap[r.driver_number] || "Unknown", time_or_gap: timeOrGap, points: r.points || 0, status: status, grid_start: r.grid_position };
        }).sort((a, b) => a.position - b.position);
        return { data_type: "Final Classification", count: leaderboard.length, leaderboard: leaderboard };
    },

    // NEW HANDLER
    leaderboard_at_lap: async (sessionKey, body, token) => {
        const targetLap = parseInt(body.lap_number);
        if (!targetLap) throw new Error("Lap number required.");
        const { data: laps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&lap_number=${targetLap}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        
        const sortedLaps = laps.filter(l => l.lap_duration).map(l => ({
            driver_number: l.driver_number,
            finish_time: new Date(l.date_start).getTime() + (l.lap_duration * 1000)
        })).sort((a, b) => a.finish_time - b.finish_time);

        if (sortedLaps.length === 0) throw new Error(`No data found for Lap ${targetLap}.`);
        const leaderNum = sortedLaps[0].driver_number;
        const { data: driverInfo } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&driver_number=${leaderNum}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        return { data_type: `Leaderboard at Lap ${targetLap}`, leader: driverInfo[0] ? driverInfo[0].full_name : `#${leaderNum}`, full_order: sortedLaps.map(l => l.driver_number) };
    },

    // NEW WRAPPER
    flag_summary: async (sessionKey, body, token) => { body.filter = "flag"; return INSIGHT_HANDLERS.race_control_summary(sessionKey, body, token); },

    starting_grid: async (sessionKey, body, token) => {
        const { data: results } = await axios.get(`${OPENF1_BASE}/v1/session_result?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!results || results.length === 0) throw new Error("No grid data found.");
        const grid = results.filter(r => r.grid_position !== null).map(r => ({ position: r.grid_position, driver: r.name_acronym, team: r.team_name, driver_number: r.driver_number })).sort((a, b) => a.position - b.position);
        return { data_type: "Starting Grid", count: grid.length, grid: grid };
    },

    race_control_summary: async (sessionKey, body, token) => {
        let driverNum = null;
        let driverInfo = null;
        
        if (body.driver) {
            const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const needle = body.driver.toString().toLowerCase().trim();
            driverInfo = drivers.find(d => {
                return ((d.name_acronym && d.name_acronym.toLowerCase() === needle) || (d.driver_number && d.driver_number.toString() === needle) || (d.last_name && d.last_name.toLowerCase().includes(needle)) || (d.full_name && d.full_name.toLowerCase().includes(needle)));
            });
            if (!driverInfo) throw new Error(`Driver '${body.driver}' not found in this session.`);
            driverNum = driverInfo.driver_number;
        }

        const { data: messages } = await axios.get(`${OPENF1_BASE}/v1/race_control?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        let filtered = messages || [];
        
        if (driverInfo) {
            const dAcronym = driverInfo.name_acronym.toLowerCase(); 
            const dName = driverInfo.last_name.toLowerCase();
            filtered = filtered.filter(m => {
                const msgLower = m.message ? m.message.toLowerCase() : "";
                if (m.driver_number === driverNum) return true;
                if (msgLower.match(new RegExp(`\\bcar ${driverNum}\\b`))) return true;
                if (msgLower.includes(`(${dAcronym})`)) return true;
                if (msgLower.includes(dName)) return true;
                if (!m.driver_number) {
                    const globalKeywords = ["safety car", "virtual safety car", "red flag", "chequered flag", "drs enabled", "drs disabled", "green light", "track clear"];
                    if (globalKeywords.some(kw => msgLower.includes(kw))) return true;
                    const globalCats = ["safetycar", "virtualsafetycar", "redflag", "drs"];
                    if (globalCats.includes(m.category?.toLowerCase())) return true;
                    if (m.category?.toLowerCase() === 'flag' && ["green", "chequered", "red", "yellow"].includes(m.flag?.toLowerCase())) return true;
                }
                return false;
            });
        }

        const lapParam = body.lap_number || body.lap;
        if (lapParam) {
            const targetLap = parseInt(lapParam);
            let refDriver = driverNum; 
            if (!refDriver) {
                 const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
                 const winner = drivers.find(d => d.position === 1) || drivers[0];
                 refDriver = winner.driver_number;
            }
            const { data: lapData } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${refDriver}&lap_number=${targetLap}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            if (lapData && lapData.length > 0) {
                const lap = lapData[0];
                const startMs = new Date(lap.date_start).getTime();
                const endMs = startMs + (lap.lap_duration * 1000);
                filtered = filtered.filter(m => {
                    if (m.lap_number === targetLap) return true;
                    const msgTime = new Date(m.date).getTime();
                    return (msgTime >= startMs && msgTime <= endMs);
                });
            } else { filtered = []; }
        }

        if (body.filter) { 
            const filterRaw = body.filter.toLowerCase();
            const filterSpaced = filterRaw.replace("safetycar", "safety car").replace("virtualsafetycar", "virtual safety car");
            filtered = filtered.filter(m => {
                const corpus = [m.category, m.flag, m.message].join(" ").toLowerCase();
                return corpus.includes(filterRaw) || corpus.includes(filterSpaced);
            });
        }

        const formatted = filtered.map(m => ({ time: m.date, lap: m.lap_number, category: m.category, flag: m.flag, message: m.message, driver_number: m.driver_number }));
        formatted.sort((a, b) => new Date(a.time) - new Date(b.time));
        let explanation = `Found ${formatted.length} event(s).`;
        if (formatted.length === 0) explanation = `No events found.`;

        return { status_note: explanation, data_type: "Race Control Summary", count: formatted.length, filter_applied: `Driver: ${body.driver || "All"}, Lap: ${lapParam || "All"}, Type: ${body.filter || "All"}`, messages: formatted };
    },

    team_radio_summary: async (sessionKey, body, token) => {
        let driverNum = null;
        if (body.driver) {
            driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (!driverNum) throw new Error(`Driver '${body.driver}' not found.`);
        }
        const query = { session_key: sessionKey };
        if (driverNum) query.driver_number = driverNum;
        const { data: radios } = await axios.get(`${OPENF1_BASE}/v1/team_radio`, { params: query, headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!radios || radios.length === 0) throw new Error("No team radio messages found.");
        let driverMap = {};
        if (!driverNum) {
             const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
             drivers.forEach(d => driverMap[d.driver_number] = d.name_acronym);
        }
        const formatted = radios.map(r => ({ date: r.date, driver: driverMap[r.driver_number] || r.driver_number, driver_number: r.driver_number, recording_url: r.recording_url }));
        formatted.sort((a, b) => new Date(a.date) - new Date(b.date));
        return { data_type: "Team Radio Summary", driver_filter: body.driver || "All", count: formatted.length, messages: formatted };
    },

    overtake_analysis: async (sessionKey, body, token) => {
        if (!token) throw new Error("Overtake data requires authentication (Paid Tier).");
        const { data: overtakes } = await axios.get(`${OPENF1_BASE}/v1/overtakes?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!overtakes || overtakes.length === 0) throw new Error("No overtake data found.");
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        let relevantOvertakes = overtakes;
        if (body.driver) {
            const targetNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (targetNum) relevantOvertakes = overtakes.filter(o => o.overtaking_driver_number === targetNum || o.overtaken_driver_number === targetNum);
        }
        if (body.lap_number) {
            const lapNum = parseInt(body.lap_number);
            const refDriver = body.driver ? (await resolveDriverNumber(sessionKey, body.driver, token)) : (drivers.find(d => d.position === 1)?.driver_number || drivers[0].driver_number);
            const { data: lapData } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}&driver_number=${refDriver}&lap_number=${lapNum}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            if (lapData.length > 0) {
                const lap = lapData[0];
                const startMs = new Date(lap.date_start).getTime();
                const endMs = startMs + (lap.lap_duration * 1000);
                relevantOvertakes = relevantOvertakes.filter(o => { const oTime = new Date(o.date).getTime(); return oTime >= startMs && oTime <= endMs; });
            }
        }
        const formatted = relevantOvertakes.map(o => ({ overtaker: dMap[o.overtaking_driver_number] || o.overtaking_driver_number, overtaken: dMap[o.overtaken_driver_number] || o.overtaken_driver_number, time: o.date }));
        return { data_type: "Overtake Analysis", count: formatted.length, overtakes: formatted };
    },

    position_change_summary: async (sessionKey, body, token) => {
        if (body.lap_number) {
            const currentLapNum = parseInt(body.lap_number);
            if (currentLapNum <= 1) throw new Error("Cannot calculate changes for Lap 1.");
            const { data: allLaps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const getLeaderboard = (lapNum) => {
                const laps = allLaps.filter(l => l.lap_number === lapNum && l.date_start && l.lap_duration);
                const withFinish = laps.map(l => ({ driver_number: l.driver_number, finish_time: new Date(l.date_start).getTime() + (l.lap_duration * 1000) }));
                withFinish.sort((a, b) => a.finish_time - b.finish_time);
                const posMap = {}; withFinish.forEach((entry, index) => { posMap[entry.driver_number] = index + 1; });
                return posMap;
            };
            const posCurrent = getLeaderboard(currentLapNum);
            const posPrev = getLeaderboard(currentLapNum - 1);
            const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const driverMap = {}; drivers.forEach(d => driverMap[d.driver_number] = d.name_acronym);
            let changes = [];
            Object.keys(posCurrent).forEach(driverNum => {
                if (posPrev[driverNum] && posCurrent[driverNum]) {
                    const gained = posPrev[driverNum] - posCurrent[driverNum];
                    changes.push({ driver: driverMap[driverNum] || driverNum, driver_number: driverNum, lap_start_pos: posPrev[driverNum], lap_end_pos: posCurrent[driverNum], positions_gained: gained, status: gained > 0 ? "GAINED" : (gained < 0 ? "LOST" : "SAME") });
                }
            });
            if (body.driver) {
                const targetNum = await resolveDriverNumber(sessionKey, body.driver, token);
                if (targetNum) changes = changes.filter(c => c.driver_number == targetNum);
            }
            changes.sort((a, b) => b.positions_gained - a.positions_gained);
            return { data_type: `Lap ${currentLapNum} Position Changes`, total_drivers_tracked: changes.length, changes: changes };
        }
        const { data: results } = await axios.get(`${OPENF1_BASE}/v1/session_result?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!results || results.length === 0) throw new Error("No position data found.");
        const changes = results.map(r => {
            if (r.position === null || r.grid_position === null) return null;
            const gained = r.grid_position - r.position; 
            return { driver: r.name_acronym, team: r.team_name, start: r.grid_position, finish: r.position, positions_gained: gained, status: gained > 0 ? "GAINED" : (gained < 0 ? "LOST" : "SAME") };
        }).filter(Boolean);
        changes.sort((a, b) => b.positions_gained - a.positions_gained);
        return { data_type: "Full Race Overtake Summary", total_drivers: changes.length, all_changes: changes };
    },

    fastest_lap_summary: async (sessionKey, body, token) => {
        const { data: laps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        let filtered = laps.filter((l) => l.lap_duration);
        if (body.driver) {
            const driverNum = await resolveDriverNumber(sessionKey, body.driver, token);
            if (driverNum) filtered = filtered.filter(l => l.driver_number === driverNum);
            else throw new Error(`Driver '${body.driver}' not found.`);
        }
        if (!filtered.length) throw new Error("No valid laps found.");
        filtered.sort((a, b) => a.lap_duration - b.lap_duration);
        const fastLap = filtered[0];
        const dDetail = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        let compound = "N/A"; let tyreAge = 0;
        try {
            const { data: stints } = await axios.get(`${OPENF1_BASE}/v1/stints?session_key=${sessionKey}&driver_number=${fastLap.driver_number}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const matchingStint = stints.find(s => fastLap.lap_number >= s.lap_start && fastLap.lap_number <= s.lap_end);
            if (matchingStint) { compound = matchingStint.compound || "Unknown"; tyreAge = fastLap.lap_number - matchingStint.lap_start + 1; }
        } catch(e) { }
        return { driver: dDetail.data[0]?.name_acronym || "UNK", full_name: dDetail.data[0]?.full_name, lap_time: fastLap.lap_duration, lap_number: fastLap.lap_number, compound: compound, tyre_age_laps: tyreAge };
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
        const config = { type: "line", data: { labels: tel.map((_, i) => i), datasets: [{ label: "Speed", data: tel.map(t => t.speed), borderColor: "red", borderWidth: 1, pointRadius: 0, fill: false }] }, options: { scales: { y: { title: { display: true, text: "Speed (km/h)" } }, x: { display: false } }, plugins: { title: { display: true, text: `${body.driver} Lap ${body.lap_number} Speed` }, legend: { display: false } } } };
        const url = await uploadImageToCloudinary(await chartJSNodeCanvas.renderToBuffer(config), `${body.year}-${body.gp}-${body.driver}-lap${body.lap_number}-speed`);
        return { image_url: url, data_type: "Speed Trace" };
    },

    pitstops_summary: async (sessionKey, body, token) => {
        const { data: pits } = await axios.get(`${OPENF1_BASE}/v1/pit?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        const dMap = {}; drivers.forEach(d => dMap[d.driver_number] = d.name_acronym);
        let targetPits = pits;
        if (body.driver) { const driverNum = await resolveDriverNumber(sessionKey, body.driver, token); if (driverNum) targetPits = pits.filter(p => p.driver_number === driverNum); }
        let enhancedPits = targetPits;
        try {
            const { data: stints } = await axios.get(`${OPENF1_BASE}/v1/stints?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            enhancedPits = targetPits.map(p => { const stint = stints.find(s => s.driver_number === p.driver_number && Math.abs(s.lap_start - p.lap_number) <= 1); return { ...p, tyre_fitted: stint ? stint.compound : "Unknown" }; });
        } catch(e) {}
        return { pit_stops: enhancedPits.map(p => ({ driver: dMap[p.driver_number] || p.driver_number, lap: p.lap_number, duration: p.pit_duration, tyres_fitted: p.ty_fitted || "Unknown" })), count: enhancedPits.length };
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
            if (driverNum) targetLaps = targetLaps.filter(l => l.driver_number === driverNum);
            else throw new Error(`Driver '${body.driver}' not found.`);
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
        return { max_speed_kph: parseFloat(maxSpeed.toFixed(1)), avg_speed_kph: parseFloat(avgSpeed.toFixed(1)), avg_throttle_percent: parseFloat(avgThrottle.toFixed(1)) };
    }
};

// ============================================
// 🚀 MAIN ROUTES
// ============================================

app.post("/generate_insight", async (req, res) => {
    // 1. APPLY DEMO DEFAULTS (Force Las Vegas Race Context if missing)
    const params = {
        ...req.body,
        year: req.body.year || DEMO_DEFAULTS.YEAR,
        location: req.body.location || req.body.gp || DEMO_DEFAULTS.LOCATION,
        session_type: req.body.session_type || DEMO_DEFAULTS.SESSION_TYPE
    };

    const { type, year, location, session_type, session_key } = params;

    // 2. FUZZY MATCH QUERY TYPE (NLP-Lite)
    let handlerKey = type;
    if (type.includes("lap") && type.includes("lead")) handlerKey = "leaderboard_at_lap";
    if (type.includes("flag")) handlerKey = "flag_summary";
    if (type.includes("lead") || type.includes("winning")) handlerKey = "race_results";
    
    if (!INSIGHT_HANDLERS[handlerKey]) {
        const match = Object.keys(INSIGHT_HANDLERS).find(k => k.includes(type));
        if (match) handlerKey = match;
        else return res.status(400).json({ error: `Unknown insight type: ${type}` });
    }

    try {
        const token = await resolveTokenFromRequest(req);
        
        // 3. RESOLVE KEY (With Latest Fallback & Index Safety)
        let finalKey = session_key;
        if (!finalKey) {
            finalKey = await getSessionKey(year, location, session_type, token);
        }
        
        console.log(`[Insight] Running '${handlerKey}' on Session ${finalKey}`);
        const result = await INSIGHT_HANDLERS[handlerKey](finalKey, params, token);
        
        res.json({ status: "Success", context: { session: finalKey, type: handlerKey }, result });

    } catch (e) {
        console.error(`[Insight Error] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});



app.get("/raw_data_proxy", async (req, res) => {
  const resource = req.query.resource;
  if (!resource) return res.status(400).json({ error: "Missing resource" });

  try {
      const token = await resolveTokenFromRequest(req);
      
      // Clone query params
      let queryParams = { ...req.query };
      delete queryParams.resource; 

      // 1. Handle Extra Query String Parsing
      if (queryParams.extra_query) {
          try { 
              const extra = new URLSearchParams(queryParams.extra_query);
              extra.forEach((v, k) => {
                  queryParams[k] = v; 
              });
          } catch(e){}
          delete queryParams.extra_query;
      }
      
      // 2. Handle Date/Month Logic
      const monthFilter = queryParams.month || queryParams.date;
      if (queryParams.month) delete queryParams.month;
      if (queryParams.date && !queryParams.date.includes('-')) delete queryParams.date;
      
      // 3. Resolve Fuzzy Location
      const fuzzy = queryParams.country_name || queryParams.location || queryParams.gp;
      if (fuzzy) {
          const resolvedCountry = await resolveCountryFromHistory(fuzzy, token);
          if (resolvedCountry) {
              queryParams.country_name = resolvedCountry;
              delete queryParams.location;
              delete queryParams.gp;
          }
      }

      // 🚨 SMART FIX 1: RESOLVE DRIVER NAME TO NUMBER 🚨
      // Endpoints like 'session_result', 'laps', 'position' require 'driver_number'.
      // If user provides 'driver_full_name' or 'driver', we must resolve it first.
      const driverNameInput = queryParams.driver_full_name || queryParams.driver || queryParams.driver_name;
      
      if (driverNameInput && queryParams.session_key) {
          // Only resolve if we don't already have a number
          if (!queryParams.driver_number) {
              const resolvedNum = await resolveDriverNumber(queryParams.session_key, driverNameInput, token);
              if (resolvedNum) {
                  console.log(`[Proxy] Resolved '${driverNameInput}' -> Driver Number: ${resolvedNum}`);
                  queryParams.driver_number = resolvedNum;
              } else {
                  console.warn(`[Proxy] Could not resolve driver '${driverNameInput}'`);
              }
          }
          // Remove the text params so they don't confuse the API
          delete queryParams.driver_full_name;
          delete queryParams.driver;
          delete queryParams.driver_name;
      }

      // 🚨 SMART FIX 2: LOCAL FILTERING FOR /MEETINGS
      let localFilterCountry = null;
      if (resource === 'meetings' && queryParams.country_name) {
          localFilterCountry = queryParams.country_name;
          delete queryParams.country_name; 
      }

      // 🚨 SMART FIX 3: LOCAL FILTERING FOR /DRIVERS (Team Name)
      let localTeamFilter = null;
      if (resource === 'drivers' && queryParams.team_name) {
          localTeamFilter = queryParams.team_name.toLowerCase();
          delete queryParams.team_name; 
      }

      // 4. Call API
      let data = await fetchFromOpenF1(`/v1/${resource}`, queryParams, token);

      // 5. Post-Processing
      if (Array.isArray(data)) {
          
          // A. Apply Country Filter (Meetings)
          if (localFilterCountry) {
              const filterLower = localFilterCountry.toLowerCase();
              data = data.filter(item => 
                  (item.country_name && item.country_name.toLowerCase().includes(filterLower)) ||
                  (item.location && item.location.toLowerCase().includes(filterLower)) ||
                  (item.circuit_short_name && item.circuit_short_name.toLowerCase().includes(filterLower))
              );
          }

          // B. Apply Team Filter (Drivers)
          if (localTeamFilter) {
              data = data.filter(item => 
                  item.team_name && item.team_name.toLowerCase().includes(localTeamFilter)
              );
          }

          // C. Apply Month Filter
          if (monthFilter) data = filterByMonth(data, monthFilter);
          
          // D. Sort Chronologically
          if (data.length > 0 && data[0].date_start) {
              data.sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
          }
          
          // E. Limit Results (only if no specific filter is active)
          if (data.length > 20 && !localFilterCountry && !monthFilter && !localTeamFilter && !queryParams.driver_number) {
              data = data.slice(0, 20);
          }
      }
      
      res.json(data);

  } catch (e) { 
      console.error(`[Proxy Error] ${e.message}`);
      if (e.response && e.response.status === 400) {
          return res.status(400).json({ error: "OpenF1 rejected parameters. Check filters." });
      }
      res.status(500).json({ error: e.message }); 
  }
});







app.get("/find_session_key", async (req, res) => {
  const { year, location, session_type, month } = req.query;
  if (!year || !location) return res.status(400).json({ error: "Missing params." });
  try {
    const token = await resolveTokenFromRequest(req);
    const key = await getSessionKey(year, location, session_type, token, month);
    const sessionDataArr = await fetchFromOpenF1("/v1/sessions", { session_key: key }, token);
    
    const responsePayload = { status: "Success", session_key: key, openf1_resolved_name: { country: sessionDataArr[0].country_name, session: sessionDataArr[0].session_name }, session_info: sessionDataArr[0] };
    res.json(responsePayload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ============================================
// 🏁 SMART POSITION ENDPOINT (Leaderboard or History)
// ============================================
// ============================================
// 🏁 SMART POSITION ENDPOINT (Leaderboard or History)
// ============================================
// ============================================
// 🏁 SMART POSITION ENDPOINT (Leaderboard or History)
// ============================================
app.get("/position", async (req, res) => {
    const year = req.query.year || DEMO_DEFAULTS.YEAR;
    const session_type = req.query.session_type || DEMO_DEFAULTS.SESSION_TYPE;
    let location = req.query.location;
    const driver = req.query.driver;

    // 1. FIX: Handle AI generic "current" input
    // If agent says "current", we set location to null so Global Search finds the latest race (Vegas)
    if (location && location.toLowerCase() === "current") location = null;

    try {
        const token = await resolveTokenFromRequest(req);
        
        // 2. Resolve Session (Uses your Bulletproof logic)
        const sessionKey = await getSessionKey(year, location, session_type, token);
        
        // ==================================================
        // SCENARIO A: SPECIFIC DRIVER HISTORY (If driver provided)
        // ==================================================
        if (driver) {
            const dNum = await resolveDriverNumber(sessionKey, driver, token);
            // If driver not found, return 404 ONLY in this scenario
            if (!dNum) return res.status(404).json({ error: `Driver '${driver}' not found in session ${sessionKey}.` });

            const { data: allLaps } = await axios.get(`${OPENF1_BASE}/v1/laps?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            
            const leaderboardMap = {};
            allLaps.forEach(l => {
                if (!l.lap_duration) return;
                const time = new Date(l.date_start).getTime() + l.lap_duration*1000;
                if(!leaderboardMap[l.lap_number]) leaderboardMap[l.lap_number] = [];
                leaderboardMap[l.lap_number].push({ driver: l.driver_number, time });
            });

            const history = [];
            allLaps.filter(l => l.driver_number === dNum).forEach(l => {
                const ops = leaderboardMap[l.lap_number];
                if(ops) {
                    ops.sort((a,b) => a.time - b.time);
                    const rank = ops.findIndex(o => o.driver === dNum);
                    if(rank !== -1) history.push({ lap: l.lap_number, position: rank+1 });
                }
            });
            
            return res.json({ 
                type: "Driver History",
                driver: driver, 
                driver_number: dNum,
                history 
            });
        }

        // ==================================================
        // SCENARIO B: FULL LEADERBOARD (No driver provided)
        // ==================================================
        // This handles "Who is leading?"
        
        // 1. Try Session Results
        let { data: results } = await axios.get(`${OPENF1_BASE}/v1/session_result?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        
        // 2. If empty (Live Race), use Live Position data
        if (!results || results.length === 0) {
            const { data: livePos } = await axios.get(`${OPENF1_BASE}/v1/position?session_key=${sessionKey}&date=>${new Date(Date.now() - 60000).toISOString()}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            
            if (livePos && livePos.length > 0) {
                const latestPositions = {};
                livePos.forEach(p => {
                    if (!latestPositions[p.driver_number] || new Date(p.date) > new Date(latestPositions[p.driver_number].date)) {
                        latestPositions[p.driver_number] = p;
                    }
                });
                results = Object.values(latestPositions).sort((a, b) => a.position - b.position).map(p => ({
                    position: p.position,
                    driver_number: p.driver_number,
                    status: "On Track"
                }));
            }
        }

        // 3. Enrich with Driver Names
        if (results.length > 0) {
            const { data: drivers } = await axios.get(`${OPENF1_BASE}/v1/drivers?session_key=${sessionKey}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
            const dMap = {}; 
            drivers.forEach(d => dMap[d.driver_number] = d.name_acronym || d.last_name);
            
            const leaderboard = results.slice(0, 10).map(r => ({
                position: r.position,
                driver: dMap[r.driver_number] || `#${r.driver_number}`,
                gap: r.time || r.gap_to_leader || "Interval"
            }));

            return res.json({
                type: "Current Leaderboard",
                session_key: sessionKey,
                leader: leaderboard[0]?.driver || "Unknown",
                top_10: leaderboard
            });
        }

        return res.json({ message: "No position data available yet.", session_key: sessionKey });

    } catch (e) { 
        console.error(`[Position Error] ${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});





app.get("/driver-info", async (req, res) => {
    const { year, location, session_type, driver } = req.query;
    if (!year || !location || !driver) return res.status(400).json({ error: "Missing required parameters." });

    try {
        const token = await resolveTokenFromRequest(req);
        const sessionKey = await getSessionKey(year, location, session_type, token);
        const driverNumber = await resolveDriverNumber(sessionKey, driver, token);
        if (!driverNumber) return res.status(404).json({ error: `Driver not found.` });
        
        const driverProfileArr = await fetchFromOpenF1("/v1/drivers", { session_key: sessionKey, driver_number: driverNumber }, token);
        res.json({ status: "Success", resolved_driver: { driver_number: driverProfileArr[0].driver_number, name: driverProfileArr[0].name_acronym }, full_profile: driverProfileArr[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/drivers", async (req, res) => {
    try {
        const token = await resolveTokenFromRequest(req);
        const drivers = await fetchFromOpenF1("/v1/drivers", {}, token);
        res.json(drivers.slice(0, 20));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function formatDuration(seconds) {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(3);
    return `${mins}:${secs.padStart(6, '0')}`;
}

app.listen(PORT, () => console.log(`🏁 Consolidated F1 Server (Authenticated & Date-Aware) running at http://localhost:${PORT}`));
