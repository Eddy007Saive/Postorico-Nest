import { readFileSync } from 'fs';
import { join } from 'path';
import { darken, inkOn, lighten, toRgb } from './color.util';

/** Aides communes aux templates de carrousel — port direct des petites fonctions
 * partagées de backend/services/carrousel_service.py (_esc, _av_span, _dots, _pills,
 * _fit_fs, _duotone_svg, _icon_b64, _two_tone, _accroche_mint, _parts, mascotte). */

export interface CarrouselSlide {
  titre?: string;
  texte?: string;
  pills?: string[];
  pro_tip?: string;
  icon?: string;
  /** Grand chiffre affiché par le template "chiffres" (ex. "92%", "3 000€/mois"). */
  chiffre?: string;
}

export interface CarrouselCta {
  titre?: string;
  texte?: string;
}

export interface CarrouselContentShape {
  hook?: string;
  legende?: string;
  slides?: CarrouselSlide[];
  cta?: CarrouselCta | string;
}

/** Équivalent de Python html.escape(t, quote=True).replace("\n","<br>"). */
export function esc(t?: string | null): string {
  return (t || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\n/g, '<br>');
}

export function avSpan(logo: string | null | undefined, initial: string, fallbackBg: string, ink: string): string {
  if (logo) {
    return (
      '<span class="av" style="overflow:hidden">' +
      `<img src="${logo}" style="width:100%;height:100%;object-fit:cover;display:block" alt=""></span>`
    );
  }
  return `<span class="av" style="background:${fallbackBg};color:${ink}">${esc(initial)}</span>`;
}

export function dots(n: number, idx: number): string {
  return Array.from({ length: n }, (_, k) => (k === idx ? '<i class="on"></i>' : '<i></i>')).join('');
}

export function pills(list?: string[]): string {
  return (list || []).slice(0, 4).map((p) => `<span class="pill">${esc(p)}</span>`).join('');
}

/** Réduit la taille de police selon la longueur du texte -> évite qu'un hook/titre
 * long déborde de sa zone et chevauche la barre du bas (avatar/swipe/dots). */
export function fitFs(text: string | undefined, base: number): number {
  const n = (text || '').length;
  if (n <= 28) return base;
  if (n <= 45) return Math.round(base * 0.8);
  if (n <= 65) return Math.round(base * 0.64);
  return Math.round(base * 0.52);
}

export function twoTone(t: string | undefined, acc: string): string {
  const w = (t || '').split(' ');
  if (w.length < 2) return `<span style="color:${acc}">${esc(t)}</span>`;
  const c = Math.floor((w.length + 1) / 2);
  return `${esc(w.slice(0, c).join(' '))} <span style="color:${acc}">${esc(w.slice(c).join(' '))}</span>`;
}

/** Dernier tiers du titre en accent : l'œil accroche la chute, pas le début. */
export function accrocheMint(t: string | undefined, acc: string): string {
  const w = (t || '').split(' ');
  if (w.length < 3) return `<span style="color:${acc}">${esc(t)}</span>`;
  const c = w.length - Math.max(1, Math.floor(w.length / 3));
  return `${esc(w.slice(0, c).join(' '))} <span style="color:${acc}">${esc(w.slice(c).join(' '))}</span>`;
}

export function duotoneSvg(acc: string): string {
  const dk = toRgb(darken(acc, 0.5));
  const lt = toRgb(lighten(acc, 0.3));
  const g = (v: number) => (v / 255).toFixed(3);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute">' +
    '<filter id="ic3d" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">' +
    '<feColorMatrix type="saturate" values="0"/>' +
    `<feComponentTransfer><feFuncR type="table" tableValues="${g(dk[0])} ${g(lt[0])}"/>` +
    `<feFuncG type="table" tableValues="${g(dk[1])} ${g(lt[1])}"/>` +
    `<feFuncB type="table" tableValues="${g(dk[2])} ${g(lt[2])}"/></feComponentTransfer></filter></svg>`
  );
}

const ICONS_DIR = join(process.cwd(), 'assets', 'carrousel', 'icons3d');
const MASCOTTE_PATH = join(process.cwd(), 'assets', 'carrousel', 'mascotte.png');
const iconCache = new Map<string, string | null>();
let mascotteCache: string | null | undefined;

export function iconB64(key?: string): string | null {
  if (!key) return null;
  if (iconCache.has(key)) return iconCache.get(key) ?? null;
  try {
    const b64 = readFileSync(join(ICONS_DIR, `${key}.png`)).toString('base64');
    iconCache.set(key, b64);
    return b64;
  } catch {
    iconCache.set(key, null);
    return null;
  }
}

/** Encodée une seule fois par process : elle est identique pour tous les rendus. */
export function mascotteB64(): string | null {
  if (mascotteCache !== undefined) return mascotteCache;
  try {
    mascotteCache = readFileSync(MASCOTTE_PATH).toString('base64');
  } catch {
    mascotteCache = null;
  }
  return mascotteCache;
}

export const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E" +
  "%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='.4'/%3E%3C/svg%3E\")";

/** Hexagones en contour, débordant volontairement du cadre — repris du rendu 3D. */
export function hexesSvg(s: string, a: string): string {
  return (
    '<svg class="hexes" viewBox="0 0 360 450" preserveAspectRatio="none">' +
    '<g fill="none" stroke-width="2">' +
    `<path d="M-46 88 l38-66 h76 l38 66 -38 66 h-76z" stroke="${s}" stroke-opacity=".85"/>` +
    `<path d="M6 216 l30-52 h60 l30 52 -30 52 h-60z" stroke="${s}" stroke-opacity=".45"/>` +
    `<path d="M-34 372 l26-45 h52 l26 45 -26 45 h-52z" stroke="${s}" stroke-opacity=".30"/>` +
    `<path d="M300 40 l34-59 h68 l34 59 -34 59 h-68z" stroke="${a}" stroke-opacity=".42"/>` +
    `<path d="M282 176 l26-45 h52 l26 45 -26 45 h-52z" stroke="${s}" stroke-opacity=".60"/>` +
    `<path d="M330 318 l30-52 h60 l30 52 -30 52 h-60z" stroke="${a}" stroke-opacity=".30"/>` +
    `<path d="M150 -40 l22-38 h44 l22 38 -22 38 h-44z" stroke="${s}" stroke-opacity=".35"/>` +
    '</g></svg>'
  );
}

/** Éclate un `content` (hook/slides/cta) en ses 3 parties, quelle que soit sa forme
 * (objet {hook,slides,cta} ou, pour compat, une liste plate de slides). */
export function parts(content: unknown): [string, CarrouselSlide[], Required<CarrouselCta>] {
  if (Array.isArray(content)) {
    const sl = (content as CarrouselSlide[]) || [];
    const hook = sl.length ? sl[0].titre || sl[0].texte || '' : '';
    const cta = (sl.length > 1 ? sl[sl.length - 1] : {}) as CarrouselSlide;
    return [
      hook,
      sl.slice(1, -1),
      { titre: cta.titre || 'On en parle ?', texte: (cta as CarrouselCta).texte || '' },
    ];
  }
  const c = (content || {}) as CarrouselContentShape;
  let cta = c.cta || {};
  if (typeof cta === 'string') cta = { titre: cta, texte: '' };
  return [c.hook || '', c.slides || [], { titre: cta.titre || 'On en parle ?', texte: cta.texte || '' }];
}

export { inkOn };
