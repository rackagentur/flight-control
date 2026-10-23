// Prints the SHA-256 (lowercase hex) of ONE id read from standard input. The id is read from stdin, never from
// argv, so it stays out of shell history and the process list. Used to compute the deny-list hashes of the
// PRODUCTION calendar ids locally; only the hashes are ever pasted into the test projects.
//
//   pbpaste | node scripts/gas-test/hash-id.mjs        (then clear the clipboard: pbcopy < /dev/null)
//
// Reads exactly one id, normalized as the guard does (trimmed, lowercase: fctNormId_ in TestGuardV2.gs); several
// lines, an empty input or an argument is refused.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** SHA-256 hex of one id; throws on an empty id or on more than one line. */
export function hashId(input) {
  const text = String(input).trim();
  if (!text) throw new Error('hash-id: empty input');
  if (/[\r\n]/.test(text)) throw new Error('hash-id: exactly one id, one line');
  return createHash('sha256').update(text.toLowerCase(), 'utf8').digest('hex');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('hash-id: no arguments (the id is read from stdin so it stays out of shell history)');
    process.exit(2);
  }
  if (process.stdin.isTTY) console.error('hash-id: paste ONE id, press Enter, then Ctrl-D (the terminal echoes it; prefer: pbpaste | node ...)');
  try {
    console.log(hashId(await readStdin()));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
