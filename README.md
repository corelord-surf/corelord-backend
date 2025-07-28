# Corelord Backend

This is the Node.js + Express backend for the Corelord surf planning app.

## Features

- POST /api/surfplan: Send your surf break, availability and preferred conditions to get a plan from GPT
- GET /health: Simple health check endpoint

## Setup

1. Copy `.env.sample` to `.env` and fill in your OpenAI key.
2. Run `npm install`
3. Run `npm start`
