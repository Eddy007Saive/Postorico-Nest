import { accDark, inkOn, mix } from './color.util';
import { avSpan, CarrouselContentShape, duotoneSvg, esc, iconB64, parts, twoTone } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Port direct de `_tpl_neon` (backend/services/carrousel_service.py). */
export function tplNeon(
  content: CarrouselContentShape,
  p: string | undefined,
  _s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const pp = p || '#0b1c44';
  const A = a || '#2f7bff';
  const acc = accDark(A);
  const D1 = mix(pp, '#0a1430', 0.3);
  const D2 = mix(pp, '#04060e', 0.72);
  const gc = 'rgba(255,255,255,.05)';
  const bg =
    `linear-gradient(${gc} 1px,transparent 1px),linear-gradient(90deg,${gc} 1px,transparent 1px),` +
    `linear-gradient(155deg,${D1},${D2})`;
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const initial = (nom || '?')[0].toUpperCase();
  const head =
    '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:40px 38px;color:#eaf1ff;
    background-image:${bg};background-size:30px 30px,30px 30px,100% 100%}
  .slide::after{content:"";position:absolute;width:420px;height:420px;right:-130px;top:40px;border-radius:50%;background:radial-gradient(circle,${mix(acc, '#000000', 0.1)}33,transparent 70%);pointer-events:none}
  .top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:2}
  .brand{display:flex;align-items:center;gap:9px;font-family:Sora;font-weight:800;font-size:15px;letter-spacing:.4px}
  .av{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-family:Sora;font-weight:800;font-size:14px;overflow:hidden}
  .cnt{font-family:Sora;font-weight:800;font-size:14px;color:${acc}}
  .grow{flex:1;overflow:hidden}
  .num{font-family:Sora;font-weight:800;font-size:96px;line-height:.8;letter-spacing:-4px;color:transparent;-webkit-text-stroke:2.5px ${acc}}
  .row2{display:flex;align-items:flex-start;gap:16px;position:relative;z-index:2}
  h1{font-family:Sora;font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.5px;text-transform:uppercase;position:relative;z-index:2}
  h2{font-family:Sora;font-weight:800;font-size:27px;line-height:1.04;letter-spacing:-.3px;text-transform:uppercase;margin-top:6px}
  .line{width:46px;height:3px;background:${acc};border-radius:3px;margin:14px 0 12px;position:relative;z-index:2}
  p{font-size:15px;line-height:1.5;color:#9fb0cf;position:relative;z-index:2}
  .btn{align-self:flex-start;background:${acc};color:${inkOn(acc)};font-family:Sora;font-weight:800;font-size:14px;padding:12px 22px;border-radius:10px;margin-top:16px;position:relative;z-index:2}
</style>`;
  const av = avSpan(logo, initial, acc, inkOn(acc));
  const duo = duotoneSvg(acc);
  const top = (i: number) =>
    `<div class="top"><div class="brand">${av}<span>${esc(nom)}</span></div><span class="cnt">${i + 1}/${n}</span></div>`;

  const illus = (sl: { icon?: string }) => {
    const ic = iconB64(sl.icon);
    if (!ic) return '';
    return (
      `<div style="position:absolute;right:20px;bottom:46px;width:150px;z-index:1;pointer-events:none">` +
      `<div style="position:absolute;right:-30px;bottom:-30px;width:210px;height:210px;border-radius:50%;background:radial-gradient(circle,${acc}40,transparent 70%)"></div>` +
      `<img src="data:image/png;base64,${ic}" style="position:relative;width:150px;display:block;opacity:.92;filter:url(#ic3d) drop-shadow(0 0 18px ${acc}aa)"></div>`
    );
  };
  const out = [
    `<div class="slide">${top(0)}<div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h1>${twoTone(hook, acc)}</h1><div class="line"></div></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const body = sl.texte ? `<p>${esc(sl.texte)}</p>` : '';
    out.push(
      `<div class="slide">${top(i + 1)}` +
        illus(sl) +
        `<div style="position:relative;z-index:2;margin-top:18px"><div class="num">${String(i + 1).padStart(2, '0')}</div>` +
        `<h2 style="margin-top:4px">${twoTone(sl.titre, acc)}</h2><div class="line"></div></div>` +
        `<div style="flex:1;position:relative;z-index:2">${body}</div>` +
        '</div>',
    );
  });
  out.push(
    `<div class="slide">${top(n - 1)}<div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h1>${twoTone(cta.titre, acc)}</h1><div class="line"></div>` +
      (cta.texte ? `<p>${esc(cta.texte)}</p>` : '') +
      '<span class="btn">Lien en bio →</span></div></div>',
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${duo}${out.join('')}</body></html>`;
}
