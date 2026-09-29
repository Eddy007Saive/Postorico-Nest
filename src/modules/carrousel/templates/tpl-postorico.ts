import { accDark, darken } from './color.util';
import { accrocheMint, CarrouselContentShape, dots, esc, fitFs, GRAIN, hexesSvg, mascotteB64, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/**
 * Template EXCLUSIF « Postorico » — univers de la mascotte. Nuit profonde + hexagones +
 * halos ; mascotte sur la couverture et la finale. Port direct de `_tpl_postorico`
 * (backend/services/carrousel_service.py). Réservé aux comptes à qui un admin l'a attribué.
 */
export function tplPostorico(
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
): string {
  const P = p || '#5B6CFF';
  const S = s || '#8A6CFF';
  const Acc = accDark(a || '#3AFFA3');
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const initial = (nom || '?')[0].toUpperCase();
  const b64 = mascotteB64();
  const masc = b64 ? `<img class="masc" src="data:image/png;base64,${b64}" alt="">` : '';
  const marque = logo ? `<span class="lg"><img src="${logo}" alt=""></span>` : `<span class="lg ini">${esc(initial)}</span>`;
  const head =
    '<link href="https://fonts.googleapis.com/css2?' +
    'family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';

  const css =
    '<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}' +
    `.slide{width:${SLIDE_W}px;height:${SLIDE_H}px;position:relative;overflow:hidden;background:#070A14;` +
    'color:#F3F6FF;display:flex;flex-direction:column;padding:26px 26px 52px}' +
    '.glow{position:absolute;border-radius:50%;filter:blur(70px)}' +
    `.glow.v{width:420px;height:420px;top:-190px;left:-150px;background:radial-gradient(circle,${S},transparent 66%);opacity:.46}` +
    `.glow.m{width:360px;height:360px;bottom:-180px;right:-120px;background:radial-gradient(circle,${Acc},transparent 66%);opacity:.20}` +
    '.hexes{position:absolute;inset:0;width:100%;height:100%}' +
    `.grain{position:absolute;inset:0;opacity:.45;mix-blend-mode:overlay;background-image:${GRAIN}}` +
    '.vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 42%,transparent 42%,rgba(2,4,10,.72) 100%)}' +
    '.top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:3}' +
    '.brand{display:flex;align-items:center;gap:8px}' +
    '.lg{width:26px;height:26px;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:none}' +
    '.lg img{width:100%;height:100%;object-fit:cover;display:block}' +
    `.lg.ini{background:linear-gradient(135deg,${P},${S});color:#06090f;font-family:Sora;font-weight:800;font-size:12px}` +
    '.brand b{font-family:Sora;font-weight:700;font-size:14px;letter-spacing:-.2px}' +
    `.idx{font-family:Sora;font-weight:700;font-size:13px;color:${Acc};font-variant-numeric:tabular-nums}` +
    '.grow{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative;z-index:3}' +
    'h1{font-family:Sora;font-weight:800;font-size:37px;line-height:1.04;letter-spacing:-1.2px;text-transform:uppercase}' +
    'h2{font-family:Sora;font-weight:800;font-size:27px;line-height:1.08;letter-spacing:-.6px;text-transform:uppercase}' +
    '.sub{font-size:13px;line-height:1.6;color:#8E9ABC;margin-top:12px;max-width:88%}' +
    `.ul{width:52px;height:4px;border-radius:2px;background:${Acc};margin-top:18px}` +
    '.num{font-family:Sora;font-weight:800;font-size:76px;line-height:.9;letter-spacing:-3px;color:transparent;' +
    `-webkit-text-stroke:2.5px ${Acc};margin-bottom:6px}` +
    '.pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:15px}' +
    '.pill{font-size:9.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:#F3F6FF;' +
    'border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);padding:6px 10px;border-radius:999px}' +
    `.tip{margin-top:16px;padding-left:12px;border-left:2px solid ${Acc}}` +
    `.tip .lbl{font-size:9px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:${Acc}}` +
    '.tip p{font-size:12px;line-height:1.5;color:#8E9ABC;margin-top:4px}' +
    '.masc{position:absolute;bottom:26px;right:-34px;height:206px;z-index:2;filter:drop-shadow(0 22px 34px rgba(0,0,0,.6))}' +
    '.cta .masc{height:188px;right:-36px;bottom:34px}' +
    '.has-masc .grow{max-width:63%} .has-masc h1{font-size:34px} .has-masc h2{font-size:25px}' +
    '.has-masc .sub{max-width:100%}' +
    '.cta .grow{max-width:70%} .cta h2{font-size:23px;line-height:1.12}' +
    '.bar{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;align-items:center;' +
    'justify-content:space-between;padding:0 26px 20px}' +
    '.hd{font-size:9.5px;color:#8E9ABC;font-weight:500}' +
    '.dots{display:flex;gap:5px;align-items:center}' +
    '.dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.18)}' +
    `.dots i.on{width:19px;border-radius:3px;background:${Acc}}` +
    `.swipe{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${Acc}}` +
    `.cta{background:linear-gradient(150deg,${darken(P, 0.55)} 0%,${P} 48%,${S} 100%)}` +
    '.cta .sub{color:rgba(255,255,255,.84)} .cta .hd{color:rgba(255,255,255,.68)}' +
    '.cta .dots i{background:rgba(255,255,255,.3)}' +
    `.btn{align-self:flex-start;margin-top:20px;background:${Acc};color:#04301F;font-family:Sora;` +
    'font-weight:700;font-size:12.5px;padding:12px 20px;border-radius:11px}' +
    '</style>';

  const hexes = hexesSvg(S, Acc);
  const fonds = `<div class="glow v"></div><div class="glow m"></div>${hexes}<div class="vig"></div><div class="grain"></div>`;
  const marqueHtml = `<div class="brand">${marque}<b>${esc(nom)}</b></div>`;

  const out = [
    `<div class="slide has-masc">${fonds}${masc}` +
      `<div class="top">${marqueHtml}<span class="idx">1/${n}</span></div>` +
      `<div class="grow"><h1 style="font-size:${fitFs(hook, 34)}px">${accrocheMint(hook, Acc)}</h1>` +
      '<div class="ul"></div></div>' +
      `<div class="bar"><span class="hd">${esc(secteur)}</span><span class="swipe">Swipe &#8594;</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    const tip = sl.pro_tip ? `<div class="tip"><span class="lbl">Pro tip</span><p>${esc(sl.pro_tip)}</p></div>` : '';
    const txt = sl.texte ? `<p class="sub">${esc(sl.texte)}</p>` : '';
    out.push(
      `<div class="slide">${fonds}` +
        `<div class="top">${marqueHtml}<span class="idx">${i + 2}/${n}</span></div>` +
        `<div class="grow"><div class="num">${String(i + 1).padStart(2, '0')}</div>` +
        `<h2 style="font-size:${fitFs(sl.titre, 27)}px">${esc(sl.titre)}</h2>${txt}${pl}${tip}</div>` +
        `<div class="bar"><div class="dots">${dots(n, i + 1)}</div><span class="hd">${esc(nom)}</span></div></div>`,
    );
  });
  out.push(
    `<div class="slide cta has-masc"><div class="glow m"></div>${hexes}<div class="grain"></div>${masc}` +
      `<div class="top">${marqueHtml}<span class="idx" style="color:#fff">${n}/${n}</span></div>` +
      `<div class="grow"><h2 style="font-size:${fitFs(cta.titre, 23)}px">${accrocheMint(cta.titre, Acc)}</h2>` +
      (cta.texte ? `<p class="sub">${esc(cta.texte)}</p>` : '') +
      '<span class="btn">Lien en bio &#8594;</span></div>' +
      `<div class="bar"><span class="hd">${esc(secteur)}</span><div class="dots">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
