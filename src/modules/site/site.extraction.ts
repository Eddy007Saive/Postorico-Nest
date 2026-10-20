import { HTMLElement, parse } from 'node-html-parser';

/** Extraction pure (sans réseau) de ce qu'un site dit de sa marque : texte visible,
 * métadonnées, liens réseaux sociaux, logo, couleurs, polices. Tout est testable sur un
 * HTML de fixture ; la lecture réseau (et l'anti-SSRF) vit dans site.service.ts.
 *
 * On travaille sur le HTML servi, sans navigateur : un site 100 % rendu en JavaScript
 * ne livrera que ses métadonnées. C'est assumé — l'ancienne version Playwright mettait
 * 30 s par site, inacceptable sur un formulaire public. */

export type LogoType = 'image' | 'og' | 'favicon';

export interface PageExtraite {
  url: string;
  langue: string;
  titre: string;
  description: string;
  og: Record<string, string>;
  themeColor: string;
  texte: string;
  /** Données structurées (JSON-LD) en texte brut, tronquées : nom, adresse, date de création… */
  jsonLd: string;
  liens: Array<{ href: string; texte: string }>;
  reseaux: string[];
  logo: string;
  logoType: LogoType | '';
  /** CSS écrit dans la page (balises <style> + attributs style). */
  cssInline: string;
  /** Feuilles CSS liées (URL absolues, tous domaines : le filtrage se fait à la lecture). */
  feuillesCss: string[];
  /** Familles demandées à Google Fonts via <link>. */
  googleFonts: string[];
}

const JSONLD_MAX = 3000;

// ------------------------------------------------------------------ outils

function absolue(href: string, base: string): string {
  try {
    const u = new URL(href.trim(), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

/** Domaine sans le « www. », pour comparer site.fr et www.site.fr. */
export function domaine(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function meta(root: HTMLElement, nom: string): string {
  for (const m of root.querySelectorAll('meta')) {
    const n = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    if (n === nom) return (m.getAttribute('content') || '').trim();
  }
  return '';
}

// Bandeaux cookies et consentement : du texte répété, sans rapport avec la marque.
const BRUIT = /cookie|consent|gdpr|rgpd|tarteaucitron|axeptio|didomi|onetrust/i;

// ------------------------------------------------------------------ réseaux sociaux

const RESEAUX: Array<{ nom: string; hote: RegExp; profil: (chemin: string[]) => boolean }> = [
  {
    nom: 'instagram',
    hote: /(^|\.)instagram\.com$/,
    profil: (c) => c.length >= 1 && !['p', 'reel', 'reels', 'stories', 'explore', 'share'].includes(c[0]),
  },
  {
    nom: 'linkedin',
    hote: /(^|\.)linkedin\.com$/,
    profil: (c) => ['company', 'in', 'school', 'showcase'].includes(c[0]) && c.length >= 2,
  },
  {
    nom: 'facebook',
    hote: /(^|\.)(facebook|fb)\.com$/,
    profil: (c) =>
      c.length >= 1 && !['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login'].includes(c[0]),
  },
  { nom: 'tiktok', hote: /(^|\.)tiktok\.com$/, profil: (c) => c.length >= 1 && c[0].startsWith('@') },
  {
    nom: 'youtube',
    hote: /(^|\.)youtube\.com$/,
    profil: (c) => c.length >= 1 && (c[0].startsWith('@') || (['channel', 'c', 'user'].includes(c[0]) && c.length >= 2)),
  },
  {
    nom: 'x',
    hote: /(^|\.)(x|twitter)\.com$/,
    profil: (c) =>
      c.length === 1 && !['intent', 'share', 'home', 'hashtag', 'search', 'i', 'login'].includes(c[0].toLowerCase()),
  },
];

/** Un lien de profil par réseau (le premier trouvé), sans les liens de partage. */
export function reseauxSociaux(urls: string[]): string[] {
  const trouves = new Map<string, string>();
  for (const brut of urls) {
    let u: URL;
    try {
      u = new URL(brut);
    } catch {
      continue;
    }
    const hote = u.hostname.toLowerCase();
    const chemin = u.pathname.split('/').filter(Boolean);
    for (const r of RESEAUX) {
      if (!trouves.has(r.nom) && r.hote.test(hote) && r.profil(chemin)) {
        trouves.set(r.nom, `https://${hote}/${chemin.join('/')}`);
      }
    }
  }
  return RESEAUX.map((r) => trouves.get(r.nom)).filter((x): x is string => !!x);
}

// ------------------------------------------------------------------ logo

function tailleIcone(link: HTMLElement): number {
  const sizes = (link.getAttribute('sizes') || '').toLowerCase();
  if (sizes === 'any' || /svg/.test(link.getAttribute('type') || '') || /\.svg(\?|$)/i.test(link.getAttribute('href') || '')) {
    return 512;
  }
  const dims = [...sizes.matchAll(/(\d+)x(\d+)/g)].map((m) => Math.max(+m[1], +m[2]));
  if (dims.length) return Math.max(...dims);
  return /apple-touch-icon/.test((link.getAttribute('rel') || '').toLowerCase()) ? 180 : 16;
}

/** og:image si c'est manifestement un logo, sinon la plus grande icône déclarée, sinon
 * une image dont alt/class/src/id (ou le conteneur) parle de « logo ». */
export function trouverLogo(root: HTMLElement, base: string): { logo: string; logoType: LogoType | '' } {
  const og = meta(root, 'og:image');
  const ogAlt = meta(root, 'og:image:alt');
  if (og && /logo/i.test(`${og} ${ogAlt}`)) {
    const u = absolue(og, base);
    if (u) return { logo: u, logoType: 'og' };
  }

  const icones = root
    .querySelectorAll('link')
    .filter((l) => /(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test((l.getAttribute('rel') || '').toLowerCase()))
    .map((l) => ({ url: absolue(l.getAttribute('href') || '', base), taille: tailleIcone(l) }))
    .filter((i) => i.url)
    .sort((a, b) => b.taille - a.taille);
  if (icones.length) return { logo: icones[0].url, logoType: 'favicon' };

  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (!src || src.startsWith('data:')) continue;
    const parent = img.parentNode;
    const indices = [img.getAttribute('alt'), img.getAttribute('class'), img.getAttribute('id'), src, parent?.getAttribute?.('class')]
      .filter(Boolean)
      .join(' ');
    if (/logo/i.test(indices)) {
      const u = absolue(src, base);
      if (u) return { logo: u, logoType: 'image' };
    }
  }
  return { logo: '', logoType: '' };
}

// ------------------------------------------------------------------ couleurs

export function versHex(valeur: string): string {
  const v = (valeur || '').trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})\b/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
    return '';
  }
  m = v.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*([\d.]+%?))?\s*\)/);
  if (m) {
    const alpha = m[4] ? parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1) : 1;
    if (alpha < 0.5) return '';
    return '#' + [m[1], m[2], m[3]].map((x) => Math.min(255, +x).toString(16).padStart(2, '0')).join('');
  }
  m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*([\d.]+%?))?\s*\)/);
  if (m) {
    const alpha = m[4] ? parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1) : 1;
    if (alpha < 0.5) return '';
    const h = (+m[1] % 360) / 360;
    const s = +m[2] / 100;
    const l = +m[3] / 100;
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Blancs, noirs, gris (même légèrement teintés) : jamais une couleur de marque. */
export function estNeutre(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function proches(a: string, b: string): boolean {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 30;
}

const COULEUR_CSS = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const VAR_MARQUE = /--([\w-]*(?:primary|brand|accent|secondary|main|theme)[\w-]*)\s*:\s*([^;}{]+)/gi;

/** Couleurs de marque, de la plus sûre à la moins sûre : theme-color, variables CSS
 * nommées (--primary, --brand…), puis les couleurs les plus fréquentes du CSS. */
export function couleursDominantes(themeColor: string, css: string[], max = 3): string[] {
  const ordre: string[] = [];
  const ajouter = (hex: string) => {
    if (hex && !estNeutre(hex) && !ordre.some((c) => proches(c, hex))) ordre.push(hex);
  };

  ajouter(versHex(themeColor));

  const tout = css.join('\n');
  const vars: Array<{ nom: string; hex: string }> = [];
  for (const m of tout.matchAll(VAR_MARQUE)) {
    const hex = versHex(m[2]);
    if (hex) vars.push({ nom: m[1].toLowerCase(), hex });
  }
  const rang = (n: string) => (/primary|brand|main|theme/.test(n) ? 0 : /secondary/.test(n) ? 1 : 2);
  vars.sort((a, b) => rang(a.nom) - rang(b.nom)).forEach((v) => ajouter(v.hex));

  const compte = new Map<string, number>();
  for (const m of tout.matchAll(COULEUR_CSS)) {
    const hex = versHex(m[0]);
    if (hex && !estNeutre(hex)) compte.set(hex, (compte.get(hex) || 0) + 1);
  }
  [...compte.entries()].sort((a, b) => b[1] - a[1]).forEach(([hex]) => ajouter(hex));

  return ordre.slice(0, max);
}

// ------------------------------------------------------------------ polices

const POLICES_GENERIQUES = new Set([
  'inherit', 'initial', 'unset', 'revert', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'helvetica', 'helvetica neue', 'arial',
  'apple color emoji', 'segoe ui emoji', 'segoe ui symbol', 'noto color emoji', 'ui-sans-serif', 'ui-serif',
  'ui-monospace', 'ui-rounded', 'courier', 'courier new', 'menlo', 'monaco', 'consolas', 'liberation mono',
  'sfmono-regular', 'times', 'times new roman', 'georgia', 'verdana', 'tahoma', 'emoji', 'math', 'fangsong',
]);
const POLICES_ICONES = /awesome|icon|glyph|dashicons|eicons|swiper|slick|fa-|fontello|icomoon|material symbols|star|fallback|source.?code|\bmono\b|mono$/i;

export function famillesGoogleFonts(urls: string[]): string[] {
  const out: string[] = [];
  for (const brut of urls) {
    let u: URL;
    try {
      u = new URL(brut);
    } catch {
      continue;
    }
    if (!/fonts\.googleapis\.com$/i.test(u.hostname)) continue;
    for (const fam of u.searchParams.getAll('family')) {
      for (const f of fam.split('|')) {
        const nom = f.split(':')[0].replace(/\+/g, ' ').trim();
        if (nom) out.push(nom);
      }
    }
  }
  return out;
}

/** Polices de la marque : Google Fonts d'abord (choix explicite), puis les familles les
 * plus citées dans le CSS, sans les polices système ni les polices d'icônes. */
export function polices(googleFonts: string[], css: string[], max = 3): string[] {
  const compte = new Map<string, { nom: string; n: number }>();
  const noter = (nom: string, poids: number) => {
    const propre = nom.trim().replace(/^['"]|['"]$/g, '').trim();
    const cle = propre.toLowerCase();
    if (!propre || propre.length > 40 || POLICES_GENERIQUES.has(cle) || POLICES_ICONES.test(cle)) return;
    if (cle.startsWith('var(') || /[{}();]/.test(cle)) return;
    const e = compte.get(cle) || { nom: propre, n: 0 };
    e.n += poids;
    compte.set(cle, e);
  };
  googleFonts.forEach((f) => noter(f, 1000));
  const tout = css.join('\n');
  for (const m of tout.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    // La première famille de la pile est celle voulue ; les suivantes sont des replis.
    noter(m[1].replace(/!important/i, '').split(',')[0], 1);
  }
  for (const m of tout.matchAll(/@import\s+url\(\s*['"]?([^'")]+)/gi)) {
    famillesGoogleFonts([m[1]]).forEach((f) => noter(f, 1000));
  }
  return [...compte.values()].sort((a, b) => b.n - a.n).slice(0, max).map((e) => e.nom);
}

// ------------------------------------------------------------------ page

/** Lit une page HTML. `nettoyerEntete` retire aussi header/footer (pages internes : ils
 * répètent ceux de l'accueil). */
export function extrairePage(html: string, url: string, nettoyerEntete = false): PageExtraite {
  const root = parse(html, { comment: false });

  const og: Record<string, string> = {};
  for (const m of root.querySelectorAll('meta')) {
    const n = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    if (n.startsWith('og:') && !og[n]) og[n] = (m.getAttribute('content') || '').trim();
  }

  const jsonLd = root
    .querySelectorAll('script')
    .filter((s) => /ld\+json/i.test(s.getAttribute('type') || ''))
    .map((s) => s.rawText.replace(/\s+/g, ' ').trim())
    .join('\n')
    .slice(0, JSONLD_MAX);
  // Les données structurées listent souvent les réseaux (sameAs).
  const urlsJsonLd = [...jsonLd.matchAll(/https?:\/\/[^"'\s,\]]+/g)].map((m) => m[0]);

  const { logo, logoType } = trouverLogo(root, url);

  const cssInline = [
    ...root.querySelectorAll('style').map((s) => s.rawText),
    ...root.querySelectorAll('[style]').map((n) => n.getAttribute('style') || ''),
  ].join('\n');
  const liensHead = root.querySelectorAll('link');
  const feuillesCss = liensHead
    .filter((l) => /(^|\s)stylesheet(\s|$)/i.test(l.getAttribute('rel') || ''))
    .map((l) => absolue(l.getAttribute('href') || '', url))
    .filter(Boolean);
  const googleFonts = famillesGoogleFonts(liensHead.map((l) => absolue(l.getAttribute('href') || '', url)));

  const liens: Array<{ href: string; texte: string }> = [];
  for (const a of root.querySelectorAll('a')) {
    const href = absolue(a.getAttribute('href') || '', url);
    if (href) liens.push({ href, texte: a.text.replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  const reseaux = reseauxSociaux([...liens.map((l) => l.href), ...urlsJsonLd]);

  // Texte visible : on retire tout ce qui n'est pas lu par un humain.
  root
    .querySelectorAll('script,style,noscript,svg,template,iframe,nav,canvas,object')
    .forEach((n) => n.remove());
  if (nettoyerEntete) root.querySelectorAll('header,footer').forEach((n) => n.remove());
  root
    .querySelectorAll('[class],[id],[aria-hidden],[hidden]')
    .filter(
      (n) =>
        n.getAttribute('aria-hidden') === 'true' ||
        n.hasAttribute('hidden') ||
        // Garde-fou : un conteneur large (body class="cookie-ok"…) n'est pas un bandeau.
        (!['HTML', 'BODY', 'MAIN'].includes(n.tagName) &&
          BRUIT.test(`${n.getAttribute('class') || ''} ${n.getAttribute('id') || ''}`) &&
          n.text.length < 1500),
    )
    .forEach((n) => n.remove());
  const corps = root.querySelector('body') || root;
  const texte = corps.structuredText
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return {
    url,
    langue: (root.querySelector('html')?.getAttribute('lang') || og['og:locale'] || '').trim(),
    titre: (root.querySelector('title')?.text || '').replace(/\s+/g, ' ').trim(),
    description: meta(root, 'description') || og['og:description'] || '',
    og,
    themeColor: meta(root, 'theme-color'),
    texte,
    jsonLd,
    liens,
    reseaux,
    logo,
    logoType,
    cssInline,
    feuillesCss,
    googleFonts,
  };
}

// ------------------------------------------------------------------ pages utiles

const CATEGORIES: Array<{ nom: string; mots: RegExp }> = [
  {
    nom: 'apropos',
    mots: /a-?propos|about|qui-?sommes|qui sommes|notre-?histoire|histoire|equipe|équipe|team|nosotros|quienes|quiénes|story|mission/i,
  },
  { nom: 'services', mots: /services?|prestations?|servicios|expertises?|savoir-?faire|solutions?/i },
  { nom: 'offres', mots: /offres?|tarifs?|prix|pricing|plans?|precios|formules?|abonnements?/i },
  { nom: 'contact', mots: /contact|contacto|nous-?trouver|coordonn/i },
];

/** Jusqu'à `max` pages internes utiles (une par catégorie d'abord), même domaine. */
export function pagesUtiles(liens: Array<{ href: string; texte: string }>, accueil: string, max = 4): string[] {
  const dom = domaine(accueil);
  const accueilPropre = accueil.replace(/[#?].*$/, '').replace(/\/$/, '');
  const parCategorie = new Map<string, string[]>();
  const vus = new Set<string>();
  for (const { href, texte } of liens) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (domaine(href) !== dom) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
    const propre = `${u.origin}${u.pathname}`.replace(/\/$/, '');
    if (propre === accueilPropre || propre === u.origin || vus.has(propre)) continue;
    const chemin = decodeURIComponent(u.pathname);
    const cat = CATEGORIES.find((c) => c.mots.test(chemin) || c.mots.test(texte));
    if (!cat) continue;
    vus.add(propre);
    parCategorie.set(cat.nom, [...(parCategorie.get(cat.nom) || []), propre]);
  }
  const choisies: string[] = [];
  // Un tour par catégorie, puis on complète avec les suivantes.
  for (let tour = 0; choisies.length < max && tour < 3; tour++) {
    for (const c of CATEGORIES) {
      const p = parCategorie.get(c.nom)?.[tour];
      if (p && choisies.length < max) choisies.push(p);
    }
  }
  return choisies;
}
