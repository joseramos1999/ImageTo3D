// Built-in sources: the demo logo shown at start-up and typed 3D text.
// Both are drawn onto a canvas and go through the same tracer as an uploaded PNG.

export function demoLogo() {
  const big = "900 210px 'Arial Black', 'Segoe UI Black', Arial";
  const small = "700 112px 'Segoe UI', Arial";
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = big;
  const w1 = probe.measureText('LOGO').width;
  probe.font = small;
  const w2 = probe.measureText('IMAGE TO 3D').width;
  const textX = 390;

  const c = document.createElement('canvas');
  c.width = Math.ceil(textX + Math.max(w1, w2) + 30);
  c.height = 640;
  const ctx = c.getContext('2d');
  const cy = c.height / 2;

  // Mark: a lime triangle with a cut-out, beside a white word.
  ctx.fillStyle = '#c8f55a';
  ctx.beginPath();
  ctx.moveTo(180, cy - 190); ctx.lineTo(350, cy + 150); ctx.lineTo(10, cy + 150); ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(180, cy - 40); ctx.lineTo(250, cy + 100); ctx.lineTo(110, cy + 100); ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = big;
  ctx.fillText('LOGO', textX, cy - 55);
  ctx.fillStyle = '#5ab4f5';
  ctx.font = small;
  ctx.fillText('IMAGE TO 3D', textX + 6, cy + 105);
  return c;
}

export function textLogo(text, font, color) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const m = probe.measureText(text);
  const ascent = m.actualBoundingBoxAscent || 300, descent = m.actualBoundingBoxDescent || 80;
  const pad = 40;
  const c = document.createElement('canvas');
  c.width = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + pad * 2) || 400;
  c.height = Math.ceil(ascent + descent + pad * 2);
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(text, pad + m.actualBoundingBoxLeft, pad + ascent);
  return c;
}
