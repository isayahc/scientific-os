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
  };
  timeline: {
    duration: string;
    prepTime: string;
    runTime: string;
  };
  energyCost: {
    estimate: string;
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
