import { Injectable } from '@nestjs/common';
import { ClaudeService } from '../claude/claude.service';
import { DimensionsService, DIM_LABELS } from '../dimensions/dimensions.service';
import { MarqueService } from '../marque/marque.service';
import { MemoireService } from '../memoire/memoire.service';
import { OffersService } from '../offers/offers.service';
import { RedigerScriptResult } from './interfaces/rediger-script-result.interface';

/**
 * Agent SCRIPT VIDÉO — port direct de `rediger_script` (backend/services/agent_service.py).
 */

const TYPES_VIDEO: Record<string, string> = {
  Reel: 'Reel Instagram (15-45s, vertical, rythme rapide)',
  Short: 'Short YouTube/TikTok (15-60s, vertical, hook immédiat)',
  Video: 'Vidéo longue (face caméra, structurée)',
  Interview: 'Interview / discussion',
};

const ROLE_SCRIPT =
  'You are a video scriptwriter for the personal brand described below. ' +
  'You write ready-to-shoot, punchy video scripts in the brand\'s voice. ' +
  'Required structure: a very strong HOOK (first 3 seconds), then the BODY ' +
  '(scenes / ideas with the exact words to say), then a final CTA. ' +
  'Answer only with the script.\n\n';

const OBJECTIFS_COMMERCIAUX = new Set(['Conversion', 'Génération de prospects', 'Preuve sociale', 'Fidélisation']);

@Injectable()
export class ScriptService {
  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly dimensionsService: DimensionsService,
    private readonly offersService: OffersService,
    private readonly memoireService: MemoireService,
  ) {}

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
    if (this.dimensionsService.validerDimension('objectif', dims.objectif)) {
      txt +=
        '\nEnd with a call to action (CTA) that follows this brief: the objective sets the action, ' +
        "the angle sets the tone, the target sets who you address. Reuse one of the brand's usual CTAs " +
        'if it fits, otherwise write a natural, specific one, never generic.';
    }
    return txt;
  }

  private async blocOffre(telegramId: string, dimensions?: Record<string, unknown>): Promise<string> {
    try {
      const offre = await this.dimensionsService.validerOffre(telegramId, (dimensions ?? {}).offre);
      if (offre) return this.offersService.faitsOffre(telegramId, offre);
      const obj = this.dimensionsService.validerDimension('objectif', (dimensions ?? {}).objectif);
      if (obj && OBJECTIFS_COMMERCIAUX.has(obj)) return this.offersService.contexteOffres(telegramId);
    } catch {
      // Silencieux : le contenu reste orienté valeur si les offres sont indisponibles.
    }
    return '';
  }

  async redigerScript(
    telegramId: string,
    sujet: string,
    typeVideo = 'Reel',
    model?: string,
    cache = false,
    dimensions?: Record<string, unknown>,
  ): Promise<RedigerScriptResult | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    if (!String(u.secteur ?? '').trim()) return { error: 'profil_incomplet' };
    const contexte = this.marqueService.contexteMarque(u);
    const tv = TYPES_VIDEO[typeVideo] ?? typeVideo;
    // Mémoire de voix : scripts validés proches du sujet (repli : posts validés).
    const extra = await this.memoireService.blocPourGenre(telegramId, sujet, dimensions, 'script');

    const resp = await this.claude.messagesCreate({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: this.claude.system(ROLE_SCRIPT, contexte, extra, cache),
      messages: [
        {
          role: 'user',
          content:
            `Write a "${tv}" video script on the topic:\n\n"${sujet}"` +
            this.briefDimensions(dimensions) +
            (await this.blocOffre(telegramId, dimensions)) +
            '\n\n' +
            'Clear output format:\n' +
            '[HOOK] the first-3-seconds hook\n' +
            '[CORPS] the scenes / ideas with the exact words to say\n' +
            '[CTA] the final call to action\n' +
            'Adapt the length to the format. Give only the script.',
        },
      ],
    });
    return { script: this.claude.texte(resp), usage: this.claude.usage(resp) };
  }
}
