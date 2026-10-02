// Output sizes: presets for the usual destinations, or a custom width × height.

export const SIZES = [
  { id: 'yt', label: 'YouTube · 16:9 · 1920×1080', w: 1920, h: 1080 },
  { id: 'yt4k', label: 'YouTube 4K · 16:9 · 3840×2160', w: 3840, h: 2160 },
  { id: 'hd720', label: 'HD · 16:9 · 1280×720', w: 1280, h: 720 },
  { id: 'vertical', label: 'Shorts · Reels · TikTok · 9:16 · 1080×1920', w: 1080, h: 1920 },
  { id: 'vertical4k', label: 'Vertical 4K · 9:16 · 2160×3840', w: 2160, h: 3840 },
  { id: 'square', label: 'Instagram cuadrado · 1:1 · 1080×1080', w: 1080, h: 1080 },
  { id: 'portrait', label: 'Instagram vertical · 4:5 · 1080×1350', w: 1080, h: 1350 },
  { id: 'classic', label: 'Clásico · 4:3 · 1440×1080', w: 1440, h: 1080 },
  { id: 'wide', label: 'Panorámico · 21:9 · 2560×1080', w: 2560, h: 1080 },
  { id: 'custom', label: 'Personalizado…' },
];

export const CUSTOM_MIN = 64, CUSTOM_MAX = 7680;

/** Video encoders need even dimensions; keep custom sizes in range and even. */
export const evenClamp = v => {
  const n = Math.round(Number(v) || 0);
  return Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, n - (n % 2)));
};

/** [width, height] in pixels for the current settings. */
export function sizeOf(s) {
  if (s.size === 'custom') return [evenClamp(s.customW), evenClamp(s.customH)];
  const p = SIZES.find(x => x.id === s.size) || SIZES[0];
  return [p.w, p.h];
}

/** Settings saved before sizes existed used res (1080 / 2160) + aspect (16:9, 9:16, 1:1). */
export function migrateSettings(s) {
  if (!s || s.size || (!s.res && !s.aspect)) return s;
  const uhd = s.res === '2160';
  const size = s.aspect === '9:16' ? (uhd ? 'vertical4k' : 'vertical')
    : s.aspect === '1:1' ? (uhd ? 'custom' : 'square')
    : (uhd ? 'yt4k' : 'yt');
  const out = { ...s, size };
  if (size === 'custom') { out.customW = 2160; out.customH = 2160; }
  delete out.res;
  delete out.aspect;
  return out;
}
