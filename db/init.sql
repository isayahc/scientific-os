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

CREATE INDEX IF NOT EXISTS protocol_versions_protocol_id_idx
  ON protocol_versions (protocol_id, version_number DESC);

CREATE INDEX IF NOT EXISTS protocol_versions_embedding_idx
  ON protocol_versions USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
