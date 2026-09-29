import { accDark, accLight, inkOn, lighten, near } from './color.util';
import { avSpan, CarrouselContentShape, esc, fitFs, dots, parts } from './common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;

/** Taille du chiffre géant (famille « chiffres ») selon sa longueur -> "92%" reste
 * énorme, "3 000€/mois" rétrécit dès le premier rendu (avant même la passe
 * d'auto-ajustement Playwright). Port direct de `_chiffre_fs`. */
function chiffreFs(text: string, base = 76): number {
  const n = (text || '').length;
  if (n <= 4) return base;
  if (n <= 7) return Math.round(base * 0.76);
  if (n <= 10) return Math.round(base * 0.58);
  return Math.round(base * 0.44);
}

/** Port direct de `_tpl_chiffres` (backend/services/carrousel_service.py). */
export function tplChiffres(
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
  const NEAR = near(pp);
  const CREAM = lighten(pp, 0.94);
  const accL = accLight(A);
  const accD = accDark(A);
  const Aink = inkOn(A);
  const Sink = inkOn(ss);
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const head =
    '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .slide{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;padding:32px 30px 26px}
  .kick{font-family:Sora;font-weight:700;font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.68}
  .grow{flex:1;overflow:hidden}
  .chiffre{font-family:Sora;font-weight:800;font-size:76px;line-height:.86;letter-spacing:-2.5px;margin-top:10px;overflow-wrap:anywhere}
  h2{font-family:Sora;font-weight:700;font-size:21px;line-height:1.12;letter-spacing:-.3px;margin-top:8px}
  p{font-size:13.5px;line-height:1.5;opacity:.82;margin-top:8px}
  .bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;padding:0 30px 22px}
  .dots{display:flex;gap:6px} .dots i{width:7px;height:7px;border-radius:50%;opacity:.3;background:currentColor} .dots i.on{opacity:1;width:22px;border-radius:5px}
  .foot{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600}
  .av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:Sora;font-size:14px}
  .cta-btn{align-self:flex-start;font-family:Sora;font-weight:800;font-size:14px;padding:13px 24px;border-radius:10px;margin-top:18px;text-transform:uppercase;letter-spacing:.3px}
</style>`;
  const initial = (nom || '?')[0].toUpperCase();
  const avAccent = avSpan(logo, initial, A, Aink);
  const avSecondaire = avSpan(logo, initial, Sink, ss);
  const footCover = `<div class="foot">${avAccent}<div>${esc(nom)}</div></div>`;
  const out = [
    `<div class="slide" style="background:${NEAR};color:#fff"><span class="kick" style="color:${accD}">Chiffres clés</span>` +
      `<div class="grow" style="display:flex;align-items:center"><h2 style="font-size:${fitFs(hook, 30)}px;font-weight:800">${esc(hook)}</h2></div>` +
      `<div class="bar">${footCover}<span class="kick" style="color:${accD}">Swipe →</span></div></div>`,
  ];
  slides.forEach((sl, i) => {
    const dk = i % 2 === 0;
    const bg = dk ? NEAR : CREAM;
    const ink = dk ? '#fff' : '#14201b';
    const acc = dk ? accD : accL;
    const chiffre = (sl.chiffre || '').trim() || `0${i + 1}`;
    const chiffreStyle = sl.chiffre ? `color:${acc}` : `color:${ink};opacity:.18`;
    out.push(
      `<div class="slide" style="background:${bg};color:${ink}"><span class="kick">${esc(sl.titre) || `Étape ${String(i + 1).padStart(2, '0')}`}</span>` +
        `<div class="chiffre" style="font-size:${chiffreFs(chiffre)}px;${chiffreStyle}">${esc(chiffre)}</div>` +
        (sl.texte ? `<p>${esc(sl.texte)}</p>` : '') +
        `<div class="grow"></div><div class="bar"><div class="dots" style="color:${acc}">${dots(n, i + 1)}</div>` +
        `<span class="kick">${i + 2}/${n}</span></div></div>`,
    );
  });
  const footCta = `<div class="foot">${avSecondaire}<div>${esc(nom)}</div></div>`;
  out.push(
    `<div class="slide" style="background:${ss};color:${Sink}"><span class="kick">À toi de jouer</span>` +
      `<div class="grow" style="display:flex;flex-direction:column;justify-content:center"><h2 style="font-size:${fitFs(cta.titre, 26)}px">${esc(cta.titre)}</h2>` +
      (cta.texte ? `<p>${esc(cta.texte)}</p>` : '') +
      `<span class="cta-btn" style="background:${Sink};color:${ss}">Lien en bio →</span></div>` +
      `<div class="bar">${footCta}<div class="dots" style="color:${Sink}">${dots(n, n - 1)}</div></div></div>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${out.join('')}</body></html>`;
}
