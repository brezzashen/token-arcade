/** Logo selectors retain native button activation and support listbox keyboard navigation. */
export function initHistoryFilters(container: HTMLElement, select: (kind: 'account' | 'model', value: string) => void) {
  const triggerFor = (filter: HTMLElement) => filter.querySelector<HTMLButtonElement>('[data-speed-filter]')!;
  const optionsFor = (filter: HTMLElement) => filter.querySelector<HTMLElement>('[role="listbox"]')!;
  const close = (filter: HTMLElement, focus = false) => {
    triggerFor(filter).setAttribute('aria-expanded', 'false');
    optionsFor(filter).hidden = true;
    if (focus) triggerFor(filter).focus({ preventScroll: true });
  };
  const closeAll = (except?: HTMLElement) => container.querySelectorAll<HTMLElement>('[data-history-filter]').forEach(filter => {
    if (filter !== except) close(filter);
  });
  const open = (filter: HTMLElement, last = false) => {
    closeAll(filter);
    triggerFor(filter).setAttribute('aria-expanded', 'true');
    const list = optionsFor(filter);
    list.hidden = false;
    const options = list.querySelectorAll<HTMLButtonElement>('[role="option"]');
    (last ? options[options.length - 1] : list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? options[0])?.focus({ preventScroll: true });
    list.querySelector<HTMLElement>(':focus')?.scrollIntoView({ block: 'nearest' });
  };
  container.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const filter = target?.closest<HTMLElement>('[data-history-filter]');
    if (!filter) { closeAll(); return; }
    const trigger = target?.closest<HTMLButtonElement>('[data-speed-filter]');
    if (trigger) {
      if (trigger.getAttribute('aria-expanded') === 'true') close(filter, true);
      else open(filter);
      return;
    }
    const option = target?.closest<HTMLButtonElement>('[role="option"]');
    if (!option) return;
    const kind = filter.dataset.historyFilter as 'account' | 'model';
    const value = kind === 'account' ? option.dataset.speedAccount! : option.dataset.speedModel!;
    close(filter, true);
    select(kind, value);
  });
  container.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : null;
    const filter = target?.closest<HTMLElement>('[data-history-filter]');
    if (!filter) return;
    if (event.key === 'Escape') { event.preventDefault(); close(filter, true); return; }
    const trigger = triggerFor(filter);
    if (target === trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); open(filter, event.key === 'ArrowUp'); return;
    }
    if (optionsFor(filter).hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...filter.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus({ preventScroll: true });
    options[next]?.scrollIntoView({ block: 'nearest' });
  });
  container.addEventListener('focusout', event => {
    const filter = (event.target as Element).closest<HTMLElement>('[data-history-filter]');
    if (filter && !filter.contains(event.relatedTarget as Node | null)) close(filter);
  });
  document.addEventListener('click', event => {
    if (!container.contains(event.target as Node | null)) closeAll();
  });
}
