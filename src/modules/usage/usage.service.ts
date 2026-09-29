import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { LlmUsage } from './interfaces/llm-usage.interface';

/** Port direct de backend/services/usage_service.py — coût réel d'un appel LLM et
 * journalisation dans usage_log. */

const PRICES: Record<string, { in: number; out: number }> = {
  haiku: { in: 1.0, out: 5.0 },
  sonnet: { in: 3.0, out: 15.0 },
  opus: { in: 5.0, out: 25.0 },
};

// Coût forfaitaire par génération d'image nano-banana (pas de tokens à mesurer).
export const IMAGE_PRICES: Record<string, number> = { nano2: 0.04, nano3: 0.14 };

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  private prix(model: string): { in: number; out: number } {
    const m = (model || '').toLowerCase();
    for (const [key, p] of Object.entries(PRICES)) {
      if (m.includes(key)) return p;
    }
    return PRICES.sonnet;
  }

  /** Coût réel en $ : entrée plein tarif + cache write (1.25×) + cache read (0.1×) + sortie. */
  coutReel(model: string, usage: LlmUsage): number {
    const p = this.prix(model);
    const inp = usage.input ?? 0;
    const cw = usage.cache_write ?? 0;
    const cr = usage.cache_read ?? 0;
    const out = usage.output ?? 0;
    return (inp / 1e6) * p.in + (cw / 1e6) * p.in * 1.25 + (cr / 1e6) * p.in * 0.1 + (out / 1e6) * p.out;
  }

  async log(
    telegramId: string,
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
          telegram_id: telegramId,
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
