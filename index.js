import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';
import dashboardRouter from './routes/dashboard.js'; // New

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Temporary mock user middleware (remove once verifyToken is integrated)
app.use((req, res, next) => {
  req.user = {
    oid: 'mock-user-1234'
  };
  next();
});

// Route handlers
app.use('/api/profile', profileRouter);
app.use('/api/dashboard', dashboardRouter); // New

app.get('/', (req, res) => {
  res.send('CoreLord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
