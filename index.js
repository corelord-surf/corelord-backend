// index.js
import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';
import plannerRouter from './routes/planner.js';
import forecastRouter from './routes/forecast.js';

const app = express();
const PORT = process.env.PORT || 3000;

// build id header
app.use((req, res, next) => {
  const buildId =
    process.env.WEBSITE_BUILD_ID ||
    process.env.SCM_BUILD ||
    new Date().toISOString();
  res.set('x-corelord-build', String(buildId));
  next();
});

// CORS for SWA frontend
app.use(
  cors({
    origin: [
      'https://calm-coast-025fe8203.2.azurestaticapps.net',
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// routers
app.use('/api/profile', profileRouter);
app.use('/api/planner', plannerRouter);
app.use('/api/forecast', forecastRouter);

// health
app.get('/', (_req, res) => {
  res.send('corelord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
