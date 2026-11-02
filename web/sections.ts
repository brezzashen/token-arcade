/** Aggregate comparison and forecast sections; local record coverage remains explicit. */
import type { AccountReport } from '../report.ts';
import { coverageBadge, escape, percent, quotaName, scopes, time, tokens } from './format.ts';
import type { SpeedSnapshot } from './output-speed.ts';
import { intervalSpeed } from './interval-speed.ts';
const calibration: Record<string, string> = {
  insufficient_quota_snapshots: '当前周期采样不足', no_active_time: '没有活动记录',
  insufficient_active_time: '活动记录不足 15 分钟', insufficient_quota_delta: '区间额度消耗不足',
  expired_reset: '重置时间已过', regressed_live_usage: '服务端读数回退',
};

export function comparison(account: AccountReport, speed?: SpeedSnapshot) {
  return `<details class="panel comparison" id="interval-comparison"><summary class="panel-title"><h2>区间对比</h2><span>1H / 3H / 5H / 24H <b>+</b></span></summary>
    <div class="comparison-label">真实对话平均输出速度 · ${escape(account.label)}</div><div id="interval-speed">${intervalSpeed(account.alias, speed)}</div>
    <div class="comparison-label">区间 token 消耗</div>
    <div class="table-scroll"><table><thead><tr><th>区间</th><th>记录 token</th><th>输入</th><th>缓存输入</th><th>输出</th><th>思考</th><th>token / 小时</th></tr></thead><tbody>${account.samples.map(row =>
      `<tr><td>${escape(scopes[row.id ?? ''] ?? row.id)}${coverageBadge(row.status)}</td><td class="accent">${tokens(row.totalTokens)}</td><td>${tokens(row.inputTokens)}</td><td>${tokens(row.cachedInputTokens)}</td><td>${tokens(row.outputTokens)}</td><td>${tokens(row.reasoningOutputTokens)}</td><td>${tokens(row.tokensPerWallClockHour)}</td></tr>`).join('')}</tbody></table></div>
    <p class="table-note">区间可能重叠，不能相加。每小时消耗按实际区间计算。</p></details>`;
}

export function forecast(account: AccountReport) {
  if (!account.forecasts.length) return '';
  return `<details class="panel comparison" id="quota-forecast"><summary class="panel-title"><h2>预计剩余开发时间</h2><span>WORKLOAD ESTIMATE <b>+</b></span></summary>
    <div class="table-scroll"><table><thead><tr><th>采样区间</th><th>预计剩余时间</th><th>区间额度消耗</th><th>实际采样时间</th></tr></thead><tbody>${account.forecasts.map(row =>
      `<tr><td>${escape(row.id === 'today' ? '今天' : scopes[row.id ?? ''] ?? row.id)}</td><td>${escape(row.text?.replace(/^预计剩余开发时间：/, '') ?? '暂无可靠估计')}<span class="row-note">${escape(row.windows.map(window => calibration[window.reason ?? ''] ?? (window.extended ? '采样区间已延长' : '')).filter(Boolean).join(' · '))}</span></td><td>${row.windows.map(window => `<span class="row-note">${escape(window.name)} · ${percent(window.delta)}</span>`).join('') || '—'}</td><td>${row.windows.map(window => `<span class="row-note">${time(window.start)} → ${time(window.end)}</span>`).join('') || '—'}</td></tr>`).join('')}</tbody></table></div>
    <p class="table-note">按最近工作负载估算活动开发时间。不是日历时间，也不是固定 token 额度。</p></details>`;
}

export function cycles(account: AccountReport) {
  const rows = account.windows.filter(row => row.cycle);
  if (!rows.length) return '';
  return `<section class="panel" id="cycle-totals"><div class="panel-title"><h2>重置周期累计</h2><span>CURRENT CYCLE / LOCAL</span></div><div class="table-scroll"><table><thead><tr><th>额度窗口</th><th>周期开始</th><th>已用额度</th><th>本机 token</th><th>输出</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(quotaName(row))}${coverageBadge(row.cycle!.status)}</td><td>${time(row.cycle!.start)}</td><td>${percent(row.usedPercent)}</td><td>${tokens(row.cycle!.totalTokens)}</td><td>${tokens(row.cycle!.outputTokens)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
