import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { labelStatutContenu } from '../../common/utils/contenu-enum.util';
import { PrismaService } from '../../config/prisma.service';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { AbonnementInfo } from '../billing/interfaces/billing-result.interface';
import { PushService } from '../notifications/push.service';

/**
 * Back-office admin — port direct de backend/services/admin_service.py.
 *
 * Portée volontairement réduite (documentée à chaque endroit concerné) :
 * - Le barème de coûts (`credit_service.COUTS`, 15 lignes) est inlined ci-dessous plutôt
 *   que dans un module séparé : il ne sert qu'ici (affichage des marges).
 */

// Barème des coûts en crédits — port direct de backend/services/credit_service.py::COUTS.
// Ne facture plus rien depuis le passage aux quotas par type d'action ; sert seulement
// d'unité de mesure historique pour le calcul des marges affiché côté admin.
const COUTS = {
  sujets: 5,
  post: { rapide: 8, equilibre: 20, premium: 40 },
  script: { rapide: 12, equilibre: 30, premium: 60 },
  carrousel: { rapide: 40, equilibre: 80, premium: 140 },
  image: { nano2: 50, nano3: 150 },
};

const RESEAUX = ['linkedin', 'instagram', 'facebook', 'tiktok', 'youtube', 'googlebusiness'];

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'toNumber' in (v as Record<string, unknown>)) {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v) || 0;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private analyticsCache: { at: number; data: unknown } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly billingService: BillingService,
    private readonly pushService: PushService,
    private readonly config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** {telegram_id: [réseaux connectés]} — une seule requête pour toute la liste. */
  private async tousLesComptes(): Promise<Record<string, string[]>> {
    const parUser: Record<string, string[]> = {};
    try {
      const rows = await this.prisma.comptes_sociaux.findMany({ select: { telegram_id: true, plateforme: true } });
      for (const x of rows) {
        (parUser[x.telegram_id] ??= []).push(x.plateforme);
      }
    } catch (e) {
      this.logger.error(`lecture comptes_sociaux (admin): ${e instanceof Error ? e.message : e}`);
    }
    return parUser;
  }

  private reseauxConnectes(telegramId: string, cache: Record<string, string[]>): string[] {
    const reseaux = cache[telegramId] || [];
    return RESEAUX.filter((r) => reseaux.includes(r));
  }

  /** Recompose les clés que l'interface admin attend depuis l'abonnement réel. */
  private champsAbonnement(abo?: AbonnementInfo): Record<string, unknown> {
    const nom = (abo?.plan || 'Essai').toLowerCase();
    return {
      plan: nom === 'essai' || nom === 'gratuit' ? 'gratuit' : nom,
      plan_libelle: abo?.plan || 'Essai',
      plan_renews_at: abo?.renouvelle_le ?? null,
      plan_cancel_at: abo?.resilie_le ?? null,
      stripe_subscription_id: abo?.stripe_subscription_id ?? null,
      prix_cents: abo?.prix_cents || 0,
    };
  }

  async getUsers(filter = 'all', q?: string): Promise<Array<Record<string, unknown>>> {
    const where: Record<string, unknown> = {};
    if (filter === 'pending') where.actif = false;
    else if (filter === 'active') where.actif = true;

    const rows = await this.prisma.users.findMany({ where: where as never, orderBy: { created_at: 'desc' } });
    let users: Array<Record<string, unknown>> = rows.map((u) => this.authService.sanitizeUser(u));
    if (q) {
      const ql = q.toLowerCase().trim();
      users = users.filter(
        (u) =>
          String(u.nom || '').toLowerCase().includes(ql) ||
          String(u.email || '').toLowerCase().includes(ql) ||
          String(u.username || '').toLowerCase().includes(ql),
      );
    }
    const comptes = await this.tousLesComptes();
    const abos = await this.billingService.abonnements();
    for (const u of users) {
      u.reseaux_connectes = this.reseauxConnectes(u.telegram_id as string, comptes);
      Object.assign(u, this.champsAbonnement(abos[u.telegram_id as string]));
    }
    if (['gratuit', 'pro', 'business', 'boss'].includes(filter)) {
      users = users.filter((u) => (u.plan || 'gratuit') === filter);
    }
    return users;
  }

  async getUserDetail(telegramId: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId } });
    if (!row) return null;
    const user: Record<string, unknown> = this.authService.sanitizeUser(row);

    const contenus = await this.prisma.contenu.findMany({
      where: { telegram_id: telegramId },
      select: { id: true, statut: true, updated_at: true, created_at: true },
      orderBy: { updated_at: 'desc' },
    });
    const contenusStats: Record<string, number> = {};
    for (const c of contenus) {
      const s = labelStatutContenu(c.statut) || 'Inconnu';
      contenusStats[s] = (contenusStats[s] || 0) + 1;
    }
    const totalCommentaires = await this.prisma.commentaires.count({ where: { telegram_id: telegramId } });

    user.reseaux_connectes = this.reseauxConnectes(telegramId, await this.tousLesComptes());
    Object.assign(user, this.champsAbonnement((await this.billingService.abonnements())[telegramId]));
    user.derniere_activite = contenus.length ? contenus[0].updated_at || contenus[0].created_at : null;
    user.stats = { total_contenus: contenus.length, contenus_par_statut: contenusStats, total_commentaires: totalCommentaires };
    return user;
  }

  async getUserContenus(telegramId: string) {
    const rows = await this.prisma.contenu.findMany({ where: { telegram_id: telegramId }, orderBy: { created_at: 'desc' } });
    return rows.map((r) => ({ ...r, statut: labelStatutContenu(r.statut), type: r.type }));
  }

  /** Change le forfait d'un compte à la main (support). Écrit dans `subscriptions`, la
   * seule source qui gouverne réellement les quotas. */
  async updatePlan(telegramId: string, plan: string): Promise<Record<string, unknown> | null> {
    const p = await this.prisma.plans.findFirst({ where: { name: { equals: plan, mode: 'insensitive' } } });
    if (!p) return null;
    const sub = await this.prisma.subscriptions.findFirst({ where: { user_id: telegramId }, orderBy: { created_at: 'desc' } });
    if (sub) {
      await this.prisma.subscriptions.update({ where: { id: sub.id }, data: { plan_id: p.id, status: 'active' } });
    } else {
      await this.prisma.subscriptions.create({
        data: { user_id: telegramId, plan_id: p.id, status: 'active', current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      });
    }
    return this.getUserDetail(telegramId);
  }

  /** Paramètres globaux : intégrations, barème crédits, coûts & marges (usage_log). */
  async systemInfo() {
    const firebaseOk = this.pushService.estConfigure();
    const integrations = {
      'Publication (Late)': Boolean(this.config.get<string>('app.lateApiKey')),
      'Paiements (Stripe)': Boolean(this.config.get<string>('app.stripeSecretKey') && this.config.get<string>('app.stripePricePro')),
      'Notifications push (Firebase)': firebaseOk,
      'Médias (Cloudinary)': Boolean(this.config.get<string>('app.cloudinaryCloudName')),
      'Avatar vidéo (HeyGen)': Boolean(this.config.get<string>('app.heygenApiKey')),
      'Génération IA': Boolean(this.config.get<string>('app.claudeApiKey') || this.config.get<string>('app.openrouterApiKey')),
    };

    const EUR_PER_CREDIT = 279 / 1000;
    const USD_TO_EUR = 0.92;
    const rows = await this.prisma.usage_log.findMany({ select: { action: true, credits: true, cost_usd: true } });
    const per: Record<string, { n: number; credits: number; cost_usd: number }> = {};
    let totCredits = 0;
    let totCost = 0;
    for (const r of rows) {
      const a = r.action || '?';
      const c = r.credits || 0;
      const cost = num(r.cost_usd);
      const d = (per[a] ??= { n: 0, credits: 0, cost_usd: 0 });
      d.n += 1;
      d.credits += c;
      d.cost_usd += cost;
      totCredits += c;
      totCost += cost;
    }
    const margin = (credits: number, costUsd: number) => {
      const revenue = credits * EUR_PER_CREDIT;
      const costEur = costUsd * USD_TO_EUR;
      return revenue ? Math.round((1 - costEur / revenue) * 1000) / 10 : 0;
    };
    const usage = {
      par_action: Object.entries(per)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([a, d]) => ({ action: a, n: d.n, credits: d.credits, cost_usd: Math.round(d.cost_usd * 10000) / 10000, marge: margin(d.credits, d.cost_usd) })),
      total: { credits: totCredits, cost_usd: Math.round(totCost * 10000) / 10000, marge: margin(totCredits, totCost), eur_par_credit: Math.round(EUR_PER_CREDIT * 10000) / 10000 },
    };

    // Rendus vidéo (Remotion) : coût en temps de calcul, moyenne par template.
    const rendus = { total: { n: 0, echecs: 0, secondes: 0, cost_usd: 0 } as Record<string, number>, par_template: [] as Array<Record<string, unknown>> };
    try {
      const lignes = await this.prisma.usage_log.findMany({
        where: { action: { startsWith: 'reel_rendu' } },
        select: { action: true, model: true, duree_s: true, cost_usd: true },
      });
      const par: Record<string, { n: number; echecs: number; secondes: number; cost_usd: number }> = {};
      for (const r of lignes) {
        const echec = (r.action || '').endsWith('echec');
        const s = num(r.duree_s);
        const c = num(r.cost_usd);
        const d = (par[r.model || '?'] ??= { n: 0, echecs: 0, secondes: 0, cost_usd: 0 });
        d.n += 1;
        d.secondes += s;
        d.cost_usd += c;
        rendus.total.n += 1;
        rendus.total.secondes += s;
        rendus.total.cost_usd += c;
        if (echec) {
          d.echecs += 1;
          rendus.total.echecs += 1;
        }
      }
      rendus.par_template = Object.entries(par)
        .map(([k, v]) => ({
          template: k,
          n: v.n,
          echecs: v.echecs,
          moyenne_s: v.n ? Math.round((v.secondes / v.n) * 10) / 10 : 0,
          cost_usd: Math.round(v.cost_usd * 10000) / 10000,
          cout_moyen_usd: v.n ? Math.round((v.cost_usd / v.n) * 100000) / 100000 : 0,
        }))
        .sort((a, b) => (b.n as number) - (a.n as number));
      rendus.total.moyenne_s = rendus.total.n ? Math.round((rendus.total.secondes / rendus.total.n) * 10) / 10 : 0;
      rendus.total.cout_moyen_usd = rendus.total.n ? Math.round((rendus.total.cost_usd / rendus.total.n) * 100000) / 100000 : 0;
      rendus.total.cost_usd = Math.round(rendus.total.cost_usd * 10000) / 10000;
      rendus.total.secondes = Math.round(rendus.total.secondes);
    } catch (e) {
      this.logger.warn(`stats rendus: ${e instanceof Error ? e.message : e}`);
    }

    // Temps de génération (post, carrousel, image) — comparé au temps de production
    // manuelle (mesure H1 du mémoire).
    const durees = { total: { n: 0, moyenne_s: 0 }, par_action: [] as Array<Record<string, unknown>> };
    try {
      const lignes = await this.prisma.usage_log.findMany({
        where: { duree_s: { not: null }, NOT: { action: { startsWith: 'reel_rendu' } } },
        select: { action: true, duree_s: true },
      });
      const par: Record<string, { n: number; secondes: number }> = {};
      for (const r of lignes) {
        const a = r.action || '?';
        const d = (par[a] ??= { n: 0, secondes: 0 });
        d.n += 1;
        d.secondes += num(r.duree_s);
      }
      const totN = Object.values(par).reduce((s, d) => s + d.n, 0);
      const totS = Object.values(par).reduce((s, d) => s + d.secondes, 0);
      durees.par_action = Object.entries(par)
        .map(([a, d]) => ({ action: a, n: d.n, moyenne_s: d.n ? Math.round((d.secondes / d.n) * 10) / 10 : 0 }))
        .sort((a, b) => (b.n as number) - (a.n as number));
      durees.total = { n: totN, moyenne_s: totN ? Math.round((totS / totN) * 10) / 10 : 0 };
    } catch (e) {
      this.logger.warn(`stats durees: ${e instanceof Error ? e.message : e}`);
    }

    const plansRows = await this.prisma.plans.findMany({ select: { name: true, price_cents: true } });
    const plans: Record<string, number> = {};
    for (const p of plansRows) plans[p.name] = (p.price_cents || 0) / 100;

    return {
      integrations,
      cron_analytics_h: this.config.get<number>('app.analyticsCronHeures'),
      bareme: COUTS,
      plans,
      usage,
      rendus,
      durees,
    };
  }

  /** Soldes des fournisseurs IA pour l'admin (OpenRouter exact, Anthropic estimé/officiel). */
  async apiBalances(): Promise<{ openrouter: unknown; anthropic: unknown }> {
    const out: { openrouter: unknown; anthropic: unknown } = { openrouter: null, anthropic: null };
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const openrouterKey = this.config.get<string>('app.openrouterApiKey');
    if (openrouterKey) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${openrouterKey}` } });
        const d = ((await r.json()) as { data?: { total_credits?: number; total_usage?: number } }).data || {};
        const total = Number(d.total_credits || 0);
        const used = Number(d.total_usage || 0);
        out.openrouter = { achete_usd: Math.round(total * 100) / 100, consomme_usd: Math.round(used * 100) / 100, restant_usd: Math.round((total - used) * 100) / 100 };
      } catch (e) {
        this.logger.warn(`openrouter credits: ${e instanceof Error ? e.message : e}`);
      }
    }

    const adminKey = this.config.get<string>('app.anthropicAdminKey');
    if (adminKey) {
      try {
        let spend = 0;
        let page: string | undefined;
        for (;;) {
          const params = new URLSearchParams({ starting_at: monthStart.toISOString(), limit: '31' });
          if (page) params.set('page', page);
          const r = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
            headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = (await r.json()) as { data?: Array<{ results?: Array<{ amount?: number }> }>; has_more?: boolean; next_page?: string };
          for (const bucket of data.data || []) {
            for (const res of bucket.results || []) {
              const amt = Number(res.amount);
              if (!Number.isNaN(amt)) spend += amt;
            }
          }
          if (!data.has_more) break;
          page = data.next_page;
        }
        out.anthropic = { mode: 'officiel', mois_usd: Math.round(spend * 100) / 100 };
      } catch (e) {
        this.logger.warn(`anthropic cost report: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (out.anthropic === null) {
      try {
        const rows = await this.prisma.usage_log.findMany({
          where: { created_at: { gte: monthStart }, model: { startsWith: 'claude', mode: 'insensitive' } },
          select: { cost_usd: true },
        });
        const est = rows.reduce((s, r) => s + num(r.cost_usd), 0);
        out.anthropic = { mode: 'estimation', mois_usd: Math.round(est * 100) / 100 };
      } catch (e) {
        this.logger.warn(`anthropic estimation usage_log: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  private async posthogQuery(source: Record<string, unknown>, apiKey: string): Promise<unknown> {
    const r = await fetch('https://us.posthog.com/api/projects/545489/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: source }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { results?: unknown }).results;
  }

  /** Synthèse business (Supabase, source de vérité argent) + comportement (PostHog, si
   * configuré) pour l'onglet Analytics de l'admin. Cache 10 min (PostHog est lent). */
  async analyticsProduit(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.analyticsCache && now - this.analyticsCache.at < 600_000) {
      return this.analyticsCache.data as Record<string, unknown>;
    }

    const users = await this.prisma.users.findMany({ select: { telegram_id: true, actif: true, is_admin: true, created_at: true } });
    const clients = users.filter((u) => !u.is_admin);
    const actifs = clients.filter((u) => u.actif);
    const abos = await this.billingService.abonnements();
    const parPlan: Record<string, number> = {};
    for (const u of actifs) {
      const p = this.champsAbonnement(abos[u.telegram_id]).plan as string;
      parPlan[p] = (parPlan[p] || 0) + 1;
    }

    const plansRows = await this.prisma.plans.findMany({ select: { id: true, price_cents: true } });
    const plansMap = new Map(plansRows.map((p) => [p.id, p.price_cents || 0]));
    const subs = await this.prisma.subscriptions.findMany({ where: { status: { in: ['active', 'trialing'] } }, select: { plan_id: true } });
    const mrr = subs.reduce((s, x) => s + (plansMap.get(x.plan_id) || 0), 0) / 100;
    const payants = subs.filter((s) => (plansMap.get(s.plan_id) || 0) > 0).length;
    const conversion = actifs.length ? Math.round((payants / actifs.length) * 1000) / 10 : 0;

    const totalContenus = await this.prisma.contenu.count();
    const contenuStatuts = await this.prisma.contenu.findMany({ select: { statut: true } });
    const parStatut: Record<string, number> = {};
    for (const c of contenuStatuts) {
      const s = labelStatutContenu(c.statut) || '?';
      parStatut[s] = (parStatut[s] || 0) + 1;
    }
    const publies = parStatut['Publie'] || 0;

    const business = {
      mrr_eur: Math.round(mrr * 100) / 100,
      clients_actifs: actifs.length,
      clients_payants: payants,
      conversion_payant_pct: conversion,
      par_plan: parPlan,
      contenus_total: totalContenus,
      contenus_publies: publies,
      contenus_par_statut: parStatut,
    };

    let posthog: Record<string, unknown> | null = null;
    const apiKey = this.config.get<string>('app.posthogApiKey');
    if (apiKey) {
      posthog = { funnel: null, series: null };
      try {
        const res = await this.posthogQuery(
          {
            kind: 'FunnelsQuery',
            series: [
              { kind: 'EventsNode', event: 'inscription', name: 'Inscription' },
              { kind: 'EventsNode', event: 'contenu_genere', name: 'Contenu généré' },
              { kind: 'EventsNode', event: 'post_valide', name: 'Post validé' },
              { kind: 'EventsNode', event: 'checkout_ouvert', name: 'Checkout ouvert' },
            ],
            dateRange: { date_from: '-90d' },
            funnelsFilter: { funnelWindowInterval: 30, funnelWindowIntervalUnit: 'day' },
          },
          apiKey,
        );
        let steps = Array.isArray(res) ? (res as Array<Record<string, unknown>>) : [];
        if (steps.length && Array.isArray(steps[0])) steps = steps[0] as unknown as Array<Record<string, unknown>>;
        let base: number | null = null;
        const funnel = steps.map((s) => {
          const n = Number(s.count || 0);
          base = base ?? (n || 1);
          return { etape: s.custom_name || s.name || '?', n, pct: base ? Math.round((n / base) * 1000) / 10 : 0 };
        });
        posthog.funnel = funnel.length ? funnel : null;
      } catch (e) {
        this.logger.warn(`posthog funnel: ${e instanceof Error ? e.message : e}`);
      }
      try {
        const series: Record<string, unknown> = {};
        const events: Array<[string, string]> = [
          ['contenu_genere', 'Contenus générés'],
          ['post_valide', 'Posts validés'],
          ['$pageview', 'Sessions'],
        ];
        for (const [event, label] of events) {
          const res = (await this.posthogQuery(
            { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event, math: event === '$pageview' ? 'weekly_active' : 'total' }], interval: 'week', dateRange: { date_from: '-60d' } },
            apiKey,
          )) as Array<{ labels?: unknown; data?: unknown }> | null;
          const r0 = (res || [{}])[0] || {};
          series[label] = { labels: r0.labels || [], data: r0.data || [] };
        }
        posthog.series = series;
      } catch (e) {
        this.logger.warn(`posthog trends: ${e instanceof Error ? e.message : e}`);
      }
    }

    const data = { business, posthog, posthog_configure: Boolean(apiKey), genere_a: new Date(now).toISOString() };
    this.analyticsCache = { at: now, data };
    return data;
  }

  /** Envoie un push à un compte (telegramId) ou à tous ceux ayant un appareil enregistré. */
  async broadcastPush(title: string, body: string, telegramId?: string): Promise<{ targets: number; sent: number }> {
    let targets: string[];
    if (telegramId) {
      targets = [telegramId];
    } else {
      const rows = await this.prisma.device_tokens.findMany({ select: { telegram_id: true } });
      targets = [...new Set(rows.map((r) => r.telegram_id).filter(Boolean))];
    }
    let sent = 0;
    for (const t of targets) {
      try {
        if (await this.pushService.sendToUser(t, title, body, { type: 'admin' })) sent += 1;
      } catch (e) {
        this.logger.warn(`broadcast push ${t}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { targets: targets.length, sent };
  }

  async getGlobalStats() {
    const users = await this.prisma.users.findMany({ select: { telegram_id: true, actif: true, created_at: true } });
    const totalUsers = users.length;
    const activeUsers = users.filter((u) => u.actif).length;
    const pendingUsers = totalUsers - activeUsers;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newUsersWeek = users.filter((u) => u.created_at && u.created_at > weekAgo).length;

    const abos = await this.billingService.abonnements();
    const parPlan: Record<string, number> = {};
    for (const u of users) {
      const p = this.champsAbonnement(abos[u.telegram_id]).plan as string;
      parPlan[p] = (parPlan[p] || 0) + 1;
    }
    const mrr = Object.values(abos).reduce((s, a) => s + (a.prix_cents || 0), 0) / 100;
    const abonnes = Object.values(abos).filter((a) => (a.prix_cents || 0) > 0).length;

    const contenus = await this.prisma.contenu.findMany({ select: { id: true, statut: true, reseau_cible: true, created_at: true } });
    const contenusParStatut: Record<string, number> = {};
    const contenusParReseau: Record<string, number> = {};
    for (const c of contenus) {
      const statut = labelStatutContenu(c.statut) || 'Inconnu';
      contenusParStatut[statut] = (contenusParStatut[statut] || 0) + 1;
      if (c.reseau_cible) contenusParReseau[c.reseau_cible] = (contenusParReseau[c.reseau_cible] || 0) + 1;
    }

    const totalCommentaires = await this.prisma.commentaires.count();
    const commentairesNouveaux = await this.prisma.commentaires.count({ where: { statut: 'Nouveau' as never } });

    // analytics_performance n'est plus alimentée : les vrais chiffres vivent dans le cache
    // des insights Zernio, rafraîchi par le cron horaire.
    const caches = await this.prisma.analytics_cache.findMany({ select: { data: true } });
    let totalVues = 0;
    let totalLikes = 0;
    let totalPartages = 0;
    for (const row of caches) {
      const kpis = ((row.data as Record<string, unknown> | null)?.kpis as Record<string, unknown>) || {};
      totalVues += Number(kpis.impressions || 0);
      totalLikes += Number(kpis.likes || 0);
      totalPartages += Number(kpis.shares || 0);
    }

    return {
      users: { total: totalUsers, actifs: activeUsers, en_attente: pendingUsers, nouveaux_semaine: newUsersWeek },
      revenus: { mrr, abonnes_payants: abonnes, par_plan: parPlan, credits_total: 0 },
      contenus: { total: contenus.length, par_statut: contenusParStatut, par_reseau: contenusParReseau },
      commentaires: { total: totalCommentaires, nouveaux: commentairesNouveaux },
      engagement: { vues: Math.trunc(totalVues), likes: Math.trunc(totalLikes), partages: Math.trunc(totalPartages) },
    };
  }

  async exportUsersCsv(): Promise<string> {
    const users = await this.prisma.users.findMany({ orderBy: { created_at: 'desc' } });
    const headers = ['telegram_id', 'nom', 'email', 'username', 'actif', 'sexe', 'style_vestimentaire', 'created_at'];
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const u of users) {
      lines.push(headers.map((h) => escape((u as Record<string, unknown>)[h])).join(','));
    }
    return lines.join('\r\n');
  }

  async getActivity(limit = 50): Promise<Array<Record<string, unknown>>> {
    const contenus = await this.prisma.contenu.findMany({
      select: { id: true, titre: true, statut: true, telegram_id: true, created_at: true, updated_at: true },
      orderBy: { updated_at: 'desc' },
      take: limit,
    });
    const users = await this.prisma.users.findMany({
      select: { telegram_id: true, nom: true, email: true, actif: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    const activities: Array<Record<string, unknown>> = [];
    for (const c of contenus) {
      activities.push({
        type: 'contenu',
        action: `Contenu ${labelStatutContenu(c.statut) || 'créé'}`,
        title: c.titre || 'Sans titre',
        user_id: c.telegram_id,
        date: c.updated_at || c.created_at,
        id: c.id,
      });
    }
    for (const u of users) {
      activities.push({
        type: 'user',
        action: u.actif ? 'Utilisateur actif' : 'Inscription',
        title: u.nom || u.email,
        user_id: u.telegram_id,
        date: u.created_at,
        id: u.telegram_id,
      });
    }
    activities.sort((a, b) => {
      const da = a.date ? new Date(a.date as Date).getTime() : 0;
      const db = b.date ? new Date(b.date as Date).getTime() : 0;
      return db - da;
    });
    return activities.slice(0, limit);
  }

  /** Les départs et leurs raisons, avec le compte par motif — la seule donnée que produit
   * le moment où quelqu'un s'en va. */
  async resiliations(): Promise<{ lignes: Array<Record<string, unknown>>; par_raison: Record<string, number>; total: number; retenus: number }> {
    let lignes: Array<Record<string, unknown>>;
    try {
      lignes = await this.prisma.resiliations.findMany({
        select: { id: true, telegram_id: true, raison: true, commentaire: true, issue: true, detail: true, fin_acces_le: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 300,
      });
    } catch (e) {
      this.logger.error(`lecture resiliations: ${e instanceof Error ? e.message : e}`);
      return { lignes: [], par_raison: {}, total: 0, retenus: 0 };
    }

    const ids = [...new Set(lignes.map((x) => x.telegram_id as string).filter(Boolean))];
    const noms = new Map<string, { nom: string | null; email: string | null }>();
    if (ids.length) {
      try {
        const u = await this.prisma.users.findMany({ where: { telegram_id: { in: ids } }, select: { telegram_id: true, nom: true, email: true } });
        for (const x of u) noms.set(x.telegram_id, x);
      } catch (e) {
        this.logger.warn(`noms des resiliations: ${e instanceof Error ? e.message : e}`);
      }
    }
    for (const x of lignes) {
      const c = noms.get(x.telegram_id as string);
      x.nom = c?.nom ?? null;
      x.email = c?.email ?? null;
    }

    const parRaison: Record<string, number> = {};
    for (const x of lignes) parRaison[x.raison as string] = (parRaison[x.raison as string] || 0) + 1;
    const retenus = lignes.filter((x) => x.issue === 'retenue' || x.issue === 'pause').length;
    return { lignes, par_raison: parRaison, total: lignes.length, retenus };
  }

  // ---------------------------------------------------------------------------
  // Quotas & offres — configuration (tout paramétrable, aucune valeur en dur)
  // ---------------------------------------------------------------------------
  /** Offres + quotas par type + packs de rachat (pour l'écran admin). */
  async quotaConfig() {
    const [plans, quotas, packs] = await Promise.all([
      this.prisma.plans.findMany({ orderBy: { price_cents: 'asc' } }),
      this.prisma.plan_quotas.findMany(),
      this.prisma.credit_packs.findMany({ orderBy: { action_type: 'asc' } }),
    ]);
    const byPlan = new Map<string, Array<Record<string, unknown>>>();
    for (const q of quotas) {
      const arr = byPlan.get(q.plan_id) ?? [];
      arr.push(q);
      byPlan.set(q.plan_id, arr);
    }
    const out = plans.map((p) => ({
      ...p,
      quotas: (byPlan.get(p.id) ?? []).sort((a, b) => String(a.action_type ?? '').localeCompare(String(b.action_type ?? ''))),
    }));
    return { plans: out, packs };
  }

  async updatePlanRow(planId: string, body: Record<string, unknown>) {
    const upd: Record<string, unknown> = {};
    for (const k of ['name', 'price_cents', 'billing_period', 'is_active']) if (k in body) upd[k] = body[k];
    if (!Object.keys(upd).length) return null;
    return this.prisma.plans.update({ where: { id: planId }, data: upd as never });
  }

  async updatePlanQuota(quotaId: string, body: Record<string, unknown>) {
    const upd: Record<string, unknown> = {};
    for (const k of ['included_quantity', 'internal_unit_cost_cents', 'rollover']) if (k in body) upd[k] = body[k];
    if (!Object.keys(upd).length) return null;
    return this.prisma.plan_quotas.update({ where: { id: quotaId }, data: upd as never });
  }

  async createPlanQuota(body: Record<string, unknown>): Promise<Record<string, unknown> | { error: string }> {
    if (!body.plan_id || !body.action_type) return { error: 'plan_id et action_type requis' };
    const row = {
      plan_id: body.plan_id as string,
      action_type: body.action_type as string,
      included_quantity: parseInt(String(body.included_quantity ?? 0), 10),
      internal_unit_cost_cents: parseInt(String(body.internal_unit_cost_cents ?? 0), 10),
      rollover: Boolean(body.rollover ?? false),
    };
    return this.prisma.plan_quotas.upsert({
      where: { plan_id_action_type: { plan_id: row.plan_id, action_type: row.action_type } },
      update: row,
      create: row,
    });
  }

  async updateCreditPack(packId: string, body: Record<string, unknown>) {
    const upd: Record<string, unknown> = {};
    for (const k of ['action_type', 'name', 'quantity', 'price_cents', 'is_active', 'stripe_price_id']) if (k in body) upd[k] = body[k];
    if (!Object.keys(upd).length) return null;
    return this.prisma.credit_packs.update({ where: { id: packId }, data: upd as never });
  }

  async createCreditPack(body: Record<string, unknown>): Promise<Record<string, unknown> | { error: string }> {
    for (const f of ['action_type', 'name', 'quantity', 'price_cents']) {
      if (body[f] === undefined || body[f] === null || body[f] === '') return { error: `${f} requis` };
    }
    const row = {
      action_type: body.action_type as string,
      name: body.name as string,
      quantity: parseInt(String(body.quantity), 10),
      price_cents: parseInt(String(body.price_cents), 10),
      is_active: Boolean(body.is_active ?? true),
    };
    return this.prisma.credit_packs.create({ data: row });
  }

  async deleteCreditPack(packId: string): Promise<void> {
    await this.prisma.credit_packs.deleteMany({ where: { id: packId } });
  }

  // ---------------------------------------------------------------------------
  // Avatars HeyGen — port des deux seules fonctions admin de heygen_service.py.
  // Le reste (génération/entraînement d'avatar) n'est pas porté (domaine séparé).
  // ---------------------------------------------------------------------------
  private deleteFromCloudinary(url: string): void {
    try {
      const parts = url.split('/upload/');
      if (parts.length < 2) return;
      const path = parts[1].split('/').slice(1).join('/'); // enlève le préfixe de version
      const publicId = path.replace(/\.[^./]+$/, '');
      cloudinary.uploader.destroy(publicId, { resource_type: 'video' }).catch(() => undefined);
    } catch (e) {
      this.logger.warn(`deleteFromCloudinary: ${e instanceof Error ? e.message : e}`);
    }
  }

  async getAllAvatars() {
    return this.prisma.heygen_avatars.findMany({
      include: { users: { select: { nom: true, username: true, email: true } } },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateAvatarByAdmin(telegramId: string, updateData: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const allowed = new Set(['avatar_id', 'status', 'error_message', 'consent_url']);
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updateData)) if (allowed.has(k)) filtered[k] = v;
    if (!Object.keys(filtered).length) return null;

    if (filtered.status === 'complete') {
      const avatar = await this.prisma.heygen_avatars.findUnique({ where: { telegram_id: telegramId }, select: { training_video_url: true } });
      if (avatar?.training_video_url) this.deleteFromCloudinary(avatar.training_video_url);
    }
    try {
      return await this.prisma.heygen_avatars.update({ where: { telegram_id: telegramId }, data: filtered as never });
    } catch {
      return null;
    }
  }
}
