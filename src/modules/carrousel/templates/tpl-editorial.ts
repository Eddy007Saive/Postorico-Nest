import { accDark, accLight, inkOn, lighten, near } from './color.util';
import { avSpan, CarrouselContentShape, esc, parts } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Port direct de `_tpl_editorial` (backend/services/carrousel_service.py). */
export function tplEditorial(
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
  const CREAM = lighten(pp, 0.94);
  const NEAR = near(pp);
  const accL = accLight(A);
  const accD = accDark(A);
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const head =
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:36px 32px 50px}
  .lt{background:${CREAM};color:#14201b} .dk{background:${NEAR};color:#fff}
  .rule{height:1px;background:currentColor;opacity:.18;margin:13px 0}
  .kick{font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:600;opacity:.6}
  .grow{flex:1;overflow:hidden}
  h1{font-family:Fraunces;font-weight:600;font-size:36px;line-height:1.08}
  h2{font-family:Fraunces;font-weight:600;font-size:27px;line-height:1.13;margin-bottom:10px}
  p{font-size:14px;line-height:1.55;opacity:.8}
  .num{font-family:Fraunces;font-weight:500;font-size:42px;line-height:1;margin-bottom:6px}
  .foot{display:flex;align-items:center;gap:9px;font-size:12px}
  .av{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-family:Fraunces;font-weight:600;font-size:13px}
  .cta-chip{display:inline-block;margin-top:16px;padding:9px 18px;border-radius:30px;font-size:13px;font-weight:600;border:1.5px solid ${accL};color:${accL}}
</style>`;
  const av = avSpan(logo, (nom || '?')[0].toUpperCase(), A, inkOn(A));
  const out = [
    `<div class="slide lt"><div class="kick">Carrousel</div><div class="rule"></div><div class="grow" style="display:flex;align-items:center"><h1>${esc(hook)}</h1></div><div class="rule"></div><div class="foot">${av}<div><b>${esc(nom)}</b> · ${esc(secteur)}</div></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const dk = i % 2 === 0;
    const kind = dk ? 'dk' : 'lt';
    const acc = dk ? accD : accL;
    out.push(
      `<div class="slide ${kind}"><div style="display:flex;justify-content:space-between"><span class="kick">Idée ${String(i + 1).padStart(2, '0')}</span><span class="kick">${String(i + 2).padStart(2, '0')} / ${String(n).padStart(2, '0')}</span></div><div class="grow"></div><div class="num" style="color:${acc}">${String(i + 1).padStart(2, '0')}</div><h2>${esc(sl.titre)}</h2>` +
        (sl.texte ? `<p>${esc(sl.texte)}</p>` : '') +
        '</div>',
    );
  });
  out.push(
    `<div class="slide lt"><div class="kick">À toi de jouer</div><div class="rule"></div><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h2>${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p>${esc(cta.texte)}</p>` : '') +
      '<span class="cta-chip">Lien en bio →</span></div><div class="rule"></div><div class="foot">' +
      av +
      `<div><b>${esc(nom)}</b> · ${esc(secteur)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
