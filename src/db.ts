import { randomUUID } from "node:crypto";

import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgresql://myuser:mypassword@localhost:5432/mydb";

const pool = new Pool({ connectionString });

let schemaReady: Promise<void> | null = null;

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS protocols (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  protocol_id UUID REFERENCES protocols(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS protocol_versions (
  id UUID PRIMARY KEY,
  protocol_id UUID NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  parent_version_id UUID REFERENCES protocol_versions(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  payload JSONB NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (protocol_id, version_number)
);

ALTER TABLE protocol_versions
  ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

CREATE INDEX IF NOT EXISTS protocol_versions_protocol_id_idx
  ON protocol_versions (protocol_id, version_number DESC);

CREATE INDEX IF NOT EXISTS protocol_versions_embedding_idx
  ON protocol_versions USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS conversation_snapshots (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  protocol_version_id UUID NOT NULL REFERENCES protocol_versions(id) ON DELETE CASCADE,
  messages JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_snapshots_conversation_id_idx
  ON conversation_snapshots (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generated_assets (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  protocol_id UUID REFERENCES protocols(id) ON DELETE SET NULL,
  protocol_version_id UUID REFERENCES protocol_versions(id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  url TEXT NOT NULL,
  content_type TEXT NOT NULL,
  openai_response_id TEXT,
  previous_response_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generated_assets_conversation_id_idx
  ON generated_assets (conversation_id, created_at DESC);
`;

export type ProtocolRecord = {
  title: string;
  abstract: string;
  equipment: string[];
  materialsReagents: string[];
  cost: {
    estimate: string;
    currency: string;
    notes: string;
    lineItems: Array<{
      item: string;
      supplier: string;
      estimate: string;
      sourceUrl: string;
    }>;
  };
  timeline: {
    duration: string;
    prepTime: string;
    runTime: string;
  };
  energyCost: {
    estimate: number;
    units: string;
    notes: string;
  };
  waterCost: {
    estimate: number;
    units: string;
    notes: string;
  };
  safetyConsiderations: string[];
  procedure: string[];
  references: string[];
};

type VersionRow = {
  id: string;
  protocol_id: string;
  version_number: number;
  parent_version_id: string | null;
  prompt: string;
  payload: ProtocolRecord;
  embedding: string | null;
  created_at: Date;
};

type SearchRow = {
  protocol_id: string;
  version_number: number;
  payload: ProtocolRecord;
  distance: number;
  created_at: Date;
};

export type SavedProtocolSearchResult = {
  protocolId: string;
  versionNumber: number;
  title: string;
  abstract: string;
  distance: number;
  createdAt: string;
};

export type SavedProtocolListItem = {
  protocolId: string;
  versionNumber: number;
  title: string;
  abstract: string;
  createdAt: string;
};

export type ConversationListItem = {
  conversationId: string;
  protocolId: string | null;
  protocolVersionId: string;
  versionNumber: number | null;
  title: string;
  abstract: string;
  updatedAt: string;
};

export type ConversationMessageRecord = {
  role: "user" | "assistant" | "system";
  content: string | Record<string, unknown>;
};

type ConversationRow = {
  id: string;
  protocol_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type ConversationListRow = {
  conversation_id: string;
  protocol_id: string | null;
  protocol_version_id: string;
  version_number: number | null;
  payload: ProtocolRecord;
  updated_at: Date;
};

type ConversationSnapshotRow = {
  conversation_id: string;
  protocol_id: string | null;
  protocol_version_id: string;
  version_number: number | null;
  messages: ConversationMessageRecord[];
  created_at: Date;
};

export async function ensureDatabaseSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA_SQL).then(() => undefined);
  }

  return schemaReady;
}

export async function saveProtocolVersion(args: {
  protocolId?: string;
  prompt: string;
  payload: ProtocolRecord;
  embedding: number[];
}) {
  await ensureDatabaseSchema();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let protocolId = args.protocolId;
    let parentVersionId: string | null = null;
    let versionNumber = 1;

    if (!protocolId) {
      protocolId = randomUUID();
      await client.query(
        "INSERT INTO protocols (id) VALUES ($1)",
        [protocolId],
      );
    } else {
      const latestVersionResult = await client.query<VersionRow>(
        `SELECT id, protocol_id, version_number, parent_version_id, prompt, payload, embedding, created_at
         FROM protocol_versions
         WHERE protocol_id = $1
         ORDER BY version_number DESC
         LIMIT 1`,
        [protocolId],
      );

      const latestVersion = latestVersionResult.rows[0];
      if (latestVersion) {
        parentVersionId = latestVersion.id;
        versionNumber = latestVersion.version_number + 1;
      } else {
        await client.query(
          "INSERT INTO protocols (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
          [protocolId],
        );
      }
    }

    const versionId = randomUUID();

    await client.query(
      `INSERT INTO protocol_versions (
         id,
         protocol_id,
         version_number,
         parent_version_id,
         prompt,
         payload,
         embedding
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector)`,
       [
         versionId,
         protocolId,
         versionNumber,
         parentVersionId,
         args.prompt,
         JSON.stringify(args.payload),
         `[${args.embedding.join(",")}]`,
       ],
     );

    await client.query(
      "UPDATE protocols SET updated_at = NOW() WHERE id = $1",
      [protocolId],
    );

    await client.query("COMMIT");

    return {
      protocolId,
      versionId,
      versionNumber,
      parentVersionId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getConversation(conversationId: string) {
  await ensureDatabaseSchema();

  const result = await pool.query<ConversationRow>(
    `SELECT id, protocol_id, created_at, updated_at
     FROM conversations
     WHERE id = $1
     LIMIT 1`,
    [conversationId],
  );

  return result.rows[0] ?? null;
}

export async function saveConversationSnapshot(args: {
  conversationId?: string;
  protocolId: string;
  protocolVersionId: string;
  messages: ConversationMessageRecord[];
}) {
  await ensureDatabaseSchema();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const conversationId = args.conversationId ?? randomUUID();

    await client.query(
      `INSERT INTO conversations (id, protocol_id)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
       SET protocol_id = EXCLUDED.protocol_id,
           updated_at = NOW()`,
      [conversationId, args.protocolId],
    );

    await client.query(
      `INSERT INTO conversation_snapshots (
         id,
         conversation_id,
         protocol_version_id,
         messages
       ) VALUES ($1, $2, $3, $4::jsonb)`,
      [randomUUID(), conversationId, args.protocolVersionId, JSON.stringify(args.messages)],
    );

    await client.query("COMMIT");

    return { conversationId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestConversationSnapshot(conversationId: string) {
  await ensureDatabaseSchema();

  const result = await pool.query<ConversationSnapshotRow>(
    `SELECT
       c.id AS conversation_id,
       c.protocol_id,
       cs.protocol_version_id,
       pv.version_number,
       cs.messages,
       cs.created_at
     FROM conversations c
     JOIN conversation_snapshots cs ON cs.conversation_id = c.id
     JOIN protocol_versions pv ON pv.id = cs.protocol_version_id
     WHERE c.id = $1
     ORDER BY cs.created_at DESC
     LIMIT 1`,
    [conversationId],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    protocolId: row.protocol_id,
    protocolVersionId: row.protocol_version_id,
    versionNumber: row.version_number,
    messages: row.messages,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getLatestProtocolVersion(protocolId: string) {
  await ensureDatabaseSchema();
  const result = await pool.query<VersionRow>(
    `SELECT id, protocol_id, version_number, parent_version_id, prompt, payload, embedding, created_at
     FROM protocol_versions
     WHERE protocol_id = $1
     ORDER BY version_number DESC
     LIMIT 1`,
    [protocolId],
  );

  return result.rows[0] ?? null;
}

export async function searchLatestProtocolVersions(args: {
  embedding: number[];
  limit: number;
}) {
  await ensureDatabaseSchema();

  const result = await pool.query<SearchRow>(
    `WITH latest_versions AS (
       SELECT DISTINCT ON (protocol_id)
         protocol_id,
         version_number,
         payload,
         embedding,
         created_at
       FROM protocol_versions
       WHERE embedding IS NOT NULL
       ORDER BY protocol_id, version_number DESC
     )
     SELECT
       protocol_id,
       version_number,
       payload,
       created_at,
       embedding <=> $1::vector AS distance
     FROM latest_versions
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${args.embedding.join(",")}]`, args.limit],
  );

  return result.rows.map((row) => ({
    protocolId: row.protocol_id,
    versionNumber: row.version_number,
    title: row.payload.title,
    abstract: row.payload.abstract,
    distance: row.distance,
    createdAt: row.created_at.toISOString(),
  } satisfies SavedProtocolSearchResult));
}

export async function listLatestProtocolVersions(limit: number) {
  await ensureDatabaseSchema();

  const result = await pool.query<SearchRow>(
    `WITH latest_versions AS (
       SELECT DISTINCT ON (protocol_id)
         protocol_id,
         version_number,
         payload,
         created_at
       FROM protocol_versions
       ORDER BY protocol_id, version_number DESC
     )
     SELECT
       protocol_id,
       version_number,
       payload,
       created_at,
       0::float AS distance
     FROM latest_versions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    protocolId: row.protocol_id,
    versionNumber: row.version_number,
    title: row.payload.title,
    abstract: row.payload.abstract,
    createdAt: row.created_at.toISOString(),
  } satisfies SavedProtocolListItem));
}

export async function listConversations(limit: number) {
  await ensureDatabaseSchema();

  const result = await pool.query<ConversationListRow>(
    `SELECT
       c.id AS conversation_id,
       c.protocol_id,
       cs.protocol_version_id,
       pv.version_number,
       pv.payload,
       c.updated_at
     FROM conversations c
     JOIN LATERAL (
       SELECT protocol_version_id
       FROM conversation_snapshots
       WHERE conversation_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) cs ON true
     JOIN protocol_versions pv ON pv.id = cs.protocol_version_id
     ORDER BY c.updated_at DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    conversationId: row.conversation_id,
    protocolId: row.protocol_id,
    protocolVersionId: row.protocol_version_id,
    versionNumber: row.version_number,
    title: row.payload.title,
    abstract: row.payload.abstract,
    updatedAt: row.updated_at.toISOString(),
  } satisfies ConversationListItem));
}

export async function saveGeneratedAsset(args: {
  conversationId?: string | null;
  protocolId?: string | null;
  protocolVersionId?: string | null;
  assetType: string;
  toolName: string;
  prompt: string;
  bucket: string;
  objectKey: string;
  url: string;
  contentType: string;
  openaiResponseId?: string | null;
  previousResponseId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await ensureDatabaseSchema();

  const id = randomUUID();

  await pool.query(
    `INSERT INTO generated_assets (
       id,
       conversation_id,
       protocol_id,
       protocol_version_id,
       asset_type,
       tool_name,
       prompt,
       bucket,
       object_key,
       url,
       content_type,
       openai_response_id,
       previous_response_id,
       metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
    [
      id,
      args.conversationId ?? null,
      args.protocolId ?? null,
      args.protocolVersionId ?? null,
      args.assetType,
      args.toolName,
      args.prompt,
      args.bucket,
      args.objectKey,
      args.url,
      args.contentType,
      args.openaiResponseId ?? null,
      args.previousResponseId ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );

  return { assetId: id };
}
