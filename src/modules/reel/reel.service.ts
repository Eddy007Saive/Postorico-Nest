import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { BanqueService } from '../banque/banque.service';
import { ClaudeService } from '../claude/claude.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { ImageService, IMAGE_MODELS } from '../image/image.service';
import { MarqueService } from '../marque/marque.service';
import { MusicLibraryService, MAX_MUSIQUES, TAILLE_MAX_MO } from '../music/music-library.service';
import { PlanningService } from '../planning/planning.service';
import { RenderQueueService } from '../render-queue/render-queue.service';
import { UsageService } from '../usage/usage.service';
import { sansTiret } from '../../common/utils/texte-genere.util';
import { MontageService, MontageSegment } from './montage.service';
import { EFFETS, GUIDES_STYLE, LANGUES, VisuelPool, clipRenduSimple, estClip, estImageSource, estVisuel, imgRendu, morceau, pimenterReveals } from './reel-common.util';

/**
 * Studio Reels (Remotion) — port direct de backend/services/reel_service.py :
 *  1. Claude (Haiku) condense un post existant en {hook, points, cta} (templates non-Séquence)
 *     ou écrit un scénario Séquence multi-plans (templates "sequence*").
 *  2. La ligne contenu "Reel" est créée tout de suite (A valider, video_status en_traitement)
 *     et le rendu Remotion (1080x1920) est fait EN ARRIÈRE-PLAN par RenderQueueService, qui
 *     uploade sur Cloudinary et notifie à la fin. Plus de requête HTTP ouverte 1-2 min.
 *  3. Publication ensuite par le flux normal (validation -> Zernio).
 */

const MODELE_SCRIPT = 'claude-haiku-4-5';

// Format Motion (typo cinétique) — port de reel_service._ROLE_MOTION / _script_motion.
const ROLE_MOTION =
  'Tu es motion designer. Tu transformes un post en TYPOGRAPHIE CINETIQUE verticale (reel 9:16) ' +
  'de 4 a 6 plans de texte, dans la langue du post. Chaque plan = une phrase courte (2 a 9 mots), ' +
  "lisible en 2-3 secondes ; l'ensemble raconte le message du post, de l'accroche a la conclusion. " +
  'Pour chaque plan choisis UN effet parmi : ' +
  'revele (mots qui apparaissent un a un, defaut), ' +
  "barre (les mots accentues sont barres en rouge : ce qu'on rejette, l'ancienne facon de faire), " +
  "surligne (les mots accentues passent sous un marqueur : l'idee cle), " +
  'geant (UN mot ou chiffre enorme, le reste en petit dessous : chiffre, mot-choc), ' +
  'machine (machine a ecrire : affirmation calme, conclusion). ' +
  'Varie les effets ; geant une fois au plus. accents = 1 a 2 mots EXACTS du plan a mettre en valeur. ' +
  "dur = duree en secondes (1.8 a 3.5) selon la longueur. N'invente aucun chiffre absent du post. " +
  "Jamais de tiret cadratin. cta = appel a l'action final de 2 a 5 mots. " +
  'icone = UNE icone qui illustre le plan, parmi : fusee, horloge, cible, graphique, eclair, coeur, coche, croix, calendrier, message, personne, ampoule, argent, etoile, bouclier, telephone, megaphone, trophee ; ' +
  "mets null si aucune ne colle vraiment, et pas d'icone sur un plan geant. Au moins la moitie des plans ont une icone. " +
  'Reponds UNIQUEMENT en JSON strict : {"plans": [{"texte": "...", "accents": ["..."], "effet": "revele", "dur": 2.4, "icone": "cible"}], "cta": "..."}';
const EFFETS_MOTION = ['revele', 'barre', 'surligne', 'geant', 'machine'];
const ICONES_MOTION = ['fusee', 'horloge', 'cible', 'graphique', 'eclair', 'coeur', 'coche', 'croix', 'calendrier', 'message', 'personne', 'ampoule', 'argent', 'etoile', 'bouclier', 'telephone', 'megaphone', 'trophee'];
type PlanMotion = { texte: string; accents: string[]; effet: string; dur: number; icone: string | null };

export type ReelSegment = MontageSegment & { debut?: number; fin?: number };

export interface ReelScenario {
  recette: string;
  brief?: string | null;
  segments: ReelSegment[];
  style?: string;
  montage_ia?: boolean;
  musique?: string | null;
  voix?: string | null;
  angle?: string;
}

export interface ReelImageInput {
  url: string;
  desc?: string | null;
  debut?: number | null;
  fin?: number | null;
}

const APERCUS = 'https://res.cloudinary.com/dy9gp5pim/video/upload/q_auto/reels/_templates';

export const TEMPLATES: Record<string, { composition: string; label: string; duree: number; style?: string; tags: string[]; apercu: string | null; desc: string }> = {
  sequence: { composition: 'ReelSequence', label: 'Séquence', duree: 18, style: 'signature', tags: ['Tous usages'], apercu: `${APERCUS}/sequence-signature.mp4`, desc: "Le montage pro : plans multiples composés par l'IA — tes visuels, textes animés, unique à chaque post." },
  'sequence-cinema': { composition: 'ReelSequence', label: 'Séquence — Cinéma', duree: 18, style: 'cinema', tags: ['Haut de gamme', 'Hôtel · Immo'], apercu: `${APERCUS}/sequence-cinema.mp4`, desc: 'Le même montage en écriture cinéma : letterbox, légendes élégantes, rythme posé.' },
  'sequence-editorial': { composition: 'ReelSequence', label: 'Séquence — Éditorial', duree: 18, style: 'editorial', tags: ['Marques', 'Produit'], apercu: `${APERCUS}/sequence-editorial.mp4`, desc: 'Façon magazine : cadre fin, numéros de page, accents nets.' },
  'sequence-impact': { composition: 'ReelSequence', label: 'Séquence — Impact', duree: 16, style: 'impact', tags: ['Punchy', 'Promo'], apercu: `${APERCUS}/sequence-impact.mp4`, desc: 'Noir et brutal : mots énormes, coupes sèches, flashs — pour les annonces qui claquent.' },
  'sequence-odyssee': { composition: 'ReelSequence', label: 'Séquence — Odyssée', duree: 18, style: 'odyssee', tags: ['Spectaculaire', 'Voyage'], apercu: `${APERCUS}/sequence-odyssee.mp4`, desc: 'Profondeur spatiale : images traversées en zoom, typo espacée — grandiose et immersif.' },
  'sequence-vlog': { composition: 'ReelSequence', label: 'Séquence — Vlog', duree: 18, style: 'vlog', tags: ['Casual', 'Coulisses'], apercu: `${APERCUS}/sequence-vlog.mp4`, desc: 'Esprit vlog : mots en stickers, cadre caméra REC, image qui respire — proche et authentique.' },
  'sequence-carnet': { composition: 'ReelSequence', label: 'Séquence — Carnet', duree: 18, style: 'carnet', tags: ['Voyage', 'Lifestyle'], apercu: `${APERCUS}/sequence-carnet.mp4`, desc: 'Carnet de voyage : polaroids scotchés, écriture manuscrite, papier crème.' },
  'sequence-avantapres': { composition: 'ReelSequence', label: 'Séquence — Avant/Après', duree: 16, style: 'avantapres', tags: ['Transformation', 'Preuve'], apercu: `${APERCUS}/sequence-avantapres.mp4`, desc: 'La preuve par l’image : visuels badgés AVANT puis APRÈS — parfait pour les transformations.' },
  'sequence-temoignage': { composition: 'ReelSequence', label: 'Séquence — Témoignage', duree: 16, style: 'temoignage', tags: ['Avis client', 'Confiance'], apercu: `${APERCUS}/sequence-temoignage.mp4`, desc: 'Un avis client mis en scène : 5 étoiles, citation en lettres serif, signature.' },
  'sequence-conseils': { composition: 'ReelSequence', label: 'Séquence — Conseils', duree: 18, style: 'conseils', tags: ['Éducatif', 'Tips'], apercu: `${APERCUS}/sequence-conseils.mp4`, desc: 'Accroche puis conseils numérotés — le format qui se partage et se sauvegarde.' },
  affiche: { composition: 'ReelAffiche', label: 'Affiche', duree: 11, tags: ['Pub'], apercu: null, desc: 'La pub premium : titre accentué, 3 arguments à icônes, ton image, CTA brillant.' },
  impact: { composition: 'ReelBrand', label: 'Impact', duree: 8, tags: ['Promo', 'Stories'], apercu: null, desc: 'Punchy : accroche mot à mot → 3 preuves → CTA. Idéal stories.' },
  stats: { composition: 'ReelStat', label: 'Gros chiffres', duree: 10, tags: ['Résultats'], apercu: null, desc: 'Un chiffre géant par écran, qui compte en direct. Pour les posts à résultats.' },
  long: { composition: 'ReelLong', label: 'Narratif', duree: 22, tags: ['Storytelling'], apercu: null, desc: 'Accroche → contexte → preuves plein écran → leçon en citation → CTA.' },
  motion: { composition: 'MotionTypo', label: 'Motion · Typo cinétique', duree: 16, tags: ['Motion design', 'Sans visuel'], apercu: null, desc: 'Ton message en typographie animée : mots révélés, barrés, surlignés, mot géant, machine à écrire. Aux couleurs de ta marque, aucun visuel requis.' },
};

const STYLES_SEQUENCE = Object.values(TEMPLATES)
  .map((v) => v.style)
  .filter((s): s is string => Boolean(s));

const ROLE_RECO =
  'Tu recommandes UN template de reel pour un post donné. Voici les templates :\n' +
  '- sequence : montage multi-plans avec les visuels du post (bon défaut)\n' +
  '- sequence-cinema : haut de gamme, contemplatif (hôtellerie, immobilier, bien-être, luxe)\n' +
  '- sequence-editorial : magazine, lancement produit, marques\n' +
  '- sequence-impact : annonce choc, promo agressive, urgence, gros lancement\n' +
  '- sequence-odyssee : voyage, destination, immobilier de prestige, spectaculaire\n' +
  '- sequence-vlog : coulisses, quotidien, créateurs, proximité avec l’audience\n' +
  '- sequence-carnet : récit de voyage, lifestyle, souvenirs, artisanat\n' +
  '- sequence-avantapres : transformation visible, rénovation, relooking, résultats photo\n' +
  '- sequence-temoignage : avis client, retour d’expérience, preuve sociale\n' +
  '- sequence-conseils : post éducatif, astuces, liste d’erreurs ou de tips\n' +
  '- affiche : publicité posée avec arguments structurés\n' +
  '- impact : promo punchy courte format stories\n' +
  '- stats : posts à chiffres et résultats\n' +
  '- long : storytelling, leçon, récit personnel\n' +
  '- motion : message fort et court à faire claquer en typographie animée, sans visuel (conviction, chiffre clé)\n' +
  'Réponds UNIQUEMENT en JSON strict : {"template": "id", "raison": "8-14 mots dans la langue du post"}';

const ROLE = 'Tu es copywriter pour reels courts. A partir d\'un post, tu produis le script d\'un reel de 8 s :\n' +
  '- hook : une phrase choc de 5 a 10 mots (la promesse ou la tension du post)\n' +
  '- points : 3 arguments TRES courts (3 a 6 mots chacun)\n' +
  '- cta : un appel a l\'action de 2 a 5 mots\n' +
  'Ecris dans la langue du post. Reponds UNIQUEMENT en JSON strict : ' +
  '{"hook": "...", "points": ["...", "...", "..."], "cta": "..."}';

const ROLE_LONG = 'Tu es copywriter pour reels narratifs de 20-25 s. A partir d\'un post, tu produis :\n' +
  '- hook : une phrase choc de 5 a 10 mots\n' +
  '- contexte : 1-2 phrases qui posent le decor (25 mots max)\n' +
  '- points : 3 arguments courts (5 a 10 mots chacun)\n' +
  '- lecon : la lecon du post en une phrase citation (15 mots max)\n' +
  '- cta : un appel a l\'action de 2 a 5 mots\n' +
  'Ecris dans la langue du post, orthographe irreprochable. Reponds UNIQUEMENT en JSON strict : ' +
  '{"hook": "...", "contexte": "...", "points": ["...", "...", "..."], "lecon": "...", "cta": "..."}';

const ROLE_AFFICHE = 'Tu es directeur artistique publicitaire. A partir d\'un post, tu produis le contenu d\'une affiche video verticale.\n' +
  'Regles : les segments a accentuer sont entre [crochets] (1 par ligne maximum, le mot le plus fort).\n' +
  '- headline : 2 ou 3 lignes courtes separees par \\n (3-5 mots par ligne), le mot cle de la derniere ligne entre [crochets]\n' +
  '- sub : 2 lignes courtes separees par \\n, un mot [marque] par ligne\n' +
  '- features : 3 objets {icon: \'bolt\'|\'star\'|\'shield\', texte: \'4-6 mots avec un mot [marque]\', sous: \'3-6 mots\'}\n' +
  '- stat : une ligne percutante avec un segment [marque] (chiffre ou promesse)\n' +
  '- cta : 2 a 4 mots\n' +
  'Ecris dans la langue du post, orthographe irreprochable. Reponds UNIQUEMENT en JSON strict : ' +
  '{"headline": "...", "sub": "...", "features": [{"icon": "bolt", "texte": "...", "sous": "..."}, ...], "stat": "...", "cta": "..."}';

const ROLE_SEQUENCE =
  'You direct short social videos (15-22 s). From a post and a list of available visuals, ' +
  'you write the SCENARIO of a reel: a sequence of 4 to 7 shots.\n\n' +
  'OUTPUT LANGUAGE — ABSOLUTE RULE. These instructions are in English; every word you WRITE ' +
  "for the audience (texte, accents, bar, label) must be in the client's language, given below. " +
  'Never mix languages, never translate to English, never leave an English word in the reel. ' +
  'Flawless spelling and accents in that language (é, è, ê, à, ç in French; ñ, á, ó in Spanish).\n\n' +
  'Recipes (pick the one that fits the post):\n' +
  '- promo: punchy hook -> benefit -> proof -> offer/CTA\n' +
  '- tutorial: hook -> 2 to 4 steps -> CTA\n' +
  '- proof: hook -> numbers/results -> CTA\n' +
  "Shot types: 'typo' (full-screen text), 'image' (one visual from the list + short text), " +
  "'cta' (last shot, mandatory).\n\n" +
  "THE CLIENT'S OWN INSTRUCTIONS OUTRANK EVERYTHING.\n" +
  'When the client says what to write or where to place it, obey to the letter:\n' +
  '- he dictates a sentence ("end with: book your demo") -> reuse HIS EXACT WORDS, ' +
  'do not rephrase or embellish them, on the exact shot he asks for\n' +
  '- "at the end" / "to finish" -> that is the text of the last shot (the cta)\n' +
  '- "start with" / "first" -> that is the text of shot 1\n' +
  '- he imposes a tone, an angle, an order, a banned word -> hold it across ALL shots\n' +
  '- his instruction contradicts the recipe or the post? HE WINS.\n' +
  'An ignored instruction makes the reel unusable: re-read it before returning your JSON.\n\n' +
  'STRICT rules (they apply UNLESS the client asks otherwise):\n' +
  '- 4 to 7 shots, 2 to 4.5 s each, the last one is ALWAYS type cta\n' +
  '- texte: 2 to 7 words per shot, punchy\n' +
  '- accents: 1 or 2 words of that text to highlight (copied exactly as written)\n' +
  '- image_id: ONLY an id from the provided list; if no visual fits, make it a typo shot\n' +
  '- a visual marked [VIDEO CLIP] is moving footage: give it a longer shot (3.5 to 4.5 s) ' +
  'so it has time to breathe, and prefer it for showing an action, a place or a gesture\n' +
  '- vary the effects: zoomIn, zoomOut, panLeft, panRight\n' +
  '- bar (cta shot): 2 to 5 words (brand, website or action)\n' +
  '- label (optional): shot badge when the art direction asks for it (BEFORE/AFTER, witness signature)\n' +
  'Answer with STRICT JSON only: ' +
  '{"recette": "...", "segments": [{"type": "typo|image|cta", "dur": 2.8, "texte": "...", ' +
  '"accents": ["..."], "image_id": "...or null", "effet": "zoomIn|zoomOut|panLeft|panRight", ' +
  '"reveal": "carte|lamelles|portes|stores|iris", "bar": "...if cta", "label": "...optional"}]}';

const CONSIGNE_VOIX =
  '\n\nVOICE-OVER. This reel will be read aloud by a narrator. For EVERY shot, add a field ' +
  '"voix": one SPOKEN sentence (8 to 16 words) in the client\'s language, that a real person ' +
  'would say out loud to a friend: natural oral phrasing, contractions allowed, a real verb, ' +
  'no telegram style, no hashtags, no emoji. It must carry the same idea as the on-screen text ' +
  'but NOT repeat it word for word (the screen shows 3 words, the voice says the full thought). ' +
  'Vary the rhythm: one question, one punchy statement, one calm sentence. On the cta shot, ' +
  'the voice says the call to action plainly. Add "voix" to each object of segments.';

const CONSIGNE_VOIX_SCRIPT =
  '\n\nVOICE-OVER FROM AN APPROVED SCRIPT. The text below is a SCRIPT the client already approved, ' +
  'written to be spoken aloud. First drop what is not spoken: section tags like [HOOK], [CORPS], [CTA] ' +
  'and stage directions between parentheses or asterisks (camera notes, gestures, tone). Then spread ' +
  "the remaining spoken lines over the shots IN THEIR ORIGINAL ORDER: each shot gets a field \"voix\" " +
  "containing the script's OWN WORDS, verbatim. You may only cut a long passage into two shots; never " +
  'rephrase, summarize, add or skip a spoken line. Cover the WHOLE script, using as many shots as ' +
  'needed (4 to 10; the last one is the cta and speaks the script\'s own call to action). The on-screen ' +
  '"texte" of each shot is 2 to 6 key words taken from that shot\'s voice line. Add "voix" to each ' +
  'object of segments.';

const ROLE_PROPOSER =
  'You cast visuals for a short vertical video (reel) made of 3 to 5 image shots. You receive the ' +
  "reel's text and the client's visual bank (id + description). Pick the bank visuals that truly " +
  'illustrate the text (relevance first, at most {n}), then, if fewer than {n} shots are covered, ' +
  'describe the missing shots as short scene ideas (8 to 20 words each, no faces, no invented UI or ' +
  "dashboards, coherent with the client's sector). Never pick a visual just to fill: an empty pick " +
  'and a generated image is better than an off-topic photo. Answer with JSON only: ' +
  '{{"banque": ["id", ...], "manquants": ["scene idea", ...]}} with len(banque)+len(manquants) <= {n}.';

@Injectable()
export class ReelService {
  private readonly logger = new Logger(ReelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly usageService: UsageService,
    private readonly musicLibraryService: MusicLibraryService,
    private readonly banqueService: BanqueService,
    private readonly montageService: MontageService,
    private readonly renderQueueService: RenderQueueService,
    private readonly planningService: PlanningService,
    private readonly imageService: ImageService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Journalise un appel LLM du studio reels dans usage_log. Un reel coûte DEUX choses :
   * l'écriture du scénario (tokens, ici) et le rendu Remotion (temps de calcul, journalisé
   * par RemotionService). Sans cette moitié, le coût affiché à l'admin serait faux. */
  private journalLlm(telegramId: string | null | undefined, action: string, resp: Parameters<ClaudeService['usage']>[0] | null, modele = MODELE_SCRIPT): void {
    if (!telegramId || !resp) return;
    this.usageService.log(telegramId, action, modele, this.claude.usage(resp), 0).catch((e) => this.logger.warn(`journal LLM ${action}: ${e instanceof Error ? e.message : e}`));
  }

  private texteReponse(resp: Parameters<ClaudeService['texte']>[0]): string {
    return this.claude.texte(resp);
  }

  private parseJson<T = Record<string, unknown>>(raw: string): T {
    const m = /\{[\s\S]*\}/.exec(raw);
    return JSON.parse(m ? m[0] : raw) as T;
  }

  listeTemplates(): Array<{ id: string; label: string; duree: number; desc: string; tags: string[]; apercu: string | null; sequence: boolean }> {
    return Object.entries(TEMPLATES).map(([k, v]) => ({
      id: k,
      label: v.label,
      duree: v.duree,
      desc: v.desc,
      tags: v.tags || [],
      apercu: v.apercu,
      sequence: k.startsWith('sequence'),
    }));
  }

  /** L'IA choisit le template le plus adapté au post (badge « Recommandé » de la galerie).
   * Résultat mis en CACHE sur la ligne (contenu.reel_reco = {template, raison, h}). */
  async recommanderTemplate(telegramId: string, contenuId: string): Promise<{ template: string; raison: string }> {
    const row = await this.prisma.contenu.findFirst({
      where: { id: contenuId, telegram_id: telegramId },
      select: { contenu: true, titre: true, reel_reco: true },
    });
    if (!row) return { template: 'sequence', raison: '' };
    const texte = (row.contenu || row.titre || '').slice(0, 2500);
    const h = crypto.createHash('sha1').update(texte, 'utf-8').digest('hex');
    const cache = (row.reel_reco || {}) as { h?: string; template?: string; raison?: string };
    if (cache && cache.h === h && cache.template && cache.template in TEMPLATES) {
      return { template: cache.template, raison: String(cache.raison || '').slice(0, 120) };
    }
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 120,
        system: ROLE_RECO,
        messages: [{ role: 'user', content: `Post :\n\n${texte}\n\nDonne le JSON.` }],
      });
      this.journalLlm(telegramId, 'reel_reco', resp);
      const data = this.parseJson<{ template?: string; raison?: string }>(this.texteReponse(resp));
      const tpl = data.template && data.template in TEMPLATES ? data.template : 'sequence';
      const out = { template: tpl, raison: String(data.raison || '').slice(0, 120) };
      try {
        await this.prisma.contenu.update({ where: { id: contenuId }, data: { reel_reco: { ...out, h } } });
      } catch (e) {
        this.logger.warn(`reel reco cache: ${e instanceof Error ? e.message : e}`);
      }
      return out;
    } catch (e) {
      this.logger.warn(`reel reco: ${e instanceof Error ? e.message : e}`);
      const low = texte.toLowerCase();
      if (['%', 'promo', 'offre', 'réduction', 'reduction'].some((k) => low.includes(k))) return { template: 'impact', raison: '' };
      if (['chiffre', 'résultat', 'resultat', 'x2', 'x3'].some((k) => low.includes(k))) return { template: 'stats', raison: '' };
      return { template: 'sequence', raison: '' };
    }
  }

  /** Visuel source d'un reel Séquence : Cloudinary + description vision (une fois). */
  async uploadImageSource(telegramId: string, data: Buffer): Promise<{ url: string; desc: string }> {
    const up = await cloudinary.uploader.upload(`data:image/*;base64,${data.toString('base64')}`, {
      folder: `reels-sources/${telegramId}`,
      transformation: [{ width: 1600, crop: 'limit' }, { quality: 'auto' }],
    });
    const url = up.secure_url;
    const d = await this.banqueService.decrire(url, telegramId);
    return { url, desc: d.description };
  }

  /** Ajoute un MP3 du client à sa bibliothèque (Cloudinary + ligne brand_musiques). */
  async importerMusique(telegramId: string, data: Buffer, nomFichier?: string | null): Promise<{ id: string; label: string; url: string; category: string } | { error: string }> {
    if (data.length > TAILLE_MAX_MO * 1024 * 1024) return { error: `Fichier trop lourd (max ${TAILLE_MAX_MO} Mo).` };
    if ((await this.musicLibraryService.musiquesDuCompte(telegramId)).length >= MAX_MUSIQUES) {
      return { error: `Bibliothèque pleine (${MAX_MUSIQUES} musiques). Supprimes-en une d'abord.` };
    }
    const label = (nomFichier || '').trim().replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 60) || 'Ma musique';
    try {
      const up = await cloudinary.uploader.upload(`data:audio/mpeg;base64,${data.toString('base64')}`, {
        resource_type: 'video',
        folder: `musiques/${telegramId}`,
      });
      const row = await this.prisma.brand_musiques.create({ data: { telegram_id: telegramId, url: up.secure_url, label } });
      return { id: row.id, label: row.label, url: row.url, category: 'perso' };
    } catch (e) {
      this.logger.error(`import musique ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Import impossible.' };
    }
  }

  /** Retire la piste ET son fichier Cloudinary (pas d'accumulation). */
  async supprimerMusique(telegramId: string, musiqueId: string): Promise<{ ok: true } | { error: string }> {
    const row = await this.prisma.brand_musiques.findFirst({ where: { id: musiqueId, telegram_id: telegramId }, select: { url: true } });
    if (!row) return { error: 'Musique introuvable.' };
    try {
      const m = /\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(row.url);
      if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'video', invalidate: true });
    } catch (e) {
      this.logger.warn(`destroy musique cloudinary: ${e instanceof Error ? e.message : e}`);
    }
    await this.prisma.brand_musiques.deleteMany({ where: { id: musiqueId, telegram_id: telegramId } });
    return { ok: true };
  }

  private planVideo(seg: ReelSegment, v: VisuelPool): void {
    const m = morceau(v);
    if (m) {
      seg.dur = Math.round((m[1] - m[0]) * 10) / 10;
      seg.video = this.montageService.clipRendu(v.url, m[0], seg.dur);
      seg.debut = m[0];
      seg.fin = m[1];
    } else {
      seg.video = clipRenduSimple(v.url, seg.dur);
    }
  }

  /** Visuels CHOISIS par le client -> pool numéroté (img_1, img_2…), avec la découpe éventuelle. */
  private poolDepuisImages(images: ReelImageInput[]): VisuelPool[] {
    return images
      .filter((im) => im.url)
      .map((im, i) => ({
        id: `img_${i + 1}`,
        url: im.url,
        desc: (im.desc || `Visuel fourni n°${i + 1}`).slice(0, 200),
        debut: im.debut ?? null,
        fin: im.fin ?? null,
      }));
  }

  /** Les visuels de la banque sous la forme du pool ({id, url, desc}), les plus récents d'abord. */
  private async poolBanque(telegramId: string, deja: Set<string> = new Set(), limite = 8): Promise<VisuelPool[]> {
    const out: VisuelPool[] = [];
    try {
      for (const a of await this.banqueService.lister(telegramId)) {
        if (!a.url || deja.has(a.url) || !estVisuel(a.url)) continue;
        let desc = (a.description || '').trim();
        if (!desc) desc = estClip(a.url) ? 'Extrait vidéo de la banque' : 'Visuel de la banque';
        out.push({ id: `bq_${String(a.id).slice(0, 8)}`, url: a.url, desc, asset: a });
        if (out.length >= limite) break;
      }
    } catch (e) {
      this.logger.warn(`reel pool banque: ${e instanceof Error ? e.message : e}`);
    }
    return out;
  }

  /** Visuels mobilisables pour le scénario : visuel du post + gabarits de la marque + banque. */
  private async poolVisuels(telegramId: string, cur: { lien_visuel?: string | null; slides_images?: unknown }): Promise<VisuelPool[]> {
    const pool: VisuelPool[] = [];
    const lv = cur.lien_visuel;
    if (lv && lv.includes('cloudinary') && estImageSource(lv)) pool.push({ id: 'visuel_post', url: lv, desc: 'Visuel principal du post' });
    const slides = (Array.isArray(cur.slides_images) ? cur.slides_images : []) as string[];
    for (const sUrl of slides.slice(0, 3)) pool.push({ id: `slide_${pool.length}`, url: sUrl, desc: 'Slide du carrousel du post' });
    try {
      const rows = await this.prisma.brand_templates.findMany({ where: { telegram_id: telegramId }, select: { id: true, nom: true, note: true, images: true }, take: 5 });
      for (const row of rows) {
        const images = (Array.isArray(row.images) ? row.images : []) as string[];
        images.slice(0, 2).forEach((u, i) => {
          pool.push({
            id: `bt_${String(row.id).slice(0, 8)}_${i}`,
            url: u,
            desc: `Visuel de marque « ${row.nom || 'gabarit'} »${row.note ? ` — ${row.note}` : ''}`,
          });
        });
      }
    } catch (e) {
      this.logger.warn(`reel pool visuels: ${e instanceof Error ? e.message : e}`);
    }
    pool.push(...(await this.poolBanque(telegramId, new Set(pool.map((p) => p.url)))));
    return pool.slice(0, 14);
  }

  /** Casting de visuels pour un reel : d'abord la banque du client (par pertinence), puis des
   * prompts d'image prêts à générer pour les plans non couverts. */
  async proposerVisuels(telegramId: string, texte: string, brief?: string | null, maximum = 3): Promise<Record<string, unknown> | { error: string }> {
    texte = (texte || '').trim();
    if (!texte) return { error: "Ce reel n'a pas de texte." };
    maximum = Math.max(1, Math.min(Number(maximum) || 3, 3));
    const pool = await this.poolBanque(telegramId, new Set(), 30);
    const parId = new Map(pool.map((p) => [p.id, p]));
    const liste = pool.length ? pool.map((p) => `- ${p.id} : ${estClip(p.url) ? '[VIDEO CLIP] ' : ''}${p.desc}`).join('\n') : '(empty bank)';
    const u = await this.marqueService.chargerMarque(telegramId);
    const langue = LANGUES[String(u.langue || 'fr').toLowerCase()] || 'French';
    const consigne = brief && brief.trim() ? `\n\nClient's instructions: ${brief.trim().slice(0, 800)}` : '';
    let choisis: VisuelPool[] = [];
    let manquants: string[] = [];
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system:
          ROLE_PROPOSER.replace(/\{n\}/g, String(maximum)) +
          ` Write the scene ideas in ${langue}. Sector: ${u.secteur || 'unknown'}.` +
          this.marqueService.contexteMarqueCourt(u, { secteur: false, ecriture: false }),
        messages: [{ role: 'user', content: `Reel text:\n\n${texte.slice(0, 3000)}${consigne}\n\nVisual bank:\n${liste}\n\nReturn the JSON.` }],
      });
      this.journalLlm(telegramId, 'reel_casting', resp);
      const data = this.parseJson<{ banque?: string[]; manquants?: string[] }>(this.texteReponse(resp));
      for (const i of data.banque || []) {
        const p = parId.get(i);
        if (p && !choisis.includes(p)) choisis.push(p);
      }
      manquants = (data.manquants || []).map((x) => String(x).trim()).filter(Boolean);
    } catch (e) {
      this.logger.warn(`reel proposer visuels : ${e instanceof Error ? e.message : e}`);
    }
    choisis = choisis.slice(0, maximum);
    manquants = manquants.slice(0, Math.max(0, maximum - choisis.length));
    return {
      banque: choisis.map((p) => ({ ...(p.asset as Record<string, unknown>) })),
      a_generer: manquants.map((idee) => ({ idee })),
      banque_vide: !pool.length,
    };
  }

  /** Le prompt d'image complet d'un plan proposé par le casting. Appelé au moment de générer. */
  async promptPourIdee(telegramId: string, idee: string, texte?: string | null): Promise<string | null> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const sujet = `${(texte || '').slice(0, 1200)}\n\nPlan à illustrer : ${idee}`.trim();
    const r = await this.imageService.genererPrompt(telegramId, sujet, 'instagram', false, String(u.style_image || 'auto'));
    return 'error' in r ? null : r.prompt || null;
  }

  private guideStyle(style?: string | null): string {
    return style && style in GUIDES_STYLE ? `\n\n${GUIDES_STYLE[style]}` : '';
  }

  /** Script du template Affiche ; repli heuristique si l'appel échoue. */
  private async scriptAffiche(texte: string, marque: Record<string, unknown>): Promise<{ headline: string; sub: string; features: Array<{ icon: string; texte: string; sous: string }>; stat: string; cta: string }> {
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: ROLE_AFFICHE + this.marqueService.contexteMarqueCourt(marque, { ctas: true }),
        messages: [{ role: 'user', content: `Post :\n\n${texte.slice(0, 4000)}\n\nDonne le JSON.` }],
      });
      this.journalLlm(marque.telegram_id as string, 'reel_script_affiche', resp);
      const data = this.parseJson<{ headline?: string; sub?: string; features?: Array<{ icon?: string; texte?: string; sous?: string }>; stat?: string; cta?: string }>(this.texteReponse(resp));
      const feats = (data.features || []).slice(0, 3).map((f) => ({
        icon: f.icon && ['bolt', 'star', 'shield'].includes(f.icon) ? f.icon : 'bolt',
        texte: String(f.texte || '').slice(0, 60),
        sous: String(f.sous || '').slice(0, 60),
      }));
      if (data.headline && feats.length === 3) {
        return {
          headline: String(data.headline).slice(0, 140),
          sub: String(data.sub || '').slice(0, 160),
          features: feats,
          stat: String(data.stat || '').slice(0, 120),
          cta: String(data.cta || 'Découvrir').slice(0, 32),
        };
      }
    } catch (e) {
      this.logger.warn(`reel affiche script LLM: ${e instanceof Error ? e.message : e}`);
    }
    const phrases = (texte || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    return {
      headline: (phrases[0] || 'Un contenu qui travaille pour toi.').slice(0, 90),
      sub: (phrases[1] || '').slice(0, 120),
      features: [
        { icon: 'bolt', texte: (phrases[2] || 'Simple et rapide').slice(0, 60), sous: '' },
        { icon: 'star', texte: (phrases[3] || 'A ta marque').slice(0, 60), sous: '' },
        { icon: 'shield', texte: (phrases[4] || 'Tu gardes le controle').slice(0, 60), sous: '' },
      ],
      stat: '',
      cta: String(marque.nom || 'Découvrir').slice(0, 32),
    };
  }

  /** Claude condense le post ; repli heuristique si l'appel échoue. */
  private async scriptMotion(texte: string, marque: Record<string, unknown>): Promise<{ plans: PlanMotion[]; cta: string; hook: string }> {
    const ctx = `\n\nMarque : ${marque.nom || ''}. Secteur : ${marque.secteur || ''}. Appels a l'action de la marque : ${marque.ctas || marque.cta || ''}.`;
    try {
      const resp = await this.claude.messagesCreate({
        model: MODELE_SCRIPT,
        max_tokens: 700,
        system: ROLE_MOTION + ctx,
        messages: [{ role: 'user', content: `Post :\n\n${texte.slice(0, 4000)}\n\nDonne le JSON.` }],
      });
      this.journalLlm(marque.telegram_id as string, 'reel_script', resp);
      const data = this.parseJson<{ plans?: Array<Record<string, unknown>>; cta?: string }>(this.texteReponse(resp));
      const plans: PlanMotion[] = [];
      for (const pl of (data.plans || []).slice(0, 6)) {
        const t = sansTiret(String(pl.texte || '').trim()).slice(0, 90);
        if (!t) continue;
        const effet = EFFETS_MOTION.includes(String(pl.effet)) ? String(pl.effet) : 'revele';
        const n = Number(pl.dur);
        const dur = Number.isFinite(n) ? Math.max(1.6, Math.min(4, n)) : 2.6;
        const accents = (Array.isArray(pl.accents) ? pl.accents : []).map((a) => String(a).slice(0, 30)).filter((a) => a.trim()).slice(0, 2);
        const icone = ICONES_MOTION.includes(String(pl.icone)) && effet !== 'geant' ? String(pl.icone) : null;
        plans.push({ texte: t, accents, effet, dur, icone });
      }
      if (plans.length >= 3) {
        return { plans, cta: sansTiret(String(data.cta || marque.nom || '')).slice(0, 40), hook: plans[0].texte.slice(0, 80) };
      }
    } catch (e) {
      this.logger.warn(`motion script LLM: ${e instanceof Error ? e.message : e}`);
    }
    const phrases = (texte || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
    const effets = ['revele', 'surligne', 'revele', 'machine', 'revele'];
    const icones = ['ampoule', 'cible', 'graphique', 'coche', 'fusee'];
    const plans = (phrases.length ? phrases : ['Un message qui compte.']).map((ph, i) => ({ texte: ph.slice(0, 90), accents: [], effet: effets[i % effets.length], dur: 2.6, icone: icones[i % icones.length] }));
    return { plans, cta: String(marque.nom || '').slice(0, 40), hook: plans[0].texte.slice(0, 80) };
  }

  private async scriptDepuisPost(texte: string, marque: Record<string, unknown>, long = false): Promise<{ hook: string; points: string[]; cta: string; contexte?: string; lecon?: string }> {
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: long ? 450 : 300,
        system: (long ? ROLE_LONG : ROLE) + this.marqueService.contexteMarqueCourt(marque, { ctas: true }),
        messages: [{ role: 'user', content: `Post :\n\n${texte.slice(0, 4000)}\n\nDonne le JSON.` }],
      });
      this.journalLlm(marque.telegram_id as string, 'reel_script', resp);
      const data = this.parseJson<{ hook?: string; points?: string[]; cta?: string; contexte?: string; lecon?: string }>(this.texteReponse(resp));
      if (data.hook && Array.isArray(data.points)) {
        const script: { hook: string; points: string[]; cta: string; contexte?: string; lecon?: string } = {
          hook: String(data.hook).slice(0, 120),
          points: data.points.slice(0, 3).map((p) => String(p).slice(0, 80)),
          cta: String(data.cta || 'Suis-nous').slice(0, 40),
        };
        if (!script.points.length) script.points = ['Simple.', 'Rapide.', 'A ta marque.'];
        if (long) {
          script.contexte = String(data.contexte || '').slice(0, 220);
          script.lecon = String(data.lecon || '').slice(0, 140);
        }
        return script;
      }
    } catch (e) {
      this.logger.warn(`reel script LLM: ${e instanceof Error ? e.message : e}`);
    }
    const phrases = (texte || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const script: { hook: string; points: string[]; cta: string; contexte?: string; lecon?: string } = {
      hook: (phrases[0] || 'Un contenu qui travaille pour toi.').slice(0, 120),
      points: phrases.slice(1, 4).map((p) => p.slice(0, 80)),
      cta: String(marque.nom || 'Suis-nous').slice(0, 40),
    };
    if (!script.points.length) script.points = ['Simple.', 'Rapide.', 'A ta marque.'];
    if (long) {
      script.contexte = (phrases[1] || '').slice(0, 220);
      script.lecon = (phrases[phrases.length - 1] || '').slice(0, 140);
    }
    return script;
  }

  private propsMarque(u: Record<string, unknown>, script: { hook: string; points: string[]; cta: string }): { brand: Record<string, unknown>; hook: string; points: string[]; cta: string } {
    return {
      brand: {
        nom: u.nom || u.user_name || 'Ma marque',
        principale: u.couleur_principale || '#5B6CFF',
        accent: u.couleur_accent || '#3AFFA3',
        fond: '#0a0a12',
        logo: u.logo_url || null,
      },
      hook: script.hook,
      points: script.points,
      cta: script.cta,
    };
  }

  /** Props Remotion d'un reel Séquence (100 % JSON, URLs Cloudinary distantes). */
  private async propsSequence(u: Record<string, unknown>, scenario: ReelScenario, telegramId: string): Promise<Record<string, unknown>> {
    return {
      brand: this.propsMarque(u, { hook: '', points: [], cta: '' }).brand,
      segments: scenario.segments.map((sg) => {
        const { image_id, ...rest } = sg;
        return rest;
      }),
      style: scenario.style || 'signature',
      musique: await this.musicLibraryService.urlDe(scenario.musique, telegramId, true),
    };
  }

  /** Poster provisoire pendant le rendu : la première image de plan, sinon rien. */
  private posterSequence(scenario: ReelScenario | null): string | null {
    for (const sg of scenario?.segments || []) {
      if (sg.image) return sg.image;
    }
    return null;
  }

  private async mettreEnFile(
    rowId: string,
    telegramId: string,
    props: Record<string, unknown>,
    composition: string,
    etiquette: string,
    opts: { restaurer?: { video_url?: string | null; video_preview_url?: string | null; reel_data?: unknown }; extra?: Record<string, unknown>; voix?: string | null } = {},
  ): Promise<void> {
    await this.renderQueueService.enqueue(rowId, telegramId, {
      composition,
      props,
      prefix: 'reel',
      etiquette,
      upload: { public_id: `reels/${telegramId}/${rowId}` },
      actionType: 'reel',
      notif: 'reel',
      restaurer: opts.restaurer,
      extra: opts.extra,
      voix: opts.voix,
    });
  }

  /** Répartiteur. montageIa=true (case cochée par le client) ET au moins un clip dans le
   * pool : le scénario est écrit par un modèle qui REGARDE les clips (montage.service).
   * Sinon, ou si le montage échoue, le scénariste texte (Haiku) écrit les textes. */
  private async scenariser(
    texte: string,
    marque: Record<string, unknown>,
    pool: VisuelPool[],
    opts: { brief?: string | null; imposees?: boolean; style?: string | null; avecVoix?: boolean; montageIa?: boolean; depuisScript?: boolean } = {},
  ): Promise<ReelScenario> {
    const { brief, imposees = false, style, avecVoix = false, montageIa = false, depuisScript = false } = opts;
    if (montageIa && pool.some((p) => estClip(p.url))) {
      let sc: ReelScenario | null = null;
      try {
        sc = await this.montageService.scenariser(texte, marque, pool, {
          brief,
          style,
          avecVoix,
          telegramId: marque.telegram_id as string,
          consigneVoix: depuisScript ? CONSIGNE_VOIX_SCRIPT : null,
        });
      } catch (e) {
        this.logger.warn(`reel montage : ${e instanceof Error ? e.message : e}`);
      }
      if (sc) {
        sc.segments = pimenterReveals(sc.segments, (brief || '') + (texte || '').slice(0, 120));
        return sc;
      }
    }
    return this.scriptSequence(texte, marque, pool, { brief, imposees, style, avecVoix, ordreFixe: imposees && !montageIa, depuisScript });
  }

  /** Scénario de séquence ; validation stricte + repli heuristique. */
  private async scriptSequence(
    texte: string,
    marque: Record<string, unknown>,
    pool: VisuelPool[],
    opts: { brief?: string | null; imposees?: boolean; style?: string | null; avecVoix?: boolean; ordreFixe?: boolean; depuisScript?: boolean } = {},
  ): Promise<ReelScenario> {
    const { brief, imposees = false, style, avecVoix = false, ordreFixe = false, depuisScript = false } = opts;
    const ids = new Set(pool.map((p) => p.id));
    const sources = new Map(pool.map((p) => [p.id, p.url]));
    const parId = new Map(pool.map((p) => [p.id, p]));
    const etiquette = (p: VisuelPool): string => {
      if (!estClip(p.url)) return '';
      const m = morceau(p);
      return m ? `[VIDEO CLIP, client-trimmed excerpt of ${(m[1] - m[0]).toFixed(0)} s, used as is] ` : '[VIDEO CLIP] ';
    };
    const liste = pool.length ? pool.map((p) => `- ${p.id} : ${etiquette(p)}${p.desc}`).join('\n') : '(no visual available)';
    const langue = LANGUES[String(marque.langue || 'fr').toLowerCase()] || 'French';
    const role =
      ROLE_SEQUENCE +
      `\n\nCLIENT'S LANGUAGE — write every audience-facing word in ${langue.toUpperCase()}.` +
      (style && style in GUIDES_STYLE ? `\n\n${GUIDES_STYLE[style]}` : '') +
      (depuisScript ? '' : this.marqueService.contexteMarqueCourt(marque, { ctas: true })) +
      (avecVoix ? (depuisScript ? CONSIGNE_VOIX_SCRIPT : CONSIGNE_VOIX) : '');
    let consigne = '';
    if (imposees && pool.length) {
      consigne =
        '\nIMPORTANT: the client picked these visuals himself. You MUST use them ALL, ' +
        'one per image shot, ' +
        (ordreFixe ? 'in EXACTLY this numbered order (img_1 first, then img_2, and so on).' : 'in the order that best serves the narration.');
    }
    let entete = '';
    if (brief) {
      entete = `### CLIENT'S OWN INSTRUCTIONS — FOLLOW THEM TO THE LETTER\n${brief.slice(0, 1500).trim()}\n### end of instructions\n\n`;
      consigne += "\nREMINDER: apply the client's instructions above word for word. If he dictates a sentence, copy it as-is on the shot he asked for.";
    }
    let segments: ReelSegment[] | null = null;
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: avecVoix ? (depuisScript ? 2200 : 1400) : 900,
        system: role,
        messages: [
          {
            role: 'user',
            content: `${entete}${depuisScript ? 'Approved script' : 'Post'}:\n\n${texte.slice(0, 4000)}\n\nAvailable visuals:\n${liste}${consigne}\n\n${depuisScript ? '' : 'Apply the editorial rules of the brand context to every word you write, even if the post above breaks them. '}Return the JSON.`,
          },
        ],
      });
      this.journalLlm(marque.telegram_id as string, 'reel_scenario', resp);
      const data = this.parseJson<{ segments?: Array<Record<string, unknown>> }>(this.texteReponse(resp));
      const segs: ReelSegment[] = [];
      for (const s of (data.segments || []).slice(0, depuisScript ? 10 : 7)) {
        const t = ['typo', 'image', 'cta'].includes(String(s.type)) ? (s.type as string) : 'typo';
        const imgId = s.image_id as string | undefined;
        const seg: ReelSegment = {
          type: t,
          dur: Math.max(2.0, Math.min(4.5, Number(s.dur) || 3)),
          texte: String(s.texte || '').slice(0, 80).trim(),
          accents: (Array.isArray(s.accents) ? s.accents : []).slice(0, 2).map((a) => String(a).slice(0, 30)),
        };
        if (t === 'image') {
          if (imgId && ids.has(imgId)) {
            const src = sources.get(imgId)!;
            if (estClip(src)) this.planVideo(seg, parId.get(imgId)!);
            else seg.image = imgRendu(src);
            seg.image_id = imgId;
            seg.effet = (EFFETS as readonly string[]).includes(String(s.effet)) ? (s.effet as string) : 'zoomIn';
            if (typeof s.reveal === 'string') seg.reveal = s.reveal;
            seg.tilt = [-3, 2, -2, 3][segs.length % 4];
          } else {
            seg.type = 'typo';
          }
        }
        if (t === 'cta') seg.bar = String(s.bar || marque.nom || '').slice(0, 40);
        if (s.label) seg.label = String(s.label).slice(0, 40);
        if (avecVoix) seg.voix_texte = String(s.voix || seg.texte).slice(0, depuisScript ? 400 : 240).trim();
        if (seg.texte) segs.push(seg);
      }
      if (segs.length && segs[segs.length - 1].type !== 'cta') {
        segs.push({
          type: 'cta',
          dur: 3.2,
          texte: (segs[segs.length - 1].texte || 'Suis-nous').slice(0, 40),
          accents: [],
          bar: String(marque.nom || '').slice(0, 40),
          ...(avecVoix ? { voix_texte: (segs[segs.length - 1].texte || 'Suis-nous').slice(0, 40) } : {}),
        });
      }
      if (ordreFixe && pool.length) {
        const plansImage = segs.filter((sg) => sg.type === 'image');
        plansImage.forEach((sg, k) => {
          const v = pool[k % pool.length];
          sg.image_id = v.id;
          delete sg.image;
          delete sg.video;
          delete sg.debut;
          delete sg.fin;
          if (estClip(v.url)) this.planVideo(sg, v);
          else sg.image = imgRendu(v.url);
        });
      }
      if (segs.length >= 4) segments = segs;
    } catch (e) {
      this.logger.warn(`reel sequence script LLM: ${e instanceof Error ? e.message : e}`);
    }
    if (segments === null) {
      // Repli : hook -> visuels -> CTA. Si les visuels sont imposés, TOUS y passent.
      const phrases = (texte || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
      segments = [{ type: 'typo', dur: 2.6, texte: (phrases[0] || 'Un contenu qui travaille pour toi.').slice(0, 70), accents: [] }];
      const visuels = imposees ? pool : pool.slice(0, 1);
      const effets = ['zoomIn', 'panRight', 'zoomOut', 'panLeft'];
      visuels.slice(0, 5).forEach((v, i) => {
        const txt = (phrases[1 + i] || 'Regarde.').slice(0, 60);
        const seg: ReelSegment = { type: 'image', dur: 3.0, texte: txt, accents: [], image_id: v.id, effet: effets[i % 4], tilt: [-3, 2, -2, 3][i % 4] };
        if (estClip(v.url)) this.planVideo(seg, v);
        else seg.image = imgRendu(v.url);
        segments!.push(seg);
      });
      if (!visuels.length) {
        for (const p of phrases.slice(2, 4)) segments.push({ type: 'typo', dur: 2.8, texte: p.slice(0, 70), accents: [] });
      }
      segments.push({ type: 'cta', dur: 3.2, texte: 'On en parle ?', accents: [], bar: String(marque.nom || 'Suis-nous').slice(0, 40) });
    }
    return { recette: 'auto', brief, segments: pimenterReveals(segments, (brief || '') + (texte || '').slice(0, 120)) };
  }

  /** Crée un reel Séquence SANS contenu source : le brief du client est le sujet. */
  async creerReelLibre(
    telegramId: string,
    brief: string,
    opts: { images?: ReelImageInput[] | null; reseau?: string; style?: string | null; musique?: string | null; voix?: string | null; montageIa?: boolean } = {},
  ): Promise<Record<string, unknown> | { error: string }> {
    if (!(brief || '').trim()) return { error: 'Décris ton reel : le brief est le sujet.' };
    const u = await this.marqueService.chargerMarque(telegramId);
    const imgs = (opts.images || []).filter((im) => estVisuel(im.url));
    const st = opts.style && STYLES_SEQUENCE.includes(opts.style) ? opts.style : 'signature';
    let scenario: ReelScenario;
    if (imgs.length) {
      const pool = this.poolDepuisImages(imgs);
      scenario = await this.scenariser(brief, u, pool, { brief, imposees: true, style: st, avecVoix: Boolean(opts.voix), montageIa: opts.montageIa });
    } else {
      scenario = await this.scenariser(brief, u, [], { brief, style: st, avecVoix: Boolean(opts.voix) });
    }
    scenario.style = st;
    scenario.montage_ia = Boolean(opts.montageIa);
    scenario.musique = (await this.musicLibraryService.urlDe(opts.musique, telegramId)) ? opts.musique : null;
    scenario.voix = opts.voix || null;
    const props = await this.propsSequence(u, scenario, telegramId);

    const hook = (scenario.segments[0]?.texte || brief).slice(0, 60);
    const reseau = opts.reseau || 'Instagram';
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre: hook,
      contenu: brief.trim(),
      type: normTypeContenu('Reel'),
      reseau_cible: reseau,
      statut: normStatutContenu('A valider'),
      video_status: 'en_traitement',
      lien_visuel: this.posterSequence(scenario),
      reel_data: scenario,
      created_at: new Date(),
    };
    const creneau = await this.planningService.prochainCreneau(telegramId, reseau, 'Reel');
    if (creneau) row.date_publication = creneau;
    const ins = await this.prisma.contenu.create({ data: row as never });
    const newId = ins.id;
    if (!newId) return { error: 'Création du contenu reel impossible.' };
    try {
      await this.mettreEnFile(newId, telegramId, props, 'ReelSequence', `sequence/${st}`, { voix: opts.voix });
    } catch (e) {
      this.logger.error(`reel libre mise en file: ${e instanceof Error ? e.message : e}`);
      await this.prisma.contenu.delete({ where: { id: newId } });
      return { error: 'Impossible de lancer le rendu, réessaie.' };
    }
    return { id: newId, video_status: 'en_traitement', hook, reseau, date_publication: row.date_publication ?? null };
  }

  /** Re-scénarise et re-rend un reel Séquence EXISTANT (statut A valider) : la vidéo est
   * remplacée sur place (même public_id Cloudinary), pas de doublon. */
  async regenererReel(
    telegramId: string,
    reelId: string,
    opts: { images?: ReelImageInput[] | null; brief?: string | null; style?: string | null; musique?: string | null; voix?: string | null; montageIa?: boolean | null } = {},
  ): Promise<Record<string, unknown> | { error: string }> {
    const cur = await this.prisma.contenu.findFirst({ where: { id: reelId, telegram_id: telegramId } });
    if (!cur) return { error: 'Reel introuvable.' };
    if (cur.type !== normTypeContenu('Reel') || !cur.reel_data) return { error: "Ce contenu n'est pas un reel modifiable." };
    if (!['A_valider', 'Refuse'].includes(String(cur.statut))) return { error: 'Ce reel a déjà été validé : il ne peut plus être modifié.' };
    if (cur.video_status === 'en_traitement') return { error: 'Un rendu de ce reel est déjà en cours.' };

    const texte = cur.contenu || cur.script || cur.titre || '';
    const depuisScript = !(cur.contenu || '').trim() && Boolean((cur.script || '').trim());
    const u = await this.marqueService.chargerMarque(telegramId);
    const oldSc = (cur.reel_data || {}) as unknown as ReelScenario;
    let style = opts.style;
    if (style === undefined || style === null) style = oldSc.style ?? null;
    let musique = opts.musique;
    if (musique === undefined) musique = oldSc.musique ?? null;
    let brief = opts.brief;
    if (brief === undefined) brief = oldSc.brief ?? null;
    let voix = opts.voix;
    if (voix === undefined) voix = oldSc.voix ?? null;
    if (voix === 'none') voix = null;
    let montageIa = opts.montageIa;
    if (montageIa === undefined || montageIa === null) montageIa = Boolean(oldSc.montage_ia);

    let images = opts.images;
    if (images === undefined || images === null) {
      images = [];
      const vus = new Set<string>();
      for (const sg of oldSc.segments || []) {
        let u_: string | undefined;
        let cle: string;
        if (estImageSource(sg.image)) {
          u_ = sg.image;
          cle = `${u_}|null|null`;
        } else if (sg.video) {
          u_ = this.montageService.urlBrute(sg.video);
          cle = `${u_}|${sg.debut ?? ''}|${sg.fin ?? ''}`;
        } else {
          continue;
        }
        if (!vus.has(cle)) {
          vus.add(cle);
          images.push({ url: u_!, desc: null, debut: sg.debut ?? null, fin: sg.fin ?? null });
        }
      }
    }
    const st = style && STYLES_SEQUENCE.includes(style) ? style : 'signature';
    let scenario: ReelScenario;
    if (images.length) {
      const pool = this.poolDepuisImages(images);
      scenario = await this.scenariser(texte, u, pool, { brief, imposees: true, style: st, avecVoix: Boolean(voix), montageIa, depuisScript });
    } else {
      const pool = await this.poolVisuels(telegramId, cur);
      scenario = await this.scenariser(texte, u, pool, { brief, style: st, avecVoix: Boolean(voix), montageIa, depuisScript });
    }
    scenario.style = st;
    scenario.montage_ia = Boolean(montageIa);
    scenario.musique = (await this.musicLibraryService.urlDe(musique, telegramId)) ? musique : null;
    scenario.voix = voix || null;
    const props = await this.propsSequence(u, scenario, telegramId);
    const restaurer = { video_url: cur.video_url, video_preview_url: cur.video_preview_url, reel_data: oldSc };
    try {
      await this.mettreEnFile(reelId, telegramId, props, 'ReelSequence', `sequence/${st}`, {
        restaurer,
        voix,
        extra: { reel_data: scenario, video_url: null, video_preview_url: null },
      });
    } catch (e) {
      this.logger.error(`reel regen mise en file: ${e instanceof Error ? e.message : e}`);
      return { error: 'Impossible de lancer le rendu, réessaie.' };
    }
    return { id: reelId, video_status: 'en_traitement' };
  }

  /** Post -> script (Claude) -> contenu jumeau 'Reel' en rendu en cours -> file de rendu. */
  async genererReel(
    telegramId: string,
    contenuId: string,
    opts: { template?: string; images?: ReelImageInput[] | null; brief?: string | null; style?: string | null; musique?: string | null; voix?: string | null; montageIa?: boolean } = {},
  ): Promise<Record<string, unknown> | { error: string }> {
    const template = opts.template || 'impact';
    if (!(template in TEMPLATES)) return { error: 'Template de reel inconnu.' };
    const cur = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!cur) return { error: 'Contenu introuvable.' };
    const texte = cur.contenu || cur.script || cur.titre || '';
    const depuisScript = !(cur.contenu || '').trim() && Boolean((cur.script || '').trim());
    if (!texte.trim()) return { error: "Ce contenu n'a pas de texte à transformer en reel." };

    const u = await this.marqueService.chargerMarque(telegramId);
    let scenario: ReelScenario | null = null;
    let script: { hook?: string; headline?: string; points?: string[]; cta?: string; contexte?: string; lecon?: string } = {};
    let props: Record<string, unknown>;
    if (template.startsWith('sequence')) {
      let style = opts.style;
      if (style === undefined || style === null) style = TEMPLATES[template]?.style ?? null;
      const st = style && STYLES_SEQUENCE.includes(style) ? style : 'signature';
      if (opts.images && opts.images.length) {
        const pool = this.poolDepuisImages(opts.images.filter((im) => estVisuel(im.url)));
        scenario = await this.scenariser(texte, u, pool, { brief: opts.brief, imposees: true, style: st, avecVoix: Boolean(opts.voix), montageIa: opts.montageIa, depuisScript });
      } else {
        const pool = await this.poolVisuels(telegramId, cur);
        scenario = await this.scenariser(texte, u, pool, { brief: opts.brief, style: st, avecVoix: Boolean(opts.voix), montageIa: opts.montageIa, depuisScript });
      }
      scenario.style = st;
      scenario.montage_ia = Boolean(opts.montageIa);
      scenario.musique = (await this.musicLibraryService.urlDe(opts.musique, telegramId)) ? opts.musique : null;
      scenario.voix = opts.voix || null;
      script = { hook: (scenario.segments[0]?.texte || '').slice(0, 80) };
      props = await this.propsSequence(u, scenario, telegramId);
    } else if (template === 'motion') {
      const m = await this.scriptMotion(texte, u);
      script = { hook: m.hook };
      props = {
        brand: { ...this.propsMarque(u, { hook: '', points: [], cta: '' }).brand, fond: '#020617', police: (u.typo_primaire as string) || null },
        plans: m.plans,
        cta: m.cta,
      };
    } else if (template === 'affiche') {
      script = await this.scriptAffiche(texte, u);
      props = { brand: this.propsMarque(u, { hook: '', points: [], cta: '' }).brand, ...script, image: null };
    } else {
      const long = template === 'long';
      script = await this.scriptDepuisPost(texte, u, long);
      props = this.propsMarque(u, script as { hook: string; points: string[]; cta: string });
      if (long) {
        props.contexte = script.contexte || '';
        props.lecon = script.lecon || '';
      }
    }

    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre: cur.titre || (script.hook || script.headline || '').slice(0, 60),
      contenu: cur.contenu,
      type: normTypeContenu('Reel'),
      reseau_cible: cur.reseau_cible,
      statut: normStatutContenu('A valider'),
      video_status: 'en_traitement',
      lien_visuel: scenario ? this.posterSequence(scenario) : null,
      created_at: new Date(),
    };
    const creneau = await this.planningService.prochainCreneau(telegramId, cur.reseau_cible as string | null, 'Reel');
    if (creneau) row.date_publication = creneau;
    if (scenario) row.reel_data = scenario;
    const ins = await this.prisma.contenu.create({ data: row as never });
    const newId = ins.id;
    if (!newId) return { error: 'Création du contenu reel impossible.' };
    try {
      await this.mettreEnFile(newId, telegramId, props, TEMPLATES[template].composition, template, { voix: scenario ? opts.voix : null });
    } catch (e) {
      this.logger.error(`reel mise en file: ${e instanceof Error ? e.message : e}`);
      await this.prisma.contenu.delete({ where: { id: newId } });
      return { error: 'Impossible de lancer le rendu, réessaie.' };
    }
    return { id: newId, video_status: 'en_traitement', hook: script.hook || script.headline, reseau: row.reseau_cible, date_publication: row.date_publication ?? null };
  }
}
