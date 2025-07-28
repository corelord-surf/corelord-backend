require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const OpenAI = require('openai'); // OpenAI v4

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Initialise OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ Health check route
app.get('/health', (req, res) => {
  res.send('Corelord backend is running ✅');
});

// ✅ AI surf planning endpoint
app.post('/api/surfplan', async (req, res) => {
  try {
    const { break: surfBreak, availability, conditions } = req.body;

    const prompt = `Create a surf plan based on:
    - Surf break: ${surfBreak}
    - Availability: ${availability.join(', ')}
    - Preferred conditions: ${conditions}

    Output should include ideal days and any tips.`;

    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
    });

    const reply = chatCompletion.choices[0].message.content;
    res.json({ plan: reply });
  } catch (error) {
    // 🔍 Detailed error logging
    if (error.response) {
      console.error('OpenAI API Error:', error.response.status, error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else if (error.request) {
      console.error('No response from OpenAI API:', error.request);
      res.status(500).json({ error: 'No response received from OpenAI API.' });
    } else {
      console.error('Error setting up OpenAI request:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
});

// ✅ Start server
app.listen(port, () => {
  console.log(`Corelord backend running on port ${port}`);
});
