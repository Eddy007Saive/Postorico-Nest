import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { normTypeContenu } from '../../common/utils/contenu-enum.util';
import { ClaudeService } from '../claude/claude.service';
import { ImageService, IMAGE_MODELS } from '../image/image.service';
import { MarqueService } from '../marque/marque.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';

/**
 * Miniatures (couvertures) des reels — port direct de backend/services/miniature_service.py.
 *
 * Pourquoi deux couches : les générateurs d'images écrivent mal (fautes, accents, lettres
 * tordues). Le fond est donc généré par nano-banana (la personne du client, depuis sa photo
 * de profil, mise en scène selon le gabarit), puis le texte est composé en HTML et capturé
 * par Playwright, avec les polices et couleurs de la marque : lisible, sans faute, cohérent
 * avec les carrousels. Et moins cher : une image du quota, le texte ne coûte rien
 * (« Changer le texte » recompose sans régénérer le fond).
 *
 * Huit gabarits, calqués sur ce qui marche sur YouTube / Instagram.
 */

interface Gabarit {
  id: string;
  layout: string;
  textes: string[];
  scene: string;
  scene_sans_photo: string;
}

export const GABARITS: Gabarit[] = [
  {
    id: 'affiche',
    layout: 'titre-bas',
    textes: ['kicker', 'titre', 'sous'],
    scene: 'Cinematic movie-poster shot: the person from the reference photo in the foreground, chest up, looking straight at the camera with a confident face, dramatic warm backlight, dark moody environment related to the subject, shallow depth of field. Keep the bottom third of the frame darker and empty for text.',
    scene_sans_photo: 'Cinematic movie-poster shot of a striking object or place related to the subject, dramatic warm backlight, dark moody environment, shallow depth of field. Bottom third darker and empty for text.',
  },
  {
    id: 'action',
    layout: 'coin',
    textes: ['titre'],
    scene: 'Dynamic action scene: the person from the reference photo caught mid-movement (turning, pointing, reacting), slight motion blur on the background, high-contrast dramatic lighting, gritty realistic look, wide vertical framing.',
    scene_sans_photo: 'Dynamic action scene related to the subject, objects in motion, slight motion blur, high-contrast dramatic lighting, realistic, wide vertical framing.',
  },
  {
    id: 'allonge',
    layout: 'centre',
    textes: ['titre', 'sous'],
    scene: 'Top-down view: the person from the reference photo lying on their back on a patterned vintage rug, arms relaxed, looking up at the camera with a calm smile, a few objects related to the subject scattered around, soft even daylight, playful magazine editorial style. Keep the centre of the frame calm for a title.',
    scene_sans_photo: 'Top-down flat-lay on a patterned vintage rug: objects related to the subject arranged around an empty centre, soft daylight, playful magazine editorial style.',
  },
  {
    id: 'grande-action',
    layout: 'geant',
    textes: ['titre'],
    scene: 'The person from the reference photo jumping high mid-air, full body, joyful, sneakers visible, in front of a flat single-colour studio background (one bold saturated colour), hard clean light, sporty energy, no props.',
    scene_sans_photo: 'An object related to the subject tossed mid-air, frozen motion, in front of a flat single-colour studio background (one bold saturated colour), hard clean light.',
  },
  {
    id: 'objet-flottant',
    layout: 'haut-neon',
    textes: ['titre', 'sous', 'objet'],
    scene: 'The person from the reference photo looking amazed at {objet} floating and glowing above their open hand, dark futuristic room with subtle neon rim light, cinematic, the top quarter of the frame dark and empty for a title.',
    scene_sans_photo: '{objet} floating and glowing above a dark futuristic table, subtle neon rim light, cinematic, the top quarter of the frame dark and empty for a title.',
  },
  {
    id: 'ecran-partage',
    layout: 'bande',
    textes: ['titre', 'sous'],
    scene: 'Two-part composition: lower half, the person from the reference photo seated at a desk, looking at the camera with a slight smile, wearing a cap, soft key light; upper half, blurred abstract app interface screens and charts floating on a dark background. Calm, clean, the middle band free for a title.',
    scene_sans_photo: 'Two-part composition: lower half, a clean desk with a laptop related to the subject, soft key light; upper half, blurred abstract app interface screens on a dark background. The middle band free for a title.',
  },
  {
    id: 'mot-geant',
    layout: 'mot-geant',
    textes: ['kicker', 'titre'],
    scene: 'Close portrait of the person from the reference photo from the chest up, holding a tablet or tool related to the subject, dark workshop background, bold high-contrast lighting, the upper half of the frame dark and empty for one huge word.',
    scene_sans_photo: 'Close shot of a tool or object related to the subject on a dark workshop background, bold high-contrast lighting, the upper half of the frame dark and empty for one huge word.',
  },
  {
    id: 'objet-main',
    layout: 'aucun',
    textes: ['objet'],
    scene: 'The person from the reference photo proudly holding {objet} in both hands, big smile, standing in front of a wall completely covered with the same kind of objects, bright even studio light, joyful, slightly surreal.',
    scene_sans_photo: '{objet} presented on a pedestal in front of a wall completely covered with the same kind of objects, bright even studio light, joyful, slightly surreal.',
  },
];
const PAR_ID = new Map(GABARITS.map((g) => [g.id, g]));

export const RATIOS: Record<string, [number, number, number]> = { '9:16': [360, 640, 3], '16:9': [640, 360, 2] };

export const STYLES: Record<string, { photo: boolean; texte: string }> = {
  photo: { photo: true, texte: 'Photorealistic, high detail, natural skin texture, thumbnail-grade contrast.' },
  cinema: {
    photo: true,
    texte: 'Cinematic film still: anamorphic look, colour grading built on the BRAND PALETTE (shadows and backgrounds in the primary colour, highlights and rim lights in the accent colour, no orange unless it belongs to the palette), volumetric light, subtle film grain, high contrast.',
  },
  '3d': { photo: false, texte: 'Stylised 3D render like a modern animated feature film (Pixar-like): soft rounded shapes, expressive face, glossy materials, warm studio lighting. Keep the person recognisable as a 3D character.' },
  illustration: { photo: false, texte: 'Bold flat vector illustration with clean shapes, thick outlines, limited vivid palette, subtle paper grain, editorial poster look. Keep the person recognisable in a simplified drawn style.' },
  neon: {
    photo: true,
    texte: 'Dark cyberpunk mood: deep blacks, neon rim lights and glowing tubes in the BRAND PALETTE (accent colour as the main glow, secondary colour as the second light, no magenta or cyan unless they belong to the palette), wet reflections, haze, dramatic high contrast, futuristic.',
  },
  pop: { photo: false, texte: 'Pop-art comic style: halftone dots, bold black outlines, saturated primary colours, high energy, print texture. Keep the person recognisable.' },
};
const LANGUES: Record<string, string> = { fr: 'French', en: 'English', es: 'Spanish' };

export const POLICES: Record<string, { famille: string; gf: string; poids: number; maj: boolean }> = {
  impact: { famille: 'Anton', gf: 'Anton', poids: 400, maj: true },
  cinema: { famille: 'Bebas Neue', gf: 'Bebas+Neue', poids: 400, maj: true },
  comics: { famille: 'Bangers', gf: 'Bangers', poids: 400, maj: true },
  elegant: { famille: 'Playfair Display', gf: 'Playfair+Display:ital,wght@0,900;1,900', poids: 900, maj: false },
  tech: { famille: 'Orbitron', gf: 'Orbitron:wght@900', poids: 900, maj: true },
  fantasy: { famille: 'Cinzel Decorative', gf: 'Cinzel+Decorative:wght@900', poids: 900, maj: false },
  manuscrit: { famille: 'Permanent Marker', gf: 'Permanent+Marker', poids: 400, maj: false },
  retro: { famille: 'Righteous', gf: 'Righteous', poids: 400, maj: true },
};
const POLICE_DEFAUT: Record<string, string> = {
  affiche: 'cinema',
  action: 'impact',
  allonge: 'elegant',
  'grande-action': 'comics',
  'objet-flottant': 'tech',
  'ecran-partage': 'elegant',
  'mot-geant': 'impact',
  'objet-main': 'impact',
};

export interface MiniatureTextes {
  kicker?: string;
  titre?: string;
  sous?: string;
  objet?: string;
}

export interface Miniature {
  url: string;
  fond: string;
  gabarit: string;
  textes: MiniatureTextes;
  ratio: string;
  style: string;
  police: string;
  ref?: string | null;
  date: string;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

@Injectable()
export class MiniatureService {
  private readonly logger = new Logger(MiniatureService.name);
  private readonly cloudName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly imageService: ImageService,
    private readonly playwrightBrowserService: PlaywrightBrowserService,
    config: ConfigService,
  ) {
    this.cloudName = config.get<string>('app.cloudinaryCloudName') || '';
    cloudinary.config({
      cloud_name: this.cloudName,
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  private apercuBase(): string {
    return `https://res.cloudinary.com/${this.cloudName}/image/upload/q_auto,f_auto,w_480`;
  }

  gabarits(): Array<{ id: string; layout: string; textes: string[]; police: string; apercu: string }> {
    return GABARITS.map((g) => ({
      id: g.id,
      layout: g.layout,
      textes: g.textes,
      police: POLICE_DEFAUT[g.id] || 'impact',
      apercu: `${this.apercuBase()}/miniatures/_gabarits/${g.id}.png`,
    }));
  }

  polices(): Array<{ id: string; famille: string }> {
    return Object.entries(POLICES).map(([id, v]) => ({ id, famille: v.famille }));
  }

  styles(): Array<{ id: string; apercu: string }> {
    return Object.keys(STYLES).map((id) => ({ id, apercu: `${this.apercuBase()}/miniatures/_styles/${id}.png` }));
  }

  /** Kicker / titre / sous-titre / objet, dans la langue du compte, à partir du reel. */
  async proposerTextes(telegramId: string, contenu: { contenu?: string | null; titre?: string | null; reel_data?: unknown }): Promise<MiniatureTextes> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const langue = LANGUES[String(u.langue || 'fr').toLowerCase()] || 'French';
    const sc = (contenu.reel_data || {}) as { segments?: Array<{ texte?: string }> };
    const plans = (sc.segments || []).map((s) => s.texte || '').filter(Boolean).join(' / ');
    const sujet = (contenu.contenu || contenu.titre || '').slice(0, 1500);
    const resp = await this.claude.messagesCreate({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system:
        `You write YouTube/Instagram thumbnail text for a small business owner. Language of the texts: ${langue.toUpperCase()}. ` +
        'Punchy, concrete, no hype words, no emoji, no quotes, no trailing period. Return STRICT JSON: ' +
        '{"kicker": "1 to 3 words, small label above the title", "titre": "2 to 4 words, THE promise, uppercase-friendly", ' +
        '"sous": "2 to 5 words, the twist or the benefit", "objet": "in ENGLISH: a short noun phrase for one iconic object that symbolises the subject, e.g. a giant golden key"}' +
        this.marqueService.contexteMarqueCourt(u, { secteur: false, audience: false }),
      messages: [{ role: 'user', content: `Subject of the video:\n${sujet}\n\nOn-screen texts of the video: ${plans.slice(0, 600)}\n\nBrand: ${u.nom || ''} (${u.secteur || ''}).` }],
    });
    const raw = this.claude.texte(resp);
    let d: Record<string, unknown> = {};
    try {
      const m = /\{[\s\S]*\}/.exec(raw);
      d = JSON.parse(m ? m[0] : raw);
    } catch {
      d = {};
    }
    return {
      kicker: String(d.kicker || '').slice(0, 30),
      titre: String(d.titre || contenu.titre || '').slice(0, 50),
      sous: String(d.sous || '').slice(0, 50),
      objet: String(d.objet || 'a glowing object').slice(0, 60),
    };
  }

  private css(layout: string, brand: { accent?: string | null }, ratio: string, police = 'impact'): string {
    const acc = brand.accent || '#3AFFA3';
    const horiz = ratio === '16:9';
    const po = POLICES[police] || POLICES.impact;
    const base = `
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=Inter:wght@500;600;700&family=Caveat:wght@700&family=${po.gf}&display=swap');
    html,body{margin:0;padding:0;background:#000;}
    .m{position:relative;width:100vw;height:100vh;overflow:hidden;font-family:'Sora',sans-serif;color:#fff;}
    .m img.fond{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scale(1.04);}
    .voile{position:absolute;inset:0;}
    .txt{position:absolute;left:0;right:0;text-align:center;padding:0 6rem;word-wrap:break-word;}
    .kicker{font-family:'Inter',sans-serif;font-weight:700;letter-spacing:.28em;text-transform:uppercase;font-size:2.4rem;opacity:.9;}
    .titre{font-family:'${po.famille}',sans-serif;font-weight:${po.poids};text-transform:${po.maj ? 'uppercase' : 'none'};line-height:.98;letter-spacing:-.01em;text-shadow:0 .6rem 2.4rem rgba(0,0,0,.55);}
    .sous{font-family:'Inter',sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:${acc};text-shadow:0 .4rem 1.6rem rgba(0,0,0,.5);}
    `;
    const L: Record<string, string> = {
      'titre-bas': `
    .voile{background:linear-gradient(180deg,rgba(0,0,0,0) 45%,rgba(0,0,0,.82) 100%);}
    .txt{bottom:${horiz ? '9%' : '8%'};text-align:left;}
    .kicker{margin-bottom:1.2rem;} .titre{font-size:${horiz ? '8.5rem' : '11.5rem'};} .sous{font-size:${horiz ? '4.4rem' : '5.6rem'};margin-top:1.2rem;}`,
      coin: `
    .voile{background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 40%);}
    .txt{top:6%;text-align:left;} .titre{font-size:${horiz ? '6.5rem' : '8rem'};}`,
      centre: `
    .voile{background:radial-gradient(ellipse at center,rgba(0,0,0,.45) 0%,rgba(0,0,0,.05) 70%);}
    .txt{top:50%;transform:translateY(-50%);} .titre{font-size:${horiz ? '9rem' : '12.5rem'};}
    .sous{font-family:'Caveat',cursive;text-transform:none;font-weight:700;font-size:${horiz ? '7rem' : '9.5rem'};letter-spacing:0;margin-top:.4rem;}`,
      geant: `
    .voile{background:rgba(0,0,0,.12);}
    .txt{top:50%;transform:translateY(-50%) rotate(-7deg);padding:0 3rem;}
    .titre{font-style:italic;font-weight:800;font-size:${horiz ? '11rem' : '15rem'};line-height:.9;text-shadow:.5rem .5rem 0 rgba(0,0,0,.55),0 1rem 3rem rgba(0,0,0,.45);}`,
      'haut-neon': `
    .voile{background:linear-gradient(180deg,rgba(0,0,0,.75) 0%,rgba(0,0,0,0) 40%);}
    .txt{top:6%;} .titre{font-size:${horiz ? '8.5rem' : '11rem'};color:${acc};text-shadow:0 0 2rem ${acc}99,0 0 6rem ${acc}66,0 .4rem 1.2rem rgba(0,0,0,.7);}
    .sous{color:#fff;font-size:${horiz ? '4rem' : '5rem'};margin-top:1rem;}`,
      bande: `
    .voile{background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,.6) 50%,rgba(0,0,0,0) 70%);}
    .txt{top:${horiz ? '44%' : '46%'};transform:translateY(-50%);}
    .titre{font-size:${horiz ? '9rem' : '11rem'};line-height:1;}
    .sous{color:#fff;font-size:${horiz ? '3.4rem' : '4.2rem'};letter-spacing:.18em;margin-top:1rem;}`,
      'mot-geant': `
    .voile{background:linear-gradient(180deg,rgba(0,0,0,.7) 0%,rgba(0,0,0,0) 55%);}
    .txt{top:${horiz ? '8%' : '11%'};} .kicker{margin-bottom:1.6rem;}
    .titre{font-size:${horiz ? '13rem' : '19rem'};line-height:.9;letter-spacing:-.04em;}`,
      aucun: '.voile{background:transparent;} .txt{display:none;}',
    };
    return base + (L[layout] || L['titre-bas']);
  }

  private htmlMiniature(fondUrl: string, layout: string, textes: MiniatureTextes, brand: { accent?: string | null }, ratio: string, police = 'impact'): string {
    let blocs = '';
    if (textes.kicker && ['titre-bas', 'mot-geant'].includes(layout)) blocs += `<div class="kicker">${htmlEscape(textes.kicker)}</div>`;
    if (textes.titre && layout !== 'aucun') blocs += `<div class="titre">${htmlEscape(textes.titre)}</div>`;
    if (textes.sous && ['titre-bas', 'centre', 'haut-neon', 'bande'].includes(layout)) blocs += `<div class="sous">${htmlEscape(textes.sous)}</div>`;
    return (
      `<!doctype html><html><head><meta charset='utf-8'><style>${this.css(layout, brand, ratio, police)}</style></head>` +
      `<body><div class='m'><img class='fond' src='${htmlEscape(fondUrl)}'><div class='voile'></div>` +
      `<div class='txt'>${blocs}</div></div></body></html>`
    );
  }

  /** Fond + texte -> PNG (1080x1920 ou 1280x720). Le titre rétrécit s'il déborde. */
  private async composer(fondUrl: string, layout: string, textes: MiniatureTextes, brand: { accent?: string | null }, ratio = '9:16', police = 'impact'): Promise<Buffer> {
    const [w, h, dsf] = RATIOS[ratio] || RATIOS['9:16'];
    const htmlStr = this.htmlMiniature(fondUrl, layout, textes, brand, ratio, police).replace('<html>', `<html style='font-size:${w / 100}px'>`);
    const browser = await this.playwrightBrowserService.launch();
    try {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
      await page.setContent(htmlStr, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForFunction(
          "(() => { const i = document.querySelector('img.fond'); return i && i.complete && i.naturalWidth > 0; })()",
          { timeout: 60_000 },
        );
      } catch (e) {
        this.logger.warn(`miniature: fond lent à charger (${String(e).slice(0, 80)}), capture quand même`);
      }
      try {
        await page.evaluate("() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 8000))])");
      } catch {
        // silencieux, comme côté Python
      }
      await page.waitForTimeout(250);
      await page.evaluate(`() => {
          const box = document.querySelector('.txt'); if (!box) return;
          const titre = box.querySelector('.titre');
          if (titre) {
            const mots = titre.textContent.trim().split(/\\s+/).length;
            const lignesMax = mots >= 5 ? 3 : 2;
            const W = titre.clientWidth;
            let s = window.innerWidth * (lignesMax === 3 ? 0.26 : 0.30);
            for (let i = 0; i < 60; i++) {
              titre.style.fontSize = s + 'px';
              const lh = parseFloat(getComputedStyle(titre).lineHeight) || s;
              const lignes = Math.round(titre.scrollHeight / lh);
              if (lignes <= lignesMax && titre.scrollWidth <= W + 1) break;
              s *= 0.95;
            }
          }
          const maxW = window.innerWidth * 0.92, maxH = window.innerHeight * 0.55;
          for (let i = 0; i < 40; i++) {
            const r = box.getBoundingClientRect();
            const large = Array.from(box.children).some(c => c.scrollWidth > maxW) || r.height > maxH;
            if (!large) break;
            box.querySelectorAll('.titre,.sous,.kicker').forEach(el => { const f = parseFloat(getComputedStyle(el).fontSize); el.style.fontSize = (f * 0.94) + 'px'; });
          }
        }`);
      await page.waitForTimeout(60);
      const png = await page.screenshot({ type: 'png', fullPage: false });
      return png;
    } finally {
      await browser.close();
    }
  }

  // ------------------------------------------------------------------ pipeline

  async contenu(telegramId: string, contenuId: string): Promise<{
    id: string;
    contenu: string | null;
    titre: string | null;
    reel_data: unknown;
    video_status: string | null;
    video_preview_url: string | null;
  }> {
    const c = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!c) throw new Error('Reel introuvable.');
    if (c.type !== normTypeContenu('Reel')) throw new Error("Ce contenu n'est pas un reel.");
    return c as never;
  }

  /** Mémorise les textes proposés une fois pour toutes sur `reel_data.miniature_textes`. */
  async memoriserTextes(contenuId: string, reelData: Record<string, unknown>): Promise<void> {
    await this.prisma.contenu.update({ where: { id: contenuId }, data: { reel_data: reelData } as never });
  }

  private brand(u: Record<string, unknown>): { principale: string; accent: string } {
    return { principale: String(u.couleur_principale || '#5B6CFF'), accent: String(u.couleur_accent || '#3AFFA3') };
  }

  /** L'image de fond (nano-banana), avec la photo du client si elle existe. Retourne l'URL.
   *
   * `refUrl` : image de la banque choisie par le client pour remplacer sa propre photo comme
   * sujet (ex. la mascotte de sa marque), sinon repli sur `photo_url` (comportement historique). */
  async genererFond(
    telegramId: string,
    contenu: { id: string; contenu?: string | null; titre?: string | null },
    gabaritId: string,
    textes: MiniatureTextes,
    ratio: string,
    modele = 'nano2',
    style = 'photo',
    refUrl?: string | null,
  ): Promise<string> {
    const g = PAR_ID.get(gabaritId) || GABARITS[0];
    const u = await this.marqueService.chargerMarque(telegramId);
    const sujetPhoto = refUrl || u.photo_url;
    const avecPhoto = Boolean(sujetPhoto);
    const scene = (avecPhoto ? g.scene : g.scene_sans_photo).replace('{objet}', textes.objet || 'a glowing object');
    const sujet = (contenu.contenu || contenu.titre || '').slice(0, 400).replace(/\n/g, ' ');
    const orient =
      (ratio !== '16:9' ? 'Vertical 9:16 composition' : 'Horizontal 16:9 composition') +
      ', the image fills the whole frame edge to edge: NO border, NO frame, NO margin, NO paper edge, NO letterbox.';
    const st = STYLES[style] || STYLES.photo;
    const prompt =
      `${scene}\n\nSubject of the video, for context only (do NOT write any of it as text): ${sujet}\n` +
      `${orient} STYLE: ${st.texte} ABSOLUTELY NO TEXT, NO LETTERS, NO LOGOS, NO WATERMARK anywhere in the image.`;
    // Référence de la banque (refUrl) : on la fait INTÉGRER LITTÉRALEMENT (personnage/objet/logo)
    // plutôt que passer par avecPhoto, qui ne sait lire que photo_url et suppose un visage à
    // préserver, inadapté à une mascotte par exemple.
    const res = await this.imageService.genererImage(
      telegramId,
      prompt,
      Boolean(!refUrl && avecPhoto),
      IMAGE_MODELS[modele] || IMAGE_MODELS.nano2,
      null,
      refUrl ? [refUrl] : [],
      null,
      !st.photo,
      ratio === '16:9' ? '16:9' : '9:16',
      refUrl ? [refUrl] : undefined,
      `miniatures/${telegramId}/${contenu.id}-fond-${Math.floor(Date.now() / 1000)}`,
      !st.photo,
    );
    if ('error' in res) throw new Error(res.error);
    return res.lien_visuel;
  }

  /** Compose le texte, dépose la miniature, en fait la couverture du reel. */
  async finaliser(
    telegramId: string,
    contenu: { id: string; reel_data?: unknown },
    fondUrl: string,
    gabaritId: string,
    textes: MiniatureTextes,
    ratio: string,
    style = 'photo',
    police?: string | null,
    ref?: string | null,
  ): Promise<Miniature> {
    const g = PAR_ID.get(gabaritId) || GABARITS[0];
    const u = await this.marqueService.chargerMarque(telegramId);
    const policeEff = police && police in POLICES ? police : POLICE_DEFAUT[g.id] || 'impact';
    const png = await this.composer(fondUrl, g.layout, textes, this.brand(u), ratio, policeEff);
    const up = await this.imageService.uploadAvecReprise(`data:image/png;base64,${png.toString('base64')}`, {
      resource_type: 'image',
      public_id: `miniatures/${telegramId}/${contenu.id}`,
      overwrite: true,
      invalidate: true,
    });
    const url = up.secure_url.replace('/upload/', '/upload/q_auto,f_auto/');
    const rd = { ...((contenu.reel_data as Record<string, unknown>) || {}) };
    const ancien = ((rd.miniature as { fond?: string } | undefined) || {}).fond;
    if (ancien && ancien !== fondUrl) {
      const m = /\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(ancien);
      if (m) {
        try {
          await cloudinary.uploader.destroy(m[1], { resource_type: 'image', invalidate: true });
        } catch (e) {
          this.logger.warn(`miniature: ancien fond non supprimé: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    const mini: Miniature = {
      url,
      fond: fondUrl,
      gabarit: g.id,
      textes,
      ratio,
      style: style in STYLES ? style : 'photo',
      police: policeEff,
      ref: ref ?? null,
      date: new Date().toISOString(),
    };
    rd.miniature = mini;
    await this.prisma.contenu.update({ where: { id: contenu.id }, data: { reel_data: rd, lien_visuel: url, video_preview_url: url } as never });
    return mini;
  }
}
