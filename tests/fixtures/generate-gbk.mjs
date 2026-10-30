// Built-in Node APIs only. Invert the GBK decoder for characters in this fake fixture.
import { readFile, writeFile } from 'node:fs/promises';
const text = await readFile(new URL('./alipay-example.csv', import.meta.url), 'utf8');
const needed = new Set([...text].filter(char => char.codePointAt(0) > 0x7f));
const encoded = new Map();
const decoder = new TextDecoder('gbk', { fatal: true });
for (let lead = 0x81; lead <= 0xfe && needed.size; lead++) {
  for (let trail = 0x40; trail <= 0xfe && needed.size; trail++) {
    if (trail === 0x7f) continue;
    const bytes = Buffer.from([lead, trail]);
    try {
      const char = decoder.decode(bytes);
      if (needed.delete(char)) encoded.set(char, bytes);
    } catch { /* Not a valid GBK byte pair. */ }
  }
}
if (needed.size) throw new Error(`Cannot encode: ${[...needed].join('')}`);
const bytes = Buffer.concat([...text].map(char => char.codePointAt(0) <= 0x7f ? Buffer.from(char) : encoded.get(char)));
await writeFile(new URL('./alipay-example-gbk.csv', import.meta.url), bytes);
console.log(`Generated fake GBK bill (${bytes.length} bytes).`);
