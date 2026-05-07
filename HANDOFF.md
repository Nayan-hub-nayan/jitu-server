# Ask Akash — Developer Handoff

## What We're Building

A personal chat website for Akash Kedia. Visitors (recruiters, founders, journalists) land on the site, type a question about Akash, and get a streaming response grounded in his personal wiki. Think ChatGPT-style interface, but scoped to one person's professional life.

**Frontend:** Framer (designed and hosted there)
**Backend API:** Standalone service (Vercel serverless) that handles all RAG logic
**Knowledge base:** 6 wiki pages + 4 career pages + 6 blog posts, all in Notion
**Target cost: $0/month** (all services on free tiers, LLM covered by existing subscription)

---

## Zero-Cost Stack Summary

Every component runs free. The LLM is covered by Akash's existing MiniMax subscription.

| Component | Service | Why it's free |
|-----------|---------|---------------|
| LLM (answers) | **MiniMax M2.7** | Akash has a monthly subscription already |
| Embeddings | **Google Gemini `text-embedding-004`** | Free tier: 1,500 RPM, 1M tokens/day |
| Anti-corpus check | **Built into system prompt** | No separate classifier call needed |
| Reranker | **Skipped** | With ~50-80 total chunks, hybrid search is precise enough |
| Vector DB | **Supabase** (pgvector) | Free tier: 500MB storage, 50k rows |
| Backend hosting | **Vercel** (serverless) | Free tier: 100k function invocations/month |
| Rate limiting | **Upstash Redis** | Free tier: 10k commands/day |
| Email fallback | **Resend** | Free tier: 100 emails/day |
| Frontend | **Framer** | Free plan (shows "Made in Framer" badge) |
| Sync cron | **GitHub Actions** | Free: 2,000 minutes/month on public repos |

At 100 questions/day, this stays well within every free tier.

---

## Architecture

```
┌─────────────────────────────────┐
│         FRAMER SITE             │
│                                 │
│  Chat UI (custom code component)│
│  - Text input                   │
│  - Streaming message display    │
│  - Citation links               │
│  - "Ask Akash directly" CTA     │
│                                 │
└──────────┬──────────────────────┘
           │ POST /api/chat
           │ { messages: [...], sessionId }
           │
           │ Response: SSE stream
           │ (text/event-stream)
           │
┌──────────▼──────────────────────┐
│       BACKEND API               │
│       (Vercel Serverless)       │
│                                 │
│  1. Rate limit check (Upstash)  │
│  2. Embed query                 │
│     (Gemini text-embedding-004) │
│  3. Hybrid retrieval            │
│     - pgvector similarity search│
│     - BM25 keyword search       │
│     - Combined: 0.7*vec + 0.3*bm│
│  4. "I don't know" gate         │
│     (top-1 similarity < 0.35)   │
│  5. Prompt MiniMax M2.7         │
│     with retrieved chunks       │
│     (anti-corpus rules baked    │
│      into system prompt)        │
│  6. Stream response back        │
│  7. Log conversation to Supabase│
│                                 │
└──────────┬──────────────────────┘
           │
    ┌──────┴───────┐
    │              │
┌───▼───┐    ┌────▼────┐
│Supabase│    │Upstash  │
│        │    │Redis    │
│- chunks│    │- rate   │
│  table │    │  limits │
│- convos│    └─────────┘
│  table │
│- pgvec │
│- tsvec │
└────────┘
```

### Key Simplifications vs. the Paid Version

1. **No separate anti-corpus classifier.** The off-limits topics are baked into the system prompt. The LLM handles gating inline. This saves an API call per question and costs nothing extra.
2. **No reranker.** With only ~50-80 chunks, hybrid search (vector + BM25) returns precise enough results. The "I don't know" gate uses the vector similarity score directly instead of a reranker score.
3. **One LLM, one embedding model.** MiniMax for generation, Gemini for embeddings. Two API keys total (plus Notion and Supabase).

### Separate Offline Pipeline (runs on cron, not on user request)

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│ Notion   │────▶│ Sync Script  │────▶│ Supabase │
│ Wiki     │     │ (Node.js)    │     │ pgvector │
│ Pages    │     │              │     │          │
└──────────┘     │ 1. Fetch pages│     └──────────┘
                 │ 2. Split by H2│
                 │ 3. Chunk ≤400t│
                 │ 4. Embed      │
                 │    (Gemini)   │
                 │ 5. Upsert     │
                 └──────────────┘
                 Runs: GitHub Action, every 6 hours
```

---

## Component 1: Framer Frontend

The chat interface is a **Framer Code Component** (React). Framer supports custom React components that can make API calls, manage state, and render dynamic content.

### Chat Component Requirements

```
Props: none (self-contained)
State:
  - messages: Array<{ role: 'user' | 'assistant', content: string, citations?: Citation[] }>
  - input: string
  - isStreaming: boolean
  - sessionId: string (generated on first load, stored in sessionStorage)

Behavior:
  1. User types question, hits enter or send button
  2. Append user message to messages[]
  3. POST to backend API:
     POST https://<backend-url>/api/chat
     Content-Type: application/json
     Body: { messages: [{ role, content }], sessionId }
  4. Read SSE stream from response
  5. Append assistant message token-by-token (streaming effect)
  6. When stream ends, parse citations from the response and render as clickable links
  7. If response is "I don't know" type, show "Ask Akash directly" button (mailto:ahkedia@gmail.com)
```

### Citation Format

The backend returns citations inline using this format:
```
Based on his work at Flipkart, Akash built... [source: Bio & Narrative]
```

The frontend parses `[source: <chunk_heading>]` and renders them as subtle footnote-style links.

### Suggested Messages (cold start)

Show 3-4 suggested questions on first load:
- "What's Akash's background?"
- "How does Akash think about AI in product orgs?"
- "What did Akash build at Flipkart?"
- "What's Akash's management style?"

### Rate Limit UX

If backend returns 429, show: "You've asked a lot of questions! Give it a few minutes, or reach out to Akash directly."

### Design Notes

- Mobile-first (recruiters browse on phones)
- Dark mode optional but nice
- Typing indicator while streaming
- Messages should feel conversational, not clinical
- Keep branding minimal, this is Akash's personal site, not a SaaS product

---

## Component 2: Backend API

This is where the AI logic lives. The Framer site is just a UI shell.

### Tech Stack

| Component | Choice | Free tier limits |
|-----------|--------|-----------------|
| Runtime | Vercel Serverless (Node.js) | 100k invocations/month |
| LLM | MiniMax M2.7 (OpenAI-compatible API) | Covered by Akash's subscription |
| Embeddings | Google Gemini `text-embedding-004` | 1,500 RPM, 1M tokens/day |
| Vector DB | Supabase (pgvector) | 500MB, 50k rows |
| Rate limiting | Upstash Redis | 10k commands/day |
| Email fallback | Resend | 100 emails/day |

### MiniMax M2.7 — Important Notes

MiniMax M2.7 is a **reasoning model**. It uses ~50% of `max_tokens` for internal reasoning (`reasoning_content`) before producing the visible response. Account for this:

- Set `max_tokens` to **4096** (the model uses ~2k for reasoning, ~2k for the answer)
- The reasoning tokens are not shown to the user, only the final `content` is streamed
- API is OpenAI-compatible: `https://api.minimaxi.chat/v1/chat/completions`
- Model ID: `MiniMax-M1-80k` (M2.7 series)
- Supports streaming via `stream: true`

```typescript
// MiniMax API call (OpenAI-compatible format)
const response = await fetch('https://api.minimaxi.chat/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${MINIMAX_API_KEY}`
  },
  body: JSON.stringify({
    model: 'MiniMax-M1-80k',
    messages: [
      { role: 'system', content: systemPrompt },
      ...retrievedContext,
      ...conversationHistory
    ],
    max_tokens: 4096,
    stream: true,
    temperature: 0.3  // low temp for factual RAG
  })
});
```

### Gemini Embeddings — Setup

```typescript
// Free tier: 1,500 RPM, 1M tokens/day
// Model: text-embedding-004, output dimension: 768

const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/text-embedding-004',
      content: { parts: [{ text: chunkContent }] },
      taskType: 'RETRIEVAL_DOCUMENT'  // use RETRIEVAL_QUERY for queries
    })
  }
);
// response.embedding.values → number[768]
```

**Important:** Use `taskType: 'RETRIEVAL_DOCUMENT'` when embedding wiki chunks (sync pipeline) and `taskType: 'RETRIEVAL_QUERY'` when embedding the user's question (chat endpoint). Gemini optimizes the embedding differently for each.

### API Endpoint: POST /api/chat

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "What did Akash do at Flipkart?" }
  ],
  "sessionId": "abc-123"
}
```

**Response:** Server-Sent Events (SSE) stream
```
data: {"type":"token","content":"Akash"}
data: {"type":"token","content":" spent"}
data: {"type":"token","content":" six"}
...
data: {"type":"done","citations":[{"heading":"Bio & Narrative","source":"wiki"}]}
```

**Error responses:**
- `429` — rate limited
- `400` — invalid input

### System Prompt

The system prompt handles both answer generation AND anti-corpus enforcement (no separate classifier needed):

```
You are a conversational assistant representing Akash Kedia. You answer questions
about Akash's professional background, views, and work based ONLY on the provided
context chunks.

Rules:
1. Only state facts present in the context. If the context doesn't cover the
   question, say: "That's not something I have in my notes. You're welcome to
   reach out to Akash directly if you'd like to discuss that."
2. Speak in third person ("Akash believes..." not "I believe...").
3. Be conversational and direct. No corporate fluff. Sound like a sharp colleague
   describing Akash, not a PR statement.
4. After each claim, cite the source in brackets: [source: <heading>]
5. Keep answers concise, 2-4 paragraphs max unless the user asks for detail.
6. Never fabricate companies, titles, dates, metrics, or opinions.

OFF-LIMITS TOPICS — if the user asks about ANY of these, respond ONLY with:
"That's not something I have in my notes. You're welcome to reach out to Akash
directly if you'd like to discuss that."
Do not explain why the topic is off-limits. Do not apologize. Just redirect.

- Salary, compensation, equity, or financial details of any employment
- Family and personal relationships (exception: Akash lives in Berlin with his wife Abhigna)
- Health or medical information
- Political, religious, or controversial social views
- Investment advice or financial recommendations
- Details of the company Akash sold in 2015 (name, product, acquirer)
- N26 internal strategy, roadmap, or future plans beyond what's in the context
- NDA-protected information from any employer
- Specific colleagues by name unless they appear in the context
```

### Retrieval Pipeline (pseudocode)

```typescript
async function retrieve(query: string): Promise<Chunk[]> {
  // 1. Embed the query using Gemini (free)
  const queryEmbedding = await geminiEmbed(query, 'RETRIEVAL_QUERY');

  // 2. Hybrid search in Supabase
  const results = await supabase.rpc('hybrid_search', {
    query_embedding: queryEmbedding,
    query_text: query,
    match_count: 10  // no reranker, so fetch fewer, higher-quality results
  });

  // 3. "I don't know" gate (using similarity score directly)
  if (!results.length || results[0].similarity < 0.35) {
    return []; // triggers fallback response
  }

  // 4. Take top 5
  return results.slice(0, 5);
}
```

**Why 0.35 threshold (not 0.4)?** Without a reranker, the raw hybrid similarity scores tend to be slightly lower. 0.35 is a good starting point. Tune after testing with 20 real queries. If too many false "I don't know" responses, lower to 0.3. If too many hallucinated answers, raise to 0.4.

### Conversation Logging

Every Q&A pair logged to Supabase `conversations` table:

```sql
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  retrieved_chunk_ids UUID[],
  top_similarity_score FLOAT,
  was_fallback BOOLEAN DEFAULT false,
  visitor_ip_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Rate Limiting

- Per IP: 20 questions/hour
- Per session: 50 questions total
- Implemented via Upstash Redis `@upstash/ratelimit`

---

## Component 3: Notion Sync Pipeline

Runs offline via GitHub Actions cron (every 6 hours). Syncs Notion wiki content into Supabase as embedded chunks.

### Notion Sources

**Wiki Chunks Database** (ID: `33d78008-9100-8183-850d-e7677ac46b63`):
| Page | Notion ID |
|------|-----------|
| Bio & Narrative | `35678008-9100-8145-b7a7-f1268061146c` |
| Projects & Artifacts | `35678008-9100-8193-9194-f03ab84d2496` |
| Career Decisions | `35678008-9100-8104-a59d-c61247cf501e` |
| FAQ | `35678008-9100-8155-becf-cfc6929db676` |
| Anti-corpus | `35678008-9100-8137-98c6-e65247b795fb` |
| Domain Expertise | `35678008-9100-81c2-87ad-ceda02206229` |

**Career Pages** (separate pages, not in wiki DB):
| Page | Notion ID |
|------|-----------|
| Flipkart (2015-2021) | `35578008-9100-8139-bfe5-e68cae40f5b1` |
| Trade Republic (2021-2023) | `35578008-9100-81ee-9802-e68bbb9a647a` |
| CheQ (2023-2024) | `35578008-9100-8155-8a28-dc876746b7bb` |
| N26 (Oct 2024-present) | `35578008-9100-815c-9866-d7f442f58f5e` |

**Blog Posts** (6 posts, query Notion for pages in the blog database):
- "Org Design in the Age of AI"
- "The 4 Archetypes of AI Leadership"
- "The Gap Nobody's Naming"
- "Your CLAUDE.md is a Scar Tissue Document"
- "The Model is a Commodity, the System is the Moat"
- "The AI Does Not Need to Be Smarter, It Needs to Stop Forgetting"

### Chunking Strategy

1. Fetch all blocks from each Notion page via `GET /v1/blocks/{page_id}/children`
2. Split by H2 heading blocks, each H2 starts a new chunk
3. Within a chunk, concatenate all child blocks (paragraphs, lists, callouts) into plain text
4. Max chunk size: 400 tokens. If a section exceeds 400 tokens, split at paragraph boundaries
5. Overlap: 50 tokens between adjacent chunks
6. Embed each chunk using Gemini `text-embedding-004` with `taskType: RETRIEVAL_DOCUMENT`
7. Upsert to Supabase with metadata

### Supabase Schema

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  notion_page_id TEXT NOT NULL,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  surface_type TEXT NOT NULL,  -- bio, career, project, faq, domain, blog, anti-corpus
  embedding vector(768),       -- Gemini text-embedding-004 dimension
  last_synced_at TIMESTAMPTZ DEFAULT now(),
  notion_last_edited TEXT,

  UNIQUE(notion_page_id, heading)
);

-- Vector similarity search index
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- Full-text search index (BM25)
ALTER TABLE chunks ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED;
CREATE INDEX ON chunks USING gin (fts);

-- Hybrid search function
CREATE OR REPLACE FUNCTION hybrid_search(
  query_embedding vector(768),
  query_text text,
  match_count int DEFAULT 10,
  vector_weight float DEFAULT 0.7,
  bm25_weight float DEFAULT 0.3
)
RETURNS TABLE (
  id uuid,
  heading text,
  content text,
  surface_type text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  WITH vector_results AS (
    SELECT id, heading, content, surface_type,
           1 - (embedding <=> query_embedding) AS vec_score
    FROM chunks
    WHERE surface_type != 'anti-corpus'
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  bm25_results AS (
    SELECT id, heading, content, surface_type,
           ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) AS bm25_score
    FROM chunks
    WHERE fts @@ websearch_to_tsquery('english', query_text)
      AND surface_type != 'anti-corpus'
    LIMIT match_count * 2
  ),
  combined AS (
    SELECT
      COALESCE(v.id, b.id) AS id,
      COALESCE(v.heading, b.heading) AS heading,
      COALESCE(v.content, b.content) AS content,
      COALESCE(v.surface_type, b.surface_type) AS surface_type,
      (COALESCE(v.vec_score, 0) * vector_weight +
       COALESCE(b.bm25_score, 0) * bm25_weight) AS similarity
    FROM vector_results v
    FULL OUTER JOIN bm25_results b ON v.id = b.id
  )
  SELECT id, heading, content, surface_type, similarity
  FROM combined
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
```

### Sync Script Pseudocode

```typescript
// sync-notion.ts — runs as GitHub Action every 6 hours

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });

async function embedChunk(text: string): Promise<number[]> {
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_DOCUMENT'
  });
  return result.embedding.values; // number[768]
}

async function syncAll() {
  const notionPages = [...WIKI_PAGES, ...CAREER_PAGES, ...BLOG_PAGES];

  for (const page of notionPages) {
    const blocks = await fetchAllBlocks(page.notionId);
    const chunks = chunkByH2(blocks, { maxTokens: 400, overlap: 50 });

    for (const chunk of chunks) {
      const embedding = await embedChunk(chunk.content);

      await supabase.from('chunks').upsert({
        notion_page_id: page.notionId,
        heading: chunk.heading,
        content: chunk.content,
        surface_type: page.surfaceType,
        embedding,
        notion_last_edited: page.lastEdited,
        last_synced_at: new Date().toISOString()
      }, { onConflict: 'notion_page_id,heading' });
    }
  }
}
```

---

## Component 4: Admin Dashboard (Phase 3)

Simple page at `/admin` (password-protected) for Akash to review:

- **Low-confidence answers:** conversations where `top_similarity_score < 0.45`
- **Top queries:** most common questions (group by similarity)
- **Unanswered rate:** % of questions that triggered "I don't know"
- **Action:** each flagged Q&A has a "Write wiki chunk" button that opens Notion

---

## API Keys Needed

All services are free tier. The developer needs to create accounts and get keys.

| Service | What | Where to get | Cost |
|---------|------|-------------|------|
| Notion | Integration API key | Get from Akash (already exists) | Free |
| MiniMax | LLM API key | Get from Akash (has subscription) | $0 (covered) |
| Google AI Studio | Gemini API key for embeddings | https://aistudio.google.com/apikey | Free |
| Supabase | Project URL + anon key + service role key | https://supabase.com (create project) | Free tier |
| Upstash | Redis REST URL + token | https://upstash.com (create database) | Free tier |
| Resend | Email API key (for contact form) | https://resend.com | Free tier |

### Setup Checklist for Developer

1. **Google AI Studio** — go to https://aistudio.google.com/apikey, sign in with any Google account, create an API key. No billing required.
2. **Supabase** — create a new project, go to Settings > API, copy the project URL and both keys (anon + service_role). Run the SQL schema above in the SQL Editor.
3. **Upstash** — create a Redis database, copy the REST URL and token.
4. **Resend** — create an account, verify a domain or use the sandbox, copy the API key.
5. **Vercel** — import the backend repo from GitHub. Add all env vars in Project Settings > Environment Variables.
6. **MiniMax + Notion keys** — get from Akash directly.

---

## Phased Build Plan

### Phase 1: Foundation (weekend 1)
- [ ] Set up backend repo (Node.js/TypeScript)
- [ ] Supabase project + run schema SQL above
- [ ] Notion sync script: fetch pages, chunk by H2, embed with Gemini, upsert
- [ ] Basic `/api/chat` endpoint: embed query (Gemini), vector search, prompt MiniMax, stream response
- [ ] Framer chat component: input, streaming display, basic styling
- [ ] Deploy backend to Vercel, connect from Framer
- [ ] **Test:** ask "What did Akash do at Flipkart?" and get a grounded answer

### Phase 2: Retrieval + Answer Quality (weekend 2)
- [ ] Add BM25 search via tsvector (already in schema)
- [ ] Switch to hybrid_search function (vector + BM25 combined)
- [ ] Add citation extraction and rendering in Framer
- [ ] Add "I don't know" gating (similarity score < 0.35)
- [ ] System prompt tuning: voice, anti-corpus rules, citation format
- [ ] **Test:** ask "What's Akash's view on vibe coding?" — verify citation appears
- [ ] **Test:** ask "What's Akash's salary?" — verify polite decline

### Phase 3: Safety & Operations (weekend 3)
- [ ] Rate limiting via Upstash Redis
- [ ] Conversation logging to Supabase
- [ ] Contact form fallback (Resend email to ahkedia@gmail.com)
- [ ] Admin page for reviewing low-confidence Q&As
- [ ] **Test:** hit rate limit, verify 429 UX works

### Phase 4: Polish (weekend 4)
- [ ] Suggested questions on cold start
- [ ] Mobile responsiveness pass
- [ ] Error states (rate limit, API failure, empty response)
- [ ] Loading/typing indicators
- [ ] Domain setup + CORS configuration
- [ ] **Test:** full flow on mobile, all error states

---

## CORS Configuration

The backend must allow requests from the Framer domain:

```typescript
const ALLOWED_ORIGINS = [
  'https://askakash.com',        // production domain (or whatever domain is chosen)
  'https://*.framer.app',        // Framer preview domains
  'http://localhost:3000'         // local development
];
```

---

## How to Hand This to Claude Code / Codex

Copy this entire document into the project's `CLAUDE.md` file. Then use these prompts in order:

**Prompt 1 — Backend + Sync Pipeline:**
> "Read CLAUDE.md for the full spec. Build the backend API and Notion sync pipeline. Phase 1: create the Supabase schema (chunks + conversations tables + hybrid_search function), write the Notion sync script that fetches pages, chunks by H2, embeds with Gemini text-embedding-004, and upserts to Supabase. Then build the /api/chat endpoint that embeds the query with Gemini, runs hybrid_search, and prompts MiniMax M2.7 with the retrieved chunks. Stream the response as SSE. Use TypeScript. All Notion page IDs and the chunking strategy are in CLAUDE.md."

**Prompt 2 — Framer Chat Component:**
> "Build a React chat component for Framer that calls POST /api/chat at <backend-url>. Handle SSE streaming, display messages with a typing indicator, parse [source: X] citations into footnote-style links, show 4 suggested questions on cold start, and handle 429 rate limit errors gracefully. Mobile-first layout. The component should be self-contained (single file, no external dependencies beyond React)."

**Prompt 3 — Phase 2 (after Phase 1 works):**
> "Read CLAUDE.md. Add hybrid retrieval by switching from pure vector search to the hybrid_search Supabase function. Add citation rendering in the chat responses. Add 'I don't know' gating: if top similarity score < 0.35, return a fallback message instead of prompting the LLM. Tune the system prompt for voice and anti-corpus enforcement."

**Prompt 4 — Phase 3 (after Phase 2 works):**
> "Read CLAUDE.md. Add Upstash rate limiting (20/hour per IP, 50/session), conversation logging to the Supabase conversations table, Resend email fallback for contact form, and a simple /admin page that shows low-confidence answers and top queries."

---

## Upgrade Path (if answer quality needs improvement later)

If MiniMax M2.7 answers feel less conversational than desired, the architecture supports a drop-in swap:

| Upgrade | What changes | Cost added |
|---------|-------------|-----------|
| Swap to Claude Sonnet 4.6 | Change one API endpoint + model ID in the chat route | ~$10-15/month |
| Add Voyage reranker | Add one API call between retrieval and LLM | ~$1-2/month |
| Add anti-corpus classifier | Add Haiku pre-check before retrieval | ~$0.50/month |
| Swap to Voyage embeddings | Re-embed all chunks (one-time), change embedding calls | ~$0.50/month |

Each upgrade is independent. The Supabase schema, Framer component, and sync pipeline stay the same. Only the backend API route changes.

---

## Cost Estimate

| Service | Monthly cost |
|---------|-------------|
| MiniMax M2.7 | $0 (existing subscription) |
| Gemini embeddings | $0 (free tier) |
| Supabase | $0 (free tier) |
| Vercel | $0 (free tier) |
| Upstash Redis | $0 (free tier) |
| Resend | $0 (free tier) |
| Framer | $0 (free plan, "Made in Framer" badge) |
| GitHub Actions | $0 (free for public repos) |
| **Total** | **$0/month** |
