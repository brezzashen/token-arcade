/** Historical generation rates use server aggregates and never infer speed from token consumption. */
import { escape, time } from './format.ts';
import { accountProvider, providerOf, type SpeedSnapshot } from './output-speed.ts';
import { providerLogo, providerName } from './provider.ts';

type HistoryProvider = ReturnType<typeof accountProvider>;
function filterIdentity(value: string, kind: 'account' | 'model') {
  if (value === 'all') return `<span class="history-filter-brands" aria-hidden="true">${(['Claude', 'Codex', 'Gemini'] as const).map(providerLogo).join('')}</span><span class="history-filter-text"><b>全部${kind === 'account' ? '账号' : '模型'}</b></span>`;
  const provider: HistoryProvider = kind === 'account' ? accountProvider(value) : providerOf(value);
  return `${provider ? `<span aria-hidden="true">${providerLogo(provider)}</span>` : '<span class="history-filter-unknown" aria-hidden="true">?</span>'}<span class="history-filter-text"><b>${escape(value)}</b>${kind === 'account' && provider ? `<small>${providerName(provider)}</small>` : ''}</span>`;
}
function historyFilter(kind: 'account' | 'model', values: string[], selected: string) {
  const label = kind === 'account' ? '账号' : '模型';
  const options = [...new Set(['all', ...values, selected])];
  return `<div class="history-filter" data-history-filter="${kind}"><span class="history-filter-label" id="history-${kind}-label">${label}</span>
    <button type="button" class="history-filter-trigger" data-speed-filter="${kind}" title="${escape(selected === 'all' ? `全部${label}` : selected)}" aria-labelledby="history-${kind}-label history-${kind}-value" aria-haspopup="listbox" aria-expanded="false" aria-controls="history-${kind}-options">
      <span class="history-filter-value" id="history-${kind}-value">${filterIdentity(selected, kind)}</span><span class="history-filter-chevron" aria-hidden="true"></span></button>
    <div class="history-filter-options" id="history-${kind}-options" role="listbox" aria-label="历史速度${label}" hidden>${options.map(value =>
      `<button type="button" role="option" tabindex="-1" data-speed-${kind}="${escape(value)}" aria-selected="${value === selected}" title="${escape(value === 'all' ? `全部${label}` : value)}">${filterIdentity(value, kind)}<span class="history-filter-check" aria-hidden="true">${value === selected ? '✓' : ''}</span></button>`).join('')}</div></div>`;
}

export const historyWindows = [
  { id: 'last_hour', label: '过去 1 小时' },
  { id: 'last_three_days', label: '过去 3 天' },
  { id: 'last_seven_days', label: '过去 7 天' },
] as const;
export const historySorts = [
  { id: 'default', label: '默认' },
  { id: 'fastest', label: '最快' },
  { id: 'slowest', label: '最慢' },
] as const;
export function speedHistory(snapshot: SpeedSnapshot, windowId = 'last_hour', account = 'all', model = 'all', sort = 'default') {
  const selected = historyWindows.find(window => window.id === windowId) ?? historyWindows[0];
  const interval = snapshot.intervals?.find(interval => interval.id === selected.id);
  const recorded = [...snapshot.samples, ...(snapshot.intervals ?? []).flatMap(interval => interval.samples)];
  const accounts = [...new Set([...(snapshot.accounts ?? []), ...recorded.map(row => row.account)])]
    .filter(value => value !== 'grok');
  const models = [...new Set(recorded.map(row => row.model))].sort((a, b) =>
    providerOf(a).localeCompare(providerOf(b)) || a.localeCompare(b));
  const order = ['ultrafast', 'fast', 'standard', 'vertex', 'subscription', 'unknown'];
  const samples = (interval?.samples ?? []).filter(row => (account === 'all' || row.account === account)
    && (model === 'all' || row.model === model))
    .sort((a, b) => {
      if (!snapshot.stale && (sort === 'fastest' || sort === 'slowest')) {
        const aRate = Number.isFinite(a.tokensPerSecond) ? a.tokensPerSecond : null;
        const bRate = Number.isFinite(b.tokensPerSecond) ? b.tokensPerSecond : null;
        if (aRate === null && bRate !== null) return 1;
        if (aRate !== null && bRate === null) return -1;
        if (aRate !== null && bRate !== null && aRate !== bRate) {
          return sort === 'fastest' ? bRate - aRate : aRate - bRate;
        }
      }
      return a.account.localeCompare(b.account) || a.model.localeCompare(b.model)
        || order.indexOf(a.mode ?? 'unknown') - order.indexOf(b.mode ?? 'unknown');
    });
  const rate = (value?: number | null) => !snapshot.stale && value != null ? `≈${value.toFixed(1)}` : '—';
  const modes: Record<string, string> = { ultrafast: 'Ultrafast', fast: 'Fast', standard: 'Standard', vertex: 'Vertex', subscription: '订阅' };
  const rows = samples.map(row => {
    const provider = accountProvider(row.account) || providerOf(row.model);
    return `<tr><td><span class="account-identity">${provider ? providerLogo(provider) : ''}<span>${escape(row.account)}</span></span></td><td class="history-model">${escape(row.model)}</td>
    <td><span class="history-mode ${row.mode === 'ultrafast' ? 'is-ultrafast' : ''}">${modes[row.mode ?? ''] ?? '模式未知'}</span></td>
    <td>${rate(row.reasoningTokensPerSecond)}</td><td>${rate(row.outputTokensPerSecond)}</td>
    <td class="history-rate">${rate(row.tokensPerSecond)}</td><td>${row.conversationCount ?? 0} / ${row.sampleCount ?? 0}
    ${row.excludedSamples ? `<span class="row-note">排除 ${row.excludedSamples} 段</span>` : ''}</td><td>${time(row.sampledAt)}</td></tr>`;
  }).join('');
  return `<section class="panel speed-history" aria-labelledby="speed-history-title">
    <div class="panel-title"><h2 id="speed-history-title">历史速度</h2><span>按账号 / 模型 / 模式统计 · token/s</span></div>
    <div class="history-toolbar"><div class="history-left"><div class="history-windows" role="group" aria-label="历史速度区间">${historyWindows.map(window =>
      `<button type="button" data-speed-window="${window.id}" aria-pressed="${window.id === selected.id}">${window.label}</button>`).join('')}</div>
    <div class="history-sorts" role="group" aria-label="按合并速度排序">${historySorts.map(option =>
      `<button type="button" data-speed-sort="${option.id}" aria-pressed="${option.id === sort}" title="${option.id === 'default' ? '按账号、模型和模式排列' : `按合并 token/s ${option.id === 'fastest' ? '从高到低' : '从低到高'}排列`}">${option.label}</button>`).join('')}</div></div>
    <div class="history-filters" role="group" aria-label="历史速度筛选">${historyFilter('account', accounts, account)}${historyFilter('model', models, model)}</div></div>
    <div class="history-range">${interval ? `${time(interval.start)} → ${time(interval.end)} · 新加坡时间` : '正在读取历史记录…'}${snapshot.stale ? ' · 采集连接中断' : ''}</div>
    <div class="history-scroll-hint">左右滑动查看全部指标 →</div>
    <div class="table-scroll"><table class="history-table"><thead><tr><th>账号</th><th>模型</th><th>模式</th><th>思考 token/s</th><th>输出 token/s</th><th>合并 token/s</th><th>对话 / 有效采样</th><th>最近采样</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="empty">${snapshot.stale ? '采集连接中断，历史速度暂不可用' : account !== 'all' || model !== 'all' ? '当前账号、模型和区间下暂无有效对话测速记录，可切换筛选查看' : '该区间暂无有效对话测速记录'}</td></tr>`}</tbody></table></div>
    <p class="table-note">均值 = 有效生成 token 总数 ÷ 有效生成时长。各模式独立统计。Claude 整段回复（含思考）与 Gemini 整段响应（含首字等待）计入合并列。无记录显示 —。历史来自本机已有记录。</p></section>`;
}
