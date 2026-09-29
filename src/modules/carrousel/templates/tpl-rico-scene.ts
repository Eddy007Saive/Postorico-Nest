import { accDark, darken } from './color.util';
import { accrocheMint, CarrouselContentShape, dots, esc, fitFs, GRAIN, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/**
 * « Rico Scène » — sombre spectaculaire. Rico est éclairé comme sur une scène : un
 * cône de lumière descend sur lui, le texte occupe le haut. Port direct de
 * `_tpl_rico_scene` (backend/services/carrousel_service.py).
 *
 * `poseUrls` : une URL de pose Rico par index de slide, déjà résolue par
 * RicoPosesService en amont (voir tpl-rico-studio.ts).
 */
export function tplRicoScene(
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  _logo: string | null | undefined,
  poseUrls: string[],
): string {
  const P = p || '#5B6CFF';
  const S = s || '#8A6CFF';
  const A = accDark(a || '#3AFFA3');
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;

  const rico = (classe: string, i: number) =>
    `<div class="scene ${classe}"><span class="halo"></span><span class="sol"></span>` +
    `<img class="masc" src="${poseUrls[i]}" alt=""></div>`;

  const marque = _logo
    ? `<span class="lg"><img src="${_logo}" alt=""></span>`
    : `<span class="lg ini">${esc((nom || '?')[0].toUpperCase())}</span>`;
  const head =
    '<link href="https://fonts.googleapis.com/css2?' +
    'family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';

  const css =
    '<style>*{box-sizing:border-box;margin:0}body{margin:0;font-family:Inter,sans-serif}' +
    `.slide{width:${SLIDE_W}px;height:${SLIDE_H}px;position:relative;overflow:hidden;background:#05060C;` +
    'color:#F4F7FF;display:flex;flex-direction:column;padding:26px 26px 48px}' +
    `.beam{position:absolute;left:50%;top:-60px;width:300px;height:430px;transform:translateX(-50%);` +
    `background:conic-gradient(from 180deg at 50% 0%,transparent 42%,${S}2e 50%,transparent 58%);` +
    'filter:blur(14px);opacity:.9}' +
    `.aura{position:absolute;width:430px;height:430px;border-radius:50%;left:50%;bottom:-200px;` +
    `transform:translateX(-50%);background:radial-gradient(circle,${P}44,transparent 66%);filter:blur(40px)}` +
    `.grain{position:absolute;inset:0;opacity:.5;mix-blend-mode:overlay;background-image:${GRAIN}}` +
    '.vig{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,transparent 34%,rgba(2,3,8,.86) 100%)}' +
    '.top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:6}' +
    '.brand{display:flex;align-items:center;gap:8px}' +
    '.lg{width:25px;height:25px;border-radius:50%;overflow:hidden;display:grid;place-items:center;flex:none}' +
    '.lg img{width:100%;height:100%;object-fit:cover;display:block}' +
    `.lg.ini{background:linear-gradient(135deg,${P},${S});color:#fff;font-family:Sora;font-weight:800;font-size:12px}` +
    '.brand b{font-family:Sora;font-weight:700;font-size:13.5px;letter-spacing:-.2px}' +
    `.idx{font-family:Sora;font-weight:700;font-size:12px;color:${A};font-variant-numeric:tabular-nums}` +
    '.haut{position:relative;z-index:6;margin-top:20px}' +
    'h1{font-family:Sora;font-weight:800;font-size:36px;line-height:1.03;letter-spacing:-1.4px;text-transform:uppercase}' +
    'h2{font-family:Sora;font-weight:800;font-size:26px;line-height:1.08;letter-spacing:-.7px;text-transform:uppercase}' +
    '.sub{font-size:12.5px;line-height:1.6;color:#93A0C4;margin-top:11px;max-width:94%}' +
    `.etape{display:inline-flex;align-items:center;gap:7px;font-family:Sora;font-weight:800;font-size:10px;` +
    `letter-spacing:1.6px;text-transform:uppercase;color:${A};margin-bottom:11px}` +
    `.etape span{display:block;width:22px;height:1.5px;background:${A}}` +
    '.pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}' +
    '.pill{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#DCE4FA;' +
    'border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);padding:5px 10px;border-radius:999px}' +
    `.tip{margin-top:13px;padding-left:11px;border-left:2px solid ${A}}` +
    `.tip .lbl{font-size:8.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:${A}}` +
    '.tip p{font-size:11.5px;line-height:1.5;color:#93A0C4;margin-top:3px}' +
    '.scene{position:absolute;left:0;right:0;bottom:26px;height:262px;z-index:4;display:flex;' +
    'align-items:flex-end;justify-content:center}' +
    `.halo{position:absolute;bottom:52px;width:220px;height:220px;border-radius:50%;` +
    `background:radial-gradient(circle,${A}30,transparent 64%);filter:blur(26px)}` +
    '.sol{position:absolute;bottom:44px;width:190px;height:22px;border-radius:50%;' +
    'background:radial-gradient(ellipse,rgba(0,0,0,.62),transparent 70%);filter:blur(7px)}' +
    '.masc{position:relative;filter:drop-shadow(0 16px 26px rgba(0,0,0,.6))}' +
    '.scene.grande{height:300px} .scene.grande .masc{height:284px}' +
    '.scene.moyenne .masc{height:164px}' +
    '.scene.petite{height:210px} .scene.petite .masc{height:146px}' +
    '.voile{position:absolute;left:0;right:0;bottom:0;height:78px;z-index:5;background:linear-gradient(transparent,rgba(5,6,12,.92) 64%)}' +
    '.bar{position:absolute;left:0;right:0;bottom:0;z-index:6;display:flex;align-items:center;' +
    'justify-content:space-between;padding:0 26px 18px}' +
    '.hd{font-size:9px;color:#7C89AE;font-weight:500}' +
    '.dots{display:flex;gap:5px;align-items:center}' +
    '.dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.18)}' +
    `.dots i.on{width:18px;border-radius:3px;background:${A}}` +
    `.swipe{font-size:9.5px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${A}}` +
    `.cta{background:radial-gradient(ellipse at 50% 0%,${S} 0%,${darken(P, 0.45)} 62%,#05060C 100%)}` +
    '.cta .sub{color:rgba(255,255,255,.88)} .cta .hd{color:rgba(255,255,255,.7)}' +
    `.btn{display:inline-block;margin-top:16px;background:${A};color:#04301F;font-family:Sora;` +
    'font-weight:800;font-size:12.5px;padding:12px 21px;border-radius:11px}' +
    '</style>';
  const fond =
    '<div class="beam"></div><div class="aura"></div><div class="vig"></div>' +
    '<div class="grain"></div><div class="voile"></div>';
  const marqueHtml = `<div class="brand">${marque}<b>${esc(nom)}</b></div>`;

  const out = [
    `<div class="slide">${fond}${rico('grande', 0)}` +
      `<div class="top">${marqueHtml}<span class="idx">1/${n}</span></div>` +
      `<div class="haut"><h1 style="font-size:${fitFs(hook, 36)}px">${accrocheMint(hook, A)}</h1></div>` +
      `<div class="bar"><span class="hd">${esc(secteur)}</span><span class="swipe">Swipe &#8594;</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const taille = i % 2 ? 'petite' : 'moyenne'; // l'échelle varie : la série respire
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    const tip = sl.pro_tip ? `<div class="tip"><span class="lbl">Le geste</span><p>${esc(sl.pro_tip)}</p></div>` : '';
    const txt = sl.texte ? `<p class="sub">${esc(sl.texte)}</p>` : '';
    out.push(
      `<div class="slide">${fond}${rico(taille, i + 1)}` +
        `<div class="top">${marqueHtml}<span class="idx">${i + 2}/${n}</span></div>` +
        `<div class="haut"><div class="etape"><span></span>Étape ${String(i + 1).padStart(2, '0')}</div>` +
        `<h2 style="font-size:${fitFs(sl.titre, 26)}px">${esc(sl.titre)}</h2>${txt}${pl}${tip}</div>` +
        `<div class="bar"><div class="dots">${dots(n, i + 1)}</div><span class="hd">${esc(nom)}</span></div></div>`,
    );
  });
  out.push(
    `<div class="slide cta"><div class="grain"></div>${rico('grande', slides.length + 1)}` +
      `<div class="top">${marqueHtml}<span class="idx" style="color:#fff">${n}/${n}</span></div>` +
      `<div class="haut"><h2 style="font-size:${fitFs(cta.titre, 26)}px">${accrocheMint(cta.titre, A)}</h2>` +
      (cta.texte ? `<p class="sub">${esc(cta.texte)}</p>` : '') +
      '<span class="btn">Lien en bio &#8594;</span></div>' +
      `<div class="bar"><span class="hd">${esc(secteur)}</span><div class="dots">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
