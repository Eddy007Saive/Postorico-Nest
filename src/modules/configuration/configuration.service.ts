import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService, MODELE_REDACTION } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';

/** États de la configuration du studio d'un compte (users.studio_config). */
export type EtatStudio = 'seul' | 'equipe' | 'livre';
export const ETATS_STUDIO: EtatStudio[] = ['seul', 'equipe', 'livre'];

/** Questions du formulaire, par rubrique de la fiche de marque qu'elles nourrissent. */
const RUBRIQUES: Record<string, string[]> = {
  identite: ['marque', 'dirigeant', 'site', 'secteur', 'anciennete', 'zone', 'pitch'],
  offre: ['produits', 'valeur', 'diff', 'concurrents', 'histoire', 'position'],
  cible: ['persona', 'douleurs', 'desir', 'objections', 'vocabulaire'],
  voix: ['adresse', 'adjectifs', 'langage', 'emojis', 'phrases', 'personne', 'inspirations_ton'],
  piliers: ['themes', 'reference', 'message', 'opinions'],
  eviter: ['mots_bannis', 'tons_eviter', 'tabous', 'promesses', 'legal'],
  publier: ['hooks_ok', 'cta', 'offres_push', 'bible', 'structure_post', 'cta_nombre', 'hashtags'],
  reseaux: ['plateformes', 'profils', 'frequence', 'creneaux'],
  visuel: ['style_visuel', 'polices', 'inspis_visuel'],
  objectifs: ['objectif', 'succes', 'libre'],
};
const CHAMPS_TEXTE = ['secteur', 'voix_marque', 'audience', 'piliers', 'a_eviter', 'hooks', 'ctas', 'regles'] as const;
const EXEMPLES: Record<string, string> = {
  ex_linkedin_linkedin: 'exemples_linkedin',
  ex_linkedin_instagram: 'exemples_instagram',
  ex_linkedin_facebook: 'exemples_facebook',
  ex_linkedin_tiktok: 'exemples_tiktok',
};
const COULEUR = /^#[0-9a-f]{6}$/i;

/**
 * « Je veux paramétrer seul » : le client remplit le questionnaire de marque dans son compte,
 * et l'IA en tire sa fiche de marque (rien n'est envoyé à l'équipe). Les réponses dictées au
 * micro sont signalées à l'IA : leur façon de parler sert d'exemple de ton.
 * L'ancienne fiche est gardée avec les réponses (brand_audits) pour pouvoir y revenir.
 */
@Injectable()
export class ConfigurationService {
  private readonly logger = new Logger(ConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
  ) {}

  async etat(telegramId: string): Promise<{ etat: EtatStudio | null; le: Date | null }> {
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { studio_config: true, studio_config_le: true } });
    const etat = ETATS_STUDIO.includes(u?.studio_config as EtatStudio) ? (u!.studio_config as EtatStudio) : null;
    return { etat, le: u?.studio_config_le ?? null };
  }

  async poser(telegramId: string, etat: EtatStudio): Promise<void> {
    await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { studio_config: etat, studio_config_le: new Date() } });
  }

  /** Les dernières réponses du client au questionnaire (pour le rouvrir pré-rempli). */
  async dernieresReponses(email: string | null | undefined): Promise<Record<string, unknown> | null> {
    if (!email) return null;
    const row = await this.prisma.brand_audits.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { created_at: 'desc' },
      select: { answers: true },
    });
    if (!row?.answers || typeof row.answers !== 'object') return null;
    const { _fiche_precedente: _ancienne, ...reponses } = row.answers as Record<string, unknown>;
    return reponses;
  }

  /** Comptes dont le studio est entre les mains de l'équipe (vue admin). */
  async studiosEnCours() {
    return this.prisma.users.findMany({
      where: { studio_config: 'equipe' },
      select: { telegram_id: true, nom: true, email: true, studio_config_le: true, created_at: true },
      orderBy: { studio_config_le: 'asc' },
    });
  }

  /** Le texte des réponses, rubrique par rubrique, réponses dictées signalées. */
  static texteReponses(answers: Record<string, unknown>): string {
    const vocal = new Set(Array.isArray(answers._vocal) ? (answers._vocal as unknown[]).map(String) : []);
    const blocs: string[] = [];
    for (const [rubrique, ids] of Object.entries(RUBRIQUES)) {
      const lignes = ids
        .map((id) => {
          const v = answers[id];
          const txt = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v.trim() : '';
          if (!txt) return '';
          return `- ${id}${vocal.has(id) ? ' [SPOKEN ANSWER, transcribed word for word]' : ''}: ${txt.slice(0, 3000)}`;
        })
        .filter(Boolean);
      if (lignes.length) blocs.push(`## ${rubrique}\n${lignes.join('\n')}`);
    }
    return blocs.join('\n\n');
  }

  /** Remplit la fiche de marque à partir des réponses ; renvoie les champs écrits. */
  async configurerDepuisFormulaire(telegramId: string, email: string | null, answers: Record<string, unknown>, recap: string): Promise<string[]> {
    const texte = ConfigurationService.texteReponses(answers);
    if (!texte.trim()) throw new Error('reponses_vides');
    const resp = await this.claude.messagesCreate({
      model: MODELE_REDACTION,
      max_tokens: 4000,
      system:
        'You turn a business owner\'s answers to a brand questionnaire into the brand profile used by an AI that writes their social media posts. ' +
        'Write in the language of the answers. Be concrete and specific to this business, keep their own words when they are telling, never invent facts, ' +
        'numbers, clients or results. Plain text, short lines, no markdown headings, no emojis.\n' +
        'Answers marked [SPOKEN ANSWER] were dictated: they show how the person really talks. Describe that way of talking in "voix_marque" ' +
        '(sentence length, register, tutoiement/vouvoiement, typical expressions) and quote 2 or 3 short phrases from them as examples of their voice.\n' +
        'Return STRICT JSON with these string fields (empty string if the answers say nothing about it):\n' +
        '{"secteur": "one line: what the business does, for whom, where", ' +
        '"voix_marque": "how the brand speaks: address (tu/vous), tone, register, sentence style, emojis, examples of their voice", ' +
        '"audience": "ideal client, their pains, desires, objections, the words they use", ' +
        '"piliers": "3 to 6 content pillars, one per line, as Name: what it covers", ' +
        '"a_eviter": "banned words, tones, taboo topics, promises never to make, legal constraints", ' +
        '"hooks": "hook styles that fit them, one per line", ' +
        '"ctas": "calls to action they use or accept, one per line", ' +
        '"regles": "writing rules: structure, number of CTAs, hashtags, signature habits, anything else to always respect"}',
      messages: [{ role: 'user', content: texte }],
    });
    const brut = this.claude.texte(resp);
    let d: Record<string, unknown> = {};
    try {
      const m = /\{[\s\S]*\}/.exec(brut);
      d = JSON.parse(m ? m[0] : brut);
    } catch {
      throw new Error('synthese_illisible');
    }

    const valeurs: Record<string, unknown> = {};
    for (const c of CHAMPS_TEXTE) {
      const v = typeof d[c] === 'string' ? (d[c] as string).trim() : '';
      if (v) valeurs[c] = v.slice(0, 6000);
    }
    // Ce qui n'a pas besoin d'IA : les exemples de posts tels quels, les couleurs, le logo.
    for (const [cle, champ] of Object.entries(EXEMPLES)) {
      const v = typeof answers[cle] === 'string' ? (answers[cle] as string).trim() : '';
      if (v) valeurs[champ] = v.slice(0, 8000);
    }
    const [c1, c2, c3] = ['col1', 'col2', 'col3'].map((k) => (typeof answers[k] === 'string' && COULEUR.test(answers[k] as string) ? (answers[k] as string) : null));
    if (c1) valeurs.couleur_principale = c1;
    if (c2) valeurs.couleur_secondaire = c2;
    if (c3) valeurs.couleur_accent = c3;
    if (typeof answers.charte === 'string' && /^https:\/\/res\.cloudinary\.com\/.+\.(png|jpe?g|webp|svg)$/i.test(answers.charte)) valeurs.logo_url = answers.charte;
    if (!Object.keys(valeurs).length) throw new Error('synthese_vide');

    // L'ancienne fiche part avec les réponses : on peut revenir en arrière si le client le demande.
    let precedente: Record<string, unknown> = {};
    try {
      precedente = await this.marqueService.fiche(telegramId);
    } catch (e) {
      this.logger.warn(`fiche précédente ${telegramId} illisible: ${e instanceof Error ? e.message : e}`);
    }
    await this.prisma.brand_audits.create({
      data: {
        marque: String(answers.marque || '').trim().slice(0, 200) || null,
        email: (email || '').trim().slice(0, 200) || null,
        answers: { ...answers, _fiche_precedente: precedente } as Prisma.InputJsonValue,
        recap: (recap || '').slice(0, 60000) || null,
        user_agent: 'configuration-compte',
        status: 'traite',
      },
    });
    const ecrits = await this.marqueService.enregistrer(telegramId, valeurs);
    if (!Object.keys(ecrits).length) throw new Error('ecriture_fiche');
    const { etat } = await this.etat(telegramId);
    if (!etat) await this.poser(telegramId, 'seul');
    return Object.keys(ecrits);
  }
}
