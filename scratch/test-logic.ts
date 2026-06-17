import 'dotenv/config';
import { retrieve } from '../src/lib/retrieval.js';
import { config } from '../src/config.js';

async function run() {
  try {
    console.log('1. Testing retrieve... (skipped for now)');
    // const query = "Who is Akash?";
    // const { chunks, topScore, isFallback } = await retrieve(query);
    // console.log(`Retrieve success. chunks: ${chunks.length}, isFallback: ${isFallback}`);

    console.log('2. Testing LLM fetch...');
    const endpoint = config.llm.baseUrl.endsWith('/chat/completions') 
      ? config.llm.baseUrl 
      : `${config.llm.baseUrl}/chat/completions`;

    const llmResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
        'HTTP-Referer': 'https://askakash.com',
        'X-Title': 'Smart Portfolio Server',
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10,
        stream: true,
      }),
    });
    console.log(`LLM status: ${llmResponse.status}`);
    if (!llmResponse.ok) {
      console.log('LLM Error:', await llmResponse.text());
    }
  } catch (err) {
    console.error('Fatal Error caught:', err);
  }
}

run();
