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
