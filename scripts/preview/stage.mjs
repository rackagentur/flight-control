// Stages the isolated iPhone preview (docs/IPHONE-ACCEPTANCE.md). Copies ONLY sw.js and the files
// the offline shell precaches (its generated ASSETS list, each hash re-verified) into an empty
// directory outside the repository, plus the preview's vercel.json. It never deploys and never
// reads reference/, docs/, tests/, local configuration or credentials.
//
//   node scripts/preview/stage.mjs [outDir] [--label B]   (default outDir: a new directory under the OS temp dir)
//
// --label X (preview only, for the service-worker update test in docs/IPHONE-ACCEPTANCE.md): in the STAGED copy
// only, Settings → About reads "Version 2.0 · preview build X", and the staged sw.js is regenerated for that
// staged tree (new cache version, hashes match the staged files). The repository is never modified.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildWorker } from '../build-offline.mjs';

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

export const ABOUT_LINE = 'Version 2.0 · operational preview (Phase 4)';
const LABEL = /^[A-Z0-9-]{1,12}$/;

/** Copies the preview files into `outDir` (absent or empty, outside the repository); optional preview build label. */
export function stage(outDir, { label = null } = {}) {
  if (label !== null && !LABEL.test(label)) throw new Error('A build label is 1-12 characters A-Z, 0-9 or "-".');
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
  let version = null;
  if (label !== null) {
    const settings = join(out, 'src/ui/screens/settings.js');
    const text = readFileSync(settings, 'utf8');
    if (text.split(ABOUT_LINE).length !== 2) throw new Error('Settings About line not found exactly once; label not applied.');
    writeFileSync(settings, text.replace(ABOUT_LINE, `Version 2.0 · preview build ${label}`));
    const worker = buildWorker(out);
    writeFileSync(join(out, 'sw.js'), worker.source);
    version = worker.version;
  }
  writeFileSync(join(out, 'vercel.json'), `${JSON.stringify(PREVIEW_CONFIG, null, 2)}\n`);
  return { out, files: [...files, 'vercel.json'].sort(), label, version };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  // Also refuses when a new frontend file is not yet in the worker's list.
  execFileSync(process.execPath, [join(root, 'scripts/build-offline.mjs'), '--check'], { stdio: 'inherit' });
  const args = process.argv.slice(2);
  const at = args.indexOf('--label');
  const label = at >= 0 ? args.splice(at, 2)[1] ?? '' : null;
  const { out, files, version } = stage(args[0] ?? join(tmpdir(), `fc-preview-${Date.now()}`), { label });
  console.log(`Staged ${files.length} files in ${out}${label !== null ? ` · preview build ${label} · shell ${version}` : ''}`);
  console.log('Not deployed. See docs/IPHONE-ACCEPTANCE.md for the approved deployment commands.');
}
