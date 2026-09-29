import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { normaliserUrl } from '../site/site.service';
import { GenererImageResult, GenererPromptResult, ImageStyle } from './interfaces/image-result.interface';

/**
 * Agent IMAGE — port direct de backend/services/image_service.py :
 *   1. Claude (Haiku) écrit un prompt d'image à partir du post + la charte de marque.
 *   2. nano-banana (Gemini 2.5/3 Flash Image) via OpenRouter génère l'image
 *      (+ photo du client en référence si demandé).
 *   3. Upload Cloudinary → URL.
 *
 * Portée : la génération libre (prompt/genererImage/editerImage) est portée en entier,
 * y compris `template_mode` (édition fidèle d'un gabarit de marque). La construction
 * automatique du prompt "accroche" à partir d'un gabarit (composer_gabarit côté Python,
 * quand le mode template est actif) vit dans ImageController.image() — pas ici — pour
 * rester au même niveau que dans la route Python d'origine (backend/routes/agent.py).
 */

export const IMAGE_MODELS: Record<string, string> = {
  nano2: 'google/gemini-2.5-flash-image',
  nano3: 'google/gemini-3-pro-image-preview',
};

const STYLES: Record<string, ImageStyle> = {
  photo: { photo: true, texte: 'Photorealistic, high detail, natural skin texture, thumbnail-grade contrast.' },
  cinema: {
    photo: true,
    texte:
      'Cinematic film still: anamorphic look, colour grading built on the BRAND PALETTE (shadows and ' +
      'backgrounds in the primary colour, highlights and rim lights in the accent colour, no orange ' +
      'unless it belongs to the palette), volumetric light, subtle film grain, high contrast.',
  },
  '3d': {
    photo: false,
    texte:
      'Stylised 3D render like a modern animated feature film (Pixar-like): soft rounded shapes, ' +
      'expressive face, glossy materials, warm studio lighting. Keep the person recognisable as a 3D character.',
  },
  illustration: {
    photo: false,
    texte:
      'Bold flat vector illustration with clean shapes, thick outlines, limited vivid palette, subtle ' +
      'paper grain, editorial poster look. Keep the person recognisable in a simplified drawn style.',
  },
  neon: {
    photo: true,
    texte:
      'Dark cyberpunk mood: deep blacks, neon rim lights and glowing tubes in the BRAND PALETTE (accent ' +
      'colour as the main glow, secondary colour as the second light, no magenta or cyan unless they ' +
      'belong to the palette), wet reflections, haze, dramatic high contrast, futuristic.',
  },
  pop: {
    photo: false,
    texte:
      'Pop-art comic style: halftone dots, bold black outlines, saturated primary colours, high energy, ' +
      'print texture. Keep the person recognisable.',
  },
};

const LANGUES_CONTENU: Record<string, string> = { fr: 'français', en: 'anglais (English)', es: 'espagnol (Español)' };

const ROLE_PROMPT =
  "Tu es directeur artistique. À partir d'un post et de la charte de marque, tu écris UN prompt " +
  "d'image pour illustrer le post, dans la LANGUE DU COMPTE indiquée plus bas (le client le lit et " +
  "le retouche : il doit le comprendre).\n\n" +
  'Structure le prompt en couches, dans cet ordre, pour cibler précisément le modèle :\n' +
  '1. Angle/cadrage caméra (ex. "medium shot", "three-quarter angle", "overhead flat lay")\n' +
  '2. Sujet (personne, objet ou scène) décrit précisément\n' +
  '3. Action / composition (ce qui se passe dans le cadre)\n' +
  '4. Environnement (décor, contexte)\n' +
  '5. Éclairage avec température de couleur (ex. "soft natural window light 5500K")\n' +
  '6. Technique caméra (ex. "85mm f/1.8", "shallow depth of field")\n' +
  '7. Un repère de pellicule photo pour ancrer le rendu ("Kodak Portra 400" pour un rendu lifestyle ' +
  'chaleureux, "Kodak Ektar 100" pour un produit saturé, "Fujifilm Provia 100F" pour un rendu ' +
  'neutre et documentaire)\n\n' +
  'Termine par une phrase, dans la même langue, demandant une texture naturelle, sans lissage ' +
  'plastique, un réalisme photographique et aucun texte dans l\'image. ' +
  'Le visuel doit coller au message, rester professionnel, épuré et lisible, et respecter la palette ' +
  'de la marque. Les termes techniques (marque de pellicule, focale) restent tels quels. ' +
  "Réponds UNIQUEMENT avec le prompt, rien d'autre.\n\n";

const ROLE_PROMPT_STYLE =
  "Tu es directeur artistique. À partir d'un post et de la charte de marque, tu écris UN prompt " +
  "d'image pour illustrer le post, dans la LANGUE DU COMPTE indiquée plus bas (le client le lit et " +
  "le retouche : il doit le comprendre).\n\n" +
  'Structure le prompt en couches, dans cet ordre :\n' +
  '1. Cadrage et composition (ex. "centered hero object", "isometric scene", "close-up")\n' +
  '2. Sujet (personnage, objet ou scène) décrit précisément\n' +
  '3. Action / ce qui se passe dans le cadre\n' +
  '4. Environnement (décor, contexte)\n' +
  '5. Lumière et ambiance\n' +
  '6. Palette : celle de la marque, nommée en mots\n' +
  '7. Une phrase de style, dans la même langue, qui résume la consigne de style ci-dessous ' +
  "(ne la recopie pas en anglais : le serveur l'ajoute lui-même au moment de générer).\n\n" +
  'Le visuel doit coller au message, rester professionnel, épuré et lisible. Aucun texte dans ' +
  "l'image. Réponds UNIQUEMENT avec le prompt, rien d'autre.\n\n";

// Règle commune : le générateur ne sait PAS dessiner une interface qu'on lui décrit vaguement.
const REGLE_ECRANS =
  "ÉCRANS ET INTERFACES : ne décris JAMAIS un écran allumé montrant une interface générique, un " +
  '« dashboard », une appli ou des graphiques inventés (le modèle produit un faux tableau de bord ' +
  "illisible). Pour un sujet numérique, préfère une métaphore physique ou un décor : devanture, " +
  "épingle de carte, loupe, fiche cartonnée avec des étoiles, icône 3D, objet symbolique. Si un " +
  'écran connu doit absolument apparaître, NOMME-le exactement et décris ses éléments visibles ' +
  '(ex. « the public Google Business Profile card as shown in Google Maps: business name, 4.8 ' +
  'stars, three photos, opening hours, Directions and Call buttons »), jamais « a dashboard ». ' +
  'COULEURS : nomme-les toujours en mots (deep navy, mint green…), JAMAIS de code hexadécimal dans ' +
  "le prompt : le générateur les dessine comme du texte. ";

const HEX_RE = /#?\b[0-9a-fA-F]{6}\b/g;

const COULEURS_FR: Record<string, string> = {
  black: 'noir', charcoal: 'anthracite', grey: 'gris', 'off-white': 'blanc cassé', white: 'blanc',
  red: 'rouge', orange: 'orange', gold: 'doré', yellow: 'jaune', 'lime green': 'vert citron',
  green: 'vert', 'mint green': 'vert menthe', teal: 'bleu canard', cyan: 'cyan', 'azure blue': 'bleu azur',
  blue: 'bleu', navy: 'bleu marine', indigo: 'indigo', violet: 'violet', magenta: 'magenta',
  deep: 'profond', pale: 'pâle',
};
const COULEURS_ES: Record<string, string> = {
  black: 'negro', charcoal: 'antracita', grey: 'gris', 'off-white': 'blanco roto', white: 'blanco',
  red: 'rojo', orange: 'naranja', gold: 'dorado', yellow: 'amarillo', 'lime green': 'verde lima',
  green: 'verde', 'mint green': 'verde menta', teal: 'azul petróleo', cyan: 'cian', 'azure blue': 'azul celeste',
  blue: 'azul', navy: 'azul marino', indigo: 'índigo', violet: 'violeta', magenta: 'magenta',
  deep: 'profundo', pale: 'pálido',
};

type ImageUrlPart = { type: 'image_url'; image_url: { url: string } };
type TextPart = { type: 'text'; text: string };
type ChatContent = string | Array<TextPart | ImageUrlPart>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class ImageService {
  private readonly logger = new Logger(ImageService.name);
  private readonly openrouterApiKey: string;
  private readonly openrouterImageModel: string;
  private readonly imageTimeoutMs: number;

  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    config: ConfigService,
  ) {
    this.openrouterApiKey = config.get<string>('app.openrouterApiKey') || '';
    this.openrouterImageModel = config.get<string>('app.openrouterImageModel') || 'google/gemini-2.5-flash-image';
    // nano-banana 3 (pro) dépasse parfois 2 min aux heures chargées d'OpenRouter.
    this.imageTimeoutMs = parseInt(process.env.OPENROUTER_IMAGE_TIMEOUT_S || '210', 10) * 1000;
  }

  stylesImage(): Record<string, ImageStyle> {
    return STYLES;
  }

  // ---------------------------------------------------------------------------
  // Couleurs
  // ---------------------------------------------------------------------------
  private traduireCouleur(nomEn: string, langue: string): string {
    const table = langue === 'fr' ? COULEURS_FR : langue === 'es' ? COULEURS_ES : null;
    if (!table) return nomEn;
    const mots = nomEn.split(' ');
    if ((mots[0] === 'deep' || mots[0] === 'pale') && mots.length === 2) {
      return `${table[mots[1]] ?? mots[1]} ${table[mots[0]]}`;
    }
    return table[nomEn] ?? nomEn;
  }

  /** Nom approximatif d'une couleur hexadécimale : le générateur lit mieux « deep violet » que
   * « #5B6CFF ». En anglais par défaut, traduit pour la description du client. */
  private nomCouleur(hexa: string, langue = 'en'): string {
    let h = (hexa || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return hexa || '';
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    let nom: string;
    if (d < 0.08) {
      nom = l < 0.12 ? 'black' : l < 0.3 ? 'charcoal' : l < 0.7 ? 'grey' : l < 0.93 ? 'off-white' : 'white';
      return this.traduireCouleur(nom, langue);
    }
    let hue: number;
    if (mx === r) hue = (60 * ((g - b) / d) + 360) % 360;
    else if (mx === g) hue = 60 * ((b - r) / d) + 120;
    else hue = 60 * ((r - g) / d) + 240;
    const noms: Array<[number, string]> = [
      [15, 'red'], [38, 'orange'], [52, 'gold'], [66, 'yellow'], [95, 'lime green'], [170, 'green'],
      [186, 'teal'], [205, 'cyan'], [222, 'azure blue'], [246, 'blue'], [268, 'indigo'], [292, 'violet'],
      [335, 'magenta'], [361, 'red'],
    ];
    nom = noms.find(([lim]) => hue < lim)?.[1] ?? 'red';
    if (nom === 'green' && l > 0.5) nom = 'mint green';
    if (nom === 'blue' && l < 0.2) nom = 'navy';
    if (l < 0.28) nom = 'deep ' + nom;
    else if (l > 0.72) nom = 'pale ' + nom;
    return this.traduireCouleur(nom, langue);
  }

  /** Remplace tout code couleur du prompt par son nom : les codes finissent écrits dans l'image. */
  private sansHex(texte: string, langue = 'en'): string {
    return (texte || '').replace(HEX_RE, (m) => this.nomCouleur(m, langue));
  }

  private charte(u: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [cle, lib] of [
      ['couleur_principale', 'primary'],
      ['couleur_secondaire', 'secondary'],
      ['couleur_accent', 'accent'],
    ]) {
      const v = String(u[cle] ?? '').trim();
      if (v) parts.push(`${lib} ${this.nomCouleur(v)} (${v})`);
    }
    if (!parts.length) return '';
    return (
      'BRAND PALETTE, mandatory: ' +
      parts.join(', ') +
      '. These are the dominant colours of the composition (backgrounds, key objects, lighting ' +
      'accents, wardrobe details); other colours stay secondary and harmonious with them. The codes ' +
      'are for colour matching only: never draw or write them.'
    );
  }

  // ---------------------------------------------------------------------------
  // Prompt (Claude)
  // ---------------------------------------------------------------------------
  private readonly guideChoixStyle =
    'photo : sujet concret, humain, produit, lieu, témoignage, coulisses ; ' +
    'cinema : émotion forte, tension, avant/après, récit dramatique ; ' +
    '3d : concept abstrait, outil numérique, process, chiffres, pédagogie ; ' +
    'illustration : conseil, liste, méthode, comparaison, sujet éditorial ; ' +
    'neon : nouveauté, lancement, tendance, tech, nuit, événement ; ' +
    'pop : humour, provocation, coup de gueule, opinion tranchée.';

  /** Mode Auto : Claude choisit le style le plus adapté au post (un mot). Repli : photo. */
  async choisirStyle(postTexte: string): Promise<string> {
    const ids = Object.keys(STYLES);
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        system:
          "Tu es directeur artistique. Choisis le style d'image le plus adapté à un post de réseau " +
          'social. Réponds par UN SEUL mot parmi : ' +
          ids.join(', ') +
          '. Repères : ' +
          this.guideChoixStyle,
        messages: [{ role: 'user', content: `Post :\n\n${(postTexte || '').slice(0, 2500)}\n\nStyle ?` }],
      });
      const mot = this.claude
        .texte(resp)
        .toLowerCase()
        .trim()
        .replace(/^[.«»"' ]+|[.«»"' ]+$/g, '');
      return mot in STYLES ? mot : 'photo';
    } catch (e) {
      this.logger.warn(`choisirStyle: ${e instanceof Error ? e.message : e}`);
      return 'photo';
    }
  }

  /** Claude écrit le prompt d'image (modifiable ensuite par l'utilisateur).
   * style : photo (défaut), cinema, 3d, illustration, neon, pop, ou "auto" (choisi d'abord).
   * Retourne {prompt, style} avec le style effectivement utilisé. */
  async genererPrompt(
    telegramId: string,
    postTexte: string,
    reseau = 'linkedin',
    avecPhoto = false,
    style = 'photo',
  ): Promise<GenererPromptResult | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    let styleEff = style;
    if (styleEff === 'auto' || !(styleEff in STYLES)) {
      styleEff = style === 'auto' ? await this.choisirStyle(postTexte) : 'photo';
    }
    const st = STYLES[styleEff] ?? STYLES.photo;
    const langue = String(u.langue ?? 'fr').toLowerCase();
    let contexte =
      `LANGUE DU COMPTE : ${LANGUES_CONTENU[langue] ?? 'français'}. Tout le prompt est écrit dans ` +
      'cette langue, y compris les noms de couleurs. FORME : un seul paragraphe de prose, sans titre, ' +
      'sans gras, sans préambule ni liste. ' +
      REGLE_ECRANS +
      `Secteur : ${u.secteur || '—'}. ` +
      `Style : ${u.style_vestimentaire || '—'}. ` +
      `Palette de marque (à utiliser) : principale ${u.couleur_principale}, ` +
      `secondaire ${u.couleur_secondaire}, accent ${u.couleur_accent}.`;

    // Sans photo du client, on ne met jamais en scène un humain inventé de toutes pièces.
    if (avecPhoto) {
      contexte +=
        ' Le client A fourni une photo de lui-même comme référence : tu peux décrire une scène ' +
        'avec CETTE personne (le visage exact sera préservé au moment de la génération).';
    } else {
      contexte +=
        " Le client N'A PAS fourni de photo de référence : NE DÉCRIS AUCUN visage ni personnage " +
        'humain, même générique ou de dos. Décris plutôt un objet, un environnement, une ' +
        'composition graphique/abstraite, une icône 3D ou une scène sans personnage — jamais un ' +
        'humain inventé.';
    }
    if (u.use_inspirations !== false && (await this.inspirationUrls(telegramId, 1)).length) {
      contexte +=
        ' Le client a fourni des IMAGES DE INSPIRATION qui seront appliquées comme référence ' +
        'de style au moment de la génération : décris surtout le SUJET et la SCÈNE, et reste ' +
        'cohérent avec ces références (le style visuel sera guidé par elles).';
    }
    contexte += this.marqueService.contexteMarqueCourt(u, { secteur: false, ecriture: false });

    let role: string;
    if (st.photo) {
      role = ROLE_PROMPT;
      if (styleEff !== 'photo') contexte += ` Ambiance photographique demandée : ${st.texte}`;
    } else {
      role = ROLE_PROMPT_STYLE;
      contexte += ` CONSIGNE DE STYLE (à recopier en dernière couche) : ${st.texte}`;
    }

    const resp = await this.claude.messagesCreate({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: role + contexte,
      messages: [
        { role: 'user', content: `Post à illustrer (réseau ${reseau}) :\n\n${postTexte}\n\nDonne le prompt d'image.` },
      ],
    });
    let prompt = this.claude.texte(resp);
    prompt = prompt.replace(/^\s*\*\*[^\n]{0,80}\*\*\s*:?\s*\n+/, '').replace(/\*\*/g, '').trim();
    prompt = this.sansHex(prompt, langue);
    return { prompt, style: styleEff };
  }

  // ---------------------------------------------------------------------------
  // Références (inspirations, photo, écrans)
  // ---------------------------------------------------------------------------
  /** Liste les images d'inspiration de l'utilisateur (dossier Cloudinary). */
  async inspirationUrls(telegramId: string, limit = 20): Promise<string[]> {
    try {
      const res = await cloudinary.api.resources({ type: 'upload', prefix: `inspirations/${telegramId}/`, max_results: limit });
      const resources = (res.resources ?? []) as Array<{ secure_url?: string }>;
      return resources.map((r) => r.secure_url).filter((u): u is string => Boolean(u));
    } catch (e) {
      this.logger.warn(`list inspirations error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Convertit un lien Google Drive (page /view) en lien de téléchargement direct. */
  private driveDirect(url: string): string {
    if (url.includes('drive.google.com')) {
      const m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
      if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
    }
    return url;
  }

  /** Télécharge + valide les images de référence (convertit Drive, ignore les non-images).
   * Retourne les data URLs valides.
   *
   * Anti-SSRF : ces URLs viennent directement du client (refs/integrate_refs/ecran_refs,
   * ImageDto) et la requête part de NOTRE serveur — signalé par le scan Strix du
   * 2026-09-28 (aucune validation au-delà de `@IsArray()` côté DTO). Même garde-fou que
   * `normaliserUrl()` (site.service.ts) : résolution DNS + rejet de toute IP non
   * publique. Revalidé à CHAQUE saut de redirection (`redirect: 'manual'`) — sans ça, une
   * URL publique qui redirige vers une adresse interne contournerait la vérification
   * initiale (DNS rebinding / redirect-based SSRF). */
  private async prepRefs(urls: string[]): Promise<string[]> {
    const ok: string[] = [];
    if (!urls.length) return ok;
    for (const u of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        let current = this.driveDirect(u);
        let r: Response;
        for (let hop = 0; ; hop++) {
          if (hop >= 5) throw new Error('Trop de redirections.');
          await normaliserUrl(current);
          r = await fetch(current, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            redirect: 'manual',
            signal: controller.signal,
          });
          if (r.status >= 300 && r.status < 400) {
            const loc = r.headers.get('location');
            if (!loc) break;
            current = new URL(loc, current).toString();
            continue;
          }
          break;
        }
        clearTimeout(timer);
        const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.ok && ct.startsWith('image/') && buf.length > 100) {
          ok.push(`data:${ct};base64,${buf.toString('base64')}`);
        } else {
          this.logger.warn(`ref image ignorée (${ct || r.status}): ${u.slice(0, 90)}`);
        }
      } catch (e) {
        this.logger.warn(`ref image échec téléchargement: ${u.slice(0, 90)} — ${e instanceof Error ? e.message : e}`);
      }
    }
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Génération (OpenRouter nano-banana) + upload
  // ---------------------------------------------------------------------------
  async genererImage(
    telegramId: string,
    promptIn: string,
    avecPhoto = false,
    model?: string,
    contenuId?: string | null,
    refs?: string[] | null,
    styleNote?: string | null,
    templateMode = false,
    ratio = '4:5',
    integrateRefs?: string[] | null,
    publicId?: string | null,
    identiteStyliseeIn = false,
    style = 'photo',
    ecranRefs?: string[] | null,
  ): Promise<GenererImageResult | { error: string }> {
    if (!this.openrouterApiKey) return { error: 'no_openrouter_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    let prompt = promptIn;
    let identiteStylisee = identiteStyliseeIn;

    if (styleNote) prompt = `${prompt}\n\nDirective de style à respecter : ${styleNote}`;
    if (ratio === '9:16') {
      prompt =
        `${prompt}\n\nFormat VERTICAL 9:16 plein écran mobile (story Instagram) : composition pensée ` +
        'pour la hauteur, éléments importants centrés (pas collés aux bords hauts/bas).';
    }

    const st = STYLES[style] ?? STYLES.photo;
    if (!templateMode) {
      prompt = this.sansHex(prompt, String(u.langue ?? 'fr').toLowerCase());
      if (st.photo) {
        prompt = `${prompt}\n\nRender with visible natural texture, no over-smoothing, no plastic/AI look. Photographic realism, no text.`;
        if (style !== 'photo') prompt = `${prompt}\nMood: ${st.texte}`;
      } else {
        prompt = `${prompt}\n\nSTYLE, mandatory: ${st.texte} No words, letters or numbers anywhere in the image.`;
        identiteStylisee = true;
      }
      const charte = this.charte(u);
      if (charte) prompt = `${prompt}\n\n${charte}`;
    }

    // Photo de l'utilisateur demandée -> PHOTO RÉALISTE (pas d'illustration)
    let photoRefs: string[] = [];
    if (avecPhoto && u.photo_url) {
      photoRefs = await this.prepRefs([u.photo_url as string]);
    }

    // Références de STYLE : explicites (choisies à la génération) sinon inspirations du compte
    let styleUrls: string[];
    if (refs !== undefined && refs !== null) {
      styleUrls = refs.filter(Boolean).slice(0, 4);
    } else if (u.use_inspirations !== false) {
      styleUrls = (await this.inspirationUrls(telegramId)).slice(0, 3);
    } else {
      styleUrls = [];
    }

    // Écrans à reproduire tels quels, puis références "à toujours intégrer" (ex. mascotte).
    const ecranSet = new Set(ecranRefs || []);
    const ecranUrls = styleUrls.filter((x) => ecranSet.has(x));
    styleUrls = styleUrls.filter((x) => !ecranSet.has(x));
    const integrateSet = new Set((integrateRefs || []).filter((x) => !ecranSet.has(x)));
    const integrateUrls = styleUrls.filter((x) => integrateSet.has(x));
    const styleOnlyUrls = styleUrls.filter((x) => !integrateSet.has(x));

    const ecranData = ecranUrls.length ? await this.prepRefs(ecranUrls) : [];
    const ecranTxtGabarit = ecranData.length
      ? "\n\nCAPTURE(S) D'ÉCRAN : la ou les DERNIÈRES images reçues sont de vraies captures d'écran. Le gabarit " +
        'montre un appareil avec un écran (téléphone, ordinateur, tablette) : affiche la capture DANS cet ' +
        'écran, ajustée exactement à ses bords (perspective et coins arrondis suivis, rien qui déborde), en ' +
        'reproduisant FIDÈLEMENT sa mise en page, ses couleurs et ses textes, parfaitement lisibles. N\'invente ' +
        "aucun élément d'interface : ce qui est à l'écran vient de la capture et de rien d'autre. Si le gabarit " +
        "n'a pas d'écran, pose la capture comme une carte à l'endroit prévu pour la photo. CADRAGE : ne zoome " +
        'pas, ne recadre pas sur l\'écran, ne pose pas la capture en carte flottante par-dessus : la composition ' +
        'ENTIÈRE du gabarit (logo, titre, appareil complet, fond) reste visible exactement comme dans l\'IMAGE 1, ' +
        "seul le contenu de l'écran change."
      : '';
    const ecranTxtLibre = ecranData.length
      ? "\n\nCAPTURE(S) D'ÉCRAN : la ou les DERNIÈRES images reçues sont de vraies captures d'écran. Si la scène " +
        "décrite contient un appareil avec un écran (téléphone, ordinateur, tablette), affiche la capture DANS cet " +
        'écran, ajustée à ses bords, mise en page et textes reproduits FIDÈLEMENT et lisibles. Sinon, fais-la ' +
        "apparaître comme un écran ou une carte flottante intégrée à la scène. N'invente aucune interface : ce qui " +
        "est à l'écran vient de la capture."
      : '';

    const integrateData = integrateUrls.length ? await this.prepRefs(integrateUrls) : [];
    const inspiRefs = styleOnlyUrls.length ? await this.prepRefs(styleOnlyUrls) : [];

    let content: ChatContent;
    if (photoRefs.length && identiteStylisee) {
      const tenue = String(u.style_vestimentaire ?? '').trim();
      const tenueTxt = tenue ? ` La personne porte la tenue suivante : ${tenue}.` : '';
      const texte =
        'Mets en scène la personne EXACTE de la PREMIÈRE image de référence : même visage, mêmes ' +
        'traits, coiffure et morphologie, immédiatement reconnaissable, mais RENDUE DANS LE STYLE ' +
        "demandé ci-dessous (ce n'est pas une photo : suis le style à la lettre)." +
        tenueTxt +
        '\n\n' +
        prompt;
      content = [
        { type: 'text', text: texte + ecranTxtLibre },
        { type: 'image_url', image_url: { url: photoRefs[0] } },
        ...inspiRefs.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ...ecranData.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    } else if (photoRefs.length) {
      const tenue = String(u.style_vestimentaire ?? '').trim();
      const tenueTxt = tenue ? ` La personne porte la tenue suivante : ${tenue}.` : '';
      let texte =
        'PHOTOGRAPHIE RÉALISTE et professionnelle — PAS une illustration, PAS un dessin, ' +
        'PAS de style cartoon / vectoriel / 3D. Mets en scène la personne EXACTE de la PREMIÈRE image ' +
        'de référence : même visage, mêmes traits, identité fidèlement préservée, intégrée ' +
        'naturellement dans la scène, rendu et éclairage photographiques réalistes.' +
        tenueTxt +
        ' Ignore toute mention de style « illustration » ou « dessin » dans la description ci-dessous : ' +
        'rends une vraie photo.\n\n' +
        prompt;
      if (inspiRefs.length) {
        texte +=
          '\n\nInspire-toi du STYLE VISUEL (composition, palette de couleurs, ambiance, ' +
          'éclairage) des images de style suivantes — sans copier leur contenu et SANS modifier ' +
          "le visage de la personne de la première image.";
      }
      content = [
        { type: 'text', text: texte + ecranTxtLibre },
        { type: 'image_url', image_url: { url: photoRefs[0] } },
        ...inspiRefs.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ...ecranData.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    } else if (inspiRefs.length && templateMode) {
      let texte: string;
      if (inspiRefs.length > 1) {
        texte =
          'Tu reçois PLUSIEURS images. IMAGE 1 = ton GABARIT DE MARQUE. IMAGE(S) suivante(s) = IMAGE(S) DE ' +
          "RÉFÉRENCE de l'utilisateur. Recrée EXACTEMENT le design de l'IMAGE 1 : même fond, même mise en " +
          'page, même logo, mêmes typographies, mêmes couleurs, mêmes emplacements et tailles de texte. ' +
          'Le gabarit contient une ZONE PHOTO (l\'endroit où se trouve une photo/personne) : remplace ' +
          "UNIQUEMENT le contenu de CETTE zone par l'image de référence, en gardant EXACTEMENT la même " +
          'position, la même taille et la même forme de découpe que dans le gabarit. IMPÉRATIF : l\'image ' +
          "de référence ne doit PAS devenir le fond de toute l'image ni déborder de la zone photo ; le " +
          'fond, le texte et la disposition du gabarit restent intacts et priment. Ne reproduis NI la mise ' +
          'en page NI le texte de l\'image de référence. Pour le TEXTE : si un « Texte à afficher » est ' +
          "fourni ci-dessous, c'est LUI (et lui seul) qui REMPLACE le texte du gabarit ; si des " +
          '« Consignes de l\'utilisateur » sont fournies, EXÉCUTE-les — ce sont des ORDRES, pas du texte à ' +
          'afficher (ex. « remplace la phrase par X » = afficher UNIQUEMENT X). L\'ancien texte du gabarit ' +
          'DISPARAÎT : ne montre JAMAIS l\'ancien et le nouveau en même temps. Garde les accents français ' +
          'corrects (é, è, ê…). Texte parfaitement lisible, sans faute.' +
          ecranTxtGabarit +
          '\n\n' +
          prompt;
      } else {
        texte =
          "ÉDITE cette image, c'est ton GABARIT DE MARQUE, et RESPECTE SON DESIGN À LA LETTRE : " +
          'arrière-plan, photo/sujet, couleurs, composition, éléments graphiques, polices et positions ' +
          'restent STRICTEMENT IDENTIQUES. Ne génère PAS une nouvelle image. La SEULE modification est le ' +
          'TEXTE : si un « Texte à afficher » est fourni ci-dessous, c\'est LUI (et lui seul) qui REMPLACE ' +
          'le texte existant (même emplacement, même style) ; si des « Consignes de l\'utilisateur » sont ' +
          'fournies, EXÉCUTE-les — ce sont des ORDRES, pas du texte à afficher (ex. « remplace la phrase ' +
          'par X » = afficher UNIQUEMENT X). L\'ancien texte DISPARAÎT : ne montre JAMAIS l\'ancien et le ' +
          'nouveau en même temps. Parfaitement lisible, sans faute, accents français corrects.' +
          (ecranData.length ? " (Exception : l'écran de l'appareil, voir ci-dessous.)" : '') +
          ecranTxtGabarit +
          '\n\n' +
          prompt;
      }
      content = [
        { type: 'text', text: texte },
        ...inspiRefs.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ...ecranData.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    } else if (integrateData.length || inspiRefs.length || ecranData.length) {
      let texte = prompt;
      if (integrateData.length) {
        texte +=
          '\n\nTu reçois aussi une ou plusieurs IMAGES DE RÉFÉRENCE À INTÉGRER LITTÉRALEMENT dans ' +
          'la scène décrite ci-dessus : reproduis fidèlement leur contenu exact (personnage, objet, ' +
          'logo…), à la bonne échelle, intégré naturellement dans la composition. Ce ne sont PAS de ' +
          'simples inspirations de style — leur contenu doit être clairement VISIBLE dans le résultat.';
      }
      if (inspiRefs.length) {
        texte +=
          '\n\nTu reçois enfin une ou plusieurs images de référence de STYLE. Si la description ' +
          "ci-dessus demande explicitement de les utiliser ou de les intégrer (par ex. « ajoute " +
          "l'image de référence », « mets la photo dans le cercle », « combine les deux images »), " +
          'alors INTÈGRE fidèlement leur contenu dans la composition finale en suivant précisément ' +
          'la description. Sinon, contente-toi de t\'INSPIRER de leur STYLE VISUEL (composition, ' +
          'palette de couleurs, ambiance, éclairage, traitement) sans copier leur contenu.';
      }
      content = [
        { type: 'text', text: texte + ecranTxtLibre },
        ...integrateData.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ...inspiRefs.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ...ecranData.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    } else {
      content = prompt;
    }

    return this.appelerEtUploader(content, model, telegramId, contenuId, publicId, ratio);
  }

  /** Retouche libre d'une image DÉJÀ générée : renvoie l'image existante au modèle avec une
   * instruction en langage naturel, en lui demandant de garder tout le reste identique. */
  async editerImage(
    telegramId: string,
    imageUrl: string,
    instruction: string,
    model?: string,
    contenuId?: string | null,
    publicId?: string | null,
    ratio = '4:5',
  ): Promise<GenererImageResult | { error: string }> {
    if (!this.openrouterApiKey) return { error: 'no_openrouter_key' };
    if (!imageUrl || !instruction.trim()) return { error: 'parametres_manquants' };
    const content: ChatContent = [
      {
        type: 'text',
        text:
          'ÉDITE cette image selon l\'instruction ci-dessous. Garde TOUT LE RESTE strictement ' +
          'identique : cadrage, personnes, couleurs, texte, mise en page, éléments graphiques. ' +
          "Ne change QUE ce que l'instruction demande, sans rien redessiner d'autre.\n\n" +
          `Instruction : ${instruction.trim()}`,
      },
      { type: 'image_url', image_url: { url: imageUrl } },
    ];
    return this.appelerEtUploader(content, model, telegramId, contenuId, publicId, ratio);
  }

  /** cloudinary.uploader.upload, réessayé sur coupure réseau (pas sur un refus 4xx). Public :
   * réutilisé par MiniatureService pour déposer le PNG composé (upload_avec_reprise côté Python). */
  async uploadAvecReprise(
    file: string,
    options: Record<string, unknown>,
    essais = 3,
  ): Promise<{ secure_url: string }> {
    let derniere: unknown;
    for (let i = 0; i < essais; i++) {
      try {
        return (await cloudinary.uploader.upload(file, options)) as { secure_url: string };
      } catch (e) {
        derniere = e;
        const msg = String(e instanceof Error ? e.message : e).toLowerCase();
        if (['400', '401', '403', '404', 'invalid', 'not allowed'].some((k) => msg.includes(k))) throw e;
        this.logger.warn(`cloudinary upload essai ${i + 1}/${essais} : ${msg}`);
        await sleep(1500 * (i + 1));
      }
    }
    throw derniere;
  }

  /** Appel OpenRouter (nano-banana) + upload Cloudinary, partagé par genererImage et editerImage. */
  private async appelerEtUploader(
    content: ChatContent,
    model: string | undefined,
    telegramId: string,
    contenuId: string | null | undefined,
    publicId: string | null | undefined,
    ratio: string,
  ): Promise<GenererImageResult | { error: string }> {
    const body = {
      model: model || this.openrouterImageModel,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
    };
    let resp: Response | undefined;
    for (const essai of [1, 2]) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.imageTimeoutMs);
        try {
          resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.openrouterApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        break;
      } catch (e) {
        const isAbort = e instanceof Error && e.name === 'AbortError';
        if (isAbort) throw e; // timeout franc : pas rejoué
        this.logger.warn(`OpenRouter image : coupure réseau (essai ${essai}) ${e instanceof Error ? e.message : e}`);
        if (essai === 2) throw e;
        await sleep(1500);
      }
    }
    if (!resp || resp.status !== 200) {
      const text = resp ? await resp.text().catch(() => '') : '';
      this.logger.error(`OpenRouter image error ${resp?.status}: ${text.slice(0, 400)}`);
      return { error: `image_failed_${resp?.status ?? 'network'}` };
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    const urlData = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!urlData) {
      this.logger.error(`OpenRouter no image in response: ${JSON.stringify(data).slice(0, 400)}`);
      return { error: 'no_image' };
    }

    // Format normalisé (4:5 feed par défaut, 9:16 story) — recadrage intelligent (sujet préservé).
    const transformation = [{ aspect_ratio: ratio, crop: 'fill', gravity: 'auto' }];
    let uploadPublicId: string;
    if (publicId) {
      uploadPublicId = publicId;
    } else if (contenuId) {
      uploadPublicId = `contenus/${telegramId}/${contenuId}`;
    } else {
      // Photo « à la volée » : slot brouillon UNIQUE par user -> une nouvelle génération écrase la précédente.
      uploadPublicId = `contenus/${telegramId}/draft-photo`;
    }
    const up = await this.uploadAvecReprise(urlData, {
      resource_type: 'image',
      public_id: uploadPublicId,
      overwrite: true,
      invalidate: true,
      transformation,
    });
    return { lien_visuel: up.secure_url };
  }
}
