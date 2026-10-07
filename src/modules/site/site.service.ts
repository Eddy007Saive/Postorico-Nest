import { Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'dns/promises';
import * as ipaddr from 'ipaddr.js';
import { ClaudeService, GenerationError } from '../claude/claude.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';

/** Le site n'a pas pu être lu : adresse invalide, injoignable, ou vide.
 * Port direct de backend/services/site_service.py::SiteIllisible. */
export class SiteIllisible extends Error {}

/** Complète le schéma manquant et refuse tout ce qui n'est pas du web public.
 * Port direct de backend/services/site_service.py::normaliser.
 *
 * Anti-SSRF : l'adresse vient du client et la requête part de NOTRE serveur. Sans ce
 * garde-fou, un client pourrait nous faire lire le réseau interne de l'hébergeur
 * (métadonnées cloud, bases internes…). `ipaddr.js` classe une IP résolue dans une
 * plage nommée ('unicast', 'private', 'loopback', 'linkLocal', 'reserved',
 * 'carrierGradeNat', 'multicast'...) — seule 'unicast' est publique ; tout le reste est
 * refusé, ce qui couvre au moins les quatre cas exclus côté Python (is_private,
 * is_loopback, is_link_local, is_reserved) et déborde volontairement plus large. */
export async function normaliserUrl(urlInput: string): Promise<string> {
  let url = (urlInput || '').trim();
  if (!url) throw new SiteIllisible('Adresse vide.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SiteIllisible('Adresse invalide.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new SiteIllisible('Adresse invalide.');
  }

  let adresses: Array<{ address: string }>;
  try {
    adresses = await dnsLookup(parsed.hostname, { all: true });
  } catch {
    throw new SiteIllisible("Ce domaine n'existe pas.");
  }
  for (const { address } of adresses) {
    if (ipaddr.process(address).range() !== 'unicast') {
      throw new SiteIllisible("Cette adresse n'est pas publique.");
    }
  }
  return url;
}

const MODELE = 'claude-haiku-4-5';
const TEXTE_MAX = 9000; // au-delà, on n'apprend plus rien de plus sur la marque
// 30 s : un site lourd rendu en JavaScript met facilement 25 s à se poser. Action
// ponctuelle (Pack Fondations), faite une fois par compte.
const DELAI_MS = 30_000;
const NAVIGATEUR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LOGO_MAX = 5 * 1024 * 1024;
// Au-delà, le logo ne transite pas dans la réponse d'analyse : un aperçu ne justifie pas
// d'alourdir la page à ce point.
const LOGO_INLINE = 400 * 1024;
const TYPES_LOGO = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];

// Polices proposables dans la charte : mêmes listes que les sélecteurs de Paramètres
// (frontend/src/lib/carrouselPreview.js, CAROUSEL_FONTS et CAROUSEL_BODY_FONTS). Une police
// du site hors liste reste affichée pour information, jamais posée sur la fiche.
const POLICES_TITRE = ['Circular Bold', 'TT Norms Pro', 'Wotfard', 'Anton', 'Archivo Black', 'Bebas Neue', 'Oswald',
  'Barlow Condensed', 'Sora', 'Space Grotesk', 'Poppins', 'Montserrat', 'Raleway', 'Nunito', 'Gantari', 'Geologica',
  'Playfair Display', 'Fraunces', 'DM Serif Display', 'Lora'];
const POLICES_CORPS = ['Sora', 'Poppins', 'Montserrat', 'Raleway', 'Nunito', 'Work Sans', 'DM Sans', 'Lora',
  'Source Serif 4', 'Inter', 'Manrope'];

/** Ce que la page livre, avant toute interprétation. */
export interface SiteBrut {
  url: string;
  titre: string;
  description: string;
  couleurs: string[];
  polices: { titre: string; corps: string };
  logo: string;
  logoType: string;
  texte: string;
  liens: string[];
}

// Exécuté DANS la page : texte visible, métadonnées, logo, et surtout les couleurs et polices
// telles que le navigateur les calcule vraiment (pas celles écrites dans le CSS).
const EXTRACTION = `() => {
  const vu = (n) => { const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && n.offsetHeight > 0; };
  const meta = (n) => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '';
  // Le logo se cherche AVANT de nettoyer la page : sur les sites récents il est souvent en
  // SVG dans l'en-tête, et on le supprimerait juste après.
  let logo = '', logoType = '';
  const img = document.querySelector('header img[alt*="logo" i], [class*=logo i] img, header a[href="/"] img, header img, nav img');
  if (img && img.src && img.naturalWidth !== 1) { logo = img.src; logoType = 'image'; }
  if (!logo) {
    for (const svg of document.querySelectorAll('header svg, [class*=logo i] svg, nav svg')) {
      const r = svg.getBoundingClientRect();
      if (r.width < 24 || r.height < 8) continue;
      const c = svg.cloneNode(true);
      // <use href="#id"> pointe vers un symbole défini ailleurs : on recopie la cible.
      let creux = false;
      c.querySelectorAll('use').forEach((u) => {
        const id = (u.getAttribute('href') || u.getAttribute('xlink:href') || '');
        const cible = id.startsWith('#') ? document.querySelector(id) : null;
        if (cible) {
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          [...cible.cloneNode(true).childNodes].forEach((n) => g.appendChild(n));
          u.replaceWith(g);
        } else { creux = true; }
      });
      if (creux) continue;
      if (!c.querySelector('path,rect,circle,ellipse,polygon,polyline,line,text,image')) continue;
      // currentColor et les classes ne suivent pas hors de la page : on fige la couleur calculée.
      const couleur = getComputedStyle(svg).color || '#111';
      c.querySelectorAll('*').forEach((n) => {
        ['fill', 'stroke'].forEach((p) => { const v = n.getAttribute(p); if (v === 'currentColor' || (!v && n.className)) n.setAttribute(p, couleur); });
        n.removeAttribute('class');
      });
      if (!c.getAttribute('xmlns')) c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!c.getAttribute('viewBox') && r.width) c.setAttribute('viewBox', '0 0 ' + Math.round(r.width) + ' ' + Math.round(r.height));
      c.setAttribute('width', Math.round(r.width));
      c.setAttribute('height', Math.round(r.height));
      logo = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(c))));
      logoType = 'svg';
      break;
    }
  }
  if (!logo && meta('og:image')) { logo = meta('og:image'); logoType = 'og'; }
  if (!logo) {
    const ico = document.querySelector('link[rel="apple-touch-icon"], link[rel*="icon"]');
    if (ico) { logo = ico.href; logoType = 'favicon'; }
  }

  // Polices réellement rendues : celle des titres (h1/h2) et celle du texte courant.
  const famille = (sel) => {
    const n = [...document.querySelectorAll(sel)].find(vu);
    if (!n) return '';
    return (getComputedStyle(n).fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
  };
  const polices = { titre: famille('h1, h2'), corps: famille('main p, article p, p, li') };

  document.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());

  // Les couleurs de marque vivent sur ce qui appelle à l'action, pas sur le fond de page.
  const compte = {};
  const cle = (c) => {
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return;
    const m = c.match(/\\d+/g);
    if (!m || m.length < 3) return;
    const [r, g, b] = m.map(Number);
    // Gris, noirs, blancs et gris-bleus d'interface ne sont pas des couleurs de marque :
    // on exige un vrai écart entre composantes ET une saturation franche.
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 40 || (max - min) / max < 0.3) return;
    const h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    compte[h] = (compte[h] || 0) + 1;
  };
  document.querySelectorAll('a,button,header,nav,h1,h2,[class*=btn],[class*=button],[class*=cta]').forEach((n) => {
    if (!vu(n)) return;
    const s = getComputedStyle(n);
    cle(s.backgroundColor); cle(s.color); cle(s.borderColor);
  });
  const couleurs = Object.entries(compte).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);

  return {
    titre: document.title || '',
    description: meta('description') || meta('og:description'),
    couleurs, polices, logo, logoType,
    texte: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXTE_MAX}),
    liens: [...document.querySelectorAll('a')].map((a) => a.innerText.trim()).filter((t) => t && t.length < 40).slice(0, 40),
  };
}`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    secteur: { type: 'string' },
    audience: { type: 'string' },
    voix_marque: { type: 'string' },
    piliers: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    hooks: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    ctas: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    a_eviter: { type: 'string' },
    couleur_principale: { type: 'string' },
    couleur_secondaire: { type: 'string' },
    couleur_accent: { type: 'string' },
  },
  required: ['secteur', 'audience', 'voix_marque', 'piliers', 'hooks', 'ctas'],
  additionalProperties: false,
};

const CONSIGNE = `Tu lis le site web d'une entreprise et tu en déduis sa fiche de marque,
celle qui servira à écrire ses publications sur les réseaux sociaux.

Règles :
- Écris en {langue}, avec les accents et la ponctuation correcte.
- Tu décris CETTE entreprise, pas une entreprise générique. Reprends son
  vocabulaire, ses offres, ses noms de produits tels qu'ils apparaissent.
- « secteur » : une formule courte et concrète (« cabinet de kinésithérapie »,
  pas « santé et bien-être »).
- « audience » : à qui elle parle vraiment, en une phrase.
- « voix_marque » : le ton, en deux ou trois phrases, tel qu'on le ressent sur
  le site. Si le site est sobre et technique, ne l'écris pas pétillant.
- « piliers » : 3 à 5 thèmes de contenu que cette entreprise peut tenir dans la
  durée, tirés de ce qu'elle fait réellement.
- « hooks » : 3 à 5 accroches prêtes à l'emploi, dans sa voix. Reprends en priorité
  les formules fortes du site (titres, slogans) plutôt que d'en inventer.
- « ctas » : 2 à 4 appels à l'action correspondant à ce qu'elle vend, en partant de
  ceux qui figurent sur ses boutons.
- « a_eviter » : mots, promesses ou tons qui trahiraient cette marque.
- Les couleurs : choisis parmi celles relevées sur le site. La principale est
  celle qui domine, l'accent celle qui attire l'œil. Format #RRGGBB. Si aucune
  couleur n'a été relevée, laisse ces trois champs vides.

N'invente pas de chiffres, de récompenses ni de références clients absents du site.`;

const LANGUES: Record<string, string> = { fr: 'français', en: 'anglais', es: 'espagnol' };

/** Prend la police de la liste qui correspond au nom relevé sur le site (casse et espaces ignorés). */
function policeConnue(nom: string, liste: string[]): string {
  const n = (nom || '').toLowerCase().replace(/\s+/g, '');
  if (!n) return '';
  return liste.find((p) => p.toLowerCase().replace(/\s+/g, '') === n) || '';
}

/**
 * Pré-remplissage de la fiche de marque à partir du site web du client — port de
 * backend/services/site_service.py, plus les polices réellement rendues (idée reprise de
 * /brag). On charge la page dans un vrai navigateur et non par un simple GET : la moitié des
 * sites d'aujourd'hui sont en React, un GET n'y renvoie qu'une coquille vide. La fiche est
 * proposée, jamais enregistrée ici : l'équipe relit, puis applique.
 */
@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);

  constructor(
    private readonly playwright: PlaywrightBrowserService,
    private readonly claude: ClaudeService,
  ) {}

  /** Charge la page et en extrait la matière brute. Navigateur d'abord (rend le
   * JavaScript, donne les vraies couleurs) ; sinon simple téléchargement. */
  async lire(urlInput: string): Promise<SiteBrut> {
    const url = await normaliserUrl(urlInput);
    try {
      return await this.lireAvecNavigateur(url);
    } catch (e) {
      if (!(e instanceof SiteIllisible)) throw e;
      this.logger.log(`navigateur en échec sur ${url} (${e.message}), repli sur le téléchargement`);
      let brut: SiteBrut;
      try {
        brut = await this.lireSansNavigateur(url);
      } catch {
        throw e;
      }
      if ((brut.texte || '').length < 120) throw e;
      return brut;
    }
  }

  private async lireAvecNavigateur(url: string): Promise<SiteBrut> {
    const navigateur = await this.playwright.launch();
    let brut: SiteBrut;
    try {
      // Sans user-agent crédible, beaucoup de sites servent une page anti-robot.
      const page = await navigateur.newPage({ viewport: { width: 1440, height: 900 }, userAgent: NAVIGATEUR_UA, locale: 'fr-FR' });
      page.setDefaultTimeout(DELAI_MS);
      try {
        // « domcontentloaded » et pas « load » : sur un gros site, le load attend toutes les
        // images et les traceurs, et on expire alors que le texte est lisible depuis longtemps.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DELAI_MS });
      } catch {
        throw new SiteIllisible("Le site n'a pas répondu à temps.");
      }
      // On laisse le rendu client s'installer, sans en dépendre.
      try {
        await page.waitForLoadState('networkidle', { timeout: 4000 });
      } catch {
        await page.waitForTimeout(1500);
      }
      brut = (await page.evaluate(`(${EXTRACTION})()`)) as SiteBrut;
      brut.url = page.url();
      if (brut.logo && !brut.logo.startsWith('data:')) brut.logo = new URL(brut.logo, page.url()).href;
    } finally {
      await navigateur.close().catch(() => undefined);
    }
    if ((brut.texte || '').length < 120) {
      throw new SiteIllisible('Ce site ne contient pas assez de texte pour en déduire une marque.');
    }
    return brut;
  }

  /** Repli : HTML téléchargé et dépouillé à la main. Pas de couleurs calculées ni de
   * polices, mais ça rattrape les pages trop lourdes pour le navigateur. */
  private async lireSansNavigateur(url: string): Promise<SiteBrut> {
    const r = await this.telecharger(url, 15_000);
    const src = await r.text();
    const meta = (nom: string) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["']${nom}["'][^>]+content=["']([^"']+)`, 'i').exec(src);
      return m ? decoderEntites(m[1]) : '';
    };
    const corps = src.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ');
    const texte = decoderEntites(corps.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, TEXTE_MAX);
    const compte: Record<string, number> = {};
    for (const [, h] of src.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const [r_, g_, b_] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      const mx = Math.max(r_, g_, b_), mn = Math.min(r_, g_, b_);
      if (mx - mn < 40 || (mx - mn) / mx < 0.3) continue;
      const cle = `#${h.toLowerCase()}`;
      compte[cle] = (compte[cle] || 0) + 1;
    }
    const titre = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
    const og = meta('og:image');
    return {
      url: r.url,
      titre: titre ? decoderEntites(titre[1]).trim() : '',
      description: meta('description') || meta('og:description'),
      couleurs: Object.entries(compte).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c),
      polices: { titre: '', corps: '' },
      logo: og ? new URL(og, r.url).href : '',
      logoType: og ? 'og' : '',
      texte,
      liens: [],
    };
  }

  /** GET qui suit les redirections À LA MAIN : chaque saut repasse par le garde-fou
   * anti-SSRF (une redirection pourrait viser le réseau interne). */
  private async telecharger(url: string, delaiMs: number): Promise<Response> {
    let courant = url;
    for (let saut = 0; saut < 5; saut++) {
      const r = await fetch(courant, {
        redirect: 'manual',
        signal: AbortSignal.timeout(delaiMs),
        headers: { 'user-agent': NAVIGATEUR_UA, 'accept-language': 'fr-FR,fr;q=0.9' },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        courant = await normaliserUrl(new URL(r.headers.get('location') as string, courant).href);
        continue;
      }
      if (!r.ok) throw new SiteIllisible(`Le site a répondu ${r.status}.`);
      return r;
    }
    throw new SiteIllisible('Trop de redirections.');
  }

  /** Transforme la matière brute en fiche de marque exploitable (Claude, sortie outillée). */
  async deduire(brut: SiteBrut, langue = 'fr'): Promise<Record<string, unknown>> {
    const contenu =
      `Adresse : ${brut.url}\n` +
      `Titre : ${brut.titre}\n` +
      `Description : ${brut.description}\n` +
      `Couleurs relevées : ${(brut.couleurs || []).join(', ') || 'aucune'}\n` +
      `Navigation : ${(brut.liens || []).join(' · ')}\n\n` +
      `Contenu de la page :\n${brut.texte}`;
    const rep = await this.claude.messagesCreate({
      model: MODELE,
      max_tokens: 2000,
      system: CONSIGNE.replace('{langue}', LANGUES[(langue || 'fr').slice(0, 2)] || 'français'),
      messages: [{ role: 'user', content: contenu }],
      tools: [{ name: 'fiche_de_marque', description: 'La fiche de marque déduite du site.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'fiche_de_marque' },
    });
    for (const bloc of rep.content) {
      if (bloc.type === 'tool_use') return { ...(bloc.input as Record<string, unknown>) };
    }
    throw new GenerationError('Analyse du site impossible.');
  }

  /** Lit le site et renvoie la fiche déduite, à faire valider. Rien n'est enregistré. */
  async analyser(url: string, langue = 'fr'): Promise<Record<string, unknown>> {
    const brut = await this.lire(url);
    const fiche = await this.deduire(brut, langue);

    // Polices : proposées seulement si elles existent dans les sélecteurs de la charte.
    const titre = policeConnue(brut.polices?.titre, POLICES_TITRE);
    const corps = policeConnue(brut.polices?.corps, POLICES_CORPS);
    if (titre) fiche.typo_primaire = titre;
    if (corps) fiche.typo_secondaire = corps;

    // On ne propose un logo qu'après l'avoir réellement récupéré, et on le renvoie inline :
    // un serveur qui refuse les appels d'un autre domaine laisserait sinon un cadre vide.
    if (brut.logo) {
      try {
        const { donnees, type } = await this.telechargerLogo(brut.logo);
        if (donnees.length <= LOGO_INLINE) {
          fiche.logo_url = `data:${type};base64,${donnees.toString('base64')}`;
          fiche.logo_type = brut.logoType || 'image';
        }
      } catch (e) {
        this.logger.log(`logo écarté (${brut.logoType}): ${e instanceof Error ? e.message : e}`);
      }
    }
    fiche._source = { url: brut.url, titre: brut.titre, couleurs: brut.couleurs, polices: brut.polices };
    this.logger.log(`site analysé : ${brut.url} -> ${String(fiche.secteur || '')}`);
    return fiche;
  }

  /** Récupère le logo repéré, prêt à être poussé sur Cloudinary. L'adresse repasse par le
   * garde-fou : elle transite par le navigateur du client et pourrait être remplacée. */
  async telechargerLogo(urlInput: string): Promise<{ donnees: Buffer; type: string }> {
    const url = (urlInput || '').trim();
    if (!url) throw new SiteIllisible('Aucun logo à récupérer.');
    if (url.startsWith('data:image/')) {
      const virgule = url.indexOf(',');
      const type = url.slice(5, virgule).split(';')[0].toLowerCase();
      if (!TYPES_LOGO.includes(type) || !url.slice(0, virgule).includes(';base64')) {
        throw new SiteIllisible("Ce fichier n'est pas une image.");
      }
      const charge = url.slice(virgule + 1);
      if (!/^[A-Za-z0-9+/=\s]+$/.test(charge)) throw new SiteIllisible('Ce logo est illisible.');
      const donnees = Buffer.from(charge, 'base64');
      if (donnees.length > LOGO_MAX) throw new SiteIllisible('Logo trop lourd.');
      return { donnees, type };
    }
    const r = await this.telecharger(await normaliserUrl(url), 20_000);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES_LOGO.includes(type)) throw new SiteIllisible("Ce fichier n'est pas une image.");
    const donnees = Buffer.from(await r.arrayBuffer());
    if (donnees.length > LOGO_MAX) throw new SiteIllisible('Logo trop lourd.');
    return { donnees, type };
  }

  /** Ancienne route GET /site/analyser (admin) : même analyse. */
  async analyserSite(url: string) {
    return this.analyser(url);
  }
}

function decoderEntites(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
