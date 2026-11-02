/** Reads owned Codex turns through the read-only thread index with four bounded stream readers. Speed cohorts use roots; account calibration can include subagents. Only timing/token metadata survives; LF anchors and inherited/deduplicated turns are covered by speed.test.ts. Also exports the line reader, Task constructor, request/final classifiers and deduplication that claude-records.ts reuses, so both agents classify identically. */
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Diagnostics, IndexedThread, Interval, Task } from './timing.ts';
import { recordUsage, requestedTier } from './speed-cost.ts';

export async function* physicalLines(path: string): AsyncGenerator<{ line: string; number: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let buffer = '', number = 0;
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let cursor = 0, newline = buffer.indexOf('\n');
      while (newline !== -1) {
        yield { line: buffer.slice(cursor, newline), number: ++number };
        cursor = newline + 1; newline = buffer.indexOf('\n', cursor);
      }
      buffer = buffer.slice(cursor);
    }
    if (buffer.length) yield { line: buffer, number: ++number };
  } finally { stream.destroy(); }
}

export function newTask(row: IndexedThread, id: string, start: number, anchor: string): Task {
  return {
    id, thread: row.id, cwd: row.cwd, start, status: 'open', models: new Set(), efforts: new Set(),
    reasoning: new Map(), execution: [], calls: new Map(), returnedCalls: new Set(), waits: [],
    responses: new Set(), reasoningTokens: 0, tokenRecords: 0, changedPaths: new Set(),
    requestedTiers: new Set(), servedTiers: new Set(), servedTierRecords: 0, usage: new Map(), usageAt: new Map(),
    frontend: false, repair: false, deploy: false, excludedRequest: false, pending: false,
    deploymentTier: 'unknown', anchors: { start: anchor },
  };
}

function requestInfo(task: Task, content: any[], at: number, anchor: string): void {
  const text = (content ?? []).filter(c => ['input_text', 'text'].includes(c.type)).map(c => c.text ?? '').join('\n').trim();
  if (!text || task.userAt !== undefined || /^(#\s*AGENTS\.md|<environment_context>|<INSTRUCTIONS>|#\s*Global Codex Rules)/.test(text)) return;
  classifyRequest(task, text, at, anchor);
}

/** Shared by the Codex and Claude parsers: classifies the user request text, which is never retained. */
export function classifyRequest(task: Task, text: string, at: number, anchor: string): void {
  task.userAt = at; task.anchors.user = anchor;
  task.frontend ||= /前端|浏览器|组件|网页|页面|sheet|弹窗|按钮|菜单|动画|文案|布局|滚动|预览|storybook|文件查看器|CSS/i.test(text);
  task.repair = /修复|修正|\b(?:bug|fix|repair)\b|故障|不工作|异常|失效|没反应|问题|不对|错误/i.test(text);
  task.deploy = /^(?:(?:好的|好|ok)[，,。 ]*)?(?:请|帮我|开始)?\s*(?:部署|发布|上线)/i.test(text)
    || /^(?:please\s+)?(?:deploy|release|publish)\b/i.test(text);
  task.excludedRequest = /^(?:<external_|提交|commit\b|push\b|归档)/i.test(text) || /思考|推理|耗时|额度/.test(text);
}

function interval(payload: any): Interval | null {
  const s = payload.started_at_ms, e = payload.completed_at_ms;
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? [s, e] : null;
}

function completedItem(task: Task, p: any, anchor: string): void {
  const item = p.item ?? {}, span = interval(p);
  if (item.type === 'Reasoning') {
    const id = String(item.id ?? anchor);
    if (!task.reasoning.has(id) || span) task.reasoning.set(id, span);
    task.anchors.reasoning ??= anchor;
  }
  if (item.type === 'AgentMessage' && item.phase === 'final_answer' && span) {
    task.end = span[1]; task.anchors.final = anchor;
  }
  if (['CommandExecution', 'McpToolCall', 'FileChange'].includes(item.type) && span) task.execution.push(span);
  if (item.type === 'FileChange') {
    const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => c.path) : Object.keys(item.changes ?? {});
    for (const path of paths) if (typeof path === 'string') {
      const absolute = resolve(task.cwd, path);
      task.changedPaths.add(absolute);
      task.frontend ||= /(?:web|front|frontend)\/.*\.(?:tsx?|css|scss)|\.stories\./i.test(absolute);
    }
  }
  if (item.type === 'CommandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
    task.frontend ||= /(?:\/web\/src|front\/src|frontend\/src|\.stories\.tsx|EvidenceSheet|Sheet\.css)/i.test(command);
  }
}

function finishTask(task: Task, p: any, anchor: string): void {
  task.status = p.type === 'task_complete' ? 'complete' : 'interrupted';
  task.anchors.complete = anchor;
  classifyFinal(task, String(p.last_agent_message ?? ''));
}

/** Shared by both parsers: reads reported pending work and deployment tier from the final reply, which is never retained. */
export function classifyFinal(task: Task, text: string): void {
  task.pending = /^(?:尚未|还未|未)(?:部署|上线|完成)|是否允许|等待.{0,25}(?:授权|确认)|需要.{0,25}(?:授权|确认)/.test(text)
    || /^(?:not|haven't|have not|has not|awaiting|waiting for)\b.{0,40}(?:deployed|completed|approval|confirmation)/i.test(text);
  task.deploymentTier = /\bcanary\b|test-e2\.|金丝雀/i.test(text) ? 'canary'
    : /\bbeta\b/i.test(text) ? 'beta' : /\bproduction\b|生产/i.test(text) ? 'production' : 'unknown';
}

function responseItem(task: Task, p: any, at: number, anchor: string): void {
  if (p.type === 'message' && p.role === 'user') requestInfo(task, p.content, at, anchor);
  if (['custom_tool_call', 'function_call'].includes(p.type) && typeof p.call_id === 'string') {
    if (!task.calls.has(p.call_id)) task.calls.set(p.call_id, at);
  }
  if (['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
    const start = task.calls.get(p.call_id);
    if (start !== undefined && !task.returnedCalls.has(p.call_id)) {
      task.waits.push([start, at]); task.returnedCalls.add(p.call_id);
    }
  }
}

export async function parseSpeedRollout(row: IndexedThread, accountId: string, since: number,
  until: number, diagnostics: Diagnostics): Promise<Task[]> {
  const tasks = new Map<string, Task>(), contexts = new Map<string, any>();
  let current: Task | undefined, seenMeta = false, owned = false, createdAt = -Infinity;
  let settings = { model: 'unknown', effort: 'unknown', tier: 'unknown' };
  try {
    for await (const { line, number } of physicalLines(row.rollout_path)) {
      const prefix = line.slice(0, 180), timestamp = /^\s*\{\s*"timestamp"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
      if (timestamp && Date.parse(timestamp) < since - 60_000 && !prefix.includes('"session_meta"')
        && !line.includes('"thread_settings_applied"')) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { diagnostics.malformedLines++; continue; }
      const p = r.payload ?? {}, at = Date.parse(r.timestamp), anchor = `${row.rollout_path}:${number}`;
      if (r.type === 'session_meta' && !seenMeta) {
        seenMeta = true; owned = p.id === row.id && p.creator_account_id === accountId;
        createdAt = Date.parse(p.timestamp ?? r.timestamp);
        if (!owned) { diagnostics.unownedFiles++; break; }
      }
      if (!owned || !Number.isFinite(at) || at > until) continue;
      if (r.type === 'event_msg' && p.type === 'thread_settings_applied') {
        settings = { model: p.thread_settings?.model ?? settings.model,
          effort: p.thread_settings?.reasoning_effort ?? settings.effort,
          tier: p.thread_settings?.service_tier ?? 'unknown' };
        if (current) requestedTier(current, settings.tier, anchor);
      }
      if (r.type === 'event_msg' && p.type === 'task_started' && typeof p.turn_id === 'string') {
        if (Number.isFinite(p.started_at) && p.started_at * 1000 < createdAt - 1000) {
          diagnostics.inheritedCopies++; current = undefined; continue;
        }
        current = tasks.get(p.turn_id) ?? newTask(row, p.turn_id, at, anchor);
        tasks.set(p.turn_id, current);
        const context = contexts.get(p.turn_id);
        if (context) applyContext(current, context.p, context.anchor, context.settings);
      }
      if (r.type === 'turn_context' && typeof p.turn_id === 'string') {
        contexts.set(p.turn_id, { p, anchor, settings: { ...settings } });
        const task = tasks.get(p.turn_id);
        if (task) { applyContext(task, p, anchor, settings); current = task; }
      }
      if (r.type === 'response_item' && current) responseItem(current, p, at, anchor);
      const task = tasks.get(p.turn_id);
      if (r.type === 'token_usage_record' && task) {
        recordUsage(task, p, anchor, at);
      }
      if (r.type === 'event_msg' && p.type === 'item_completed' && task) completedItem(task, p, anchor);
      if (r.type === 'event_msg' && ['task_complete', 'turn_aborted', 'task_interrupted'].includes(p.type) && task) {
        finishTask(task, p, anchor);
        if (current?.id === task.id) current = undefined;
      }
    }
  } catch { diagnostics.unreadableFiles++; }
  if (!seenMeta) diagnostics.unownedFiles++;
  return [...tasks.values()].filter(t => (t.userAt ?? t.start) >= since && (t.userAt ?? t.start) < until);
}

function applyContext(task: Task, p: any, anchor: string, settings: { model: string; effort: string; tier: string }): void {
  task.models.add(p.model ?? settings.model); task.efforts.add(p.effort ?? p.reasoning_effort ?? settings.effort);
  requestedTier(task, p.service_tier ?? settings.tier, anchor);
  if (typeof p.cwd === 'string') task.cwd = p.cwd;
  task.anchors.context ??= anchor;
}

export function deduplicate(tasks: Task[], diagnostics: Diagnostics): Task[] {
  const unique = new Map<string, Task>();
  const quality = (t: Task) => Number(t.status === 'complete') * 1e6 + Number(Boolean(t.anchors.final)) * 1e5
    + [...t.reasoning.values()].filter(Boolean).length;
  for (const task of tasks) {
    const previous = unique.get(task.id);
    if (previous) diagnostics.duplicateTurns++;
    if (!previous || quality(task) > quality(previous)) unique.set(task.id, task);
  }
  return [...unique.values()].sort((a, b) => (a.userAt ?? a.start) - (b.userAt ?? b.start));
}

export async function readSpeedRecords(home: string, accountId: string, since: number, until: number, project?: string,
  options: { includeSubagents?: boolean } = {}) {
  const diagnostics: Diagnostics = { indexedFiles: 0, rootFiles: 0, excludedSubagents: 0, unknownOwnership: 0,
    unownedFiles: 0, unreadableFiles: 0, malformedLines: 0, inheritedCopies: 0, duplicateTurns: 0 };
  const names = readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!names.length) throw new Error('No supported Codex thread index found.');
  const db = new DatabaseSync(`${home}/${names[0]}`, { readOnly: true });
  let rows: any[];
  const scope = project ? ' AND cwd = ?' : '', params = project ? [Math.floor(since / 1000), project] : [Math.floor(since / 1000)];
  try {
    rows = db.prepare(`SELECT id, rollout_path, cwd, source, agent_path FROM threads WHERE updated_at >= ?${scope} AND creator_account_id = ?`)
      .all(...params, accountId);
    diagnostics.unknownOwnership = Number((db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE updated_at >= ?${scope} AND creator_account_id IS NULL`)
      .get(...params) as any).n);
  } finally { db.close(); }
  diagnostics.indexedFiles = rows.length;
  const roots = rows.filter(r => !r.agent_path && ['cli', 'vscode'].includes(r.source));
  diagnostics.rootFiles = roots.length; diagnostics.subagentFiles = rows.length - roots.length;
  diagnostics.excludedSubagents = options.includeSubagents ? 0 : rows.length - roots.length;
  const selected = options.includeSubagents ? rows : roots;
  diagnostics.calibrationFiles = options.includeSubagents ? selected.length : 0;
  const tasks: Task[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) tasks.push(...await parseSpeedRollout(selected[cursor++], accountId, since, until, diagnostics));
  }));
  return { tasks: deduplicate(tasks, diagnostics), diagnostics, index: names[0] };
}
