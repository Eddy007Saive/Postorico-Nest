import { Body, Controller, Get, InternalServerErrorException, Logger, NotFoundException, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CommentaireService } from './commentaire.service';
import { CommentaireUpdateDto } from './dto/commentaire-update.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/commentaires.py. */
@Controller('commentaires')
@UseGuards(JwtAuthGuard)
export class CommentaireController {
  private readonly logger = new Logger(CommentaireController.name);

  constructor(private readonly commentaireService: CommentaireService) {}

  @Get()
  async list(@Query('statut') statut: string | undefined, @Req() req: AuthedRequest) {
    try {
      return await this.commentaireService.getCommentaires(req.user.telegram_id, statut);
    } catch (e) {
      this.logger.error(`Get commentaires error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch(':commentaireId')
  async update(@Param('commentaireId') commentaireId: string, @Body() body: CommentaireUpdateDto, @Req() req: AuthedRequest) {
    try {
      const result = await this.commentaireService.updateCommentaire(commentaireId, req.user.telegram_id, body);
      if (!result) throw new NotFoundException('Commentaire not found');
      return result;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      this.logger.error(`Update commentaire error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
