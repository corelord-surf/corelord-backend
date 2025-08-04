// index.js
import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';

const app = express();
const PORT = process.env.PORT || 3000;

// add a build header to every response so we can see which instance answered
app.use((req, res, next) => {
  const buildId =
    process.env.WEBSITE_BUILD_ID ||
    process.env.SCM_BUILD ||
    new Date().toISOString();
  res.set('x-corelord-build', String(buildId));
  next();
});

// Allow your Static Web App to call the API
app.use(
  cors({
    origin: [
      'https://calm-coast-025fe8203.2.azurestaticapps.net',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);

app.use(express.json());

// IMPORTANT: no mock user middleware here — rely on verifyToken inside routes
app.use('/api/profile', profileRouter);

// Simple health endpoint
app.get('/', (_req, res) => {
  res.send('corelord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
