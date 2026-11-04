import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChangerRoleDto, InviterDto, RejoindreDto } from './dto/equipe.dto';
import { EquipeService } from './equipe.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Seul le propriétaire du compte (pas un membre de son équipe) gère l'équipe. Le garde
 * JWT le refuse déjà aux membres (routeInterdite) ; redit ici pour ne pas dépendre de lui. */
function proprietaire(req: AuthedRequest): string {
  if (req.user.equipe || req.user.vision) throw new ForbiddenException('Réservé au propriétaire du compte');
  return req.user.telegram_id;
}

@Controller('equipe')
export class EquipeController {
  constructor(private readonly equipe: EquipeService) {}

  /** Page d'invitation, avant toute connexion. */
  @Get('invitation/:jeton')
  invitation(@Param('jeton') jeton: string) {
    return this.equipe.invitation(jeton);
  }

  /** La personne réellement connectée (origine), même si elle regarde un autre compte. */
  @Post('rejoindre')
  @UseGuards(JwtAuthGuard)
  rejoindre(@Body() dto: RejoindreDto, @Req() req: AuthedRequest) {
    return this.equipe.rejoindre(req.user.origine || req.user.telegram_id, dto.jeton);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  lister(@Req() req: AuthedRequest) {
    return this.equipe.lister(proprietaire(req));
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  inviter(@Body() dto: InviterDto, @Req() req: AuthedRequest) {
    return this.equipe.inviter(proprietaire(req), dto.email, dto.role);
  }

  @Post(':id/renvoyer')
  @UseGuards(JwtAuthGuard)
  async renvoyer(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.equipe.renvoyer(proprietaire(req), id);
    return { success: true };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async changerRole(@Param('id') id: string, @Body() dto: ChangerRoleDto, @Req() req: AuthedRequest) {
    await this.equipe.changerRole(proprietaire(req), id, dto.role);
    return { success: true };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async retirer(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.equipe.retirer(proprietaire(req), id);
    return { success: true };
  }
}
