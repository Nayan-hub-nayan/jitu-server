import { fetchAllBlocks, blockToText } from './lib/notion.js';

async function testNotionPage() {
  const pageId = '35678008-9100-8155-becf-cfc6929db676';
  const pageName = 'FAQ ';

  console.log(`\n🔍 Fetching data for: | ${pageName} | \`${pageId}\` |\n`);

  try {
    const blocks = await fetchAllBlocks(pageId);
    console.log(`✅ Successfully fetched ${blocks.length} blocks.\n`);

    console.log('--- PAGE CONTENT START ---');
    blocks.forEach(block => {
      const text = blockToText(block);
      if (text.trim()) {
        console.log(text);
      }
    });
    console.log('--- PAGE CONTENT END ---\n');
  } catch (error) {
    console.error('❌ Error fetching Notion page:', error);
  }
}

testNotionPage();
