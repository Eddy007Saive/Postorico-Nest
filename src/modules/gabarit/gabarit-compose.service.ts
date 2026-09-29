import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { LlmUsage } from '../usage/interfaces/llm-usage.interface';
import { SAMPLES, Slots, TitleLine } from './templates/gabarit-builders';

/**
 * Agent GABARIT (texte) — port direct de `composer_gabarit` (backend/services/agent_service.py) :
 * à partir du texte d'un post, écrit les champs texte du gabarit choisi (titre/eyebrow/
 * citation/etc.) et les pose sur les défauts structurels du gabarit (SAMPLES).
 */

const ROLE_GABARIT =
  'Tu transformes un post en VISUEL court et percutant pour un feed social. ' +
  'Tu écris dans la voix de la marque ci-dessous. ' +
  'IMPORTANT : le contenu (titre, accroche, citation, chiffres...) doit être condensé ' +
  "STRICTEMENT à partir du texte du post fourni par l'utilisateur, jamais inventé ni tiré " +
  "d'un autre sujet — même si la voix de marque mentionne d'autres exemples ou thèmes. " +
  'Réponds UNIQUEMENT en JSON valide, sans texte autour.\n\n';

// Pour chaque gabarit : (description du JSON à produire, liste des champs à appliquer sur les défauts).
const GAB_SPECS: Record<string, [string, string[]]> = {
  statement: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"LIGNE COURTE MAJUSCULES","c":"a (optionnel)"}],"subtitle":"phrase courte"} ' +
      '— title_lines = 3 à 4 lignes de max 3 mots, marque 1-2 lignes avec "c":"a".',
    ['eyebrow', 'title_lines', 'subtitle'],
  ],
  split: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"LIGNE COURTE MAJUSCULES","c":"a (optionnel)"}],"subtitle":"phrase courte"} ' +
      '— title_lines = 3 lignes courtes, marque 1 ligne avec "c":"a".',
    ['eyebrow', 'title_lines', 'subtitle'],
  ],
  acquisition: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"v (optionnel)"}],"stats":[{"k":"libellé","n":"valeur","v":true}]} ' +
      '— title_lines = 2-3 lignes ; stats = 4 (chiffres du post, sinon "n":"—", jamais de faux chiffres).',
    ['eyebrow', 'title_lines', 'stats'],
  ],
  citation: [
    '{"label":"Témoignage","quote_lines":[{"t":"ligne courte","c":"v sur la dernière"}]} ' +
      '— quote_lines = 2-3 lignes, une citation percutante tirée du post.',
    ['label', 'quote_lines'],
  ],
  dashboard: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"v (optionnel)"}]} — title_lines = 3 lignes.',
    ['eyebrow', 'title_lines'],
  ],
  features: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"a (optionnel)"}],"features":[{"t":"titre court","d":"phrase"}]} ' +
      '— title_lines = 2-3 lignes ; features = EXACTEMENT 3.',
    ['eyebrow', 'title_lines', 'features'],
  ],
  phone: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"COURT","c":"v (optionnel)"}],"subtitle":"phrase courte","bubbles":[{"side":"in|out","t":"message court"}]} ' +
      "— bubbles = 3 à 4 messages d'une conversation client réaliste.",
    ['eyebrow', 'title_lines', 'subtitle', 'bubbles'],
  ],
  services: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"a (optionnel)"}],"services":["mot","mot"],"flow":["Étape début","Étape fin"]} ' +
      '— title_lines = 2 lignes ; services = 4 mots ; flow = 2 étapes.',
    ['eyebrow', 'title_lines', 'services', 'flow'],
  ],
  mission: [
    '{"label":"Notre mission","title_lines":[{"t":"MAJUSCULES","c":"v (optionnel)"}],"subtitle":"phrase","statrow":[{"n":"valeur","k":"libellé"}]} ' +
      '— title_lines = 2 lignes ; statrow = 4 (chiffres du post sinon "n":"—").',
    ['label', 'title_lines', 'subtitle', 'statrow'],
  ],
  integrations: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"v (optionnel)"}],"subtitle":"phrase courte"} — title_lines = 2 lignes.',
    ['eyebrow', 'title_lines', 'subtitle'],
  ],
  testimonial: [
    '{"label":"Nos clients","quote_lines":[{"t":"phrase de l\'avis"}],"author":{"name":"Prénom N.","role":"métier · ville"}} ' +
      '— une citation client en 1-2 lignes ; author = client (pas la marque).',
    ['label', 'quote_lines', 'author'],
  ],
  people: [
    '{"eyebrow":"1-2 mots","title_lines":[{"t":"MAJUSCULES","c":"a (optionnel)"}],"subtitle":"phrase courte"} — title_lines = 3 lignes.',
    ['eyebrow', 'title_lines', 'subtitle'],
  ],
  closing: [
    '{"title_lines":[{"t":"MAJUSCULES","c":"v (optionnel)"}],"subtitle":"phrase courte"} — title_lines = 2 lignes.',
    ['title_lines', 'subtitle'],
  ],
};

function gabLines(v: unknown): TitleLine[] {
  const arr = Array.isArray(v) ? v : [];
  const out: TitleLine[] = [];
  for (const ln of arr) {
    if (typeof ln === 'string' && ln.trim()) {
      out.push({ t: ln.trim() });
    } else if (ln && typeof ln === 'object' && String((ln as Record<string, unknown>).t ?? '').trim()) {
      const item: TitleLine = { t: String((ln as Record<string, unknown>).t).trim() };
      const c = (ln as Record<string, unknown>).c;
      if (c === 'a' || c === 'v') item.c = c;
      out.push(item);
    }
  }
  return out.slice(0, 4);
}

export interface ComposerGabaritResult {
  slots: Slots;
  usage: LlmUsage;
}

@Injectable()
export class GabaritComposeService {
  private readonly logger = new Logger(GabaritComposeService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly config: ConfigService,
  ) {}

  /** À partir du texte d'un post, écrit les champs texte du gabarit (titre/eyebrow/citation/
   * etc.) et les pose sur les défauts structurels du gabarit (stats/services/bulles… restent
   * cohérents). */
  async composerGabarit(
    telegramId: string,
    gabaritIn: string,
    texte: string,
  ): Promise<ComposerGabaritResult | { error: string }> {
    if (!this.claude.isConfigured) return { error: 'no_api_key' };
    const gabarit = gabaritIn in GAB_SPECS ? gabaritIn : 'statement';
    const u = await this.marqueService.chargerMarque(telegramId);
    const contexte = this.marqueService.contexteMarque(u, false);
    const nom = (u.nom as string) || (u.user_name as string) || '';
    const [spec, fields] = GAB_SPECS[gabarit];

    const resp = await this.claude.messagesCreate({
      model: this.config.get<string>('app.claudeModel') || 'claude-sonnet-4-6',
      max_tokens: 700,
      system: this.claude.system(ROLE_GABARIT, contexte),
      messages: [
        {
          role: 'user',
          content: `Post :\n"""${(texte || '').slice(0, 1500)}"""\n\nProduis le visuel "${gabarit}" au format JSON : ${spec}`,
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
      this.logger.error(`gabarit compose parse: ${e instanceof Error ? e.message : e} | ${txt.slice(0, 200)}`);
      return { error: 'parse' };
    }

    // Base = exemple du gabarit (structure complète, toujours rendable) ; on pose les champs IA dessus.
    const slots: Slots = JSON.parse(JSON.stringify(SAMPLES[gabarit] ?? {}));
    for (const f of fields) {
      const v = data[f];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (f === 'title_lines' || f === 'quote_lines') {
        const lines = gabLines(v);
        if (lines.length) slots[f] = lines;
      } else if (f === 'stats') {
        slots.stats = (Array.isArray(v) ? v : [])
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .slice(0, 4)
          .map((x) => ({ k: String(x.k ?? ''), n: String(x.n ?? '—'), ...(x.v ? { v: true } : {}) }));
      } else if (f === 'statrow') {
        slots.statrow = (Array.isArray(v) ? v : [])
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .slice(0, 4)
          .map((x) => ({ n: String(x.n ?? '—'), k: String(x.k ?? '') }));
      } else if (f === 'features') {
        slots.features = (Array.isArray(v) ? v : [])
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .slice(0, 3)
          .map((x) => ({ t: String(x.t ?? ''), d: String(x.d ?? '') }));
      } else if (f === 'bubbles') {
        slots.bubbles = (Array.isArray(v) ? v : [])
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .slice(0, 5)
          .map((x) => ({ side: x.side === 'out' ? 'out' : 'in', t: String(x.t ?? '') }));
      } else if (f === 'services' || f === 'flow') {
        const max = f === 'services' ? 4 : 2;
        slots[f] = (Array.isArray(v) ? v : []).map((x) => String(x)).filter((x) => x.trim()).slice(0, max);
      } else if (f === 'author') {
        const av = (v ?? {}) as Record<string, unknown>;
        slots.author = { name: String(av.name ?? ''), role: String(av.role ?? '') };
      } else {
        // eyebrow, label, subtitle
        slots[f] = String(v);
      }
    }

    // Auteur de la citation = la marque (sauf témoignage client).
    if (gabarit === 'citation') slots.author = { name: nom, role: '' };
    return { slots, usage: this.claude.usage(resp) };
  }
}
