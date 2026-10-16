// Claude Code hook: writes session status to ~/.wave-agent-board/status/<blockid>.json
// Usage: node hook.mjs <EventName>, with the event JSON on stdin.
// Never prints to stdout (for UserPromptSubmit it would be injected into context) and always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_DIR, PID_FILE, ensureDirs, writeJsonAtomic, readJson, isPidAlive, clip, lastAssistantText, spawnDetached, saveWaveEnv, runningBackgroundAgents } from './common.mjs';
import { playDoneSound } from './sound.mjs';

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${clip(input.description || input.command, 120)}`;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name}: ${base(input.file_path || input.notebook_path)}`;
    case 'Grep':
    case 'Glob':
      return `${name}: ${clip(input.pattern, 80)}`;
    case 'Agent':
    case 'Task':
      return `Subagent: ${clip(input.description || input.prompt, 100)}`;
    case 'WebFetch':
      try { return `WebFetch: ${new URL(input.url).host}`; } catch { return 'WebFetch'; }
    case 'WebSearch':
      return `WebSearch: ${clip(input.query, 100)}`;
    case 'TodoWrite':
      return 'Updating plan';
    case 'AskUserQuestion':
      return 'Asking a question';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      return m ? `${m[1]}: ${m[2]}` : name || '';
    }
  }
}

function ensureServer() {
  const pid = Number(readJson(PID_FILE)?.pid);
  if (isPidAlive(pid)) return;
  saveWaveEnv();
  spawnDetached(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')]);
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

async function main() {
  const event = process.argv[2] || '';
  const blockId = process.env.WAVETERM_BLOCKID;
  if (!blockId) return; // not inside Wave, nothing to track
  ensureDirs();
  const input = await readStdin().catch(() => ({}));
  const file = path.join(STATUS_DIR, `${blockId}.json`);
  const prev = readJson(file) || {};
  const now = Date.now();

  // A new session in the same block starts from a clean status
  const sameSession = prev.sessionId && prev.sessionId === input.session_id;
  const st = sameSession ? { ...prev } : { startedAt: now };
  Object.assign(st, {
    blockId,
    tabId: process.env.WAVETERM_TABID || prev.tabId,
    workspaceId: process.env.WAVETERM_WORKSPACEID || prev.workspaceId,
    sessionId: input.session_id || prev.sessionId,
    transcriptPath: input.transcript_path || prev.transcriptPath,
    cwd: input.cwd || prev.cwd,
    agent: 'claude',
    updatedAt: now,
    lastEvent: event,
  });

  switch (event) {
    case 'SessionStart':
      st.state = 'idle';
      st.activity = '';
      ensureServer();
      break;
    case 'UserPromptSubmit':
      st.state = 'working';
      // background-task notifications and the like come through as prompts too; they aren't the user's task
      if (!/^\s*<(task-notification|system-reminder|local-command|command-)/.test(input.prompt || '')) st.task = clip(input.prompt);
      st.activity = 'Thinking…';
      st.workingSince = now;
      st.lastMessage = '';
      st.doneAt = null;
      ensureServer();
      break;
    case 'PreToolUse':
      if (input.tool_name === 'AskUserQuestion') {
        st.state = 'waiting';
        st.activity = 'Waiting for your answer';
      } else {
        st.state = 'working';
        st.activity = describeTool(input.tool_name, input.tool_input);
      }
      st.workingSince ||= now;
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      // after a permission grant or an answer the agent is working again
      st.state = 'working';
      break;
    case 'PermissionRequest':
      st.state = 'waiting';
      st.activity = `Needs permission: ${describeTool(input.tool_name, input.tool_input)}`;
      break;
    case 'Notification':
      if (input.notification_type === 'idle_prompt') {
        st.state = 'idle';
      } else {
        st.state = 'waiting';
        st.activity = clip(input.message, 150) || 'Needs you';
      }
      break;
    case 'Stop':
    case 'StopFailure': {
      st.state = 'idle';
      st.activity = event === 'StopFailure' ? 'Stopped with an error' : '';
      st.workingSince = null;
      st.lastMessage = lastAssistantText(st.transcriptPath);
      // The main thread stops between turns while background agents keep working;
      // it's done only once they're finished too (the server then sees working -> idle)
      if (event === 'Stop' && runningBackgroundAgents(blockId) > 0) break;
      st.doneAt = now; // 'finished, not looked at yet' until the board marks it seen
      await playDoneSound().catch(() => {});
      break;
    }
    case 'SessionEnd':
      st.state = 'ended';
      st.activity = '';
      st.workingSince = null;
      break;
    default:
      return;
  }
  writeJsonAtomic(file, st);
}

main().catch(() => {}).finally(() => process.exit(0));
