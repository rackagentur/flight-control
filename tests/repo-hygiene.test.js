// Repository hygiene: nothing personal or secret may become committable.
//
// Scans every file git would commit (tracked + untracked-not-ignored) for:
//   1. generic patterns (deployment URLs, calendar/sheet IDs, API keys, saved-list links,
//      crew employee numbers, personal mailboxes);
//   2. exact production values, read at test time from the private, git-ignored
//      reference/ folder when it exists locally. The values themselves never enter the repo.
// Also enforces that reference/ stays ignored and that committed fixtures are synthetic/redacted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = join(ROOT, 'reference', 'apps-script-v5');
// Binary formats are skipped; every other committable file is scanned as text
// (so copied .gs sources, .ics/.csv roster exports, .env files etc. are covered too).
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.mp4', '.mov']);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function committableFiles() {
  return git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean)
    .filter((path) => existsSync(join(ROOT, path)))
    .filter((path) => !BINARY_EXTENSIONS.has(extname(path).toLowerCase()))
    .filter((path) => !readFileSync(join(ROOT, path)).subarray(0, 8000).includes(0));
}

const GENERIC_PATTERNS = [
  { name: 'Apps Script deployment URL', re: /script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/[A-Za-z0-9_-]{20,}/ },
  { name: 'Google Calendar ID', re: /[a-z0-9]{16,}(?:@|%40)(?:import\.|group\.)?calendar\.google\.com/i },
  { name: 'Google Sheets URL', re: /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google Maps saved-list link', re: /(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9]{6,}|google\.[a-z.]+\/maps\/(?:placelists|@[^\s]*data=!4m)/ },
  { name: 'Crew employee number', re: /\b\d{6}[A-Z]\b/ },
  { name: 'Personal mailbox address', re: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/ },
];

// Exact production values, sourced only from the local, ignored reference/ copy.
function productionSecrets() {
  if (!existsSync(REFERENCE_DIR)) return [];
  const read = (name) => {
    const path = join(REFERENCE_DIR, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  const code = read('Code.gs');
  const dashboard = read('Dashboard.gs');
  const webApp = readdirSync(REFERENCE_DIR)
    .filter((name) => /web ?app/i.test(name) && name.endsWith('.gs'))
    .map(read)
    .join('\n');

  const constValue = (source, name) => {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
    return match ? match[1] : null;
  };
  const found = [
    ['SOURCE_CALENDAR_ID', constValue(code, 'SOURCE_CALENDAR_ID')],
    ['TARGET_CALENDAR_ID', constValue(code, 'TARGET_CALENDAR_ID')],
    ['HOTEL_SPREADSHEET_ID', constValue(code, 'HOTEL_SPREADSHEET_ID')],
    ['MY_EMPLOYEE_NUMBER', constValue(code, 'MY_EMPLOYEE_NUMBER')],
    ['EMAIL_ADDRESS', constValue(dashboard, 'EMAIL_ADDRESS')],
    ['HOTELS_LIST_URL', (webApp.match(/HOTELS_LIST_URL\s*=\s*'([^']+)'/) || [])[1] || null],
  ];
  // Also guard the bare ID part of addresses/URLs (e.g. a calendar ID without its @domain).
  const expanded = [];
  for (const [name, value] of found) {
    if (!value) continue;
    expanded.push([name, value]);
    const localPart = value.includes('@') ? value.split('@')[0] : null;
    const lastPathSegment = /^https?:\/\//.test(value) ? value.split('/').filter(Boolean).pop() : null;
    for (const part of [localPart, lastPathSegment]) {
      if (part && part !== value) expanded.push([`${name} (id part)`, part]);
    }
  }
  return expanded.filter(([, value]) => value.length >= 6);
}

test('reference/ is git-ignored and nothing under it is tracked', () => {
  const ignored = execFileSync('git', ['check-ignore', 'reference/apps-script-v5/Code.gs'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(ignored, /reference/);
  assert.equal(git('ls-files', 'reference').trim(), '', 'files under reference/ are tracked');
});

test('no committable file contains generic secret/personal-data patterns', () => {
  const hits = [];
  for (const path of committableFiles()) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const { name, re } of GENERIC_PATTERNS) {
      const match = text.match(re);
      if (match) hits.push(`${path}: ${name}`);
    }
  }
  assert.deepEqual(hits, [], `Potential personal data or secrets found:\n${hits.join('\n')}`);
});

test('no committable file contains exact production identifiers (local reference check)', (t) => {
  const secrets = productionSecrets();
  if (secrets.length === 0) {
    // Reported as SKIPPED (not passed) so CI output makes the reduced coverage visible.
    t.skip('reference/ not present: exact production-value check NOT performed (generic patterns still apply)');
    return;
  }
  t.diagnostic(`checked ${secrets.length} production identifier values from local reference/`);
  const hits = [];
  for (const path of committableFiles()) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const [name, value] of secrets) {
      if (text.includes(value)) hits.push(`${path}: ${name}`);
    }
  }
  assert.deepEqual(hits, [], `Production identifiers found:\n${hits.join('\n')}`);
});

test('every committed JSON fixture is explicitly synthetic or redacted', () => {
  const fixtures = committableFiles().filter((path) => path.startsWith('tests/fixtures/') && path.endsWith('.json'));
  assert.ok(fixtures.length > 0, 'expected at least one fixture');
  for (const path of fixtures) {
    const data = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    assert.ok(data._synthetic === true || data._redacted === true, `${path} must declare "_synthetic": true or "_redacted": true`);
  }
});
