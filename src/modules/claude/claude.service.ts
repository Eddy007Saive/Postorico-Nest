import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { LlmUsage } from '../usage/interfaces/llm-usage.interface';

/**
 * Client Claude partagé (Anthropic SDK) — infrastructure commune à tous les agents
 * de génération (sujets, rédaction, plus tard carrousel/script/gabarit). Port direct
 * de la partie transverse de backend/services/agent_service.py : `_messages_create`
 * (retry anti-fuite), `_usage`, `_texte`, `_system`.
 */

/** Erreur de génération présentée à l'utilisateur (message générique, sans fuite du fournisseur). */
export class GenerationError extends Error {}

// Niveaux de qualité (noms neutres côté UI) → modèle réel (jamais exposé). Partagé par
// tous les agents de génération (post, carrousel, plus tard script) — port direct de
// QUALITE_MODELS (backend/services/agent_service.py).
export const QUALITE_MODELS: Record<string, string> = {
  rapide: 'claude-haiku-4-5',
  equilibre: 'claude-sonnet-4-6',
  premium: 'claude-opus-4-8',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('app.claudeApiKey');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /** Appel LLM centralisé : retry sur surcharge/limite (529/429/5xx) + message propre.
   * Ne laisse jamais remonter l'erreur brute du fournisseur (anti-fuite). */
  async messagesCreate(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Messages.Message> {
    if (!this.client) {
      throw new GenerationError('Le service de génération est momentanément surchargé. Réessaie dans quelques secondes.');
    }
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.client.messages.create(params);
      } catch (e) {
        last = e;
        const status = (e as { status?: number })?.status;
        const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
        const retryable =
          (status !== undefined && [408, 409, 429, 500, 502, 503, 504, 529].includes(status)) ||
          msg.includes('overloaded') ||
          msg.includes('rate') ||
          e instanceof Anthropic.APIConnectionError;
        if (!retryable || attempt === 3) break;
        await sleep(800 * 2 ** attempt); // 0.8s, 1.6s, 3.2s
      }
    }
    this.logger.error(`LLM generation error (after retries): ${last instanceof Error ? last.message : last}`);
    throw new GenerationError('Le service de génération est momentanément surchargé. Réessaie dans quelques secondes.');
  }

  usage(resp: Anthropic.Messages.Message): LlmUsage {
    const u = resp.usage;
    return {
      input: u.input_tokens ?? 0,
      cache_write: u.cache_creation_input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
  }

  texte(resp: Anthropic.Messages.Message): string {
    return resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  /** Construit le bloc system.
   *
   * cache=true (génération en rafale) : la VOIX DE MARQUE (contexte, identique pour toutes
   * les générations d'un client) est mise en cache -> relue à 0,1× sur les générations
   * suivantes de la rafale. Le rôle + exemples (variables) restent hors cache.
   * cache=false (génération unique) : pas de cache (évite le surcoût d'écriture). */
  system(role: string, contexte: string, extra = '', cache = false): string | Anthropic.Messages.TextBlockParam[] {
    if (cache) {
      return [
        { type: 'text', text: contexte, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: role + extra },
      ];
    }
    return role + contexte + extra;
  }
}
