/** Render account-wide quota, Claude Fable 5 weekly limits and local cycle/24h token tables; scoped limits stay independent. */
import type { AccountReport } from '../report.ts';
import { coverageBadge, escape, percent, quotaName, time, tokens, usd } from './format.ts';
import { providerLogo, providerName } from './provider.ts';
import { weeklyLogo } from './weekly-logo.ts';
type Quota = AccountReport['windows'][number];
const isFableWindow = (row: Quota) => row.scoped && row.minutes === 10080 && row.model !== null && /fable/i.test(row.model);
export const quotaOrder = (row: Quota) => row.scoped ? (isFableWindow(row) ? 2 : 3) : row.minutes === 300 ? 0 : row.minutes === 10080 ? 1 : 4;
const level = (value: number | null | undefined) => value === null || value === undefined ? '' : value <= 0 ? ' exhausted' : value < 15 ? ' warning' : '';
const accountName = (account: AccountReport) => `<span class="account-identity">${providerLogo(account.provider)}<span class="account-text">${escape(account.label.startsWith(account.alias)
  ? account.label : `${account.alias} · ${account.label}`)}</span></span>`;
const resetTime = (value: string | null) => value
  ? `<time class="quota-reset" datetime="${escape(value)}">${escape(time(value)).replace(' ', '<br>')}</time>` : '—';

function remaining(row: Quota | undefined, account: AccountReport) {
  if (!row) {
    if (account.billing) {
      const cost = account.billing.costUsd;
      const dayCost = account.billing.dayCostUsd;
      return `<strong class="remaining-number" data-provider="${account.provider}">${usd(cost)}</strong><span class="row-note">本月真实账单${dayCost !== null ? ` · 近 24h ${usd(dayCost)}` : ' · 按量计费'}</span>`;
    }
    const fallback = account.issue ?? (account.windows.some(w => !w.scoped && w.minutes === 10080) ? '仅周限额'
      : account.provider === 'Gemini' ? '暂未提供读数' : '未单独报告');
    return `<span class="row-note">${escape(fallback)}</span>`;
  }
  const provider = account.provider;
  const filled = row.remainingPercent === null ? 0 : Math.round(row.remainingPercent / 100 * 16);
  return `<strong class="remaining-number${level(row.remainingPercent)}" data-provider="${provider}">${percent(row.remainingPercent)}</strong><div class="pixel-meter overview-meter${level(row.remainingPercent)}" data-provider="${provider}" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('')}</div>`;
}

function fableRemaining(fable: Quota | undefined, weekly: Quota | undefined, account: AccountReport) {
  if (account.provider !== 'Claude') return '<span class="row-note">—</span>';
  if (!fable) return `<span class="row-note">${escape(account.issue ?? '等待服务端读数')}</span>`;
  const rem = fable.remainingPercent;
  const weeklyRem = weekly?.remainingPercent ?? null;
  const blocked = rem !== null && rem > 0 && weeklyRem !== null && weeklyRem <= 0;
  const capped = rem !== null && rem > 0 && weeklyRem !== null && weeklyRem > 0 && weeklyRem < rem;
  const share = fable.weeklyShare?.usedPercent != null && fable.weeklyShare?.allowancePercent != null
    ? `占周额 ${percent(fable.weeklyShare.usedPercent)}/${percent(fable.weeklyShare.allowancePercent)}` : null;
  const note = rem !== null && rem <= 0
    ? `<span class="row-note status-exhausted">Fable 5 已耗尽${share ? ` · ${share}` : ''}</span>`
    : blocked ? `<span class="row-note status-capped">受周总额限制 (0%)${share ? ` · ${share}` : ''}</span>`
    : capped ? `<span class="row-note status-capped">可用上限 ${percent(weeklyRem)} (周总额)</span>`
    : share ? `<span class="row-note">${share}</span>` : '';
  const filled = rem === null ? 0 : Math.round(rem / 100 * 16);
  const state = `${level(rem)}${blocked ? ' is-capped' : ''}`;
  return `<strong class="remaining-number fable-number${state}" data-provider="Claude">${percent(rem)}</strong><div class="pixel-meter overview-meter fable-meter${state}" data-provider="Claude" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('')}</div>${note}`;
}

function tokenPlanCell(account: AccountReport) {
  const day = account.samples.find(row => row.id === 'last_24_hours');
  const fableModels = account.models.filter(row => row.model !== null && /fable/i.test(row.model) && (row.totalTokens ?? 0) > 0);
  const fableTokens = fableModels.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
  const hit = account.cache.find(row => row.id === 'last_24_hours')?.tokenHitPercent ?? null;
  const primary = day?.totalTokens != null
    ? `<strong class="overview-tokens">${tokens(day.totalTokens)}</strong>`
    : `<span class="row-note">${account.provider === 'Grok' ? '无本机记录' : '暂无 24h 记录'}</span>`;
  const detail = fableModels.length
    ? `<span class="row-note fable-token-note">Fable 5 · ${tokens(fableTokens)}</span>`
    : day?.totalTokens != null && hit !== null ? `<span class="row-note">缓存读 ${percent(hit)}</span>` : '';
  return `${primary}${detail}<span class="plan-pill">${escape(account.plan ?? '—')}</span>`;
}

export function overview(accounts: AccountReport[]) {
  return `<section class="panel all-quota"><div class="panel-title"><h2>01 / 全部账号 · 实时额度与 Token</h2><span>5H · WEEKLY · FABLE 5 · 24H TOKEN / SGT</span></div><div class="table-scroll"><table><thead><tr><th scope="col">账号</th><th scope="col">5 小时剩余</th><th scope="col">5h 重置 <span class="quota-timezone">(SGT)</span></th><th scope="col">本周剩余</th><th scope="col">Fable 5 剩余</th><th scope="col">周重置 <span class="quota-timezone">(SGT)</span></th><th scope="col">近 24h Token · 套餐</th></tr></thead><tbody>${accounts.map(account => {
    const session = account.windows.find(row => !row.scoped && row.minutes === 300);
    const weekly = account.windows.find(row => !row.scoped && row.minutes === 10080);
    const fable = account.windows.find(isFableWindow);
    const sessionReset = session ? resetTime(session.resetsAt ?? null)
      : account.billing ? `${resetTime(account.billing.periodStart)} 起<span class="row-note">${escape(account.billing.project ?? '按量计费')}</span>` : '—';
    const weeklyReset = (weekly ?? fable) ? resetTime((weekly?.resetsAt ?? fable?.resetsAt) ?? null)
      : account.billing ? `截至 ${resetTime(account.billing.periodEnd)}<span class="row-note">有效响应 ${account.billing.validResponses ?? '—'}</span>` : '—';
    return `<tr data-overview-account="${account.alias}"><td class="quota-account"><button class="account-link" data-account="${account.alias}">${accountName(account)}</button><span class="row-note provider-caption">${providerName(account.provider)}${account.issue ? ` · ${escape(account.issue)}` : ''}${account.quotaSource === 'statusline' ? `<span class="quota-reading">状态栏读数 ${time(account.quotaObservedAt)}</span>` : account.quotaSource === 'cached' ? `<span class="quota-reading">读数截至 ${time(account.quotaObservedAt)}</span>` : ''}</span></td><td data-label="5 小时剩余">${remaining(session, account)}</td><td data-label="5h 重置 (SGT)">${sessionReset}</td><td data-label="本周剩余">${weeklyLogo(weekly?.remainingPercent, account)}</td><td data-label="Fable 5 剩余">${fableRemaining(fable, weekly, account)}</td><td data-label="周重置 (SGT)">${weeklyReset}</td><td class="quota-plan" data-label="近 24h Token · 套餐">${tokenPlanCell(account)}</td></tr>`;
  }).join('')}</tbody></table></div><p class="table-note">每个百分比只属于该账号，不能相加。Claude「Fable 5 剩余」来自服务端独立周模型限额（默认约占周总额度 50%），与「本周剩余」总额度同时生效、先到先限。近 24h Token 来自本机记录。Claude 接口限流或会话活跃时结合状态栏与每 5 分钟服务端模型窗口读数更新。</p></section>`;
}

export function consumption(accounts: AccountReport[]) {
  const rows = accounts.flatMap(account => {
    const windows = account.windows.filter(row => (!row.scoped || (row.model !== null && row.surface === null)) && row.cycle)
      .sort((a, b) => quotaOrder(a) - quotaOrder(b));
    if (windows.length) return windows.map(row => {
      const cycle = row.cycle!;
      return `<tr data-consumption-account="${account.alias}"${isFableWindow(row) ? ' class="is-fable-row"' : ''}><td>${accountName(account)}<span class="row-note">${escape(quotaName(row))}${row.scoped ? ' · 独立模型限额' : ''}${coverageBadge(cycle.status)}</span></td><td>${time(cycle.start)} → ${time(cycle.end)}</td><td>${percent(row.usedPercent)}</td><td class="accent">${tokens(cycle.totalTokens)}<span class="row-note">缓存读 ${tokens(cycle.cachedInputTokens)}</span></td><td>${tokens(cycle.outputTokens)}</td><td>${tokens(cycle.tokensPerQuotaPercentagePoint)}</td><td>${tokens(cycle.projectedTokensPerFullWindow)}</td></tr>`;
    });
    const recent = account.samples.find(row => row.id === 'last_24_hours');
    const usedCell = account.billing?.costUsd != null ? `${usd(account.billing.costUsd)}<span class="row-note">本月账单</span>` : '—';
    return [`<tr data-consumption-account="${account.alias}"><td>${accountName(account)}<span class="row-note">${recent ? (account.billing ? '最近 24 小时 · 按量计费' : '最近 24 小时 · 无周期读数') : '暂无本机 Token 记录'}${coverageBadge(recent?.status ?? null)}</span></td><td>${time(recent?.start ?? null)} → ${time(recent?.end ?? null)}</td><td>${usedCell}</td><td class="accent">${tokens(recent?.totalTokens ?? null)}<span class="row-note">缓存读 ${tokens(recent?.cachedInputTokens ?? null)}</span></td><td>${tokens(recent?.outputTokens ?? null)}${recent?.reasoningOutputTokens != null ? `<span class="row-note">思考 ${tokens(recent.reasoningOutputTokens)}</span>` : ''}</td><td>—</td><td>—</td></tr>`];
  });
  return `<section class="panel all-consumption"><div class="panel-title"><h2>03 / 全部账号 · Token 消耗</h2><span>RECORDED / CURRENT CYCLE</span></div><div class="table-scroll"><table><thead><tr><th>账号 / 窗口</th><th>周期区间 (SGT)</th><th>已用</th><th>累计 Token (缓存读)</th><th>输出</th><th>每 1% Token</th><th>按当前用法推算整窗口</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="table-note">Token 来自本机记录，不含其他设备。缓存读已包含在累计值中。独立模型限额（如 Fable 5 周额度）仅统计对应模型，各窗口与账号不能相加。</p><p class="table-note">整窗口推算按当前周期用法外推，不是官方额度。无周期读数时单独显示最近 24 小时的本机记录。</p></section>`;
}
