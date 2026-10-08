import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService, MODELE_REDACTION } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { OffersService } from '../offers/offers.service';
import { UsageService } from '../usage/usage.service';
import { Diagnostic, DiagnosticService } from './diagnostic.service';
import { decalerMois, moisParis } from './mois.util';

/**
 * Rico Coach, brique 3 : le plan d'action mensuel.
 *
 * 1. Des RÈGLES (code, sans IA) lisent le diagnostic du mois précédent et décident quoi
 *    recommander, avec des chiffres exacts ; on garde les 4 plus importantes.
 * 2. L'IA (un appel par client et par mois) formule chaque recommandation dans la voix de la
 *    marque et propose des sujets à produire. Chaque nombre d'une phrase IA est vérifié contre
 *    les chiffres de la recommandation ; sinon la phrase standard est gardée.
 *
 * N'écrit que dans plans_mensuels (upsert) ; `ecrire: false` calcule sans écrire.
 */

export const VERSION_PLAN = 1;
const NB_RECOS = 4;
const TOUS = 'tous';
const GBP = 'googlebusiness';

export type GenreAction = 'post' | 'carrousel' | 'reel' | 'story' | 'actualite_google';

export interface Recommandation {
  id: string;
  type: string;
  priorite: number;
  reseau: string | null;
  chiffres: Record<string, number | string>;
  texte_standard: string;
  texte: string;
  action: { genre: GenreAction; reseau: string; quantite: number } | null;
  sujets: string[];
}

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const NOM_RESEAU: Record<string, string> = {
  instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', googlebusiness: 'ta fiche Google', twitter: 'X',
};
const NOM_FORMAT: Record<string, string> = {
  image: 'posts image', carrousel: 'carrousels', reel: 'reels', video: 'vidéos', story: 'stories', texte: 'posts texte', document: 'documents',
};
const GENRE_DE_FORMAT: Record<string, GenreAction> = { carrousel: 'carrousel', reel: 'reel', video: 'reel', story: 'story', image: 'post', texte: 'post', document: 'carrousel' };

const nom = (r: string) => NOM_RESEAU[r] || r;
/** Nombre en français : virgule décimale, une décimale au plus. */
const fr = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
export const nomMois = (mois: string) => MOIS[Number(mois.slice(5, 7)) - 1];

// ---------------------------------------------------------------------------
// Règles (fonctions pures, testées dans plan.service.spec.ts)
// ---------------------------------------------------------------------------

export function reglesPlan(d: Diagnostic): Recommandation[] {
  const recos: Recommandation[] = [];
  const ajouter = (r: Omit<Recommandation, 'texte' | 'sujets'>) => recos.push({ ...r, texte: r.texte_standard, sujets: [] });
  const moisNom = nomMois(d.mois);
  const reseaux = d.evolution.filter((e) => e.reseau !== TOUS);
  const v = d.volume;

  // Aucun réseau social connecté : c'est la seule chose à faire.
  if (!reseaux.length && !d.fiche_google) {
    ajouter({ id: 'connecter', type: 'connecter_reseaux', priorite: 120, reseau: null, chiffres: {}, action: null,
      texte_standard: "Connecte tes réseaux sociaux dans Paramètres : sans eux, je ne peux ni publier pour toi ni mesurer ce qui marche." });
    return recos;
  }

  // Réseau principal : celui qui a le plus d'abonnés (sinon le premier).
  const principal = [...reseaux].sort((a, b) => (b.actuel.abonnes ?? 0) - (a.actuel.abonnes ?? 0))[0]?.reseau ?? 'linkedin';
  const meilleurFormat = (r: string) => d.formats.find((f) => f.reseau === r)?.meilleur?.format;
  const cadence = (r: string) => v.cadences.find((c) => c.reseau === r)?.meilleure_cadence;
  const cible = Math.max(2, Math.round(cadence(principal)?.posts_par_semaine ?? 2));

  if (v.posts === 0) {
    ajouter({ id: 'reprise', type: 'volume_reprise', priorite: 100, reseau: principal, chiffres: { cible },
      action: { genre: GENRE_DE_FORMAT[meilleurFormat(principal) || 'image'] || 'post', reseau: principal, quantite: cible * 4 },
      texte_standard: `Tu n'as rien publié en ${moisNom}. Reprends avec ${cible} publications par semaine sur ${nom(principal)}.` });
  } else if ((v.posts_mois_precedent ?? 0) >= 4 && v.posts <= v.posts_mois_precedent! / 2) {
    ajouter({ id: 'chute', type: 'volume_chute', priorite: 90, reseau: principal, chiffres: { avant: v.posts_mois_precedent!, maintenant: v.posts, cible },
      action: { genre: GENRE_DE_FORMAT[meilleurFormat(principal) || 'image'] || 'post', reseau: principal, quantite: cible * 4 },
      texte_standard: `Tu es passé de ${v.posts_mois_precedent} à ${v.posts} publications en ${moisNom}. Vise ${cible} publications par semaine sur ${nom(principal)}.` });
  } else if (!v.regulier && v.plus_long_silence_jours >= 10) {
    ajouter({ id: 'regularite', type: 'regularite', priorite: 70, reseau: null, chiffres: { silence: v.plus_long_silence_jours, semaines: v.semaines_actives, total: v.semaines_du_mois },
      action: null,
      texte_standard: `Tu as publié ${v.semaines_actives} semaines sur ${v.semaines_du_mois}, avec un silence de ${v.plus_long_silence_jours} jours. Publie au moins une fois chaque semaine.` });
  }

  // Cadence qui a le mieux marché, quand on en est loin (et pas déjà couvert par la reprise / la chute).
  if (!recos.some((r) => r.type === 'volume_reprise' || r.type === 'volume_chute')) {
    for (const c of v.cadences) {
      const m = c.meilleure_cadence;
      if (m.posts_par_semaine >= c.posts_par_semaine_actuel + 1) {
        // Une marche à la fois : +3 publications par semaine au plus, même si la meilleure cadence est loin.
        const visee = Math.min(m.posts_par_semaine, Math.ceil(c.posts_par_semaine_actuel) + 3);
        ajouter({ id: `cadence-${c.reseau}`, type: 'cadence', priorite: 75, reseau: c.reseau,
          chiffres: { meilleure: m.posts_par_semaine, taux: m.taux_engagement, actuel: c.posts_par_semaine_actuel, cible: visee },
          action: { genre: GENRE_DE_FORMAT[meilleurFormat(c.reseau) || 'image'] || 'post', reseau: c.reseau, quantite: visee * 4 },
          texte_standard: `Sur ${nom(c.reseau)}, tes semaines à ${m.posts_par_semaine} publications ont fait ${fr(m.taux_engagement)} % d'engagement. Tu en es à ${fr(c.posts_par_semaine_actuel)} par semaine : monte à ${visee} ce mois-ci.` });
      }
    }
  }

  // Format qui marche nettement mieux.
  for (const f of d.formats) {
    const m = f.meilleur;
    if (!m || (m.fois_plus_que_dernier ?? 0) < 1.5) continue;
    const premier = f.formats.find((x) => x.format === m.format)!;
    const dernier = f.formats.find((x) => x.format === m.dernier)!;
    ajouter({ id: `format-${f.reseau}`, type: 'format', priorite: 80 + Math.min(m.fois_plus_que_dernier!, 5) * 2, reseau: f.reseau,
      chiffres: { ratio: m.fois_plus_que_dernier!, taux: premier.taux_engagement!, taux_dernier: dernier.taux_engagement! },
      action: { genre: GENRE_DE_FORMAT[m.format] || 'post', reseau: f.reseau, quantite: 3 },
      texte_standard: `Sur ${nom(f.reseau)}, tes ${NOM_FORMAT[m.format] || m.format} font ${fr(m.fois_plus_que_dernier!)} fois l'engagement de tes ${NOM_FORMAT[m.dernier] || m.dernier} (${fr(premier.taux_engagement!)} % contre ${fr(dernier.taux_engagement!)} %). Fais-en davantage.` });
  }

  // Fiche Google.
  const g = d.fiche_google;
  if (g) {
    const baisse = Math.min(g.variations.vues_recherche ?? 0, g.variations.appels ?? 0);
    if (baisse <= -20) {
      const cle = (g.variations.vues_recherche ?? 0) <= (g.variations.appels ?? 0) ? 'vues_recherche' : 'appels';
      const lib = cle === 'appels' ? 'tes appels depuis ta fiche Google' : 'les vues de ta fiche Google en recherche';
      ajouter({ id: 'fiche-google', type: 'fiche_google_baisse', priorite: 85, reseau: GBP,
        chiffres: { baisse: Math.abs(g.variations[cle]!), actuel: g.actuel[cle], precedent: g.precedent?.[cle] ?? 0 },
        action: { genre: 'actualite_google', reseau: GBP, quantite: 2 },
        texte_standard: `En ${moisNom}, ${lib} ont baissé de ${fr(Math.abs(g.variations[cle]!))} % (${g.actuel[cle]} contre ${g.precedent?.[cle] ?? 0}). Publie 2 actualités sur ta fiche ce mois-ci.` });
    } else {
      ajouter({ id: 'fiche-google', type: 'fiche_google_entretien', priorite: 40, reseau: GBP,
        chiffres: { appels: g.actuel.appels ?? 0, itineraires: g.actuel.itineraires ?? 0 },
        action: { genre: 'actualite_google', reseau: GBP, quantite: 2 },
        texte_standard: `Ta fiche Google a généré ${g.actuel.appels ?? 0} appels et ${g.actuel.itineraires ?? 0} demandes d'itinéraire en ${moisNom}. Garde le rythme avec 2 actualités ce mois-ci.` });
    }
  }

  // Le post qui a le mieux marché : en refaire un dans la même veine.
  const top = d.top_posts.meilleurs[0];
  if (top && top.taux_engagement !== null) {
    const sujet = top.titre ? `« ${top.titre} »` : `du ${new Date(top.publie_le).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
    ajouter({ id: 'top-post', type: 'top_post', priorite: 60, reseau: top.reseau, chiffres: { taux: top.taux_engagement },
      action: { genre: GENRE_DE_FORMAT[top.format] || 'post', reseau: top.reseau, quantite: 1 },
      texte_standard: `Ton post ${sujet} sur ${nom(top.reseau)} a fait ${fr(top.taux_engagement)} % d'engagement, ton meilleur du mois : refais un contenu dans la même veine.` });
  }

  // Meilleur créneau.
  const c = d.creneaux?.[0];
  if (c) {
    ajouter({ id: 'creneau', type: 'creneau', priorite: 50, reseau: null, chiffres: { heure: c.heure, taux: c.engagement, posts: c.posts }, action: null,
      texte_standard: `Publie le ${JOURS[c.jour]} vers ${c.heure} h : c'est ton créneau le plus engageant (${fr(c.engagement)} % sur ${c.posts} publications).` });
  }

  return recos.sort((a, b) => b.priorite - a.priorite).slice(0, NB_RECOS);
}

const NOMBRE = /\d+(?:[.,]\d+)?/g;
const valeur = (x: string) => Number(x.replace(',', '.'));

/**
 * Garde la phrase IA seulement si chacun de ses nombres est un chiffre de la reco (ou de sa
 * phrase standard) correctement arrondi au nombre de décimales écrit : pour 1,26, « 1,26 »,
 * « 1,3 » et « 1 » passent, « 1,24 » et « 1,2 » non. Les petits entiers (≤ 10) sont tolérés
 * (« 2 posts », « 3 sujets »). Sinon : la phrase standard.
 */
export function phraseSure(texteIa: unknown, reco: Recommandation): string {
  const t = typeof texteIa === 'string' ? texteIa.trim() : '';
  if (!t || t.length > 400) return reco.texte_standard;
  const permis = [
    ...Object.values(reco.chiffres).map(Number).filter(Number.isFinite),
    ...(reco.texte_standard.match(NOMBRE) || []).map(valeur),
  ];
  const sur = (t.match(NOMBRE) || []).every((x) => {
    const n = valeur(x);
    const dec = (x.split(/[.,]/)[1] || '').length;
    const arrondi = (p: number) => Math.round(p * 10 ** dec) / 10 ** dec;
    return (Number.isInteger(n) && n <= 10) || permis.some((p) => Math.abs(arrondi(p) - n) < 1e-9);
  });
  return sur ? t : reco.texte_standard;
}

/** Un sujet trop long est coupé au dernier mot entier, jamais au milieu d'un mot. */
function court(s: string, max = 160): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/\s+\S*$/, '').replace(/[,;:–-]+$/, '')}…`;
}

export function sujetsSurs(sujets: unknown, reco: Recommandation): string[] {
  if (!reco.action || !Array.isArray(sujets)) return [];
  return sujets
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 3)
    .map((s) => court(s.trim()))
    .slice(0, Math.min(3, reco.action.quantite));
}

export function introStandard(mois: string): string {
  return `Salut ! Voici ton plan pour ${nomMois(mois)}, tiré de tes vrais chiffres du mois dernier 👇`;
}

// ---------------------------------------------------------------------------

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly diagnosticService: DiagnosticService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly offersService: OffersService,
    private readonly usageService: UsageService,
  ) {}

  /** Le plan le plus récent d'un client (pour l'app). */
  async dernier(telegramId: string) {
    return this.prisma.plans_mensuels.findFirst({ where: { telegram_id: telegramId }, orderBy: { mois: 'desc' } });
  }

  /** Plan du mois en cours seulement s'il n'existe pas encore (cron quotidien). */
  async planifierSiAbsent(telegramId: string, maintenant = new Date()): Promise<boolean> {
    const mois = moisParis(maintenant);
    const existe = await this.prisma.plans_mensuels.count({ where: { telegram_id: telegramId, mois: new Date(`${mois}T00:00:00Z`) } });
    if (existe) return false;
    const r = await this.planifier(telegramId, { maintenant });
    return r.ok && !!r.ecrit;
  }

  /**
   * @param mois mois du plan, AAAA-MM (défaut : le mois en cours) ; le diagnostic utilisé est
   *             celui du mois précédent.
   * @param ecrire false = test à blanc. @param formuler false = phrases standard, sans IA.
   */
  async planifier(telegramId: string, opts: { mois?: string; ecrire?: boolean; formuler?: boolean; maintenant?: Date } = {}) {
    const ecrire = opts.ecrire !== false;
    const mois = opts.mois && /^\d{4}-\d{2}$/.test(opts.mois) ? `${opts.mois}-01` : moisParis(opts.maintenant ?? new Date());
    const moisDiag = decalerMois(mois, -1);

    const enBase = await this.prisma.diagnostics_mensuels.findUnique({
      where: { telegram_id_mois: { telegram_id: telegramId, mois: new Date(`${moisDiag}T00:00:00Z`) } },
    });
    let diagnostic = enBase?.constats as unknown as Diagnostic | undefined;
    if (!diagnostic) {
      const r = await this.diagnosticService.diagnostiquerClient(telegramId, { mois: moisDiag.slice(0, 7), ecrire });
      if (!r.diagnostic) return { ok: true, ignore: r.ignore || 'aucun_diagnostic' };
      diagnostic = r.diagnostic;
    }

    const recos = reglesPlan(diagnostic);
    let intro = introStandard(mois);
    let modele: string | null = null;
    if (opts.formuler !== false && this.claude.isConfigured && recos.length) {
      try {
        const f = await this.formuler(telegramId, recos, diagnostic, mois);
        intro = f.intro;
        modele = MODELE_REDACTION;
      } catch (e) {
        this.logger.warn(`plan ${telegramId} formulation: ${e instanceof Error ? e.message : e} (phrases standard)`);
      }
    }

    if (ecrire) {
      const moisDate = new Date(`${mois}T00:00:00Z`);
      const data = {
        telegram_id: telegramId, mois: moisDate, diagnostic_mois: new Date(`${moisDiag}T00:00:00Z`), intro,
        recommandations: recos as never, version: VERSION_PLAN, modele, calcule_le: new Date(),
      };
      await this.prisma.plans_mensuels.upsert({ where: { telegram_id_mois: { telegram_id: telegramId, mois: moisDate } }, create: data, update: data });
      this.logger.log(`plan ${telegramId} ${mois} : ${recos.length} recommandations`);
    }
    return { ok: true, ecrit: ecrire, plan: { mois, diagnostic_mois: moisDiag, intro, modele, recommandations: recos } };
  }

  /** Un appel IA : formulation dans la voix de la marque + sujets. Modifie `recos` en place. */
  private async formuler(telegramId: string, recos: Recommandation[], d: Diagnostic, mois: string): Promise<{ intro: string }> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const contexte = this.marqueService.contexteMarque(u, false);
    const offres = await this.offersService.nomsOffres(telegramId, 8).catch(() => '');
    const meilleurs = d.top_posts.meilleurs.filter((p) => p.titre).map((p) => `- « ${p.titre} » (${p.reseau}, ${p.format})`).join('\n');
    const entree = recos.map((r) => ({ id: r.id, phrase: r.texte_standard, chiffres: r.chiffres, action: r.action }));

    const role =
      "You are Rico, the coach mascot of Postorico. You present a client's monthly action plan, in FRENCH, " +
      "speaking to the client with 'tu', warm and direct, in the client's brand voice. You never give generic advice: " +
      'every recommendation is already decided and backed by the client\'s real numbers.\n' +
      'RULES:\n' +
      '- Rewrite each recommendation in 1 or 2 short sentences. Keep its meaning and its action. ' +
      'Use ONLY the numbers given in its "phrase" or "chiffres"; never add, round differently or invent a number.\n' +
      '- For each recommendation that has an "action", propose up to min(3, quantite) concrete SUBJECTS to produce ' +
      '(one line each, a topic of 15 words at most, not a full post), fitting the brand, its offers and in the spirit of the best posts.\n' +
      '- "intro": one short friendly sentence (no numbers) introducing the plan of the month.\n' +
      'Answer ONLY with valid JSON: {"intro":"...","recommandations":[{"id":"...","texte":"...","sujets":["..."]}]}\n\n';
    const resp = await this.claude.messagesCreate({
      model: MODELE_REDACTION,
      max_tokens: 1500,
      system: this.claude.system(role, contexte),
      messages: [{
        role: 'user',
        content:
          `Plan for ${nomMois(mois)}.\n` +
          (offres ? `Active offers:\n${offres}\n` : '') +
          (meilleurs ? `Best posts last month:\n${meilleurs}\n` : '') +
          `Recommendations (JSON):\n${JSON.stringify(entree)}`,
      }],
    });
    void this.usageService.log(telegramId, 'coach_plan', MODELE_REDACTION, this.claude.usage(resp), 0);

    let txt = this.claude.texte(resp);
    if (txt.includes('{')) txt = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const data = JSON.parse(txt) as { intro?: unknown; recommandations?: Array<{ id?: unknown; texte?: unknown; sujets?: unknown }> };
    for (const r of recos) {
      const ia = (data.recommandations || []).find((x) => x.id === r.id);
      r.texte = phraseSure(ia?.texte, r);
      r.sujets = sujetsSurs(ia?.sujets, r);
    }
    const intro = typeof data.intro === 'string' && data.intro.trim() && !/\d/.test(data.intro) ? data.intro.trim().slice(0, 300) : introStandard(mois);
    return { intro };
  }
}
