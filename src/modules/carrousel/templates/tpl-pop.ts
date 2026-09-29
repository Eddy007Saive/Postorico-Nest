import { inkOn, near } from './color.util';
import { avSpan, CarrouselContentShape, esc, fitFs, parts } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Port direct de `_tpl_pop` (backend/services/carrousel_service.py). */
export function tplPop(
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const pp = p || '#003D2E';
  const ss = s || '#0077FF';
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const Sink = inkOn(ss);
  const NEAR = near(pp);
  const [hook, slides, cta] = parts(content);
  const head =
    '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:32px 30px 30px}
  .top{display:flex;align-items:center;justify-content:space-between}
  .badge{font-family:Sora;font-weight:800;font-size:12px;padding:5px 11px;border-radius:30px}
  .grow{flex:1;overflow:hidden}
  h1{font-family:Sora;font-weight:800;font-size:37px;line-height:1.04;letter-spacing:-1px}
  h2{font-family:Sora;font-weight:800;font-size:26px;line-height:1.08;letter-spacing:-.5px;margin-bottom:10px}
  p{font-size:14px;line-height:1.5;font-weight:500;opacity:.92}
  .num{font-family:Sora;font-weight:800;font-size:84px;line-height:.8;letter-spacing:-3px;opacity:.16}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .pill{font-size:10px;font-weight:700;text-transform:uppercase;padding:5px 10px;border-radius:30px}
  .foot{display:flex;align-items:center;gap:9px;font-family:Sora;font-weight:700;font-size:14px;margin-top:12px}
  .av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:Sora;font-size:14px}
  .swipe{font-family:Sora;font-weight:800;font-size:13px}
  .cta-btn{display:inline-flex;align-items:center;gap:8px;font-family:Sora;font-weight:800;font-size:15px;padding:13px 24px;border-radius:14px;margin-top:16px;width:max-content}
</style>`;
  const av = avSpan(logo, (nom || '?')[0].toUpperCase(), Aink, A);
  const out = [
    `<div class="slide" style="background:${A};color:${Aink}"><div class="top"><span class="badge" style="background:${Aink};color:${A}">Carrousel</span><span class="swipe">SWIPE →</span></div><div class="grow" style="display:flex;align-items:center"><h1 style="font-size:${fitFs(hook, 37)}px">${esc(hook)}</h1></div><div class="foot">${av}<div>${esc(nom)}</div></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const acc = i % 2 === 0;
    const bg = acc ? A : NEAR;
    const ink = acc ? Aink : '#fff';
    const bstyle = acc ? `background:${NEAR};color:#fff` : `background:${A};color:${Aink}`;
    const pbg = acc ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.16)';
    const pl = sl.pills
      ? `<div class="pills">${sl.pills
          .slice(0, 4)
          .map((x) => `<span class="pill" style="background:${pbg};color:${ink}">${esc(x)}</span>`)
          .join('')}</div>`
      : '';
    out.push(
      `<div class="slide" style="background:${bg};color:${ink}"><span class="badge" style="${bstyle};align-self:flex-start">Étape ${String(i + 1).padStart(2, '0')}</span><div class="num" style="margin-top:auto;color:${ink}">${String(i + 1).padStart(2, '0')}</div><h2>${esc(sl.titre)}</h2>${pl}</div>`,
    );
  });
  out.push(
    `<div class="slide" style="background:${ss};color:${Sink}"><span class="badge" style="background:${Sink};color:${ss};align-self:flex-start">À toi</span><div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h2>${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p>${esc(cta.texte)}</p>` : '') +
      `<span class="cta-btn" style="background:${Sink};color:${ss}">Lien en bio →</span></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
