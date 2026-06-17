import fs from 'node:fs';
import path from 'node:path';

const messagesDir = 'C:\\Users\\pathf\\.gemini\\antigravity-ide\\brain\\c78f8bb2-3f67-452c-b2f4-d30b3684920c\\.system_generated\\messages';

function main() {
  if (!fs.existsSync(messagesDir)) {
    console.error('Directory does not exist:', messagesDir);
    return;
  }

  const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    if (file === 'cursor.json' || file === 'read.json') continue;
    const filePath = path.join(messagesDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.content) {
        console.log(`\n============================\nFILE: ${file}\n============================\n`);
        console.log(parsed.content.substring(0, 300));
      }
    } catch (err) {
      console.error(`Error reading/parsing file ${file}:`, err);
    }
  }
}

main();
