import "dotenv/config";

import cors from "cors";
import express from "express";
import { Agent, assistant, run, setDefaultOpenAIKey, system, tool, user } from "@openai/agents";
import { tavily } from "@tavily/core";
import { z } from "zod";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const apiKey = process.env.OPENAI_API_KEY;
const tavilyApiKey = process.env.TAVILY_API_KEY;

if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY in environment.");
}

setDefaultOpenAIKey(apiKey);

const tavilyClient = tavilyApiKey ? tavily({ apiKey: tavilyApiKey }) : null;

const searchWebParameters = z.object({
  query: z.string().min(1).describe("The search query to run on the web."),
  topic: z.enum(["general", "news", "finance"]).nullable().describe("Optional search topic."),
  maxResults: z.number().int().min(1).max(10).nullable().describe("Maximum number of results to return."),
  timeRange: z.enum(["day", "week", "month", "year", "d", "w", "m", "y"]).nullable().describe("Optional time filter for recent results."),
});

const searchWebTool = tool({
  name: "search_web",
  description:
    "Search the web with Tavily for current events, recent facts, or sources that need live verification.",
  parameters: searchWebParameters,
  execute: async (input) => {
    if (!tavilyClient) {
      return "Tavily search is unavailable because TAVILY_API_KEY is not configured.";
    }

    const query = input.query.trim();
    const topic = input.topic ?? undefined;
    const maxResults = input.maxResults ?? undefined;
    const timeRange = input.timeRange ?? undefined;

    const response = await tavilyClient.search(query, {
      topic: topic ?? undefined,
      timeRange: timeRange ?? undefined,
      maxResults: maxResults ?? 5,
      includeAnswer: true,
      searchDepth: "advanced",
    });

    const lines = [
      `Query: ${response.query}`,
      response.answer ? `Answer: ${response.answer}` : null,
      "Results:",
      ...response.results.map((result, index) => [
        `${index + 1}. ${result.title}`,
        `URL: ${result.url}`,
        `Snippet: ${result.content}`,
      ].join("\n")),
    ].filter((value): value is string => Boolean(value));

    return lines.join("\n\n");
  },
});

const app = express();
const port = Number(process.env.PORT ?? 3000);

const agent = new Agent({
  name: "Science Assistant",
  instructions:
    "You are a concise science assistant. Answer clearly, ask follow-up questions only when needed, and keep explanations practical. Use the search_web tool for current events, recent research, or anything that needs live web verification. When you use web search, cite the relevant URLs in your answer.",
  tools: [searchWebTool],
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.post("/api/chat", async (req, res) => {
  const messages = (req.body?.messages ?? []) as ChatMessage[];

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  try {
    const input = messages.map((message) => {
      if (message.role === "user") {
        return user(message.content);
      }

      if (message.role === "assistant") {
        return assistant(message.content);
      }

      return system(message.content);
    });

    const result = await run(agent, input);
    const reply = typeof result.finalOutput === "string"
      ? result.finalOutput
      : JSON.stringify(result.finalOutput, null, 2);

    return res.json({ reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});
