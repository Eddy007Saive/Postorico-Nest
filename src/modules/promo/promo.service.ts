import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Codes promotionnels Stripe (admin) — port direct de backend/services/promo_service.py :
 * création complète (pourcentage ou montant, durée once / repeating / forever, limite
 * d'utilisations, expiration), liste et activation/désactivation. Un code promo = un
 * coupon Stripe + un promotion code.
 *
 * Client Stripe dédié (distinct de celui de BillingService) épinglé sur une version
 * d'API antérieure : les comptes Stripe créés après 2025 ont changé les paramètres des
 * promotion codes, cette version accepte encore `coupon=` (vérifié manuellement le 2026-07-31).
 */
const API_VERSION = '2024-06-20' as Stripe.LatestApiVersion;

/** Forme du promotion code sous l'API épinglée 2024-06-20 : `coupon` est un champ direct
 * (l'API 2025+ l'a déplacé sous `promotion.coupon`, forme que décrivent les types de la
 * lib `stripe` installée — le SDK ne type que la dernière version, pas celle qu'on
 * épingle en paramètre). Le JSON réellement reçu suit bien l'ancienne forme. */
interface PromotionCodeLegacy extends Omit<Stripe.PromotionCode, 'coupon'> {
  coupon: string | Stripe.Coupon;
}
interface PromotionCodeCreateParamsLegacy extends Omit<Stripe.PromotionCodeCreateParams, 'coupon' | 'promotion'> {
  coupon: string;
}

export interface PromoResume {
  id: string;
  code: string | null | undefined;
  active: boolean | undefined;
  times_redeemed: number;
  max_redemptions: number | null;
  expires_at: number | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: string;
  duration_in_months: number | null;
  coupon_valid: boolean;
  created: number;
}

export interface CreatePromoInput {
  code?: string;
  type?: 'percent' | 'amount';
  valeur?: number | string;
  duration?: 'once' | 'repeating' | 'forever';
  duration_in_months?: number | string;
  max_redemptions?: number | string;
  expires_at?: number | string;
  name?: string;
}

@Injectable()
export class PromoService {
  private readonly logger = new Logger(PromoService.name);
  private readonly stripe: Stripe | null;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('app.stripeSecretKey') || '';
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: API_VERSION }) : null;
  }

  private ready(): boolean {
    return Boolean(this.stripe);
  }

  /** Codes promo (actifs et inactifs) avec le détail de leur coupon. */
  async listPromos(): Promise<PromoResume[]> {
    if (!this.ready()) return [];
    try {
      const res = await this.stripe!.promotionCodes.list({ limit: 50, expand: ['data.coupon'] });
      return (res.data as unknown as PromotionCodeLegacy[]).map((p) => {
        const c = (typeof p.coupon === 'object' ? p.coupon : {}) as Stripe.Coupon;
        return {
          id: p.id,
          code: p.code,
          active: p.active,
          times_redeemed: p.times_redeemed || 0,
          max_redemptions: p.max_redemptions ?? null,
          expires_at: p.expires_at ?? null,
          percent_off: c.percent_off ?? null,
          amount_off: c.amount_off ?? null,
          currency: c.currency ?? null,
          duration: c.duration,
          duration_in_months: c.duration_in_months ?? null,
          coupon_valid: c.valid ?? true,
          created: p.created,
        };
      });
    } catch (e) {
      this.logger.error(`list promos: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Crée coupon + promotion code. */
  async createPromo(data: CreatePromoInput): Promise<{ ok: true; id: string; code: string | null } | { error: string }> {
    if (!this.ready()) return { error: 'Stripe non configuré.' };
    const code = (data.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code || code.length < 3) return { error: 'Code invalide (3 caractères minimum).' };
    const valeur = Number(data.valeur ?? 0);
    if (Number.isNaN(valeur)) return { error: 'Valeur de réduction invalide.' };
    if (valeur <= 0) return { error: 'La réduction doit être positive.' };

    const duration = data.duration || 'once';
    if (!['once', 'repeating', 'forever'].includes(duration)) return { error: 'Durée invalide.' };

    const couponParams: Stripe.CouponCreateParams = {
      duration,
      name: (data.name || code).slice(0, 40),
    };
    if (duration === 'repeating') {
      const months = parseInt(String(data.duration_in_months ?? 0), 10);
      if (!months || months < 1) return { error: 'Indique le nombre de mois pour une réduction répétée.' };
      couponParams.duration_in_months = months;
    }

    if (data.type === 'amount') {
      couponParams.amount_off = Math.round(valeur * 100);
      couponParams.currency = 'eur';
    } else {
      if (valeur > 100) return { error: 'Un pourcentage ne peut pas dépasser 100.' };
      couponParams.percent_off = valeur;
    }

    let expiresAt: number | undefined;
    if (data.expires_at) {
      expiresAt = parseInt(String(data.expires_at), 10);
      if (Number.isNaN(expiresAt)) return { error: "Date d'expiration invalide." };
      if (expiresAt <= Math.floor(Date.now() / 1000)) return { error: "La date d'expiration est déjà passée." };
    }

    try {
      const coupon = await this.stripe!.coupons.create(couponParams);
      const promoParams: PromotionCodeCreateParamsLegacy = { coupon: coupon.id, code };
      if (data.max_redemptions) promoParams.max_redemptions = parseInt(String(data.max_redemptions), 10);
      if (expiresAt) promoParams.expires_at = expiresAt;
      const promo = await this.stripe!.promotionCodes.create(promoParams as unknown as Stripe.PromotionCodeCreateParams);
      this.logger.log(`admin promo créé: ${code} (${coupon.id})`);
      return { ok: true, id: promo.id, code: promo.code };
    } catch (e) {
      const msg = e instanceof Stripe.errors.StripeError ? e.message : e instanceof Error ? e.message : String(e);
      if (msg.includes('already exists')) return { error: `Le code ${code} existe déjà.` };
      this.logger.error(`create promo: ${msg}`);
      if (e instanceof Stripe.errors.StripeError) return { error: `Stripe a refusé : ${msg.slice(0, 140)}` };
      return { error: 'Création impossible.' };
    }
  }

  /** Active/désactive un promotion code (un code désactivé ne peut plus être saisi). */
  async togglePromo(promoId: string, active: boolean): Promise<{ ok: true; id: string; active: boolean } | { error: string }> {
    if (!this.ready()) return { error: 'Stripe non configuré.' };
    try {
      const p = await this.stripe!.promotionCodes.update(promoId, { active });
      return { ok: true, id: p.id, active: p.active };
    } catch (e) {
      this.logger.error(`toggle promo ${promoId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Modification impossible.' };
    }
  }
}
