import { accDark } from './color.util';
import { CarrouselContentShape, dots, esc, fitFs, GRAIN, parts, pills } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/**
 * « Rico Studio » — éditorial clair. Rico présente le sujet sur CHAQUE slide.
 * Contraste volontaire avec le sombre : c'est la vitrine haut de gamme. Port direct
 * de `_tpl_rico_studio` (backend/services/carrousel_service.py).
 *
 * `poseUrls` : une URL de pose Rico par index de slide (0 = couverture, dernier = CTA),
 * déjà résolue par RicoPosesService en amont (appel Claude) — ce fichier reste une
 * fonction pure, sans dépendance réseau.
 */
export function tplRicoStudio(
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo: string | null | undefined,
  poseUrls: string[],
): string {
  const P = p || '#5B6CFF';
  const S = s || '#8A6CFF';
  const A = a || '#3AFFA3';
  const ENCRE = '#12131A';
  const PAPIER = '#F6F3EA';
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;

  const rico = (classe: string, i: number) => `<img class="masc ${classe}" src="${poseUrls[i]}" alt="">`;

  const marque = logo
    ? `<span class="lg"><img src="${logo}" alt=""></span>`
    : `<span class="lg ini">${esc((nom || '?')[0].toUpperCase())}</span>`;
  const head =
    '<link href="https://fonts.googleapis.com/css2?' +
    'family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';

  const css =
    '<style>*{box-sizing:border-box;margin:0}body{margin:0;font-family:Inter,sans-serif}' +
    `.slide{width:${SLIDE_W}px;height:${SLIDE_H}px;position:relative;overflow:hidden;background:${PAPIER};` +
    `color:${ENCRE};display:flex;flex-direction:column;padding:26px 26px 50px}` +
    `.arc{position:absolute;width:520px;height:520px;border-radius:50%;right:-230px;top:-220px;` +
    `background:radial-gradient(circle at 30% 70%,${S}26,${P}12 55%,transparent 72%)}` +
    `.ligne{position:absolute;left:26px;right:26px;top:74px;height:1px;background:${ENCRE}14}` +
    `.grain{position:absolute;inset:0;opacity:.30;mix-blend-mode:multiply;background-image:${GRAIN}}` +
    '.top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:4}' +
    '.brand{display:flex;align-items:center;gap:8px}' +
    '.lg{width:25px;height:25px;border-radius:8px;overflow:hidden;display:grid;place-items:center;flex:none}' +
    '.lg img{width:100%;height:100%;object-fit:cover;display:block}' +
    `.lg.ini{background:linear-gradient(135deg,${P},${S});color:#fff;font-family:Sora;font-weight:800;font-size:12px}` +
    '.brand b{font-family:Sora;font-weight:700;font-size:13.5px;letter-spacing:-.2px}' +
    `.idx{font-family:Sora;font-weight:700;font-size:12px;color:${ENCRE}66;font-variant-numeric:tabular-nums}` +
    '.grow{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative;z-index:4}' +
    'h1{font-family:Sora;font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-1.6px}' +
    'h2{font-family:Sora;font-weight:800;font-size:27px;line-height:1.08;letter-spacing:-.8px}' +
    `.sub{font-size:13px;line-height:1.62;color:${ENCRE}9e;margin-top:12px}` +
    `.wm{position:absolute;left:-6px;top:34%;font-family:Sora;font-weight:800;font-size:150px;` +
    `line-height:.8;letter-spacing:-8px;color:${ENCRE}0d;z-index:1;user-select:none}` +
    `.kicker{display:inline-block;align-self:flex-start;font-size:9px;font-weight:800;letter-spacing:2px;` +
    `text-transform:uppercase;color:${ENCRE};background:${A};padding:5px 11px;border-radius:6px;margin-bottom:14px}` +
    '.pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}' +
    `.pill{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${ENCRE}b0;` +
    `border:1px solid ${ENCRE}1f;padding:6px 10px;border-radius:999px}` +
    `.tip{margin-top:15px;padding:11px 13px;background:#fff;border-radius:11px;border:1px solid ${ENCRE}12}` +
    `.tip .lbl{font-size:8.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:${accDark(A)}}` +
    `.tip p{font-size:11.5px;line-height:1.5;color:${ENCRE}a0;margin-top:3px}` +
    '.masc{position:absolute;z-index:3;filter:drop-shadow(0 26px 30px rgba(18,19,26,.22))}' +
    '.masc.hero{height:238px;right:-14px;bottom:48px}' +
    '.masc.droite{height:146px;right:-8px;bottom:56px}' +
    '.masc.gauche{height:140px;left:-12px;bottom:56px;transform:scaleX(-1)}' +
    '.masc.final{height:224px;right:-16px;bottom:46px}' +
    '.voile{position:absolute;left:0;right:0;bottom:0;height:74px;z-index:3;background:linear-gradient(transparent,#F6F3EAe6 62%)}' +
    '.cta .voile{background:linear-gradient(transparent,rgba(60,40,160,.55))}' +
    '.has-hero .grow{max-width:62%} .has-side .grow{max-width:70%}' +
    '.has-side.g .grow{margin-left:34%;max-width:66%}' +
    '.has-side.g .wm{left:auto;right:-6px}' +
    '.bar{position:absolute;left:0;right:0;bottom:0;z-index:4;display:flex;align-items:center;' +
    'justify-content:space-between;padding:0 26px 18px}' +
    `.hd{font-size:9px;color:${ENCRE}70;font-weight:500}` +
    '.dots{display:flex;gap:5px;align-items:center}' +
    `.dots i{width:6px;height:6px;border-radius:50%;background:${ENCRE}1f}` +
    `.dots i.on{width:18px;border-radius:3px;background:${accDark(A)}}` +
    `.swipe{font-size:9.5px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${accDark(A)}}` +
    `.cta{background:linear-gradient(160deg,${P} 0%,${S} 100%);color:#fff}` +
    '.cta .arc,.cta .ligne{display:none}' +
    '.cta .brand b,.cta .idx{color:#fff} .cta .sub{color:rgba(255,255,255,.86)}' +
    '.cta .hd{color:rgba(255,255,255,.7)} .cta .dots i{background:rgba(255,255,255,.3)}' +
    `.btn{align-self:flex-start;margin-top:20px;background:${A};color:#04301F;font-family:Sora;` +
    'font-weight:800;font-size:12.5px;padding:12px 21px;border-radius:11px}' +
    '</style>';
  const fond = '<div class="arc"></div><div class="ligne"></div><div class="grain"></div><div class="voile"></div>';
  const marqueHtml = `<div class="brand">${marque}<b>${esc(nom)}</b></div>`;

  const out = [
    `<div class="slide has-hero">${fond}${rico('hero', 0)}` +
      `<div class="top">${marqueHtml}<span class="idx">1/${n}</span></div>` +
      `<div class="grow"><span class="kicker">${esc(secteur) || 'Postorico'}</span>` +
      `<h1 style="font-size:${fitFs(hook, 38)}px">${esc(hook)}</h1></div>` +
      `<div class="bar"><span class="hd">${esc(nom)}</span><span class="swipe">Swipe &#8594;</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const cote = i % 2 ? 'gauche' : 'droite'; // Rico alterne : le regard circule
    const cls = i % 2 ? 'has-side g' : 'has-side';
    const pl = sl.pills ? `<div class="pills">${pills(sl.pills)}</div>` : '';
    const tip = sl.pro_tip ? `<div class="tip"><span class="lbl">Le geste</span><p>${esc(sl.pro_tip)}</p></div>` : '';
    const txt = sl.texte ? `<p class="sub">${esc(sl.texte)}</p>` : '';
    out.push(
      `<div class="slide ${cls}">${fond}<div class="wm">${String(i + 1).padStart(2, '0')}</div>${rico(cote, i + 1)}` +
        `<div class="top">${marqueHtml}<span class="idx">${i + 2}/${n}</span></div>` +
        `<div class="grow"><h2 style="font-size:${fitFs(sl.titre, 27)}px">${esc(sl.titre)}</h2>` +
        `${txt}${pl}${tip}</div>` +
        `<div class="bar"><div class="dots">${dots(n, i + 1)}</div><span class="hd">${esc(nom)}</span></div></div>`,
    );
  });
  out.push(
    `<div class="slide cta has-hero"><div class="grain"></div>${rico('final', slides.length + 1)}` +
      `<div class="top">${marqueHtml}<span class="idx">${n}/${n}</span></div>` +
      `<div class="grow"><h2 style="font-size:${fitFs(cta.titre, 26)}px">${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p class="sub">${esc(cta.texte)}</p>` : '') +
      '<span class="btn">Lien en bio &#8594;</span></div>' +
      `<div class="bar"><span class="hd">${esc(secteur)}</span><div class="dots">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
