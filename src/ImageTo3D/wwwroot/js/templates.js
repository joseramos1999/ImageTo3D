// Templates: ready-made setups aimed at a result — an app icon, a YouTube intro, a vertical
// reel… Unlike the "Predeterminados" (a look for the scene), a template also sets the output:
// format and size, the animation or sequence, the camera, and where it matters the relief or
// the print base. Applied over the current settings; the logo and its cut-out stay.
import { PRESET_BASE } from './presets.js';

const seq = (intro, loop, reps, outro) => ({ mode: 'sequence', seqIntro: intro, seqLoop: loop, seqReps: reps, seqOutro: outro, seqTransition: 0.6, seqLoopSpeed: 1 });
const single = anim => ({ mode: 'single', anim });

const RAW = [
  { id: 'app-icon', label: 'Logo de app', tag: 'PNG · 1024×1024',
    desc: 'Icono cuadrado con relieve suave sobre fondo de color, listo para una tienda de apps.',
    set: { ...single('none'), format: 'png', size: 'custom', customW: 1024, customH: 1024,
      material: 'plastic', lighting: 'soft', floor: 'none', bg: 'indigo', camMove: 'none', depth: 0.35, bevel: 0.04 },
    relief: { mode: 'inflate', amount: 0.14, edge: 0.14 } },
  { id: 'yt-intro', label: 'Intro YouTube', tag: 'MP4 · 1920×1080 · 60 fps',
    desc: 'El contorno se dibuja, un barrido metálico y se disuelve en partículas. Con brillo y reflejo.',
    set: { ...seq('intro-trace', 'shine-sweep', 1, 'outro-dissolve'), format: 'mp4', size: 'yt', fps: '60',
      material: 'titanium', lighting: 'dramatic', floor: 'mirror', bg: 'black', bloom: 0.35, bloomTh: 0.75, particles: true, density: 0.8, camMove: 'push' } },
  { id: 'reel', label: 'Reel vertical', tag: 'MP4 · 1080×1920',
    desc: 'Para Shorts, Reels y TikTok: cae con física, gira de frente y sale por capas.',
    set: { ...seq('intro-physics', 'rotate-y-front', 2, 'outro-layers'), format: 'mp4', size: 'vertical', fps: '30',
      material: 'logo', lighting: 'soft', floor: 'shadow', bg: 'sunset', camMove: 'orbit-arc', camAmount: 0.8 } },
  { id: 'metal-badge', label: 'Badge metálico', tag: 'MP4 · 1080×1080',
    desc: 'Insignia de oro abombada con un destello que la recorre, sobre espejo.',
    set: { ...single('shine-sweep'), format: 'mp4', size: 'square', fps: '30',
      material: 'gold', lighting: 'dramatic', floor: 'mirror', bg: 'graphite', bloom: 0.2, bloomTh: 0.8, camMove: 'macro', camAmount: 0.6, depth: 0.3, bevel: 0.05 },
    relief: { mode: 'inflate', amount: 0.25, edge: 0.22 } },
  { id: 'neon-sign', label: 'Rótulo neón', tag: 'MP4 · 1920×1080',
    desc: 'Se enciende como un tubo de neón, parpadea y se apaga. Mucho brillo, fondo negro.',
    set: { ...seq('intro-neon', 'flicker', 2, 'outro-neon'), format: 'mp4', size: 'yt', fps: '30',
      material: 'neon', color: '#ff2fa8', lighting: 'neon', floor: 'mirror', bg: 'black', bloom: 0.7, bloomTh: 0.55, bloomRadius: 0.5, camMove: 'handheld', camAmount: 0.6 } },
  { id: 'avatar', label: 'Avatar 3D', tag: 'PNG · 1080×1080 · transparente',
    desc: 'Muy abombado, como un muñeco blando, sobre fondo transparente para usarlo de avatar.',
    set: { ...single('none'), format: 'png', size: 'square', material: 'logo', lighting: 'soft', floor: 'none', bg: 'transparent', camMove: 'none', depth: 0.5, bevel: 0.06 },
    relief: { mode: 'inflate', amount: 0.45, edge: 0.4 } },
  { id: 'print-plate', label: 'Placa para impresión', tag: 'STL · 80 mm',
    desc: 'Placa con base de contorno, tumbada y comprobada para imprimir en 3D.',
    set: { ...single('none'), format: 'stl', stlWidth: 80, printBase: 'contour', printMargin: 4, printBaseThick: 2.4, printOrient: 'flat',
      material: 'matte', color: '#c8ccd6', lighting: 'studio', floor: 'shadow', bg: 'graphite', camMove: 'none', depth: 0.35, bevel: 0.02 },
    relief: { mode: 'none' } },
  { id: 'overlay', label: 'Superposición transparente', tag: 'WebM con alfa · 1920×1080',
    desc: 'Vídeo con fondo transparente para OBS, DaVinci o Premiere: entra por un portal y gira.',
    set: { ...seq('intro-portal', 'rotate-y-front', 1, 'outro-portal'), format: 'webm', size: 'yt', fps: '30',
      material: 'logo', lighting: 'studio', floor: 'none', bg: 'transparent', camMove: 'none', bloom: 0 } },
];

/** Scene keys every template sets (from the presets' base), so the result never depends on what was on before. */
export const TEMPLATES = RAW.map(t => ({ ...t, set: { ...PRESET_BASE, ...t.set } }));
