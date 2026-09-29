import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { PushService } from '../notifications/push.service';
import { ZernioClientService, ZernioError } from '../zernio/zernio-client.service';

/**
 * Inbox commentaires via l'API Late/Zernio (add-on Inbox requis -> 403 addon_required) —
 * port direct de backend/services/inbox_service.py. Deux niveaux : listInbox (posts avec
 * commentaires) -> postComments (fil d'un post). Webhook `comment.received` -> notification
 * push (temps réel, pas de polling).
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly lateApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
    private readonly pushService: PushService,
    config: ConfigService,
  ) {
    this.lateApiKey = config.get<string>('app.lateApiKey') || '';
  }

  private normPlatform(p: string | null | undefined): string {
    return (p || '').toLowerCase().split('.').pop() || '';
  }

  /** Retrouve le telegram_id du propriétaire d'un compte social, par son identifiant Late. */
  async userByAccount(_platform: string, accountId: string | null | undefined): Promise<string | null> {
    if (!accountId) return null;
    try {
      const row = await this.prisma.comptes_sociaux.findFirst({ where: { late_account_id: accountId }, select: { telegram_id: true } });
      return row?.telegram_id ?? null;
    } catch (e) {
      this.logger.warn(`user_by_account ${accountId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Traite l'event `comment.received` : notifie l'utilisateur par push. */
  async handleCommentWebhook(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const event = String(payload.event || payload.type || '').toLowerCase();
    if (event !== 'comment.received') return { ok: true, ignored: event };
    const comment = (payload.comment as Record<string, unknown>) || {};
    const account = (payload.account as Record<string, unknown>) || {};
    const author = (comment.author as Record<string, unknown>) || {};

    const platform = this.normPlatform((account.platform as string) || (comment.platform as string));
    const accountId = account.id as string | undefined;
    // Ignore nos propres commentaires/réponses
    if (author.username && account.username && author.username === account.username) return { ok: true, ignored: 'self' };

    const telegramId = await this.userByAccount(platform, accountId);
    if (!telegramId) {
      this.logger.log(`comment webhook: user introuvable pour ${platform}/${accountId}`);
      return { ok: true, no_user: true };
    }

    const authorName = (author.name as string) || (author.username as string) || "Quelqu'un";
    const texte = String(comment.text || '').trim();
    const titre = `💬 Nouveau commentaire · ${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
    const body = texte ? `${authorName}: ${texte.slice(0, 90)}` : `${authorName} a commenté ton post`;
    try {
      await this.pushService.sendToUser(telegramId, titre, body, {
        type: 'comment',
        platform,
        post_id: String(comment.postId || comment.platformPostId || ''),
        account_id: String(accountId || ''),
      });
    } catch (e) {
      this.logger.warn(`comment webhook push: ${e instanceof Error ? e.message : e}`);
    }
    return { ok: true, telegram_id: telegramId, platform };
  }

  private async profile(telegramId: string): Promise<string | null> {
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    return u?.late_profile_id ?? null;
  }

  async listInbox(telegramId: string, platform?: string | null): Promise<Record<string, unknown>> {
    if (!this.lateApiKey) return { ok: false, error: 'Indisponible (non configuré).' };
    const profileId = await this.profile(telegramId);
    if (!profileId) return { ok: true, connected: false };
    try {
      const r = await this.zernio.listInboxComments({ profileId, platform: platform ? platform.toLowerCase() : undefined, limit: 50 });
      return { ok: true, connected: true, items: r.data || [] };
    } catch (e) {
      if (e instanceof ZernioError && e.statusCode && [402, 403].includes(e.statusCode)) return { ok: true, addon_required: true };
      this.logger.error(`inbox list error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Inbox indisponible pour le moment.' };
    }
  }

  async postComments(postId: string, accountId: string): Promise<Record<string, unknown>> {
    try {
      const r = await this.zernio.getInboxPostComments(postId, accountId, { limit: 50 });
      return { ok: true, comments: r.comments || [] };
    } catch (e) {
      if (e instanceof ZernioError && e.statusCode && [402, 403].includes(e.statusCode)) return { ok: true, addon_required: true };
      this.logger.error(`post comments error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Commentaires indisponibles.' };
    }
  }

  async reply(postId: string, accountId: string, message: string, commentId?: string | null): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.zernio.replyToInboxPost(postId, accountId, message, commentId ?? undefined);
      return { ok: true };
    } catch (e) {
      this.logger.error(`reply error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: "Échec de l'envoi de la réponse." };
    }
  }

  async action(kind: string, postId: string, commentId: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (kind) {
        case 'like':
          await this.zernio.likeInboxComment(postId, commentId, accountId);
          break;
        case 'unlike':
          await this.zernio.unlikeInboxComment(postId, commentId, accountId);
          break;
        case 'hide':
          await this.zernio.hideInboxComment(postId, commentId, accountId);
          break;
        case 'unhide':
          await this.zernio.unhideInboxComment(postId, commentId, accountId);
          break;
        case 'delete':
          await this.zernio.deleteInboxComment(postId, accountId, commentId);
          break;
        default:
          return { ok: false, error: 'Action inconnue.' };
      }
      return { ok: true };
    } catch (e) {
      this.logger.error(`comment ${kind} error: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: `Échec de l'action (${kind}).` };
    }
  }
}
