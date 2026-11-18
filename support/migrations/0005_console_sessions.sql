-- Prototype (dev only): which conversation each Console agent session answers, so the MCP server (src/mcp.ts) can hand a
-- tool call to that conversation's Durable Object. Written when the conversation opens the session (or its first turn does).
CREATE TABLE console_sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX console_sessions_conversation ON console_sessions (conversation_id);
