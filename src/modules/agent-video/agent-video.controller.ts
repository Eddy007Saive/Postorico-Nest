import { BadRequestException, Body, Controller, HttpCode, HttpException, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AgentVideoCreerDto, BattementDto, EchecDto, TerminerDto } from './agent-video.dto';
import { AgentVideoService } from './agent-video.service';
import { AgentWorkerGuard } from './agent-worker.guard';

type AuthedRequest = Request & { user: JwtPayload };

/** Côté client : confier ses rushes à l'agent IA pour un montage complet. */
@Controller('agent-video')
@UseGuards(JwtAuthGuard)
export class AgentVideoController {
  constructor(private readonly service: AgentVideoService) {}

  @Post()
  async creer(@Body() dto: AgentVideoCreerDto, @Req() req: AuthedRequest) {
    const r = await this.service.creer(req.user.telegram_id, dto);
    if ('error' in r) throw new HttpException({ message: r.error }, r.status || 400);
    return r;
  }
}

/** Côté worker du VPS (jeton partagé) : réserver, signaler, envoyer, rendre compte. */
@Controller('agent-video/worker')
@UseGuards(AgentWorkerGuard)
export class AgentVideoWorkerController {
  constructor(private readonly service: AgentVideoService) {}

  /** Le prochain travail à faire, ou { travail: null } s'il n'y en a pas. */
  @Post('prendre')
  @HttpCode(200)
  async prendre() {
    return { travail: await this.service.prendre() };
  }

  @Post(':id/battement')
  @HttpCode(200)
  async battement(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BattementDto) {
    if (!(await this.service.battement(id, dto.progression))) throw new NotFoundException('Travail introuvable ou plus en cours');
    return { ok: true };
  }

  @Post(':id/signature')
  @HttpCode(200)
  async signature(@Param('id', ParseUUIDPipe) id: string) {
    const s = await this.service.signature(id);
    if (!s) throw new NotFoundException('Travail introuvable ou plus en cours');
    return s;
  }

  @Post(':id/terminer')
  @HttpCode(200)
  async terminer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TerminerDto) {
    const r = await this.service.terminer(id, dto);
    if ('error' in r) throw new BadRequestException(r.error);
    return r;
  }

  @Post(':id/echec')
  @HttpCode(200)
  async echec(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EchecDto) {
    const r = await this.service.echouer(id, dto.erreur, dto.cout_usd);
    if (!r) throw new NotFoundException('Travail introuvable ou déjà clos');
    return r;
  }
}
