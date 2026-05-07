import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';
import { blockToText } from './notion.js';

// ── Types ────────────────────────────────────────────────────────
export interface Chunk {
  heading: string;
  content: string;
}

interface ChunkOptions {
  maxTokens: number;
  overlap: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxTokens: 400,
  overlap: 50,
};

// ── Rough token count (words ≈ 0.75 tokens, so words * 1.33) ────
// This is a good approximation for English text without a tokenizer
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}

// ── Split text at paragraph boundaries to fit within maxTokens ──
function splitAtParagraphs(
  text: string,
  maxTokens: number,
  overlap: number
): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const result: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    // If a single paragraph exceeds maxTokens, split by sentences
    if (paraTokens > maxTokens) {
      // Flush current buffer first
      if (current.length > 0) {
        result.push(current.join('\n\n'));
        current = [];
        currentTokens = 0;
      }

      // Split long paragraph by sentences
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentBuf: string[] = [];
      let sentTokens = 0;

      for (const sent of sentences) {
        const st = estimateTokens(sent);
        if (sentTokens + st > maxTokens && sentBuf.length > 0) {
          result.push(sentBuf.join(' '));
          // Overlap: keep last sentence(s) that fit within overlap token budget
          const overlapBuf: string[] = [];
          let ot = 0;
          for (let i = sentBuf.length - 1; i >= 0; i--) {
            const ost = estimateTokens(sentBuf[i]);
            if (ot + ost > overlap) break;
            overlapBuf.unshift(sentBuf[i]);
            ot += ost;
          }
          sentBuf = [...overlapBuf];
          sentTokens = ot;
        }
        sentBuf.push(sent);
        sentTokens += st;
      }
      if (sentBuf.length > 0) {
        result.push(sentBuf.join(' '));
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      result.push(current.join('\n\n'));

      // Overlap: keep trailing paragraphs that fit within overlap budget
      const overlapBuf: string[] = [];
      let ot = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const pt = estimateTokens(current[i]);
        if (ot + pt > overlap) break;
        overlapBuf.unshift(current[i]);
        ot += pt;
      }
      current = [...overlapBuf];
      currentTokens = ot;
    }

    current.push(para);
    currentTokens += paraTokens;
  }

  if (current.length > 0) {
    result.push(current.join('\n\n'));
  }

  return result;
}

// ── Main chunking function: split Notion blocks by H2 ───────────
/**
 * Takes raw Notion blocks and splits them into chunks by H2 headings.
 * Each H2 starts a new chunk. Content before the first H2 goes into
 * a chunk with the page title as heading.
 *
 * If a section exceeds maxTokens (400), it's split at paragraph
 * boundaries with 50-token overlap.
 */
export function chunkByH2(
  blocks: BlockObjectResponse[],
  pageTitle: string,
  options: Partial<ChunkOptions> = {}
): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: Chunk[] = [];

  let currentHeading = pageTitle; // Default heading for content before first H2
  let currentLines: string[] = [];

  function flushSection() {
    const content = currentLines
      .join('\n')
      .trim();

    if (!content) return;

    const tokens = estimateTokens(content);

    if (tokens <= opts.maxTokens) {
      chunks.push({ heading: currentHeading, content });
    } else {
      // Split at paragraph boundaries with overlap
      const parts = splitAtParagraphs(content, opts.maxTokens, opts.overlap);
      for (let i = 0; i < parts.length; i++) {
        const suffix = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
        chunks.push({
          heading: `${currentHeading}${suffix}`,
          content: parts[i],
        });
      }
    }
  }

  for (const block of blocks) {
    // Check if this is an H2 heading — starts a new chunk
    if (block.type === 'heading_2') {
      flushSection();
      currentHeading = blockToText(block) || pageTitle;
      currentLines = [];
      continue;
    }

    const text = blockToText(block);
    if (text) {
      currentLines.push(text);
    }
  }

  // Flush the last section
  flushSection();

  return chunks;
}
