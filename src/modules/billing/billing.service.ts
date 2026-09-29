import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { subscriptions as SubscriptionRow } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../config/prisma.service';
import { AffiliationService } from '../affiliation/affiliation.service';
import { ImpayeService } from '../impaye/impaye.service';
import { NotificationService } from '../notifications/notification.service';
import {
  AbonnementInfo,
  AdminInvoiceItem,
  CarteEnregistreeResult,
  CheckoutResult,
  ClientImpayePayload,
  DemarrerAbonnementResult,
  FacturePayload,
  InvoiceItem,
  LienPackResult,
  NotifyPayload,
  OuvrirParcoursResult,
  PackListItem,
  PauseResult,
  RappelPayload,
  ResilierResult,
  SyncResult,
  WebhookResult,
} from './interfaces/billing-result.interface';

/**
 * Abonnements Stripe -> plan utilisateur + crédits mensuels — port direct de
 * backend/services/billing_service.py.
 *
 * No-op propre si Stripe non configuré (l'app marche en mode gratuit sans Stripe).
 *
 * Portée volontairement réduite (documentée à chaque endroit concerné) :
 * - `admin_service._abonnements()` (utilisé par `_notify_payload` pour le libellé du plan) :
 *   remplacé par `abonnements()` de CE service, même source de vérité (`subscriptions`).
 *
 * `impaye_service.regulariser`/`marquer_echec` (cycle grâce/suspension/résiliation),
 * `affiliation_service.creer_commission` (commission setup 25% / récurrente 10%, isolée et
 * silencieuse) et `social_service.disconnect_all` (libération des comptes Late à la
 * résiliation) sont tous appelés ici comme côté Python — `canceled_uid` déclenche
 * `disconnectAll` côté `BillingController`, pas dans ce service (même découpage que la
 * route Python).
 *
 * Comme pour late_service : code complet, ZÉRO appel réel à Stripe pendant ce portage
 * (aucune clé Stripe réelle en local) — vérifié uniquement via tsc/build/jest/routes.
 */

const STATUS_MAP: Record<string, string> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  incomplete: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  incomplete_expired: 'canceled',
};

const CANCEL_FEEDBACK: Record<string, string> = {
  too_expensive: 'Trop cher',
  missing_features: 'Fonctionnalités manquantes',
  switched_service: 'Passé à un concurrent',
  unused: 'Pas / peu utilisé',
  customer_service: 'Service client',
  too_complex: 'Trop compliqué',
  low_quality: 'Qualité insuffisante',
  other: 'Autre',
};

const RAISONS = new Set(['prix', 'temps', 'resultats', 'complexite', 'fonctionnalite', 'concurrent', 'test', 'autre']);
const PAUSE_MOIS_MAX = 3;

const CONTINENT_EURO = ['Europe/', 'Africa/', 'Atlantic/'];
const CONTINENT_DOLLAR = ['America/', 'Pacific/'];

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: Stripe | null;
  private readonly frontendUrl: string;
  private readonly webhookSecret: string;
  private readonly pricePro: string;
  private readonly priceProUsd: string;
  private readonly priceBusiness: string;
  private readonly packPrix: Record<string, string>;
  private readonly autoTax: boolean;
  private readonly packDelaiJours: number;

  readonly ESSAI_JOURS = 14;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ImpayeService))
    private readonly impayeService: ImpayeService,
    private readonly notificationService: NotificationService,
    private readonly affiliationService: AffiliationService,
    config: ConfigService,
  ) {
    const secretKey = config.get<string>('app.stripeSecretKey') || '';
    // Aucune clé Stripe réelle n'est présente en local pour ce portage (voir en-tête) :
    // ready() reste false, tout appel Stripe est court-circuité en no-op contrôlé.
    this.stripe = secretKey ? new Stripe(secretKey) : null;
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
    this.webhookSecret = config.get<string>('app.stripeWebhookSecret') || '';
    this.pricePro = config.get<string>('app.stripePricePro') || '';
    this.priceProUsd = config.get<string>('app.stripePriceProUsd') || '';
    this.priceBusiness = config.get<string>('app.stripePriceBusiness') || '';
    this.packPrix = {
      eur: config.get<string>('app.stripePricePackEur') || '',
      usd: config.get<string>('app.stripePricePackUsd') || '',
    };
    this.autoTax = config.get<boolean>('app.stripeAutoTax') ?? true;
    this.packDelaiJours = config.get<number>('app.packDelaiJours') ?? 14;
  }

  private get ready(): boolean {
    return this.stripe !== null;
  }

  private priceFor(plan: string, devise = 'eur'): string | null {
    const d = (devise || 'eur').toLowerCase();
    if (plan === 'pro') return d === 'usd' && this.priceProUsd ? this.priceProUsd : this.pricePro || null;
    if (plan === 'business') return this.priceBusiness || null;
    return null;
  }

  private planForPrice(priceId: string | null | undefined): string | null {
    if (priceId && (priceId === this.pricePro || priceId === this.priceProUsd)) return 'pro';
    if (priceId && priceId === this.priceBusiness) return 'business';
    return null;
  }

  /** Un essai par compte, jamais deux : on regarde l'historique complet (pas seulement
   * l'abonnement en cours). Un essai LOCAL (sans carte) ne compte pas. */
  async aDejaEuUnAbonnement(telegramId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.subscriptions.findMany({
        where: { user_id: telegramId },
        select: { status: true },
        take: 5,
      });
      return rows.some((r) => ['active', 'past_due', 'canceled'].includes(r.status));
    } catch (e) {
      this.logger.warn(`aDejaEuUnAbonnement ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  private optionsTva(): Record<string, unknown> {
    if (!this.autoTax) return {};
    return {
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true, required: 'if_supported' },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
    };
  }

  /** Session d'abonnement Stripe. essaiJours > 0 : carte saisie, rien prélevé — Stripe crée
   * l'abonnement en « trialing » et déclenche lui-même le premier prélèvement au terme. */
  async createCheckout(telegramId: string, plan: string, essaiJours = 0): Promise<CheckoutResult> {
    if (!this.ready) return { ok: false, error: 'Paiement indisponible : Stripe non configuré (contacte le support).' };
    const price = this.priceFor(plan);
    if (!price) return { ok: false, error: 'Offre inconnue.' };
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true, email: true } });
    let customer = row?.stripe_customer_id ?? undefined;
    try {
      if (!customer) {
        const c = await this.stripe!.customers.create({ email: row?.email || undefined, metadata: { telegram_id: telegramId } });
        customer = c.id;
        await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { stripe_customer_id: customer } });
      }
      const params: Record<string, unknown> = {
        mode: 'subscription',
        customer,
        line_items: [{ price, quantity: 1 }],
        success_url: `${this.frontendUrl}/dashboard/parametres?paiement=ok`,
        cancel_url: `${this.frontendUrl}/dashboard/parametres?paiement=annule`,
        client_reference_id: telegramId,
        metadata: { telegram_id: telegramId, plan },
        subscription_data: {
          metadata: { telegram_id: telegramId, plan },
          ...(essaiJours ? { trial_period_days: essaiJours } : {}),
        },
        // « always » et non « if_required » : sans cela Stripe n'exige pas la carte quand
        // la première facture est à zéro — c'est tout l'objet de l'essai avec carte.
        ...(essaiJours ? { payment_method_collection: 'always' } : {}),
        allow_promotion_codes: true,
        ...this.optionsTva(),
      };
      const sess = await this.stripe!.checkout.sessions.create(params as unknown as Stripe.Checkout.SessionCreateParams);
      return { ok: true, url: sess.url ?? undefined };
    } catch (e) {
      this.logger.error(`stripe checkout error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Impossible de créer la session de paiement.' };
    }
  }

  async createPortal(telegramId: string): Promise<CheckoutResult> {
    if (!this.ready) return { ok: false, error: 'Stripe non configuré.' };
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true } });
    const customer = row?.stripe_customer_id;
    if (!customer) return { ok: false, error: 'Aucun abonnement à gérer.' };
    try {
      const sess = await this.stripe!.billingPortal.sessions.create({ customer, return_url: `${this.frontendUrl}/dashboard/parametres` });
      return { ok: true, url: sess.url };
    } catch (e) {
      this.logger.error(`stripe portal error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Portail indisponible.' };
    }
  }

  /** Factures Stripe du compte (les plus récentes) : date, montant, statut, PDF, lien. */
  async listInvoices(telegramId: string): Promise<InvoiceItem[]> {
    if (!this.ready) return [];
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true } });
    const customer = row?.stripe_customer_id;
    if (!customer) return [];
    let invs: Stripe.ApiList<Stripe.Invoice>;
    try {
      invs = await this.stripe!.invoices.list({ customer, limit: 24 });
    } catch (e) {
      this.logger.error(`list_invoices error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
    const out: InvoiceItem[] = [];
    for (const i of invs.data || []) {
      if (i.status === 'draft' && !(i.amount_due || i.total)) continue;
      out.push({
        number: i.number,
        date: this.tsIso(i.created),
        amount: (i.amount_paid || i.total || 0) / 100,
        currency: (i.currency || 'eur').toUpperCase(),
        status: i.status,
        pdf: i.invoice_pdf ?? null,
        url: i.hosted_invoice_url ?? null,
      });
    }
    return out;
  }

  /** [ADMIN] Toutes les factures du compte Stripe (auto-paginé), enrichies du client. */
  async listAllInvoices(limit = 500): Promise<AdminInvoiceItem[]> {
    if (!this.ready) return [];
    const rows = await this.prisma.users.findMany({ select: { telegram_id: true, nom: true, email: true, stripe_customer_id: true } });
    const byCust = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (r.stripe_customer_id) byCust.set(r.stripe_customer_id, r);
    const out: AdminInvoiceItem[] = [];
    try {
      for await (const i of this.stripe!.invoices.list({ limit: 100 })) {
        if (out.length >= limit) break;
        if (i.status === 'draft' && !(i.amount_due || i.total)) continue;
        const custId = typeof i.customer === 'string' ? i.customer : i.customer?.id;
        const u = (custId && byCust.get(custId)) || undefined;
        const ix = i as unknown as { customer_name?: string; customer_email?: string };
        out.push({
          number: i.number,
          date: this.tsIso(i.created),
          amount: (i.amount_paid || i.total || 0) / 100,
          currency: (i.currency || 'eur').toUpperCase(),
          status: i.status,
          pdf: i.invoice_pdf ?? null,
          url: i.hosted_invoice_url ?? null,
          client: u?.nom || ix.customer_name || ix.customer_email || '—',
          email: u?.email || ix.customer_email,
          telegram_id: u?.telegram_id ?? null,
        });
      }
    } catch (e) {
      this.logger.error(`list_all_invoices error: ${e instanceof Error ? e.message : e}`);
    }
    return out;
  }

  private async proPlanId(): Promise<string | null> {
    const p = await this.prisma.plans.findFirst({ where: { name: 'Pro' } });
    return p?.id ?? null;
  }

  private async essaiPlanId(): Promise<string | null> {
    const p = await this.prisma.plans.findFirst({ where: { name: 'Essai' } });
    return p?.id ?? null;
  }

  /** En essai, quotas VOLONTAIREMENT limités (plan Essai) ; dès le premier prélèvement
   * (statut « active »), le compte bascule sur les quotas Pro complets. */
  private async planSelonStatut(status: string): Promise<string | null> {
    if (status === 'trialing') {
      const essai = await this.essaiPlanId();
      if (essai) return essai;
    }
    return this.proPlanId();
  }

  private ts(v: number | null | undefined): Date | null {
    return v ? new Date(v * 1000) : null;
  }

  private tsIso(v: number | null | undefined): string | null {
    return v ? new Date(v * 1000).toISOString() : null;
  }

  private formatDateFr(d: Date): string {
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  }

  /** Écrit l'abonnement dans `subscriptions` (source de vérité des quotas). Le PLAN suit le
   * statut : quotas Essai pendant l'essai, quotas Pro au premier prélèvement. */
  private async upsertSubscription(
    uid: string,
    status: string,
    periodStart: Date | null,
    periodEnd: Date | null,
    stripeSubId: string | null | undefined,
  ): Promise<void> {
    const planId = await this.planSelonStatut(status);
    if (!planId) {
      this.logger.warn('stripe: offre Pro/Essai absente de la table plans');
      return;
    }
    const row: Record<string, unknown> = { plan_id: planId, status, stripe_subscription_id: stripeSubId };
    if (periodStart) row.current_period_start = periodStart;
    if (periodEnd) row.current_period_end = periodEnd;

    const existing = await this.prisma.subscriptions.findFirst({
      where: { user_id: uid },
      orderBy: { created_at: 'desc' },
      include: { plans: true },
    });
    if (existing) {
      // Un compte suspendu par le cron (réseaux déconnectés) le reste tant que Stripe ne
      // signale qu'un past_due : sinon le cron le re-suspendrait en boucle.
      if (existing.status === 'suspended' && status === 'past_due') row.status = 'suspended';
      // Un compte Boss (interne) garde son plan et reste actif.
      if (existing.plans?.name === 'Boss') {
        delete row.plan_id;
        if (status === 'past_due' || status === 'suspended') row.status = 'active';
      }
      await this.prisma.subscriptions.update({ where: { id: existing.id }, data: row as never });
    } else if (periodEnd) {
      row.user_id = uid;
      await this.prisma.subscriptions.create({ data: row as never });
    }
  }

  /** Reflète l'état de l'abonnement Stripe dans `subscriptions` (pilote les quotas). */
  private async applySubscription(
    sub: Stripe.Subscription,
  ): Promise<{ uid: string; status: string; newlyCanceling: boolean; cancelAt: Date | null } | null> {
    const s = sub as unknown as Record<string, unknown>;
    const meta = sub.metadata || {};
    const tg = meta.telegram_id;
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const status = STATUS_MAP[sub.status] ?? 'past_due';

    // TODO (DemarrageService sans état dans ce portage — pas de cache à invalider) :
    // équivalent no-op de `demarrage_service.oublier(tg)`.

    let uid: string | null = null;
    if (tg) {
      const u = await this.prisma.users.findUnique({ where: { telegram_id: tg } });
      if (u) uid = u.telegram_id;
    }
    if (!uid && customer) {
      const u = await this.prisma.users.findFirst({ where: { stripe_customer_id: customer } });
      if (u) uid = u.telegram_id;
    }
    if (!uid) {
      this.logger.warn('stripe webhook: utilisateur introuvable');
      return null;
    }

    let ps = this.ts(s.current_period_start as number | undefined);
    let pe = this.ts(s.current_period_end as number | undefined);
    // API Stripe récente : current_period_start/end vit désormais sur les ITEMS.
    if (!pe) {
      const items = sub.items?.data || [];
      if (items.length) {
        const it = items[0] as unknown as Record<string, unknown>;
        ps = this.ts(it.current_period_start as number | undefined) || ps;
        pe = this.ts(it.current_period_end as number | undefined) || pe;
      }
    }
    await this.upsertSubscription(uid, status, ps, pe, sub.id);

    let cancelTs = s.cancel_at as number | undefined;
    if (!cancelTs && sub.cancel_at_period_end) {
      const items = sub.items?.data || [];
      cancelTs = (s.current_period_end as number | undefined) ?? ((items[0] as unknown as Record<string, unknown>)?.current_period_end as number | undefined);
    }
    const cancelAt = this.ts(cancelTs);

    const actif = status === 'active' || status === 'trialing';
    const prev = await this.prisma.subscriptions.findFirst({
      where: { user_id: uid },
      orderBy: { created_at: 'desc' },
      select: { cancel_at: true },
    });
    const wasCanceling = Boolean(prev?.cancel_at);
    const newlyCanceling = Boolean(cancelAt) && actif && !wasCanceling;

    try {
      await this.prisma.subscriptions.updateMany({ where: { user_id: uid }, data: { cancel_at: actif ? cancelAt : null } });
    } catch (e) {
      this.logger.warn(`stripe: date de résiliation non enregistrée pour ${uid}: ${e instanceof Error ? e.message : e}`);
    }
    this.logger.log(`stripe: ${uid} -> ${status}${cancelAt ? ' (résiliation programmée)' : ''}`);
    return { uid, status, newlyCanceling, cancelAt };
  }

  /** {telegram_id: {...}} pour tous les comptes, en une requête. `subscriptions` fait
   * autorité — c'est elle qui gouverne les quotas. */
  async abonnements(): Promise<Record<string, AbonnementInfo>> {
    let subs: Array<
      Pick<SubscriptionRow, 'user_id' | 'status' | 'current_period_end' | 'cancel_at' | 'stripe_subscription_id' | 'plan_id' | 'created_at'>
    >;
    let tarifs: Map<string, { id: string; name: string; price_cents: number }>;
    try {
      subs = await this.prisma.subscriptions.findMany({
        select: { user_id: true, status: true, current_period_end: true, cancel_at: true, stripe_subscription_id: true, plan_id: true, created_at: true },
        orderBy: { created_at: 'desc' },
      });
      const plans = await this.prisma.plans.findMany({ select: { id: true, name: true, price_cents: true } });
      tarifs = new Map(plans.map((p) => [p.id, p]));
    } catch (e) {
      this.logger.error(`lecture abonnements: ${e instanceof Error ? e.message : e}`);
      return {};
    }
    const parUser: Record<string, AbonnementInfo> = {};
    for (const s of subs) {
      if (parUser[s.user_id]) continue; // trié par date : on garde le plus récent
      const p = tarifs.get(s.plan_id);
      const actif = s.status === 'active' || s.status === 'trialing';
      parUser[s.user_id] = {
        plan: p?.name || 'Essai',
        prix_cents: s.status === 'active' ? p?.price_cents || 0 : 0,
        statut: s.status,
        renouvelle_le: s.current_period_end,
        resilie_le: s.cancel_at,
        stripe_subscription_id: actif ? s.stripe_subscription_id : null,
      };
    }
    return parUser;
  }

  async abonnement(telegramId: string): Promise<AbonnementInfo> {
    const all = await this.abonnements();
    return (
      all[telegramId] ?? {
        plan: 'Essai',
        prix_cents: 0,
        statut: null,
        renouvelle_le: null,
        resilie_le: null,
        stripe_subscription_id: null,
      }
    );
  }

  async listPacks(actionType?: string): Promise<PackListItem[]> {
    try {
      return await this.prisma.credit_packs.findMany({
        where: { is_active: true, ...(actionType ? { action_type: actionType } : {}) },
        select: { id: true, action_type: true, name: true, quantity: true, price_cents: true },
        orderBy: { price_cents: 'asc' },
      });
    } catch (e) {
      this.logger.error(`list_packs error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Paiement unique (one-time) pour un pack -> à la confirmation, +quota via webhook. */
  async createPackCheckout(telegramId: string, packId: string): Promise<CheckoutResult> {
    if (!this.ready) return { ok: false, error: 'Paiement indisponible : Stripe non configuré (contacte le support).' };
    const p = await this.prisma.credit_packs.findFirst({ where: { id: packId, is_active: true } });
    if (!p) return { ok: false, error: 'Pack inconnu.' };
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true, email: true } });
    let customer = u?.stripe_customer_id ?? undefined;
    try {
      if (!customer) {
        const c = await this.stripe!.customers.create({ email: u?.email || undefined, metadata: { telegram_id: telegramId } });
        customer = c.id;
        await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { stripe_customer_id: customer } });
      }
      const sess = await this.stripe!.checkout.sessions.create({
        mode: 'payment',
        customer,
        line_items: [{ price_data: { currency: 'eur', unit_amount: p.price_cents, product_data: { name: p.name } }, quantity: 1 }],
        success_url: `${this.frontendUrl}/dashboard?pack=ok`,
        cancel_url: `${this.frontendUrl}/dashboard?pack=annule`,
        metadata: { telegram_id: telegramId, pack_id: p.id, action_type: p.action_type, quantity: String(p.quantity) },
      });
      return { ok: true, url: sess.url ?? undefined };
    } catch (e) {
      this.logger.error(`pack checkout error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Impossible de créer la session de paiement.' };
    }
  }

  /** La monnaie de facturation d'un client. Le fuseau prime (désigne un pays) ; la langue
   * ne sert que de repli quand le fuseau est inconnu. */
  deviseDuMarche(langue?: string | null, fuseau?: string | null): string {
    const f = (fuseau || '').trim();
    if (CONTINENT_DOLLAR.some((c) => f.startsWith(c))) return 'usd';
    if (CONTINENT_EURO.some((c) => f.startsWith(c))) return 'eur';
    return (langue || '').toLowerCase().startsWith('es') ? 'usd' : 'eur';
  }

  /** Crée un lien de paiement du Pack Fondations, à envoyer après le call. */
  async lienPack(params: { email?: string; telegram_id?: string; affilie?: string; devise?: string; langue?: string }): Promise<LienPackResult> {
    if (!this.ready) return { ok: false, error: 'Stripe non configuré.' };

    let devise = (params.devise || this.deviseDuMarche(params.langue)).toLowerCase();
    let price = this.packPrix[devise];

    let row: { stripe_customer_id: string | null; email: string | null; langue: string; timezone: string | null } | null = null;
    if (params.telegram_id) {
      row = await this.prisma.users.findUnique({
        where: { telegram_id: params.telegram_id },
        select: { stripe_customer_id: true, email: true, langue: true, timezone: true },
      });
      if (!params.devise && (row?.timezone || row?.langue)) {
        devise = this.deviseDuMarche(row?.langue, row?.timezone);
        price = this.packPrix[devise];
      }
    }
    if (!price) {
      return { ok: false, error: `Aucun prix configuré en ${devise.toUpperCase()} (STRIPE_PRICE_PACK_${devise.toUpperCase()} manquant).` };
    }
    const email = params.email || row?.email || undefined;

    const meta: Record<string, string> = { produit: 'fondations' };
    if (params.telegram_id) meta.telegram_id = String(params.telegram_id);
    if (params.affilie) meta.affilie = params.affilie.trim().toUpperCase();

    try {
      // La carte est ENREGISTRÉE au passage (setup_future_usage) : permet de déclencher
      // l'abonnement plus tard sans redemander la carte. customer_creation et customer sont
      // mutuellement exclusifs en mode paiement, d'où l'aiguillage.
      const clientOpt: Record<string, unknown> = row?.stripe_customer_id
        ? { customer: row.stripe_customer_id }
        : { customer_creation: 'always', ...(email ? { customer_email: email } : {}) };
      const params2: Record<string, unknown> = {
        mode: 'payment',
        line_items: [{ price, quantity: 1 }],
        payment_intent_data: { setup_future_usage: 'off_session', metadata: meta },
        success_url: `${this.frontendUrl}/dashboard?pack=ok`,
        cancel_url: `${this.frontendUrl}/tarifs?pack=annule`,
        metadata: meta,
        client_reference_id: params.telegram_id ? String(params.telegram_id) : undefined,
        ...clientOpt,
      };
      const sess = await this.stripe!.checkout.sessions.create(params2 as unknown as Stripe.Checkout.SessionCreateParams);
      return { ok: true, url: sess.url ?? undefined, devise: devise.toUpperCase(), expire_le: sess.expires_at };
    } catch (e) {
      this.logger.error(`lien pack fondations: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Impossible de créer le lien de paiement.' };
    }
  }

  /** Retient l'identifiant client Stripe sur le compte. Le Pack se paie souvent AVANT que
   * le compte existe : on rattrape alors par l'email. */
  private async lierClientStripe(telegramId: string | null | undefined, email: string | null | undefined, customer: string | null | undefined): Promise<void> {
    if (!customer) return;
    try {
      if (telegramId) {
        await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { stripe_customer_id: customer } });
      } else if (email) {
        await this.prisma.users.updateMany({ where: { email: email.toLowerCase() }, data: { stripe_customer_id: customer } });
      }
    } catch (e) {
      this.logger.warn(`lier client stripe: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Ce que le back-office a besoin de savoir avant de déclencher l'abonnement. */
  async carteEnregistree(telegramId: string): Promise<CarteEnregistreeResult> {
    if (!this.ready) return { ok: false, error: 'Stripe non configuré.' };
    const r = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true } });
    const cust = r?.stripe_customer_id;
    if (!cust) return { ok: true, carte: null, abonnement: null };
    try {
      const pms = await this.stripe!.customers.listPaymentMethods(cust, { type: 'card', limit: 1 });
      let carte: CarteEnregistreeResult['carte'] = null;
      if (pms.data.length) {
        const c = pms.data[0].card;
        carte = c ? { marque: c.brand, fin: c.last4, expire: `${String(c.exp_month).padStart(2, '0')}/${c.exp_year}` } : null;
      }
      const subs = await this.stripe!.subscriptions.list({ customer: cust, status: 'all', limit: 1 });
      const abo = subs.data.length ? subs.data[0].status : null;
      return { ok: true, carte, abonnement: abo };
    } catch (e) {
      this.logger.error(`carte_enregistree: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Lecture Stripe impossible.' };
    }
  }

  /** Déclenche l'abonnement Pro sur la carte laissée au paiement du Pack. Aucun essai : ce
   * client a payé, il entre directement en facturation, hors la présence du client. */
  async demarrerAbonnement(telegramId: string, devise?: string): Promise<DemarrerAbonnementResult> {
    if (!this.ready) return { ok: false, error: 'Stripe non configuré.' };
    const r = await this.prisma.users.findUnique({
      where: { telegram_id: telegramId },
      select: { stripe_customer_id: true, email: true, langue: true, timezone: true },
    });
    if (!r) return { ok: false, error: 'Compte introuvable.' };
    const cust = r.stripe_customer_id;
    if (!cust) return { ok: false, error: "Ce compte n'a jamais payé par Stripe — aucune carte à utiliser." };

    const dev = (devise || this.deviseDuMarche(r.langue, r.timezone)).toLowerCase();
    const price = this.priceFor('pro', dev);
    if (!price) return { ok: false, error: "Aucun prix d'abonnement configuré." };

    try {
      const deja = await this.stripe!.subscriptions.list({ customer: cust, status: 'all', limit: 10 });
      const vivant = deja.data.find((x) => ['active', 'trialing', 'past_due', 'suspended'].includes(x.status));
      if (vivant && vivant.status === 'trialing') {
        // Cas normal depuis que l'abonnement naît avec le Pack : on ÉCOURTE l'attente.
        const sub = await this.stripe!.subscriptions.update(vivant.id, { trial_end: 'now' });
        await this.applySubscription(sub);
        return { ok: true, status: sub.status, devise: '—', ecourte: true, prochain_prelevement: null };
      }
      if (vivant) return { ok: false, error: `Ce compte a déjà un abonnement (${vivant.status}).` };

      const pms = await this.stripe!.customers.listPaymentMethods(cust, { type: 'card', limit: 1 });
      if (!pms.data.length) {
        return {
          ok: false,
          error:
            'Aucune carte enregistrée sur ce client. Le Pack a probablement été réglé avant la mise en place ' +
            "de l'enregistrement de carte : envoie-lui un lien d'abonnement.",
        };
      }
      const pm = pms.data[0].id;

      const sub = await this.stripe!.subscriptions.create({
        customer: cust,
        items: [{ price }],
        default_payment_method: pm,
        off_session: true,
        metadata: { telegram_id: String(telegramId), origine: 'pack_fondations' },
        expand: ['latest_invoice.payment_intent'],
      });
      await this.applySubscription(sub);
      // La date de fin de période a migré vers les ITEMS dans les versions récentes de l'API.
      const s = sub as unknown as Record<string, unknown>;
      let fin = s.current_period_end as number | undefined;
      if (fin == null) {
        const items = sub.items?.data || [];
        fin = items.length ? ((items[0] as unknown as Record<string, unknown>).current_period_end as number | undefined) : undefined;
      }
      return { ok: true, status: sub.status, devise: dev.toUpperCase(), prochain_prelevement: fin ?? null };
    } catch (e) {
      this.logger.error(`demarrer_abonnement ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: `Stripe a refusé : ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
    }
  }

  /** Filet de sécurité : relit l'abonnement Stripe du compte et l'applique. */
  async syncSubscription(telegramId: string): Promise<SyncResult> {
    if (!this.ready) return { ok: false, error: 'Stripe non configuré.' };
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { stripe_customer_id: true } });
    const cust = u?.stripe_customer_id;
    if (!cust) return { ok: true, synced: false };
    try {
      const subs = await this.stripe!.subscriptions.list({ customer: cust, status: 'all', limit: 1 });
      if (subs.data.length) {
        await this.applySubscription(subs.data[0]);
        return { ok: true, synced: true, status: subs.data[0].status };
      }
      return { ok: true, synced: false };
    } catch (e) {
      this.logger.error(`sync_subscription error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Synchronisation impossible.' };
    }
  }

  /** Crédite le quota acheté (extra) sur la période courante du compte. */
  private async applyPack(session: Stripe.Checkout.Session): Promise<void> {
    const meta = session.metadata || {};
    const tg = meta.telegram_id;
    const action = meta.action_type;
    const qty = parseInt(meta.quantity || '0', 10) || 0;
    if (!(tg && action && qty > 0)) return;
    const sub = await this.prisma.subscriptions.findFirst({
      where: { user_id: tg, status: { in: ['trialing', 'active', 'past_due', 'suspended'] } },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    if (!sub) {
      this.logger.warn(`pack: aucun abonnement pour ${tg}`);
      return;
    }
    try {
      await this.prisma.$executeRaw`SELECT add_extra_quota(${sub.id}::uuid, ${action}, ${qty}::int)`;
      this.logger.log(`pack: +${qty} ${action} pour ${tg}`);
    } catch (e) {
      this.logger.error(`add_extra_quota: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async uidByCustomer(customer: string | null | undefined): Promise<string | null> {
    if (!customer) return null;
    try {
      const r = await this.prisma.users.findFirst({ where: { stripe_customer_id: customer }, select: { telegram_id: true } });
      return r?.telegram_id ?? null;
    } catch {
      return null;
    }
  }

  /** Le motif exact du refus (carte insuffisante, expirée...), pour l'email admin. */
  private async raisonEchecPaiement(invoiceId: string | null | undefined): Promise<string | null> {
    if (!invoiceId) return null;
    try {
      const inv = await this.stripe!.invoices.retrieve(invoiceId, {}, { apiVersion: '2024-06-20' });
      const chargeId = (inv as unknown as { charge?: string }).charge;
      if (!chargeId) return null;
      const ch = await this.stripe!.charges.retrieve(chargeId);
      return ch.failure_message || ch.failure_code || null;
    } catch (e) {
      this.logger.warn(`raison echec paiement ${invoiceId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Insère l'événement dans evenements_stripe ; true si l'id y était déjà (doublon Stripe).
   * Une erreur technique laisse passer : on préfère un doublon rare à un webhook bloqué. */
  private async dejaTraite(eventId: string | undefined, etype: string): Promise<boolean> {
    if (!eventId) return false;
    try {
      await this.prisma.evenements_stripe.create({ data: { stripe_event_id: eventId, type: etype } });
      return false;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'P2002') {
        this.logger.log(`stripe webhook: doublon ignoré ${eventId} (${etype})`);
        return true;
      }
      this.logger.warn(`stripe webhook: idempotence indisponible (${e instanceof Error ? e.message : e})`);
      return false;
    }
  }

  private async clientImpayePayload(uid: string, lienFacture?: string | null): Promise<ClientImpayePayload | null> {
    let u: { nom: string | null; email: string | null } | null = null;
    try {
      u = await this.prisma.users.findUnique({ where: { telegram_id: uid }, select: { nom: true, email: true } });
    } catch {
      u = null;
    }
    if (!u?.email) return null;
    return { nom: u.nom, email: u.email, lien: lienFacture || `${this.frontendUrl}/dashboard/parametres?s=abonnement` };
  }

  /** Infos pour l'email admin. Le plan se lit via `abonnements()` de ce service — même
   * source de vérité que le Python (admin_service._abonnements()) n'est pas porté. */
  private async notifyPayload(uid: string | null | undefined, kind: string, extra?: string | null): Promise<NotifyPayload | null> {
    if (!uid) return null;
    let u: { nom: string | null; email: string | null } | null = null;
    try {
      u = await this.prisma.users.findUnique({ where: { telegram_id: uid }, select: { nom: true, email: true } });
    } catch {
      u = null;
    }
    const plan = (await this.abonnement(uid)).plan;
    return { kind, nom: u?.nom ?? null, email: u?.email, plan, extra };
  }

  /** None si le client est introuvable, sans email, ou si le montant est nul (essai). */
  private async facturePayload(
    uid: string | null | undefined,
    montantCents: number | null | undefined,
    devise: string | null | undefined,
    libelle: string,
    numero?: string | null,
    url?: string | null,
    pdf?: string | null,
  ): Promise<FacturePayload | null> {
    if (!uid || !montantCents) return null;
    let u: { nom: string | null; email: string | null } | null = null;
    try {
      u = await this.prisma.users.findUnique({ where: { telegram_id: uid }, select: { nom: true, email: true } });
    } catch {
      u = null;
    }
    if (!u?.email) return null;
    return {
      nom: u.nom,
      email: u.email,
      montant: montantCents / 100,
      devise: (devise || 'eur').toUpperCase(),
      libelle,
      numero: numero ?? null,
      url: url ?? null,
      pdf: pdf ?? null,
    };
  }

  /** Crée la commission d'affiliation liée à un encaissement (setup 25% sur le Pack
   * Fondations, récurrente 10% chaque mensualité). Isolé et silencieux : une erreur
   * d'affiliation ne doit jamais empêcher l'activation d'un abonnement ni l'envoi d'une
   * facture. */
  private commission(
    type_: 'setup' | 'recurrent',
    refId: unknown,
    montantCents: number | null | undefined,
    devise: string | null | undefined,
    telegramId?: string | null,
    email?: string | null,
    libelle?: string,
    codeAffilie?: string | null,
  ): void {
    this.affiliationService
      .creerCommission(type_, String(refId ?? ''), montantCents, devise, telegramId, email, libelle, codeAffilie)
      .catch((e) => this.logger.warn(`commission affiliation ignorée (${refId}): ${e instanceof Error ? e.message : e}`));
  }

  /** Crée l'abonnement Pro dès l'encaissement du Pack, premier prélèvement différé — c'est
   * STRIPE qui tient le compteur, pas nous (fiable même si le serveur redémarre). */
  private async abonnementApresPack(customer: string | null | undefined, telegramId?: string | null, email?: string | null): Promise<void> {
    if (!customer || this.packDelaiJours <= 0) return;
    try {
      const deja = await this.stripe!.subscriptions.list({ customer, status: 'all', limit: 10 });
      if (deja.data.some((x) => ['active', 'trialing', 'past_due', 'suspended'].includes(x.status))) return;

      const pms = await this.stripe!.customers.listPaymentMethods(customer, { type: 'card', limit: 1 });
      if (!pms.data.length) {
        this.logger.warn(`Pack payé sans carte enregistrée (${customer}) — abonnement non créé`);
        return;
      }

      let row: { telegram_id: string | null; langue: string | null; timezone: string | null } | null = null;
      if (telegramId || email) {
        row = telegramId
          ? await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { telegram_id: true, langue: true, timezone: true } })
          : await this.prisma.users.findFirst({ where: { email: (email || '').toLowerCase() }, select: { telegram_id: true, langue: true, timezone: true } });
      }
      const devise = this.deviseDuMarche(row?.langue, row?.timezone);
      const price = this.priceFor('pro', devise);
      if (!price) return;

      const sub = await this.stripe!.subscriptions.create({
        customer,
        items: [{ price }],
        default_payment_method: pms.data[0].id,
        trial_period_days: this.packDelaiJours,
        metadata: { telegram_id: String(row?.telegram_id || telegramId || ''), origine: 'pack_fondations' },
      });
      await this.applySubscription(sub);
      this.logger.log(`Abonnement créé après le Pack (${customer}) — premier prélèvement dans ${this.packDelaiJours} jours, en ${devise.toUpperCase()}`);
    } catch (e) {
      this.logger.error(`_abonnement_apres_pack ${customer}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async rappelPayload(sub: Stripe.Subscription): Promise<RappelPayload | null> {
    const custId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const uid = await this.uidByCustomer(custId);
    if (!uid) return null;
    try {
      const u = await this.prisma.users.findUnique({ where: { telegram_id: uid }, select: { email: true, nom: true } });
      if (!u?.email) return null;
      const items = sub.items?.data || [];
      const prix = items.length ? items[0].price : null;
      const fin = sub.trial_end;
      return {
        email: u.email,
        nom: u.nom,
        montant: (prix?.unit_amount || 0) / 100,
        devise: (prix?.currency || 'eur').toUpperCase(),
        date: fin ? this.formatDateFr(new Date(fin * 1000)) : '',
        apres_pack: (sub.metadata || {}).origine === 'pack_fondations',
      };
    } catch (e) {
      this.logger.warn(`_rappel_payload: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Raison de résiliation lisible ; re-fetch l'abonnement si le webhook n'a pas encore le
   * feedback au moment T. */
  private async cancelReason(sub: Stripe.Subscription): Promise<string> {
    let cd = sub.cancellation_details;
    if (!cd?.feedback && !cd?.comment) {
      try {
        const fresh = await this.stripe!.subscriptions.retrieve(sub.id);
        cd = fresh.cancellation_details ?? cd;
      } catch {
        // best-effort
      }
    }
    return (cd?.feedback && CANCEL_FEEDBACK[cd.feedback]) || cd?.comment || 'non précisée';
  }

  /** Enregistre la raison DÈS QU'ELLE EST DONNÉE, avant toute décision (ouvre le parcours
   * de départ — sinon quelqu'un qui reste finalement ne laisse aucune trace). */
  async ouvrirParcours(telegramId: string, raison: string, commentaire?: string): Promise<OuvrirParcoursResult> {
    const r = RAISONS.has(raison) ? raison : 'autre';
    try {
      const row = await this.prisma.resiliations.create({
        data: { telegram_id: telegramId, raison: r, commentaire: (commentaire || '').trim().slice(0, 2000) || null, issue: 'entamee' },
        select: { id: true },
      });
      return { ok: true, id: row.id };
    } catch (e) {
      this.logger.warn(`ouverture du parcours (${telegramId}) : ${e instanceof Error ? e.message : e}`);
      return { ok: true, id: null }; // jamais bloquant
    }
  }

  /** Note l'issue du parcours (partie/retenue/pause). Une erreur ici ne doit jamais
   * empêcher la résiliation elle-même. */
  private async journalDepart(
    telegramId: string,
    raison: string | null | undefined,
    commentaire: string | null | undefined,
    issue = 'partie',
    detail?: string | null,
    fin?: Date | string | null,
    parcours?: string | null,
  ): Promise<void> {
    const champs = { issue, detail: detail ?? null, fin_acces_le: fin ?? null };
    try {
      if (parcours) {
        await this.prisma.resiliations.updateMany({ where: { id: parcours, telegram_id: telegramId }, data: champs as never });
        return;
      }
      await this.prisma.resiliations.create({
        data: {
          telegram_id: telegramId,
          raison: raison || 'autre',
          commentaire: (commentaire || '').trim().slice(0, 2000) || null,
          ...champs,
        } as never,
      });
    } catch (e) {
      this.logger.warn(`journal de départ (${telegramId}) : ${e instanceof Error ? e.message : e}`);
    }
  }

  private async abonnementCourant(telegramId: string): Promise<[SubscriptionRow | null, Stripe.Subscription | null]> {
    const ligne = await this.prisma.subscriptions.findFirst({
      where: { user_id: telegramId, status: { in: ['active', 'trialing', 'past_due', 'suspended'] } },
      orderBy: { created_at: 'desc' },
    });
    if (!ligne) return [null, null];
    const sid = ligne.stripe_subscription_id;
    if (!sid || !this.ready) return [ligne, null];
    try {
      const sub = await this.stripe!.subscriptions.retrieve(sid);
      return [ligne, sub];
    } catch (e) {
      this.logger.error(`lecture abonnement ${sid}: ${e instanceof Error ? e.message : e}`);
      return [ligne, null];
    }
  }

  /** Arrête le renouvellement. L'accès reste ouvert jusqu'au terme déjà payé : rien n'est
   * supprimé ni coupé tout de suite (la période a été réglée, elle est due). */
  async resilier(telegramId: string, raison: string, commentaire?: string, parcours?: string): Promise<ResilierResult> {
    const [ligne, sub] = await this.abonnementCourant(telegramId);
    if (!ligne) return { ok: false, error: 'Aucun abonnement à résilier.' };
    const r = RAISONS.has(raison) ? raison : 'autre';

    let fin: Date | string | null = ligne.current_period_end;
    if (sub) {
      try {
        const maj = await this.stripe!.subscriptions.update(sub.id, { cancel_at_period_end: true });
        const cancelAtTs = (maj as unknown as Record<string, unknown>).cancel_at as number | undefined;
        fin = this.ts(cancelAtTs) || fin;
        await this.applySubscription(maj);
      } catch (e) {
        this.logger.error(`resiliation ${telegramId}: ${e instanceof Error ? e.message : e}`);
        return { ok: false, error: 'Résiliation impossible pour le moment.' };
      }
    } else {
      // Abonnement local (aucun identifiant Stripe) : on le termine chez nous.
      try {
        await this.prisma.subscriptions.update({ where: { id: ligne.id }, data: { status: 'canceled' } });
      } catch (e) {
        this.logger.error(`resiliation locale ${telegramId}: ${e instanceof Error ? e.message : e}`);
        return { ok: false, error: 'Résiliation impossible pour le moment.' };
      }
    }

    await this.journalDepart(telegramId, r, commentaire, 'partie', null, fin, parcours);
    return { ok: true, fin_acces_le: fin };
  }

  /** Suspend la facturation ET l'accès, un à trois mois. Config (marque, gabarits) conservée
   * — l'accès est suspendu, sinon la pause serait un abonnement gratuit. */
  async mettreEnPause(telegramId: string, mois: number, raison?: string, commentaire?: string, parcours?: string): Promise<PauseResult> {
    const m = Math.max(1, Math.min(PAUSE_MOIS_MAX, Math.trunc(mois || 1)));
    const [ligne, sub] = await this.abonnementCourant(telegramId);
    if (!ligne) return { ok: false, error: 'Aucun abonnement à mettre en pause.' };
    if (!sub) return { ok: false, error: 'Pause indisponible sur cet abonnement.' };

    const reprise = new Date(Date.now() + 30 * m * 24 * 60 * 60 * 1000);
    try {
      await this.stripe!.subscriptions.update(sub.id, {
        pause_collection: { behavior: 'void', resumes_at: Math.floor(reprise.getTime() / 1000) },
      } as unknown as Stripe.SubscriptionUpdateParams);
    } catch (e) {
      this.logger.error(`pause ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Mise en pause impossible pour le moment.' };
    }

    try {
      await this.prisma.subscriptions.update({ where: { id: ligne.id }, data: { pause_jusqu_au: reprise } });
    } catch (e) {
      // La colonne manque (migration non passée) : Stripe a déjà suspendu la facturation,
      // mais nous ne saurions pas bloquer l'accès -> on revient en arrière.
      this.logger.error(`pause : colonne pause_jusqu_au absente (${e instanceof Error ? e.message : e}) — annulation`);
      try {
        await this.stripe!.subscriptions.update(sub.id, { pause_collection: '' } as unknown as Stripe.SubscriptionUpdateParams);
      } catch {
        // best-effort
      }
      return { ok: false, error: 'Pause indisponible (configuration incomplète).' };
    }

    await this.journalDepart(telegramId, raison || 'autre', commentaire, 'pause', `${m} mois`, reprise.toISOString(), parcours);
    return { ok: true, reprise_le: reprise.toISOString(), mois: m };
  }

  /** Le parcours s'arrête parce que la personne RESTE, sans prendre d'offre. */
  async noterRetenue(telegramId: string, parcours?: string, detail?: string): Promise<{ ok: true }> {
    await this.journalDepart(telegramId, null, null, 'retenue', detail, null, parcours);
    return { ok: true };
  }

  /** Reprend un compte en pause, ou annule une résiliation programmée. Un seul geste. */
  async reprendre(telegramId: string): Promise<{ ok: boolean; error?: string }> {
    const [ligne, sub] = await this.abonnementCourant(telegramId);
    if (!ligne) return { ok: false, error: 'Aucun abonnement à reprendre.' };
    if (sub) {
      try {
        await this.stripe!.subscriptions.update(sub.id, {
          pause_collection: '',
          cancel_at_period_end: false,
        } as unknown as Stripe.SubscriptionUpdateParams);
      } catch (e) {
        this.logger.error(`reprise ${telegramId}: ${e instanceof Error ? e.message : e}`);
        return { ok: false, error: 'Reprise impossible pour le moment.' };
      }
    }
    try {
      await this.prisma.subscriptions.update({ where: { id: ligne.id }, data: { pause_jusqu_au: null } });
    } catch (e) {
      this.logger.warn(`reprise (colonne pause) ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    return { ok: true };
  }

  /** Traite un webhook Stripe déjà vérifié par le contrôleur (signature valide). */
  async handleWebhook(payloadBytes: Buffer, signature: string | undefined): Promise<WebhookResult> {
    if (!this.ready) return { ok: false };
    // Fail-closed : sans secret configuré, on REFUSE (jamais de payload non signé -> pas de faux abo).
    if (!this.webhookSecret) {
      this.logger.error('stripe webhook reçu mais STRIPE_WEBHOOK_SECRET absent -> rejeté');
      return { ok: false, error: 'webhook non configuré' };
    }
    let event: Stripe.Event;
    try {
      event = this.stripe!.webhooks.constructEvent(payloadBytes, signature || '', this.webhookSecret);
    } catch (e) {
      this.logger.warn(`stripe webhook signature invalide: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'bad signature' };
    }

    const etype = event.type;
    if (await this.dejaTraite(event.id, etype)) {
      return { ok: true, event: etype, duplicate: true };
    }
    const obj = event.data.object as unknown;
    let canceledUid: string | null = null;
    let clientImpaye: ClientImpayePayload | null = null;
    let notify: NotifyPayload | null = null;
    let facture: FacturePayload | null = null;
    let rappel: RappelPayload | null = null;

    try {
      if (etype === 'checkout.session.completed') {
        const session = obj as Stripe.Checkout.Session;
        const meta = session.metadata || {};
        if (meta.pack_id) {
          await this.applyPack(session);
          notify = await this.notifyPayload(meta.telegram_id, 'pack', meta.action_type);
          // Reçu client : les packs (paiement one-time) n'ont pas de facture Stripe, on
          // envoie le reçu depuis la session.
          facture = await this.facturePayload(meta.telegram_id, session.amount_total, session.currency, `Pack ${meta.action_type || 'crédits'}`);
        } else if (['fondations', 'pack_fondations'].includes((meta.produit || '').toLowerCase())) {
          const custEmail = session.customer_details?.email ?? undefined;
          const custId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          // Commission setup (25%) : code de l'affilié déposé dans la metadata du lien.
          this.commission('setup', session.id, session.amount_total, session.currency, meta.telegram_id, custEmail, 'Pack Fondations', meta.affilie);
          await this.lierClientStripe(meta.telegram_id, custEmail, custId);
          await this.abonnementApresPack(custId, meta.telegram_id, custEmail);
          facture = await this.facturePayload(meta.telegram_id, session.amount_total, session.currency, 'Pack Fondations');
        } else if (session.subscription) {
          const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const sub = await this.stripe!.subscriptions.retrieve(subId);
          await this.applySubscription(sub);
        }
      } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(etype)) {
        const sub = obj as Stripe.Subscription;
        const res = await this.applySubscription(sub);
        if (res) {
          if (etype === 'customer.subscription.created' && ['active', 'trialing'].includes(res.status)) {
            notify = await this.notifyPayload(res.uid, 'new_sub', res.status);
          } else if (res.status === 'canceled') {
            canceledUid = res.uid; // fin de cycle -> libère les réseaux Late (route)
            notify = await this.notifyPayload(res.uid, 'canceled');
          } else if (res.newlyCanceling) {
            const end = res.cancelAt ? res.cancelAt.toISOString().slice(0, 10) : '';
            notify = await this.notifyPayload(res.uid, 'canceling', `Fin le ${end} · raison : ${await this.cancelReason(sub)}`);
          }
        }
      } else if (etype === 'invoice.payment_succeeded') {
        const inv = obj as Stripe.Invoice;
        const lignes = inv.lines?.data || [];
        const libelle = (lignes.length ? lignes[0].description : null) || 'Abonnement Postorico';
        const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        const uid = await this.uidByCustomer(custId);
        this.commission('recurrent', inv.id, inv.amount_paid, inv.currency, uid, inv.customer_email, libelle);
        facture = await this.facturePayload(uid, inv.amount_paid, inv.currency, libelle, inv.number, inv.hosted_invoice_url, inv.invoice_pdf);
      } else if (etype === 'customer.subscription.trial_will_end') {
        rappel = await this.rappelPayload(obj as Stripe.Subscription);
      } else if (etype === 'invoice.paid') {
        // Le SEUL chemin qui ramène un compte impayé à « actif » : un encaissement
        // effectif. Jamais une date, jamais un cron.
        const inv = obj as Stripe.Invoice;
        const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        const uid = await this.uidByCustomer(custId);
        if (uid) {
          const reprise = await this.impayeService.regulariser(uid);
          if (reprise.changement) {
            this.logger.log(`stripe: ${uid} régularisé (reconnexion à faire: ${JSON.stringify(reprise.reconnexion)})`);
            if (reprise.etait_suspendu) {
              try {
                await this.notificationService.notifier(
                  uid,
                  null,
                  null,
                  'billing.regularise',
                  'Paiement reçu, merci',
                  'Ton compte est de nouveau actif. Reconnecte tes réseaux pour reprendre la publication.',
                  'facturation',
                );
              } catch (e) {
                this.logger.warn(`stripe: notification reprise ${uid}: ${e instanceof Error ? e.message : e}`);
              }
            }
          }
        }
      } else if (etype === 'invoice.payment_failed') {
        const inv = obj as Stripe.Invoice;
        const raison = await this.raisonEchecPaiement(inv.id);
        const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        const uid = await this.uidByCustomer(custId);
        notify = await this.notifyPayload(uid, 'payment_failed', raison);
        if (uid) {
          // Cran 1 : le compte passe en grâce (génération bloquée), impaye_depuis posé au
          // PREMIER échec seulement. Mail 1 au client, une seule fois.
          const echec = await this.impayeService.marquerEchec(uid);
          if (echec.premier_echec) {
            clientImpaye = await this.clientImpayePayload(uid, inv.hosted_invoice_url);
          }
        }
      }
    } catch (e) {
      this.logger.error(`stripe webhook handle error: ${e instanceof Error ? e.message : e}`);
    }
    return { ok: true, event: etype, canceled_uid: canceledUid, notify, client_impaye: clientImpaye, facture, rappel };
  }
}
