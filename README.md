# OpenAI Agent SDK Chat Boilerplate

Minimal starter with:

- `Express` backend
- `@openai/agents` server-side agent runner
- Tavily-backed web search tool
- single-page browser chat UI

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env vars:

```bash
cp .env.example .env
```

3. Add your `OPENAI_API_KEY` and `TAVILY_API_KEY` to `.env`

4. Start the app:

```bash
npm run dev
```

Then open `http://localhost:3000`.

## Files

- `src/server.ts`: Express server and agent call
- `public/index.html`: chat layout
- `public/app.js`: browser chat logic

## Search Tool

The agent includes a `search_web` tool powered by Tavily. It is intended for current events, recent research, and questions that need live web verification.

If `TAVILY_API_KEY` is missing, the app still runs, but the tool will report that search is unavailable.

## Next steps

- add streaming responses
- add tools / handoffs to the agent
- persist conversations in a database
