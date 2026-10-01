import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { applyFont, AtelierSatureError, CarrouselRenduService, rendre } from '../carrousel/carrousel-rendu.service';
import { parts as carrouselParts } from '../carrousel/templates/common.util';
import { RicoPosesService } from '../carrousel/rico-poses.service';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService, REGLES_ANTI_IA } from '../marque/marque.service';
import { PlanningService } from '../planning/planning.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';
import { QuotaService } from '../quota/quota.service';
import { RenderQueueService } from '../render-queue/render-queue.service';
import {
  buildStoryHtml,
  CANDIDATS_IA,
  CANDIDATS_SERIE,
  DEFAULT_SIGNATURE,
  DSF,
  StoryContent,
  STORY_H,
  STORY_W,
  templateEffectif,
  templateValide,
  TEMPLATES,
} from './story-templates.util';

export { AtelierSatureError } from '../carrousel/carrousel-rendu.service';

/**
 * Story : décline un post en visuel VERTICAL plein écran (1080×1920, format 9:16) prêt
 * pour Instagram/Facebook — port direct de backend/services/story_service.py. HTML brandé
 * -> PNG via Playwright -> Cloudinary. Même philosophie que le carrousel : le HTML des
 * modèles est FIXE, on n'injecte que le contenu + les couleurs et le logo de la marque.
 *
 * Réutilise la même file d'attente Playwright que les carrousels (`rendre`/AtelierSatureError,
 * exportés par carrousel-rendu.service.ts) — un seul atelier de rendu partagé, comme côté Python.
 */

const SERIE_MAX_ECRANS = 6;
const ROLES_SERIE = new Set(['hook', 'problem', 'value', 'interaction', 'revelation', 'solution', 'cta']);
const INTERACTIONS = new Set(['poll', 'quiz', 'question', 'slider', 'none']);

const PROMPT_SERIE = `Tu es un expert en stratégie de contenu Instagram, storytelling et engagement.
Ta mission est de transformer le contenu fourni (un carrousel : hook, slides, CTA, légende) en une séquence de Stories Instagram engageante qui se lit à la suite.

OBJECTIF :
Créer une séquence qui pousse l'utilisateur à regarder les Stories jusqu'à la fin, à réagir lorsque c'est pertinent, puis à effectuer l'action souhaitée.

RÈGLES :
- NE PAS simplement convertir les slides du carrousel une par une.
- Conserver le message, les informations et l'intention du contenu original.
- Reconstruire la narration spécifiquement pour le format Story.
- Chaque Story doit transmettre UNE seule idée principale.
- La première Story doit être un HOOK fort qui donne envie de continuer.
- Introduire une interaction lorsque celle-ci apporte réellement quelque chose au contenu.
- L'interaction doit être naturelle et directement liée au sujet.
- Ne pas utiliser une interaction artificielle uniquement pour en ajouter.
- Alterner contenu, curiosité et interaction pour éviter une séquence monotone.
- Utiliser des textes courts, lisibles en 5 secondes sur mobile.
- Ne jamais inventer de faits, chiffres ou promesses absents du contenu original.
- Terminer par un CTA clair et cohérent avec l'objectif marketing.

TYPES D'INTERACTIONS : poll (2 choix), quiz (2 à 4 réponses, une bonne), question (réponse libre), slider (mesurer une réaction), none.
CHOISIS AUTOMATIQUEMENT LE TYPE LE PLUS PERTINENT.
IMPORTANT : les stickers ne sont PAS cliquables une fois publiés (publication par API). Une interaction est AFFICHÉE comme une question à l'écran et la réponse se fait en DM — écris la question et les choix en conséquence (« Réponds A ou B en DM »).

STRUCTURE RECOMMANDÉE (adapte : entre 4 et {max_ecrans} Stories, jamais de Story inutile pour atteindre un nombre) :
1 HOOK → curiosité, surprise ou identification.
2 PROBLÈME → pourquoi le sujet concerne l'utilisateur.
3 INTERACTION → question qui permet de se positionner.
4 VALEUR → information ou explication.
5 INTERACTION OU RÉVÉLATION → seconde interaction seulement si pertinente.
6 SOLUTION → la réponse, méthode ou conclusion.
Dernière CTA → l'action souhaitée.

RÈGLES POUR LES INTERACTIONS :
- POLL : 2 choix courts, compréhensibles immédiatement.
- QUIZ : 2 à 4 réponses, une seule bonne, déductible du contenu.
- QUESTION : quand la réponse personnelle de l'audience apporte de la valeur ; question simple.
- SLIDER : opinion, émotion ou niveau d'intérêt ; pas de réponse précise attendue.

L'interaction doit être intégrée à la narration.
❌ Mauvais : contenu / contenu / « Êtes-vous d'accord ? » [Oui/Non] / contenu.
✅ Bon : « Tu fais probablement cette erreur sans le savoir… » / « Est-ce que tu fais ça ? » [Oui / Non] / « Si tu as répondu oui, voici pourquoi… » / explication / solution / CTA.

FORMAT DE SORTIE — réponds STRICTEMENT avec ce JSON, rien d'autre :
{{"stories":[{{"story_number":1,"role":"hook|problem|value|interaction|revelation|solution|cta",
"accroche":"4 à 8 mots, sans guillemets — le texte principal de l'écran",
"sous":"UNE phrase de 8 à 14 mots, ou chaîne vide",
"cta":"appel à l'action bref, ou chaîne vide (le dernier écran en a toujours un)",
"slide_image":<index de l'image du carrousel qui illustre le mieux cet écran (0 = couverture, 1..n = slides, n+1 = slide CTA), ou null si aucune>,
"interaction":{{"type":"poll|quiz|question|slider|none","question":"…","options":["…","…"],"correct_answer":null}}}}, …]}}
Pour un écran interaction : accroche = la question (≤ 8 mots), options courtes ; pour les autres : interaction.type = "none".
Voix de marque : {voix}. Secteur : {secteur}.
`;

export interface StoryEcran {
  role: string;
  interaction: { type: string; question?: unknown; options?: unknown; correct_answer?: unknown } | null;
  accroche: string;
  sous: string;
  cta: string;
  image: string | null;
}

@Injectable()
export class StoryService {
  private readonly logger = new Logger(StoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly carrouselRenduService: CarrouselRenduService,
    private readonly ricoPosesService: RicoPosesService,
    private readonly playwrightBrowserService: PlaywrightBrowserService,
    private readonly planningService: PlanningService,
    private readonly quotaService: QuotaService,
    private readonly renderQueueService: RenderQueueService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  templateValide = templateValide;
  templateEffectif = templateEffectif;

  /** Modèles proposables. Sans visuel de post, on masque les modèles qui en ont besoin. */
  templatesStory(aUnVisuel = true) {
    return TEMPLATES.filter((t) => aUnVisuel || !t.image);
  }

  /** Modèles proposés à CE compte : « photo » seulement si le post a un visuel ; « Rico »
   * (maison) seulement si le compte a droit à la mascotte (mêmes comptes que les
   * carrousels Rico). */
  async modelesPour(telegramId: string, aUnVisuel: boolean) {
    let ricoOk = false;
    try {
      const exclusifs = await this.carrouselRenduService.exclusifsDuCompte(telegramId);
      ricoOk = ['rico-studio', 'rico-scene', 'postorico'].some((k) => exclusifs.has(k));
    } catch (e) {
      this.logger.warn(`droits Rico story ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    return TEMPLATES.filter((t) => !(t.image && !aUnVisuel) && !(t.rico && !ricoOk));
  }

  private phrase(txt: string | null | undefined): string {
    let t = (txt || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = t.split(/(?<=[.!?…])\s/);
    let s = (m[0] || t).trim();
    if (s.length > 120) s = s.slice(0, 118).replace(/\s+$/, '') + '…';
    return s;
  }

  private court(t: string | null | undefined, n: number): string {
    const s = (t || '').trim();
    return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+$/, '') + '…';
  }

  /** Dérive {accroche, sous, cta} depuis un post existant. */
  partsDepuisContenu(contenu: { titre?: string | null; contenu?: string | null; lien_visuel?: string | null }): {
    accroche: string;
    sous: string;
    cta: string;
    image: string | null;
  } {
    const titre = (contenu.titre || '').trim();
    const corps = (contenu.contenu || '').trim();
    const hook = titre || this.phrase(corps);
    let sous = titre === '' ? '' : this.phrase(corps);
    if (sous && hook && sous.slice(0, 40).toLowerCase() === hook.slice(0, 40).toLowerCase()) sous = '';
    if (sous && sous.split(/\s+/).filter(Boolean).length < 5) sous = '';
    return { accroche: hook, sous, cta: 'Réponds en DM 👉', image: contenu.lien_visuel || null };
  }

  /** Écrit le TEXTE de la story (accroche + sous-titre + CTA) à partir du post, dans la
   * voix de marque. Retombe sur la dérivation heuristique si l'IA est indisponible. */
  async texteStoryIa(telegramId: string, contenu: { titre?: string | null; contenu?: string | null; lien_visuel?: string | null }) {
    const base = this.partsDepuisContenu(contenu);
    const post = `${contenu.titre || ''}\n\n${contenu.contenu || ''}`.trim();
    if (!this.claude.isConfigured || !post) return base;
    try {
      const u = await this.marqueService.chargerMarque(telegramId);
      const system =
        "Tu écris le TEXTE d'une story Instagram/Facebook à partir d'un post existant. " +
        "Une story = UNE idée, reformulée pour la story — surtout PAS le titre du post recopié.\n" +
        'Donne exactement :\n' +
        '- accroche : très courte et qui claque, 4 à 8 mots, sans guillemets, sans point final ;\n' +
        "- sous : UNE phrase de soutien de 8 à 14 mots, ou chaîne vide si rien d'utile (jamais un fragment de 2-3 mots) ;\n" +
        "- cta : appel à l'action bref adapté à une story (ex. « Réponds en DM », « Écris-moi VOIX »).\n" +
        `Voix de marque : ${u.voix_marque || '—'}. Secteur : ${u.secteur || '—'}.\n` +
        'Réponds STRICTEMENT en JSON : {"accroche": "...", "sous": "...", "cta": "..."}.' +
        REGLES_ANTI_IA +
        this.marqueService.contexteMarqueCourt(u, { secteur: false, voix: false, ecriture: false });
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: `Post :\n\n${post}\n\nÉcris le texte de la story.` }],
      });
      const brut = this.claude.texte(resp);
      const m = /\{[\s\S]*\}/.exec(brut);
      const data = JSON.parse(m ? m[0] : brut) as { accroche?: string; sous?: string; cta?: string };
      const acc = (data.accroche || '').trim().replace(/^"|"$/g, '');
      let sous = (data.sous || '').trim();
      const cta = (data.cta || '').trim();
      if (sous && sous.split(/\s+/).filter(Boolean).length < 4) sous = '';
      return {
        accroche: acc || base.accroche,
        sous,
        cta: cta || base.cta || 'Réponds en DM 👉',
        image: contenu.lien_visuel || null,
      };
    } catch (e) {
      this.logger.warn(`texte story IA ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return base;
    }
  }

  /** Laisse l'IA choisir le GABARIT le plus adapté au contenu (pas seulement le texte). */
  async choisirStoryIa(telegramId: string, contenu: { titre?: string | null; contenu?: string | null; lien_visuel?: string | null }) {
    const aUnVisuel = Boolean(contenu.lien_visuel);
    const defautId = aUnVisuel ? 'photo-flou' : 'epure';
    const base = this.partsDepuisContenu(contenu);
    const baseOut = { ...base, template: defautId, points: null as unknown };
    const post = `${contenu.titre || ''}\n\n${contenu.contenu || ''}`.trim();
    if (!this.claude.isConfigured || !post) return baseOut;
    try {
      const modeles = await this.modelesPour(telegramId, aUnVisuel);
      const candidats = modeles.filter((t) => CANDIDATS_IA.has(t.id));
      if (!candidats.length) return baseOut;
      const catalogue = candidats.map((t) => `- ${t.id} : ${t.hint}`).join('\n');
      const u = await this.marqueService.chargerMarque(telegramId);
      const system =
        'Tu prépares une story Instagram/Facebook (9:16) à partir d\'un post existant. ' +
        'Deux décisions : quel GABARIT convient le mieux à ce contenu, et le texte qui va dedans.\n\n' +
        `Gabarits disponibles :\n${catalogue}\n\n` +
        'Le gabarit texte/photo classique (epure, sombre, editorial, bloc, photo, photo-flou, split) ' +
        "est le choix PAR DÉFAUT — c'est lui qui convient à un post qui développe UNE idée, " +
        "un raisonnement, une anecdote ou un script de Reel, même s'il mentionne plusieurs éléments " +
        'au passage. C\'est le cas la plupart du temps.\n' +
        "N'utilise 'liste' QUE si le post énumère déjà, explicitement et structurellement, 2 à 4 " +
        "éléments séparés du même ordre (des étapes numérotées, une checklist, des options qu'on " +
        'compare). Ne découpe JAMAIS un paragraphe continu ou un raisonnement en puces artificielles ' +
        "pour remplir le gabarit 'liste' — si tu dois inventer des titres de puces qui ne sont pas " +
        "déjà des unités séparées dans le post, ce n'est PAS une liste, choisis un gabarit texte.\n" +
        "N'utilise 'citation' QUE si UNE phrase du post, prise telle quelle mot pour mot, fonctionne " +
        'seule sortie de son contexte comme une punchline complète (pas une phrase tronquée ou ' +
        'réécrite).\n\n' +
        'Réponds STRICTEMENT en JSON, dont les clés dépendent du gabarit choisi :\n' +
        '- texte/photo (epure, sombre, editorial, bloc, photo, photo-flou, split) : ' +
        '{"template":"...", "accroche":"4 à 8 mots, sans guillemets", ' +
        '"sous":"UNE phrase de 8 à 14 mots ou chaîne vide", "cta":"appel à l\'action bref"}\n' +
        '- liste : {"template":"liste", "accroche":"4 à 8 mots", ' +
        '"points":[{"titre":"2 à 4 mots","desc":"5 à 9 mots MAX, jamais une phrase complète"}, ' +
        '... 2 à 4 items], "cta":"appel à l\'action bref"} — desc est un fragment, pas une phrase : ' +
        'la carte est petite, un texte trop long déborde et casse le rendu.\n' +
        '- citation : {"template":"citation", "accroche":"la citation elle-même, mot pour mot, ' +
        'telle qu\'écrite dans le post", "sous":"attribution courte (ex. « Extrait du post »)"}\n' +
        `Voix de marque : ${u.voix_marque || '—'}. Secteur : ${u.secteur || '—'}.` +
        REGLES_ANTI_IA +
        this.marqueService.contexteMarqueCourt(u, { secteur: false, voix: false, ecriture: false });
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: `Post :\n\n${post}\n\nChoisis le gabarit et écris le texte.` }],
      });
      const brut = this.claude.texte(resp);
      const m = /\{[\s\S]*\}/.exec(brut);
      const data = JSON.parse(m ? m[0] : brut) as {
        template?: string;
        accroche?: string;
        sous?: string;
        cta?: string;
        points?: Array<{ titre?: string; desc?: string }>;
      };
      let tpl = (data.template || '').trim().toLowerCase();
      const idsCandidats = new Set(candidats.map((t) => t.id));
      if (!idsCandidats.has(tpl)) tpl = defautId;
      const acc = (data.accroche || '').trim().replace(/^"|"$/g, '') || base.accroche;
      let sous = (data.sous || '').trim();
      const cta = (data.cta || '').trim();
      let points: Array<{ titre: string; desc: string }> | null = null;
      if (tpl === 'liste') {
        const bruts = Array.isArray(data.points) ? data.points : [];
        points = bruts
          .filter((p) => p && (p.titre || '').trim())
          .map((p) => ({ titre: this.court(p.titre, 28), desc: this.court(p.desc, 48) }))
          .slice(0, 4);
        if (points.length < 2) {
          tpl = defautId;
          points = null;
        }
      }
      if (sous && tpl !== 'citation' && sous.split(/\s+/).filter(Boolean).length < 4) sous = '';
      return {
        template: tpl,
        accroche: acc,
        sous: sous || (tpl === defautId ? base.sous : ''),
        cta: cta || base.cta || 'Réponds en DM 👉',
        points,
        image: contenu.lien_visuel || null,
      };
    } catch (e) {
      this.logger.warn(`choix story IA ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return baseOut;
    }
  }

  /** Repli déterministe (IA indisponible / JSON invalide) : hook, 3 premières slides, CTA. */
  private ecransRepliCarrousel(
    hook: string,
    slides: Array<{ titre?: string; texte?: string }>,
    cta: { titre?: string; texte?: string },
    imgs: string[],
    lienVisuel?: string | null,
  ): StoryEcran[] {
    const img = (i: number): string | null => (i >= 0 && i < imgs.length ? imgs[i] : lienVisuel || null);
    const ecrans: StoryEcran[] = [
      { role: 'hook', interaction: null, accroche: this.court(hook, 60), sous: '', cta: '', image: img(0) },
    ];
    slides.slice(0, 3).forEach((s, i) => {
      const acc = (s.titre || this.phrase(s.texte)).trim();
      if (!acc) return;
      ecrans.push({ role: 'value', interaction: null, accroche: this.court(acc, 60), sous: this.court(s.texte || '', 90), cta: '', image: img(1 + i) });
    });
    ecrans.push({
      role: 'cta',
      interaction: null,
      accroche: this.court(cta.titre || 'On en parle ?', 60),
      sous: this.court(cta.texte || '', 90),
      cta: 'Réponds en DM 👉',
      image: img(1 + slides.length),
    });
    return ecrans;
  }

  /** Réécrit un CARROUSEL (contenu.carrousel_data) en série narrative de 4 à maxEcrans
   * stories — hook → problème → question → valeur → solution → CTA. Dégrade sur un repli
   * déterministe, n'échoue jamais (le dialog s'ouvre toujours). */
  async preparerSerieCarrousel(
    telegramId: string,
    cur: { carrousel_data?: unknown; slides_images?: unknown; lien_visuel?: string | null; contenu?: string | null },
    maxEcrans = SERIE_MAX_ECRANS,
  ): Promise<{ format: 'serie'; template: string; ecrans: StoryEcran[] }> {
    const [hook, slides, cta] = carrouselParts(cur.carrousel_data);
    const imgs = (Array.isArray(cur.slides_images) ? cur.slides_images : []) as string[];
    const lienVisuel = cur.lien_visuel;
    const repli = this.ecransRepliCarrousel(hook, slides, cta, imgs, lienVisuel);
    const n = slides.length;
    const img = (idx: unknown): string | null => {
      const i = Number(idx);
      return Number.isFinite(i) && i >= 0 && i < imgs.length ? imgs[i] : null;
    };

    let ecrans: StoryEcran[] | null = null;
    if (this.claude.isConfigured && (hook || slides.length)) {
      try {
        const u = await this.marqueService.chargerMarque(telegramId);
        const lignes: string[] = [`COUVERTURE (image 0) : ${hook}`];
        slides.forEach((s, i) => {
          let extra = '';
          if (s.pills?.length) extra += ` | points : ${s.pills.slice(0, 4).join(', ')}`;
          if (s.pro_tip) extra += ` | astuce : ${s.pro_tip}`;
          lignes.push(`SLIDE ${i + 1} (image ${i + 1}) : ${s.titre || ''} — ${s.texte || ''}${extra}`);
        });
        lignes.push(`CTA (image ${n + 1}) : ${cta.titre || ''} — ${cta.texte || ''}`);
        if (cur.contenu) lignes.push(`LÉGENDE : ${cur.contenu}`);
        const system =
          PROMPT_SERIE.replace('{max_ecrans}', String(maxEcrans)).replace('{voix}', u.voix_marque ? String(u.voix_marque) : '—').replace('{secteur}', u.secteur ? String(u.secteur) : '—') +
          REGLES_ANTI_IA +
          this.marqueService.contexteMarqueCourt(u, { secteur: false, voix: false, ecriture: false });
        const resp = await this.claude.messagesCreate({
          model: 'claude-haiku-4-5',
          max_tokens: 1500,
          system,
          messages: [{ role: 'user', content: `CONTENU SOURCE :\n\n${lignes.join('\n')}\n\nÉcris la séquence de Stories.` }],
        });
        const brut = this.claude.texte(resp);
        const m = /\{[\s\S]*\}/.exec(brut);
        const data = JSON.parse(m ? m[0] : brut) as {
          stories?: Array<{
            accroche?: string;
            role?: string;
            interaction?: { type?: string; question?: string; options?: string[]; correct_answer?: unknown };
            sous?: string;
            cta?: string;
            slide_image?: unknown;
          }>;
        };
        const bruts = Array.isArray(data.stories) ? data.stories : [];
        const out: StoryEcran[] = [];
        for (const e of bruts) {
          if (!e || typeof e !== 'object') continue;
          let acc = (e.accroche || '').trim().replace(/^"|"$/g, '');
          if (!acc) continue;
          let role = (e.role || '').trim().toLowerCase();
          const inter = e.interaction && typeof e.interaction === 'object' ? e.interaction : {};
          let itype = (inter.type || 'none').trim().toLowerCase();
          if (!INTERACTIONS.has(itype)) itype = 'none';
          let sous = (e.sous || '').trim();
          let ctae = (e.cta || '').trim();
          if (itype !== 'none') {
            const q = (inter.question || acc).trim();
            acc = this.court(q, 64);
            const options = (inter.options || []).map((o) => String(o).trim()).filter(Boolean);
            if (['poll', 'quiz'].includes(itype) && options.length) sous = options.slice(0, 4).join(' · ');
            ctae = ctae || 'Réponds en DM 👉';
            role = 'interaction';
          }
          if (!ROLES_SERIE.has(role)) role = 'value';
          if (sous && sous.split(/\s+/).filter(Boolean).length < 4) sous = '';
          out.push({
            role,
            interaction: itype !== 'none' ? { type: itype, question: inter.question, options: inter.options, correct_answer: inter.correct_answer } : null,
            accroche: this.court(acc, 64),
            sous: this.court(sous, 110),
            cta: ctae,
            image: img(e.slide_image),
          });
        }
        const limited = out.slice(0, maxEcrans);
        if (limited.length >= 4) {
          limited[0].role = limited[0].role !== 'value' ? limited[0].role : 'hook';
          if (!limited[limited.length - 1].cta) limited[limited.length - 1].cta = 'Réponds en DM 👉';
          if (!['cta', 'solution'].includes(limited[limited.length - 1].role)) limited[limited.length - 1].role = 'cta';
          ecrans = limited;
        } else {
          this.logger.warn(`serie carrousel IA ${telegramId}: ${limited.length} écran(s) exploitable(s), repli`);
        }
      } catch (e) {
        this.logger.warn(`serie carrousel IA ${telegramId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (ecrans === null) ecrans = repli;
    const aUneImage = ecrans.some((e) => e.image);
    const tpl = aUneImage ? 'photo-flou' : 'epure';
    return { format: 'serie', template: tpl, ecrans };
  }

  /** Un post ne peut avoir qu'UNE story active à la fois (simple/série/animée). Requête
   * live, pas de flag. */
  async aDejaUneStory(telegramId: string, contenuId: string): Promise<boolean> {
    try {
      const r = await this.prisma.contenu.findFirst({ where: { telegram_id: telegramId, story_source_id: contenuId }, select: { id: true } });
      return Boolean(r);
    } catch {
      return false;
    }
  }

  private couleursMarque(u: Record<string, unknown>, colors?: { p?: string; s?: string; a?: string } | null): [string, string, string] {
    const co = colors || {};
    const p = co.p || (u.carrousel_couleur_principale as string) || (u.couleur_principale as string) || '#003D2E';
    const s = co.s || (u.carrousel_couleur_secondaire as string) || (u.couleur_secondaire as string) || '#0077FF';
    const a = co.a || (u.carrousel_couleur_accent as string) || (u.couleur_accent as string) || '#3AFFA3';
    return [p, s, a];
  }

  /** Rendu synchrone d'UNE story -> PNG (bytes). */
  private async renderStoryBytes(
    content: StoryContent,
    p: string,
    s: string,
    a: string,
    nom: string,
    secteur: string,
    template: string,
    logo: string | null,
    font: string | null,
    fontCorps: string | null,
  ): Promise<Buffer> {
    const ricoUrl = template === 'rico' || template === 'signature' ? this.ricoPosesService.url(content.rico_pose || (template === 'rico' ? 'presente-cote' : 'pouce-leve')) : undefined;
    const htmlStr = applyFont(
      buildStoryHtml(content, p, s, a, nom, secteur, template, logo, ricoUrl),
      font,
      fontCorps,
      this.carrouselRenduService.frontendUrl,
    );
    const browser = await this.playwrightBrowserService.launch();
    try {
      const page = await browser.newPage({ viewport: { width: STORY_W, height: STORY_H }, deviceScaleFactor: DSF });
      await page.setContent(htmlStr, { waitUntil: 'load' });
      try {
        await page.waitForSelector('.story', { timeout: 15_000 });
      } catch {
        // silencieux, comme côté Python
      }
      try {
        await page.evaluate("() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))])");
      } catch {
        // silencieux
      }
      await page.waitForTimeout(300);
      try {
        await page.evaluate(`() => {
              var sl = document.querySelector('.story'); if(!sl) return;
              var h = sl.querySelector('h1'); var guard = 0;
              while (sl.scrollHeight > sl.clientHeight + 1 && guard < 140) {
                var c = parseFloat(getComputedStyle(h).fontSize);
                if (c > 20) { h.style.fontSize = (c - 1.5) + 'px'; }
                else {
                  var sub = sl.querySelector('.sous');
                  if (sub) { var cs = parseFloat(getComputedStyle(sub).fontSize); if (cs > 12) { sub.style.fontSize = (cs-1)+'px'; } else break; }
                  else break;
                }
                guard++;
              }
            }`);
      } catch {
        // silencieux
      }
      await page.waitForTimeout(60);
      return await page.locator('.story').screenshot({ type: 'png' });
    } finally {
      await browser.close();
    }
  }

  /** Rend une story 9:16 et l'envoie sur Cloudinary. Renvoie {image, template} (image
   * null si le rendu échoue après 2 essais). */
  async genererStory(
    telegramId: string,
    content: StoryContent,
    template = 'epure',
    colors?: { p?: string; s?: string; a?: string } | null,
    contenuId?: string | null,
    font?: string | null,
    fontCorps?: string | null,
  ): Promise<{ image: string | null; template: string }> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const [p, s, a] = this.couleursMarque(u, colors);
    const nom = (u.nom as string) || (u.username as string) || '';
    const secteur = (u.secteur as string) || '';
    const logo = (u.logo_url as string) || null;
    const fontEff = ((font !== undefined ? font : (u.carrousel_font as string)) || '').trim() || null;
    const fontCorpsEff = ((fontCorps !== undefined ? fontCorps : (u.carrousel_font_corps as string)) || '').trim() || null;
    const tpl = templateValide(template);
    const base = (contenuId || 'tmp').replace(/-/g, '').slice(0, 16);
    for (const attempt of [1, 2]) {
      try {
        const png = await rendre(() => this.renderStoryBytes(content, p, s, a, nom, secteur, tpl, logo, fontEff, fontCorpsEff));
        if (png) {
          const up = await cloudinary.uploader.upload(`data:image/png;base64,${png.toString('base64')}`, {
            resource_type: 'image',
            folder: `stories/${telegramId}`,
            public_id: `${base}_${tpl}`,
            overwrite: true,
          });
          return { image: up.secure_url, template: tpl };
        }
      } catch (e) {
        if (e instanceof AtelierSatureError) throw e;
        this.logger.error(`Story render error (essai ${attempt}): ${e instanceof Error ? e.message : e}`);
      }
    }
    return { image: null, template: tpl };
  }

  /** Crée une SÉRIE de stories (2 à SERIE_MAX_ECRANS écrans) à partir des écrans édités
   * dans le dialog. Statique : chaque écran est rendu ici. Animé : chaque ligne est créée
   * en video_status=en_traitement, rendue ensuite par le worker. */
  async creerSerieStories(
    telegramId: string,
    contenuId: string,
    contents: StoryContent[],
    template: string,
    colors?: { p?: string; s?: string; a?: string } | null,
    anime = false,
  ): Promise<{ ids: string[]; count: number; serie_id: string; date_publication: string | null; video_status?: string } | { error: string; conflict?: boolean; quota?: boolean }> {
    const cur = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!cur) return { error: 'Contenu introuvable.' };
    if (!['Instagram', 'Facebook'].includes(String(cur.reseau_cible))) {
      return { error: 'Les stories ne sont possibles que sur Instagram ou Facebook.' };
    }
    if (await this.aDejaUneStory(telegramId, contenuId)) {
      return { error: 'Ce post a déjà une story. Supprime-la pour en refaire une.', conflict: true };
    }
    const n = contents.length;
    if (n < 2 || n > SERIE_MAX_ECRANS) return { error: `Entre 2 et ${SERIE_MAX_ECRANS} écrans requis.` };

    const extra = n - 1;
    const q = await this.quotaService.consume(telegramId, 'story', extra);
    if (!q.ok) return { error: q.message || 'Quota story épuisé.', quota: true };

    const titreSource = (cur.titre || '').trim();
    const reseau = String(cur.reseau_cible);
    const creneau = await this.planningService.prochainCreneau(telegramId, reseau, 'Story');
    const creneauDt = creneau ? new Date(creneau) : null;

    const ids: string[] = [];
    let premiereDate: string | null = null;
    for (let i = 0; i < contents.length; i++) {
      const content = contents[i];
      let imageUrl: string | null = null;
      if (!anime) {
        try {
          const renderRes = await this.genererStory(telegramId, content, templateEffectif(template, content), colors, `${i}${contenuId}`);
          imageUrl = renderRes.image;
        } catch (e) {
          if (e instanceof AtelierSatureError) break; // rendus saturés : on garde ce qui a déjà été créé
          throw e;
        }
        if (!imageUrl) {
          this.logger.warn(`serie story ecran ${i} rendu echoue, ${telegramId}`);
          continue;
        }
      }
      const row: Record<string, unknown> = {
        telegram_id: telegramId,
        titre: titreSource ? `${titreSource.slice(0, 100)} — écran ${i + 1}/${n}` : `Story ${i + 1}/${n}`,
        contenu: (content.accroche + (content.sous ? ` — ${content.sous}` : '')).trim(),
        lien_visuel: imageUrl || content.image,
        reseau_cible: reseau,
        type: normTypeContenu('Story'),
        statut: normStatutContenu('A valider'),
        serie_id: contenuId,
        story_source_id: contenuId,
        created_at: new Date(),
      };
      if (anime) row.video_status = 'en_traitement';
      if (creneauDt) row.date_publication = new Date(creneauDt.getTime() + 90_000 * i);
      let newId: string | undefined;
      try {
        const ins = await this.prisma.contenu.create({ data: row as never });
        newId = ins.id;
      } catch (e) {
        this.logger.warn(`serie story insert ${telegramId}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!newId) continue;
      if (anime) {
        try {
          await this.enqueueStoryAnimee(newId, telegramId, content.accroche || '', content.sous, content.cta, colors);
        } catch (e) {
          this.logger.error(`serie story anime enqueue ${newId}: ${e instanceof Error ? e.message : e}`);
          await this.prisma.contenu.delete({ where: { id: newId } });
          continue;
        }
      }
      ids.push(newId);
      if (premiereDate === null) premiereDate = (row.date_publication as Date | undefined)?.toISOString() ?? null;
    }

    const rendus = ids.length;
    const aRembourser = Math.min(n - rendus, extra);
    if (aRembourser > 0) await this.quotaService.refund({ ...q, qty: aRembourser });
    if (!ids.length) return { error: 'Le rendu de la série a échoué, réessaie.' };
    if (rendus - 1 > 0) await this.quotaService.confirm({ ...q, qty: rendus - 1 });
    const out: { ids: string[]; count: number; serie_id: string; date_publication: string | null; video_status?: string } = {
      ids,
      count: rendus,
      serie_id: contenuId,
      date_publication: premiereDate,
    };
    if (anime) out.video_status = 'en_traitement';
    return out;
  }

  /** Props du gabarit Remotion « StoryAnime » (charte du compte + texte édité). */
  async propsStoryAnimee(telegramId: string, accroche: string, sous?: string | null, cta?: string | null, colors?: { p?: string; s?: string; a?: string } | null, motAccent?: string | null) {
    const u = await this.marqueService.chargerMarque(telegramId);
    const [p, , a] = this.couleursMarque(u, colors);
    const nom = (u.nom as string) || (u.username as string) || 'Ma marque';
    const logo = (u.logo_url as string) || null;
    return {
      brand: { nom, principale: p, accent: a, fond: '#0b1020', logo },
      accroche: accroche || '',
      motAccent: motAccent || '',
      sous: sous || '',
      cta: cta || '',
    };
  }

  /** Story animée (gabarit StoryAnime) : même schéma d'upload que le rendu synchrone. */
  async enqueueStoryAnimee(rowId: string, telegramId: string, accroche: string, sous?: string | null, cta?: string | null, colors?: { p?: string; s?: string; a?: string } | null): Promise<void> {
    const props = await this.propsStoryAnimee(telegramId, accroche, sous, cta, colors);
    const base = (rowId || 'tmp').replace(/-/g, '').slice(0, 16);
    await this.renderQueueService.enqueue(rowId, telegramId, {
      composition: 'StoryAnime',
      props,
      prefix: 'story_anime',
      etiquette: 'story_anime',
      upload: { folder: `stories/${telegramId}`, public_id: `${base}_anime` },
      actionType: 'story',
      notif: 'story',
    });
  }
}

export { DEFAULT_SIGNATURE, SERIE_MAX_ECRANS, CANDIDATS_SERIE, TEMPLATES as STORY_TEMPLATES };
