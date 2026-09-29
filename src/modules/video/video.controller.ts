import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MUSIC_CATEGORIES, MUSIC_LIBRARY } from '../music/music-library.service';
import { QuotaService } from '../quota/quota.service';
import { VideoDraftDto } from './dto/video-draft.dto';
import { VideoCreateDto } from './dto/video-create.dto';
import { VideoImportDto } from './dto/video-import.dto';
import { VideoRerenderDto } from './dto/video-rerender.dto';
import { MontagePocService, PRESETS } from './montage-poc.service';
import { VideoService } from './video.service';

type AuthedRequest = Request & { user: JwtPayload };

const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 Mo

/** Port direct de backend/routes/video.py. */
@Controller('video')
@UseGuards(JwtAuthGuard)
export class VideoController {
  private readonly logger = new Logger(VideoController.name);

  constructor(
    private readonly videoService: VideoService,
    private readonly montagePoc: MontagePocService,
    private readonly quotaService: QuotaService,
  ) {}

  /** Presets de sous-titres (fixes, Studio Montage) + bibliothèque de sons. */
  @Get('options')
  options() {
    const utilisables = MUSIC_LIBRARY;
    const catsOk = new Set(utilisables.map((m) => m.category));
    return {
      templates: PRESETS,
      custom: [],
      music_categories: MUSIC_CATEGORIES.filter((c) => catsOk.has(c.id)),
      music: utilisables.map((m) => ({ id: m.id, label: m.label, category: m.category, url: m.url })),
    };
  }

  /** Upload la vidéo brute de l'utilisateur → Cloudinary (video) → {video_url}. */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadRaw(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    if (!file?.mimetype?.startsWith('video/')) throw new BadRequestException('Le fichier doit être une vidéo (mp4, mov…)');
    if (file.size > MAX_VIDEO_BYTES) throw new BadRequestException('Vidéo trop lourde (300 Mo max).');
    try {
      return await this.videoService.uploadRaw(telegramId, file.buffer);
    } catch (e) {
      this.logger.error(`raw video upload error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'upload de la vidéo.");
    }
  }

  /** Transcrit la vidéo (envoyée directement) et propose 3 accroches. Gratuit. */
  @Post('suggest_hooks')
  @UseInterceptors(FileInterceptor('file'))
  async suggestHooks(@UploadedFile() file: Express.Multer.File) {
    if (!file?.mimetype?.startsWith('video/')) throw new BadRequestException('Le fichier doit être une vidéo (mp4, mov…)');
    if (file.size > MAX_VIDEO_BYTES) throw new BadRequestException('Vidéo trop lourde (300 Mo max).');
    try {
      const hooks = await this.videoService.suggestHooks(file.buffer, file.originalname || 'video.mp4', file.mimetype);
      return { hooks };
    } catch (e) {
      throw new HttpException(e instanceof Error ? e.message : 'Suggestion indisponible.', HttpStatus.BAD_GATEWAY);
    }
  }

  /** Crée un contenu-script (statut « À tourner ») depuis un script. Gratuit. */
  @Post('draft')
  async draft(@Body() body: VideoDraftDto, @Req() req: AuthedRequest) {
    return this.videoService.draft(req.user.telegram_id, body.script, body.titre, body.reseau);
  }

  /** Lance le montage Studio Montage sur une vidéo déjà uploadée. Consomme un quota 'video'. */
  @Post('create')
  async create(@Body() body: VideoCreateDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const q = await this.quotaService.consume(telegramId, 'video');
    if (!q.ok) {
      throw new HttpException({ raison: q.reason || 'quota', message: q.message || 'Génération indisponible.' }, HttpStatus.PAYMENT_REQUIRED);
    }
    const res = await this.videoService.create(telegramId, body);
    if ('error' in res) {
      await this.quotaService.refund(q);
      throw new HttpException(res.error, HttpStatus.BAD_GATEWAY);
    }
    return res;
  }

  /** Import DIRECT d'une vidéo déjà prête — SANS montage, SANS quota vidéo. */
  @Post('import')
  async importVideo(@Body() body: VideoImportDto, @Req() req: AuthedRequest) {
    try {
      return await this.videoService.importVideo(req.user.telegram_id, body);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Notification Submagic héritée : jamais appelée en pratique (submagic-poc n'a pas de
   * webhook, polling only via /status) — laissée en place, inoffensive. */
  @Post('webhook')
  webhook() {
    return { ok: true };
  }

  @Get(':contenuId/edition')
  async edition(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    try {
      return await this.videoService.edition(contenuId, req.user.telegram_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'not_found') throw new NotFoundException('Contenu introuvable');
      if (msg.includes('pas été montée')) throw new BadRequestException(msg);
      throw new HttpException(msg || 'Studio Montage injoignable.', HttpStatus.BAD_GATEWAY);
    }
  }

  /** Re-monte la vidéo sur place avec les corrections du client. Sans quota. */
  @Post(':contenuId/rerender')
  async rerender(@Param('contenuId') contenuId: string, @Body() body: VideoRerenderDto, @Req() req: AuthedRequest) {
    try {
      return await this.videoService.rerenderVideo(contenuId, req.user.telegram_id, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'not_found') throw new NotFoundException('Contenu introuvable');
      if (msg.startsWith('conflict:')) throw new HttpException(msg.slice('conflict:'.length), HttpStatus.CONFLICT);
      if (msg.includes('pas été montée')) throw new BadRequestException(msg);
      throw new HttpException(msg || "Le re-rendu n'a pas pu démarrer.", HttpStatus.BAD_GATEWAY);
    }
  }

  /** Statut du montage (fallback polling pour le front). */
  @Get('status/:contenuId')
  async status(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    try {
      return await this.videoService.status(req.user.telegram_id, contenuId);
    } catch (e) {
      if (e instanceof Error && e.message === 'not_found') throw new NotFoundException('Contenu introuvable');
      throw e;
    }
  }
}
