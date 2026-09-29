import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../claude/claude.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { MarqueService } from '../marque/marque.service';
import { MemoireService } from '../memoire/memoire.service';
import { OffersService } from '../offers/offers.service';
import { LlmUsage } from '../usage/interfaces/llm-usage.interface';
import { CarrouselContent } from './interfaces/carrousel-content.interface';

/**
 * Agent CARROUSEL (texte des slides) — port direct de `rediger_carrousel`
 * (backend/services/agent_service.py). Le rendu visuel Playwright vit dans
 * carrousel-rendu.service.ts.
 */

// Icônes 3D disponibles (clé -> thème) pour illustrer les slides.
export const ICON_HINTS: Record<string, string> = {
  chart: 'croissance/données', bars: 'stats/chiffres', money: 'argent/revenus', cash: 'cash/flux',
  brain: 'réflexion/stratégie', idea: 'idée/insight', rocket: 'scale/croissance rapide', gem: 'valeur',
  trophy: 'réussite/résultat', briefcase: 'business/pro', handshake: 'vente/partenariat', gear: 'process/système',
  search: 'analyse/audit', clock: 'temps/urgence', hourglass: 'temps qui file', fire: 'urgence/hot',
  bolt: 'énergie/rapidité', megaphone: 'marketing/communication', key: 'clé/solution', lock: 'sécurité',
  calendar: 'planning/régularité', check: 'validation/checklist', warning: 'erreur/risque', package: 'produit/offre',
  cart: 'ventes/e-commerce', phone: 'mobile/digital', laptop: 'outil/digital', people: 'équipe/audience',
  star: 'excellence', crown: 'premium/leader', shield: 'protection/fiabilité',
};

const ROLE_CARROUSEL =
  'You create CAROUSELS for the personal brand described below, in its voice. ' +
  'Structure: a HOOK (very short scroll-stopping line), STEPS/IDEAS (one strong idea each), ' +
  "and a final CTA. Each idea has a VERY short title (2-5 words, headline style), 1-2 explanatory " +
  "sentences, 2-4 keywords (pills), a 'pro_tip' (one concrete piece of advice) and an 'icon' " +
  '(the most relevant illustration keyword from this list: ' +
  Object.keys(ICON_HINTS).join(', ') +
  '). Short, punchy text, readable on a slide. ' +
  "The 'legende' is the POST TEXT (the caption above the carousel): SHORT (2 to 4 lines). " +
  'A scroll-stopping hook + an invitation to swipe/save + ONE single CTA. It does NOT repeat ' +
  "the slides' content; the carousel carries the substance, the caption only hooks. " +
  'You may end with 2 to 4 targeted hashtags. ' +
  'Answer ONLY with valid JSON of this shape:\n' +
  '{"hook":"...","legende":"...","slides":[{"titre":"...","texte":"...","pills":["..",".."],"pro_tip":"...","icon":"chart"}],' +
  '"cta":{"titre":"...","texte":"..."}}\n\n';

@Injectable()
export class CarrouselTexteService {
  private readonly logger = new Logger(CarrouselTexteService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly dimensionsService: DimensionsService,
    private readonly offersService: OffersService,
    private readonly memoireService: MemoireService,
  ) {}

  private briefDimensions(dims?: Record<string, unknown>): string {
    if (!dims || typeof dims !== 'object') return '';
    const DIM_LABELS: Record<string, string> = { objectif: 'Objective', angle: 'Angle', cible: 'Target', format: 'Format' };
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
    const OBJECTIFS_COMMERCIAUX = new Set(['Conversion', 'Génération de prospects', 'Preuve sociale', 'Fidélisation']);
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

  async redigerCarrousel(
    telegramId: string,
    sujet: string,
    nbSlides = 5,
    model?: string,
    cache = false,
    dimensions?: Record<string, unknown>,
  ): Promise<{ content: CarrouselContent; usage: LlmUsage } | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const u = await this.marqueService.chargerMarque(telegramId);
    if (!String(u.secteur ?? '').trim()) return { error: 'profil_incomplet' };
    const contexte = this.marqueService.contexteMarque(u);
    const nbIdees = Math.max(1, nbSlides - 2); // hook + idées + cta
    // Mémoire de voix : carrousels validés proches du sujet (repli : posts validés).
    const extra = await this.memoireService.blocPourGenre(telegramId, sujet, dimensions, 'carrousel');

    const resp = await this.claude.messagesCreate({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 1600,
      system: this.claude.system(ROLE_CARROUSEL, contexte, extra, cache),
      messages: [
        {
          role: 'user',
          content:
            `Carousel topic: "${sujet}".` +
            this.briefDimensions(dimensions) +
            (await this.blocOffre(telegramId, dimensions)) +
            '\n' +
            `Give the hook, the legende (short: hook + swipe invitation + 1 CTA, without repeating the slides), ` +
            `EXACTLY ${nbIdees} ideas (with short titre, texte, pills, pro_tip) and the cta, as JSON.`,
        },
      ],
    });

    let txt = this.claude.texte(resp);
    if (txt.includes('{') && txt.includes('}')) {
      txt = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      this.logger.error(`carrousel parse error: ${e instanceof Error ? e.message : e} | ${txt.slice(0, 200)}`);
      return { error: 'parse' };
    }

    const cleanSlide = (s: Record<string, unknown>) => {
      const rawPills = s.pills;
      const pills: unknown[] = typeof rawPills === 'string' ? [rawPills] : Array.isArray(rawPills) ? rawPills : [];
      const icon = String(s.icon ?? '').trim().toLowerCase();
      return {
        titre: String(s.titre ?? '').trim(),
        texte: String(s.texte ?? '').trim(),
        pills: pills.map((p) => String(p).trim()).filter(Boolean).slice(0, 4),
        pro_tip: String(s.pro_tip ?? s.protip ?? '').trim(),
        icon: icon in ICON_HINTS ? icon : '',
      };
    };

    const slidesRaw = Array.isArray(data.slides) ? (data.slides as Array<Record<string, unknown>>) : [];
    const slides = slidesRaw
      .filter((s) => s.titre || s.texte)
      .map(cleanSlide)
      .slice(0, nbIdees);

    let cta = data.cta as Record<string, unknown> | string | undefined;
    if (typeof cta === 'string') cta = { titre: cta, texte: '' };
    const ctaObj = (cta ?? {}) as Record<string, unknown>;

    const content: CarrouselContent = {
      hook: String(data.hook ?? '').trim(),
      legende: String(data.legende ?? '').trim(),
      slides,
      cta: {
        titre: String(ctaObj.titre ?? 'On en parle ?').trim() || 'On en parle ?',
        texte: String(ctaObj.texte ?? '').trim(),
      },
    };
    if (!content.hook && !slides.length) return { error: 'parse' };
    return { content, usage: this.claude.usage(resp) };
  }
}
