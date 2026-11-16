// Stages the isolated iPhone preview (docs/IPHONE-ACCEPTANCE.md). Copies ONLY sw.js and the files
// the offline shell precaches (its generated ASSETS list, each hash re-verified) into an empty
// directory outside the repository, plus the preview's vercel.json. It never deploys and never
// reads reference/, docs/, tests/, local configuration or credentials.
//
//   node scripts/preview/stage.mjs [outDir]      (default: a new directory under the OS temp dir)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Static-hosting configuration for the preview project only (never used for production). */
export const PREVIEW_CONFIG = Object.freeze({
  cleanUrls: false,
  trailingSlash: false,
  headers: [
    { source: '/(.*)', headers: [
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ] },
    // The worker and the entry document must be revalidated so a new build is noticed.
    { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/manifest.webmanifest', headers: [{ key: 'Content-Type', value: 'application/manifest+json' }] },
  ],
});

/** The precache list embedded in the generated worker. */
export function precacheList(swSource) {
  const match = swSource.match(/\nconst ASSETS = (\[[\s\S]*?\]);\n/);
  if (!match) throw new Error('sw.js has no ASSETS list. Run npm run build:offline.');
  return JSON.parse(match[1]);
}

/** Copies the preview files into `outDir` (absent or empty, outside the repository). */
export function stage(outDir) {
  const out = resolve(outDir);
  const rel = relative(root, out);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Refusing to stage inside the repository.');
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error('The output directory must be empty or absent.');
  const assets = precacheList(readFileSync(join(root, 'sw.js'), 'utf8'));
  for (const asset of assets) {
    if (sha256(readFileSync(join(root, asset.path))) !== asset.sha256) throw new Error(`sw.js is stale (${asset.path}). Run npm run build:offline.`);
  }
  const files = ['sw.js', ...assets.map((a) => a.path)];
  mkdirSync(out, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    copyFileSync(join(root, file), join(out, file));
  }
  writeFileSync(join(out, 'vercel.json'), `${JSON.stringify(PREVIEW_CONFIG, null, 2)}\n`);
  return { out, files: [...files, 'vercel.json'].sort() };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  // Also refuses when a new frontend file is not yet in the worker's list.
  execFileSync(process.execPath, [join(root, 'scripts/build-offline.mjs'), '--check'], { stdio: 'inherit' });
  const { out, files } = stage(process.argv[2] ?? join(tmpdir(), `fc-preview-${Date.now()}`));
  console.log(`Staged ${files.length} files in ${out}`);
  console.log('Not deployed. See docs/IPHONE-ACCEPTANCE.md for the approved deployment commands.');
}
