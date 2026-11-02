/** Shared display rules for local token counters and independent quota windows. */
import type { AccountReport } from '../report.ts';
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const percent = (value: number | null) => value === null ? '—' : `${Number(value.toFixed(1))}%`;
export const usd = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const tokens = (value: number | null) => value === null ? '—' : value === 0 ? '0' : value >= 1e8
  ? `${Number((value / 1e8).toPrecision(3))} 亿` : `${Number((value / 1e6).toPrecision(3))} 百万`;
export const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', {
  timeZone: 'Asia/Singapore', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  second: '2-digit', hour12: false }) : '—';
export const scopes: Record<string, string> = { last_hour: '最近 1 小时', last_three_hours: '最近 3 小时', last_five_hours: '最近 5 小时', last_24_hours: '最近 24 小时' };
export const coverageBadge = (status: string | null) => status === 'partial' ? '<span class="coverage">部分记录</span>' : '';
export function quotaName(row: AccountReport['windows'][number]) {
  const duration = row.minutes === 10080 ? '周额度' : row.minutes === 300 ? '5 小时额度'
    : row.name?.includes('monthly') || row.name === 'monthly' ? '月额度' : row.minutes ? `${row.minutes / 60} 小时额度` : '额度';
  return `${duration}${row.model ? ` · ${row.model}` : ''}${row.surface ? ` · ${row.surface}` : ''}`;
}
