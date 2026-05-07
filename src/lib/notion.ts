import { Client } from '@notionhq/client';
import { config } from '../config.js';
import type {
  BlockObjectResponse,
  RichTextItemResponse,
} from '@notionhq/client/build/src/api-endpoints.js';

// ── Notion client (lazy-init — only created when sync script runs) ──
let _notion: Client | null = null;

export function getNotionClient(): Client {
  if (!_notion) {
    if (!config.notion.apiKey) {
      throw new Error(
        'NOTION_API_KEY is not set. Add it to your .env file.\n' +
        'Get it from: https://www.notion.so/my-integrations'
      );
    }
    _notion = new Client({ auth: config.notion.apiKey });
  }
  return _notion;
}

// ── Page definitions from CLAUDE.md ─────────────────────────────

export type SurfaceType =
  | 'bio'
  | 'career'
  | 'project'
  | 'faq'
  | 'domain'
  | 'blog'
  | 'anti-corpus';

export interface NotionPage {
  notionId: string;
  title: string;
  surfaceType: SurfaceType;
}

// Wiki pages
export const WIKI_PAGES: NotionPage[] = [
  { notionId: '35678008-9100-8145-b7a7-f1268061146c', title: 'Bio & Narrative', surfaceType: 'bio' },
  { notionId: '35678008-9100-8193-9194-f03ab84d2496', title: 'Projects & Artifacts', surfaceType: 'project' },
  { notionId: '35678008-9100-8104-a59d-c61247cf501e', title: 'Career Decisions', surfaceType: 'domain' },
  { notionId: '35678008-9100-8155-becf-cfc6929db676', title: 'FAQ', surfaceType: 'faq' },
  { notionId: '35678008-9100-8137-98c6-e65247b795fb', title: 'Anti-corpus', surfaceType: 'anti-corpus' },
  { notionId: '35678008-9100-81c2-87ad-ceda02206229', title: 'Domain Expertise', surfaceType: 'domain' },
];

// Career pages
export const CAREER_PAGES: NotionPage[] = [
  { notionId: '35578008-9100-8139-bfe5-e68cae40f5b1', title: 'Flipkart (2015-2021)', surfaceType: 'career' },
  { notionId: '35578008-9100-81ee-9802-e68bbb9a647a', title: 'Trade Republic (2021-2023)', surfaceType: 'career' },
  { notionId: '35578008-9100-8155-8a28-dc876746b7bb', title: 'CheQ (2023-2024)', surfaceType: 'career' },
  { notionId: '35578008-9100-815c-9866-d7f442f58f5e', title: 'N26 (Oct 2024-present)', surfaceType: 'career' },
];

// Blog database ID — we query this for all blog post pages
export const BLOG_DATABASE_ID = '33d78008-9100-8183-850d-e7677ac46b63';

// ── Fetch all blocks from a page (handles pagination) ────────────
export async function fetchAllBlocks(
  pageId: string
): Promise<BlockObjectResponse[]> {
  const notion = getNotionClient();
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      // Filter to only full block objects (not partial)
      if ('type' in block) {
        blocks.push(block as BlockObjectResponse);

        // Recursively fetch children for blocks that have them
        if (block.has_children) {
          const children = await fetchAllBlocks(block.id);
          blocks.push(...children);
        }
      }
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return blocks;
}

// ── Extract plain text from rich text array ──────────────────────
export function richTextToPlain(richText: RichTextItemResponse[]): string {
  return richText.map((rt) => rt.plain_text).join('');
}

// ── Extract text content from a single block ─────────────────────
export function blockToText(block: BlockObjectResponse): string {
  const type = block.type;

  switch (type) {
    case 'paragraph':
      return richTextToPlain(block.paragraph.rich_text);
    case 'heading_1':
      return richTextToPlain(block.heading_1.rich_text);
    case 'heading_2':
      return richTextToPlain(block.heading_2.rich_text);
    case 'heading_3':
      return richTextToPlain(block.heading_3.rich_text);
    case 'bulleted_list_item':
      return `• ${richTextToPlain(block.bulleted_list_item.rich_text)}`;
    case 'numbered_list_item':
      return richTextToPlain(block.numbered_list_item.rich_text);
    case 'to_do':
      return richTextToPlain(block.to_do.rich_text);
    case 'toggle':
      return richTextToPlain(block.toggle.rich_text);
    case 'callout':
      return richTextToPlain(block.callout.rich_text);
    case 'quote':
      return richTextToPlain(block.quote.rich_text);
    case 'code':
      return richTextToPlain(block.code.rich_text);
    case 'divider':
      return '';
    case 'table_of_contents':
      return '';
    case 'image':
      return '[image]';
    default:
      return '';
  }
}

// ── Fetch blog pages from the wiki database ─────────────────────
export async function fetchBlogPages(): Promise<NotionPage[]> {
  const notion = getNotionClient();
  const blogPages: NotionPage[] = [];

  try {
    const response = await notion.databases.query({
      database_id: BLOG_DATABASE_ID,
    });

    for (const page of response.results) {
      if ('properties' in page) {
        // Extract the title from the page properties
        let title = 'Untitled';
        const titleProp = page.properties['Name'] ?? page.properties['Title'] ?? page.properties['title'];
        if (titleProp && titleProp.type === 'title' && titleProp.title.length > 0) {
          title = titleProp.title.map((t) => t.plain_text).join('');
        }

        blogPages.push({
          notionId: page.id,
          title,
          surfaceType: 'blog',
        });
      }
    }
  } catch (err) {
    console.warn('⚠️  Could not fetch blog database. Skipping blog posts.', err);
  }

  return blogPages;
}
