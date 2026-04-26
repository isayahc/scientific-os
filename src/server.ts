import "dotenv/config";

import OpenAI from "openai";
import cors from "cors";
import express from "express";
import { Agent, assistant, run, setDefaultOpenAIKey, system, tool, user } from "@openai/agents";
import { tavily } from "@tavily/core";
import { z } from "zod";

import { ensureDatabaseSchema, getConversation, getLatestConversationSnapshot, getLatestProtocolVersion, listConversations, saveConversationSnapshot, saveProtocolVersion, searchLatestProtocolVersions } from "./db.js";

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
  conversationId: z.string().uuid().nullable().optional(),
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
    lineItems: z.array(z.object({
      item: z.string(),
      supplier: z.string(),
      estimate: z.string(),
      sourceUrl: z.string(),
    })),
  }),
  timeline: z.object({
    duration: z.string(),
    prepTime: z.string(),
    runTime: z.string(),
  }),
  energyCost: z.object({
    estimate: z.number(),
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

const PRICING_DOMAINS = [
  "thermofisher.com",
  "sigmaaldrich.com",
  "promega.com",
  "qiagen.com",
  "idtdna.com",
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

function getPricingSourceType(url: string) {
  const hostname = new URL(url).hostname.replace(/^www\./, "");

  if (hostname === "thermofisher.com" || hostname.endsWith(".thermofisher.com")) {
    return "Thermo Fisher";
  }

  if (hostname === "sigmaaldrich.com" || hostname.endsWith(".sigmaaldrich.com")) {
    return "Sigma-Aldrich";
  }

  if (hostname === "promega.com" || hostname.endsWith(".promega.com")) {
    return "Promega";
  }

  if (hostname === "qiagen.com" || hostname.endsWith(".qiagen.com")) {
    return "Qiagen";
  }

  if (hostname === "idtdna.com" || hostname.endsWith(".idtdna.com")) {
    return "IDT";
  }

  return hostname;
}

function isAllowedPricingUrl(url: string) {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return PRICING_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function extractPriceSnippet(text: string) {
  const match = text.match(/(\$\s?\d+(?:,\d{3})*(?:\.\d{2})?|USD\s?\d+(?:,\d{3})*(?:\.\d{2})?)/i);

  if (!match) {
    return {
      estimate: "Pricing not found in indexed snippet",
      currency: "USD",
    };
  }

  return {
    estimate: match[0].replace(/\s+/g, " ").trim(),
    currency: "USD",
  };
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

function orderConversationMessageContent(content: ChatMessage["content"]) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return content;
  }

  const parsed = ProtocolSchema.safeParse(content);
  if (!parsed.success) {
    return content;
  }

  return orderProtocolOutput(parsed.data);
}

function orderConversationMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    ...message,
    content: orderConversationMessageContent(message.content),
  }));
}

const PROTOCOL_COMPONENTS = [
  "title",
  "abstract",
  "equipment",
  "materialsReagents",
  "cost",
  "timeline",
  "energyCost",
  "safetyConsiderations",
  "procedure",
  "references",
] as const;

type ProtocolComponent = typeof PROTOCOL_COMPONENTS[number];

function detectRequestedProtocolComponents(prompt: string): ProtocolComponent[] {
  const normalized = prompt.toLowerCase();
  const matches = new Set<ProtocolComponent>();

  const componentMatchers: Array<[ProtocolComponent, string[]]> = [
    ["title", ["title", "rename"]],
    ["abstract", ["abstract", "summary"]],
    ["equipment", ["equipment", "instruments", "apparatus"]],
    ["materialsReagents", ["materials", "reagents", "supplies", "consumables"]],
    ["cost", ["cost", "price", "pricing", "budget", "line items"]],
    ["timeline", ["timeline", "duration", "prep time", "run time"]],
    ["energyCost", ["energy cost", "energy", "power"]],
    ["safetyConsiderations", ["safety", "safety considerations", "hazards"]],
    ["procedure", ["procedure", "steps", "method", "protocol steps"]],
    ["references", ["references", "citations", "sources"]],
  ];

  for (const [component, patterns] of componentMatchers) {
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      matches.add(component);
    }
  }

  return [...matches];
}

function mergeProtocolUpdate(
  baseProtocol: z.infer<typeof ProtocolSchema>,
  updatedProtocol: z.infer<typeof ProtocolSchema>,
  requestedComponents: ProtocolComponent[],
) {
  if (requestedComponents.length === 0) {
    return updatedProtocol;
  }

  const mergedProtocol: z.infer<typeof ProtocolSchema> = { ...baseProtocol };

  for (const component of requestedComponents) {
    switch (component) {
      case "title":
        mergedProtocol.title = updatedProtocol.title;
        break;
      case "abstract":
        mergedProtocol.abstract = updatedProtocol.abstract;
        break;
      case "equipment":
        mergedProtocol.equipment = updatedProtocol.equipment;
        break;
      case "materialsReagents":
        mergedProtocol.materialsReagents = updatedProtocol.materialsReagents;
        break;
      case "cost":
        mergedProtocol.cost = updatedProtocol.cost;
        break;
      case "timeline":
        mergedProtocol.timeline = updatedProtocol.timeline;
        break;
      case "energyCost":
        mergedProtocol.energyCost = updatedProtocol.energyCost;
        break;
      case "safetyConsiderations":
        mergedProtocol.safetyConsiderations = updatedProtocol.safetyConsiderations;
        break;
      case "procedure":
        mergedProtocol.procedure = updatedProtocol.procedure;
        break;
      case "references":
        mergedProtocol.references = updatedProtocol.references;
        break;
    }
  }

  return mergedProtocol;
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

async function searchSupplyPricing(supplies: string[]) {
  if (!tavilyClient) {
    return [];
  }

  const selectedSupplies = supplies
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);

  const searches = await Promise.all(selectedSupplies.map(async (item) => {
    const response = await tavilyClient.search(
      `${item} price supply technical bulletin application note protocol`,
      {
        topic: "general",
        maxResults: 3,
        searchDepth: "advanced",
        includeDomains: [...PRICING_DOMAINS],
      },
    );

    const result = response.results.find((entry) => {
      try {
        return isAllowedPricingUrl(entry.url);
      } catch {
        return false;
      }
    });

    if (!result) {
        return {
        item,
        supplier: "Unknown",
        estimate: "Pricing not found",
        sourceUrl: "",
      };
      }

    const price = extractPriceSnippet(`${result.title} ${result.content}`);

      return {
      item,
      supplier: getPricingSourceType(result.url),
      estimate: price.estimate,
      sourceUrl: result.url,
    };
  }));

  return searches;
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
    "You are a protocol authoring assistant. Search context may already be provided in the conversation; use that first and do not repeatedly call search_protocols. If the user asks whether a similar internal protocol already exists, use search_saved_protocols. The only approved repositories for external protocol evidence are protocols.io, bio-protocol.org, nature.com/nprot, jove.com, and openwetware.org. Fill these fields only from retrieved evidence when possible in this exact order: title, abstract, equipment, materialsReagents, cost, timeline, energyCost, safetyConsiderations, procedure, references. Do not invent unsupported references and do not rely on sites outside the approved repositories. Treat materialsReagents as the full set of consumables, reagents, and general supplies needed for the protocol. Represent cost as { estimate, currency, notes, lineItems } where lineItems is an array and may be empty before vendor pricing enrichment. Represent timeline as { duration, prepTime, runTime }, and energyCost as { estimate, units, notes } where estimate is a numeric value, not text. Estimate them conservatively from the retrieved protocol evidence and typical lab execution requirements. Put citation strings and URLs in references, and write procedure as an ordered list of concrete steps.",
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

app.get("/api/conversations", async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 25;

  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "Query parameter 'limit' must be between 1 and 100" });
  }

  try {
    const conversations = await listConversations(limit);
    return res.json({ conversations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[conversation-list] request failed", { limit, error });
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
      reply: orderProtocolOutput(ProtocolSchema.parse(protocol.payload)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[protocol-get] request failed", { protocolId, error });
    return res.status(500).json({ error: message });
  }
});

app.get("/api/conversations/:conversationId", async (req, res) => {
  const conversationId = req.params.conversationId;

  if (!z.string().uuid().safeParse(conversationId).success) {
    return res.status(400).json({ error: "Invalid conversation id" });
  }

  try {
    const snapshot = await getLatestConversationSnapshot(conversationId);

    if (!snapshot) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    return res.json({
      ...snapshot,
      messages: orderConversationMessages(snapshot.messages as ChatMessage[]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[conversation-get] request failed", { conversationId, error });
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

  const { messages, protocolId, conversationId } = parsedRequest.data;
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  console.log("[chat] request received", {
    conversationId: conversationId ?? null,
    protocolId: protocolId ?? null,
    messageCount: messages.length,
    lastUserMessage,
  });

  if (!Array.isArray(messages) || messages.length === 0) {
    console.error("[chat] empty messages array");
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  try {
    const conversation = conversationId
      ? await getConversation(conversationId)
      : null;
    const activeProtocolId = protocolId ?? conversation?.protocol_id ?? null;
    const latestVersion = activeProtocolId
      ? await getLatestProtocolVersion(activeProtocolId)
      : null;
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const latestUserPrompt = normalizeMessageContent(latestUserMessage?.content ?? "");
    const shouldGenerateProtocol = isProtocolPrompt(latestUserPrompt);
    const requestedComponents = latestVersion
      ? detectRequestedProtocolComponents(latestUserPrompt)
      : [];

    if (!shouldGenerateProtocol) {
      if (activeProtocolId && latestVersion && isVersionQuestion(latestUserPrompt)) {
        return res.json({
          reply: `Current protocol version is v${latestVersion.version_number} for protocol ${activeProtocolId}.`,
          conversationId: conversationId ?? null,
          protocolId: activeProtocolId,
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
        requestedComponents.length > 0
          ? `Only update these components unless the user explicitly asks otherwise: ${requestedComponents.join(", ")}. Preserve all other components exactly as they are.`
          : "If the user did not clearly target a specific component, you may revise the protocol more broadly.",
        `Previous protocol JSON: ${JSON.stringify(latestVersion.payload)}`,
      ].join("\n\n")));
    }

    if (!shouldGenerateProtocol) {
      const chatResult = await run(chatAgent, input);
      const reply = typeof chatResult.finalOutput === "string"
        ? chatResult.finalOutput
        : JSON.stringify(chatResult.finalOutput, null, 2);
      const savedConversation = activeProtocolId && latestVersion
        ? await saveConversationSnapshot({
            conversationId: conversationId ?? undefined,
            protocolId: activeProtocolId,
            protocolVersionId: latestVersion.id,
            messages: [
              ...messages,
              { role: "assistant", content: reply },
            ],
          })
        : null;

      console.log("[chat] request succeeded", {
        conversationId: savedConversation?.conversationId ?? conversationId ?? null,
        protocolId: activeProtocolId,
        versionNumber: latestVersion?.version_number ?? null,
        durationMs: Date.now() - requestStartedAt,
        mode: "chat",
      });

      return res.json({
        reply,
        conversationId: savedConversation?.conversationId ?? conversationId ?? null,
        protocolId: activeProtocolId,
        versionNumber: latestVersion?.version_number ?? null,
      });
    }

    const result = await run(agent, input);
    const generatedProtocol = ProtocolSchema.parse(result.finalOutput);
    const mergedProtocol = latestVersion
      ? mergeProtocolUpdate(latestVersion.payload, generatedProtocol, requestedComponents)
      : generatedProtocol;
    const orderedProtocol = orderProtocolOutput(mergedProtocol);
    const pricingLineItems = await searchSupplyPricing([
      ...orderedProtocol.materialsReagents,
      ...orderedProtocol.equipment,
    ]);
    orderedProtocol.cost = {
      ...orderedProtocol.cost,
      notes: pricingLineItems.length > 0
        ? `${orderedProtocol.cost.notes} Vendor pricing references were searched for listed supplies, materials, reagents, and selected equipment.`.trim()
        : orderedProtocol.cost.notes,
      lineItems: pricingLineItems,
    };
    const embedding = await createProtocolEmbedding(orderedProtocol);
    const prompt = normalizeMessageContent(messages[messages.length - 1]?.content ?? "");
    const savedVersion = await saveProtocolVersion({
      protocolId: activeProtocolId ?? undefined,
      prompt,
      payload: orderedProtocol,
      embedding,
    });
    const savedConversation = await saveConversationSnapshot({
      conversationId: conversationId ?? undefined,
      protocolId: savedVersion.protocolId,
      protocolVersionId: savedVersion.versionId,
      messages: [
        ...messages,
        { role: "assistant", content: orderedProtocol },
      ],
    });

    console.log("[chat] request succeeded", {
      conversationId: savedConversation.conversationId,
      protocolId: savedVersion.protocolId,
      versionNumber: savedVersion.versionNumber,
      durationMs: Date.now() - requestStartedAt,
      mode: "protocol",
    });

    return res.json({
      reply: orderedProtocol,
      conversationId: savedConversation.conversationId,
      protocolId: savedVersion.protocolId,
      versionNumber: savedVersion.versionNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat] request failed", {
      conversationId: conversationId ?? null,
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
