import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const HOME_DIR = path.join(os.homedir(), '.wave-agent-board');
export const STATUS_DIR = path.join(HOME_DIR, 'status');
export const PID_FILE = path.join(HOME_DIR, 'server.pid');
export const LOG_FILE = path.join(HOME_DIR, 'server.log');
export const PORT = Number(process.env.WAVE_AGENT_BOARD_PORT || 7788);

// Claude Code runs hooks in a job object that is killed together with the hook, taking any
// child (detached or not) with it. A process created through WMI lives outside that job and
// gets no window. It doesn't inherit our environment, so callers pass what they need via files.
export function spawnDetached(command, args) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const cmdline = [command, ...args].map(quote).join(' ').replace(/'/g, "''");
  const ps =
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; ' +
    `$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdline}'; ProcessStartupInformation=$si}`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 });
}

// Wave variables the server needs for wsh; handed over through a file because of spawnDetached
export const ENV_FILE = path.join(HOME_DIR, 'wave-env.json');
export function saveWaveEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('WAVETERM')));
  if (env.WAVETERM_JWT) writeJsonAtomic(ENV_FILE, env);
}

export function ensureDirs() {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
}

// Atomic write so the server never reads a half-written file
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const MAX_TEXT = 300;

export function clip(s, n = MAX_TEXT) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Last assistant text from the transcript (reads only the file's tail)
export function lastAssistantText(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'assistant' || !Array.isArray(obj.message?.content)) continue;
      const text = obj.message.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      if (text.trim()) return clip(text, 400);
    }
  } catch {}
  return '';
}

