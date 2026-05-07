/**
 * sync-notion.ts — Offline Notion → Supabase sync pipeline
 *
 * Fetches all Notion pages (wiki, career, blog), chunks by H2,
 * embeds with Gemini text-embedding-004, and upserts to Supabase.
 *
 * Run: `npm run sync` or via GitHub Actions cron every 6 hours.
 */

import 'dotenv/config';
import {
  notion,
  WIKI_PAGES,
  CAREER_PAGES,
  fetchAllBlocks,
  fetchBlogPages,
  type NotionPage,
} from './lib/notion.js';
import { chunkByH2 } from './lib/chunker.js';
import { embedText } from './lib/embeddings.js';
import { supabase } from './lib/supabase.js';

// ── Stats tracking ──────────────────────────────────────────────
interface SyncStats {
  pagesProcessed: number;
  chunksUpserted: number;
  chunksSkipped: number;
  errors: string[];
}

// ── Get last edited time for a page ─────────────────────────────
async function getPageLastEdited(pageId: string): Promise<string> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    if ('last_edited_time' in page) {
      return page.last_edited_time;
    }
  } catch {
    // Ignore errors, return empty string
  }
  return '';
}

// ── Process a single page ───────────────────────────────────────
async function processPage(
  page: NotionPage,
  stats: SyncStats
): Promise<void> {
  console.log(`\n📄 Processing: ${page.title} (${page.surfaceType})`);

  try {
    // 1. Get last edited time
    const lastEdited = await getPageLastEdited(page.notionId);

    // 2. Check if page has changed since last sync
    const { data: existingChunks } = await supabase
      .from('chunks')
      .select('notion_last_edited')
      .eq('notion_page_id', page.notionId)
      .limit(1);

    if (
      existingChunks &&
      existingChunks.length > 0 &&
      existingChunks[0].notion_last_edited === lastEdited &&
      lastEdited !== ''
    ) {
      console.log(`   ⏭️  Skipping — not modified since last sync`);
      stats.chunksSkipped++;
      return;
    }

    // 3. Fetch all blocks
    console.log(`   📥 Fetching blocks...`);
    const blocks = await fetchAllBlocks(page.notionId);
    console.log(`   📦 Got ${blocks.length} blocks`);

    // 4. Chunk by H2
    const chunks = chunkByH2(blocks, page.title);
    console.log(`   ✂️  Split into ${chunks.length} chunks`);

    if (chunks.length === 0) {
      console.log(`   ⚠️  No chunks produced — page may be empty`);
      return;
    }

    // 5. Embed and upsert each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(
        `   🔢 Embedding chunk ${i + 1}/${chunks.length}: "${chunk.heading}"`
      );

      // Embed with Gemini (RETRIEVAL_DOCUMENT task type)
      const embedding = await embedText(chunk.content, 'RETRIEVAL_DOCUMENT');

      // Upsert to Supabase (on conflict: notion_page_id + heading)
      const { error } = await supabase.from('chunks').upsert(
        {
          notion_page_id: page.notionId,
          heading: chunk.heading,
          content: chunk.content,
          surface_type: page.surfaceType,
          embedding: JSON.stringify(embedding),
          notion_last_edited: lastEdited,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'notion_page_id,heading' }
      );

      if (error) {
        console.error(`   ❌ Upsert error for "${chunk.heading}":`, error.message);
        stats.errors.push(`${page.title} / ${chunk.heading}: ${error.message}`);
      } else {
        stats.chunksUpserted++;
      }

      // Small delay to stay within Gemini free tier rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 6. Remove stale chunks (headings that no longer exist in the page)
    const currentHeadings = chunks.map((c) => c.heading);
    const { error: deleteError } = await supabase
      .from('chunks')
      .delete()
      .eq('notion_page_id', page.notionId)
      .not('heading', 'in', `(${currentHeadings.map((h) => `"${h.replace(/"/g, '\\"')}"`).join(',')})`);

    if (deleteError) {
      console.warn(`   ⚠️  Could not clean stale chunks:`, deleteError.message);
    }

    stats.pagesProcessed++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ Failed to process ${page.title}:`, message);
    stats.errors.push(`${page.title}: ${message}`);
  }
}

// ── Main sync function ──────────────────────────────────────────
async function syncAll(): Promise<void> {
  console.log('🔄 Starting Notion → Supabase sync...');
  console.log(`   Timestamp: ${new Date().toISOString()}\n`);

  const stats: SyncStats = {
    pagesProcessed: 0,
    chunksUpserted: 0,
    chunksSkipped: 0,
    errors: [],
  };

  // Gather all pages
  const blogPages = await fetchBlogPages();
  console.log(`📚 Found ${blogPages.length} blog posts`);

  const allPages: NotionPage[] = [...WIKI_PAGES, ...CAREER_PAGES, ...blogPages];
  console.log(`📋 Total pages to process: ${allPages.length}`);

  // Process each page sequentially (to respect rate limits)
  for (const page of allPages) {
    await processPage(page, stats);
  }

  // ── Report ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Sync Complete!');
  console.log(`   Pages processed: ${stats.pagesProcessed}`);
  console.log(`   Chunks upserted: ${stats.chunksUpserted}`);
  console.log(`   Pages skipped (unchanged): ${stats.chunksSkipped}`);

  if (stats.errors.length > 0) {
    console.log(`   ❌ Errors (${stats.errors.length}):`);
    for (const err of stats.errors) {
      console.log(`      - ${err}`);
    }
    process.exit(1);
  }

  console.log('═'.repeat(50));
}

// ── Run ─────────────────────────────────────────────────────────
syncAll().catch((err) => {
  console.error('💥 Fatal sync error:', err);
  process.exit(1);
});
