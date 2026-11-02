/**
 * Reads Claude Code root transcripts (`<config>/projects/<slug>/<session>.jsonl`) into the same Task shape the Codex
 * parser in speed-records.ts produces, so speed-report.ts treats both agents identically. A request starts at a human
 * prompt, absorbs prompts queued mid-tool-loop, and completes only at the recorded `turn_duration`; an interrupt marker
 * ends it as interrupted. Thinking time is the recorded `thinkingDurationMs` (CLI 2.1.287+), anchored to its block's
 * record timestamp; earlier transcripts leave it null so those turns never enter reasoning averages. Headless
 * `claude -p` sessions, sidechains and `subagents/` files are excluded. Only timing, token and path metadata survive;
 * classification reads prompt/final text in memory and never returns it. speed.test.ts covers every rule above.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Diagnostics, Task } from './timing.ts';
import { classifyFinal, classifyRequest, deduplicate, newTask, physicalLines } from './speed-records.ts';

const INTERACTIVE = new Set(['cli', 'claude-desktop']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Claude Code keeps the login in `<config>/.claude.json`, or `~/.claude.json` for the default `~/.claude`. */
export function readClaudeAccountId(configDir: string, home = homedir()): string {
  const candidates = [join(configDir, '.claude.json')];
  if (resolve(configDir) === resolve(home, '.claude')) candidates.push(join(home, '.claude.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const account = state.oauthAccount;
    if (typeof account?.accountUuid === 'string' && account.accountUuid) {
      return `${account.accountUuid}:${account.organizationUuid ?? ''}`;
    }
    if (typeof state.userID === 'string' && state.userID) {
      return `claude-user:${state.userID}`;
    }
  }
  throw new Error('No local Claude Code account identity available.');
}

/** Claude Code names a project directory after its cwd with every non-alphanumeric character replaced by `-`. */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content) || content.some(b => b?.type === 'tool_result')) return null;
  return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n').trim();
}

/** `/commit args` arrives wrapped in command tags; unwrap it so the shared request rules see `commit args`. */
function commandText(text: string): string {
  const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1];
  return name === undefined ? text : `${name} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''}`.trim();
}

const FILE = String.raw`(?:~|\.{1,2}/|/|\.?[\w@-])[\w@./~-]*\.\w{1,10}`;
const SHELL_WRITES = [
  new RegExp(String.raw`(?<![<>&=\-\d])>>?\s*(['"]?)(${FILE})\1`, 'g'),
  new RegExp(String.raw`\btee\s+(?:-a\s+)?(['"]?)(${FILE})\1`, 'g'),
];
const CODE_WRITES = [
  new RegExp(String.raw`\b(?:writeFileSync|appendFileSync)\(\s*(['"])(${FILE})\1`, 'g'),
  new RegExp(String.raw`\bopen\(\s*(['"])(${FILE})\1\s*,\s*['"][wa+]`, 'g'),
  new RegExp(String.raw`Path\(\s*(['"])(${FILE})\1\s*\)\.write_(?:text|bytes)`, 'g'),
];

/**
 * Literal write targets in a Bash command: redirects, tee, sed -i / perl -pi operands and file-writing calls, resolved
 * against a leading `cd`. Shell patterns skip heredoc bodies, which hold code rather than redirects. Writes through
 * variables or computed paths are invisible, so this under-counts by design.
 */
export function bashWrittenPaths(command: string, cwd: string): string[] {
  const base = resolve(cwd, /^\s*cd\s+(['"]?)([^'"\s;&|]+)\1\s*(?:&&|;)/.exec(command)?.[2]?.replace(/^~(?=\/)/, homedir()) ?? '.');
  const shell = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<$3');
  const found = new Set<string>();
  for (const pattern of SHELL_WRITES) for (const m of shell.matchAll(pattern)) found.add(m[2]);
  for (const pattern of CODE_WRITES) for (const m of command.matchAll(pattern)) found.add(m[2]);
  for (const m of shell.matchAll(/\b(?:sed\s+-i|perl\s+-p?i\S*)\s+([^\n;&|]*)/g)) {
    const operands = m[1].replace(/'[^']*'|"[^"]*"/g, ' ');
    for (const word of operands.match(new RegExp(FILE, 'g')) ?? []) if (!word.startsWith('-')) found.add(word);
  }
  return [...found].filter(p => !p.startsWith('/dev/')).map(p => resolve(base, p.replace(/^~(?=\/)/, homedir())));
}

function recordUsage(task: Task, message: any, at: number, anchor: string): void {
  const id = message.id, u = message.usage;
  if (typeof id !== 'string' || !u || task.responses.has(id)) return;
  task.responses.add(id);
  const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
  const parts = [u.input_tokens, cacheRead, cacheWrite, u.output_tokens];
  task.usage.set(id, parts.every(v => Number.isSafeInteger(v) && v >= 0)
    ? { input: u.input_tokens + cacheRead + cacheWrite, cachedInput: cacheRead, output: u.output_tokens } : null);
  task.usageAt.set(id, at);
  const thinking = u.output_tokens_details?.thinking_tokens;
  if (Number.isSafeInteger(thinking) && thinking >= 0) { task.reasoningTokens += thinking; task.tokenRecords++; }
  if (typeof u.speed === 'string') {
    task.servedTiers.add(u.speed); task.servedTierRecords++; task.anchors.servedSpeed = anchor;
  }
  task.anchors.tokens ??= anchor;
}

function assistantRecord(task: Task, r: any, at: number, anchor: string, state: { final: string }): void {
  const m = r.message ?? {};
  task.models.add(m.model); task.efforts.add(r.perTurnEffort ?? r.effort ?? 'none');
  task.anchors.context ??= anchor;
  recordUsage(task, m, at, anchor);
  for (const block of Array.isArray(m.content) ? m.content : []) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      const ms = r.thinkingDurationMs;
      task.reasoning.set(String(r.uuid ?? anchor), Number.isFinite(ms) && ms >= 0 ? [at - ms, at] : null);
      task.anchors.reasoning ??= anchor;
    }
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      task.end = at; task.anchors.final = anchor; state.final = block.text.slice(0, 2000);
    }
    if (block?.type === 'tool_use' && typeof block.id === 'string') {
      // Text followed by another tool call was progress narration, not the final answer.
      task.end = undefined; delete task.anchors.final; state.final = '';
      if (!task.calls.has(block.id)) task.calls.set(block.id, at);
      const input = block.input ?? {}, shellCwd = typeof r.cwd === 'string' ? r.cwd : task.cwd;
      const edited = EDIT_TOOLS.has(block.name) ? input.file_path ?? input.notebook_path : undefined;
      const paths = typeof edited === 'string' ? [resolve(shellCwd, edited)]
        : block.name === 'Bash' && typeof input.command === 'string' ? bashWrittenPaths(input.command, shellCwd) : [];
      for (const absolute of paths) {
        task.changedPaths.add(absolute);
        task.frontend ||= /(?:web|front|frontend)\/.*\.(?:tsx?|css|scss)|\.stories\./i.test(absolute);
      }
      if (block.name === 'Bash' && typeof input.command === 'string') {
        task.frontend ||= /(?:\/web\/src|front\/src|frontend\/src|\.stories\.tsx)/i.test(input.command);
      }
    }
  }
}

export async function parseClaudeTranscript(path: string, since: number, until: number, diagnostics: Diagnostics,
  options: { includeHeadless?: boolean } = {}): Promise<Task[]> {
  const session = basename(path, '.jsonl'), tasks: Task[] = [], state = { final: '' };
  const basis = new Map<Task, 'TurnDuration' | 'StopHook' | 'EndTurn'>();
  // Record cwd follows the shell's `cd`; the session's first cwd is its project, as in the transcript directory name.
  let current: Task | undefined, midLoop = false, entrypointSeen = false, sessionCwd: string | undefined;
  // turn_duration is definitive; Desktop sessions never write it, so a Stop-hook summary or an end_turn reply closes
  // the request provisionally and a later assistant record in the same request reopens it.
  const close = (task: Task, anchor: string, how: 'TurnDuration' | 'StopHook' | 'EndTurn') => {
    task.status = 'complete'; task.anchors.complete = anchor; basis.set(task, how); classifyFinal(task, state.final);
  };
  try {
    for await (const { line, number } of physicalLines(path)) {
      if (!line.trim()) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { diagnostics.malformedLines++; continue; }
      if (r.isSidechain) continue;
      if (typeof r.entrypoint === 'string' && !entrypointSeen) {
        entrypointSeen = true;
        if (!INTERACTIVE.has(r.entrypoint) && !options.includeHeadless) { diagnostics.excludedHeadless++; return []; }
      }
      if (typeof r.cwd === 'string') sessionCwd ??= r.cwd;
      const at = Date.parse(r.timestamp), anchor = `${path}:${number}`;
      if (!Number.isFinite(at) || at > until) continue;
      if (r.type === 'user' && !r.isMeta) {
        const text = promptText(r.message?.content);
        if (text === null) {
          for (const block of r.message.content) {
            const start = current?.calls.get(block?.tool_use_id);
            if (block?.type === 'tool_result' && start !== undefined && !current!.returnedCalls.has(block.tool_use_id)) {
              current!.waits.push([start, at]); current!.returnedCalls.add(block.tool_use_id);
            }
          }
          continue;
        }
        if (/^\[Request interrupted by user/.test(text)) {
          if (current) { current.status = 'interrupted'; current.anchors.complete = anchor; current = undefined; }
          continue;
        }
        if (!text || /^<local-command-(?:stdout|stderr|caveat)>/.test(text)) continue;
        // A prompt typed while tools are still running is injected into the running request.
        if (current?.status === 'open' && (midLoop || current.calls.size > current.returnedCalls.size)) continue;
        current = newTask({ id: session, rollout_path: path, cwd: sessionCwd ?? '' }, String(r.promptId ?? r.uuid ?? anchor), at, anchor);
        classifyRequest(current, commandText(text), at, anchor);
        if (r.origin?.kind === 'task-notification' || text.startsWith('<task-notification>')) current.excludedRequest = true;
        tasks.push(current); midLoop = false; state.final = '';
      }
      if (r.type === 'assistant' && current && r.message?.model && r.message.model !== '<synthetic>') {
        if (current.status === 'complete') { current.status = 'open'; delete current.anchors.complete; basis.delete(current); }
        assistantRecord(current, r, at, anchor, state);
        if (r.message.stop_reason) midLoop = r.message.stop_reason === 'tool_use';
        if (r.message.stop_reason === 'end_turn' && current.anchors.final) close(current, anchor, 'EndTurn');
      }
      if (r.type === 'system' && r.subtype === 'stop_hook_summary' && current?.anchors.final
        && basis.get(current) !== 'StopHook') close(current, anchor, 'StopHook');
      if (r.type === 'system' && r.subtype === 'turn_duration' && current) {
        close(current, anchor, 'TurnDuration'); current = undefined; state.final = '';
      }
    }
  } catch { diagnostics.unreadableFiles++; }
  const inWindow = tasks.filter(t => (t.userAt ?? t.start) >= since && (t.userAt ?? t.start) < until);
  for (const task of inWindow) if (task.status === 'complete') {
    const key = `completedBy${basis.get(task)}`;
    diagnostics[key] = (diagnostics[key] ?? 0) + 1;
  }
  return inWindow;
}

export async function readClaudeRecords(configDir: string, since: number, until: number, project?: string,
  options: { includeHeadless?: boolean } = {}) {
  const diagnostics: Diagnostics = { indexedFiles: 0, rootFiles: 0, excludedSubagents: 0, excludedHeadless: 0,
    unknownOwnership: 0, unownedFiles: 0, unreadableFiles: 0, malformedLines: 0, inheritedCopies: 0, duplicateTurns: 0,
    completedByTurnDuration: 0, completedByStopHook: 0, completedByEndTurn: 0 };
  const root = join(configDir, 'projects');
  if (!existsSync(root)) throw new Error('No Claude Code transcript directory found.');
  const dirs = project ? [projectSlug(project)].filter(d => existsSync(join(root, d))) : readdirSync(root);
  const files: string[] = [];
  for (const dir of dirs) {
    const path = join(root, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const name of readdirSync(path)) {
      const file = join(path, name), stat = statSync(file);
      if (name.endsWith('.jsonl') && stat.isFile() && stat.mtimeMs >= since) files.push(file);
      if (stat.isDirectory() && existsSync(join(file, 'subagents'))) {
        diagnostics.excludedSubagents += readdirSync(join(file, 'subagents'))
          .filter(n => n.endsWith('.jsonl') && statSync(join(file, 'subagents', n)).mtimeMs >= since).length;
      }
    }
  }
  diagnostics.indexedFiles = files.length;
  const tasks: Task[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) tasks.push(...await parseClaudeTranscript(files[cursor++], since, until, diagnostics, options));
  }));
  diagnostics.rootFiles = files.length - diagnostics.excludedHeadless;
  return { tasks: deduplicate(tasks, diagnostics), diagnostics, index: 'projects/<slug>/<session>.jsonl' };
}
