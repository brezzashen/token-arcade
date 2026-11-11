/** Render rolling telemetry or one account-wide reset cycle from the public report; cycles never sum overlapping windows. */
import type { AccountReport } from '../report.ts';
import { escape, percent, quotaName, scopes, time, tokens } from './format.ts';
import { quotaModels } from './quota-models.ts';

export const telemetryScopes = { ...scopes, current_cycle: '周期内' };
type QuotaWindow = AccountReport['windows'][number];

export function cycleWindows(account: AccountReport, now = Date.now()): QuotaWindow[] {
  // A model-scoped window (the separate Fable weekly limit) is a cycle of its own; surface-scoped ones have no local records.
  return account.windows.filter(row => (!row.scoped || (row.model !== null && row.surface === null && row.cycle !== null)) && row.minutes !== null && row.minutes > 0
    && row.resetsAt !== null && Date.parse(row.resetsAt) > now);
}

export function selectedCycle(account: AccountReport, name: string, now = Date.now()): QuotaWindow | undefined {
  const windows = cycleWindows(account, now);
  return windows.find(row => row.name === name) ?? windows.find(row => row.minutes === 10080 && !row.scoped) ?? windows[0];
}

export function telemetry(account: AccountReport, windowId: string, cycleName: string, now = Date.now(), accounts: AccountReport[] = [account]) {
  const inCycle = windowId === 'current_cycle';
  const cycle = inCycle ? selectedCycle(account, cycleName, now) : undefined;
  const sample = inCycle ? cycle?.cycle : account.samples.find(row => row.id === windowId);
  const input = sample?.inputTokens ?? null;
  const cached = sample?.cachedInputTokens ?? null;
  const hit = inCycle ? input !== null && input > 0 && cached !== null ? cached / input * 100 : null
    : account.cache.find(row => row.id === windowId)?.tokenHitPercent ?? null;
  const coverage = sample?.status === 'partial' ? '部分记录' : sample?.status === 'observed' ? '已记录' : '暂无记录';
  const start = sample?.start ?? (cycle ? new Date(Date.parse(cycle.resetsAt!) - cycle.minutes! * 60_000).toISOString() : null);
  const cycleControls = inCycle ? `<div class="cycle-controls"><label>额度周期 <select data-cycle aria-label="额度周期">${cycleWindows(account, now).map(row =>
    `<option value="${escape(row.name)}"${row === cycle ? ' selected' : ''}>${escape(quotaName(row))}</option>`).join('') || '<option>暂无周期读数</option>'}</select></label><span>已用额度 <b>${percent(cycle?.usedPercent ?? null)}</b></span></div>` : '';
  const cycleNote = inCycle ? cycle
    ? `<div class="sample-note">上次重置 ${time(start)} → 下次重置 ${time(cycle.resetsAt)}（新加坡时间） · 累计截至 ${time(sample?.end ?? account.quotaObservedAt ?? account.capturedAt)}</div>`
    : '<div class="sample-note">暂无有效重置周期，无法计算周期累计。</div>' : '';
  return `<section class="telemetry" id="telemetry-section">${!inCycle && account.telemetryIssue ? `<div class="notice">! ${escape(account.telemetryIssue)}。</div>` : ''}<div class="section-heading"><span>TOKEN 遥测</span><div class="window-tabs" aria-label="统计区间">${Object.entries(telemetryScopes).map(([id, label]) => `<button data-window="${id}" aria-pressed="${windowId === id}" class="${windowId === id ? 'active' : ''}">${label}</button>`).join('')}</div></div>
    ${cycleControls}<div class="metrics"><article class="metric main-metric"><span class="metric-label">${inCycle ? '周期累计 token' : '记录 token'}</span><strong>${tokens(sample?.totalTokens ?? null)}</strong><div class="metric-sub">${coverage} · 输入 + 输出</div></article><article class="metric"><span class="metric-label">缓存命中</span><strong>${percent(hit)}</strong><div class="metric-sub">缓存输入 / 总输入</div></article><article class="metric"><span class="metric-label">消耗速度</span><strong>${tokens(sample?.tokensPerWallClockHour ?? null)}<small>/h</small></strong><div class="metric-sub">${inCycle ? '按重置后已过时长计算' : '按实际区间时长计算'}</div></article></div>
    <div class="breakdown"><span>输入 <b>${tokens(input)}</b></span><span>缓存输入 <b>${tokens(cached)}</b></span><span>缓存写入 <b>${tokens(sample?.cacheCreationInputTokens ?? null)}</b></span><span>输出 <b>${tokens(sample?.outputTokens ?? null)}</b></span><span>思考 <b>${tokens(sample?.reasoningOutputTokens ?? null)}</b></span></div>
    ${cycleNote}<div class="sample-note">${inCycle ? '本机记录' : `${time(sample?.start ?? null)} → ${time(sample?.end ?? null)}（新加坡时间）`} · 有效响应 ${sample?.validResponses ?? '—'}${sample?.status === 'partial' ? ` · 缺失 usage ${sample.turnsWithoutUsage ?? '—'} · 无效响应 ${sample.invalidResponses ?? '—'}${sample.recordGaps ? ' · 存在文件缺口' : ''}` : ''}</div></section>${inCycle ? quotaModels(account, cycle, accounts) : ''}`;
}
