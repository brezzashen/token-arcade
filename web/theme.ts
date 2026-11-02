/** Three-state color theme toggle: follow the system, or force light or dark; index.html applies the stored choice before first paint. */
type Theme = 'auto' | 'light' | 'dark';
const order: Theme[] = ['auto', 'light', 'dark'];
const labels: Record<Theme, [icon: string, text: string, spoken: string]> = {
  auto: ['◐', '自动', '跟随系统'], light: ['☀', '浅色', '浅色'], dark: ['☾', '深色', '深色'],
};
const colors = { light: '#f4f2ec', dark: '#101010' };
const system = matchMedia('(prefers-color-scheme: light)');

function stored(): Theme {
  try { const value = localStorage.getItem('token-theme'); return value === 'light' || value === 'dark' ? value : 'auto'; } catch { return 'auto'; }
}

function apply(theme: Theme, button: HTMLButtonElement) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // A forced theme pins every theme-color meta so the browser chrome matches the page, not the system.
  const effective = theme === 'auto' ? null : colors[theme];
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta =>
    meta.content = effective ?? (meta.media.includes('light') ? colors.light : colors.dark));
  const [icon, text, spoken] = labels[theme];
  button.textContent = `${icon} ${text}`;
  button.setAttribute('aria-label', `切换配色：${spoken}`);
  button.title = theme === 'auto' ? `跟随系统（当前${system.matches ? '浅色' : '深色'}）` : `已固定为${spoken}`;
}

export function initTheme(button: HTMLButtonElement) {
  let theme = stored();
  apply(theme, button);
  button.onclick = () => {
    theme = order[(order.indexOf(theme) + 1) % order.length];
    try { if (theme === 'auto') localStorage.removeItem('token-theme'); else localStorage.setItem('token-theme', theme); } catch { /* Preferences are optional. */ }
    apply(theme, button);
  };
  system.addEventListener('change', () => apply(theme, button));
}
