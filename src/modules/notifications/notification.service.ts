import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { PushService } from './push.service';

/**
 * Notifications in-app + push pour les événements hors publication (rendus en
 * arrière-plan, etc.) — port direct de backend/services/notification_service.py.
 * `LateService` reste dédié aux événements Zernio (type "publication") ; ici le type
 * est libre. Best-effort : ne lève jamais.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
  ) {}

  /** Insère une notification (cloche) et envoie un push à tous les appareils du compte.
   * `contenuId` permet au front de ramener vers la liste Contenus. */
  async notifier(telegramId: string | null | undefined, contenuId: string | null | undefined, reseau: string | null | undefined, event: string, titre: string, message: string, type = 'rendu'): Promise<void> {
    if (!telegramId) return;
    try {
      await this.prisma.notifications.create({
        data: { telegram_id: telegramId, type, event, titre, message, contenu_id: contenuId ? String(contenuId) : null, reseau },
      });
    } catch (e) {
      this.logger.warn(`notification insert (${event}): ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.pushService.sendToUser(telegramId, titre, message, { event, contenu_id: String(contenuId || '') });
    } catch (e) {
      this.logger.warn(`notification push (${event}): ${e instanceof Error ? e.message : e}`);
    }
  }
}
