import { accDark, accLight, inkOn, lighten, mix, near } from '../carrousel/templates/color.util';
import { esc } from '../carrousel/templates/common.util';

/**
 * Les 11 gabarits de story (rendu HTML -> PNG 1080×1920 via Playwright) — port direct de
 * backend/services/story_service.py (fonctions `_tpl_*`). Réutilise les mêmes maths de
 * couleur que les carrousels (contraste auto, teintes de marque) — voir templates/color.util.ts.
 */

export const STORY_W = 360;
export const STORY_H = 640;
export const DSF = 3; // 360×640 × 3 = 1080×1920 (9:16 exact)

export interface StoryContent {
  accroche?: string;
  sous?: string;
  cta?: string;
  image?: string | null;
  rico_pose?: string | null;
  points?: Array<{ titre?: string; desc?: string; icon?: string }> | null;
  baseline?: string | null;
}

export interface StoryTemplateMeta {
  id: string;
  label: string;
  hint: string;
  image: boolean;
  rico?: boolean;
}

export const TEMPLATES: StoryTemplateMeta[] = [
  { id: 'epure', label: 'Épuré', hint: 'Clair, minimal, accroche en grand', image: false },
  { id: 'sombre', label: 'Sombre', hint: 'Fond profond, accent lumineux', image: false },
  { id: 'editorial', label: 'Éditorial', hint: 'Serif élégant, filets fins', image: false },
  { id: 'bloc', label: 'Bloc', hint: 'Aplat de couleur, titre massif', image: false },
  { id: 'photo', label: 'Photo', hint: 'Visuel plein cadre, texte en surimpression', image: true },
  { id: 'photo-flou', label: 'Photo (entière)', hint: "Visuel entier + fond flouté, aucune bande vide", image: true },
  { id: 'split', label: 'Photo + bloc', hint: 'Visuel en haut, texte à la charte en bas', image: true },
  { id: 'liste', label: 'Liste', hint: "Jusqu'à 4 points clés + CTA", image: false },
  { id: 'citation', label: 'Citation', hint: 'Grande citation extraite + attribution', image: false },
  { id: 'rico', label: 'Rico', hint: 'La mascotte Postorico, fond clair de marque', image: false, rico: true },
  { id: 'signature', label: 'Signature', hint: 'Riche : Rico, 3 arguments, CTA (maison)', image: false, rico: true },
];
export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const CANDIDATS_SERIE = new Set(['epure', 'sombre', 'editorial', 'bloc', 'photo', 'photo-flou', 'split']);
export const CANDIDATS_IA = new Set(['epure', 'sombre', 'editorial', 'bloc', 'photo', 'photo-flou', 'split', 'liste', 'citation']);

export const DEFAULT_SIGNATURE = {
  points: [
    { titre: "La [vitesse] d'un logiciel", desc: 'Contenu prêt à publier.', icon: 'eclair' },
    { titre: 'La [qualité] d’une agence', desc: 'Ton calibré. Marque respectée.', icon: 'etoile' },
    { titre: 'Le [contrôle] d’un patron', desc: 'Tu valides, tu pilotes.', icon: 'bouclier' },
  ],
  baseline: '10x moins cher qu’une agence. [2h par mois]. Maximum.',
};

export function templateValide(template?: string | null): string {
  const t = (template || 'epure').toLowerCase();
  return TEMPLATE_IDS.includes(t) ? t : 'epure';
}

/** Gabarit réellement rendu pour UN écran : un gabarit photo sans image retombe sur
 * « epure » plutôt que de rendre un cadre vide ou d'échouer. */
export function templateEffectif(template: string | null | undefined, content: StoryContent | null | undefined): string {
  const t = templateValide(template);
  const info = TEMPLATES.find((x) => x.id === t);
  if (info?.image && !(content || {}).image) return 'epure';
  return t;
}

/** Réduit la taille de police selon la longueur du texte — seuils PROPRES à la story
 * (distincts de ceux du carrousel, cartes/formats différents). */
export function fit(text: string | undefined, base: number): number {
  const n = (text || '').length;
  const seuils: Array<[number, number]> = [
    [26, 1.0],
    [40, 0.82],
    [58, 0.66],
    [999, 0.54],
  ];
  for (const [lim, f] of seuils) {
    if (n <= lim) return Math.round(base * f);
  }
  return Math.round(base * 0.5);
}

/** Colorie les segments marqués entre [crochets] dans un texte (échappe le reste). */
export function accentuer(text: string | undefined | null, color: string): string {
  const t = text || '';
  const out: string[] = [];
  let i = 0;
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    out.push(esc(t.slice(i, m.index)));
    out.push(`<span style="color:${color}">${esc(m[1])}</span>`);
    i = m.index + m[0].length;
  }
  out.push(esc(t.slice(i)));
  return out.join('');
}

function ico(key: string | undefined, color: string): string {
  const paths: Record<string, string> = {
    eclair: '<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    etoile: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
    bouclier: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    fusee: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8a2 2 0 0 0-3 .8z"/><path d="M12 15l-3-3a22 22 0 0 1 8-11c2 0 4 2 4 4a22 22 0 0 1-11 8z"/>',
    coche: '<path d="M20 6L9 17l-5-5"/>',
  };
  const p = paths[key || ''] || '<circle cx="12" cy="12" r="9"/>';
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

// Le compte (nom + photo) s'affiche déjà nativement en haut de la story sur Instagram/
// Facebook : un bloc marque dans l'image ferait doublon. On l'omet (toujours "").
function lockup(): string {
  return '';
}

function doc(head: string, css: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}${css}</head><body>${body}</body></html>`;
}

// =============================================================================
// Modèle « Épuré »
// =============================================================================
function tplEpure(c: StoryContent, p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const BG = lighten(p || '#003D2E', 0.95);
  const INK = '#151a17';
  const MUT = 'rgba(0,0,0,.5)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:'Plus Jakarta Sans',sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:64px 40px 72px;background:${BG};color:${INK}}
  .story::after{content:"";position:absolute;right:-90px;top:-90px;width:280px;height:280px;border-radius:50%;
    background:radial-gradient(circle,${mix(A, BG, 0.35)},transparent 70%);opacity:.5}
  .mid{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center}
  h1{font-weight:800;line-height:1.08;letter-spacing:-.6px;color:${INK}}
  .sous{font-size:17px;line-height:1.5;color:${MUT};margin-top:18px;max-width:92%}
  .cta{position:relative;z-index:2;display:inline-flex;align-items:center;align-self:flex-start;gap:8px;background:${A};color:${Aink};
    font-weight:800;font-size:16px;padding:14px 24px;border-radius:30px;margin-top:22px}
  .lockup{position:relative;z-index:2;display:flex;align-items:center;gap:11px;margin-top:26px}
</style>`;
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="mid"><h1 style="font-size:${fit(c.accroche, 46)}px">${esc(c.accroche)}</h1>${sous}<span class="cta">${esc(c.cta)}</span></div>${lockup()}</div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Sombre »
// =============================================================================
function tplSombre(c: StoryContent, p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const accD = accDark(A);
  const NEAR = near(p || '#003D2E');
  const grad = `linear-gradient(160deg,${NEAR},${mix(NEAR, A, 0.16)})`;
  const INK = '#ffffff';
  const MUT = 'rgba(255,255,255,.66)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:64px 40px 72px;background:${grad};color:${INK}}
  .story::after{content:"";position:absolute;left:-110px;bottom:60px;width:320px;height:320px;border-radius:50%;
    background:radial-gradient(circle,${accD}33,transparent 70%);pointer-events:none}
  .mid{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center}
  h1{font-family:Sora;font-weight:800;line-height:1.04;letter-spacing:-.5px}
  .accent{color:${accD}}
  .sous{font-size:17px;line-height:1.55;color:${MUT};margin-top:18px;max-width:92%}
  .cta{position:relative;z-index:2;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:${accD};
    color:${inkOn(accD)};font-family:Sora;font-weight:800;font-size:16px;padding:14px 24px;border-radius:12px;margin-top:22px}
  .lockup{position:relative;z-index:2;display:flex;align-items:center;gap:11px;margin-top:26px}
</style>`;
  const words = (c.accroche || '').split(' ');
  let accHtml: string;
  if (words.length >= 3) {
    const cut = words.length - Math.max(1, Math.floor(words.length / 3));
    accHtml = esc(words.slice(0, cut).join(' ')) + ` <span class="accent">${esc(words.slice(cut).join(' '))}</span>`;
  } else {
    accHtml = `<span class="accent">${esc(c.accroche)}</span>`;
  }
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="mid"><h1 style="font-size:${fit(c.accroche, 44)}px">${accHtml}</h1>${sous}<span class="cta">${esc(c.cta)}</span></div>${lockup()}</div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Éditorial »
// =============================================================================
function tplEditorial(c: StoryContent, p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const accL = accLight(A);
  const BG = lighten(p || '#003D2E', 0.94);
  const INK = '#1a201d';
  const MUT = 'rgba(0,0,0,.55)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:66px 42px 74px;background:${BG};color:${INK}}
  .mid{flex:1;display:flex;flex-direction:column;justify-content:center}
  h1{font-family:Fraunces;font-weight:600;line-height:1.1;letter-spacing:-.2px}
  .sous{font-size:16px;line-height:1.6;color:${MUT};margin-top:20px;max-width:94%}
  .cta{align-self:flex-start;display:inline-block;margin-top:24px;padding:11px 22px;border-radius:30px;font-size:14px;
    font-weight:600;border:1.5px solid ${accL};color:${accL}}
  .lockup{display:flex;align-items:center;gap:11px}
</style>`;
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="mid"><h1 style="font-size:${fit(c.accroche, 40)}px">${esc(c.accroche)}</h1>${sous}<span class="cta">${esc(c.cta)}</span></div></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Bloc »
// =============================================================================
function tplBloc(c: StoryContent, _p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const head = '<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:60px 40px 70px;background:${A};color:${Aink}}
  .mid{flex:1;display:flex;flex-direction:column;justify-content:center}
  h1{font-family:Anton;line-height:.98;letter-spacing:.4px;text-transform:uppercase}
  .sous{font-size:16px;line-height:1.5;font-weight:500;margin-top:18px;max-width:92%;opacity:.86}
  .cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:${Aink};color:${A};font-family:Anton;
    font-size:16px;letter-spacing:.5px;padding:13px 24px;border-radius:8px;margin-top:22px;text-transform:uppercase}
  .lockup{display:flex;align-items:center;gap:11px}
</style>`;
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="mid"><h1 style="font-size:${fit(c.accroche, 56)}px">${esc(c.accroche)}</h1>${sous}<span class="cta">${esc(c.cta)}</span></div>${lockup()}</div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Photo »
// =============================================================================
function tplPhoto(c: StoryContent, _p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const accD = accDark(A);
  const img = c.image || '';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    justify-content:flex-end;padding:0;background:#0b1020;color:#fff}
  .photo{position:absolute;inset:0;background:url('${img}') center/cover no-repeat}
  .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,10,20,.10) 0%,rgba(6,10,20,0) 34%,rgba(6,10,20,.72) 74%,rgba(6,10,20,.92) 100%)}
  .body{position:relative;z-index:3;padding:0 40px 68px}
  h1{font-family:Sora;font-weight:800;line-height:1.05;letter-spacing:-.5px;text-shadow:0 2px 22px rgba(0,0,0,.5)}
  .accent{color:${accD}}
  .sous{font-size:16px;line-height:1.5;color:rgba(255,255,255,.85);margin-top:14px;max-width:92%;text-shadow:0 1px 14px rgba(0,0,0,.5)}
  .cta{display:inline-flex;align-items:center;gap:8px;background:${A};color:${Aink};font-family:Sora;font-weight:800;font-size:16px;padding:14px 24px;border-radius:12px;margin-top:20px}
  .lockup{display:flex;align-items:center;gap:11px;margin-top:22px}
</style>`;
  const words = (c.accroche || '').split(' ');
  let accHtml: string;
  if (words.length >= 3) {
    const cut = words.length - Math.max(1, Math.floor(words.length / 3));
    accHtml = esc(words.slice(0, cut).join(' ')) + ` <span class="accent">${esc(words.slice(cut).join(' '))}</span>`;
  } else {
    accHtml = esc(c.accroche);
  }
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="photo"></div><div class="scrim"></div><div class="body"><h1 style="font-size:${fit(c.accroche, 42)}px">${accHtml}</h1>${sous}<span class="cta">${esc(c.cta)}</span>${lockup()}</div></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Photo entière »
// =============================================================================
function tplPhotoFlou(c: StoryContent, _p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const img = c.image || '';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;justify-content:flex-end;background:#0b1020;color:#fff}
  .blur{position:absolute;inset:-6%;background:url('${img}') center/cover no-repeat;filter:blur(26px) brightness(.55);transform:scale(1.12)}
  .photo{position:absolute;left:0;right:0;top:0;bottom:150px;background:url('${img}') center/contain no-repeat}
  .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,10,20,.35) 0%,rgba(6,10,20,0) 26%,rgba(6,10,20,.55) 72%,rgba(6,10,20,.9) 100%)}
  .body{position:relative;z-index:3;padding:0 40px 58px}
  h1{font-family:Sora;font-weight:800;line-height:1.06;letter-spacing:-.4px;font-size:30px;text-shadow:0 2px 20px rgba(0,0,0,.6)}
  .cta{display:inline-flex;align-items:center;gap:8px;background:${A};color:${Aink};font-family:Sora;font-weight:800;font-size:15px;padding:13px 22px;border-radius:12px;margin-top:16px}
  .lockup{display:flex;align-items:center;gap:10px;margin-top:18px}
</style>`;
  const body = `<div class="story"><div class="blur"></div><div class="photo"></div><div class="scrim"></div><div class="body"><h1>${esc(c.accroche)}</h1><span class="cta">${esc(c.cta)}</span>${lockup()}</div></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Photo + bloc »
// =============================================================================
function tplSplit(c: StoryContent, p: string, _s: string, a: string): string {
  const A = a || '#3AFFA3';
  const accD = accDark(A);
  const img = c.image || '';
  const NEAR = near(p || '#003D2E');
  const INK = '#fff';
  const MUT = 'rgba(255,255,255,.66)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;background:${NEAR};color:${INK}}
  .pic{height:58%;background:url('${img}') center/cover no-repeat;position:relative}
  .blk{flex:1;display:flex;flex-direction:column;justify-content:center;padding:32px 40px 40px}
  h1{font-family:Sora;font-weight:800;line-height:1.06;letter-spacing:-.4px}
  .accent{color:${accD}}
  .sous{font-size:15px;line-height:1.5;color:${MUT};margin-top:12px;max-width:94%}
  .cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:${accD};color:${inkOn(accD)};font-family:Sora;font-weight:800;font-size:15px;padding:13px 22px;border-radius:12px;margin-top:18px}
  .lockup{display:flex;align-items:center;gap:10px;margin-top:18px}
</style>`;
  const words = (c.accroche || '').split(' ');
  let accHtml: string;
  if (words.length >= 3) {
    const cut = words.length - Math.max(1, Math.floor(words.length / 3));
    accHtml = esc(words.slice(0, cut).join(' ')) + ` <span class="accent">${esc(words.slice(cut).join(' '))}</span>`;
  } else {
    accHtml = esc(c.accroche);
  }
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="pic"></div><div class="blk"><h1 style="font-size:${fit(c.accroche, 32)}px">${accHtml}</h1>${sous}<span class="cta">${esc(c.cta)}</span>${lockup()}</div></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Liste »
// =============================================================================
function tplListe(c: StoryContent, _p: string, s: string, a: string, nom?: string, _secteur?: string, logo?: string | null): string {
  const S_ = s || '#8A6CFF';
  const A_ = a || '#3AFFA3';
  const Aink = inkOn(A_);
  const BG1 = mix(S_, '#050409', 0.86);
  const BG2 = '#050409';
  const INK = '#ffffff';
  const MUT = 'rgba(255,255,255,.66)';
  const LINE = 'rgba(255,255,255,.10)';
  const marque = logo
    ? `<img src="${logo}" style="height:26px;width:auto;display:block" alt="">`
    : `<span style="width:28px;height:28px;border-radius:8px;background:${A_};color:${Aink};display:grid;place-items:center;font-weight:800;font-family:Sora">${esc((nom || '?').slice(0, 1).toUpperCase())}</span>`;
  const points = (c.points || []).slice(0, 4);
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
  const rows = points.map((pt, i) => {
    const div = i ? `<div style="height:1px;background:${LINE};margin:13px 0"></div>` : '';
    return (
      `${div}<div style="display:flex;align-items:flex-start;gap:13px">` +
      `<span style="flex:0 0 auto;width:36px;height:36px;border-radius:10px;background:${mix(A_, BG2, 0.82)};` +
      `border:1px solid ${mix(A_, BG2, 0.45)};display:grid;place-items:center;font-family:Sora;font-weight:800;` +
      `font-size:13px;color:${A_}">${i + 1}</span>` +
      `<div><div style="font-family:Sora;font-weight:700;font-size:16px;color:${INK};line-height:1.25">${accentuer(pt.titre, A_)}</div>` +
      `<div style="font-size:13px;color:${MUT};margin-top:3px;line-height:1.4">${esc(pt.desc)}</div></div></div>`
    );
  });
  const cta = c.cta
    ? `<span style="align-self:flex-start;display:inline-flex;align-items:center;gap:7px;background:${A_};color:${Aink};font-family:Sora;font-weight:800;font-size:15px;padding:13px 22px;border-radius:30px;margin-top:24px">${esc(c.cta)} →</span>`
    : '';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:56px 36px 60px;background:linear-gradient(160deg,${BG1},${BG2});color:${INK}}
  .story::after{content:"";position:absolute;left:-100px;bottom:-100px;width:300px;height:300px;border-radius:50%;
    background:radial-gradient(circle,${mix(A_, BG2, 0.3)},transparent 70%);opacity:.45;pointer-events:none}
  .brand{position:relative;z-index:3;display:flex;align-items:center;gap:9px;font-family:Sora;font-weight:800;font-size:15px;color:${INK}}
  h1{position:relative;z-index:3;font-family:Sora;font-weight:800;line-height:1.08;letter-spacing:-.4px;margin-top:22px}
  .card{position:relative;z-index:3;margin-top:26px;border:1px solid ${LINE};border-radius:16px;background:rgba(255,255,255,.035);padding:18px 18px}
</style>`;
  const body = `<div class="story"><div class="brand">${marque}<span>${esc(nom || 'Story')}</span></div><h1 style="font-size:${fit(c.accroche, 36)}px">${esc(c.accroche)}</h1><div class="card">${rows.join('')}</div>${cta}</div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Citation »
// =============================================================================
function tplCitation(c: StoryContent, p: string, _s: string, a: string): string {
  const A_ = a || '#3AFFA3';
  const BG = near(p || '#0b1020');
  const INK = '#ffffff';
  const MUT = 'rgba(255,255,255,.62)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    justify-content:center;padding:70px 44px;background:${BG};color:${INK}}
  .mark{font-family:Fraunces;font-weight:600;font-size:96px;line-height:.5;color:${A_};opacity:.9;margin-bottom:6px}
  blockquote{font-family:Fraunces;font-weight:500;font-style:italic;line-height:1.24;letter-spacing:-.2px;margin:0}
  .rule{width:38px;height:3px;border-radius:3px;background:${A_};margin:24px 0 14px}
  .attrib{font-size:13.5px;color:${MUT};font-weight:500}
</style>`;
  const body = `<div class="story"><div class="mark">&ldquo;</div><blockquote style="font-size:${fit(c.accroche, 34)}px">${esc(c.accroche)}</blockquote><div class="rule"></div><div class="attrib">${esc(c.sous)}</div></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Rico »
// =============================================================================
function tplRico(c: StoryContent, p: string, _s: string, a: string, nom?: string, _secteur?: string, logo?: string | null, ricoUrl?: string): string {
  const P = p || '#003D2E';
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const BG = lighten(P, 0.95);
  const BG2 = lighten(P, 0.88);
  const INK = '#151a17';
  const MUT = 'rgba(0,0,0,.5)';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:52px 40px 0;background:linear-gradient(160deg,${BG},${BG2});color:${INK}}
  .story::after{content:"";position:absolute;right:-120px;top:-70px;width:320px;height:320px;border-radius:50%;
    background:radial-gradient(circle,${mix(A, BG, 0.25)},transparent 70%);opacity:.6}
  .head{position:relative;z-index:3;display:flex;align-items:center;justify-content:flex-start}
  .mid{position:relative;z-index:3;margin-top:32px}
  h1{font-family:Sora;font-weight:800;line-height:1.06;letter-spacing:-.5px;max-width:96%}
  .sous{font-size:16px;line-height:1.5;color:${MUT};margin-top:13px;max-width:90%}
  .cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:${A};color:${Aink};font-family:Sora;
    font-weight:800;font-size:16px;padding:13px 23px;border-radius:30px;margin-top:18px}
  .rico{position:absolute;right:-18px;bottom:0;height:47%;z-index:2;
    filter:drop-shadow(0 16px 26px rgba(0,0,0,.20))}
</style>`;
  const sous = c.sous ? `<div class="sous">${esc(c.sous)}</div>` : '';
  const body = `<div class="story"><div class="head">${lockup()}</div><div class="mid"><h1 style="font-size:${fit(c.accroche, 38)}px">${esc(c.accroche)}</h1>${sous}<span class="cta">${esc(c.cta)}</span></div><img class="rico" src="${ricoUrl}" alt=""></div>`;
  return doc(head, css, body);
}

// =============================================================================
// Modèle « Signature »
// =============================================================================
function tplSignature(c: StoryContent, _p: string, s: string, a: string, nom?: string, _secteur?: string, logo?: string | null, ricoUrl?: string): string {
  const S = s || '#8A6CFF';
  const A = a || '#3AFFA3';
  const Aink = inkOn(A);
  const BG1 = mix(S, '#050409', 0.84);
  const BG2 = '#050409';
  const INK = '#ffffff';
  const MUT = 'rgba(255,255,255,.66)';
  const LINE = 'rgba(255,255,255,.10)';
  const words = (c.accroche || '').split(' ');
  let accHtml: string;
  if (words.length >= 2) {
    accHtml = esc(words.slice(0, -1).join(' ')) + ` <span style="color:${S}">${esc(words[words.length - 1])}</span>`;
  } else {
    accHtml = esc(c.accroche);
  }
  const marque = logo
    ? `<img src="${logo}" style="height:28px;width:auto;display:block" alt="">`
    : `<span style="width:30px;height:30px;border-radius:9px;background:${A};color:${Aink};display:grid;place-items:center;font-weight:800;font-family:Sora">${esc((nom || '?').slice(0, 1).toUpperCase())}</span>`;
  const points = (c.points || []).slice(0, 3);
  const baseline = c.baseline || '';
  const head = '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">';
  let carte = '';
  if (points.length) {
    const defaultIcons = ['eclair', 'etoile', 'bouclier'];
    const rows = points.map((pt, i) => {
      const div = i ? `<div style="height:1px;background:${LINE};margin:9px 0"></div>` : '';
      const icone = pt.icon || defaultIcons[i % defaultIcons.length];
      return (
        `${div}<div style="display:flex;align-items:flex-start;gap:11px">` +
        `<span style="flex:0 0 auto;width:32px;height:32px;border-radius:9px;background:${mix(A, BG2, 0.82)};` +
        `border:1px solid ${mix(A, BG2, 0.5)};display:grid;place-items:center">${ico(icone, A)}</span>` +
        `<div><div style="font-family:Sora;font-weight:700;font-size:14.5px;color:${INK}">${accentuer(pt.titre, A)}</div>` +
        `<div style="font-size:12.5px;color:${MUT};margin-top:1px">${esc(pt.desc)}</div></div></div>`
      );
    });
    carte = `<div style="position:relative;z-index:3;margin-top:14px;border:1px solid ${LINE};border-radius:15px;background:rgba(255,255,255,.03);padding:13px 15px">${rows.join('')}</div>`;
  }
  let bas = '';
  if (baseline || c.cta) {
    const bl = baseline
      ? `<div style="flex:1;min-width:0;font-size:13px;font-weight:600;color:${MUT};line-height:1.4">${accentuer(baseline, A)}</div>`
      : '<div style="flex:1"></div>';
    const cta = c.cta
      ? `<span style="flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;background:${A};color:${Aink};font-family:Sora;font-weight:800;font-size:14px;padding:12px 20px;border-radius:30px">${esc(c.cta)} →</span>`
      : '';
    bas = `<div style="position:relative;z-index:3;margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px">${bl}${cta}</div>`;
  }
  const css = `<style>*{box-sizing:border-box;margin:0} body{margin:0;font-family:Inter,sans-serif}
  .story{width:${STORY_W}px;height:${STORY_H}px;overflow:hidden;position:relative;display:flex;flex-direction:column;
    padding:38px 32px 36px;background:linear-gradient(155deg,${BG1},${BG2});color:${INK}}
  .rings{position:absolute;right:-104px;top:-72px;width:340px;height:340px;z-index:1;pointer-events:none;opacity:.8}
  .rings i{position:absolute;border-radius:50%;border:1px solid ${mix(S, BG2, 0.55)}}
  .brand{position:relative;z-index:3;display:flex;align-items:center;gap:9px;font-family:Sora;font-weight:800;font-size:18px;color:${INK}}
  .rico{position:absolute;right:-10px;top:58px;width:45%;height:auto;z-index:2;filter:drop-shadow(0 16px 26px rgba(0,0,0,.4))}
  h1{position:relative;z-index:3;font-family:Sora;font-weight:800;line-height:1.02;letter-spacing:-.5px;margin-top:16px;max-width:54%}
  .rule{position:relative;z-index:3;width:44px;height:3px;border-radius:3px;background:${A};margin:12px 0}
  .sous{position:relative;z-index:3;font-size:15px;line-height:1.45;color:${MUT};max-width:82%}
</style>`;
  const rings = '<div class="rings">' + [0, 30, 66, 108, 156].map((v) => `<i style="inset:${v}px"></i>`).join('') + '</div>';
  const sous = c.sous ? `<div class="sous">${accentuer(c.sous, A)}</div>` : '';
  const body = `<div class="story">${rings}<img class="rico" src="${ricoUrl}" alt=""><div class="brand">${marque}<span>${esc(nom || 'postorico')}</span></div><h1 style="font-size:${fit(c.accroche, 32)}px">${accHtml}</h1><div class="rule"></div>${sous}${carte}${bas}</div>`;
  return doc(head, css, body);
}

type TplFn = (c: StoryContent, p: string, s: string, a: string, nom?: string, secteur?: string, logo?: string | null, ricoUrl?: string) => string;

const FN: Record<string, TplFn> = {
  epure: tplEpure,
  sombre: tplSombre,
  editorial: tplEditorial,
  bloc: tplBloc,
  photo: tplPhoto,
  'photo-flou': tplPhotoFlou,
  split: tplSplit,
  liste: tplListe,
  citation: tplCitation,
  rico: tplRico,
  signature: tplSignature,
};

export function buildStoryHtml(
  content: StoryContent,
  p: string,
  s: string,
  a: string,
  nom: string | undefined,
  secteur: string | undefined,
  template = 'epure',
  logo?: string | null,
  ricoUrl?: string,
): string {
  const fn = FN[templateValide(template)] || tplEpure;
  return fn(content, p, s, a, nom, secteur, logo, ricoUrl);
}
