import { BadRequestException, Body, Controller, Get, InternalServerErrorException, Logger, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../config/prisma.service';
import { DeviceTokenDto } from './dto/device-token.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/notifications.py. */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    try {
      const items = await this.prisma.notifications.findMany({
        where: { telegram_id: req.user.telegram_id },
        orderBy: { created_at: 'desc' },
        take: 50,
      });
      return { items, unread: items.filter((n) => !n.lu).length };
    } catch (e) {
      this.logger.error(`list notifications error: ${e instanceof Error ? e.message : e}`);
      return { items: [], unread: 0 };
    }
  }

  @Post('lus')
  async markAllRead(@Req() req: AuthedRequest) {
    await this.prisma.notifications.updateMany({ where: { telegram_id: req.user.telegram_id, lu: false }, data: { lu: true } });
    return { ok: true };
  }

  @Post(':notifId/lu')
  async markRead(@Param('notifId') notifId: string, @Req() req: AuthedRequest) {
    await this.prisma.notifications.updateMany({ where: { id: notifId, telegram_id: req.user.telegram_id }, data: { lu: true } });
    return { ok: true };
  }

  /** Enregistre le token push (FCM) de l'appareil pour l'utilisateur courant. */
  @Post('device-token')
  async registerDeviceToken(@Body() body: DeviceTokenDto, @Req() req: AuthedRequest) {
    const token = (body.token || '').trim();
    if (!token) throw new BadRequestException('token requis');
    const platform = body.platform || 'android';
    try {
      // upsert sur le token (un token = un appareil), rattaché à l'utilisateur courant
      await this.prisma.device_tokens.upsert({
        where: { token },
        create: { telegram_id: req.user.telegram_id, token, platform },
        update: { telegram_id: req.user.telegram_id, platform },
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`register device token error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'enregistrement du token");
    }
  }
}
