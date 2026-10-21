#!/usr/bin/env node
/**
 * One-shot deploy for Ling's Classroom.
 *
 *   node deploy.mjs
 *
 * Signs you in, creates the database, creates the table, asks for your teacher
 * password, and deploys. Safe to run again — it skips whatever is already done.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(here, 'wrangler.toml');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DB_NAME = 'lings-classroom';

const wrangler = (args, opts = {}) =>
  spawnSync(npx, ['--yes', 'wrangler@4', ...args], { cwd: here, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const wranglerOut = (args) =>
  spawnSync(npx, ['--yes', 'wrangler@4', ...args], { cwd: here, encoding: 'utf8', shell: process.platform === 'win32' });

const step = (n, msg) => console.log(`\n—— ${n}/5 —— ${msg}\n`);
const die = (msg) => { console.error('\n✗ ' + msg); process.exit(1); };

if (!existsSync(tomlPath)) die('Run this from inside the classroom-api folder.');

/* 1 ------------------------------------------------------------------ */
step(1, 'Signing in to Cloudflare — a browser window will open, click Allow');
if (wrangler(['login']).status !== 0) die('Sign-in failed.');

/* 2 ------------------------------------------------------------------ */
step(2, 'Creating the database');
let toml = readFileSync(tomlPath, 'utf8');
if (!toml.includes('PASTE_DATABASE_ID_HERE')) {
  console.log('   wrangler.toml already has a database_id — skipping.');
} else {
  const res = wranglerOut(['d1', 'create', DB_NAME]);
  const out = (res.stdout || '') + (res.stderr || '');
  console.log(out.trim());
  const id = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  if (!id) {
    die(`Could not read the database id from the output above.\n` +
        `  Copy the database_id it printed into wrangler.toml, replacing\n` +
        `  PASTE_DATABASE_ID_HERE, then run this script again.`);
  }
  writeFileSync(tomlPath, toml.replace('PASTE_DATABASE_ID_HERE', id));
  console.log(`\n   database_id = ${id}  → written to wrangler.toml`);
}

/* 3 ------------------------------------------------------------------ */
step(3, 'Creating the table');
if (wrangler(['d1', 'execute', DB_NAME, '--remote', '--file=schema.sql']).status !== 0) {
  die('Could not create the table.');
}

/* 4 ------------------------------------------------------------------ */
step(4, 'Setting your teacher password');
console.log('   Type a long password and press Enter. Nothing will appear as you type.');
console.log('   This is the only thing protecting your students’ answers — do not give it to students.\n');
if (wrangler(['secret', 'put', 'TEACHER_KEY']).status !== 0) die('Could not set the password.');

/* 5 ------------------------------------------------------------------ */
step(5, 'Deploying');
const dep = wranglerOut(['deploy']);
const depOut = (dep.stdout || '') + (dep.stderr || '');
console.log(depOut.trim());
if (dep.status !== 0) die('Deploy failed — see the output above.');

const url = (depOut.match(/https:\/\/[a-z0-9.-]*workers\.dev/i) || [])[0];
console.log('\n' + '='.repeat(64));
if (url) {
  console.log('✓ Done. Your Worker is live at:\n\n    ' + url + '\n');
  console.log('Send that address to Claude. It goes into classroom/index.html,');
  console.log('on the line:  window.LINGS_API = "";');
} else {
  console.log('✓ Deployed. Copy the https://....workers.dev address printed above');
  console.log('  and send it to Claude.');
}
console.log('='.repeat(64) + '\n');
