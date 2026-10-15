// Install: node install.mjs        Uninstall: node install.mjs --uninstall
// Adds hooks to ~/.claude/settings.json (next to existing ones) and a button to ~/.config/waveterm/widgets.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './common.mjs';

const uninstall = process.argv.includes('--uninstall');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'hook.mjs').replace(/\\/g, '/');
const NODE = process.execPath.replace(/\\/g, '/');
// Our hook commands end with this tag, so we can find them whatever the checkout folder is called
const TAG = '--wave-agent-board';
const isOurs = (cmd) => cmd.endsWith(` ${TAG}`) || cmd.includes('wave-agent-board/hook.mjs'); // second form: pre-0.1 installs

const EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: '*',
  PostToolUse: '*',
  PostToolUseFailure: '*',
  PermissionRequest: '*',
  Notification: null,
  Stop: null,
  StopFailure: null,
  SessionEnd: null,
};

function readJsonFile(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
function backup(file) {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, bak);
  console.log(`  backup: ${bak}`);
}

// ---------- Claude Code hooks ----------
const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
const settings = readJsonFile(claudeSettings);
settings.hooks ||= {};
for (const [event, groups] of Object.entries(settings.hooks)) {
  // drop our own previous entries, leave other hooks alone
  settings.hooks[event] = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(String(h.command || ''))) }))
    .filter((g) => g.hooks.length);
  if (!settings.hooks[event].length) delete settings.hooks[event];
}
if (!uninstall) {
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const group = { hooks: [{ type: 'command', command: `"${NODE}" "${HOOK}" ${event} ${TAG}`, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] ||= []).push(group);
  }
}
backup(claudeSettings);
fs.writeFileSync(claudeSettings, JSON.stringify(settings, null, 2) + '\n');
console.log(`${uninstall ? 'Hooks removed from' : 'Hooks added to'} ${claudeSettings}`);

// ---------- Wave widget ----------
const widgetsFile = path.join(os.homedir(), '.config', 'waveterm', 'widgets.json');
const widgets = readJsonFile(widgetsFile);
if (uninstall) delete widgets['agent-board'];
else {
  const url = `http://127.0.0.1:${PORT}/`;
  widgets['agent-board'] = {
    'display:order': -1,
    icon: 'robot',
    label: 'agents',
    description: 'All Claude Code sessions in this workspace',
    blockdef: { meta: { view: 'web', url, pinnedurl: url } },
  };
}
backup(widgetsFile);
fs.mkdirSync(path.dirname(widgetsFile), { recursive: true });
fs.writeFileSync(widgetsFile, JSON.stringify(widgets, null, 2) + '\n');
console.log(`${uninstall ? 'Widget removed from' : 'Widget added to'} ${widgetsFile}`);
