import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PDFDocument } from 'pdf-lib';
import { Semaphore } from '../../common/utils/semaphore.util';
import { PrismaService } from '../../config/prisma.service';
import { MarqueService } from '../marque/marque.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';
import { UsageService } from '../usage/usage.service';
import { CarrouselCustomService } from './carrousel-custom.service';
import { RicoPosesService } from './rico-poses.service';
import { buildHtml, EXCLUSIFS, TEMPLATES } from './templates/build-html';
import { CarrouselContentShape, parts } from './templates/common.util';

const SLIDE_W = 360;
const SLIDE_H = 450;
const DSF = 3; // device scale factor -> 1080×1350

// --- Atelier de rendu : combien de Chromium tournent en même temps -------------
// Même limite que côté Python (backend/services/carrousel_service.py) : sans borne,
// rien n'empêche plusieurs clients de lancer plusieurs Chromium à la fois, et ce n'est
// pas le rendu de trop qui tombe alors, c'est le process entier.
const RENDUS_SIMULTANES = 3;
const ATTENTE_MAX_S = 45; // au-delà, le proxy coupera de toute façon

export class AtelierSatureError extends Error {}

const atelier = new Semaphore(RENDUS_SIMULTANES, () => new AtelierSatureError());

/** Exécute un rendu Playwright une place à la fois. Attendre son tour, oui ; attendre
 * indéfiniment, non : l'appelant doit répondre 503 (AtelierSatureError), pas faire
 * attendre le client pendant que le serveur continue de travailler pour rien. */
/** Exporté : StoryService (module reel) réutilise la MÊME file d'attente (un seul atelier
 * de rendu Playwright partagé entre carrousels et stories, comme côté Python où
 * story_service importe directement carrousel_service._rendre / AtelierSature). */
/** Upload un buffer à Cloudinary via upload_stream (flux binaire direct), au lieu d'une
 * data URI base64 : évite le +33% de payload et le coût CPU de l'encodage — sensible sur
 * un carrousel qui enchaîne 5 à 8 uploads d'affilée. Le SDK Node n'accepte pas un Buffer
 * en argument direct de `.upload()` (contrairement au SDK Python), d'où ce flux. */
function uploadBuffer(buffer: Buffer, options: Record<string, unknown>): Promise<{ secure_url: string }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result) {
        reject(error instanceof Error ? error : new Error(String(error || 'cloudinary upload failed')));
        return;
      }
      resolve(result as { secure_url: string });
    });
    stream.end(buffer);
  });
}

export async function rendre<T>(fn: () => Promise<T>): Promise<T> {
  await atelier.acquire(ATTENTE_MAX_S * 1000);
  try {
    return await fn();
  } finally {
    atelier.release();
  }
}

// Polices d'affichage utilisées par les templates (remplacées par la police choisie)
const DISPLAY_FONTS = ['Anton', 'Fraunces', 'Sora'];

/** Polices de marque (fichiers, PAS sur Google Fonts) : servies depuis frontend/public/fonts/
 * — mêmes fichiers que l'aperçu navigateur (cf. carrouselPreview.js côté front). Plusieurs
 * graisses -> une seule famille CSS, comme Google Fonts. Port de `_CUSTOM_FONTS`
 * (backend/services/carrousel_service.py). */
export const CUSTOM_FONTS: Record<string, Array<{ file: string; format: string; weight: string }>> = {
  'Circular Bold': [{ file: 'CircularBold.ttf', format: 'truetype', weight: '100 900' }],
  Wotfard: [{ file: 'Wotfard-Regular.woff2', format: 'woff2', weight: '100 500' }],
  'TT Norms Pro': [
    { file: 'TTNormsPro-Regular.otf', format: 'opentype', weight: '400' },
    { file: 'TTNormsPro-Medium.otf', format: 'opentype', weight: '500' },
    { file: 'TTNormsPro-Bold.otf', format: 'opentype', weight: '700' },
    { file: 'TTNormsPro-ExtraBold.otf', format: 'opentype', weight: '800 900' },
  ],
};

/** @font-face pour les polices de marque parmi `fams` (les Google Fonts sont ignorées ici).
 * `frontendUrl` est l'origine qui sert /fonts/… — port de `_font_face_css`. */
export function fontFaceCss(fams: string[], frontendUrl: string): string {
  const blocks: string[] = [];
  for (const fam of fams) {
    for (const face of CUSTOM_FONTS[fam] ?? []) {
      const url = `${frontendUrl}/fonts/${face.file}`;
      blocks.push(
        `@font-face{font-family:'${fam}';src:url('${url}') format('${face.format}');font-weight:${face.weight};font-display:swap;}`,
      );
    }
  }
  return blocks.length ? `<style>${blocks.join('')}</style>` : '';
}

/** Décode "Famille" ou "Famille|bi" (b = gras, i = italique) -> famille + style. Même
 * convention que parseFontSpec() côté front (carrouselPreview.js) : pas de colonne dédiée,
 * la chaîne qui porte la famille porte aussi le style — port de `_parse_font_spec`. */
export function parseFontSpec(spec?: string | null): { famille: string | null; gras: boolean; italique: boolean } {
  if (!spec) return { famille: null, gras: false, italique: false };
  const [famille, flags = ''] = spec.split('|', 2);
  return { famille: famille || null, gras: flags.includes('b'), italique: flags.includes('i') };
}

function styleOverride(gras: boolean, italique: boolean): string {
  return (gras ? 'font-weight:700 !important;' : '') + (italique ? 'font-style:italic !important;' : '');
}

/** Applique les polices choisies + charge les polices correspondantes (Google Fonts, ou
 * @font-face pour les polices de marque, cf. CUSTOM_FONTS). `font` = police d'AFFICHAGE
 * (titres), `fontCorps` = police du TEXTE (corps, Inter par défaut). Valeur vide -> police
 * d'origine du template. `frontendUrl` sert d'origine aux fichiers @font-face — port de
 * `_apply_font` (backend/services/carrousel_service.py). */
export function applyFont(htmlStr: string, font?: string | null, fontCorps?: string | null, frontendUrl = ''): string {
  if (!font && !fontCorps) return htmlStr;
  const aff = parseFontSpec(font);
  const corps = parseFontSpec(fontCorps);
  const fams = Array.from(new Set([aff.famille, corps.famille].filter((f): f is string => Boolean(f))));
  const googleFams = fams.filter((f) => !(f in CUSTOM_FONTS));
  let out = htmlStr;
  if (googleFams.length) {
    const q = googleFams.map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700;800;900`).join('&');
    out = `<link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet">` + out;
  }
  out = fontFaceCss(fams, frontendUrl) + out;
  if (aff.famille) {
    const override = styleOverride(aff.gras, aff.italique);
    for (const f of DISPLAY_FONTS) {
      out = out.split(`font-family:${f}`).join(`font-family:'${aff.famille}';${override}`);
    }
  }
  if (corps.famille) {
    const override = styleOverride(corps.gras, corps.italique);
    out = out.split('font-family:Inter').join(`font-family:'${corps.famille}';${override}`);
  }
  return out;
}

// Auto-ajustement injecté dans la page : réduit la taille des titres (puis du sous-texte)
// tant que le contenu déborde de la slide -> plus de texte coupé quand l'accroche/le
// titre est long. Identique au script côté Python (page.evaluate).
const AUTO_SHRINK_SCRIPT = `() => {
  document.querySelectorAll('.slide').forEach(function(sl){
    var heads = Array.prototype.slice.call(sl.querySelectorAll('h1,h2'));
    var guard = 0;
    while (sl.scrollHeight > sl.clientHeight + 1 && guard < 120) {
      var shrunk = false;
      heads.forEach(function(h){
        var c = parseFloat(getComputedStyle(h).fontSize);
        if (c > 15) { h.style.fontSize = (c - 1.5) + 'px'; shrunk = true; }
      });
      if (!shrunk) {
        Array.prototype.slice.call(sl.querySelectorAll('.sub, p')).forEach(function(s){
          var c = parseFloat(getComputedStyle(s).fontSize);
          if (c > 11) { s.style.fontSize = (c - 1) + 'px'; shrunk = true; }
        });
      }
      if (!shrunk) break;
      guard++;
    }
  });
}`;

export interface CarrouselRenduResult {
  images: string[];
  pdf: string | null;
}

@Injectable()
export class CarrouselRenduService {
  private readonly logger = new Logger(CarrouselRenduService.name);
  /** Origine des fichiers @font-face des polices de marque (frontend/public/fonts/). */
  readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marqueService: MarqueService,
    private readonly carrouselCustomService: CarrouselCustomService,
    private readonly ricoPosesService: RicoPosesService,
    private readonly usageService: UsageService,
    private readonly playwrightBrowser: PlaywrightBrowserService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Public : réutilisé par StoryService pour le même garde-fou d'accès au gabarit Rico
   * (mêmes comptes que les carrousels Rico — voir story_service.modeles_pour côté Python). */
  async exclusifsDuCompte(telegramId: string): Promise<Set<string>> {
    try {
      const marque = await this.prisma.marques.findUnique({ where: { telegram_id: telegramId } });
      const csv = marque?.carrousel_templates_exclusifs || '';
      return new Set(
        csv
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      );
    } catch (e) {
      this.logger.warn(`exclusifs carrousel ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return new Set();
    }
  }

  /** Templates proposables à ce compte : les communs + ceux qu'un admin lui a attribués
   * (sur mesure codés en dur ET templates importés depuis le back-office). */
  async templatesAutorises(telegramId: string): Promise<string[]> {
    const accordes = await this.exclusifsDuCompte(telegramId);
    const importesTous = await this.carrouselCustomService.ids();
    const importes = [...importesTous].filter((t) => accordes.has(t));
    return [...TEMPLATES.filter((t) => !EXCLUSIFS.has(t) || accordes.has(t)), ...importes];
  }

  /** Renvoie le template s'il est autorisé pour ce compte, sinon retombe sur « creme ». */
  async templateValide(template: string | undefined, telegramId: string): Promise<string> {
    const t = (template || 'creme').toLowerCase();
    if (!TEMPLATES.includes(t)) {
      // Template importé : il n'est valable que s'il existe ET qu'il a été attribué.
      const ids = await this.carrouselCustomService.ids();
      const accordes = await this.exclusifsDuCompte(telegramId);
      if (ids.has(t) && accordes.has(t)) return t;
      return 'creme';
    }
    if (EXCLUSIFS.has(t)) {
      const accordes = await this.exclusifsDuCompte(telegramId);
      if (!accordes.has(t)) return 'creme';
    }
    return t;
  }

  private async renderAndUpload(
    telegramId: string,
    content: CarrouselContentShape,
    p: string,
    s: string,
    a: string,
    nom: string,
    secteur: string,
    base: string,
    template: string,
    logo: string | null | undefined,
    font: string | null | undefined,
    fontCorps: string | null | undefined,
    customHtml: string | null,
  ): Promise<CarrouselRenduResult> {
    let poseUrls: string[] | undefined;
    if (template === 'rico-studio' || template === 'rico-scene') {
      const [hook, slides, cta] = parts(content);
      const poses = await this.ricoPosesService.choisir(hook, slides, cta.titre);
      poseUrls = poses.map((pose) => this.ricoPosesService.url(pose));
    }
    const htmlStr = applyFont(
      buildHtml(content, p, s, a, nom, secteur, template, logo, poseUrls, customHtml ? { html: customHtml } : null),
      font,
      fontCorps,
      this.frontendUrl,
    );

    const pngs: Buffer[] = [];
    const browser = await this.playwrightBrowser.launch();
    try {
      const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H }, deviceScaleFactor: DSF });
      // waitUntil: "load" (pas "networkidle") : on ne se bloque pas si le CDN de polices/le
      // logo répond lentement — sinon un simple ralentissement réseau => 0 slide rendue.
      await page.setContent(htmlStr, { waitUntil: 'load' });
      await page.waitForSelector('.slide', { timeout: 15000 }).catch(() => undefined);
      await page
        .evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]))
        .catch(() => undefined);
      await page.waitForTimeout(300); // laisse les polices se peindre
      await page.evaluate(AUTO_SHRINK_SCRIPT).catch(() => undefined);
      await page.waitForTimeout(60);

      // Les screenshots (locaux, Playwright) restent séquentiels — une seule page à la fois.
      const count = await page.locator('.slide').count();
      for (let i = 0; i < count; i++) {
        pngs.push(await page.locator('.slide').nth(i).screenshot({ type: 'png' }));
      }
    } finally {
      // Chromium libéré avant l'upload : les slides sont déjà capturées, inutile de garder
      // le navigateur (et sa RAM) ouvert pendant que le réseau travaille.
      await browser.close();
    }

    // Les uploads sont indépendants les uns des autres : le goulot est le réseau, pas
    // Playwright, donc on les lance de front plutôt que de les sérialiser (l'upload de la
    // slide 1 n'a aucune raison de bloquer le départ de celui de la slide 2).
    const urls = await Promise.all(
      pngs.map((png, i) =>
        uploadBuffer(png, {
          resource_type: 'image',
          folder: `carrousels/${telegramId}`,
          public_id: `${base}_s${i + 1}`,
          overwrite: true,
        }).then((up) => up.secure_url),
      ),
    );

    let pdfUrl: string | null = null;
    try {
      if (pngs.length) {
        const pdfDoc = await PDFDocument.create();
        for (const png of pngs) {
          const img = await pdfDoc.embedPng(png);
          const page = pdfDoc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
        const pdfBytes = await pdfDoc.save();
        // resource_type="raw" : Cloudinary bloque la livraison des PDF en "image" (401).
        // En "raw", le fichier est téléchargeable directement (Late/LinkedIn peut le récupérer).
        const up = await uploadBuffer(Buffer.from(pdfBytes), {
          resource_type: 'raw',
          folder: `carrousels/${telegramId}`,
          public_id: `${base}_doc.pdf`,
          overwrite: true,
        });
        pdfUrl = up.secure_url;
      }
    } catch (e) {
      this.logger.error(`carrousel pdf error: ${e instanceof Error ? e.message : e}`);
    }
    return { images: urls, pdf: pdfUrl };
  }

  async genererCarrousel(
    telegramId: string,
    content: CarrouselContentShape,
    contenuId?: string | null,
    template = 'creme',
    colors?: { p?: string; s?: string; a?: string } | null,
    font?: string | null,
    fontCorps?: string | null,
  ): Promise<CarrouselRenduResult> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const co = colors || {};
    // Override explicite (retouche par carrousel) > couleurs propres au carrousel > couleurs de marque
    const p = co.p || (u.carrousel_couleur_principale as string) || (u.couleur_principale as string) || '#003D2E';
    const s = co.s || (u.carrousel_couleur_secondaire as string) || (u.couleur_secondaire as string) || '#0077FF';
    const a = co.a || (u.carrousel_couleur_accent as string) || (u.couleur_accent as string) || '#3AFFA3';
    const nom = (u.nom as string) || (u.username as string) || '';
    const secteur = (u.secteur as string) || '';
    const logo = (u.logo_url as string) || null;
    const fontResolue = ((font !== undefined ? font : (u.carrousel_font as string)) || '').trim();
    const fontCorpsResolue = ((fontCorps !== undefined ? fontCorps : (u.carrousel_font_corps as string)) || '').trim();
    // Un template sur mesure ne se rend que pour les comptes à qui il a été attribué.
    const templateOk = await this.templateValide(template, telegramId);
    let customHtml: string | null = null;
    if (!TEMPLATES.includes(templateOk)) {
      const row = await this.carrouselCustomService.charger(templateOk);
      customHtml = row?.html ?? null;
    }
    const base = (contenuId || 'tmp').replace(/-/g, '').slice(0, 16);

    // Ratés intermittents de Playwright (timeout réseau/police) : jusqu'à 2 essais.
    let res: CarrouselRenduResult = { images: [], pdf: null };
    const depart = process.hrtime.bigint();
    let ok = false;
    try {
      for (const attempt of [1, 2]) {
        try {
          res = await rendre(() =>
            this.renderAndUpload(
              telegramId,
              content,
              p,
              s,
              a,
              nom,
              secteur,
              base,
              templateOk,
              logo,
              fontResolue || null,
              fontCorpsResolue || null,
              customHtml,
            ),
          );
          if (res.images.length) {
            ok = true;
            break;
          }
          this.logger.warn(`Carrousel ${base}: 0 slide rendue (essai ${attempt})`);
        } catch (e) {
          if (e instanceof AtelierSatureError) {
            // Ne PAS réessayer : la boucle rendrait l'attente de 45s deux fois avant de
            // renvoyer un carrousel vide. L'appelant doit répondre 503.
            throw e;
          }
          this.logger.error(`Carrousel render error (essai ${attempt}): ${e instanceof Error ? e.message : e}`);
        }
      }
      return res;
    } finally {
      const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
      try {
        await this.usageService.log(
          telegramId,
          ok ? 'carrousel_rendu' : 'carrousel_rendu_echec',
          templateOk,
          {},
          0,
          undefined,
          undefined,
          dureeS,
        );
      } catch (e) {
        this.logger.warn(`journal du rendu carrousel ${base}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
