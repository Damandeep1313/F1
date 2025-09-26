// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Base URL for OpenF1 API
const OPENF1_BASE = "https://api.openf1.org";

// Utility to proxy requests
async function fetchFromOpenF1(path, query) {
  try {
    const url = `${OPENF1_BASE}${path}`;
    // IMPORTANT: Only pass the 'query' object if you want to use OpenF1's built-in filtering.
    // For the custom /drivers route, we might not pass req.query here.
    const res = await axios.get(url, { params: query }); 
    return res.data;
  } catch (err) {
    console.error("OpenF1 API error:", err.message);
    throw err;
  }
}

// Generic handler generator (remains the same for other routes)
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


// --- MODIFIED DRIVERS ROUTE TO RETURN THE LATEST ENTRY ---
app.get("/drivers", async (req, res) => {
  try {
    const drivers = await fetchFromOpenF1("/v1/drivers");
    const filterName = req.query.name;

    // 1. Create a map to store the driver entry with the highest session/meeting key
    const uniqueDriversMap = new Map();
    
    drivers.forEach(driver => {
      const driverNumber = driver.driver_number;
      const currentEntryKey = driver.session_key; // Use session_key for best granularity
      
      // If the driver is not yet in the map, add them.
      // OR, if the current entry has a HIGHER (more recent) key than the one stored, overwrite it.
      if (!uniqueDriversMap.has(driverNumber) || currentEntryKey > uniqueDriversMap.get(driverNumber).session_key) {
        uniqueDriversMap.set(driverNumber, driver);
      }
    });

    let resultDrivers = Array.from(uniqueDriversMap.values());
    
    // 2. Perform name filtering (as before)
    if (filterName) {
      const searchNeedle = filterName.toLowerCase();
      
      resultDrivers = resultDrivers.filter(driver => {
        const fullName = (driver.full_name || "").toLowerCase();
        const broadcastName = (driver.broadcast_name || "").toLowerCase();
        
        return fullName.includes(searchNeedle) || broadcastName.includes(searchNeedle);
      });
    }

    // 3. Send the (filtered) unique list
    res.json(resultDrivers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch or filter drivers" });
  }
});
// --------------------------------------------------------


const sanitizeOpenF1Date = (dateString) => {
    if (!dateString) return null;

    // 1. Convert to a Date object, which handles various ISO formats
    const date = new Date(dateString);

    // 2. Return a standardized ISO string (YYYY-MM-DDTHH:MM:SS.mmmZ)
    // The slice(0, 23) forces millisecond precision (3 digits)
    return date.toISOString().slice(0, 23) + 'Z';
};

// --- FINAL FIXED CAR DATA ROUTE WITH LAP NUMBER FILTERING ---
app.get("/car_data", async (req, res) => {
  const { session_key, driver_number, lap_number, date } = req.query;

  // 1. Validate required parameters
  if (!session_key || !driver_number) {
    return res.status(400).json({ 
      error: "Missing required query parameters: session_key and driver_number." 
    });
  }

  let carDataQuery = req.query;

  // 2. Handle the 'lap_number' request by converting it to a date range
  if (lap_number) {
    try {
      // Step A: Fetch lap timing data
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
      
      // FIX: Sanitize the raw start time from the /laps response
      const startTime = sanitizeOpenF1Date(rawStartTime);
      
      // Calculate end time with a generous buffer (2 seconds)
      const startDateTime = new Date(startTime);
      const bufferMs = 2000; 
      const endDateTime = new Date(startDateTime.getTime() + (duration * 1000) + bufferMs); 

      // Format the calculated end time
      const endTime = sanitizeOpenF1Date(endDateTime.toISOString());
      
      // *** DEBUG LOGGING (This should now show consistent formats) ***
      console.log('--- Car Data Debug ---');
      console.log(`Lap Duration: ${duration}s`);
      console.log(`Start Time (Sanitized): ${startTime}`);
      console.log(`End Time (Calculated & Sanitized): ${endTime}`);
      console.log('----------------------');
      // **********************************

      // Step B: Construct a CLEAN query object for the /car_data request.
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
    // If user provided neither lap_number nor date, warn them
    return res.status(400).json({ 
        error: "For /car_data, you must provide either a 'lap_number' or a precise 'date' filter." 
    });
  }
  
  // 3. Fetch the car data 
  try {
  const data = await fetchFromOpenF1("/v1/car_data", carDataQuery);
  
  // *** NEW: LIMIT THE OUTPUT TO THE FIRST 5 ENTRIES FOR TESTING ***
  const limitedData = data.slice(0, 5);
  
  // Change res.json(data) to res.json(limitedData);
  res.json(limitedData); 

  // REVERT this line back to res.json(data) once confirmed!

} catch (err) {
    console.error("OpenF1 API error in /car_data:", err.message);
    res.status(500).json({ error: "Failed to fetch car data from OpenF1" });
  }
});


app.get("/lap_intervals", async (req, res) => {
  const { session_key, driver_number, lap_number } = req.query;

  if (!session_key || !driver_number || !lap_number) {
    return res.status(400).json({ 
      error: "Please specify the required parameters: 'session_key', 'driver_number', and 'lap_number'." 
    });
  }

  try {
    // 1. Fetch lap data to find the lap end time
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
    
    // --- WIDENED SEARCH WINDOW (10 seconds before, 10 seconds after) ---
    // We widen the window significantly to guarantee we capture an interval data point.
    const wideWindowMs = 10000; // 10 seconds wide in each direction

    const windowStart = sanitizeOpenF1Date(new Date(lapEndTimeMs - wideWindowMs).toISOString());
    const windowEnd = sanitizeOpenF1Date(new Date(lapEndTimeMs + wideWindowMs).toISOString());

    // 2. Query the /intervals endpoint with the WIDE date window
    const intervalData = await fetchFromOpenF1("/v1/intervals", {
        session_key: session_key,
        driver_number: driver_number,
        'date>=': windowStart,
        'date<=': windowEnd
    });
    
    // 3. SERVER-SIDE FILTERING: Find the closest data point
    
    if (intervalData.length === 0) {
        // If the wide window STILL returns nothing, data is truly missing.
        return res.status(200).json({ 
            error: "Interval data is missing for this lap. Try a different lap.",
            data: []
        });
    }

    // Find the single record whose timestamp is closest to the exact lap end time
    let closestRecord = intervalData.reduce((closest, current) => {
        const currentDiff = Math.abs(new Date(current.date).getTime() - lapEndTimeMs);
        const closestDiff = Math.abs(new Date(closest.date).getTime() - lapEndTimeMs);
        
        return (currentDiff < closestDiff) ? current : closest;
    }, intervalData[0]);


    // 4. Return the single most relevant record
    res.json([closestRecord]);

  } catch (err) {
    console.error("Error in /lap_intervals:", err.message);
    res.status(500).json({ error: "Failed to process interval data request." });
  }
});


app.get("/session_result", async (req, res) => {
  const { session_key, driver_number } = req.query;

  // 1. Enforce the required session_key parameter
  if (!session_key) {
    return res.status(400).json({ 
      error: "The /session_result endpoint requires a 'session_key' parameter to filter the results. Please specify a session ID." 
    });
  }

  // 2. Build the query object
  // Since we are handling the request manually, we pass all query parameters (including driver_number) 
  // directly to OpenF1's /v1/session_result endpoint for native filtering.
  const query = {
    session_key: session_key,
    ...(driver_number && { driver_number: driver_number }) // Conditionally add driver_number
  };
  
  try {
    const data = await fetchFromOpenF1("/v1/session_result", query);
    
    // 3. Return the filtered data
    res.json(data);

  } catch (err) {
    console.error("OpenF1 API error in /session_result:", err.message);
    res.status(500).json({ error: "Failed to fetch session results from OpenF1" });
  }
});



// Core REST endpoints (Use the generic handler for all others)

// app.get("/car_data", createRoute("/v1/car_data")); done
// app.get("/intervals", createRoute("/v1/intervals")); not done yet
app.get("/laps", createRoute("/v1/laps"));  //done

app.get("/meetings", createRoute("/v1/meetings"));
app.get("/overtakes", createRoute("/v1/overtakes"));
app.get("/pit", createRoute("/v1/pit"));//ignored
app.get("/position", createRoute("/v1/position"));
app.get("/race_control", createRoute("/v1/race_control"));
app.get("/sessions", createRoute("/v1/sessions"));
// app.get("/session_result", createRoute("/v1/session_result"));
app.get("/starting_grid", createRoute("/v1/starting_grid"));
app.get("/stints", createRoute("/v1/stints"));
app.get("/team_radio", createRoute("/v1/team_radio"));
app.get("/weather", createRoute("/v1/weather"));

// Root endpoint
app.get("/", (req, res) => {
  res.send("OpenF1 REST proxy is running 🚦");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
