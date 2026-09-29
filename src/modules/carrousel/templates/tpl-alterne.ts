import { accDark, accLight, inkOn, lighten, mix, near } from './color.util';
import { avSpan, CarrouselContentShape, dots, esc, fitFs, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Port direct de `_tpl_alterne` (backend/services/carrousel_service.py) : alterne
 * fond clair/sombre slide après slide. */
export function tplAlterne(
  content: CarrouselContentShape,
  p: string | undefined,
  _s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const pp = p || '#003D2E';
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const CREAM = lighten(pp, 0.93);
  const CLINE = mix(pp, '#ffffff', 0.78);
  const NEAR = near(pp);
  const accL = accLight(A);
  const accD = accDark(A);
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const initial = (nom || '?')[0].toUpperCase();
  const av = avSpan(logo, initial, A, Aink);
  const css = `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
  *{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:34px 30px 56px}
  .lt{background:${CREAM};color:#14201b} .dk{background:${NEAR};color:#fff}
  .tag{align-self:flex-start;background:${A};color:${Aink};font-weight:700;font-size:11px;letter-spacing:2px;padding:6px 12px;border-radius:6px;text-transform:uppercase}
  .grow{flex:1;overflow:hidden}
  h1{font-family:Anton;font-size:50px;line-height:.96;text-transform:uppercase;margin-top:16px}
  h2{font-family:Anton;font-size:39px;line-height:.97;text-transform:uppercase;margin:12px 0}
  .pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px}
  .pill{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;background:${A};color:${Aink};padding:6px 11px;border-radius:6px}
  .protip{margin-top:15px;padding-top:12px} .lt .protip{border-top:1px solid ${CLINE}} .dk .protip{border-top:1px solid rgba(255,255,255,.15)}
  .protip .lbl{font-size:10px;font-weight:700;letter-spacing:2px;color:${Aink};background:${A};display:inline-block;padding:3px 8px;border-radius:4px;text-transform:uppercase}
  .protip p{font-size:13px;line-height:1.5;margin-top:7px} .lt .protip p{color:#5d655e} .dk .protip p{color:rgba(255,255,255,.66)}
  .bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;padding:0 30px 22px}
  .dots{display:flex;gap:6px} .dots i{width:7px;height:7px;border-radius:50%} .lt .dots i{background:${CLINE}} .dk .dots i{background:rgba(255,255,255,.2)}
  .lt .dots i.on{width:22px;border-radius:5px;background:${accL}} .dk .dots i.on{width:22px;border-radius:5px;background:${accD}}
  .swipe{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${accL}}
  .cnt{font-size:11px;font-weight:600} .lt .cnt{color:#5d655e} .dk .cnt{color:rgba(255,255,255,.6)}
  .foot{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600}
  .av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:Anton;font-size:14px}
  .foot small{font-weight:500;display:block;font-size:11px} .lt .foot small{color:#5d655e} .dk .foot small{color:rgba(255,255,255,.66)}
  .cta-btn{align-self:flex-start;background:${A};color:${Aink};font-weight:700;font-size:14px;padding:13px 24px;border-radius:8px;margin-top:18px;text-transform:uppercase;letter-spacing:.5px}
</style>`;
  const out = [
    `<div class="slide lt"><span class="tag">Carrousel</span><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h1 style="font-size:${fitFs(hook, 50)}px">${esc(hook)}</h1></div><div class="bar"><div class="foot">${av}<div>${esc(nom)}<small>${esc(secteur)}</small></div></div><span class="swipe">Swipe →</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const kind = i % 2 === 0 ? 'dk' : 'lt';
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    const protip = sl.pro_tip ? `<div class="protip"><span class="lbl">Pro tip</span><p>${esc(sl.pro_tip)}</p></div>` : '';
    out.push(
      `<div class="slide ${kind}"><span class="tag">Étape ${String(i + 1).padStart(2, '0')}</span><div class="grow"></div><h2 style="font-size:${fitFs(sl.titre, 39)}px">${esc(sl.titre)}</h2>${pl}${protip}<div class="bar"><div class="dots">${dots(n, i + 1)}</div><span class="cnt">${i + 2}/${n}</span></div></div>`,
    );
  });
  out.push(
    `<div class="slide lt"><span class="tag">À toi de jouer</span><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h2 style="font-size:${fitFs(cta.titre, 39)}px">${esc(cta.titre)}</h2><span class="cta-btn">Lien en bio →</span></div><div class="bar"><div class="foot">${av}<div>${esc(nom)}<small>${esc(secteur)}</small></div></div><div class="dots">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body>${out.join('')}</body></html>`;
}
