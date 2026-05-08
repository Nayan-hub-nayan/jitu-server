async function testChat() {
  const url = 'http://localhost:3001/api/chat';
  const body = {
    messages: [
      { role: 'user', content: 'Who is Akash and what does he write about in his blogs?' }
    ],
    sessionId: 'test-session'
  };

  console.log('Sending request to:', url);
  console.log('Body:', JSON.stringify(body, null, 2));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Error response:', err);
      return;
    }

    console.log('--- Response Stream ---');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') {
            console.log('\n[DONE]');
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'token') {
              process.stdout.write(parsed.content);
            } else if (parsed.type === 'done') {
              console.log('\n--- Citations ---');
              console.log(JSON.stringify(parsed.citations, null, 2));
            } else if (parsed.type === 'error') {
              console.error('\nError token:', parsed.content);
            }
          } catch (e) {
            // Ignore parse errors for partial lines
          }
        }
      }
    }

    console.log('\n--- Stream Ended ---');

  } catch (err) {
    console.error('Fetch error:', err);
  }
}

testChat();
