require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

app.get('/health', (req, res) => {
  res.send('Corelord backend is running ✅');
});

app.post('/api/surfplan', async (req, res) => {
  try {
    const { break: surfBreak, availability, conditions } = req.body;

    const prompt = `Create a surf plan based on:
    - Surf break: ${surfBreak}
    - Availability: ${availability.join(', ')}
    - Preferred conditions: ${conditions}

    Output should include ideal days and any tips.`;

    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }]
    });

    const reply = completion.data.choices[0].message.content;
    res.json({ plan: reply });
  } catch (error) {
    console.error('OpenAI error:', error);
    res.status(500).json({ error: 'Something went wrong with AI response.' });
  }
});

app.listen(port, () => {
  console.log(`Corelord backend running on port ${port}`);
});
