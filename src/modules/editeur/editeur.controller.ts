import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, NotFoundException, Param, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DemarrageService } from '../demarrage/demarrage.service';
import { QuotaService } from '../quota/quota.service';
import { EditeurService } from './editeur.service';
import { MontageCreerDto } from './dto/montage-creer.dto';
import { MontageModifierDto } from './dto/montage-modifier.dto';
import { MontageRendreDto } from './dto/montage-rendre.dto';
import { MontageSilencesDto } from './dto/montage-silences.dto';
import { MontageTranscrireDto } from './dto/montage-transcrire.dto';
import { MontageVoixOffDto } from './dto/montage-voix-off.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/editeur.py. */
@Controller('editeur')
@UseGuards(JwtAuthGuard)
export class EditeurController {
  constructor(
    private readonly editeurService: EditeurService,
    private readonly quotaService: QuotaService,
    private readonly demarrageService: DemarrageService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Get('montages')
  async lister(@Req() req: AuthedRequest) {
    return { montages: await this.editeurService.lister(req.user.telegram_id) };
  }

  @Post('montages')
  async creer(@Body() body: MontageCreerDto, @Req() req: AuthedRequest) {
    return this.editeurService.creer(req.user.telegram_id, body.titre, body.projet, body.source_contenu_id);
  }

  /** Ouvre un reel ou une vidéo de Contenus dans l'éditeur (crée le montage ou rouvre l'existant). */
  @Post('montages/depuis-contenu/:contenuId')
  async depuisContenu(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    const res = await this.editeurService.depuisContenu(req.user.telegram_id, contenuId);
    if ('error' in res) {
      throw new HttpException(res.error, res.error.includes('introuvable') ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST);
    }
    return res;
  }

  @Get('medias')
  async medias(@Req() req: AuthedRequest) {
    return this.editeurService.medias(req.user.telegram_id);
  }

  /** Un fichier audio du client (musique perso...), prêt à poser sur la piste Audio. */
  @Post('audio-import')
  @UseInterceptors(FileInterceptor('file'))
  async audioImport(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    if (!file) throw new BadRequestException('Fichier manquant.');
    const res = await this.editeurService.importerAudio(req.user.telegram_id, file);
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }

  @Get('montages/:montageId')
  async lire(@Param('montageId') montageId: string, @Req() req: AuthedRequest) {
    const m = await this.editeurService.lire(req.user.telegram_id, montageId);
    if (!m) throw new NotFoundException('Montage introuvable.');
    return m;
  }

  @Put('montages/:montageId')
  async modifier(@Param('montageId') montageId: string, @Body() body: MontageModifierDto, @Req() req: AuthedRequest) {
    const m = await this.editeurService.modifier(req.user.telegram_id, montageId, body.projet, body.titre);
    if (!m) throw new NotFoundException('Montage introuvable.');
    return { id: m.id, statut: m.statut, updated_at: m.updated_at };
  }

  /** Remet le projet dans l'état où il était au moment du dernier export. */
  @Post('montages/:montageId/restaurer')
  async restaurer(@Param('montageId') montageId: string, @Req() req: AuthedRequest) {
    const m = await this.editeurService.restaurerRendu(req.user.telegram_id, montageId);
    if (!m) throw new NotFoundException('Aucune version exportée à restaurer.');
    return m;
  }

  @Delete('montages/:montageId')
  async supprimer(@Param('montageId') montageId: string, @Req() req: AuthedRequest) {
    if (!(await this.editeurService.supprimer(req.user.telegram_id, montageId))) throw new NotFoundException('Montage introuvable.');
    return { success: true };
  }

  /** Exporte le montage en vidéo (1 reel de quota) : la ligne Contenus passe en rendu en cours. */
  @Post('montages/:montageId/rendre')
  async rendre(@Param('montageId') montageId: string, @Body() body: MontageRendreDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.demarrageService.exigerProfil(telegramId);
    await this.quotaService.exigerAbonnement(telegramId);
    const res = await this.editeurService.rendre(telegramId, montageId, body.reseau, body.titre);
    if ('error_quota' in res && res.error_quota) {
      const q = res.error_quota;
      throw new HttpException({ raison: q.reason || 'quota', message: q.message || 'Quota de reels épuisé.' }, HttpStatus.PAYMENT_REQUIRED);
    }
    if ('error' in res && res.error) throw new BadRequestException(res.error);
    return res;
  }

  /** « Générer les sous-titres » d'un plan vidéo. Gratuit, plafonné à 10 par heure et par compte. */
  @Post('montages/:montageId/transcrire')
  async transcrire(@Param('montageId') montageId: string, @Body() body: MontageTranscrireDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const cle = `transcrire:${telegramId}`;
    if (this.rateLimitService.lockedFor(cle) > 0) {
      throw new HttpException("Beaucoup de transcriptions d'un coup. Réessaie dans quelques minutes.", HttpStatus.TOO_MANY_REQUESTS);
    }
    this.rateLimitService.fail(cle, 10, 3600, 600);
    const res = await this.editeurService.transcrire(telegramId, montageId, body.element_id);
    if (res.error) throw new BadRequestException(res.error);
    return res;
  }

  /** Génère un clip de voix off à partir d'un texte (1 phrase, 1 quota « voix »). */
  @Post('voix-off')
  async voixOff(@Body() body: MontageVoixOffDto, @Req() req: AuthedRequest) {
    const res = await this.editeurService.genererVoixOff(req.user.telegram_id, body.texte, body.voix);
    if ('error_quota' in res && res.error_quota) {
      const q = res.error_quota;
      throw new HttpException({ raison: q.reason || 'quota', message: q.message || 'Quota de voix off épuisé.' }, HttpStatus.PAYMENT_REQUIRED);
    }
    if ('error' in res && res.error) throw new BadRequestException(res.error);
    return res;
  }

  /** Coupe les silences d'un plan vidéo en un clic. Gratuit, plafonné à 10 par heure. */
  @Post('montages/:montageId/silences')
  async silences(@Param('montageId') montageId: string, @Body() body: MontageSilencesDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const cle = `silences:${telegramId}`;
    if (this.rateLimitService.lockedFor(cle) > 0) {
      throw new HttpException('Beaucoup de détections d\'un coup. Réessaie dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.rateLimitService.fail(cle, 10, 3600, 600);
    const res = await this.editeurService.couperSilences(telegramId, montageId, body.element_id, body.intensite);
    if (res.error) throw new BadRequestException(res.error);
    return res;
  }
}
