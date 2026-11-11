/** Splits one quota cycle by model and estimates what the same quota would hold on a single model.
 * Quota burn is taken as API-equivalent cost times a per-model burn factor measured from the accounts' own windows;
 * the providers publish no formula, so every number here is an estimate. */
import type { AccountReport } from '../report.ts';
import { coverageBadge, escape, percent, quotaName, tokens, usd } from './format.ts';
import { estimate, rateFor, rates } from './pricing.ts';

type QuotaWindow = AccountReport['windows'][number];
type Capacity = { usdPerMillion: number | null; fullTokens: number | null; remainingTokens: number | null; ratio: number | null };
type Factor = { factor: number; windows: number; low: number; high: number; from?: string };
export type Calibration = { base: string | null; factors: Map<string, Factor> };
/** Models always offered as a what-if, beside every single-tier model the cycle actually used. */
const referenceModels: Record<string, string[]> = {
  Claude: ['claude-opus-5-5', 'claude-fable-5-2'],
  Codex: ['gpt-6.1-sol'],
  Gemini: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash'],
};
const minimumPoints = 3, baseShare = 0.95, modelShare = 0.3;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const family = (model: string) => model.replace(/(-\d+)+$/, '');

function priced(window: QuotaWindow) {
  const models = window.cycle?.models ?? [];
  const costs = models.map(row => ({ model: rateFor(row.model)?.model ?? row.model ?? 'unknown', row, cost: estimate(row, rateFor(row.model))?.cost ?? null }));
  return { costs, complete: costs.length > 0 && costs.every(item => item.cost !== null) };
}

/** Burn factor of each model against the provider's dominant model: windows almost entirely on that model give the
 * dollars behind one point per window length, and windows with a real share of another model give its factor. */
export function calibrate(accounts: AccountReport[], provider: AccountReport['provider']): Calibration {
  const windows = accounts.filter(account => account.provider === provider).flatMap(account => account.windows)
    .filter(window => !window.scoped && window.minutes && (window.usedPercent ?? 0) >= minimumPoints)
    .map(window => ({ window, ...priced(window) })).filter(item => item.complete)
    .map(item => ({ minutes: item.window.minutes!, used: item.window.usedPercent!, costs: item.costs,
      spent: item.costs.reduce((sum, cost) => sum + cost.cost!, 0) })).filter(item => item.spent > 0);
  const totals = new Map<string, number>();
  for (const item of windows) for (const cost of item.costs) totals.set(cost.model, (totals.get(cost.model) ?? 0) + cost.cost!);
  const base = [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const share = (item: typeof windows[number], model: string) => item.costs.filter(cost => cost.model === model).reduce((sum, cost) => sum + cost.cost!, 0) / item.spent;
  const perPoint = new Map<number, number>();
  for (const minutes of new Set(windows.map(item => item.minutes))) {
    const pure = windows.filter(item => item.minutes === minutes && base !== null && share(item, base) >= baseShare);
    if (pure.length) perPoint.set(minutes, median(pure.map(item => item.spent / item.used)));
  }
  const factors = new Map<string, Factor>();
  for (const model of totals.keys()) {
    if (model === base) continue;
    const values = windows.filter(item => perPoint.has(item.minutes) && share(item, model) >= modelShare).map(item => {
      const own = share(item, model) * item.spent;
      return (item.used * perPoint.get(item.minutes)! - (item.spent - own)) / own;
    }).filter(value => value > 0.2 && value < 10);
    if (values.length >= 2) factors.set(model, { factor: median(values), windows: values.length, low: Math.min(...values), high: Math.max(...values) });
  }
  return { base, factors };
}

function factorFor(model: string, calibration: Calibration): Factor | null {
  if (model === calibration.base) return { factor: 1, windows: 0, low: 1, high: 1 };
  const own = calibration.factors.get(model);
  if (own) return own;
  const relative = [...calibration.factors].find(([other]) => family(other) === family(model));
  return relative ? { ...relative[1], from: relative[0] } : null;
}

export function cycleModelEstimate(window: QuotaWindow, provider: AccountReport['provider'], calibration: Calibration = { base: null, factors: new Map() }) {
  const cycle = window.cycle;
  if (!cycle?.models?.length || cycle.totalTokens === null || cycle.totalTokens <= 0) return null;
  const used = window.usedPercent, remaining = window.remainingPercent, total = cycle.totalTokens;
  const { costs } = priced(window);
  const burn = (model: string, cost: number | null) => cost === null ? null : cost * (factorFor(model, calibration)?.factor ?? 1);
  const unpriced = costs.filter(item => item.cost === null).map(item => item.model);
  const unrated = unpriced.filter(model => !rateFor(model));
  const spent = unpriced.length ? null : costs.reduce((sum, item) => sum + item.cost!, 0);
  const burned = unpriced.length ? null : costs.reduce((sum, item) => sum + burn(item.model, item.cost)!, 0);
  // Burn-weighted dollars behind one percentage point of this window, from this cycle's own records.
  const perPoint = burned !== null && used !== null && used > 0 ? burned / used : null;
  const capacity = (cost: number | null, weighted: number | null): Capacity => {
    const full = weighted !== null && weighted > 0 && perPoint !== null ? perPoint * 100 / weighted * total : null;
    return { usdPerMillion: cost === null ? null : cost / total * 1e6, fullTokens: full,
      remainingTokens: full !== null && remaining !== null ? full * remaining / 100 : null,
      ratio: weighted !== null && weighted > 0 && burned !== null ? burned / weighted : null };
  };
  const usedModels = new Set(costs.map(item => item.model));
  const candidates = window.scoped ? [] : rates.filter(rate => rate.provider === provider
    && (referenceModels[provider]?.includes(rate.model) || (usedModels.has(rate.model) && !rate.long)));
  return { used, remaining, total, spent, perPoint, unpriced, unrated,
    actual: costs.map(item => ({ model: item.model, status: item.row.status, totalTokens: item.row.totalTokens,
      outputTokens: item.row.outputTokens, cost: item.cost, factor: factorFor(item.model, calibration),
      points: item.cost !== null && perPoint ? burn(item.model, item.cost)! / perPoint : null })),
    mix: capacity(spent, burned),
    // The whole cycle's token mix repriced at one model's rates, then weighted by that model's burn factor.
    single: candidates.map(rate => {
      const cost = estimate({ ...cycle, model: rate.model }, rate)?.cost ?? null;
      return { model: rate.model, factor: factorFor(rate.model, calibration), ...capacity(cost, burn(rate.model, cost)) };
    }) };
}

const times = (value: number | null) => value === null ? '—' : `${value >= 10 ? value.toFixed(0) : value.toFixed(2)}×`;
const points = (value: number | null) => value === null ? '—' : value > 0 && value < 0.1 ? '<0.1%' : percent(value);
function factorCell(factor: Factor | null) {
  if (!factor) return '1×<span class="row-note">未校准 · 按 API 单价比例</span>';
  if (!factor.windows) return '1×<span class="row-note">基准模型</span>';
  return `${factor.factor.toFixed(2)}×<span class="row-note">${factor.from ? `沿用 ${escape(factor.from)}` : `实测 ${factor.windows} 个窗口`} · ${factor.low.toFixed(2)}–${factor.high.toFixed(2)}</span>`;
}

export function quotaModels(account: AccountReport, window: QuotaWindow | undefined, accounts: AccountReport[] = [account]) {
  const calibration = calibrate(accounts, account.provider);
  const result = window && cycleModelEstimate(window, account.provider, calibration);
  if (!window || !result) return '';
  const name = escape(quotaName(window));
  const capacityCells = (row: Capacity) =>
    `<td>${usd(row.usdPerMillion)}</td><td class="accent">${tokens(row.fullTokens)}</td><td class="accent">${tokens(row.remainingTokens)}</td><td>${times(row.ratio)}</td>`;
  const unavailable = result.unrated.length ? `未核对单价：${escape(result.unrated.join('、'))}，暂不估算额度。`
    : result.unpriced.length ? `本机记录缺少计价所需的拆分计数：${escape(result.unpriced.join('、'))}，暂不估算额度。`
    : result.perPoint === null ? '已用额度为 0% 或缺少读数，暂不估算额度。' : '';
  const scopedWindows = account.windows.filter(row => row.scoped && row.model && row !== window);
  const what = result.single.length ? `<div class="comparison-label">同样的 ${name}，整个周期只用一个模型能跑多少 token</div>
    <div class="table-scroll"><table><thead><tr><th>模型</th><th>额度燃烧系数</th><th>混合单价 / 百万 token</th><th>满额约可用</th><th>剩余 ${percent(result.remaining)} 约可用</th><th>相对当前组合</th></tr></thead><tbody>
      <tr><td>当前组合（实际）</td><td>—</td>${capacityCells(result.mix)}</tr>${result.single.map(row =>
      `<tr data-quota-model="${escape(row.model)}"><td><span class="model-dot"></span>${escape(row.model)}</td><td>${factorCell(row.factor)}</td>${capacityCells(row)}</tr>`).join('')}</tbody></table></div>` : '';
  return `<section class="panel" id="quota-models"><div class="panel-title"><h2>按模型估算额度 · ${name}</h2><span>ESTIMATE / CALIBRATED</span></div>
    <div class="comparison-label">本周期各模型消耗 · 已用 ${percent(result.used)} ≈ API 等价 ${usd(result.spent)}</div>
    <div class="table-scroll"><table><thead><tr><th>模型</th><th>周期 token</th><th>输出</th><th>API 等价</th><th>额度燃烧系数</th><th>约占额度</th></tr></thead><tbody>${result.actual.map(row =>
      `<tr><td><span class="model-dot"></span>${escape(row.model)}${coverageBadge(row.status)}</td><td>${tokens(row.totalTokens)}</td><td>${tokens(row.outputTokens)}</td><td>${usd(row.cost)}</td><td>${factorCell(row.factor)}</td><td class="accent">${points(row.points)}</td></tr>`).join('')}</tbody></table></div>
    ${what}${unavailable ? `<p class="table-note">${unavailable}</p>` : ''}
    ${scopedWindows.map(row => `<p class="table-note">服务端另有独立的「${escape(quotaName(row))}」：已用 ${percent(row.usedPercent)}，重置周期相同。它只统计该模型，与上面的总额度同时生效，先到先限。</p>`).join('')}
    <p class="table-note">额度燃烧系数 = 同样的 API 等价费用，该模型消耗的额度是基准模型（${escape(calibration.base ?? '暂无')}）的多少倍；由各账号额度窗口的实测读数反推，样本不足时按 1× 并标注未校准。</p>
    <p class="table-note">单模型一行把本周期全部 token 的输入、缓存读写、输出结构按该模型官方单价重新计价，再乘以燃烧系数。官方未公布换算公式，全部为估算。</p>
    <p class="table-note">已用额度是整数百分比，并包含其他设备的用量；已用越少，误差越大。token 只含本机记录。未计 Fast 附加费。</p></section>`;
}
