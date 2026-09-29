import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { AuthService, JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RegisterDto } from '../auth/dto/register.dto';
import { UsersService } from '../users/users.service';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { SwitchAccountDto } from './dto/switch-account.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/accounts.py. */
@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  /** Liste les comptes de la famille (le master + ses sous-comptes) pour le sélecteur. */
  @Get()
  async listAccounts(@Req() req: AuthedRequest) {
    return this.accountsService.listAccounts(req.user);
  }

  /** Crée une nouvelle marque (sous-compte) rattachée au master courant. */
  @Post()
  async createAccount(@Body() dto: CreateAccountDto, @Req() req: AuthedRequest) {
    const master = await this.accountsService.effectiveMaster(req.user);
    const nom = (dto.nom || '').trim();
    const email = (dto.email || '').trim().toLowerCase();
    if (!nom || !email || (dto.password || '').length < 6) {
      throw new BadRequestException('Nom, email et mot de passe (6+ caractères) requis');
    }
    const res = await this.authService.registerUser({ nom, email, username: nom, password: dto.password } as RegisterDto, master);
    return { success: true, telegram_id: res.telegramId, nom, email };
  }

  /** Bascule vers un compte de la famille : renvoie un token scopé sur ce compte. */
  @Post('switch')
  async switchAccount(@Body() dto: SwitchAccountDto, @Req() req: AuthedRequest) {
    if (!dto.telegram_id) throw new BadRequestException('telegram_id requis');
    const { master, row } = await this.accountsService.resoudreCible(req.user, dto.telegram_id);
    const isSub = dto.telegram_id !== master;

    // La qualité d'administrateur suit la PERSONNE connectée, pas la marque qu'elle
    // regarde — relue sur « origine » (le compte qui s'est authentifié), jamais sur la
    // cible (ce serait une élévation de privilège pour une sous-marque ordinaire dont le
    // master est administrateur).
    const origine = req.user.origine || req.user.telegram_id;
    let estAdmin: boolean;
    if (origine === dto.telegram_id) {
      estAdmin = Boolean(row.is_admin);
    } else {
      const o = await this.prisma.users.findUnique({ where: { telegram_id: origine }, select: { is_admin: true } });
      estAdmin = Boolean(o?.is_admin);
    }

    const token = this.authService.issueSwitchToken(dto.telegram_id, row.email, estAdmin, origine, isSub ? master : null, row.password_hash);
    return { token, telegram_id: dto.telegram_id, nom: row.nom };
  }

  /** Supprime un sous-compte possédé par le master (jamais le master lui-même). */
  @Delete(':telegramId')
  async deleteAccount(@Param('telegramId') telegramId: string, @Req() req: AuthedRequest) {
    await this.accountsService.verifierSuppressible(req.user, telegramId);
    await this.usersService.deleteUser(telegramId); // purge (effacement + anonymisation) puis suppression
    return { success: true };
  }
}
