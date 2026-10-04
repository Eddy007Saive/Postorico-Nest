/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Le design arrive en JSON non typé du navigateur : chaque champ est relu et revalidé ici. */
/**
 * Modèles de carrousel créés par les CLIENTS dans l'éditeur — port de
 * backend/services/carrousel_modele_service.py (partie pure : nettoyage du design + gabarit).
 *
 * Le client envoie trois pages (couverture, étape, finale) dont chaque texte porte un rôle ;
 * on en fabrique ici un gabarit au contrat des templates importés (blocs data-role et
 * marqueurs {{hook}}, {{titre}}…). Le client n'envoie jamais de HTML : chaque valeur est
 * validée puis réécrite, les images passent par notre Cloudinary (callback `heberger`).
 */
import { CUSTOM_FONTS, fontFaceCss } from './polices.util';

export const MAX_MODELES = 10;
export const LARGEUR = 1080;
export const HAUTEUR = 1350;
const K = 360 / LARGEUR;
export const ROLES_PAGES = ['couverture', 'etape', 'final'] as const;
type RolePage = (typeof ROLES_PAGES)[number];

const MARQUEURS: Record<RolePage, Record<string, string>> = {
  couverture: { accroche: '{{hook}}' },
  etape: { titre: '{{titre}}', texte: '{{texte}}', astuce: '{{pro_tip}}' },
  final: { cta: '{{cta_titre}}', cta_texte: '{{cta_texte}}' },
};
const COMMUNS: Record<string, string> = {
  nom: '{{nom}}',
  compteur: '{{index}}/{{total}}',
};
// Textes écrits par l'IA
const VARIABLES = new Set(Object.values(MARQUEURS).flatMap((m) => Object.keys(m)));
// Couleurs de marque qu'un texte ou un fond peut suivre : variable CSS posée par le rendu.
const VARS_MARQUE: Record<string, string> = { principale: '--marque-p', secondaire: '--marque-s', accent: '--marque-a' };
const marque = (v: unknown): string | null => (typeof v === 'string' && VARS_MARQUE[v] ? v : null);
/** Couleur CSS : celle de la marque au moment du rendu, sinon la couleur dessinée. */
const teinte = (c: string, m?: string | null) => (m ? `var(${VARS_MARQUE[m]},${c})` : c);

// Joué après le chargement des polices (même script que le Python) :
// 1. mots en couleur (data-accent-mots) : les N derniers mots passent dans un span coloré ;
// 2. ajustement (data-fit) : la police rétrécit tant que le texte déborde de sa zone.
export const FIT_JS = `() => {
  document.querySelectorAll('[data-accent-mots]').forEach(function(el){
    var n = parseInt(el.getAttribute('data-accent-mots'), 10) || 0;
    if (!n) return;
    var m = el.textContent.split(/(\\s+)/), idx = [];
    for (var i = m.length - 1; i >= 0 && idx.length < n; i--) if (m[i].trim()) idx.push(i);
    if (!idx.length) return;
    var d = Math.min.apply(null, idx), s = document.createElement('span');
    s.style.color = el.getAttribute('data-accent');
    s.textContent = m.slice(d).join('');
    el.textContent = m.slice(0, d).join('');
    el.appendChild(s);
  });
  document.querySelectorAll('[data-fit]').forEach(function(el){
    var fs = parseFloat(getComputedStyle(el).fontSize), g = 0;
    while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && fs > 5 && g < 200) { fs -= 0.5; el.style.fontSize = fs + 'px'; g++; }
  });
}`;

const COULEUR =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;
const POLICE = /^[A-Za-z0-9 -]{1,60}$/;
/** Texte d'un champ non typé (un objet ne devient jamais « [object Object] »). */
const chaine = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const CHEMIN_SITE = /^\/[A-Za-z0-9/_\-.]{1,200}$/;
export const ID_MODELE = /^perso-[0-9a-f]{10}$/;

/** Design inutilisable : le message est montré tel quel au client. */
export class ModeleInvalide extends Error {}

export interface ElementPropre {
  type: 'texte' | 'image' | 'forme';
  forme?: string;
  stroke?: string | null;
  strokeWidth?: number;
  rayon?: number;
  contourMarque?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  role?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fill?: string;
  gras?: boolean;
  italique?: boolean;
  align?: string;
  lineHeight?: number;
  letterSpacing?: number;
  src?: string;
  uneLigne?: boolean;
  couleurMarque?: string | null;
  accentMots?: number;
  accentCouleur?: string;
  accentMarque?: string | null;
  rond?: boolean;
  ombre?: {
    couleur: string;
    opacite: number;
    x: number;
    y: number;
    flou: number;
  } | null;
}
export interface PagePropre {
  role: RolePage;
  fond: string;
  degrade: { angle: number; stops: Array<[number, string]> } | null;
  fondImage: string | null;
  fondMarque: string | null;
  elements: ElementPropre[];
}
/** Héberge une image (data URL décodée) et renvoie son URL publique. */
export type Hebergeur = (brut: Buffer, nom: string) => Promise<string>;

function nombre(v: unknown, mini: number, maxi: number, defaut = 0): number {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n))
    return defaut;
  return Math.max(mini, Math.min(maxi, n));
}
const couleur = (v: unknown, defaut = '#ffffff') =>
  COULEUR.test(chaine(v).trim()) ? chaine(v).trim() : defaut;
const police = (v: unknown) =>
  POLICE.test(chaine(v).trim()) ? chaine(v).trim() : 'Inter';

async function urlImage(
  src: unknown,
  frontendUrl: string,
  heberger: Hebergeur,
  nom: string,
): Promise<string | null> {
  const s = chaine(src).trim();
  const m = DATA_IMG.exec(s);
  if (m) {
    const brut = Buffer.from(m[2], 'base64');
    if (brut.length > 6 * 1024 * 1024)
      throw new ModeleInvalide('Une image du modèle dépasse 6 Mo.');
    return heberger(brut, nom);
  }
  if (s.startsWith('https://res.cloudinary.com/'))
    return s.replace(/"/g, '%22');
  if (CHEMIN_SITE.test(s) && !s.includes('..')) return `${frontendUrl}${s}`;
  return null;
}

/** Une page du design, nettoyée : seules des valeurs validées passent. */
export async function nettoyerPage(
  page: any,
  role: RolePage,
  frontendUrl: string,
  heberger: Hebergeur,
): Promise<PagePropre> {
  if (!page || typeof page !== 'object')
    throw new ModeleInvalide('Page de modèle illisible.');
  let degrade: PagePropre['degrade'] = null;
  if (page.degrade && typeof page.degrade === 'object') {
    const stops = (Array.isArray(page.degrade.stops) ? page.degrade.stops : [])
      .slice(0, 6)
      .filter((st: any) => Array.isArray(st) && typeof st[1] === 'string')
      .map(
        (st: any) =>
          [nombre(st[0], 0, 1), couleur(st[1], '#000000')] as [number, string],
      );
    if (stops.length >= 2)
      degrade = { angle: nombre(page.degrade.angle, -360, 360, 180), stops };
  }
  const out: PagePropre = {
    role,
    fond: couleur(page.fond, '#000000'),
    degrade,
    fondImage: page.fondImage
      ? await urlImage(page.fondImage, frontendUrl, heberger, `${role}_fond`)
      : null,
    fondMarque: marque(page.fondMarque),
    elements: [],
  };
  const elements = Array.isArray(page.elements) ? page.elements : [];
  if (elements.length > 60)
    throw new ModeleInvalide("Trop d'éléments sur une slide (60 au maximum).");
  const rolesOk = new Set([
    ...Object.keys(MARQUEURS[role]),
    ...Object.keys(COMMUNS),
    ...(role === 'etape' ? ['numero'] : []),
    'fixe',
  ]);
  for (let i = 0; i < elements.length; i += 1) {
    const e = elements[i];
    if (!e || typeof e !== 'object') continue;
    const base = {
      x: nombre(e.x, -LARGEUR, 2 * LARGEUR),
      y: nombre(e.y, -HAUTEUR, 2 * HAUTEUR),
      width: nombre(e.width, 1, 3 * LARGEUR, 100),
      rotation: nombre(e.rotation, -360, 360),
      opacity: nombre(e.opacity, 0, 1, 1),
      height: nombre(e.height, 1, 3 * HAUTEUR, 100),
    };
    if (e.type === 'texte') {
      const r = chaine(e.role) || 'fixe';
      out.elements.push({
        ...base,
        type: 'texte',
        role: rolesOk.has(r) ? r : 'fixe',
        text: chaine(e.text).slice(0, 3000),
        fontSize: nombre(e.fontSize, 4, 600, 40),
        fontFamily: police(e.fontFamily),
        fill: couleur(e.fill),
        gras: !!e.gras,
        italique: !!e.italique,
        align: ['left', 'center', 'right'].includes(e.align) ? e.align : 'left',
        lineHeight: nombre(e.lineHeight, 0.5, 4, 1.2),
        letterSpacing: nombre(e.letterSpacing, -50, 200),
        uneLigne: !!e.uneLigne,
        couleurMarque: marque(e.couleurMarque),
        accentMots: Math.trunc(nombre(e.accentMots, 0, 5)),
        accentCouleur: couleur(e.accentCouleur, '#3AFFA3'),
        accentMarque: marque(e.accentMarque),
      });
    } else if (e.type === 'forme' && FORMES.has(chaine(e.forme))) {
      out.elements.push({
        ...base,
        type: 'forme',
        forme: chaine(e.forme),
        fill: e.fill ? couleur(e.fill, '') || undefined : undefined,
        stroke: e.stroke ? couleur(e.stroke, '') || null : null,
        strokeWidth: nombre(e.strokeWidth, 0, 200),
        rayon: nombre(e.rayon, 0, 2 * HAUTEUR),
        couleurMarque: marque(e.couleurMarque),
        contourMarque: marque(e.contourMarque),
      });
    } else if (e.type === 'image') {
      const src = await urlImage(
        e.src,
        frontendUrl,
        heberger,
        `${role}_img${i}`,
      );
      if (!src) continue;
      const o = e.ombre && typeof e.ombre === 'object' ? e.ombre : null;
      out.elements.push({
        ...base,
        type: 'image',
        src,
        role: e.role === 'logo' ? 'logo' : 'fixe',
        rond: !!e.rond,
        ombre: o
          ? {
              couleur: couleur(o.couleur, '#000000'),
              opacite: nombre(o.opacite, 0, 1, 0.5),
              x: nombre(o.x, -200, 200),
              y: nombre(o.y, -200, 200),
              flou: nombre(o.flou, 0, 300),
            }
          : null,
      });
    }
  }
  return out;
}

/** Nombre CSS lisible : 160 plutôt que 160.0 (même sortie que le Python). */
function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}
const px = (v: number) => `${n(v * K)}px`;

function rgba(hexa: string, opacite: number): string {
  let h = hexa.replace(/^#/, '');
  if (h.length === 3 || h.length === 4)
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  if (h.length < 6 || !/^[0-9a-fA-F]{6}/.test(h)) return hexa;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${Math.round(opacite * 1000) / 1000})`;
}

const fondCss = (p: PagePropre) =>
  p.degrade
    ? `linear-gradient(${n(p.degrade.angle)}deg, ${p.degrade.stops.map(([o, c]) => `${c} ${Math.round(o * 100)}%`).join(', ')})`
    : p.fond;

const echapper = (t: string) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');

function contenuTexte(e: ElementPropre, rolePage: RolePage): string {
  const r = e.role || 'fixe';
  if (MARQUEURS[rolePage][r]) return MARQUEURS[rolePage][r];
  if (COMMUNS[r]) return COMMUNS[r];
  const txt = echapper(e.text || '');
  if (r === 'numero')
    return /\d/.test(txt) ? txt.replace(/\d+/, '{{numero}}') : '{{numero}}';
  return txt;
}

const POLICE_TITRE = new Set(['accroche', 'titre', 'cta']); // prennent la police des titres choisie
const POLICE_CORPS = new Set(['texte', 'astuce', 'cta_texte']); // prennent la police du texte choisie

/** Police des titres et police du texte telles que dessinées dans le modèle. */
function famillesDuModele(pages: PagePropre[]): [string | null, string | null] {
  const textes = pages.flatMap((p) => p.elements.filter((e) => e.type === 'texte'));
  return [
    textes.find((e) => POLICE_TITRE.has(e.role || ''))?.fontFamily ?? null,
    textes.find((e) => POLICE_CORPS.has(e.role || ''))?.fontFamily ?? null,
  ];
}

/** « titre » ou « corps » : la police choisie dans Contenus/Carrousels remplacera la sienne.
 * Un texte fixe suit le groupe dont il partage la police (étiquette, numéro d'étape…). */
function policeDe(e: ElementPropre, f: [string | null, string | null]): string | null {
  if (POLICE_TITRE.has(e.role || '')) return 'titre';
  if (POLICE_CORPS.has(e.role || '')) return 'corps';
  if (e.fontFamily === f[0]) return 'titre';
  if (e.fontFamily === f[1]) return 'corps';
  return null;
}

// Formes dessinées dans l'éditeur (même tracé que designCarrousel.js et le Python)
const FORMES = new Set(['rect', 'ellipse', 'triangle', 'etoile', 'ligne', 'fleche']);

function pointsEtoile(w: number, h: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.45 : 1;
    pts.push(`${n(w / 2 + (w / 2) * r * Math.cos(a))},${n(h / 2 + (h / 2) * r * Math.sin(a))}`);
  }
  return pts.join(' ');
}

/** Forme en SVG, tracée dans sa boîte comme dans l'éditeur (coordonnées 1080×1350). */
function svgForme(e: ElementPropre, commun: string): string {
  const { width: w, height: h } = e;
  const f = e.forme || 'rect';
  const ouverte = f === 'ligne' || f === 'fleche';
  const sw = e.strokeWidth || 0;
  let corps: string;
  if (f === 'rect') corps = `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(e.rayon || 0, w / 2, h / 2))}"`;
  else if (f === 'ellipse') corps = `<ellipse cx="${n(w / 2)}" cy="${n(h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}"`;
  else if (f === 'triangle') corps = `<polygon points="${n(w / 2)},0 ${n(w)},${n(h)} 0,${n(h)}"`;
  else if (f === 'etoile') corps = `<polygon points="${pointsEtoile(w, h)}"`;
  else {
    let d = `M0 ${n(h / 2)} L${n(w)} ${n(h / 2)}`;
    if (f === 'fleche') {
      const t = Math.min(h / 2, Math.max(sw * 2.5, 16));
      d += ` M${n(w - t)} ${n(h / 2 - t)} L${n(w)} ${n(h / 2)} L${n(w - t)} ${n(h / 2 + t)}`;
    }
    corps = `<path d="${d}"`;
  }
  const fond = ouverte || !e.fill ? 'none' : teinte(e.fill, e.couleurMarque);
  const trait = e.stroke && sw > 0
    ? `stroke:${teinte(e.stroke, e.contourMarque)};stroke-width:${n(sw)};stroke-linecap:round;stroke-linejoin:round`
    : 'stroke:none';
  return `<svg viewBox="0 0 ${n(w)} ${n(h)}" preserveAspectRatio="none" style="${commun}height:${px(h)};overflow:visible">${corps} style="fill:${fond};${trait}"/></svg>`;
}

function bloc(p: PagePropre, groupes: [string | null, string | null] = [null, null]): string {
  const m: string[] = [
    `<div class="slide" data-role="${p.role}" style="position:relative;width:360px;height:450px;overflow:hidden;background:${teinte(fondCss(p), p.degrade ? null : p.fondMarque)}">`,
  ];
  if (p.fondImage)
    m.push(
      `<img src="${p.fondImage}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover">`,
    );
  for (const e of p.elements) {
    const commun =
      `position:absolute;left:${px(e.x)};top:${px(e.y)};width:${px(e.width)};` +
      `opacity:${n(e.opacity)};transform:rotate(${n(e.rotation)}deg);transform-origin:0 0;`;
    if (e.type === 'forme') {
      m.push(svgForme(e, commun));
      continue;
    }
    if (e.type === 'image') {
      const o = e.ombre;
      const filtre = o
        ? `filter:drop-shadow(${px(o.x)} ${px(o.y)} ${px(o.flou)} ${rgba(o.couleur, o.opacite)});`
        : '';
      m.push(
        // le logo suit celui de la marque ; rond, il est recadré dans sa pastille
        `<img src="${e.role === 'logo' ? '{{logo}}' : e.src}" alt="" style="${commun}height:${px(e.height)};` +
          `${e.rond ? 'border-radius:50%;object-fit:cover;' : ''}${filtre}">`,
      );
    } else {
      // un texte fixe tenu sur une ligne (bouton, étiquette) ne passe jamais à la ligne
      const ligne = e.uneLigne && !VARIABLES.has(e.role || 'fixe');
      const style =
        `${commun}height:${px(e.height)};margin:0;overflow:hidden;` +
        `white-space:${ligne ? 'nowrap' : 'pre-wrap'};` +
        `overflow-wrap:break-word;font-family:'${e.fontFamily}',sans-serif;` +
        `font-size:${px(e.fontSize!)};font-weight:${e.gras ? 700 : 400};` +
        `font-style:${e.italique ? 'italic' : 'normal'};color:${teinte(e.fill!, e.couleurMarque)};` +
        `text-align:${e.align};line-height:${n(e.lineHeight!)};letter-spacing:${px(e.letterSpacing!)}`;
      const accent = e.accentMots
        ? ` data-accent-mots="${e.accentMots}" data-accent="${teinte(e.accentCouleur!, e.accentMarque)}"`
        : '';
      const groupe = policeDe(e, groupes);
      const police = groupe ? ` data-police="${groupe}"` : '';
      m.push(`<div data-fit${accent}${police} style="${style}">${contenuTexte(e, p.role)}</div>`);
    }
  }
  m.push('</div>');
  return m.join('');
}

/** Gabarit au contrat des templates importés : polices en tête, puis les trois blocs. */
export function htmlDepuisPages(
  pages: PagePropre[],
  frontendUrl: string,
): string {
  const familles = [
    ...new Set(
      pages.flatMap((p) =>
        p.elements.filter((e) => e.type === 'texte').map((e) => e.fontFamily!),
      ),
    ),
  ];
  const google = familles.filter((f) => !CUSTOM_FONTS[f]);
  let tete = fontFaceCss(familles, frontendUrl);
  if (google.length) {
    const q = google
      .map(
        (f) =>
          `family=${f.replace(/ /g, '+')}:ital,wght@0,400;0,700;1,400;1,700`,
      )
      .join('&');
    tete = `<link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet">${tete}`;
  }
  tete += '<style>body{margin:0}</style>';
  const groupes = famillesDuModele(pages);
  return tete + pages.map((p) => bloc(p, groupes)).join('');
}

/** Rôles minimum avant création (mêmes messages que le Python). */
export function verifierRoles(pages: any[]): void {
  const roles = pages.map(
    (p) =>
      new Set(
        (Array.isArray(p?.elements) ? p.elements : []).map((e: any) =>
          chaine(e?.role),
        ),
      ),
  );
  if (!roles[0].has('accroche'))
    throw new ModeleInvalide(
      "Choisis le texte de la couverture qui recevra l'accroche.",
    );
  if (!roles[1].has('titre'))
    throw new ModeleInvalide(
      "Choisis le texte de la slide d'étape qui recevra le titre.",
    );
}
