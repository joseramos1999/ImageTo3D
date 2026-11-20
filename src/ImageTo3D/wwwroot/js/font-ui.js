// Font picker of the text generator: a search box, a style filter, and every font drawn in its
// own face with the text being typed, grouped by style (fonts.js).
import { FONTS, FONT_CATEGORIES, fontOf } from './fonts.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
/** Lower case without accents: «gótica» finds «Góticas», «retro» finds «Retro y art déco». */
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const face = (n, f) => { n.style.fontFamily = `'${f.family}'`; n.style.fontWeight = f.weight; };

/**
 * Wires the picker. els: { button (opens it, shows the font), panel, input (the text field) };
 * `current` is a font id. onPick(font) — a font was chosen (click, Enter or Space).
 */
export function initFontPicker({ button, panel, input }, current, onPick) {
  const search = panel.querySelector('.font-search'), cat = panel.querySelector('.font-cat'), list = panel.querySelector('.font-list');
  let selected = fontOf(current);

  cat.append(new Option(`Todos los estilos · ${FONTS.length} fuentes`, ''),
    ...FONT_CATEGORIES.map(c => new Option(`${c.label} · ${FONTS.filter(f => f.cat === c.id).length}`, c.id)));

  const showButton = () => {
    button.textContent = selected.family;
    face(button, selected);
    button.title = `Fuente: ${selected.family}`;
    button.setAttribute('aria-label', `Fuente: ${selected.family}. Cambiar fuente`);
  };

  function render() {
    const q = fold(search.value.trim()), only = cat.value, text = input.value.trim();
    const groups = FONT_CATEGORIES
      .filter(c => !only || c.id === only)
      .map(c => [c, FONTS.filter(f => f.cat === c.id && (!q || fold(f.family).includes(q) || fold(c.label).includes(q)))])
      .filter(([, fonts]) => fonts.length);
    if (!groups.length) { list.replaceChildren(el('p', 'note', 'Ninguna fuente coincide.')); return; }
    list.replaceChildren(...groups.map(([c, fonts]) => {
      const group = el('div', 'font-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', c.label);
      if (!only) group.append(el('div', 'font-cat-title', c.label));
      for (const f of fonts) {
        const item = el('button', 'font-item');
        item.type = 'button';
        item.dataset.id = f.id;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(f === selected));
        item.setAttribute('aria-label', f.family);
        const sample = el('span', 'font-sample', text || f.family);
        face(sample, f);
        item.append(sample);
        if (text) item.append(el('span', 'font-name', f.family));
        item.onclick = () => pick(f);
        group.append(item);
      }
      return group;
    }));
  }

  function pick(f) {
    selected = f;
    showButton();
    list.querySelectorAll('.font-item').forEach(i => i.setAttribute('aria-selected', String(i.dataset.id === f.id)));
    onPick(f);
  }

  const items = () => [...list.querySelectorAll('.font-item')];
  function open(on) {
    panel.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (!on) return;
    render();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    search.focus();
  }

  button.onclick = () => open(panel.hidden);
  search.addEventListener('input', render);
  cat.addEventListener('change', () => { render(); list.scrollTop = 0; });
  input.addEventListener('input', () => { if (!panel.hidden) render(); });
  // Arrows walk the list (from the search box too), Escape closes and goes back to the button.
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); open(false); button.focus(); return; }
    // Space picks here (elsewhere it plays / pauses, and the app keeps it from pressing buttons).
    if (e.key === ' ' && e.target.matches('.font-item')) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) e.target.click(); return; }
    const all = items();
    if (!all.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (e.target === cat) return;   // the select's own arrows
    const at = all.indexOf(document.activeElement);
    if (at < 0 && e.target !== search) return;
    e.preventDefault();
    const next = at < 0 ? (e.key === 'ArrowUp' || e.key === 'End' ? all.length - 1 : 0)
      : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1
        : Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    all[next].focus();
    all[next].scrollIntoView({ block: 'nearest' });
  });

  showButton();
  return { get font() { return selected; }, close: () => open(false) };
}
