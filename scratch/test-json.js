// test-json.js
async function runTest(question) {
  console.log(`\n\n=== Testing: "${question}" ===`);
  const response = await fetch('http://localhost:3001/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      sessionId: 'test-json'
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullOutput = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.type === 'token') {
            process.stdout.write(parsed.content);
            fullOutput += parsed.content;
          } else if (parsed.type === 'error') {
            console.error('\nError:', parsed.content);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }

  console.log('\n\n--- Done Streaming ---');
  // Try to parse the full output as JSON just to verify
  try {
    const json = JSON.parse(fullOutput);
    console.log('✅ Successfully parsed as JSON array:', json.length, 'items');
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.log('ℹ️ Output is not JSON (conversational text or malformed).');
  }
}

async function main() {
  await runTest("Who is Jitu?");
  await runTest("Tell me about your projects and templates.");
  await runTest("What is COSMOQ?");
}

main().catch(console.error);
