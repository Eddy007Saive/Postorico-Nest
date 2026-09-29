import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService } from '../claude/claude.service';
import { DIM_LABELS, DIMENSIONS, DimensionsService } from '../dimensions/dimensions.service';
import { MarqueService } from '../marque/marque.service';
import { OffersService } from '../offers/offers.service';
import { LlmUsage } from '../usage/interfaces/llm-usage.interface';
import { SujetGenere } from './interfaces/sujet-genere.interface';

/**
 * Agent SUJETS — port direct de la partie "génération de sujets" de
 * backend/services/agent_service.py (`generer_sujets` et ses aides).
 */

// Les sujets sont des idées jetables -> Haiku suffit (3x moins cher que Sonnet).
export const SUJETS_MODEL = 'claude-haiku-4-5';

const ROLE_SUJETS =
  'You are a content strategist for the personal brand described below. ' +
  'You propose post topic ideas relevant to its sector and audience.\n\n';

@Injectable()
export class SujetsService {
  private readonly logger = new Logger(SujetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly dimensionsService: DimensionsService,
    private readonly offersService: OffersService,
  ) {}

  private async offresListeCourte(telegramId: string): Promise<string> {
    try {
      return await this.offersService.nomsOffres(telegramId);
    } catch (e) {
      this.logger.warn(`offres liste courte: ${e instanceof Error ? e.message : e}`);
      return '';
    }
  }

  /** Normalise un titre pour comparer (minuscules, sans accents, alphanumérique). */
  private norm(s: string): string {
    const nfd = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const spaced = nfd.replace(/[^a-z0-9]+/g, ' ');
    return spaced.split(/\s+/).filter(Boolean).join(' ');
  }

  /** Voix Postorico : aucun tiret cadratin/demi-cadratin. */
  private sansTiret(txt: string): string {
    if (typeof txt !== 'string') return txt;
    let t = txt
      .replace(/ — /g, ', ')
      .replace(/ – /g, ', ')
      .replace(/ —/g, ', ')
      .replace(/ –/g, ', ')
      .replace(/— /g, ', ')
      .replace(/– /g, ', ')
      .replace(/—/g, ', ')
      .replace(/–/g, ', ');
    while (t.includes('  ')) t = t.replace(/ {2}/g, ' ');
    return t
      .replace(/ ,/g, ',')
      .replace(/,,/g, ',')
      .replace(/^[ ,]+|[ ,]+$/g, '');
  }

  /** Titres des sujets déjà proposés (brouillons) ou publiés (contenu), récents d'abord.
   * Sert de MÉMOIRE anti-répétition : réinjectée dans le prompt et filtrée en sortie. */
  private async sujetsHistorique(telegramId: string, limit = 60): Promise<string[]> {
    const titres: string[] = [];
    try {
      const rows = await this.prisma.brouillons.findMany({
        where: { telegram_id: telegramId },
        orderBy: { created_at: 'desc' },
        take: limit,
        select: { titre: true },
      });
      for (const r of rows) if (r.titre) titres.push(r.titre);
    } catch (e) {
      this.logger.warn(`historique brouillons: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const rows = await this.prisma.contenu.findMany({
        where: { telegram_id: telegramId },
        orderBy: { created_at: 'desc' },
        take: limit,
        select: { titre: true },
      });
      for (const r of rows) if (r.titre) titres.push(r.titre);
    } catch (e) {
      this.logger.warn(`historique contenu: ${e instanceof Error ? e.message : e}`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of titres) {
      const k = this.norm(t);
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(t.trim());
      }
    }
    return out;
  }

  /** Propose des sujets TAGGÉS (objectif/angle/cible/format), pas une liste plate.
   * `filtres` : dimensions imposées par l'utilisateur (ex. {objectif:'Conversion',
   * format:'Reel'}) ; celles laissées libres sont variées automatiquement. */
  async genererSujets(
    telegramId: string,
    nombre = 6,
    filtresIn?: Record<string, unknown>,
  ): Promise<{ sujets: SujetGenere[]; usage: LlmUsage } | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    if (!String(u.secteur ?? '').trim()) return { error: 'profil_incomplet' };
    const contexte = this.marqueService.contexteMarque(u);

    // Mémoire anti-boucle : sujets déjà vus (à éviter dans le prompt + filtrer en sortie)
    const historique = await this.sujetsHistorique(telegramId);
    let consigne = '';
    if (historique.length) {
      const deja = historique
        .slice(0, 20)
        .map((t) => `- ${t}`)
        .join('\n'); // petite liste = coût négligeable
      consigne =
        `\n\nTopics ALREADY proposed or published for this brand. You must NOT repeat them, ` +
        `rephrase them, or propose simple variants:\n${deja}\n` +
        `Propose genuinely new angles, different from this list.`;
    }

    // Formats limités aux réseaux connectés (pas de Reel si aucun compte adapté).
    const formatsOk = await this.dimensionsService.formatsDisponibles(telegramId);

    // Dimensions : imposées par l'utilisateur (filtres) OU variées par l'IA pour la diversité.
    const filtreOffre = await this.dimensionsService.validerOffre(telegramId, (filtresIn ?? {}).offre);
    const filtres: Record<string, string> = {};
    for (const cle of Object.keys(DIMENSIONS)) {
      const v = this.dimensionsService.validerDimension(cle, (filtresIn ?? {})[cle]);
      if (v) filtres[cle] = v;
    }
    const contraintes: string[] = [];
    for (const [cle, label] of Object.entries(DIM_LABELS)) {
      const valeurs = cle === 'format' ? formatsOk : DIMENSIONS[cle];
      if (filtres[cle]) {
        contraintes.push(`${label} = "${filtres[cle]}" for ALL topics (imposed).`);
      } else {
        contraintes.push(`${label}: pick ONE from [${valeurs.join(', ')}], varying it from one topic to the next.`);
      }
    }
    const menu = contraintes.map((c) => `- ${c}`).join('\n');

    // Offres du client (liste courte) : sujets COMMERCIAUX pertinents, sans imposer la vente
    // aux sujets éducatifs/notoriété (logique 80/20).
    const offresCourt = await this.offresListeCourte(telegramId);
    let hintOffres = '';
    if (offresCourt) {
      hintOffres =
        '\n\nThe client\'s offers (products/services):\n' +
        offresCourt +
        '\nAdd an "offre" field to each topic: for a COMMERCIAL topic (objective Conversion or ' +
        'Génération de prospects), set "offre" to the EXACT name of the most relevant offer from ' +
        'the list above; for educational / awareness / engagement topics, set "offre" to an empty ' +
        'string "" (stay value-first, do NOT push an offer).';
      if (filtreOffre) {
        hintOffres += `\nIMPORTANT: every topic must target the offer "${filtreOffre}" (set "offre" to it).`;
      }
    }

    // On demande quelques sujets de rab : après filtrage des doublons, il en reste assez.
    const demande = nombre + 4;
    const resp = await this.claude.messagesCreate({
      model: SUJETS_MODEL,
      max_tokens: 2600,
      system: ROLE_SUJETS + contexte,
      messages: [
        {
          role: 'user',
          content:
            `Propose ${demande} content topic ideas for this brand. Each topic is an actionable ` +
            `BRIEF described by 4 dimensions:\n${menu}\n\n` +
            `Answer ONLY with a JSON array (no surrounding text), one object per topic:\n` +
            `[{"sujet":"…","objectif":"…","angle":"…","cible":"…","format":"…","offre":"…"}]\n` +
            `"sujet" = a concrete, catchy hook (not a vague theme), written in the output language. ` +
            `The other fields take EXACTLY one value from the lists above.` +
            consigne +
            hintOffres,
        },
      ],
    });

    const texte = this.claude.texte(resp);
    let brut: Array<Record<string, unknown>> = [];
    try {
      const start = texte.indexOf('[');
      const end = texte.lastIndexOf(']');
      if (start === -1 || end === -1) throw new Error('no_array');
      const parsed: unknown = JSON.parse(texte.slice(start, end + 1));
      if (!Array.isArray(parsed)) throw new Error('not_array');
      brut = parsed as Array<Record<string, unknown>>;
    } catch (e) {
      // Le tableau entier est illisible (souvent : coupé par max_tokens en plein milieu d'un
      // objet). Plutôt que d'afficher le JSON brut ligne par ligne au client, on récupère un
      // par un les objets COMPLETS qu'on trouve — le dernier objet tronqué est perdu.
      this.logger.warn(
        `sujets JSON illisible (${e instanceof Error ? e.message : e}, stop_reason=${resp.stop_reason}) — récupération objet par objet`,
      );
      brut = [];
      const re = /\{[^{}]*\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(texte))) {
        try {
          brut.push(JSON.parse(m[0]));
        } catch {
          continue;
        }
      }
      if (!brut.length) {
        this.logger.warn('sujets : aucun objet récupérable — repli liste plate');
        brut = texte
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => ({ sujet: l.replace(/^[\s\-•\t0-9.]+/, '').trim() }));
      }
    }

    // Filtre anti-doublon : vs l'historique ET entre eux (sécurité si le modèle répète)
    const existants = new Set(historique.map((t) => this.norm(t)));
    const seen = new Set<string>();
    const uniques: SujetGenere[] = [];
    for (const o of brut) {
      const isObj = typeof o === 'object' && o !== null;
      const rawS = isObj ? (o as Record<string, unknown>).sujet : String(o ?? '');
      const s = this.sansTiret(String(rawS ?? '').trim());
      const k = this.norm(s);
      if (!k || existants.has(k) || seen.has(k)) continue;
      seen.add(k);
      const d = isObj ? (o as Record<string, unknown>) : {};
      uniques.push({
        sujet: s,
        objectif: filtres.objectif || this.dimensionsService.validerDimension('objectif', d.objectif),
        angle: filtres.angle || this.dimensionsService.validerDimension('angle', d.angle),
        cible: filtres.cible || this.dimensionsService.validerDimension('cible', d.cible),
        format: filtres.format || this.dimensionsService.validerFormat(d.format, formatsOk),
        offre: filtreOffre || (await this.dimensionsService.validerOffre(telegramId, d.offre)),
      });
    }
    return { sujets: uniques.slice(0, nombre), usage: this.claude.usage(resp) };
  }
}
