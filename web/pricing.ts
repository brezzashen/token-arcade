/** Dated official standard API rates, exact local-record API equivalents and subscription discounts against a 30-day projection. */
import type { AccountReport, Alias } from '../report.ts';
import { coverageBadge, escape, percent } from './format.ts';
import { providerLogo, providerName } from './provider.ts';
import { geminiSubscriptionPlan, geminiVertexPlan } from '../subscription.ts';

type Rate = { model: string; provider: AccountReport['provider']; input: number; cached: number;
  write: number | null; writeHour: number | null; output: number; long?: { input: number; cached: number; write: number; output: number };
  source: string };
const claudeSource = 'https://platform.claude.com/docs/en/about-claude/pricing';
const openaiSource = 'https://developers.openai.com/api/docs/pricing';
const grokSource = 'https://docs.x.ai/developers/pricing';
// Official Google Vertex AI Generative AI pricing: https://cloud.google.com/vertex-ai/generative-ai/pricing
// Checked on 2026-10-14: the page lists Gemini 2.5 and Gemini 3 preview rates only and does not publish
// per-token prices for `gemini-4-argon` or `gemini-3.8-flash`, so their estimated USD cost remains null.
export const geminiSource = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
export const checkedAt = '2026-10-07';
export const rates: Rate[] = [
  { model: 'claude-opus-5-5', provider: 'Claude', input: 4, cached: .2, write: 5, writeHour: 8, output: 20, source: claudeSource },
  { model: 'claude-opus-5', provider: 'Claude', input: 5, cached: .5, write: 6.25, writeHour: 10, output: 25, source: claudeSource },
  { model: 'claude-haiku-4-5', provider: 'Claude', input: 1, cached: .1, write: 1.25, writeHour: 2, output: 5, source: claudeSource },
  { model: 'gpt-6.1-sol', provider: 'Codex', input: 2, cached: .1, write: 2.5, writeHour: null, output: 10,
    long: { input: 4, cached: .2, write: 5, output: 15 }, source: openaiSource },
  { model: 'grok-build-0.1', provider: 'Grok', input: 1, cached: .2, write: null, writeHour: null, output: 2,
    long: { input: 2, cached: .4, write: 0, output: 4 }, source: grokSource },
];
export const rateFor = (model: string | null) => rates.find(rate => rate.model === model?.replace(/-\d{8}$/, ''));
/** Confirmed monthly fees; an unknown subscription fee is not pay-as-you-go or zero. */
export const subscriptions: Record<Alias, { plan: string; monthlyUsd: number | null }> = {
  cc1: { plan: 'Claude Team Premium', monthlyUsd: 125 }, cc2: { plan: 'Claude Team Premium', monthlyUsd: 125 },
  cc3: { plan: 'Claude Team Premium', monthlyUsd: 125 }, cc4: { plan: 'Claude Team Premium', monthlyUsd: 125 },
  cc5: { plan: 'Claude Team Premium', monthlyUsd: 125 },
  co1: { plan: 'ChatGPT Pro 500', monthlyUsd: 500 }, co2: { plan: 'ChatGPT Pro 200', monthlyUsd: 200 },
  grok: { plan: 'SuperGrok', monthlyUsd: 30 },
  ag1: { plan: geminiSubscriptionPlan, monthlyUsd: null },
  ag2: { plan: geminiVertexPlan, monthlyUsd: null },
};
export const projectionDays = 30;
const amount = (value: number | null) => value === null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const folds = (value: number | null) => value === null ? '—' : `${(value / 10).toFixed(2)} 折`;

type Model = AccountReport['models'][number];
type Part = { input: number; cached: number; write: number; write1h: number; output: number };
type Price = { input: number; cached: number; write: number; writeHour: number; output: number };

function part(input: number | null, cached: number | null, write: number | null, write1h: number | null, output: number | null): Part | null {
  if ([input, cached, write, write1h, output].some(v => v === null || v < 0)) return null;
  const p = { input: input!, cached: cached!, write: write!, write1h: write1h!, output: output! };
  return p.cached + p.write <= p.input && p.write1h <= p.write ? p : null;
}
const charge = (p: Part, price: Price) => ((p.input - p.cached - p.write) * price.input + p.cached * price.cached
  + (p.write - p.write1h) * price.write + p.write1h * price.writeHour + p.output * price.output) / 1e6;
const baseline = (p: Part, price: Price) => (p.input * price.input + p.output * price.output) / 1e6;

/** Exact API equivalent of one model's records: each cache write at its own TTL price, each long request at long-context rates. */
export function estimate(row: Model, rate: Rate | undefined) {
  if (!rate) return null;
  const total = part(row.inputTokens, row.cachedInputTokens, row.cacheCreationInputTokens, row.cacheCreation1hInputTokens, row.outputTokens);
  const lc = row.longContext;
  const long = rate.long ? lc && part(lc.inputTokens, lc.cachedInputTokens, lc.cacheCreationInputTokens, lc.cacheCreation1hInputTokens, lc.outputTokens)
    : { input: 0, cached: 0, write: 0, write1h: 0, output: 0 };
  if (!total || !long || total.input + total.output === 0) return null;
  const short = { input: total.input - long.input, cached: total.cached - long.cached, write: total.write - long.write,
    write1h: total.write1h - long.write1h, output: total.output - long.output };
  if (Object.values(short).some(v => v < 0)) return null;
  const write = rate.write ?? 0;
  const standard = { ...rate, write, writeHour: rate.writeHour ?? write };
  const longPrice = rate.long ? { ...rate.long, writeHour: rate.long.write } : standard;
  const cost = charge(short, standard) + charge(long, longPrice);
  const original = baseline(short, standard) + baseline(long, longPrice);
  return { cost, baseline: original, paidPercent: cost / original * 100, longRequests: long.input > 0 };
}

/** One account's 24-hour API equivalent and its 30-day projection; null cost when any recorded model lacks an exact price. */
export function accountCost(account: AccountReport) {
  const models = account.models.map(row => ({ row, result: estimate(row, rateFor(row.model)) }));
  const dayCost = models.length && models.every(m => m.result) ? models.reduce((n, m) => n + m.result!.cost, 0) : null;
  const monthly = dayCost === null ? null : dayCost * projectionDays;
  const fee = subscriptions[account.alias as Alias]?.monthlyUsd ?? null;
  return { models, dayCost, monthly, fee, discount: monthly && fee !== null ? fee / monthly * 100 : null };
}

function quote(rate: Rate) {
  const long = rate.long;
  const value = (key: 'input' | 'cached' | 'output') => `${amount(rate[key])}${long ? `<span class="row-note">长上下文 ${amount(long[key])}</span>` : ''}`;
  return `<tr><td><span class="account-identity">${providerLogo(rate.provider)}<span>${escape(rate.model)}</span></span><span class="row-note">${providerName(rate.provider)}${rate.provider === 'Grok' ? ' · 参考模型，未读取用量' : ''}</span></td>
    <td>${value('input')}</td><td>${value('cached')}</td><td>${amount(rate.write)}${rate.writeHour !== null ? `<span class="row-note">5 分钟</span><span class="row-note">1 小时 ${amount(rate.writeHour)}</span>` : long && rate.write !== null ? `<span class="row-note">长上下文 ${amount(long.write)}</span>` : ''}</td><td>${value('output')}</td>
    <td class="accent">${folds(rate.cached / rate.input * 100)}<span class="row-note">仅缓存读单价</span></td><td><a href="${rate.source}" target="_blank" rel="noopener noreferrer">官方报价 ↗</a></td></tr>`;
}

function accountRow(account: AccountReport) {
  const { models, dayCost, monthly, fee, discount } = accountCost(account);
  const plan = subscriptions[account.alias as Alias];
  const identity = `<span class="account-identity">${providerLogo(account.provider)}<span>${escape(account.label)}</span></span>`;
  const missingModel = account.provider === 'Gemini' && account.samples.some(row => row.totalTokens !== null)
    ? '记录未提供模型归属，暂不估价' : '最近 24 小时暂无本机 Token 记录';
  const breakdown = models.length ? models.map(({ row, result }) => `<span class="row-note">${escape(row.model)}${coverageBadge(row.status)} · ${result
    ? `24 小时 ${amount(result.cost)}${result.longRequests ? ' · 含长上下文请求' : ''}` : '缺少单价或拆分计数'}</span>`).join('') : `<span class="row-note">${missingModel}</span>`;
  const billedUsd = account.billing?.costUsd ?? null;
  const feeDisplay = billedUsd !== null ? `${amount(billedUsd)}<span class="row-note">本月真实账单 · ${escape(plan?.plan ?? '按量计费')}</span>`
    : `${fee === null && plan ? '月费待确认' : amount(fee)}<span class="row-note">${escape(plan?.plan ?? '未录入')}</span>`;
  const discountNote = billedUsd !== null ? '按量计费实付，无固定月费' : discount === null ? (fee === null && plan ? '月费未录入，暂不计算' : '暂无可比用量') : `月费是 API 原价的 ${percent(discount)}`;
  return `<tr data-price-account="${account.alias}"><td>${identity}${breakdown}</td>
    <td class="accent">${amount(monthly)}<span class="row-note">24 小时 ${amount(dayCost)} × ${projectionDays}</span></td>
    <td>${feeDisplay}</td>
    <td class="accent">${folds(discount)}<span class="row-note">${discountNote}</span></td>
    <td>${discount === null ? '—' : percent(100 - discount)}</td></tr>`;
}

export function pricing(accounts: AccountReport[]) {
  const models = [...new Set(accounts.flatMap(account => account.models.map(row => row.model)).filter((model): model is string => model !== null))];
  const activeRates = rates.filter(rate => rate.provider === 'Grok' || models.some(model => rateFor(model) === rate));
  const unknownModels = models.filter(model => !rateFor(model));
  return `<section class="panel pricing-panel"><div class="panel-title"><h2>04 / 官方单价 · 缓存折扣</h2><span>USD / 1M TOKENS</span></div>
    <p class="table-note">官方标准 API 报价 · 美元 / 百万 Token · 核对 ${checkedAt}</p>
    <div class="table-scroll"><table><thead><tr><th>模型</th><th>普通输入</th><th>缓存读</th><th>缓存写入</th><th>输出</th><th>缓存读折扣</th><th>来源</th></tr></thead><tbody>${activeRates.map(quote).join('')}</tbody></table></div>
    ${unknownModels.length ? `<p class="table-note">未核对单价：${escape(unknownModels.join('、'))}。这些模型不估算费用。</p>` : ''}
    <div class="panel-title pricing-subtitle"><h2>单月 API 原价（含缓存）· 订阅折扣</h2><span>24H × ${projectionDays} / PROJECTION</span></div>
    <div class="table-scroll"><table><thead><tr><th>账号 / 模型</th><th>单月原价（含缓存）</th><th>订阅月费</th><th>订阅折扣</th><th>节省比例</th></tr></thead><tbody>${accounts.map(accountRow).join('')}</tbody></table></div>
    <p class="table-note">单月原价（含缓存）= 最近 24 小时本机记录按标准 API 单价计费 × ${projectionDays}，是推算值，不是账单。</p>
    <p class="table-note">订阅折扣 = 订阅月费 ÷ 单月原价（含缓存）。超过 10 折表示订阅比按 API 付费更贵。</p>
    <p class="table-note">Claude 缓存写入按记录里的 5 分钟 / 1 小时实际拆分计价。GPT 单次输入超过 272K 的请求整单按长上下文单价计价。</p>
    <p class="table-note">未计 Fast、Batch、区域和工具附加费。本机记录不含其他设备。月费按公开价，用户确认于 2026-10-07。</p></section>`;
}
