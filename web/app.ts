/** Browser rendering of aggregate readings; a client never starts provider requests. */
import type { AccountReport } from '../report.ts';
import { coverageBadge, escape, percent, quotaName, time, tokens, usd } from './format.ts';
import { comparison, cycles, forecast } from './sections.ts';
import { consumption, overview, quotaOrder } from './overview.ts';
import { providerLogo, providerName } from './provider.ts';
import { pricing } from './pricing.ts';
import { outputSpeed, type SpeedSnapshot } from './output-speed.ts';
import { intervalSpeed } from './interval-speed.ts';
import { speedHistory, historyWindows, historySorts } from './speed-history.ts';
import { initHistoryFilters } from './speed-history-controls.ts';
import { telemetry, telemetryScopes } from './telemetry.ts';
import { initTheme } from './theme.ts';
import { hostMonitor, emptyHostSnapshot, type HostSnapshot } from './host-monitor.ts';
import { remoteHosts, type RemoteHost } from './remote-hosts.ts';
type Snapshot = { generation: number; running: boolean; stale: boolean; nextRefreshAt: number;
  completedAt: string | null; accounts: AccountReport[] };
const element = (id: string) => document.getElementById(id)!;
const preference = (key: string) => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } };
let snapshot: Snapshot | null = null;
let selected = preference('token-account');
let windowId = preference('token-window') || 'last_24_hours';
if (!Object.hasOwn(telemetryScopes, windowId)) windowId = 'last_24_hours';
let cycleName = preference('token-cycle');
let fetching = false;
let lastSignature = '';
let speedFetching = false;
let speedSnapshot: SpeedSnapshot = { samples: [], nextFallbackAt: null, stale: false };
let hostFetching = false;
let hostSnapshot: HostSnapshot = emptyHostSnapshot();
let remoteFetching = false;
let remoteSnapshot: RemoteHost[] = [];
let speedWindow = preference('token-speed-window') || 'last_hour';
if (!historyWindows.some(window => window.id === speedWindow)) speedWindow = 'last_hour';
let speedAccount = preference('token-speed-account') || 'all';
let speedModel = preference('token-speed-model') || 'all';
let speedSort = preference('token-speed-sort') || 'default';
if (!historySorts.some(option => option.id === speedSort)) speedSort = 'default';
function renderSpeedHistory(force = false) {
  const container = element('speed-history');
  const scrollLeft = container.querySelector('.table-scroll')?.scrollLeft ?? 0;
  const focused = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusWindow = focused?.dataset.speedWindow;
  const focusSort = focused?.dataset.speedSort;
  const focusFilter = focused?.closest<HTMLElement>('[data-history-filter]')?.dataset.historyFilter;
  const markup = speedHistory(speedSnapshot, speedWindow, speedAccount, speedModel, speedSort);
  if (!force && container.querySelector('[data-speed-filter][aria-expanded="true"]')) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    for (const selector of ['.history-range', '.history-table']) {
      container.querySelector(selector)!.innerHTML = template.content.querySelector(selector)!.innerHTML;
    }
    return;
  }
  container.innerHTML = markup;
  const table = container.querySelector('.table-scroll');
  if (table) table.scrollLeft = scrollLeft;
  container.querySelectorAll<HTMLButtonElement>('[data-speed-window]').forEach(button => {
    button.onclick = () => { speedWindow = button.dataset.speedWindow!; remember('token-speed-window', speedWindow); renderSpeedHistory(); };
  });
  container.querySelectorAll<HTMLButtonElement>('[data-speed-sort]').forEach(button => {
    button.onclick = () => { speedSort = button.dataset.speedSort!; remember('token-speed-sort', speedSort); renderSpeedHistory(); };
  });
  if (focusWindow) container.querySelector<HTMLButtonElement>(`[data-speed-window="${focusWindow}"]`)?.focus({ preventScroll: true });
  else if (focusSort) container.querySelector<HTMLButtonElement>(`[data-speed-sort="${focusSort}"]`)?.focus({ preventScroll: true });
  else if (focusFilter) container.querySelector<HTMLButtonElement>(`[data-speed-filter="${focusFilter}"]`)?.focus({ preventScroll: true });
}
initHistoryFilters(element('speed-history'), (kind, value) => {
  if (kind === 'account') speedAccount = value;
  else speedModel = value;
  remember(`token-speed-${kind}`, value);
  renderSpeedHistory(true);
});
initTheme(element('theme-toggle') as HTMLButtonElement);
element('host-monitor').innerHTML = hostMonitor(hostSnapshot);
element('output-speed').innerHTML = outputSpeed(speedSnapshot);
renderSpeedHistory();
async function syncHost() {
  if (hostFetching) return;
  hostFetching = true;
  try {
    const response = await fetch('/api/host', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Host read failed');
    hostSnapshot = await response.json();
  } catch { hostSnapshot = { ...hostSnapshot, stale: true }; }
  finally {
    element('host-monitor').innerHTML = hostMonitor(hostSnapshot);
    hostFetching = false;
  }
}
async function syncRemoteHosts() {
  if (remoteFetching) return;
  remoteFetching = true;
  try {
    const response = await fetch('/api/hosts', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Remote host read failed');
    remoteSnapshot = (await response.json()).hosts;
  } catch { remoteSnapshot = remoteSnapshot.map(host => ({ ...host, stale: true })); }
  finally {
    element('remote-hosts').innerHTML = remoteHosts(remoteSnapshot);
    remoteFetching = false;
  }
}
async function syncSpeed() {
  if (speedFetching) return;
  speedFetching = true;
  try {
    const response = await fetch('/api/speed', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Speed read failed');
    speedSnapshot = await response.json();
  } catch { speedSnapshot = { ...speedSnapshot, stale: true }; }
  finally {
    element('output-speed').innerHTML = outputSpeed(speedSnapshot);
    renderSpeedHistory();
    const comparison = document.getElementById('interval-speed');
    if (comparison) {
      const scrollLeft = comparison.querySelector('.table-scroll')?.scrollLeft ?? 0;
      comparison.innerHTML = intervalSpeed(selected, speedSnapshot);
      const table = comparison.querySelector('.table-scroll');
      if (table) table.scrollLeft = scrollLeft;
    }
    speedFetching = false;
  }
}

function quotaCard(row: AccountReport['windows'][number]) {
  const filled = row.remainingPercent === null ? 0 : Math.round(row.remainingPercent / 100 * 24);
  return `<article class="quota-card ${row.remainingPercent !== null && row.remainingPercent < 20 ? 'low' : ''}"><div class="card-label">${escape(quotaName(row))}<span>REMAINING</span></div>
    <div class="quota-number">${percent(row.remainingPercent)}<span>剩余</span></div>
    <div class="pixel-meter" role="img" aria-label="剩余 ${percent(row.remainingPercent)}">${Array.from({ length: 24 }, (_, i) => `<i class="${i < filled ? 'filled' : ''}"></i>`).join('')}</div>
    <div class="quota-bottom"><span>已用 <b>${percent(row.usedPercent)}</b></span><span>重置 ${time(row.resetsAt)}</span></div></article>`;
}

function billingCards(account: AccountReport) {
  const b = account.billing!;
  return `<article class="quota-card"><div class="card-label">本月真实账单<span>MTD / USD</span></div>
    <div class="quota-number">${usd(b.costUsd)}<span>本机 Vertex 消耗</span></div>
    <div class="quota-bottom"><span>项目 <b>${escape(b.project ?? '—')}</b></span><span>起算 ${time(b.periodStart)}</span></div></article>
    <article class="quota-card"><div class="card-label">最近 24 小时账单<span>LAST 24H / USD</span></div>
    <div class="quota-number">${usd(b.dayCostUsd)}<span>24 小时消耗</span></div>
    <div class="quota-bottom"><span>本月有效响应 <b>${b.validResponses ?? '—'}</b></span><span>截至 ${time(b.periodEnd)}</span></div></article>`;
}

function modelTable(account: AccountReport) {
  const missingModel = account.provider === 'Gemini' && account.samples.some(row => row.totalTokens !== null)
    ? '日志未提供模型归属，总量见上方遥测' : '暂无有效 token 记录';
  return `<section class="panel" id="model-consumption"><div class="panel-title"><h2>模型消耗</h2><span>LAST 24H / RECORDED</span></div><div class="table-scroll"><table><thead><tr><th>模型</th><th>输入</th><th>缓存输入</th><th>输出</th><th>思考</th><th>总 token</th></tr></thead><tbody>${account.models.length ? account.models.map(row => `<tr><td><span class="model-dot"></span>${escape(row.model)}${coverageBadge(row.status)}</td><td>${tokens(row.inputTokens)}</td><td>${tokens(row.cachedInputTokens)}</td><td>${tokens(row.outputTokens)}</td><td>${tokens(row.reasoningOutputTokens)}</td><td class="accent">${tokens(row.totalTokens)}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">${missingModel}</td></tr>`}</tbody></table></div></section>`;
}

let navCollapsed = preference('token-sidenav') === 'collapsed';
let activeNavTarget = 'overview';
function syncSideNavState() {
  document.body.dataset.sidenav = navCollapsed ? 'collapsed' : 'expanded';
  const toggle = document.getElementById('side-nav-toggle') as HTMLButtonElement | null;
  if (toggle) {
    toggle.textContent = navCollapsed ? '»' : '«';
    toggle.setAttribute('aria-label', navCollapsed ? '展开侧边导航' : '收起侧边导航');
    toggle.title = navCollapsed ? '展开侧边导航' : '收起侧边导航';
  }
}
function closeMobileSideNav() {
  delete document.body.dataset.sidenavOpen;
  const fab = document.getElementById('side-nav-fab');
  if (fab) fab.setAttribute('aria-expanded', 'false');
}
function syncSideNavTargets() {
  document.querySelectorAll<HTMLAnchorElement>('#side-nav .is-sub[data-nav-target]').forEach(link => {
    const id = link.dataset.navTarget!;
    link.hidden = !document.getElementById(id);
  });
  updateActiveNav();
}
function setActiveNav(targetId: string) {
  activeNavTarget = targetId;
  document.querySelectorAll<HTMLAnchorElement>('#side-nav [data-nav-target]').forEach(link => {
    const active = link.dataset.navTarget === targetId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
function updateActiveNav() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('#side-nav [data-nav-target]')].filter(link => !link.hidden);
  if (!links.length) return;
  const threshold = 140;
  let current = links[0].dataset.navTarget!;
  for (const link of links) {
    const target = document.getElementById(link.dataset.navTarget!);
    if (!target || target.hidden) continue;
    if (target.getBoundingClientRect().top <= threshold) current = link.dataset.navTarget!;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24) {
    const last = [...links].reverse().find(link => {
      const target = document.getElementById(link.dataset.navTarget!);
      return target && !target.hidden && target.offsetHeight > 0;
    });
    if (last) current = last.dataset.navTarget!;
  }
  if (current !== activeNavTarget) setActiveNav(current);
}
function initSideNav() {
  syncSideNavState();
  setActiveNav(activeNavTarget);
  const toggle = document.getElementById('side-nav-toggle');
  if (toggle) toggle.onclick = () => {
    navCollapsed = !navCollapsed;
    remember('token-sidenav', navCollapsed ? 'collapsed' : 'expanded');
    syncSideNavState();
  };
  const fab = document.getElementById('side-nav-fab');
  if (fab) fab.onclick = () => {
    const open = document.body.dataset.sidenavOpen !== 'true';
    if (open) document.body.dataset.sidenavOpen = 'true';
    else delete document.body.dataset.sidenavOpen;
    fab.setAttribute('aria-expanded', String(open));
  };
  document.querySelectorAll<HTMLAnchorElement>('#side-nav [data-nav-target]').forEach(link => {
    link.onclick = event => {
      const id = link.dataset.navTarget!;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      const details = target instanceof HTMLDetailsElement ? target : target.closest('details');
      if (details) details.open = true;
      setActiveNav(id);
      closeMobileSideNav();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  const topButton = document.getElementById('side-nav-top');
  if (topButton) topButton.onclick = () => {
    closeMobileSideNav();
    setActiveNav('overview');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  document.addEventListener('click', event => {
    if (document.body.dataset.sidenavOpen !== 'true') return;
    const target = event.target as Node | null;
    const nav = document.getElementById('side-nav');
    if (target && !nav?.contains(target) && !fab?.contains(target)) closeMobileSideNav();
  });
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { updateActiveNav(); ticking = false; });
  }, { passive: true });
}
initSideNav();

function renderAccount(account: AccountReport) {
  const openDetails = [...document.querySelectorAll<HTMLDetailsElement>('#content details[open]')].map(row => row.id);
  const cards = account.windows.length ? [...account.windows].sort((a, b) => quotaOrder(a) - quotaOrder(b)).map(quotaCard).join('')
    : account.billing ? billingCards(account)
    : `<article class="quota-card empty">${account.provider === 'Gemini' ? `${escape(account.plan)} 订阅 · 暂未提供额度读数` : '暂无服务端额度读数'}</article>`;
  element('content').innerHTML = `${account.issue ? `<div class="notice">! ${escape(account.issue)}。本机 token 记录单独显示。</div>` : ''}${account.quotaSource === 'cached' ? `<div class="notice">本次额度未获取，显示截至 ${time(account.quotaObservedAt)} 的读数，到重置时间后清除。</div>` : ''}
    <div class="section-heading"><span>02 / 账号详情</span><span>${escape(account.label)} · ${escape(account.fingerprint ?? '指纹不可用')}</span></div>
    <div class="quota-grid" data-provider="${account.provider}">${cards}</div>
    ${telemetry(account, windowId, cycleName)}${account.provider === 'Gemini' ? '<p class="table-note">用量来自本机 Antigravity 记录，按响应记录的通道拆分订阅（ag1 · ultra）与 Vertex AI（ag2 · vertex）。未记录模型或思考拆分时显示「—」。</p>' : ''}
    ${comparison(account, speedSnapshot)}${modelTable(account)}${cycles(account)}${forecast(account)}
    <details class="notes" id="reading-notes"><summary>读数说明 <span>+</span></summary><p>额度来自服务端。token 来自本机记录，不含其他设备。账号额度保持独立。</p><p>缓存输入已包含在输入中。推理 token 已包含在输出中。缺失数据显示为「—」。</p><p>消耗速度表示工作负载消耗，不是模型输出速度。最近 24 小时从读数时间向前计算。时间按新加坡时间显示。</p>${account.provider === 'Claude' ? '<p>Claude 记录按本地账号目录归属。切换登录可能影响历史记录归属。</p>' : ''}<p>${escape(account.forecast ?? '剩余开发时间暂无可靠估计。')}</p></details>`;
  openDetails.forEach(id => { const details = document.getElementById(id) as HTMLDetailsElement | null; if (details) details.open = true; });
  document.querySelectorAll<HTMLButtonElement>('[data-window]').forEach(button => button.onclick = () => {
    windowId = button.dataset.window!;
    remember('token-window', windowId);
    renderAccount(account);
  });
  const cycleSelector = document.querySelector<HTMLSelectElement>('[data-cycle]');
  if (cycleSelector) cycleSelector.onchange = () => {
    cycleName = cycleSelector.value;
    remember('token-cycle', cycleName);
    renderAccount(account);
  };
  syncSideNavTargets();
}

function render() {
  if (!snapshot) return;
  if (!snapshot.accounts.some(account => account.alias === selected)) selected = snapshot.accounts[0]?.alias ?? '';
  element('connection').textContent = snapshot.stale ? '读数过期' : snapshot.running ? '读取中' : '实时连接';
  element('timestamp').textContent = snapshot.completedAt ? `更新 ${time(snapshot.completedAt)}` : '首次读取中…';
  setPageNotice(snapshot.stale ? '读数已过期。下次读取成功后将自动恢复。' : '');
  element('overview').innerHTML = snapshot.accounts.length ? overview(snapshot.accounts) : '<div class="loading">正在读取全部账号…</div>';
  element('consumption').innerHTML = snapshot.accounts.length ? consumption(snapshot.accounts) : '';
  element('pricing').innerHTML = snapshot.accounts.length ? pricing(snapshot.accounts) : '';
  element('accounts').innerHTML = snapshot.accounts.map(account => `<button data-account="${account.alias}" aria-pressed="${account.alias === selected}" class="${account.alias === selected ? 'active' : ''}">${providerLogo(account.provider)}<span class="selector-label"><b>${providerName(account.provider)}</b>${escape(account.label)}</span></button>`).join('');
  const sideAccountsWrap = document.getElementById('side-nav-accounts-wrap');
  const sideAccounts = document.getElementById('side-nav-accounts');
  if (sideAccountsWrap && sideAccounts) {
    sideAccountsWrap.hidden = !snapshot.accounts.length;
    sideAccounts.innerHTML = snapshot.accounts.map(account => `<button type="button" data-side-account="${account.alias}" data-provider="${account.provider}" aria-pressed="${account.alias === selected}" class="${account.alias === selected ? 'active' : ''}" title="查看 ${escape(account.label)} 详情">${escape(account.alias)}</button>`).join('');
    sideAccounts.querySelectorAll<HTMLButtonElement>('[data-side-account]').forEach(button => button.onclick = () => {
      selected = button.dataset.sideAccount!;
      remember('token-account', selected);
      render();
      closeMobileSideNav();
      element('content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-account]').forEach(button => button.onclick = () => {
    selected = button.dataset.account!;
    remember('token-account', selected);
    render();
  });
  const account = snapshot.accounts.find(row => row.alias === selected);
  if (!snapshot.stale && !snapshot.running && account?.issue) element('connection').textContent = '额度读取失败';
  if (account) renderAccount(account);
}

function setPageNotice(message: string) {
  element('page-notice').textContent = message;
  element('page-notice').hidden = !message;
  document.body.dataset.connection = message ? 'unavailable' : 'live';
}

async function sync(): Promise<boolean> {
  if (fetching) return false;
  fetching = true;
  try {
    const response = await fetch('/api/usage', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('Read failed');
    snapshot = await response.json();
    const signature = `${snapshot!.generation}/${snapshot!.running}/${snapshot!.stale}/${snapshot!.completedAt}`;
    if (signature !== lastSignature) { render(); lastSignature = signature; }
    return true;
  } catch {
    element('connection').textContent = '连接中断';
    element('timestamp').textContent = '读取失败 · 旧读数仅供参考';
    lastSignature = '';
    setPageNotice('连接中断。当前显示旧读数，恢复连接后将自动更新。');
    return false;
  } finally { fetching = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void sync(); void syncSpeed(); void syncHost(); void syncRemoteHosts(); } });
setInterval(() => { if (!document.hidden) void sync(); }, 5000);
void sync();
setInterval(() => { if (!document.hidden) void syncSpeed(); }, 1000);
void syncSpeed();
setInterval(() => { if (!document.hidden) void syncHost(); }, 2000);
setInterval(() => { if (!document.hidden) void syncRemoteHosts(); }, 2000);
void syncHost();
void syncRemoteHosts();
