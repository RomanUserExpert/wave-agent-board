// Local server for the Wave Terminal agent board.
// Must be started from a Wave terminal: it needs the WAVETERM_* variables to call wsh.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getConfig, CONFIG_FILE, ensureSoundFile, psPlayCommand } from './sound.mjs';
import { HOME_DIR, STATUS_DIR, PID_FILE, LOG_FILE, ENV_FILE, PORT, ensureDirs, writeJsonAtomic, readJson, isPidAlive, lastAssistantText } from './common.mjs';

// Started by a hook through WMI we get no Wave variables; take the ones the hook saved
if (!process.env.WAVETERM_JWT) Object.assign(process.env, readJson(ENV_FILE) || {});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAVE_DATA = process.env.WAVETERM_DATA_HOME || path.join(os.homedir(), 'AppData', 'Local', 'waveterm', 'Data');
const DB_PATH = path.join(WAVE_DATA, 'db', 'waveterm.db');
const WSH = process.env.WAVETERM_WSHBINDIR ? path.join(process.env.WAVETERM_WSHBINDIR, 'wsh.exe') : 'wsh';

// Logs to a file itself: when a hook starts the server, its stdout goes nowhere
const log = (...a) => {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {}
};

// ---------- Wave DB (read-only) ----------
let db = null;
function query(sql, ...args) {
  try {
    db ||= new DatabaseSync(DB_PATH, { readOnly: true });
    return db.prepare(sql).all(...args);
  } catch (e) {
    try { db?.close(); } catch {}
    db = null;
    throw e;
  }
}
const parseData = (row) => JSON.parse(Buffer.from(row.data).toString('utf8'));
function getObj(table, oid) {
  const row = query(`select data from ${table} where oid = ?`, oid)[0];
  return row ? parseData(row) : null;
}

function getWorkspace() {
  const wsId = process.env.WAVETERM_WORKSPACEID;
  let ws = wsId && getObj('db_workspace', wsId);
  if (!ws) ws = query('select data from db_workspace').map(parseData)[0];
  return ws;
}

// ---------- wsh ----------
function wsh(args, env = {}, timeout = 3000) {
  return new Promise((resolve, reject) => {
    execFile(WSH, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// ---------- Terminal screen parsing ----------
const CLAUDE_UI = /bypass permissions|\? for shortcuts|esc to interrupt|shift\+tab to cycle|accept edits on|plan mode on|auto mode on/i;

function analyzeScrollback(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-40);
  const tailText = tail.join('\n');
  // A working agent's spinner: "· Sublimating… (4m 55s · ↓ 25.1k tokens)"
  const spinner = tail.slice(-12).findLast((l) => /^\s*[·✢✳✶✻✽*]\s+\S[^\n]*…\s*\(/.test(l));
  const res = {
    claudeUi: CLAUDE_UI.test(tail.slice(-8).join('\n')),
    busy: !!spinner || /esc to interrupt/i.test(tailText),
    spinner: spinner ? spinner.trim().replace(/^[·✢✳✶✻✽*]\s+/, '') : '',
    asking: /Do you want to (proceed|make this edit|create)|❯\s*1\.\s*Yes/i.test(tailText),
    recap: '',
    lastLine: '',
  };
  // "※ recap: ..." can span several lines
  const i = tail.findLastIndex((l) => /※\s*recap:/i.test(l));
  if (i >= 0) {
    const parts = [tail[i].replace(/.*※\s*recap:\s*/i, '')];
    for (let j = i + 1; j < tail.length && tail[j].trim() && !/^[─━]+$/.test(tail[j].trim()); j++) parts.push(tail[j].trim());
    res.recap = parts.join(' ').replace(/\(disable recaps.*?\)/i, '').replace(/\s+/g, ' ').trim();
  }
  res.lastLine = (tail.filter((l) => l.trim()).pop() || '').trim().slice(0, 200);
  return res;
}

async function scrollbackInfo(blockId) {
  try {
    return analyzeScrollback(await wsh(['termscrollback', '-b', blockId]));
  } catch {
    return null;
  }
}

// ---------- Snapshot ----------
let cache = { at: 0, data: null, pending: null };
let wshFailures = 0;

async function buildSnapshot() {
  const ws = getWorkspace();
  if (!ws) throw new Error('workspace not found');
  const tabs = [];
  const jobs = [];
  ws.tabids.forEach((tabId, index) => {
    const tab = getObj('db_tab', tabId);
    if (!tab) return;
    const t = { id: tabId, name: tab.name, index, active: tabId === ws.activetabid, sessions: [] };
    tabs.push(t);
    for (const blockId of tab.blockids || []) {
      const block = getObj('db_block', blockId);
      const meta = block?.meta || {};
      if (meta.view !== 'term' || (meta.controller && meta.controller !== 'shell')) continue;
      const s = { blockId, tabId, tabName: tab.name, cwd: meta['cmd:cwd'] || '' };
      t.sessions.push(s);
      jobs.push(scrollbackInfo(blockId).then((sb) => { fillSession(s, sb); return !!sb; }));
    }
  });
  seen = readJson(SEEN_FILE) || {};
  const results = await Promise.all(jobs);
  // If wsh stopped answering entirely (e.g. the terminal the server got its token from was closed),
  // exit: the next Claude hook restarts the server with a fresh environment
  if (results.length && results.every((ok) => !ok)) {
    if (++wshFailures >= 3) setTimeout(() => { log('wsh unavailable, exiting'); cleanup(); }, 100);
  } else wshFailures = 0;
  return {
    workspace: { id: ws.oid, name: ws.name },
    activeTabId: ws.activetabid,
    tabs,
    generatedAt: Date.now(),
  };
}

// The Stop hook can fire before the final reply is flushed to the transcript,
// so read it here instead, cached by the transcript's mtime
const lastMessageCache = new Map();
function freshLastMessage(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const mtime = fs.statSync(transcriptPath).mtimeMs;
    const hit = lastMessageCache.get(transcriptPath);
    if (hit?.mtime === mtime) return hit.text;
    const text = lastAssistantText(transcriptPath);
    lastMessageCache.set(transcriptPath, { mtime, text });
    return text;
  } catch {
    return '';
  }
}

const lastState = new Map();
const observedDoneAt = new Map();
let seen = {};
const SEEN_FILE = path.join(HOME_DIR, 'seen.json');
function markSeen(blockId) {
  seen = { ...(readJson(SEEN_FILE) || {}), [blockId]: Date.now() };
  writeJsonAtomic(SEEN_FILE, seen);
  cache.at = 0;
}

function fillSession(s, sb) {
  const st = readJson(path.join(STATUS_DIR, `${s.blockId}.json`));
  const agentRunning = sb ? sb.claudeUi : st && st.state !== 'ended';
  s.cwd = st?.cwd || s.cwd;
  s.project = s.cwd ? path.basename(s.cwd.replace(/[\\/]+$/, '')) : '';
  s.hooked = !!st && st.state !== 'ended';

  if (!agentRunning) {
    s.agent = null;
    s.state = 'shell';
    s.lastLine = sb?.lastLine || '';
    if (st?.task) s.lastTask = st.task;
    return;
  }

  s.agent = 'Claude Code';
  s.task = st?.task || '';
  s.sessionId = st?.sessionId || '';
  s.transcriptPath = st?.transcriptPath || '';
  s.activity = st?.activity || '';
  s.lastMessage = freshLastMessage(st?.transcriptPath) || st?.lastMessage || '';
  s.recap = sb?.recap || '';
  s.spinner = sb?.spinner || '';
  s.updatedAt = st?.updatedAt || null;
  s.since = st?.workingSince || null;

  // Hooks give meaning (task, tool); the screen tells whether the agent is actually running right now
  let state = st && st.state !== 'ended' ? st.state : 'idle';
  if (sb) {
    if (sb.asking) state = 'waiting';
    else if (sb.busy) state = 'working';
    else if (state === 'working' && Date.now() - (st?.updatedAt || 0) > 10_000) state = 'idle';
  }
  s.state = state;
  if (state !== 'working') s.since = null;

  // Finished and not looked at yet. Hooks record when the agent stopped; sessions without hooks
  // get the moment the server saw working -> idle.
  const prev = lastState.get(s.blockId);
  if (prev === 'working' && state === 'idle') observedDoneAt.set(s.blockId, Date.now());
  if (state === 'working') observedDoneAt.delete(s.blockId);
  lastState.set(s.blockId, state);
  const doneAt = Math.max(st?.doneAt || 0, observedDoneAt.get(s.blockId) || 0);
  s.unread = state === 'idle' && doneAt > (seen[s.blockId] || 0);
}

async function getSnapshot() {
  if (cache.data && Date.now() - cache.at < 1000) return cache.data;
  cache.pending ||= buildSnapshot()
    .then((d) => { cache = { at: Date.now(), data: d, pending: null }; return d; })
    .catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

// ---------- Jump to session ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Persistent PowerShell: spawning a new one per click costs ~1.2s
let psWorker = null;
let psWaiters = [];
function getPsWorker() {
  if (psWorker && psWorker.exitCode === null) return psWorker;
  psWorker = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  psWorker.stdout.on('data', (d) => {
    buf += d;
    const err = /chime-error: [^\r\n]*/.exec(buf);
    if (err) { log(err[0]); buf = buf.replace(err[0], ''); }
    while (buf.includes('__done__')) {
      buf = buf.slice(buf.indexOf('__done__') + 8);
      psWaiters.shift()?.();
    }
  });
  psWorker.on('exit', () => { psWaiters.splice(0).forEach((r) => r()); psWorker = null; });
  psWorker.stdin.write('$ws = New-Object -ComObject WScript.Shell\n');
  // Real key events: WScript.SendKeys sometimes leaves Alt held down after a tab switch
  psWorker.stdin.write(`Add-Type -Namespace AgentBoard -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'\n`);
  return psWorker;
}

// Runs one line in the persistent PowerShell and resolves when it's done
function psRun(script) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    psWaiters.push(() => { clearTimeout(t); resolve(); });
    getPsWorker().stdin.write(`${script}; Write-Output '__done__'\n`);
  });
}

const VK_ALT = 0x12;
const KEYUP = 2;
function sendKeysToWave(keys) {
  // Wave on Windows: Alt+1..9 jumps to tab N, Alt+] / Alt+[ to the next/previous tab.
  // keys are virtual-key codes pressed with Alt held; Alt is released in finally, whatever happens.
  const k = (vk, flags = 0) => `[AgentBoard.Keys]::keybd_event(${vk}, 0, ${flags}, [UIntPtr]::Zero)`;
  const presses = keys.map((vk) => `${k(vk)}; ${k(vk, KEYUP)}; Start-Sleep -Milliseconds 40`).join('; ');
  return psRun(`$null = $ws.AppActivate('Wave'); Start-Sleep -Milliseconds 60; try { ${k(VK_ALT)}; ${presses} } finally { ${k(VK_ALT, KEYUP)} }`);
}

function setClipboard(text) {
  // base64 keeps quotes and non-ASCII text intact on the way into PowerShell
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return psRun(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`);
}

// What another Claude session needs to look into this one or talk to it
function sessionReference(s) {
  const lines = [
    `Claude Code session "${s.project}" (Wave tab "${s.tabName}")`,
    `Session ID: ${s.sessionId || 'unknown (started before the board hooks were installed)'}`,
  ];
  if (s.transcriptPath) lines.push(`Transcript (JSONL, read it for the full context): ${s.transcriptPath}`);
  if (s.cwd) lines.push(`Working directory: ${s.cwd}`);
  lines.push(`To message it, run from a Wave terminal: echo "<your message>" | "${WAVE_INPUT}" -b ${s.blockId} -enter`);
  return lines.join('\n');
}

async function focusSession(blockId) {
  const ws = getWorkspace();
  const tabId = ws.tabids.find((id) => (getObj('db_tab', id)?.blockids || []).includes(blockId));
  if (!tabId) throw new Error('block not found in workspace');

  if (tabId !== ws.activetabid) {
    const target = ws.tabids.indexOf(tabId);
    const current = ws.tabids.indexOf(ws.activetabid);
    let keys;
    if (target < 8) keys = [0x31 + target]; // '1'..'8'
    else {
      const delta = target - current;
      keys = Array(Math.abs(delta)).fill(delta > 0 ? 0xdd : 0xdb); // ']' / '['
    }
    const switched = async () => {
      for (let i = 0; i < 12; i++) {
        if (getWorkspace().activetabid === tabId) return true;
        await sleep(50);
      }
      return false;
    };
    // an absolute hotkey is safe to retry, a relative one is not
    await sendKeysToWave(keys);
    if (!(await switched()) && target < 8) {
      log('tab switch retry', tabId);
      await sendKeysToWave(keys);
      await switched();
    }
    await sleep(100);
  }
  await wsh(['focusblock', '-b', blockId], { WAVETERM_TABID: tabId });
  cache.at = 0;
  return { tabId, switched: tabId !== ws.activetabid };
}

function playChime(reason) {
  const file = ensureSoundFile();
  log(`chime (${reason}) volume=${getConfig().volume}`);
  getPsWorker().stdin.write(`try { ${psPlayCommand(file)} } catch { Write-Output "chime-error: $_" }\n`);
}

// ---------- Send input ----------
const WAVE_INPUT = path.resolve(HERE, '..', 'bin', 'wave-input.exe');

function waveInput(blockId, text, flags = []) {
  if (!fs.existsSync(WAVE_INPUT)) {
    return Promise.reject(new Error('bin/wave-input.exe not found: download it from Releases or run "npm run build"'));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(WAVE_INPUT, ['-b', blockId, ...flags], { windowsHide: true, timeout: 10000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    );
    child.stdin.end(text);
  });
}

// Pasted images are saved here; Claude Code turns a pasted image path into an attachment ([Image #N])
const IMAGES_DIR = path.join(HOME_DIR, 'images');
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_MARK = /\[Image #(\d+)\]/g;

function saveImage(dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES[m[1]]) throw new Error('unsupported image type');
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const file = path.join(IMAGES_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${IMAGE_TYPES[m[1]]}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

// Images are kept a week: the transcript refers to them by path
function pruneImages() {
  try {
    for (const f of fs.readdirSync(IMAGES_DIR)) {
      const p = path.join(IMAGES_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400_000) fs.rmSync(p, { force: true });
    }
  } catch {}
}

// The text may hold [Image #N] marks: send the text around them as typed, each image as a pasted path,
// in order, then Enter
async function sendInput(blockId, text, images = {}) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(IMAGE_MARK)) {
    const image = images[m[1]];
    if (!image) continue; // a mark the user typed by hand
    parts.push({ text: text.slice(last, m.index) }, { text: saveImage(image), paste: true });
    last = m.index + m[0].length;
  }
  parts.push({ text: text.slice(last) });
  const nonEmpty = parts.filter((p) => p.text.trim());
  for (const [i, p] of nonEmpty.entries()) {
    const isLast = i === nonEmpty.length - 1;
    await waveInput(blockId, p.text.replace(/^[\r\n]+|[\r\n]+$/g, ''), [...(p.paste ? ['-paste'] : []), ...(isLast ? ['-enter'] : [])]);
    if (!isLast) await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const MAX_BODY = 40 * 1024 * 1024; // room for a few pasted screenshots
async function readBody(req) {
  let data = '';
  for await (const c of req) {
    data += c;
    if (data.length > MAX_BODY) throw new Error('request too large');
  }
  return data ? JSON.parse(data) : {};
}

// /api/send types into terminals, so block other web pages from reaching the API:
// the Host check stops DNS rebinding, and the custom header forces a CORS preflight we never allow.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function isTrustedRequest(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return req.method === 'GET' || req.headers['x-agent-board'] === '1';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!isTrustedRequest(req)) return send(res, 403, { error: 'forbidden' });
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, await getSnapshot());
    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, pid: process.pid });
    if (req.method === 'POST' && url.pathname === '/api/focus') {
      const { blockId } = await readBody(req);
      markSeen(blockId);
      return send(res, 200, await focusSession(blockId));
    }
    if (req.method === 'POST' && url.pathname === '/api/copy-ref') {
      const { blockId } = await readBody(req);
      cache.at = 0;
      const s = (await getSnapshot()).tabs.flatMap((t) => t.sessions).find((x) => x.blockId === blockId);
      if (!s) return send(res, 404, { error: 'session not found' });
      await setClipboard(sessionReference(s));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/seen') {
      const { blockId } = await readBody(req);
      if (blockId) markSeen(blockId);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, getConfig());
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const config = getConfig();
      if (typeof body.sound === 'boolean') config.sound = body.sound;
      if (Number.isFinite(body.volume)) config.volume = Math.round(Math.max(0, Math.min(100, body.volume)));
      writeJsonAtomic(CONFIG_FILE, config);
      if (config.sound) playChime('preview');
      return send(res, 200, config);
    }
    if (req.method === 'POST' && url.pathname === '/api/chime') {
      if (getConfig().sound) playChime('agent finished');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const { blockId, text, images } = await readBody(req);
      if (!blockId || !String(text || '').trim()) return send(res, 400, { error: 'blockId and text are required' });
      await sendInput(blockId, String(text), images && typeof images === 'object' ? images : {});
      markSeen(blockId);
      cache.at = 0;
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', req.url, e.message);
    send(res, 500, { error: e.message });
  }
});

ensureDirs();
pruneImages();
const existing = Number(readJson(PID_FILE)?.pid);
if (existing && existing !== process.pid && isPidAlive(existing)) {
  log(`already running (pid ${existing})`);
  process.exit(0);
}
server.on('error', (e) => {
  log('listen error', e.message);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(PORT, '127.0.0.1', () => {
  writeJsonAtomic(PID_FILE, { pid: process.pid, port: PORT, startedAt: Date.now() });
  log(`wave-agent-board on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  getPsWorker(); // warm up so the first click is fast
});
const cleanup = () => {
  psWorker?.kill();
  if (readJson(PID_FILE)?.pid === process.pid) fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
