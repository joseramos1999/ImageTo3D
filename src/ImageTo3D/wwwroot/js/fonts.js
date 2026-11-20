// The text generator's fonts. They ship with the app (fonts/, from Google Fonts; licences in
// fonts/LICENCIAS.txt, faces in fonts/fonts.css), so a text comes out the same on every computer,
// Windows or Mac. One weight per font: the heaviest that still looks like it, since thin
// strokes make a weak 3D logo.
export const FONT_CATEGORIES = [
  { id: 'bold', label: 'Gruesas' },
  { id: 'condensed', label: 'Estrechas' },
  { id: 'rounded', label: 'Redondeadas' },
  { id: 'tech', label: 'Futuristas' },
  { id: 'serif', label: 'Con serifa' },
  { id: 'slab', label: 'Slab y western' },
  { id: 'fun', label: 'Divertidas' },
  { id: 'retro', label: 'Retro y art déco' },
  { id: 'script', label: 'Caligrafía' },
  { id: 'brush', label: 'Rotulador y grafiti' },
  { id: 'gothic', label: 'Góticas y terror' },
  { id: 'stencil', label: 'Plantilla y militar' },
  { id: 'pixel', label: 'Píxel y código' },
];

const font = (cat, family, weight = 400) => ({ id: family.toLowerCase().replace(/[^a-z0-9]/g, ''), family, weight, cat });

export const FONTS = [
  font('bold', 'Montserrat', 900), font('bold', 'Poppins', 800), font('bold', 'Archivo Black'), font('bold', 'Raleway', 900),
  font('bold', 'Kanit', 800), font('bold', 'Unbounded', 900), font('bold', 'Syne', 800), font('bold', 'Dela Gothic One'),
  font('bold', 'Rubik', 900), font('bold', 'Outfit', 800), font('bold', 'Space Grotesk', 700),
  font('condensed', 'Bebas Neue'), font('condensed', 'Anton'), font('condensed', 'Oswald', 700), font('condensed', 'Teko', 700),
  font('condensed', 'Big Shoulders Display', 900), font('condensed', 'Fjalla One'),
  font('rounded', 'Nunito', 900), font('rounded', 'Fredoka', 700), font('rounded', 'Comfortaa', 700), font('rounded', 'Baloo 2', 800),
  font('rounded', 'Varela Round'),
  font('tech', 'Orbitron', 900), font('tech', 'Audiowide'), font('tech', 'Russo One'), font('tech', 'Michroma'),
  font('tech', 'Zen Dots'), font('tech', 'Exo 2', 900), font('tech', 'Oxanium', 800),
  font('serif', 'Playfair Display', 900), font('serif', 'Abril Fatface'), font('serif', 'DM Serif Display'), font('serif', 'Cinzel', 900),
  font('serif', 'Merriweather', 900), font('serif', 'Bodoni Moda', 900), font('serif', 'Cormorant Garamond', 700),
  font('slab', 'Alfa Slab One'), font('slab', 'Ultra'), font('slab', 'Rye'), font('slab', 'Arvo', 700), font('slab', 'Zilla Slab', 700),
  font('fun', 'Luckiest Guy'), font('fun', 'Bangers'), font('fun', 'Titan One'), font('fun', 'Lilita One'), font('fun', 'Chewy'),
  font('fun', 'Sigmar One'), font('fun', 'Bowlby One'),
  font('retro', 'Righteous'), font('retro', 'Bungee'), font('retro', 'Shrikhand'), font('retro', 'Limelight'), font('retro', 'Monoton'),
  font('retro', 'Faster One'), font('retro', 'Fascinate'), font('retro', 'Gravitas One'),
  font('script', 'Pacifico'), font('script', 'Lobster'), font('script', 'Dancing Script', 700), font('script', 'Kaushan Script'),
  font('script', 'Yellowtail'), font('script', 'Satisfy'), font('script', 'Great Vibes'), font('script', 'Cookie'),
  font('brush', 'Permanent Marker'), font('brush', 'Knewave'), font('brush', 'Rock Salt'), font('brush', 'Sedgwick Ave Display'),
  font('brush', 'Caveat Brush'),
  font('gothic', 'UnifrakturMaguntia'), font('gothic', 'Pirata One'), font('gothic', 'Metal Mania'), font('gothic', 'Creepster'),
  font('gothic', 'Nosifer'), font('gothic', 'New Rocker'),
  font('stencil', 'Black Ops One'), font('stencil', 'Stardos Stencil', 700), font('stencil', 'Wallpoet'), font('stencil', 'Saira Stencil One'),
  font('pixel', 'Press Start 2P'), font('pixel', 'Silkscreen', 700), font('pixel', 'VT323'), font('pixel', 'JetBrains Mono', 800),
  font('pixel', 'Space Mono', 700),
];

export const DEFAULT_FONT = 'montserrat';
export const fontOf = id => FONTS.find(f => f.id === id) || FONTS.find(f => f.id === DEFAULT_FONT);

/** The CSS / canvas font of `f` at `px` pixels. */
export const cssFont = (f, px) => `${f.weight} ${px}px '${f.family}'`;

/**
 * Loads the faces `text` needs (the browser only fetches a font when it is first used, and a
 * canvas draws with a fallback until then). False when none was found: the font is missing.
 */
export async function loadFont(f, text) {
  try { return (await document.fonts.load(cssFont(f, 100), text)).length > 0; } catch { return false; }
}
