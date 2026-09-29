import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { QuotaService } from '../quota/quota.service';
import { CreateAvatarDto } from './dto/create-avatar.dto';
import { HeygenService } from './heygen.service';

type AuthedRequest = Request & { user: JwtPayload };

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 Mo

/** Port direct de backend/routes/heygen.py. */
@Controller('heygen')
@UseGuards(JwtAuthGuard)
export class HeygenController {
  private readonly logger = new Logger(HeygenController.name);

  constructor(
    private readonly heygenService: HeygenService,
    private readonly quotaService: QuotaService,
    private readonly prisma: PrismaService,
  ) {}

  /** Upload la vidéo d'entraînement + description. Enregistre en attente pour revue admin. */
  @Post('create-avatar')
  @UseInterceptors(FileInterceptor('training_video'))
  async createAvatar(@UploadedFile() file: Express.Multer.File, @Body() body: CreateAvatarDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    try {
      await this.quotaService.exigerAbonnement(telegramId); // sans carte -> popup mur de paiement

      const existing = await this.heygenService.getAvatarFromDb(telegramId);
      if (existing && ['pending', 'in_progress', 'complete'].includes(existing.status)) {
        throw new BadRequestException("Vous avez déjà une demande d'avatar en cours ou un avatar actif.");
      }

      const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { nom: true, username: true } });
      if (!user) throw new NotFoundException('Utilisateur non trouvé');
      const avatarName = user.nom || user.username || `Avatar_${telegramId}`;

      if (!file?.mimetype?.startsWith('video/')) {
        throw new BadRequestException(`Le fichier ${file?.originalname || ''} n'est pas une vidéo valide`);
      }
      if (file.size > MAX_FILE_SIZE) throw new BadRequestException('La vidéo dépasse la taille maximale de 500MB');

      this.logger.log(`Uploading training video to Cloudinary for user ${telegramId}`);
      const trainingCloudUrl = await this.heygenService.uploadToCloudinary(file.buffer, `training_${telegramId}`, `heygen_avatars/${telegramId}`);

      await this.heygenService.saveAvatarRequest(telegramId, avatarName, body.description || '', trainingCloudUrl);

      return { message: "Demande d'avatar soumise avec succès", status: 'pending' };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      this.logger.error(`Create avatar error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Info de l'avatar du compte courant. */
  @Get('avatar')
  async getAvatar(@Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    try {
      let avatar = await this.heygenService.getAvatarFromDb(telegramId);
      if (avatar) avatar = await this.heygenService.autoFillPreview(telegramId, avatar);
      return { avatar };
    } catch (e) {
      this.logger.error(`Get avatar error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Delete('avatar')
  async deleteAvatar(@Req() req: AuthedRequest) {
    try {
      await this.heygenService.deleteAvatar(req.user.telegram_id);
      return { message: 'Avatar supprimé' };
    } catch (e) {
      this.logger.error(`Delete avatar error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
