import { accDark, accLight, inkOn, lighten, mix, near } from './color.util';
import { avSpan, CarrouselContentShape, esc, fitFs, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Port direct de `_tpl_clean` (backend/services/carrousel_service.py). */
export function tplClean(
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
  const LBG = lighten(pp, 0.93);
  const NEAR = near(pp);
  const accL = accLight(A);
  const accD = accDark(A);
  const grad = `linear-gradient(165deg,${NEAR},${mix(NEAR, A, 0.5)})`;
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const chev =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const head =
    '<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:'Plus Jakarta Sans',sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:34px 30px 50px}
  .lt{background:${LBG};color:#181a1f} .dk{background:${NEAR};color:#fff} .gr{background:${grad};color:#fff}
  .center{justify-content:center} .end{justify-content:flex-end} .grow{flex:1}
  .kick{font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:12px}
  h1{font-size:33px;font-weight:800;line-height:1.12;letter-spacing:-.5px}
  h2{font-size:25px;font-weight:700;line-height:1.16;margin-bottom:10px}
  p{font-size:14px;line-height:1.55} .lt p{color:rgba(0,0,0,.55)} .dk p,.gr p{color:rgba(255,255,255,.74)}
  .num{font-size:38px;font-weight:300;line-height:1;margin-bottom:6px}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .pill{font-size:10px;font-weight:700;text-transform:uppercase;padding:5px 10px;border-radius:20px}
  .lt .pill{background:${A};color:${Aink}} .dk .pill,.gr .pill{background:rgba(255,255,255,.12);color:#fff}
  .lockup{display:flex;align-items:center;gap:9px}
  .av{width:32px;height:32px;border-radius:50%;background:${A};color:${Aink};display:grid;place-items:center;font-weight:800;font-size:14px;overflow:hidden}
  .lk-nm{font-size:14px;font-weight:700} .lk-hd{font-size:11px;opacity:.6}
  .ctabtn{display:inline-flex;align-items:center;gap:7px;background:${LBG};color:${inkOn(LBG)};font-weight:700;font-size:14px;padding:11px 22px;border-radius:26px;width:max-content;margin-top:16px}
  .pbar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:0 30px 20px}
  .track{flex:1;height:4px;border-radius:9px;overflow:hidden} .lt .track{background:rgba(0,0,0,.08)} .dk .track,.gr .track{background:rgba(255,255,255,.16)}
  .fill{height:100%;border-radius:9px} .lt .fill{background:${accL}} .dk .fill,.gr .fill{background:#fff}
  .cnt{font-size:12px;font-weight:600} .lt .cnt{color:rgba(0,0,0,.35)} .dk .cnt,.gr .cnt{color:rgba(255,255,255,.5)}
  .swipe{position:absolute;top:0;right:0;bottom:0;width:44px;display:flex;align-items:center;justify-content:flex-end;padding-right:12px;color:rgba(0,0,0,.22)} .dk .swipe{color:rgba(255,255,255,.4)}
</style>`;
  const av = avSpan(logo, (nom || '?')[0].toUpperCase(), A, Aink);
  const pbar = (idx: number) =>
    `<div class="pbar"><div class="track"><div class="fill" style="width:${(((idx + 1) / n) * 100).toFixed(0)}%"></div></div><span class="cnt">${idx + 1}/${n}</span></div>`;
  const out = [
    `<div class="slide lt center"><div class="kick" style="color:${accL}">Carrousel</div><h1>${esc(hook)}</h1><div class="grow"></div><div class="lockup">${av}<div><div class="lk-nm">${esc(nom)}</div><div class="lk-hd">${esc(secteur)}</div></div></div><div class="swipe">${chev}</div>${pbar(0)}</div>`,
  ];
  slides.forEach((sl, i) => {
    const dk = i % 2 === 0;
    const kind = dk ? 'dk' : 'lt';
    const acc = dk ? accD : accL;
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    out.push(
      `<div class="slide ${kind} end"><div class="num" style="color:${acc}">${String(i + 1).padStart(2, '0')}</div><h2>${esc(sl.titre)}</h2>` +
        (sl.texte ? `<p>${esc(sl.texte)}</p>` : '') +
        pl +
        `<div class="swipe">${chev}</div>${pbar(i + 1)}</div>`,
    );
  });
  out.push(
    `<div class="slide gr center"><div class="lockup">${av}<div><div class="lk-nm">${esc(nom)}</div><div class="lk-hd" style="color:rgba(255,255,255,.7)">${esc(secteur)}</div></div></div><div class="grow"></div><h2>${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p>${esc(cta.texte)}</p>` : '') +
      `<span class="ctabtn">Lien en bio →</span>${pbar(n - 1)}</div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
