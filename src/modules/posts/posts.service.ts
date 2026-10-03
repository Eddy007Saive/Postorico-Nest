import { Injectable, Logger } from '@nestjs/common';
import { nettoyerTexteGenere } from '../../common/utils/texte-genere.util';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeService, MODELE_REDACTION } from '../claude/claude.service';
import { DimensionsService, DIM_LABELS } from '../dimensions/dimensions.service';
import { MarqueService } from '../marque/marque.service';
import { MemoireService } from '../memoire/memoire.service';
import { OffersService } from '../offers/offers.service';
import { RedigerPostResult } from './interfaces/rediger-post-result.interface';

/**
 * Agent RÉDACTION (post) — port direct de la partie "rédaction de post" de
 * backend/services/agent_service.py (`rediger_post` et ses aides). La rédaction
 * carrousel/script/gabarit n'est pas dans ce portage.
 */

export { MODELE_REDACTION };

const RESEAUX: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  googlebusiness: 'Google Business',
  twitter: 'X (Twitter)',
};

const ROLE_REDACTION =
  'You are the dedicated copywriter for the personal brand described below. ' +
  'You write EXCLUSIVELY in its voice. You produce a ready-to-publish post: ' +
  "no explanations, no meta-commentary, no 'Here is your post'. " +
  'Answer only with the post text.\n\n';

// Longueur cible par réseau : (cible confortable, limite dure de la plateforme). La cible
// laisse ~10-15% de marge sous la limite pour que Zernio n'ait jamais à refuser une légende.
const LONGUEURS: Record<string, [number, number]> = {
  instagram: [1800, 2200],
  tiktok: [1800, 2200],
  googlebusiness: [1200, 1500],
  twitter: [250, 280],
  linkedin: [2500, 3000],
  facebook: [2500, 60000],
  youtube: [3500, 5000],
};

// Objectifs pour lesquels le contenu s'appuie vraiment sur une offre (logique 80/20 : on ne
// « vend » pas dans un contenu éducatif/notoriété/engagement).
const OBJECTIFS_COMMERCIAUX = new Set(['Conversion', 'Génération de prospects', 'Preuve sociale', 'Fidélisation']);

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly dimensionsService: DimensionsService,
    private readonly offersService: OffersService,
    private readonly memoireService: MemoireService,
    private readonly config: ConfigService,
  ) {}

  private consigneLongueur(reseau: string): string {
    const [cible, limite] = LONGUEURS[reseau] ?? [2500, 3000];
    return (
      ` STRICT LENGTH: ${cible} characters MAXIMUM, spaces and hashtags included ` +
      `(${RESEAUX[reseau] ?? reseau} limit: ${limite}; an over-long post is rejected at publish time).`
    );
  }

  /** Transforme les dimensions d'un sujet en BRIEF injecté dans la rédaction.
   * Vide si aucune dimension exploitable — la rédaction retombe alors sur son
   * comportement d'avant (le sujet seul). */
  private briefDimensions(dims?: Record<string, unknown>): string {
    if (!dims || typeof dims !== 'object') return '';
    const lignes: string[] = [];
    for (const [cle, label] of Object.entries(DIM_LABELS)) {
      const v = this.dimensionsService.validerDimension(cle, dims[cle]);
      if (v) lignes.push(`- ${label} : ${v}`);
    }
    const offre = typeof dims.offre === 'string' ? dims.offre.trim() : '';
    if (offre) lignes.push(`- Offre : ${offre}`);
    if (!lignes.length) return '';
    let txt = `\n\nCONTENT BRIEF (respect its tone and intent):\n${lignes.join('\n')}`;
    // CTA driven by the whole brief: action = objective, tone = angle, audience = target.
    // No fixed table: the model writes the CTA by combining the three (+ the brand's usual CTAs).
    if (this.dimensionsService.validerDimension('objectif', dims.objectif)) {
      txt +=
        '\nEnd with a call to action (CTA) that follows this brief: the objective sets the action, ' +
        "the angle sets the tone, the target sets who you address. Reuse one of the brand's usual CTAs " +
        'if it fits, otherwise write a natural, specific one, never generic.';
    }
    return txt;
  }

  /** Faits d'offre à la rédaction :
   * - si le brief cible UNE offre (dimension « offre ») -> uniquement CETTE offre ;
   * - sinon, si l'objectif est commercial -> repli sur toutes les offres ;
   * - sinon -> rien (contenu orienté valeur, zéro token d'offres). */
  private async blocOffre(telegramId: string, dimensions?: Record<string, unknown>): Promise<string> {
    try {
      const offre = await this.dimensionsService.validerOffre(telegramId, (dimensions ?? {}).offre);
      if (offre) return this.offersService.faitsOffre(telegramId, offre);
      const obj = this.dimensionsService.validerDimension('objectif', (dimensions ?? {}).objectif);
      if (obj && OBJECTIFS_COMMERCIAUX.has(obj)) return this.offersService.contexteOffres(telegramId);
    } catch (e) {
      this.logger.warn(`bloc offre: ${e instanceof Error ? e.message : e}`);
    }
    return '';
  }

  async redigerPost(
    telegramId: string,
    sujet: string,
    reseau = 'linkedin',
    model?: string,
    cache = false,
    dimensions?: Record<string, unknown>,
  ): Promise<RedigerPostResult | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const reseauLabel = RESEAUX[reseau] ?? 'LinkedIn';
    const u = await this.marqueService.chargerMarque(telegramId);
    if (!String(u.secteur ?? '').trim()) return { error: 'profil_incomplet' };
    const contexte = this.marqueService.contexteMarque(u);
    const exemples = String(u[`exemples_${reseau}`] ?? '').trim();
    let extra = '';
    if (exemples) {
      extra =
        `\n\n## CLIENT'S ${reseauLabel} POST EXAMPLES ` +
        `(mimic this style, structure and tone; do not invent a different style)\n\n${exemples}`;
    }
    // Mémoire de voix : les posts VALIDÉS du compte les plus proches du sujet, après les
    // exemples saisis à la main (ceux-ci décrivent le style voulu, ceux-là le style réel).
    extra += await this.memoireService.blocPourGenre(telegramId, sujet, dimensions, 'post', reseau, reseauLabel);

    const resp = await this.claude.messagesCreate({
      model: model || this.config.get<string>('app.claudeModel') || 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: this.claude.system(ROLE_REDACTION, contexte, extra, cache),
      messages: [
        {
          role: 'user',
          content:
            `Write ONE ready-to-publish ${reseauLabel} post on the topic:\n\n"${sujet}"` +
            this.briefDimensions(dimensions) +
            (await this.blocOffre(telegramId, dimensions)) +
            `\n\n${reseauLabel} format: strong hook on the first line, short airy lines, ` +
            'one central idea, and a question / engagement prompt at the end.' +
            this.consigneLongueur(reseau) +
            ' Give only the post text.',
        },
      ],
    });
    return { contenu: nettoyerTexteGenere(this.claude.texte(resp)), usage: this.claude.usage(resp) };
  }

  /** Vision : analyse une photo fournie et écrit un post adapté au réseau, dans la voix de
   * marque — port direct de `rediger_depuis_photo` (backend/services/agent_service.py). */
  async redigerDepuisPhoto(
    telegramId: string,
    imgB64: string,
    mediaType: string,
    reseau = 'linkedin',
    model?: string,
  ): Promise<RedigerPostResult | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    if (!String(u.secteur ?? '').trim()) return { error: 'profil_incomplet' };
    const reseauLabel = RESEAUX[reseau] ?? 'LinkedIn';
    const contexte = this.marqueService.contexteMarque(u);
    const exemples = String(u[`exemples_${reseau}`] ?? '').trim();
    const extra = exemples ? `\n\n## CLIENT'S ${reseauLabel} POST EXAMPLES (mimic this style)\n\n${exemples}` : '';
    const role =
      'You are the dedicated copywriter for the brand below. You are given a PHOTO. ' +
      'Observe what it shows (subject, context, mood, details) and write a ready-to-publish post ' +
      'that BUILDS on this photo, in the brand\'s voice: do not describe the photo flatly, ' +
      'use it as the starting point for a message relevant to the audience. ' +
      'Strong hook, short lines, one idea, an engagement prompt. Give only the post text.\n\n';

    const resp = await this.claude.messagesCreate({
      model: model || this.config.get<string>('app.claudeModel') || 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: role + contexte + extra,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType as Anthropic.Messages.Base64ImageSource['media_type'], data: imgB64 },
            },
            {
              type: 'text',
              text:
                `Write ONE ready-to-publish ${reseauLabel} post from this photo, in the brand's voice.` +
                this.consigneLongueur(reseau) +
                ' Give only the text.',
            },
          ],
        },
      ],
    });
    return { contenu: nettoyerTexteGenere(this.claude.texte(resp)), usage: this.claude.usage(resp) };
  }
}
