import {
  Body,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AgentVideoCorrectionDto, AgentVideoCreerDto } from './agent-video.dto';
import { AgentVideoService } from './agent-video.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Confier sa vidéo à l'agent IA du VPS pour un montage complet, suivre l'avancement, demander des corrections. */
@Controller('agent-video')
@UseGuards(JwtAuthGuard)
export class AgentVideoController {
  constructor(private readonly service: AgentVideoService) {}

  @Post()
  async creer(@Body() dto: AgentVideoCreerDto, @Req() req: AuthedRequest) {
    const r = await this.service.creer(req.user.telegram_id, dto);
    if ('error' in r)
      throw new HttpException({ message: r.error }, r.status || 400);
    return r;
  }

  @Post(':id/corrections')
  async corriger(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentVideoCorrectionDto,
    @Req() req: AuthedRequest,
  ) {
    const r = await this.service.corriger(req.user.telegram_id, id, dto);
    if (r && 'error' in r)
      throw new HttpException({ message: r.error }, r.status || 400);
    return r;
  }

  @Get(':id')
  async etat(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    const r = await this.service.etat(req.user.telegram_id, id);
    if (!r) throw new NotFoundException('Montage introuvable');
    return r;
  }
}
