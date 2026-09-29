import { accDark, accLight, inkOn, lighten, mix, near } from './color.util';
import { avSpan, CarrouselContentShape, dots, esc, fitFs, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/**
 * Famille référence (Anton condensé + bandeau étape + pills + PRO TIP) — port direct
 * de `_ref` (backend/services/carrousel_service.py), partagée par les templates
 * « creme » et « sombre ».
 */
function ref(
  content: unknown,
  a: string,
  nom: string,
  secteur: string,
  logo: string | null | undefined,
  bg: string,
  bg2: string,
  ink: string,
  mut: string,
  line: string,
  accentText: string,
): string {
  const A = a;
  const Aink = inkOn(A);
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const initial = (nom || '?')[0].toUpperCase();
  const foot =
    `<div class="foot" style="color:${ink}">${avSpan(logo, initial, A, Aink)}` +
    `<div><div class="nm">${esc(nom)}</div><div class="hd" style="color:${mut}">${esc(secteur)}</div></div></div>`;
  const css = `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
  *{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;background:${bg};color:${ink};overflow:hidden;position:relative;display:flex;flex-direction:column;padding:34px 30px 56px}
  .cta-slide{background:${bg2}}
  .tag{align-self:flex-start;background:${A};color:${Aink};font-weight:700;font-size:11px;letter-spacing:2px;padding:6px 12px;border-radius:6px;text-transform:uppercase}
  .grow{flex:1;overflow:hidden}
  h1{font-family:Anton;font-size:50px;line-height:.96;letter-spacing:.3px;text-transform:uppercase;margin-top:16px}
  h2{font-family:Anton;font-size:39px;line-height:.97;letter-spacing:.3px;text-transform:uppercase;margin:12px 0}
  .sub{font-size:15px;color:${mut};line-height:1.5;margin-top:13px;max-width:90%}
  .pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px}
  .pill{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;background:${A};color:${Aink};padding:6px 11px;border-radius:6px}
  .protip{margin-top:15px;border-top:1px solid ${line};padding-top:12px}
  .protip .lbl{font-size:10px;font-weight:700;letter-spacing:2px;color:${Aink};background:${A};display:inline-block;padding:3px 8px;border-radius:4px;text-transform:uppercase}
  .protip p{font-size:13px;color:${mut};line-height:1.5;margin-top:7px}
  .bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;padding:0 30px 22px}
  .dots{display:flex;gap:6px} .dots i{width:7px;height:7px;border-radius:50%;background:${line}} .dots i.on{background:${accentText};width:22px;border-radius:5px}
  .swipe{font-size:11px;font-weight:700;letter-spacing:1.5px;color:${accentText};text-transform:uppercase}
  .cnt{font-size:11px;color:${mut};font-weight:600}
  .foot{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600}
  .av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:Anton;font-size:14px}
  .foot .nm{font-weight:600} .foot .hd{font-size:11px;font-weight:500}
  .cta-btn{align-self:flex-start;background:${A};color:${Aink};font-weight:700;font-size:14px;padding:13px 24px;border-radius:8px;margin-top:18px;text-transform:uppercase;letter-spacing:.5px}
</style>`;
  const out = [
    `<div class="slide"><span class="tag">Carrousel</span><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h1 style="font-size:${fitFs(hook, 50)}px">${esc(hook)}</h1></div><div class="bar">${foot}<span class="swipe">Swipe →</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    const protip = sl.pro_tip ? `<div class="protip"><span class="lbl">Pro tip</span><p>${esc(sl.pro_tip)}</p></div>` : '';
    const txt = sl.texte && !protip && !pl ? `<p class="sub">${esc(sl.texte)}</p>` : '';
    out.push(
      `<div class="slide"><span class="tag">Étape ${String(i + 1).padStart(2, '0')}</span><div class="grow"></div><h2 style="font-size:${fitFs(sl.titre, 39)}px">${esc(sl.titre)}</h2>${txt}${pl}${protip}<div class="bar"><div class="dots">${dots(n, i + 1)}</div><span class="cnt">${i + 2}/${n}</span></div></div>`,
    );
  });
  out.push(
    `<div class="slide cta-slide"><span class="tag">À toi de jouer</span><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h2 style="font-size:${fitFs(cta.titre, 39)}px">${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p class="sub">${esc(cta.texte)}</p>` : '') +
      `<span class="cta-btn">Lien en bio →</span></div><div class="bar">${foot}<div class="dots">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body>${out.join('')}</body></html>`;
}

export function tplCreme(
  content: CarrouselContentShape,
  p: string | undefined,
  _s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const pp = p || '#003D2E';
  return ref(
    content,
    a || '#3AFFA3',
    nom,
    secteur,
    logo,
    lighten(pp, 0.93),
    lighten(pp, 0.88),
    '#14201b',
    '#5d655e',
    mix(pp, '#ffffff', 0.78),
    accLight(a || '#3AFFA3'),
  );
}

export function tplSombre(
  content: CarrouselContentShape,
  p: string | undefined,
  _s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const pp = p || '#003D2E';
  return ref(
    content,
    a || '#3AFFA3',
    nom,
    secteur,
    logo,
    near(pp),
    mix(pp, '#0a0c0b', 0.62),
    '#ffffff',
    'rgba(255,255,255,.66)',
    'rgba(255,255,255,.15)',
    accDark(a || '#3AFFA3'),
  );
}
