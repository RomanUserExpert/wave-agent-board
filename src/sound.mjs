// "Agent finished" chime: a soft two-note bell, generated per volume into ~/.wave-agent-board/chime-<volume>.wav
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, PORT, readJson, spawnDetached } from './common.mjs';

export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
// volume 0..100 maps linearly to peak amplitude 0..MAX_AMPLITUDE; 27 is the level picked by ear
const MAX_AMPLITUDE = 0.2;
const DEFAULT_VOLUME = 27;

export function getConfig() {
  return { sound: true, volume: DEFAULT_VOLUME, ...(readJson(CONFIG_FILE) || {}) };
}

function makeChime(volume) {
  const amp = (volume / 100) * MAX_AMPLITUDE;
  // Warm, bell-like fifth: sine plus a quiet octave partial, soft attack, smooth tail that fades to silence
  const rate = 44100;
  const notes = [
    { freq: 659.25, start: 0.0, dur: 0.45 }, // E5
    { freq: 987.77, start: 0.09, dur: 0.46 }, // B5
  ];
  const total = 0.55;
  const n = Math.floor(rate * total);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const note of notes) {
      const lt = t - note.start;
      if (lt < 0 || lt > note.dur) continue;
      const attack = Math.min(1, lt / 0.015);
      const release = Math.min(1, (note.dur - lt) / 0.12); // fade to zero, no click
      const env = attack * release * Math.exp(-lt * 6);
      const w = 2 * Math.PI * note.freq * lt;
      v += (Math.sin(w) + 0.18 * Math.sin(2 * w) * Math.exp(-lt * 10)) * env;
    }
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * amp)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function ensureSoundFile() {
  const volume = Math.round(Math.max(0, Math.min(100, Number(getConfig().volume) || 0)));
  const file = path.join(HOME_DIR, `chime-${volume}.wav`);
  if (!fs.existsSync(file)) {
    // drop chimes generated for other volumes
    for (const f of fs.readdirSync(HOME_DIR)) if (/^(chime-\d+|done-v\d+)\.wav$/.test(f)) fs.rmSync(path.join(HOME_DIR, f), { force: true });
    fs.writeFileSync(file, makeChime(volume));
  }
  return file;
}

export const psPlayCommand = (file) =>
  `$global:chime = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $global:chime.Play()`;

// Called from the hook. The server already has a warm PowerShell, so ask it first (instant);
// if it's down, play from a process that outlives the hook's job object.
export async function playDoneSound() {
  if (!getConfig().sound) return;
  const file = ensureSoundFile();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/chime`, {
      method: 'POST',
      headers: { 'X-Agent-Board': '1' },
      signal: AbortSignal.timeout(500),
    });
    if (r.ok) return;
  } catch {}
  spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psPlayCommand(file).replace('.Play()', '.PlaySync()')]);
}
