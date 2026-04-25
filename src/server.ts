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

const ProtocolSchema = z.object({
  title: z.string(),
  abstract: z.string(),
  equipment: z.array(z.string()),
  materialsReagents: z.array(z.string()),
  safetyConsiderations: z.array(z.string()),
  procedure: z.array(z.string()),
  references: z.array(z.string()),
});

const ProtocolSearchResultSchema = z.object({
  query: z.string(),
  answer: z.string().nullable(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    sourceType: z.string(),
  })),
});

const PROTOCOL_DOMAINS = [
  "protocols.io",
  "bio-protocol.org",
  "nature.com",
  "jove.com",
  "openwetware.org",
] as const;

if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY in environment.");
}

setDefaultOpenAIKey(apiKey);

const tavilyClient = tavilyApiKey ? tavily({ apiKey: tavilyApiKey }) : null;

function getSourceType(url: string) {
  const hostname = new URL(url).hostname.replace(/^www\./, "");

  if (hostname === "protocols.io" || hostname.endsWith(".protocols.io")) {
    return "protocols.io";
  }

  if (hostname === "bio-protocol.org" || hostname.endsWith(".bio-protocol.org")) {
    return "bio-protocol";
  }

  if (hostname === "jove.com" || hostname.endsWith(".jove.com")) {
    return "jove";
  }

  if (hostname === "openwetware.org" || hostname.endsWith(".openwetware.org")) {
    return "openwetware";
  }

  if (hostname === "nature.com" || hostname.endsWith(".nature.com")) {
    return url.includes("/nprot") ? "nature-protocols" : "nature";
  }

  return hostname;
}

function isAllowedProtocolUrl(url: string) {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.replace(/^www\./, "");

  if (hostname === "nature.com" || hostname.endsWith(".nature.com")) {
    return parsedUrl.pathname.startsWith("/nprot");
  }

  return PROTOCOL_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function buildProtocolQuery(query: string) {
  return `${query} (protocol OR methods OR procedure OR workflow) site:protocols.io OR site:bio-protocol.org OR site:nature.com/nprot OR site:jove.com OR site:openwetware.org`;
}

function orderProtocolOutput(protocol: z.infer<typeof ProtocolSchema>) {
  return {
    title: protocol.title,
    abstract: protocol.abstract,
    equipment: protocol.equipment,
    materialsReagents: protocol.materialsReagents,
    safetyConsiderations: protocol.safetyConsiderations,
    procedure: protocol.procedure,
    references: protocol.references,
  };
}

const searchWebParameters = z.object({
  query: z.string().min(1).describe("The search query to run on the web."),
  topic: z.enum(["general", "news", "finance"]).nullable().describe("Optional search topic."),
  maxResults: z.number().int().min(1).max(10).nullable().describe("Maximum number of results to return."),
  timeRange: z.enum(["day", "week", "month", "year", "d", "w", "m", "y"]).nullable().describe("Optional time filter for recent results."),
});

const searchWebTool = tool({
  name: "search_protocols",
  description:
    "Search protocol sources with Tavily and return structured source data for protocol generation using only approved repositories.",
  parameters: searchWebParameters,
  execute: async (input) => {
    if (!tavilyClient) {
      return {
        query: input.query.trim(),
        answer: "Tavily search is unavailable because TAVILY_API_KEY is not configured.",
        results: [],
      };
    }

    const query = input.query.trim();
    const topic = input.topic ?? undefined;
    const maxResults = input.maxResults ?? undefined;
    const timeRange = input.timeRange ?? undefined;

    const response = await tavilyClient.search(buildProtocolQuery(query), {
      topic: topic ?? "general",
      timeRange: timeRange ?? undefined,
      maxResults: maxResults ?? 5,
      includeAnswer: true,
      searchDepth: "advanced",
      includeDomains: [...PROTOCOL_DOMAINS],
    });

    const filteredResults = response.results.filter((result) => {
      try {
        return isAllowedProtocolUrl(result.url);
      } catch {
        return false;
      }
    });

    return ProtocolSearchResultSchema.parse({
      query,
      answer: response.answer ?? null,
      results: filteredResults.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        sourceType: getSourceType(result.url),
      })),
    });
  },
});

const app = express();
const port = Number(process.env.PORT ?? 3000);

const agent = new Agent({
  name: "Science Assistant",
  instructions:
    "You are a protocol authoring assistant. Use the search_protocols tool to gather source material, then produce a structured protocol object. The only approved repositories are protocols.io, bio-protocol.org, nature.com/nprot, jove.com, and openwetware.org. Fill these fields only from retrieved evidence when possible in this exact order: title, abstract, equipment, materialsReagents, safetyConsiderations, procedure, references. Do not invent unsupported references and do not rely on sites outside the approved repositories. Put citation strings and URLs in references, and write procedure as an ordered list of concrete steps.",
  outputType: ProtocolSchema,
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
    return res.json({ reply: orderProtocolOutput(ProtocolSchema.parse(result.finalOutput)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});
