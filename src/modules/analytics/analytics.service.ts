import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { labelStatutContenu } from '../../common/utils/contenu-enum.util';
import { ZernioClientService, ZernioError } from '../zernio/zernio-client.service';

/** Port direct de backend/services/analytics_service.py. */

const METRICS = ['impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'views'] as const;

export interface AnalyticsResult {
  ok: boolean;
  connected?: boolean;
  addon_required?: boolean;
  error?: string;
  kpis?: Record<string, number>;
  overview?: Record<string, unknown>;
  posts?: Array<Record<string, unknown>>;
  daily?: unknown[];
  platformBreakdown?: unknown[];
  bestSlots?: unknown[];
}

@Injectable()
export class AnalyticsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly lateApiKey: string;
  private readonly cronHeures: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
    private readonly config: ConfigService,
  ) {
    this.lateApiKey = config.get<string>('app.lateApiKey') || '';
    this.cronHeures = config.get<number>('app.analyticsCronHeures') || 0;
  }

  /** Rafraîchit le cache analytics toutes les ANALYTICS_CRON_HOURS heures — port direct de
   * backend/server.py::_analytics_cron. Petit délai initial pour ne pas charger au boot. */
  onApplicationBootstrap(): void {
    if (!(this.cronHeures > 0)) return;
    const interval = this.cronHeures * 3600 * 1000;
    this.logger.log(`Cron analytics activé (toutes les ${this.cronHeures} h)`);
    setTimeout(() => {
      void this.refreshAll();
      setInterval(() => void this.refreshAll(), interval);
    }, 60_000);
  }

  /** Performances réelles via l'API analytics de Late (add-on requis -> 402/403). */
  async performance(telegramId: string, days = 30, platform?: string | null): Promise<AnalyticsResult> {
    if (!this.lateApiKey) return { ok: false, error: 'Analytics indisponible (non configuré).' };
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    const profile = u?.late_profile_id;
    if (!profile) return { ok: true, connected: false };

    const toD = new Date();
    const fr = new Date(toD.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = toD.toISOString().slice(0, 10);
    const plateforme = platform ? platform.toLowerCase() : undefined;

    let an: { posts?: Array<Record<string, unknown>>; overview?: Record<string, unknown> };
    let daily: { dailyData?: unknown[]; platformBreakdown?: unknown[] } = {};
    let best: { slots?: unknown[] } = {};
    try {
      an = await this.zernio.getAnalytics({ profileId: profile, platform: plateforme, fromDate: fr, toDate: to, limit: 100 });
      try {
        daily = await this.zernio.getDailyMetrics({ profileId: profile, platform: plateforme, fromDate: fr, toDate: to });
      } catch {
        daily = {};
      }
      try {
        best = await this.zernio.getBestTimeToPost(profile);
      } catch {
        best = {};
      }
    } catch (e) {
      if (e instanceof ZernioError && e.statusCode && [402, 403].includes(e.statusCode)) return { ok: true, addon_required: true };
      this.logger.error(`analytics error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Analytics indisponible pour le moment.' };
    }

    const postsRaw = an.posts || [];
    const agg: Record<string, number> = Object.fromEntries(METRICS.map((k) => [k, 0]));
    const posts: Array<Record<string, unknown>> = [];
    for (const p of postsRaw) {
      const a = (p.analytics as Record<string, number>) || {};
      for (const k of METRICS) agg[k] += a[k] || 0;
      posts.push({
        id: p._id,
        content: p.content,
        platform: p.platform,
        publishedAt: p.publishedAt,
        thumbnailUrl: p.thumbnailUrl,
        url: p.platformPostUrl,
        metrics: Object.fromEntries(METRICS.map((k) => [k, a[k] || 0])),
        engagementRate: a.engagementRate || 0,
      });
    }
    posts.sort((x, y) => ((y.metrics as Record<string, number>).impressions || 0) - ((x.metrics as Record<string, number>).impressions || 0));
    const engagements = agg.likes + agg.comments + agg.shares + agg.saves;
    const engRate = agg.impressions ? Math.round((engagements / agg.impressions) * 1000) / 10 : 0;
    return {
      ok: true,
      connected: true,
      kpis: { ...agg, engagements, engagementRate: engRate },
      overview: an.overview || {},
      posts,
      daily: daily.dailyData || [],
      platformBreakdown: daily.platformBreakdown || [],
      bestSlots: best.slots || [],
    };
  }

  // --- Cache (alimenté par le cron horaire) ---

  /** Retourne {data, updated_at} ou null. */
  async getCached(telegramId: string): Promise<{ data: unknown; updated_at: Date | null } | null> {
    try {
      const row = await this.prisma.analytics_cache.findUnique({ where: { telegram_id: telegramId }, select: { data: true, updated_at: true } });
      return row ?? null;
    } catch (e) {
      this.logger.warn(`analytics cache read: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async storeCache(telegramId: string, data: AnalyticsResult): Promise<void> {
    try {
      await this.prisma.analytics_cache.upsert({
        where: { telegram_id: telegramId },
        create: { telegram_id: telegramId, data: data as never, updated_at: new Date() },
        update: { data: data as never, updated_at: new Date() },
      });
    } catch (e) {
      this.logger.warn(`analytics cache write: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Récupère les analytics (30 j) et les met en cache. Cron + refresh manuel. */
  async refreshUser(telegramId: string): Promise<AnalyticsResult> {
    const data = await this.performance(telegramId, 30);
    if (data.ok && data.connected) await this.storeCache(telegramId, data);
    return data;
  }

  private readonly dernierRefresh = new Map<string, number>();

  /**
   * `analytics.synced` : Zernio annonce que les chiffres d'UN compte ont changé (le message ne
   * contient aucun chiffre). On rafraîchit le cache du client propriétaire, au plus une fois par
   * 10 min (un événement arrive par compte connecté). Le cron reste en secours (quotidien).
   * Port de `refresh_depuis_webhook` (analytics_service.py).
   */
  async refreshDepuisWebhook(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const account = (payload.account as Record<string, unknown>) || {};
    const accountId = (account.accountId || account.id || account._id || payload.accountId) as string | undefined;
    if (!accountId) return { ok: true, no_user: true };
    const row = await this.prisma.comptes_sociaux.findFirst({ where: { late_account_id: accountId }, select: { telegram_id: true } });
    if (!row) {
      this.logger.log(`analytics.synced: compte ${accountId} sans client connu`);
      return { ok: true, no_user: true };
    }
    const maintenant = Date.now();
    if (maintenant - (this.dernierRefresh.get(row.telegram_id) ?? 0) < 10 * 60 * 1000) return { ok: true, debounced: true };
    this.dernierRefresh.set(row.telegram_id, maintenant);
    try {
      await this.refreshUser(row.telegram_id);
      this.logger.log(`analytics.synced: cache rafraîchi pour ${row.telegram_id}`);
      return { ok: true, telegram_id: row.telegram_id };
    } catch (e) {
      this.logger.warn(`analytics.synced refresh ${row.telegram_id}: ${e instanceof Error ? e.message : e}`);
      return { ok: false };
    }
  }

  /** Cron : rafraîchit le cache analytics de tous les users actifs ayant un profil Late. */
  async refreshAll(): Promise<{ ok: boolean; skipped?: string; error?: string; refreshed?: number; errors?: number }> {
    if (!this.lateApiKey) return { ok: false, skipped: 'no_late_key' };
    let users: Array<{ telegram_id: string }>;
    try {
      users = await this.prisma.users.findMany({ where: { actif: true, late_profile_id: { not: null } }, select: { telegram_id: true } });
    } catch (e) {
      this.logger.error(`refresh_all users query: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    let done = 0;
    let errors = 0;
    for (const u of users) {
      try {
        await this.refreshUser(u.telegram_id);
        done += 1;
      } catch (e) {
        errors += 1;
        this.logger.warn(`refresh_all ${u.telegram_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`analytics cron: ${done} users rafraîchis, ${errors} erreurs`);
    return { ok: true, refreshed: done, errors };
  }

  async getStats(telegramId: string): Promise<Record<string, unknown>> {
    const analytics = await this.prisma.analytics_performance.findMany({ where: { telegram_id: telegramId } });

    let totalVues = analytics.reduce((s, a) => s + Number(a.vues || 0), 0);
    let totalLikes = analytics.reduce((s, a) => s + Number(a.likes || 0), 0);
    let totalCommentaires = analytics.reduce((s, a) => s + Number(a.commentaires || 0), 0);
    let totalPartages = analytics.reduce((s, a) => s + Number(a.partages || 0), 0);

    const engagements = analytics.filter((a) => Number(a.taux_engagement || 0)).map((a) => Number(a.taux_engagement || 0));
    let avgEngagement = engagements.length ? engagements.reduce((s, v) => s + v, 0) / engagements.length : 0;

    // Les KPI du tableau de bord lisent la MÊME source que la courbe : le cache des
    // insights Zernio (alimenté par le cron horaire). L'ancienne table
    // analytics_performance n'est plus alimentée — sans ce raccord, les cartes
    // affichaient 0 alors que la courbe montrait les vraies données.
    const cached = await this.getCached(telegramId);
    const cacheData = (cached?.data as AnalyticsResult) || {};
    const kpis = cacheData.kpis || {};
    const depuisCache = Boolean(kpis.impressions || kpis.likes || kpis.comments);
    if (depuisCache) {
      totalVues = kpis.impressions || 0;
      totalLikes = kpis.likes || 0;
      totalCommentaires = kpis.comments || 0;
      totalPartages = kpis.shares || 0;
      avgEngagement = kpis.engagementRate || 0;
    }

    const contenus = await this.prisma.contenu.findMany({ where: { telegram_id: telegramId }, select: { statut: true } });
    const contenusStats: Record<string, number> = {};
    for (const c of contenus) {
      const statut = labelStatutContenu(c.statut as string | null) || 'Inconnu';
      contenusStats[statut] = (contenusStats[statut] || 0) + 1;
    }

    let nouveauxCommentaires = await this.prisma.commentaires.count({ where: { telegram_id: telegramId, statut: 'Nouveau' } });
    let postsPerformants = analytics.filter((a) => a.post_performant).length;

    // Mêmes cartes, même source que la courbe : les cartes « nouveaux commentaires »
    // et « posts performants » se calculent depuis le cache des insights, les tables
    // héritées (commentaires / analytics_performance) n'étant plus alimentées.
    if (depuisCache) {
      const daily = (cacheData.daily as Array<Record<string, unknown>>) || [];
      if (daily.length) {
        nouveauxCommentaires = daily.slice(-7).reduce((s, d) => {
          const metrics = (d.metrics as Record<string, unknown>) || {};
          return s + Number(metrics.comments ?? d.comments ?? 0);
        }, 0);
      }
      const postsCache = (cacheData.posts as Array<Record<string, unknown>>) || [];
      if (postsCache.length) {
        postsPerformants = postsCache.filter((p) => {
          const metrics = (p.metrics as Record<string, unknown>) || {};
          return Number(p.engagementRate || 0) > (avgEngagement || 0) && Number(metrics.impressions || 0) > 0;
        }).length;
      }
    }

    return {
      vues: Math.trunc(totalVues),
      likes: Math.trunc(totalLikes),
      commentaires: totalCommentaires,
      partages: Math.trunc(totalPartages),
      taux_engagement: Math.round(avgEngagement * 100) / 100,
      contenus_stats: contenusStats,
      nouveaux_commentaires: nouveauxCommentaires,
      posts_performants: postsPerformants,
    };
  }

  async getPerformance(telegramId: string) {
    return this.prisma.analytics_performance.findMany({ where: { telegram_id: telegramId }, orderBy: { created_at: 'desc' }, take: 20 });
  }
}
