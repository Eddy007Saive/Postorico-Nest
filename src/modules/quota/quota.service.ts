import { forwardRef, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { BillingService } from '../billing/billing.service';
import { QuotaResult } from './interfaces/quota-result.interface';

/**
 * Quotas PAR TYPE d'action — port direct de backend/services/quota_service.py.
 * On mètre par type (subject/post/image_standard/...), on réserve atomiquement avant
 * génération (via les fonctions Postgres consume_quota/refund_quota — la logique
 * atomique vit en base, pas dans ce service, des deux côtés), on rembourse en cas
 * d'échec, on journalise tout.
 */

const LABELS: Record<string, string> = {
  voix: 'voix off',
  subject: 'sujets',
  post: 'posts',
  image_standard: 'images standard',
  image_pro: 'images HD',
  carousel: 'carrousels',
  video: 'vidéos',
  story: 'stories',
  reel: 'reels',
  video_agent: 'montages par l\'agent IA',
};

const TRIAL_DAYS = 14;
const RESEAUX_EN_ESSAI = 1;
const PLAN_INTERNE = 'Boss';
const STATUTS_ACTIFS = ['active', 'trialing', 'past_due', 'suspended'];

/** nano2 -> image_standard ; nano3 -> image_pro. */
export function imageAction(modele: string): string {
  return modele === 'nano3' ? 'image_pro' : 'image_standard';
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BillingService))
    private readonly billingService: BillingService,
  ) {}

  async estBoss(telegramId: string): Promise<boolean> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: STATUTS_ACTIFS } },
        orderBy: { created_at: 'desc' },
        include: { plans: true },
      });
      return sub?.plans?.name === PLAN_INTERNE;
    } catch {
      return false;
    }
  }

  /** True si le compte a un abonnement payant actif (pas un simple essai trialing).
   * Un compte Boss compte comme payant, quel que soit son statut. */
  async isPaid(telegramId: string): Promise<boolean> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: 'active' },
        select: { id: true },
      });
      return Boolean(sub) || (await this.estBoss(telegramId));
    } catch {
      return false;
    }
  }

  async statutAbonnement(telegramId: string): Promise<string | null> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: STATUTS_ACTIFS } },
        select: { status: true },
      });
      return sub?.status ?? null;
    } catch {
      return null;
    }
  }

  /** Un compte sans abonnement actif tombe dans deux cas bien différents : jamais abonné
   * (on lui propose l'essai gratuit) ou déjà résilié (il a déjà consommé son essai —
   * BillingService.aDejaEuUnAbonnement l'empêche d'en reprendre un, donc lui promettre
   * « 14 jours gratuits » serait faux). Port de _raison_sans_abonnement (quota_service.py). */
  private async raisonSansAbonnement(telegramId: string): Promise<{ reason: string; message: string }> {
    if (await this.billingService.aDejaEuUnAbonnement(telegramId)) {
      return { reason: 'canceled', message: 'Réactive ton abonnement pour continuer.' };
    }
    return { reason: 'no_subscription', message: "Ajoute ta carte pour lancer tes 14 jours d'essai." };
  }

  /** Mur de paiement PARTAGÉ : un compte SANS aucun abonnement ne peut lancer aucune
   * action qui produit ou consomme. Lève un 402 {raison, message} — à poser en tête de
   * tout nouvel endpoint qui produit/consomme, pour que TOUTES les actions ressortent le
   * même popup, pas seulement « Générer ». */
  async exigerAbonnement(telegramId: string): Promise<void> {
    const statut = await this.statutAbonnement(telegramId);
    if (statut === null) {
      const { reason, message } = await this.raisonSansAbonnement(telegramId);
      throw new HttpException({ raison: reason, message }, HttpStatus.PAYMENT_REQUIRED);
    }
  }

  /** Droit de connecter un réseau et de publier : abonnement actif OU en essai (à ne pas
   * confondre avec un paiement encaissé — quelqu'un en essai a déjà donné sa carte, lui
   * interdire de connecter le priverait de voir le produit avant son premier prélèvement). */
  async peutPublier(telegramId: string): Promise<boolean> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: ['active', 'trialing'] } },
        select: { id: true },
      });
      return Boolean(sub);
    } catch {
      return false;
    }
  }

  /** Nombre de réseaux connectables. null = sans limite, 0 = aucun droit. */
  async reseauxAutorises(telegramId: string): Promise<number | null> {
    const statut = await this.statutAbonnement(telegramId);
    if (statut === null) return 0;
    return statut === 'trialing' ? RESEAUX_EN_ESSAI : null;
  }

  /** Date de fin de pause, ou null. Stripe suspend la facturation sans toucher au
   * statut (`pause_jusqu_au` porte cet état séparément). */
  async enPause(telegramId: string): Promise<Date | null> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: STATUTS_ACTIFS } },
        select: { pause_jusqu_au: true },
      });
      return sub?.pause_jusqu_au ?? null;
    } catch {
      return null;
    }
  }

  private async planId(nom: string): Promise<string | null> {
    const p = await this.prisma.plans.findFirst({ where: { name: nom, is_active: true } });
    return p?.id ?? null;
  }

  /** Pose un essai local si le compte n'a aucun abonnement — UNIQUEMENT quand Stripe
   * n'est pas configuré (cf. BillingService.ready plus bas : en production, Stripe est
   * configuré, donc ce filet ne s'active jamais — il protège seulement le dev local). */
  async ensureSubscription(telegramId: string): Promise<void> {
    try {
      const existing = await this.prisma.subscriptions.findFirst({ where: { user_id: telegramId } });
      if (existing) return;
      // UNIQUEMENT quand Stripe n'est pas configuré. Depuis que l'essai passe par Stripe
      // avec carte, accorder ici quatorze jours gratuits sans carte serait une porte
      // dérobée : il suffirait de refermer la page de paiement pour obtenir la même
      // chose sans rien donner (cf. quota_service.py::ensure_subscription).
      if (this.billingService.ready) return;
      const planId = (await this.planId('Essai')) ?? (await this.planId('Pro'));
      if (!planId) return;
      const now = new Date();
      await this.prisma.subscriptions.create({
        data: {
          user_id: telegramId,
          plan_id: planId,
          status: 'trialing',
          current_period_start: now,
          current_period_end: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    } catch (e) {
      this.logger.warn(`ensureSubscription ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private message(actionType: string, reason?: string, limit?: number): string {
    const label = LABELS[actionType] ?? 'générations';
    switch (reason) {
      case 'no_subscription':
        return "Ajoute ta carte pour lancer tes 14 jours d'essai.";
      case 'canceled':
        return 'Réactive ton abonnement pour continuer.';
      case 'impaye':
        return "Ton dernier prélèvement n'est pas passé. Mets à jour ta carte pour reprendre la génération.";
      case 'suspendu':
        return 'Paiement en attente depuis plus de dix jours : tes réseaux ont été déconnectés. Régularise pour reprendre.';
      case 'expired':
        return "Ton essai est terminé. Passe à l'offre Pro pour continuer.";
      case 'not_in_plan':
        return `Les ${label} sont inclus dans l'offre Pro.`;
      case 'quota':
        return limit === 0
          ? `Les ${label} sont réservés à l'offre Pro — passe Pro pour les débloquer.`
          : `Tu as utilisé tous tes ${label} de la période.`;
      default:
        return 'Quota indisponible.';
    }
  }

  /** Réserve atomiquement qty pour (compte, type) via la fonction Postgres consume_quota
   * (même RPC que le backend Python — la logique atomique vit en base). */
  async consume(telegramId: string, actionType: string, qty = 1): Promise<QuotaResult> {
    await this.ensureSubscription(telegramId);

    const pause = await this.enPause(telegramId);
    if (pause) {
      return {
        ok: false,
        reason: 'pause',
        action_type: actionType,
        qty,
        message: 'Ton compte est en pause. Reprends-le quand tu veux, tout est conservé.',
      };
    }

    const statut = await this.statutAbonnement(telegramId);
    if ((statut === 'past_due' || statut === 'suspended') && !(await this.estBoss(telegramId))) {
      const reason = statut === 'past_due' ? 'impaye' : 'suspendu';
      return { ok: false, reason, action_type: actionType, qty, message: this.message(actionType, reason) };
    }

    let data: Record<string, unknown>;
    try {
      // qty::int est nécessaire : Prisma type un nombre JS passé tel quel en bigint dans
      // $queryRaw, alors que consume_quota(uuid, text, int) attend un int4 (42883 sinon).
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT consume_quota(${telegramId}::uuid, ${actionType}, ${qty}::int) AS result
      `;
      data = (rows[0]?.result as Record<string, unknown>) ?? {};
    } catch (e) {
      this.logger.error(`consume_quota error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, reason: 'error', action_type: actionType, qty, message: 'Erreur de quota.' };
    }

    const result: QuotaResult = {
      ok: Boolean(data.ok),
      reason: data.reason as string | undefined,
      subscription_id: data.subscription_id as string | undefined,
      unit_cost: data.unit_cost as number | undefined,
      used: data.used as number | undefined,
      limit: data.limit as number | undefined,
      action_type: actionType,
      qty,
    };
    if (!result.ok) {
      // La RPC ne distingue pas jamais-abonné / ex-abonné (elle ne voit que l'absence
      // d'abonnement actif) — affine ici, même logique que exigerAbonnement().
      if (result.reason === 'no_subscription') {
        result.reason = (await this.raisonSansAbonnement(telegramId)).reason;
      }
      result.message = this.message(actionType, result.reason, result.limit);
    }
    return result;
  }

  /** Journalise un succès (le débit a déjà été réservé par consume). */
  async confirm(ctx: QuotaResult): Promise<void> {
    if (!ctx.subscription_id) return;
    try {
      await this.prisma.usage_events.create({
        data: {
          subscription_id: ctx.subscription_id,
          action_type: ctx.action_type,
          quantity: ctx.qty,
          internal_cost_cents: Math.round((ctx.unit_cost ?? 0) * ctx.qty),
          status: 'success',
        },
      });
    } catch (e) {
      this.logger.warn(`usage_event success: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Jauge de résultats pour la période courante + état de l'abonnement (écran client +
   * détail admin). */
  async usage(telegramId: string): Promise<{ subscription: Record<string, unknown> | null; gauges: Array<Record<string, unknown>> }> {
    await this.ensureSubscription(telegramId);
    // Matérialise les compteurs de la période (avec REPORT des restes de la période
    // précédente) pour que la jauge affiche le cumul même avant toute consommation.
    try {
      await this.prisma.$executeRaw`SELECT ensure_period_counters(${telegramId}::uuid)`;
    } catch (e) {
      this.logger.warn(`ensure_period_counters ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: STATUTS_ACTIFS } },
        orderBy: { created_at: 'desc' },
      });
      if (!sub) return { subscription: null, gauges: [] };

      const quotas = await this.prisma.plan_quotas.findMany({
        where: { plan_id: sub.plan_id },
        select: { action_type: true, included_quantity: true },
      });
      const counters = await this.prisma.usage_counters.findMany({
        where: { subscription_id: sub.id },
        select: { action_type: true, used_quantity: true, extra_quantity: true, period_start: true },
      });
      const ps = sub.current_period_start.getTime();
      const cmap = new Map(counters.filter((c) => Math.abs(c.period_start.getTime() - ps) < 5000).map((c) => [c.action_type, c]));

      const gauges = quotas.map((q) => {
        const c = cmap.get(q.action_type);
        const used = c?.used_quantity ?? 0;
        const limit = q.included_quantity + (c?.extra_quantity ?? 0);
        return {
          action_type: q.action_type,
          label: LABELS[q.action_type] ?? q.action_type,
          used,
          limit,
          remaining: Math.max(0, limit - used),
          included: q.included_quantity,
          extra: c?.extra_quantity ?? 0,
        };
      });
      return {
        subscription: {
          status: sub.status,
          current_period_end: sub.current_period_end,
          cancel_at: sub.cancel_at ?? null,
          pause_jusqu_au: sub.pause_jusqu_au ?? null,
        },
        gauges,
      };
    } catch (e) {
      this.logger.error(`usage ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { subscription: null, gauges: [] };
    }
  }

  /** Rembourse (échec de génération) + journalise. */
  async refund(ctx: QuotaResult): Promise<void> {
    if (!ctx?.subscription_id) return;
    try {
      await this.prisma.$executeRaw`SELECT refund_quota(${ctx.subscription_id}::uuid, ${ctx.action_type}, ${ctx.qty}::int)`;
      await this.prisma.usage_events.create({
        data: {
          subscription_id: ctx.subscription_id,
          action_type: ctx.action_type,
          quantity: ctx.qty,
          status: 'failed',
        },
      });
    } catch (e) {
      this.logger.warn(`refund_quota: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Rembourse un quota pour un échec ASYNC (ex. rendu vidéo qui échoue plus tard, worker
   * de rendu), quand on n'a plus le contexte du consume — on retrouve l'abonnement du
   * compte directement. */
  async refundByUser(telegramId: string, actionType: string, qty = 1): Promise<void> {
    try {
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: telegramId, status: { in: STATUTS_ACTIFS } },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      });
      if (sub) await this.refund({ ok: false, subscription_id: sub.id, action_type: actionType, qty });
    } catch (e) {
      this.logger.warn(`refund_by_user ${telegramId}/${actionType}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
