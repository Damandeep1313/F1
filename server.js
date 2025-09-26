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

// Core REST endpoints
app.get("/car_data", createRoute("/v1/car_data"));
app.get("/drivers", createRoute("/v1/drivers"));
app.get("/intervals", createRoute("/v1/intervals"));
app.get("/laps", createRoute("/v1/laps"));
app.get("/location", createRoute("/v1/location"));
app.get("/meetings", createRoute("/v1/meetings"));
app.get("/overtakes", createRoute("/v1/overtakes"));
app.get("/pit", createRoute("/v1/pit"));
app.get("/position", createRoute("/v1/position"));
app.get("/race_control", createRoute("/v1/race_control"));
app.get("/sessions", createRoute("/v1/sessions"));
app.get("/session_result", createRoute("/v1/session_result"));
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
