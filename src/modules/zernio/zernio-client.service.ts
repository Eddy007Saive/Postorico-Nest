import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ZernioAccountsListResponse,
  ZernioConnectUrlResponse,
  ZernioCreatePostPayload,
  ZernioCreatePostResponse,
  ZernioGetPostResponse,
  ZernioProfileCreateResponse,
  ZernioProfilesListResponse,
} from './interfaces/zernio.interface';

/**
 * Client HTTP brut pour l'API Zernio — port du comportement du SDK Python `zernio`/`late`
 * (venv/Lib/site-packages/late/client/base.py + resources/posts.py + resources/accounts.py).
 * Aucun SDK Node officiel n'existe (paquet Python uniquement) : les appels REST ci-dessous
 * reproduisent fidèlement ceux du SDK (base URL, headers, retry, mapping d'erreurs).
 */

const BASE_URL = 'https://zernio.com/api';
const TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

export class ZernioError extends Error {
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ZernioError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

@Injectable()
export class ZernioClientService {
  private readonly logger = new Logger(ZernioClientService.name);
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('app.lateApiKey') || '';
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async safeJson(resp: Response): Promise<Record<string, unknown> | null> {
    try {
      const text = await resp.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Traduit une réponse HTTP en résultat ou en ZernioError, comme
   * `BaseClient._handle_response` côté SDK Python. */
  private async handleResponse<T>(resp: Response): Promise<T> {
    if (resp.status === 401) throw new ZernioError('Invalid API key', 401);
    if (resp.status === 403) {
      const data = await this.safeJson(resp);
      throw new ZernioError((data?.error as string) || 'Access forbidden - check your plan', 403);
    }
    if (resp.status === 404) {
      const data = await this.safeJson(resp);
      throw new ZernioError((data?.error as string) || 'Resource not found', 404);
    }
    if (resp.status === 429) {
      throw new ZernioError('Rate limit exceeded', 429);
    }
    if (resp.status >= 400) {
      const data = await this.safeJson(resp);
      throw new ZernioError((data?.error as string) || `HTTP ${resp.status}`, resp.status, data ?? undefined);
    }
    const text = await resp.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Requête avec retry exponentiel (0.5s, 1s, 2s) sur erreur réseau/timeout uniquement —
   * une ZernioError (4xx, 429) n'est JAMAIS rejouée, comme côté SDK Python. */
  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    if (!this.apiKey) throw new ZernioError('API key is required');
    let url = `${BASE_URL}${path}`;
    if (options.params) {
      const entries = Object.entries(options.params)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]) as [string, string][];
      const qs = new URLSearchParams(entries).toString();
      if (qs) url += `?${qs}`;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        return await this.handleResponse<T>(resp);
      } catch (e) {
        if (e instanceof ZernioError) throw e;
        lastError = e;
        this.logger.warn(`Zernio ${method} ${path} (essai ${attempt + 1}/${MAX_RETRIES}): ${e instanceof Error ? e.message : e}`);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? new ZernioError(lastError.message) : new ZernioError('Request failed after retries');
  }

  async createPost(payload: ZernioCreatePostPayload): Promise<ZernioCreatePostResponse> {
    return this.request('POST', '/v1/posts', { body: payload as unknown as Record<string, unknown> });
  }

  async getPost(postId: string): Promise<ZernioGetPostResponse> {
    return this.request('GET', `/v1/posts/${postId}`);
  }

  async deletePost(postId: string): Promise<{ message?: string }> {
    return this.request('DELETE', `/v1/posts/${postId}`);
  }

  async retryPost(postId: string): Promise<{ message?: string }> {
    return this.request('POST', `/v1/posts/${postId}/retry`);
  }

  async listAccounts(profileId?: string): Promise<ZernioAccountsListResponse> {
    return this.request('GET', '/v1/accounts', { params: profileId ? { profileId } : undefined });
  }

  /** Supprime un compte social connecté (déconnexion) — libère un slot Late. */
  async deleteAccount(accountId: string): Promise<{ message?: string }> {
    return this.request('DELETE', `/v1/accounts/${accountId}`);
  }

  async listProfiles(): Promise<ZernioProfilesListResponse> {
    return this.request('GET', '/v1/profiles');
  }

  async createProfile(name: string): Promise<ZernioProfileCreateResponse> {
    return this.request('POST', '/v1/profiles', { body: { name } });
  }

  /** URL OAuth pour connecter un réseau à un profil (le client la suit, Late gère le flow,
   * puis redirige vers `redirectUrl`). */
  async getConnectUrl(platform: string, profileId: string, redirectUrl: string): Promise<ZernioConnectUrlResponse> {
    return this.request('GET', `/v1/connect/${platform}`, { params: { profileId, redirectUrl } });
  }

  // ---------------------------------------------------------------------------
  // Inbox commentaires — port de late/resources/_generated/comments.py (add-on Inbox
  // requis côté Late : un compte sans cet add-on reçoit un 402/403 addon_required).
  // ---------------------------------------------------------------------------

  /** Liste les posts commentés (fil d'entrée de l'inbox). */
  async listInboxComments(params: { profileId?: string; platform?: string; limit?: number; cursor?: string; accountId?: string }): Promise<{ data?: unknown[] }> {
    return this.request('GET', '/v1/inbox/comments', {
      params: { profileId: params.profileId, platform: params.platform, sortBy: 'date', sortOrder: 'desc', limit: params.limit ?? 50, cursor: params.cursor, accountId: params.accountId },
    });
  }

  /** Fil des commentaires d'UN post. */
  async getInboxPostComments(postId: string, accountId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ comments?: unknown[] }> {
    return this.request('GET', `/v1/inbox/comments/${postId}`, { params: { accountId, limit: opts.limit ?? 25, cursor: opts.cursor } });
  }

  /** Répond à un post/commentaire de l'inbox. */
  async replyToInboxPost(postId: string, accountId: string, message: string, commentId?: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/inbox/comments/${postId}`, { body: { accountId, message, commentId } });
  }

  async deleteInboxComment(postId: string, accountId: string, commentId: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/v1/inbox/comments/${postId}`, { params: { accountId, commentId } });
  }

  async hideInboxComment(postId: string, commentId: string, accountId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/inbox/comments/${postId}/${commentId}/hide`, { body: { accountId } });
  }

  async unhideInboxComment(postId: string, commentId: string, accountId: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/v1/inbox/comments/${postId}/${commentId}/hide`, { params: { accountId } });
  }

  async likeInboxComment(postId: string, commentId: string, accountId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/inbox/comments/${postId}/${commentId}/like`, { body: { accountId } });
  }

  async unlikeInboxComment(postId: string, commentId: string, accountId: string): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/v1/inbox/comments/${postId}/${commentId}/like`, { params: { accountId } });
  }

  // ---------------------------------------------------------------------------
  // Analytics — port de late/resources/_generated/analytics.py (add-on Analytics requis
  // côté Late : un compte sans cet add-on reçoit un 402/403).
  // ---------------------------------------------------------------------------

  async getAnalytics(params: { profileId: string; platform?: string; fromDate: string; toDate: string; limit?: number }): Promise<{ posts?: Record<string, unknown>[]; overview?: Record<string, unknown> }> {
    return this.request('GET', '/v1/analytics', {
      params: { profileId: params.profileId, platform: params.platform, fromDate: params.fromDate, toDate: params.toDate, limit: params.limit ?? 100 },
    });
  }

  async getDailyMetrics(params: { profileId: string; platform?: string; fromDate: string; toDate: string }): Promise<{ dailyData?: unknown[]; platformBreakdown?: unknown[] }> {
    return this.request('GET', '/v1/analytics/daily-metrics', { params: { profileId: params.profileId, platform: params.platform, fromDate: params.fromDate, toDate: params.toDate } });
  }

  async getBestTimeToPost(profileId: string): Promise<{ slots?: unknown[] }> {
    return this.request('GET', '/v1/analytics/best-time', { params: { profileId } });
  }

  /** Totaux de la période + ceux de la période précédente (`compare=previous_period`),
   * abonnés gagnés par compte, série quotidienne. */
  async getDashboard(params: { profileId: string; platform?: string; fromDate: string; toDate: string }): Promise<Record<string, unknown>> {
    return this.request('GET', '/v1/analytics/dashboard', {
      params: { profileId: params.profileId, platform: params.platform, fromDate: params.fromDate, toDate: params.toDate, compare: 'previous_period' },
    });
  }

  /** Historique quotidien des abonnés : `stats` = { accountId: [{date, followers}] }. */
  async getFollowerStats(params: { profileId: string; fromDate: string; toDate: string }): Promise<{ accounts?: Record<string, unknown>[]; stats?: Record<string, Array<{ date: string; followers: number }>> }> {
    return this.request('GET', '/v1/accounts/follower-stats', { params: { profileId: params.profileId, fromDate: params.fromDate, toDate: params.toDate } });
  }

  /** Engagement moyen selon le nombre de posts par semaine, par réseau. */
  async getPostingFrequency(profileId: string): Promise<{ frequency?: Array<Record<string, unknown>> }> {
    return this.request('GET', '/v1/analytics/posting-frequency', { params: { profileId } });
  }
}
