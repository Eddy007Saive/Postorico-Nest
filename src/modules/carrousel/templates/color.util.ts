/** Maths de couleur pour les templates de carrousel — port direct de la section
 * « couleur » de backend/services/carrousel_service.py. Contraste automatique :
 * la couleur du texte est calculée selon la luminosité du fond. */

export function toRgb(hex: string): [number, number, number] {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function mix(c1: string, c2: string, t: number): string {
  const r1 = toRgb(c1);
  const r2 = toRgb(c2);
  return toHex([0, 1, 2].map((i) => r1[i] * (1 - t) + r2[i] * t) as [number, number, number]);
}

export function lighten(h: string, t: number): string {
  return mix(h, '#ffffff', t);
}

export function darken(h: string, t: number): string {
  return mix(h, '#000000', t);
}

export function lum(h: string): number {
  const [r, g, b] = toRgb(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function inkOn(bg: string): string {
  return lum(bg) > 0.6 ? '#12150f' : '#ffffff';
}

/** Accent lisible sur fond clair. */
export function accLight(a: string): string {
  return lum(a) < 0.62 ? a : darken(a, 0.5);
}

/** Accent lisible sur fond sombre. */
export function accDark(a: string): string {
  return lum(a) > 0.34 ? a : lighten(a, 0.42);
}

/** Fond sombre teinté par la couleur choisie (reste assez sombre pour le texte blanc). */
export function near(p: string): string {
  return mix(p, '#0a0c0b', 0.5);
}
