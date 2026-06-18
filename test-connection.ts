import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Test 1: Supabase connection + chunks table
  console.log('1️⃣  Testing Supabase connection...');
  const { data, error } = await sb.from('chunks').select('id').limit(1);
  if (error) {
    console.log('   ❌ Supabase error:', error.message);
    console.log('   💡 Have you run supabase-schema.sql in the SQL Editor?');
  } else {
    console.log('   ✅ Supabase connected! Existing chunks:', data.length);
  }

  // Test 2: Notion connection
  console.log('\n2️⃣  Testing Notion connection...');
  try {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (res.ok) {
      const user = await res.json() as any;
      console.log('   ✅ Notion authenticated as:', user.name || user.bot?.owner?.type || 'integration');
    } else {
      const errBody = await res.text();
      console.log(`   ❌ Notion error (${res.status}):`, errBody);
    }
  } catch (err) {
    console.log('   ❌ Notion connection failed:', err);
  }

  // Test 3: Gemini embedding
  console.log('\n3️⃣  Testing Gemini embedding...');
  try {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: 'test embedding' }] },
          taskType: 'RETRIEVAL_QUERY',
        }),
      }
    );
    if (gemRes.ok) {
      const gemData = await gemRes.json() as any;
      console.log('   ✅ Gemini embedding works! Dimension:', gemData.embedding.values.length);
    } else {
      const errBody = await gemRes.text();
      console.log(`   ❌ Gemini error (${gemRes.status}):`, errBody);
    }
  } catch (err) {
    console.log('   ❌ Gemini connection failed:', err);
  }

  console.log('\n✅ Connection test complete.');
}

main().catch(console.error);
