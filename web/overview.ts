/** Render account-wide quota and consumption tables; scoped limits stay separate. */
import type { AccountReport } from '../report.ts';
import { coverageBadge, escape, percent, quotaName, time, tokens, usd } from './format.ts';
import { providerLogo, providerName } from './provider.ts';
import { weeklyLogo } from './weekly-logo.ts';
type Quota = AccountReport['windows'][number];
export const quotaOrder = (row: Quota) => row.scoped ? 3 : row.minutes === 300 ? 0 : row.minutes === 10080 ? 1 : 2;
const accountName = (account: AccountReport) => `<span class="account-identity">${providerLogo(account.provider)}<span class="account-text">${escape(account.label.startsWith(account.alias)
  ? account.label : `${account.alias} · ${account.label}`)}</span></span>`;

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
  return `<strong class="remaining-number ${row.remainingPercent !== null && row.remainingPercent < 20 ? 'warning' : ''}" data-provider="${provider}">${percent(row.remainingPercent)}</strong><div class="pixel-meter overview-meter" data-provider="${provider}" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('')}</div>`;
}

export function overview(accounts: AccountReport[]) {
  return `<section class="panel all-quota"><div class="panel-title"><h2>01 / 全部账号 · 5 小时限额</h2><span>5H FIRST / SGT</span></div><div class="table-scroll"><table><thead><tr><th>账号</th><th>套餐</th><th>5 小时已用</th><th>5 小时剩余</th><th>5 小时重置 (SGT)</th><th>本周剩余</th><th>周重置 (SGT)</th></tr></thead><tbody>${accounts.map(account => {
    const session = account.windows.find(row => !row.scoped && row.minutes === 300);
    const weekly = account.windows.find(row => !row.scoped && row.minutes === 10080);
    const subscription = account.provider === 'Gemini' && account.plan ? ` · ${escape(account.plan)}` : '';
    const sessionUsed = session ? percent(session.usedPercent ?? null)
      : account.billing?.dayCostUsd != null ? `${usd(account.billing.dayCostUsd)}<span class="row-note">近 24 小时</span>` : '—';
    const sessionReset = session ? time(session.resetsAt ?? null)
      : account.billing ? `${time(account.billing.periodStart)} 起<span class="row-note">${escape(account.billing.project ?? '按量计费')}</span>` : '—';
    const weeklyReset = weekly ? time(weekly.resetsAt ?? null)
      : account.billing ? `截至 ${time(account.billing.periodEnd)}<span class="row-note">有效响应 ${account.billing.validResponses ?? '—'}</span>` : '—';
    return `<tr data-overview-account="${account.alias}"><td><button class="account-link" data-account="${account.alias}">${accountName(account)}</button><span class="row-note provider-caption">${providerName(account.provider)}${subscription}${account.issue ? ` · ${escape(account.issue)}` : ''}${account.quotaSource === 'statusline' ? ` · 状态栏读数 ${time(account.quotaObservedAt)}` : account.quotaSource === 'cached' ? ` · 读数截至 ${time(account.quotaObservedAt)}` : ''}</span></td><td>${escape(account.plan ?? '—')}</td><td>${sessionUsed}</td><td>${remaining(session, account)}</td><td>${sessionReset}</td><td>${weeklyLogo(weekly?.remainingPercent, account)}</td><td>${weeklyReset}</td></tr>`;
  }).join('')}</tbody></table></div><p class="table-note">每个百分比只属于该账号，不能相加。服务端只有周额度时显示「仅周限额」。Claude 接口限流时改用 Claude Code 状态栏的最近读数，并标出读数时间。读取失败时沿用本周期最近一次读数并标出截至时间，到重置时间后清除。</p></section>`;
}

export function consumption(accounts: AccountReport[]) {
  const rows = accounts.flatMap(account => {
    const windows = account.windows.filter(row => !row.scoped && row.cycle).sort((a, b) => quotaOrder(a) - quotaOrder(b));
    if (windows.length) return windows.map(row => {
      const cycle = row.cycle!;
      return `<tr data-consumption-account="${account.alias}"><td>${accountName(account)}<span class="row-note">${escape(quotaName(row))}${coverageBadge(cycle.status)}</span></td><td>${time(cycle.start)} → ${time(cycle.end)}</td><td>${percent(row.usedPercent)}</td><td class="accent">${tokens(cycle.totalTokens)}<span class="row-note">缓存读 ${tokens(cycle.cachedInputTokens)}</span></td><td>${tokens(cycle.outputTokens)}</td><td>${tokens(cycle.tokensPerQuotaPercentagePoint)}</td><td>${tokens(cycle.projectedTokensPerFullWindow)}</td></tr>`;
    });
    const recent = account.samples.find(row => row.id === 'last_24_hours');
    const usedCell = account.billing?.costUsd != null ? `${usd(account.billing.costUsd)}<span class="row-note">本月账单</span>` : '—';
    return [`<tr data-consumption-account="${account.alias}"><td>${accountName(account)}<span class="row-note">${recent ? (account.billing ? '最近 24 小时 · 按量计费' : '最近 24 小时 · 无周期读数') : '暂无本机 Token 记录'}${coverageBadge(recent?.status ?? null)}</span></td><td>${time(recent?.start ?? null)} → ${time(recent?.end ?? null)}</td><td>${usedCell}</td><td class="accent">${tokens(recent?.totalTokens ?? null)}<span class="row-note">缓存读 ${tokens(recent?.cachedInputTokens ?? null)}</span></td><td>${tokens(recent?.outputTokens ?? null)}${recent?.reasoningOutputTokens != null ? `<span class="row-note">思考 ${tokens(recent.reasoningOutputTokens)}</span>` : ''}</td><td>—</td><td>—</td></tr>`];
  });
  return `<section class="panel all-consumption"><div class="panel-title"><h2>03 / 全部账号 · Token 消耗</h2><span>RECORDED / CURRENT CYCLE</span></div><div class="table-scroll"><table><thead><tr><th>账号 / 窗口</th><th>周期区间 (SGT)</th><th>已用</th><th>累计 Token (缓存读)</th><th>输出</th><th>每 1% Token</th><th>按当前用法推算整窗口</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="table-note">Token 来自本机记录，不含其他设备。缓存读已包含在累计值中。周期和账号不能相加。</p><p class="table-note">整窗口推算按当前周期用法外推，不是官方额度。无周期读数时单独显示最近 24 小时的本机记录。</p></section>`;
}
