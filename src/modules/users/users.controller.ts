import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { AuthService, JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DemarrageService } from '../demarrage/demarrage.service';
import { ImpayeService } from '../impaye/impaye.service';
import { QuotaService } from '../quota/quota.service';
import { SocialService, VALID_PLATFORMS } from '../social/social.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { InspirationIntegrateDto } from './dto/inspiration-integrate.dto';
import { InspirationRoleDto } from './dto/inspiration-role.dto';
import { RemoveInspirationDto } from './dto/remove-inspiration.dto';
import { ScheduleUpdateDto } from './dto/schedule-update.dto';
import { SocialConnectDto } from './dto/social-connect.dto';
import { UserUpdateDto } from './dto/user-update.dto';
import { ScheduleService } from './schedule.service';
import { ImageInvalideError, RoleInvalideError, UsersService } from './users.service';

type AuthedRequest = Request & { user: JwtPayload };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function checkImage(file: Express.Multer.File | undefined, messageType: string): void {
  if (!file) throw new BadRequestException(messageType);
  if (!file.mimetype || !file.mimetype.startsWith('image/')) throw new BadRequestException(messageType);
  if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException('Image trop lourde (max 10 Mo)');
}

/** Port direct de backend/routes/users.py. */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly scheduleService: ScheduleService,
    private readonly socialService: SocialService,
    private readonly demarrageService: DemarrageService,
    private readonly authService: AuthService,
    private readonly quotaService: QuotaService,
    private readonly impayeService: ImpayeService,
  ) {}

  @Get('me')
  async getCurrentUser(@Req() req: AuthedRequest) {
    const user = await this.usersService.getUser(req.user.telegram_id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Delete('me')
  async deleteCurrentUser(@Req() req: AuthedRequest) {
    if (!(await this.usersService.deleteUser(req.user.telegram_id))) {
      throw new NotFoundException('User not found');
    }
    return { success: true, message: 'Account deleted' };
  }

  @Patch('me')
  async updateCurrentUser(@Body() dto: UserUpdateDto, @Req() req: AuthedRequest) {
    const updateData = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined && v !== null));
    if (!Object.keys(updateData).length) throw new BadRequestException('No updates provided');
    const user = await this.usersService.updateUser(req.user.telegram_id, updateData);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Upload la photo de profil (image) -> Cloudinary -> users.photo_url. */
  @Post('me/photo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMyPhoto(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    checkImage(file, 'Le fichier doit être une image (jpg, png, webp…)');
    try {
      const url = await this.usersService.uploadPhoto(req.user.telegram_id, file.buffer, file.mimetype);
      return { photo_url: url };
    } catch (e) {
      this.logger.error(`Upload photo error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'upload de la photo");
    }
  }

  /** Change le mot de passe (ancien + nouveau). */
  @Post('me/password')
  async changeMyPassword(@Body() dto: ChangePasswordDto, @Req() req: AuthedRequest) {
    const res = await this.authService.changePassword(req.user.telegram_id, dto.old_password || '', dto.new_password || '');
    if (res.error === 'wrong_old') throw new BadRequestException('Mot de passe actuel incorrect.');
    if (res.error === 'too_short') throw new BadRequestException('Le nouveau mot de passe doit faire au moins 6 caractères.');
    if (res.error) throw new BadRequestException('Impossible de changer le mot de passe.');
    return { success: true };
  }

  /** Upload l'avatar (photo de profil) -> Cloudinary -> users.avatar_url. */
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMyAvatar(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    checkImage(file, 'Le fichier doit être une image (png, jpg, webp…)');
    try {
      const url = await this.usersService.uploadAvatar(req.user.telegram_id, file.buffer, file.mimetype);
      return { avatar_url: url };
    } catch (e) {
      this.logger.error(`Upload avatar error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'upload de l'avatar");
    }
  }

  /** TODO (site_service pas porté) : reprendrait le logo repéré sur le site du client
   * (Playwright) et le pousserait sur Cloudinary. Domaine séparé (analyse de site web),
   * pas encore porté — voir aussi `/me/analyser-site`. */
  @Post('me/logo-depuis-site')
  logoDepuisSite() {
    throw new ServiceUnavailableException("Récupération du logo depuis le site indisponible pour le moment (fonctionnalité en cours de portage).");
  }

  /** Upload le logo de marque (image) -> Cloudinary -> marques.logo_url. */
  @Post('me/logo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMyLogo(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    checkImage(file, 'Le fichier doit être une image (png, svg, webp…)');
    try {
      const url = await this.usersService.uploadLogo(req.user.telegram_id, file.buffer, file.mimetype);
      return { logo_url: url };
    } catch (e) {
      this.logger.error(`Upload logo error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'upload du logo");
    }
  }

  @Delete('me/logo')
  async deleteMyLogo(@Req() req: AuthedRequest) {
    try {
      await this.usersService.deleteLogo(req.user.telegram_id);
      return { success: true };
    } catch (e) {
      this.logger.error(`Delete logo error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Échec de la suppression du logo');
    }
  }

  @Get('me/inspirations')
  async listInspirations(@Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const [images, integrate, ecran] = await Promise.all([
      this.usersService.listInspirations(telegramId),
      this.usersService.listIntegrateFlags(telegramId),
      this.usersService.listEcranFlags(telegramId),
    ]);
    return { images, integrate, ecran };
  }

  /** Rôle d'une image de référence : style (défaut), integrate (mascotte…), ecran (capture
   * d'écran à reproduire dans le mockup). Exclusif. */
  @Post('me/inspirations/role')
  async setInspirationRole(@Body() dto: InspirationRoleDto, @Req() req: AuthedRequest) {
    const url = (dto.url || '').trim();
    const role = (dto.role || 'style').trim();
    if (!url) throw new BadRequestException('url requise');
    try {
      await this.usersService.setRole(req.user.telegram_id, url, role);
    } catch (e) {
      if (e instanceof RoleInvalideError || e instanceof ImageInvalideError) throw new BadRequestException(e.message);
      this.logger.error(`set_role error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Échec de la mise à jour');
    }
    return { success: true, role };
  }

  /** Marque/démarque une inspiration comme « à toujours intégrer littéralement ». */
  @Post('me/inspirations/integrate')
  async setInspirationIntegration(@Body() dto: InspirationIntegrateDto, @Req() req: AuthedRequest) {
    const url = (dto.url || '').trim();
    if (!url) throw new BadRequestException('url requise');
    try {
      await this.usersService.setIntegration(req.user.telegram_id, url, Boolean(dto.integrate));
    } catch (e) {
      if (e instanceof RoleInvalideError || e instanceof ImageInvalideError) throw new BadRequestException('image invalide');
      this.logger.error(`set_integration error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Échec de la mise à jour');
    }
    return { ok: true };
  }

  /** Ajoute une image d'inspiration (style aimé) -> Cloudinary. */
  @Post('me/inspirations')
  @UseInterceptors(FileInterceptor('file'))
  async addInspiration(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    checkImage(file, 'Le fichier doit être une image');
    try {
      return { images: await this.usersService.addInspiration(req.user.telegram_id, file.buffer, file.mimetype) };
    } catch (e) {
      this.logger.error(`Add inspiration error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'upload");
    }
  }

  @Delete('me/inspirations')
  async removeInspiration(@Body() dto: RemoveInspirationDto, @Req() req: AuthedRequest) {
    const url = (dto.url || '').trim();
    if (!url) throw new BadRequestException('url requise');
    return { images: await this.usersService.removeInspiration(req.user.telegram_id, url) };
  }

  @Post('me/connect')
  async connectSocial(@Body() dto: SocialConnectDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    if (!VALID_PLATFORMS.has(dto.platform)) throw new BadRequestException('Invalid platform');
    await this.quotaService.exigerAbonnement(telegramId); // sans carte -> popup mur de paiement (au lieu d'un toast)
    try {
      return await this.socialService.connectPlatform(telegramId, dto.platform);
    } catch (e) {
      this.logger.error(`Social connect error: ${e instanceof Error ? e.message : e}`);
      return { success: false, error: 'Une erreur est survenue lors de la connexion. Réessaie dans un instant.' };
    }
  }

  @Post('me/disconnect')
  async disconnectSocial(@Body() dto: SocialConnectDto, @Req() req: AuthedRequest) {
    if (!VALID_PLATFORMS.has(dto.platform)) throw new BadRequestException('Invalid platform');
    try {
      return await this.socialService.disconnectPlatform(req.user.telegram_id, dto.platform);
    } catch (e) {
      this.logger.error(`Social disconnect error: ${e instanceof Error ? e.message : e}`);
      return { success: false, error: 'Une erreur est survenue lors de la déconnexion. Réessaie dans un instant.' };
    }
  }

  /** Métadonnées des comptes connectés (nom, @username, avatar) pour l'affichage. */
  @Get('me/social-accounts')
  async getSocialAccounts(@Req() req: AuthedRequest) {
    try {
      return { accounts: await this.socialService.listConnectedAccounts(req.user.telegram_id) };
    } catch (e) {
      this.logger.error(`social accounts error: ${e instanceof Error ? e.message : e}`);
      return { accounts: {} };
    }
  }

  /** Premiers pas du compte : les 6 étapes, l'étape courante et si elle bloque la
   * génération. `force=1` : juste après une action, l'état réel, pas le cache de 20s. */
  @Get('me/demarrage')
  async getDemarrage(@Query('force') force: string | undefined, @Req() req: AuthedRequest) {
    return this.demarrageService.etat(req.user.telegram_id, force === '1' || force === 'true');
  }

  // ============ SCHEDULES ============

  @Get('me/schedules')
  async getSchedules(@Req() req: AuthedRequest) {
    try {
      return await this.scheduleService.getSchedules(req.user.telegram_id);
    } catch (e) {
      this.logger.error(`Get schedules error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Put('me/schedules')
  async updateSchedules(@Body() dto: ScheduleUpdateDto, @Req() req: AuthedRequest) {
    try {
      const result = await this.scheduleService.updateSchedules(req.user.telegram_id, dto.schedules);
      if ('error' in result) throw new BadRequestException(result.error);
      return result.data;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`Update schedules error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** TODO (site_service pas porté) : pré-remplirait la fiche de marque à partir du site web
   * du client (Playwright). Domaine séparé, pas encore porté. */
  @Post('me/analyser-site')
  analyserSite() {
    throw new ServiceUnavailableException("Analyse du site indisponible pour le moment (fonctionnalité en cours de portage).");
  }

  /** Reconnexion guidée après une suspension pour impayé — les réseaux que le compte
   * avait, pas encore reconnectés. `a_afficher` une fois le paiement reçu. */
  @Get('me/reconnexion')
  async getReconnexion(@Req() req: AuthedRequest) {
    return this.impayeService.reconnexion(req.user.telegram_id);
  }

  /** Le client ne veut pas reconnecter ce réseau : on retire la ligne de la liste. */
  @Post('me/reconnexion/:plateforme/ignorer')
  async ignorerReconnexion(@Param('plateforme') plateforme: string, @Req() req: AuthedRequest) {
    await this.impayeService.marquerRetabli(req.user.telegram_id, plateforme.toLowerCase(), true);
    return this.impayeService.reconnexion(req.user.telegram_id);
  }
}
