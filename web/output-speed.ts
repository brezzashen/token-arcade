/** First-screen cards show each account's most recently used model with its rolling conversation-weighted rates and sample coverage. */
import { escape, time } from './format.ts';
import { normalizeMode } from '../speed-policy.ts';
export type SpeedSample = { model: string; account: string; source: string; status: string; reason: string | null;
  mode?: string; speedBasis?: string;
  sampleCount?: number; conversationCount?: number; outputSampleCount?: number; reasoningSampleCount?: number; excludedSamples?: number;
  responseSampleCount?: number; responseTokensPerSecond?: number | null;
  outputTokensPerSecond?: number | null; reasoningTokensPerSecond?: number | null;
  sampledAt: string; updatedAt: string; tokensPerSecond: number | null; estimatedTokens: number; measuredTokens: number;
  outputMs: number | null; firstTextMs: number | null };
export type SpeedInterval = { id: string; windowMs: number; start: string; end: string; samples: SpeedSample[] };
export type SpeedSnapshot = { samples: SpeedSample[]; nextFallbackAt: number | null; stale: boolean; fallbackEnabled?: boolean;
  intervals?: SpeedInterval[]; accounts?: string[] };
// One card per local account in registry order, then other recorded accounts by name. Each card follows the model the
// account answered with most recently; speed never moves a card. Grok has no local conversation records.
const defaultAccounts = ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2', 'ag1', 'ag2'];
const rateCells = (cells: [string, number | null | undefined, string][]) => `<div class="speed-primary${cells.length === 1 ? ' is-single' : ''}">${cells
  .map(([label, value, unit]) => `<div><span>${label}</span><strong>${typeof value === 'number' ? value.toFixed(1) : '—'}</strong><small>${unit}</small></div>`).join('')}</div>`;
const primaryRates = (reasoning?: number | null, output?: number | null) => rateCells([['思考', reasoning, 'token/s'], ['输出', output, 'token/s']]);
// Claude records time only the whole response, so its card shows one whole-response rate and no thinking cell.
const responseRates = (response?: number | null) => rateCells([['整段输出', response, '含思考 · token/s']]);
// Speed numbers take the provider brand color: Claude models orange-red, GPT models white, Gemini models blue.
export const providerOf = (model: string): 'Claude' | 'Codex' | 'Gemini' | '' =>
  model.startsWith('claude') ? 'Claude' : model.startsWith('gpt') ? 'Codex' : model.startsWith('gemini') ? 'Gemini' : '';
export const accountProvider = (account: string): 'Claude' | 'Codex' | 'Gemini' | '' =>
  account.startsWith('cc') ? 'Claude' : account.startsWith('co') ? 'Codex' : account.startsWith('ag') || account.startsWith('gm') ? 'Gemini' : '';
const windowLabels: Record<string, [string, string]> = {
  last_hour: ['最近 1 小时均值', '近 1 小时'],
  last_three_hours: ['最近 3 小时均值', '近 3 小时'],
  last_five_hours: ['最近 5 小时均值', '近 5 小时'],
  last_24_hours: ['最近 24 小时均值', '近 24 小时'],
  last_three_days: ['过去 3 天均值', '过去 3 天'],
  last_seven_days: ['过去 7 天均值', '过去 7 天'],
};
export function outputSpeed(snapshot: SpeedSnapshot, now = Date.now()) {
  const availableIn = (windowMs: number) => (row: SpeedSample) => !snapshot.stale
    && now - Date.parse(row.sampledAt) <= windowMs && row.tokensPerSecond !== null;
  const available1h = availableIn(3600_000);
  const live1h = (row: SpeedSample) => !snapshot.stale && now - Date.parse(row.sampledAt) <= 3600_000
    && ['streaming', 'waiting'].includes(row.status);
  const rows = [...snapshot.samples].sort((a, b) => Number(available1h(b)) - Number(available1h(a))
    || Number(b.source === 'task') - Number(a.source === 'task')
    || Date.parse(b.sampledAt) - Date.parse(a.sampledAt));
  const intervalAccounts = (snapshot.intervals ?? []).flatMap(interval => interval.samples.map(row => row.account));
  const accounts = [...(snapshot.accounts ?? defaultAccounts).filter(account => account !== 'grok'),
    ...[...new Set([...rows.map(row => row.account), ...intervalAccounts])]
      .filter(account => account !== 'grok' && !(snapshot.accounts ?? defaultAccounts).includes(account)).sort()];
  const modeLabel = (mode: string) => mode === 'fast' ? 'Fast 开启' : mode === 'standard' ? 'Fast 未开启 · Standard'
    : mode === 'ultrafast' ? 'Ultrafast 开启' : mode === 'vertex' ? 'Vertex' : mode === 'subscription' ? '订阅' : 'Fast 状态未知';
  const cards = accounts.map(account => {
    const owned1h = rows.filter(row => row.account === account);
    const historical = owned1h.some(row => available1h(row) || live1h(row)) ? undefined
      : (snapshot.intervals ?? []).find(interval => interval.id !== 'last_hour'
        && interval.samples.some(row => row.account === account && availableIn(interval.windowMs)(row)));
    const windowMs = historical?.windowMs ?? 3600_000;
    const [meanLabel, rangeLabel] = windowLabels[historical?.id ?? 'last_hour'] ?? ['历史均值', '历史区间'];
    const available = availableIn(windowMs);
    const owned = historical ? historical.samples.filter(row => row.account === account) : owned1h;
    const latest = [...owned].sort((a, b) => Number(available(b)) - Number(available(a))
      || Number(b.source === 'task') - Number(a.source === 'task')
      || Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0];
    const isGemini = accountProvider(account) === 'Gemini';
    if (!latest) return `<article class="speed-card" data-provider="${accountProvider(account)}"><div class="speed-meta"><span>${escape(account)} · 正在用</span></div><h3>${snapshot.stale ? '采集连接中断' : '近 1 小时无对话'}</h3><div class="speed-mode">${account === 'ag2' || account === 'gm2' ? 'Vertex AI 按量计费' : isGemini ? 'Google AI Ultra 订阅' : 'Fast 状态未知'}</div>${isGemini ? rateCells([['整段响应', null, '含首字等待 · token/s']]) : primaryRates()}<div class="speed-detail">${snapshot.stale ? '正在恢复采集，暂时无法判断对话状态' : '没有有效对话数据'}${snapshot.fallbackEnabled ? ' · 等待兜底' : ' · 自动测速已关闭'}</div></article>`;
    const model = latest.model, group = owned.filter(row => row.model === model);
    const row = normalizeMode(latest.mode) !== 'unknown' ? latest
      : group.find(row => row.source === 'task' && available(row) && normalizeMode(row.mode) !== 'unknown') ?? latest;
    const others = [...new Set(owned.map(row => row.model))].filter(other => other !== model).sort().map(other => {
      const sample = owned.filter(row => row.model === other).find(available);
      return `<div><span>${escape(other)}</span><b>${sample ? `≈${sample.tokensPerSecond!.toFixed(1)} token/s` : '—'}</b></div>`;
    }).join('');
    const expired = now - Date.parse(row.sampledAt) > windowMs;
    const live = !snapshot.stale && !expired && ['streaming', 'waiting'].includes(row.status);
    const mode = normalizeMode(row.mode);
    const state = snapshot.stale ? '采集连接中断' : expired ? '采样已过期' : row.status === 'streaming' ? '正在输出'
      : row.status === 'waiting' ? '等待首字' : row.status === 'unavailable' ? '缺少有效时间记录'
      : row.source === 'task' ? meanLabel : row.status === 'sampled' ? '兜底测速采样' : '测速暂不可用';
    const rate = (value: number | null | undefined) => available(row) && value != null ? `≈${value.toFixed(1)}` : '—';
    const geminiPool = isGemini
      ? (historical ? historical.samples : rows).filter(item => accountProvider(item.account) === 'Gemini' && item.model === model) : group;
    return `<article class="speed-card ${live ? 'is-streaming' : ''}" data-provider="${providerOf(model)}"><div class="speed-meta"><span>${escape(account)} · ${row.source === 'task' ? '正在用' : '兜底测速'}</span><span class="speed-state">${state}</span></div>
      <h3>${escape(row.model)}</h3><div class="speed-mode ${mode === 'fast' ? 'is-fast' : ''}">${modeLabel(mode)}<span>${mode === 'unknown' ? '缺少模式记录' : row.speedBasis === 'response' ? '响应记录' : row.speedBasis === 'mixed' ? '混合记录' : '请求配置'}</span></div>
      ${row.responseSampleCount ? isGemini ? rateCells([['整段响应', available(row) ? row.responseTokensPerSecond : null, '含首字等待 · token/s']]) : responseRates(available(row) ? row.responseTokensPerSecond : null)
        : primaryRates(available(row) ? row.reasoningTokensPerSecond : null, available(row) ? row.outputTokensPerSecond : null)}
      <div class="speed-mean"><span>合并均值</span><b>${rate(row.tokensPerSecond)}</b><small>token/s</small></div>
      <div class="speed-detail">${row.source === 'task' ? row.status === 'unavailable' ? '已有对话 · 缺少有效生成时间' : `${row.conversationCount ?? 0} 个对话 · ${row.sampleCount ?? 0} 个有效采样` : '兜底测速采样'}
      ${row.outputMs !== null ? `<br>${row.measuredTokens} token / ${(row.outputMs / 1000).toFixed(2)}s 生成` : ''}
      ${row.sampleCount !== undefined ? `<br>${row.responseSampleCount ? `整段回复 ${row.responseSampleCount} 段` : `思考 ${row.reasoningSampleCount ?? 0} 段 · 输出 ${row.outputSampleCount ?? 0} 段`}${row.excludedSamples ? ` · 排除 ${row.excludedSamples} 段` : ''}` : ''}</div>
      <div class="speed-time">${time(row.sampledAt)}${row.firstTextMs !== null ? ` · 首字 ${(row.firstTextMs / 1000).toFixed(1)}s` : ''}</div>
      <div class="speed-comparison"><div class="speed-comparison-title">模式对比 · ${rangeLabel}</div>${(accountProvider(account) === 'Codex' ? ['ultrafast', 'fast', 'standard'] : accountProvider(account) === 'Gemini' ? ['vertex', 'subscription'] : ['fast', 'standard']).map(comparisonMode => {
        const sample = geminiPool.find(sample => normalizeMode(sample.mode) === comparisonMode);
        const value = sample && available(sample) ? `≈${sample.tokensPerSecond!.toFixed(1)} token/s` : '—';
        const source = !sample || sample.status === 'unavailable' ? '暂无有效对话数据' : snapshot.stale ? '连接中断'
          : now - Date.parse(sample.sampledAt) > windowMs ? '采样过期' : sample.status === 'streaming' ? '正在输出'
          : sample.status === 'waiting' ? '等待首字' : sample.source === 'task' ? `${sample.conversationCount ?? 0} 对话 / ${sample.sampleCount ?? 0} 采样` : '兜底测速';
        return `<div class="speed-comparison-row ${comparisonMode === mode ? 'is-current' : ''}"><span>${comparisonMode === 'ultrafast' ? 'Ultrafast' : comparisonMode === 'fast' ? 'Fast' : comparisonMode === 'vertex' ? 'Vertex' : comparisonMode === 'subscription' ? '订阅' : 'Standard'}${comparisonMode === mode ? '<i>当前</i>' : ''}</span><b>${value}</b><small>${source}</small></div>`;
      }).join('')}</div>${others ? `<div class="speed-others"><span>${rangeLabel}其他模型</span>${others}</div>` : ''}</article>`;
  }).join('');
  return `<section class="panel output-speed"><div class="panel-title"><h2>各账号当前输出速度</h2><span>最近 1 小时 / 历史回退 · ${snapshot.fallbackEnabled ? '无有效数据才兜底' : '自动测速已关闭'}</span></div><div class="speed-grid">${cards}</div>
    <p class="table-note speed-note">总 token ÷ 总生成时长 · 思考使用记录计数，输出分词估算 · Claude 按整段回复计（含思考，记录无法拆分） · Gemini 按整段响应计（含首字等待） · 仅计完整生成段 · 工具等待不计 · 每 2 秒采集
    <span>${snapshot.fallbackEnabled && snapshot.nextFallbackAt ? `下次兜底 ${time(new Date(snapshot.nextFallbackAt).toISOString())}` : '仅采集已有对话 · 不主动调用模型'}</span></p></section>`;
}
