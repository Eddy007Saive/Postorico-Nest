import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { contexteIa } from '../../common/contexte-ia';
import { LlmUsage } from './interfaces/llm-usage.interface';

/** Tarifs officiels Anthropic en $ par million de jetons (platform.claude.com, novembre 2026).
 * Cache : écriture 5 min = 1,25 x entrée, 1 h = 2 x, lecture = 0,1 x. */
const TARIFS_ANTHROPIC: Array<[motif: string, entree: number, sortie: number]> = [
  ['fable', 10, 50],
  ['mythos', 10, 50],
  ['opus-5-5', 4, 20],
  ['opus-4-1', 15, 75],
  ['opus-4-2', 15, 75],
  ['opus', 5, 25],
  ['sonnet-5-5', 2, 10],
  ['sonnet-5', 2, 10],
  ['sonnet', 3, 15],
  ['haiku-5-5', 0.1, 0.5],
  ['haiku-3', 0.8, 4],
  ['haiku', 1, 5],
];
const PRIX_RECHERCHE_WEB = 0.01; // 10 $ les 1 000 recherches

/** Ce que l'API Anthropic renvoie dans `usage` (sous-ensemble utile). */
export interface UsageAnthropic {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** Ce qu'OpenRouter renvoie dans `usage` : `cost` est le montant facturé, en $. */
export interface UsageOpenRouter {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

/** Coût exact d'un appel Anthropic : jetons renvoyés par l'API x tarif officiel. */
export function coutAnthropic(modele: string, u: UsageAnthropic): number {
  const m = (modele || '').toLowerCase();
  const [, entree, sortie] = TARIFS_ANTHROPIC.find(([motif]) => m.includes(motif)) ?? ['', 3, 15];
  const c5m = u.cache_creation?.ephemeral_5m_input_tokens ?? null;
  const c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? null;
  // Sans le détail 5 min / 1 h, toute écriture de cache est comptée au tarif 5 min
  const ecriture5m = c5m ?? (c1h === null ? u.cache_creation_input_tokens ?? 0 : 0);
  const ecriture1h = c1h ?? 0;
  return (
    ((u.input_tokens ?? 0) * entree +
      ecriture5m * entree * 1.25 +
      ecriture1h * entree * 2 +
      (u.cache_read_input_tokens ?? 0) * entree * 0.1 +
      (u.output_tokens ?? 0) * sortie) /
      1e6 +
    (u.server_tool_use?.web_search_requests ?? 0) * PRIX_RECHERCHE_WEB
  );
}

/** Port direct de backend/services/usage_service.py — coût réel d'un appel LLM et
 * journalisation dans usage_log. */

// Coût forfaitaire par génération d'image nano-banana (pas de tokens à mesurer).
export const IMAGE_PRICES: Record<string, number> = { nano2: 0.04, nano3: 0.14 };

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Coût réel en $ : jetons x tarif officiel du modèle (voir coutAnthropic). */
  coutReel(model: string, usage: LlmUsage): number {
    return coutAnthropic(model, {
      input_tokens: usage.input ?? 0,
      cache_creation_input_tokens: usage.cache_write ?? 0,
      cache_read_input_tokens: usage.cache_read ?? 0,
      output_tokens: usage.output ?? 0,
    });
  }

  /** Journal de CHAQUE appel IA (appels_ia), indépendant de usage_log : client et action
   * viennent du contexte de la requête, sauf `action` explicite. Ne lève jamais. */
  private async suivre(fournisseur: 'anthropic' | 'openrouter', modele: string, donnees: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number; web?: number; cout: number; dureeMs?: number;
  }, action?: string): Promise<void> {
    const ctx = contexteIa.getStore();
    try {
      await this.prisma.appels_ia.create({
        data: {
          telegram_id: ctx?.telegramId ?? null,
          fournisseur,
          action: (action || ctx?.action || 'tache_fond').slice(0, 120),
          modele: (modele || '?').slice(0, 120),
          input_tokens: donnees.input ?? 0,
          output_tokens: donnees.output ?? 0,
          cache_read: donnees.cacheRead ?? 0,
          cache_write: donnees.cacheWrite ?? 0,
          recherches_web: donnees.web ?? 0,
          cout_usd: Math.round(donnees.cout * 1e6) / 1e6,
          duree_ms: donnees.dureeMs !== undefined ? Math.round(donnees.dureeMs) : null,
        },
      });
    } catch (e) {
      this.logger.error(`suivi appel IA : ${e instanceof Error ? e.message : e}`);
    }
  }

  suivreAnthropic(modele: string, usage: UsageAnthropic | undefined, dureeMs?: number, action?: string): Promise<void> {
    const u = usage ?? {};
    return this.suivre('anthropic', modele, {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      web: u.server_tool_use?.web_search_requests ?? 0,
      cout: coutAnthropic(modele, u),
      dureeMs,
    }, action);
  }

  suivreOpenRouter(modele: string, usage: UsageOpenRouter | undefined, dureeMs?: number, action?: string): Promise<void> {
    const cout = Number(usage?.cost);
    return this.suivre('openrouter', modele, {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      cout: Number.isFinite(cout) ? cout : 0,
      dureeMs,
    }, action);
  }

  /** `telegramId` null : appel d'un visiteur anonyme (ex. analyse de site de l'onboarding public). */
  async log(
    telegramId: string | null,
    action: string,
    model: string,
    usage: LlmUsage | undefined,
    credits: number,
    qualite?: string,
    costOverride?: number,
    dureeS?: number,
  ): Promise<void> {
    try {
      const u = usage ?? {};
      const cost = costOverride ?? this.coutReel(model, u);
      await this.prisma.usage_log.create({
        data: {
          telegram_id: telegramId || null,
          action,
          model,
          qualite: qualite ?? null,
          input_tokens: u.input ?? 0,
          cache_read: u.cache_read ?? 0,
          cache_write: u.cache_write ?? 0,
          output_tokens: u.output ?? 0,
          cost_usd: Math.round(cost * 1e6) / 1e6,
          credits,
          ...(dureeS !== undefined ? { duree_s: Math.round(dureeS * 100) / 100 } : {}),
        },
      });
    } catch (e) {
      this.logger.error(`usage log error: ${e instanceof Error ? e.message : e}`);
    }
  }
}
