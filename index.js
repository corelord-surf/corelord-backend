// index.js
import express from 'express';
import cors from 'cors';

// Routes
import profileRouter from './routes/profile.js';
import plannerRouter from './routes/planner.js';
import forecastRouter from './routes/forecast.js';
import cacheRouter from './routes/cache.js';
import sessionsRouter from './routes/sessions.js'; // ✅ NEW

const app = express();
const PORT = process.env.PORT || 3000;

// Build ID header for tracking deployments
app.use((req, res, next) => {
  const buildId =
    process.env.WEBSITE_BUILD_ID ||
    process.env.SCM_BUILD ||
    new Date().toISOString();
  res.set('x-corelord-build', String(buildId));
  next();
});

// CORS configuration for SWA frontend
app.use(
  cors({
    origin: [
      'https://calm-coast-025fe8203.2.azurestaticapps.net',
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// JSON parsing
app.use(express.json());

// Routers
app.use('/api/profile', profileRouter);
app.use('/api/planner', plannerRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/cache', cacheRouter);
app.use('/api/sessions', sessionsRouter); // ✅ NEW

// Health check
app.get('/', (_req, res) => {
  res.send('corelord backend is running.');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
