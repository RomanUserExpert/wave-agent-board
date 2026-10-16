// Phone access through Tailscale.   On: npm run mobile   Off: npm run mobile -- --off
// Publishes the board inside your tailnet with `tailscale serve` (HTTPS, your devices only) and
// lets your Tailscale login through the server's checks.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { HOME_DIR, PORT, readJson, writeJsonAtomic } from './common.mjs';
import { CONFIG_FILE } from './sound.mjs';

const off = process.argv.includes('--off');
const candidates = ['tailscale', 'C:/Program Files/Tailscale/tailscale.exe'];

function run(args) {
  for (const exe of candidates) {
    const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r.error?.code === 'ENOENT') continue;
    return r;
  }
  console.error('Tailscale not found. Install it from https://tailscale.com/download and sign in, then run this again.');
  process.exit(1);
}

function fail(what, r) {
  console.error(`${what} failed:\n${(r.stderr || r.stdout || '').trim()}`);
  process.exit(1);
}

fs.mkdirSync(HOME_DIR, { recursive: true });
const config = readJson(CONFIG_FILE) || {};

if (off) {
  const r = run(['serve', '--https=443', 'off']);
  if (r.status !== 0) fail('tailscale serve off', r);
  delete config.tailscaleUsers;
  writeJsonAtomic(CONFIG_FILE, config);
  console.log('Phone access is off.');
  process.exit(0);
}

const status = run(['status', '--json']);
if (status.status !== 0) fail('tailscale status', status);
const st = JSON.parse(status.stdout);
if (st.BackendState !== 'Running') {
  console.error(`Tailscale is ${st.BackendState}. Open it and sign in, then run this again.`);
  process.exit(1);
}
const login = st.User?.[st.Self?.UserID]?.LoginName;
const host = String(st.Self?.DNSName || '').replace(/\.$/, '');
if (!login || !host) {
  console.error("Couldn't read your Tailscale login or this machine's name from `tailscale status`.");
  process.exit(1);
}

config.tailscaleUsers = [...new Set([...(config.tailscaleUsers || []), login])];
writeJsonAtomic(CONFIG_FILE, config);

// --bg keeps it running across restarts. The first time Tailscale may ask to enable HTTPS for the tailnet.
const serve = run(['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`]);
if (serve.status !== 0) fail('tailscale serve', serve);

console.log(`Phone access is on for ${login}.

Open on your phone (Tailscale must be on there too, signed in to the same account):

  https://${host}/

Tip: "Add to Home Screen" makes it open like an app.
To turn it off: npm run mobile -- --off`);
