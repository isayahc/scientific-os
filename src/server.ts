import "dotenv/config";

import OpenAI from "openai";
import cors from "cors";
import express from "express";
import { Agent, assistant, run, setDefaultOpenAIKey, system, tool, user } from "@openai/agents";
import { tavily } from "@tavily/core";
import { z } from "zod";

import { ensureDatabaseSchema, getLatestProtocolVersion, listLatestProtocolVersions, saveProtocolVersion, searchLatestProtocolVersions } from "./db.js";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string | Record<string, unknown>;
};

const ChatMessageContentSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

const ChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: ChatMessageContentSchema,
  })),
  protocolId: z.string().uuid().nullable().optional(),
});

const apiKey = process.env.OPENAI_API_KEY;
const tavilyApiKey = process.env.TAVILY_API_KEY;

const ProtocolSchema = z.object({
  title: z.string(),
  abstract: z.string(),
  equipment: z.array(z.string()),
  materialsReagents: z.array(z.string()),
  cost: z.object({
    estimate: z.string(),
    currency: z.string(),
    notes: z.string(),
  }),
  timeline: z.object({
    duration: z.string(),
    prepTime: z.string(),
    runTime: z.string(),
  }),
  energyCost: z.object({
    estimate: z.string(),
    units: z.string(),
    notes: z.string(),
  }),
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

const SavedProtocolSearchResultSchema = z.object({
  results: z.array(z.object({
    protocolId: z.string(),
    versionNumber: z.number(),
    title: z.string(),
    abstract: z.string(),
    distance: z.number(),
    createdAt: z.string(),
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

const openaiClient = new OpenAI({ apiKey });

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
    cost: protocol.cost,
    timeline: protocol.timeline,
    energyCost: protocol.energyCost,
    safetyConsiderations: protocol.safetyConsiderations,
    procedure: protocol.procedure,
    references: protocol.references,
  };
}

function isProtocolPrompt(prompt: string) {
  const normalized = prompt.toLowerCase();

  return [
    "generate protocol",
    "create protocol",
    "write protocol",
    "draft protocol",
    "protocol for",
    "revise protocol",
    "modify protocol",
    "update protocol",
    "change protocol",
  ].some((phrase) => normalized.includes(phrase));
}

function isVersionQuestion(prompt: string) {
  const normalized = prompt.toLowerCase();

  return normalized.includes("what version") || normalized.includes("current version") || normalized.includes("which version");
}

function normalizeMessageContent(content: ChatMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content, null, 2);
}

async function createProtocolEmbedding(protocol: z.infer<typeof ProtocolSchema>) {
  const embeddingInput = [
    `Title: ${protocol.title}`,
    `Abstract: ${protocol.abstract}`,
    `Equipment: ${protocol.equipment.join(", ")}`,
    `Materials and reagents: ${protocol.materialsReagents.join(", ")}`,
    `Procedure: ${protocol.procedure.join(" ")}`,
    `Safety considerations: ${protocol.safetyConsiderations.join(" ")}`,
    `References: ${protocol.references.join(" ")}`,
  ].join("\n");

  const response = await openaiClient.embeddings.create({
    model: "text-embedding-3-small",
    input: embeddingInput,
  });

  return response.data[0]?.embedding ?? [];
}

async function createSearchEmbedding(query: string) {
  const response = await openaiClient.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });

  return response.data[0]?.embedding ?? [];
}

const searchWebParameters = z.object({
  query: z.string().min(1).describe("The search query to run on the web."),
  topic: z.enum(["general", "news", "finance"]).nullable().describe("Optional search topic."),
  maxResults: z.number().int().min(1).max(10).nullable().describe("Maximum number of results to return."),
  timeRange: z.enum(["day", "week", "month", "year", "d", "w", "m", "y"]).nullable().describe("Optional time filter for recent results."),
});

async function searchProtocols(input: z.infer<typeof searchWebParameters>) {
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
}

const searchWebTool = tool({
  name: "search_protocols",
  description:
    "Search protocol sources with Tavily and return structured source data for protocol generation using only approved repositories.",
  parameters: searchWebParameters,
  execute: searchProtocols,
});

const searchSavedProtocolsTool = tool({
  name: "search_saved_protocols",
  description:
    "Searches saved internal protocols in Postgres and returns the closest existing protocol matches by semantic similarity.",
  parameters: z.object({
    query: z.string().min(1).describe("The protocol concept or method to search for in saved internal protocols."),
    limit: z.number().int().min(1).max(10).nullable().describe("Maximum number of saved protocols to return."),
  }),
  execute: async ({ query, limit }) => {
    const embedding = await createSearchEmbedding(query.trim());
    const results = await searchLatestProtocolVersions({
      embedding,
      limit: limit ?? 5,
    });

    return SavedProtocolSearchResultSchema.parse({ results });
  },
});

const app = express();
const port = Number(process.env.PORT ?? 3000);

const agent = new Agent({
  name: "Science Assistant",
  instructions:
    "You are a protocol authoring assistant. Search context may already be provided in the conversation; use that first and do not repeatedly call search_protocols. If the user asks whether a similar internal protocol already exists, use search_saved_protocols. The only approved repositories for external protocol evidence are protocols.io, bio-protocol.org, nature.com/nprot, jove.com, and openwetware.org. Fill these fields only from retrieved evidence when possible in this exact order: title, abstract, equipment, materialsReagents, cost, timeline, energyCost, safetyConsiderations, procedure, references. Do not invent unsupported references and do not rely on sites outside the approved repositories. Represent cost as { estimate, currency, notes }, timeline as { duration, prepTime, runTime }, and energyCost as { estimate, units, notes }. Estimate them conservatively from the retrieved protocol evidence and typical lab execution requirements. Put citation strings and URLs in references, and write procedure as an ordered list of concrete steps.",
  outputType: ProtocolSchema,
  tools: [searchWebTool, searchSavedProtocolsTool],
});

const chatAgent = new Agent({
  name: "Science Chat Assistant",
  instructions:
    "You are a concise science assistant. Answer directly. If the user asks about protocol version state, explain it from the provided context only. If the user asks whether a similar saved protocol exists, use search_saved_protocols. Do not generate a new protocol unless explicitly asked.",
  tools: [searchSavedProtocolsTool],
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/api/protocols/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 5;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter 'q'" });
  }

  if (!Number.isFinite(limit) || limit < 1 || limit > 20) {
    return res.status(400).json({ error: "Query parameter 'limit' must be between 1 and 20" });
  }

  try {
    const embedding = await createSearchEmbedding(query);
    const results = await searchLatestProtocolVersions({
      embedding,
      limit,
    });

    return res.json({ query, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[protocol-search] request failed", {
      query,
      limit,
      error,
    });
    return res.status(500).json({ error: message });
  }
});

app.get("/api/protocols", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 25;

  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "Query parameter 'limit' must be between 1 and 100" });
  }

  try {
    const protocols = await listLatestProtocolVersions(limit);
    return res.json({ protocols });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[protocol-list] request failed", { limit, error });
    return res.status(500).json({ error: message });
  }
});

app.get("/api/protocols/:protocolId", async (req, res) => {
  const protocolId = req.params.protocolId;

  if (!z.string().uuid().safeParse(protocolId).success) {
    return res.status(400).json({ error: "Invalid protocol id" });
  }

  try {
    const protocol = await getLatestProtocolVersion(protocolId);

    if (!protocol) {
      return res.status(404).json({ error: "Protocol not found" });
    }

    return res.json({
      protocolId,
      versionNumber: protocol.version_number,
      reply: protocol.payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[protocol-get] request failed", { protocolId, error });
    return res.status(500).json({ error: message });
  }
});

app.post("/api/chat", async (req, res) => {
  const requestStartedAt = Date.now();
  const parsedRequest = ChatRequestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    console.error("[chat] invalid request body", {
      issues: parsedRequest.error.issues,
      body: req.body,
    });
    return res.status(400).json({ error: "Invalid request body" });
  }

  const { messages, protocolId } = parsedRequest.data;
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  console.log("[chat] request received", {
    protocolId: protocolId ?? null,
    messageCount: messages.length,
    lastUserMessage,
  });

  if (!Array.isArray(messages) || messages.length === 0) {
    console.error("[chat] empty messages array");
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  try {
    const latestVersion = protocolId
      ? await getLatestProtocolVersion(protocolId)
      : null;
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const latestUserPrompt = normalizeMessageContent(latestUserMessage?.content ?? "");
    const shouldGenerateProtocol = isProtocolPrompt(latestUserPrompt);

    if (!shouldGenerateProtocol) {
      if (protocolId && latestVersion && isVersionQuestion(latestUserPrompt)) {
        return res.json({
          reply: `Current protocol version is v${latestVersion.version_number} for protocol ${protocolId}.`,
          protocolId,
          versionNumber: latestVersion.version_number,
        });
      }
    }

    const searchContext = latestUserMessage
      && shouldGenerateProtocol
      ? await searchProtocols({
          query: latestUserPrompt,
          topic: "general",
          maxResults: 5,
          timeRange: null,
        })
      : null;

    const input = messages.map((message) => {
      const content = normalizeMessageContent(message.content);

      if (message.role === "user") {
        return user(content);
      }

      if (message.role === "assistant") {
        return assistant(content);
      }

      return system(content);
    });

    if (searchContext) {
      input.unshift(system([
        "Protocol search context has already been gathered for this request.",
        "Use this context as your primary evidence and avoid calling search_protocols again unless it is truly necessary.",
        `Search context JSON: ${JSON.stringify(searchContext)}`,
      ].join("\n\n")));
    }

    if (latestVersion) {
      input.unshift(system([
        `You are revising an existing protocol version ${latestVersion.version_number}.`,
        "Use the previous protocol as the baseline and apply the user's requested changes.",
        `Previous protocol JSON: ${JSON.stringify(latestVersion.payload)}`,
      ].join("\n\n")));
    }

    if (!shouldGenerateProtocol) {
      const chatResult = await run(chatAgent, input);

      console.log("[chat] request succeeded", {
        protocolId: protocolId ?? null,
        versionNumber: latestVersion?.version_number ?? null,
        durationMs: Date.now() - requestStartedAt,
        mode: "chat",
      });

      return res.json({
        reply: typeof chatResult.finalOutput === "string"
          ? chatResult.finalOutput
          : JSON.stringify(chatResult.finalOutput, null, 2),
        protocolId: protocolId ?? null,
        versionNumber: latestVersion?.version_number ?? null,
      });
    }

    const result = await run(agent, input);
    const orderedProtocol = orderProtocolOutput(ProtocolSchema.parse(result.finalOutput));
    const embedding = await createProtocolEmbedding(orderedProtocol);
    const prompt = normalizeMessageContent(messages[messages.length - 1]?.content ?? "");
    const savedVersion = await saveProtocolVersion({
      protocolId: protocolId ?? undefined,
      prompt,
      payload: orderedProtocol,
      embedding,
    });

    console.log("[chat] request succeeded", {
      protocolId: savedVersion.protocolId,
      versionNumber: savedVersion.versionNumber,
      durationMs: Date.now() - requestStartedAt,
      mode: "protocol",
    });

    return res.json({
      reply: orderedProtocol,
      protocolId: savedVersion.protocolId,
      versionNumber: savedVersion.versionNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat] request failed", {
      protocolId: protocolId ?? null,
      durationMs: Date.now() - requestStartedAt,
      error,
    });
    return res.status(500).json({ error: message });
  }
});

async function start() {
  await ensureDatabaseSchema();

  app.listen(port, () => {
    console.log(`Chat app running at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("[startup] failed to initialize server", { error });
  process.exit(1);
});
