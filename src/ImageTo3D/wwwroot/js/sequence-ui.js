// "Secuencia" tab: build a complete clip from an intro, a loop repeated N times (or a
// still pause) and an outro. The clip's length follows from the parts.
import { ANIMATIONS, getAnimation, timelineOf, DEFAULT_TRANSITION } from './animations.js';

export const SEQ_MAX_REPS = 20;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const secs = n => n.toFixed(1).replace('.', ',') + ' s';

/** The sequence's parts as animation objects (null where a part is off). */
export function sequenceParts(state) {
  const pick = (id, kind) => { const a = id && id !== 'none' && id !== 'still' ? getAnimation(id) : null; return a?.kind === kind && (kind !== 'loop' || a.period) ? a : null; };
  return {
    intro: pick(state.seqIntro, 'intro'),
    loop: pick(state.seqLoop, 'loop'),
    outro: pick(state.seqOutro, 'outro'),
    still: state.seqLoop === 'still',
  };
}

export function sequenceTimeline(state) {
  const p = sequenceParts(state);
  const reps = Math.max(1, Math.min(SEQ_MAX_REPS, Math.round(state.seqReps || 1)));
  return timelineOf({ intro: p.intro, loop: p.loop, outro: p.outro, reps, hold: p.still ? reps : 0, speed: state.speed,
    loopSpeed: state.seqLoopSpeed ?? 1,
    transition: state.seqTransition ?? DEFAULT_TRANSITION });
}

/** A labelled range like the panel's other sliders; `commit` runs when the drag ends. */
function slider(cls, title, aria, { min, max, step }, value, format, commit) {
  const wrap = el('div', `slider ${cls}`);
  const head = el('div', 'lbl');
  const shown = el('span', null, format(value));
  head.append(el('span', null, title), shown);
  const range = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  range.setAttribute('aria-label', aria);
  const paint = () => { range.style.setProperty('--p', ((range.value - min) / (max - min) * 100) + '%'); shown.textContent = format(Number(range.value)); };
  paint();
  range.addEventListener('input', paint);
  range.addEventListener('change', () => commit(Number(range.value)));
  wrap.append(head, range);
  return wrap;
}

function select(options, value, label) {
  const s = el('select', 'select seq-select');
  s.setAttribute('aria-label', label);
  for (const [v, text] of options) s.add(new Option(text, v));
  s.value = value;
  return s;
}

/**
 * Renders the panel into `container`. `change(patch)` applies a settings patch (and makes
 * the sequence the active animation); `use()` activates it without changing anything.
 */
export function renderSequencePanel(container, state, { change, use }) {
  const byKind = kind => ANIMATIONS.filter(a => a.kind === kind && (kind !== 'loop' || a.period))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'))
    .map(a => [a.id, a.pieces ? `${a.label} ▦` : a.label]);
  const tl = sequenceTimeline(state);
  const parts = sequenceParts(state);
  const active = state.mode === 'sequence';

  const slot = (n, title, cls, control, seconds, ...extra) => {
    const row = el('div', `seq-slot ${cls}`);
    const head = el('div', 'seq-head');
    head.append(el('span', 'seq-num', String(n)), el('span', 'seq-title', title), el('span', 'seq-dur', seconds > 0 ? secs(seconds) : '—'));
    row.append(head, control, ...extra);
    return row;
  };

  const introSel = select([['none', 'Sin intro'], ...byKind('intro')], state.seqIntro, 'Intro');
  introSel.onchange = () => change({ seqIntro: introSel.value });

  const loopSel = select([['none', 'Sin bucle'], ['still', 'Quieto (pausa)'], ...byKind('loop')], state.seqLoop, 'Bucle');
  loopSel.onchange = () => change({ seqLoop: loopSel.value });

  // Repetitions (or seconds of pause, for "Quieto")
  const stepper = el('div', 'seq-reps');
  const unit = parts.still ? 'segundos' : 'repeticiones';
  const minus = el('button', 'btn small', '−'), plus = el('button', 'btn small', '+');
  const count = el('span', 'seq-count', String(state.seqReps));
  minus.setAttribute('aria-label', `Menos ${unit}`);
  plus.setAttribute('aria-label', `Más ${unit}`);
  const setReps = v => change({ seqReps: Math.max(1, Math.min(SEQ_MAX_REPS, v)) });
  minus.onclick = () => setReps(state.seqReps - 1);
  plus.onclick = () => setReps(state.seqReps + 1);
  minus.disabled = state.seqReps <= 1;
  plus.disabled = state.seqReps >= SEQ_MAX_REPS;
  stepper.append(el('span', 'seq-reps-label', parts.loop ? 'Repeticiones' : 'Segundos quieto'), minus, count, plus);
  stepper.hidden = !parts.loop && !parts.still;

  // The loop's own speed, on top of the general «Velocidad» (which also moves intro and outro).
  // Repetitions stay whole, so a faster loop makes its part of the clip shorter.
  const loopSpeed = slider('seq-speed', 'Velocidad del bucle', 'Velocidad del bucle',
    { min: 0.25, max: 3, step: 0.05 }, state.seqLoopSpeed ?? 1,
    v => v.toFixed(2) + 'x', v => change({ seqLoopSpeed: v }));
  loopSpeed.hidden = !parts.loop;

  const outroSel = select([['none', 'Sin salida'], ...byKind('outro')], state.seqOutro, 'Salida');
  outroSel.onchange = () => change({ seqOutro: outroSel.value });

  // Proportional timeline bar
  const bar = el('div', 'seq-bar');
  bar.setAttribute('aria-hidden', 'true');
  const total = tl.clip || 0;
  for (const [cls, len, label] of [['intro', tl.introSecs, 'Intro'], ['loop', tl.mid, parts.loop ? `× ${state.seqReps}` : 'Quieto'], ['outro', tl.outroSecs, 'Salida']]) {
    if (len <= 0) continue;
    const seg = el('span', `seq-seg ${cls}`, label);
    seg.style.flexGrow = String(len);
    seg.title = `${label} · ${secs(len)}`;
    bar.append(seg);
  }

  // Transition: how long each join between parts eases in / out (0 = hard cut)
  const trans = slider('seq-trans', 'Transición entre partes', 'Transición entre partes, en segundos',
    { min: 0, max: 1.5, step: 0.05 }, state.seqTransition ?? DEFAULT_TRANSITION,
    v => v > 0 ? secs(v) : 'Corte seco', v => change({ seqTransition: v }));
  trans.hidden = !(parts.loop && (parts.intro || parts.outro));   // only joins next to a loop are eased

  const foot = el('div', 'seq-foot');
  const totalText = el('span', 'seq-total', total > 0 ? `Total ${secs(total)}` : 'Elige al menos una parte');
  const status = active
    ? el('span', 'seq-active', '● En uso')
    : Object.assign(el('button', 'btn small primary', 'Usar esta secuencia'), { onclick: use });
  foot.append(totalText, status);

  container.replaceChildren(
    slot(1, 'Intro', 'intro', introSel, tl.introSecs),
    slot(2, 'Bucle', 'loop', loopSel, tl.mid, stepper, loopSpeed),
    slot(3, 'Salida', 'outro', outroSel, tl.outroSecs),
    bar, trans, foot,
  );
}
