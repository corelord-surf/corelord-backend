// index.js
import express from "express";
import cors from "cors";

import profileRouter from "./routes/profile.js";
import plannerRouter from "./routes/planner.js";
import forecastRouter from "./routes/forecast.js";
import cacheRouter from "./routes/cache.js";
import sessionsRouter from "./routes/sessions.js";

const app = express();
const PORT = process.env.PORT || 3000;

// trust proxy for correct client IPs when behind Azure
app.set("trust proxy", true);

// build id header for traceability
app.use((req, res, next) => {
  const buildId =
    process.env.WEBSITE_BUILD_ID ||
    process.env.SCM_BUILD ||
    new Date().toISOString();
  res.set("x-corelord-build", String(buildId));
  next();
});

// CORS for SWA and local dev
app.use(
  cors({
    origin: [
      "https://calm-coast-025fe8203.2.azurestaticapps.net",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    credentials: false,
  })
);

// body parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// simple health probe
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    time: new Date().toISOString(),
    build: res.get("x-corelord-build"),
  });
});

// API routes
app.use("/api/profile", profileRouter);
app.use("/api/planner", plannerRouter);
app.use("/api/forecast", forecastRouter);
app.use("/api/cache", cacheRouter);
app.use("/api/sessions", sessionsRouter);

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    method: req.method,
    path: req.originalUrl,
  });
});

// error handler
app.use((err, req, res, next) => {
  console.error("[Unhandled Error]", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
  });
});

// start server
app.listen(PORT, () => {
  console.log(`CoreLord backend listening on ${PORT}`);
});

export default app;
