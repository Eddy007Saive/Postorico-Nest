import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { QuotaService } from '../quota/quota.service';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';
import { WorkflowsService } from './workflows.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Automatisations des messages privés et commentaires (workflows Zernio). La lecture
 * reste ouverte ; créer, modifier ou activer exige un abonnement (mur de paiement). */
@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly quotaService: QuotaService,
  ) {}

  @Get()
  lister(@Req() req: AuthedRequest) {
    return this.workflows.lister(req.user.telegram_id);
  }

  /** Déclaré AVANT `:id`, sinon « posts » serait pris pour un identifiant de workflow. */
  @Get('posts')
  posts(@Query('accountId') accountId: string | undefined, @Req() req: AuthedRequest) {
    if (!accountId) throw new BadRequestException('accountId requis.');
    return this.workflows.postsCompte(req.user.telegram_id, accountId);
  }

  @Get(':id')
  obtenir(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.workflows.obtenir(req.user.telegram_id, id);
  }

  @Get(':id/executions')
  executions(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.workflows.executions(req.user.telegram_id, id);
  }

  @Post()
  async creer(@Body() dto: CreateWorkflowDto, @Req() req: AuthedRequest) {
    await this.quotaService.exigerAbonnement(req.user.telegram_id);
    return this.workflows.creer(req.user.telegram_id, dto);
  }

  @Patch(':id')
  async modifier(@Param('id') id: string, @Body() dto: UpdateWorkflowDto, @Req() req: AuthedRequest) {
    await this.quotaService.exigerAbonnement(req.user.telegram_id);
    return this.workflows.modifier(req.user.telegram_id, id, dto);
  }

  @Post(':id/activate')
  async activer(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.quotaService.exigerAbonnement(req.user.telegram_id);
    return this.workflows.activer(req.user.telegram_id, id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.workflows.pause(req.user.telegram_id, id);
  }

  @Delete(':id')
  supprimer(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.workflows.supprimer(req.user.telegram_id, id);
  }
}
