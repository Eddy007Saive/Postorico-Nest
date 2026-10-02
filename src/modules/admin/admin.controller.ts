import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { EXCLUSIFS, TEMPLATES } from '../carrousel/templates/build-html';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthService, JwtPayload } from '../auth/auth.service';
import { PromoService } from '../promo/promo.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { BillingService } from '../billing/billing.service';
import { CarrouselCustomService, PLACEHOLDERS } from '../carrousel/carrousel-custom.service';
import { PrismaService } from '../../config/prisma.service';
import { MarqueService } from '../marque/marque.service';
import { QuotaService } from '../quota/quota.service';
import { SocialService } from '../social/social.service';
import { UsersService } from '../users/users.service';
import { AdminService } from './admin.service';
import { AvatarUpdateDto } from './dto/avatar-update.dto';
import { CarrouselTemplateImportDto } from './dto/carrousel-template-import.dto';
import { CarrouselTemplatesUpdateDto } from './dto/carrousel-templates-update.dto';
import { PlanUpdateDto } from './dto/plan-update.dto';
import { PushBroadcastDto } from './dto/push-broadcast.dto';
import { QuotaBonusDto } from './dto/quota-bonus.dto';
import { SubmagicThemeUpdateDto } from './dto/submagic-theme-update.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/admin.py.
 *
 * Stub documenté (dépendance pas encore portée) : `/analyser-site` (site_service).
 * `/appliquer-marque` pose bien les champs de marque ; seule la reprise du logo depuis
 * le site est un stub. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly authService: AuthService,
    private readonly billingService: BillingService,
    private readonly socialService: SocialService,
    private readonly quotaService: QuotaService,
    private readonly marqueService: MarqueService,
    private readonly usersService: UsersService,
    private readonly carrouselCustomService: CarrouselCustomService,
    private readonly analyticsService: AnalyticsService,
    private readonly promoService: PromoService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('users')
  async getUsers(@Query('filter') filter: string | undefined, @Query('q') q: string | undefined) {
    try {
      return await this.adminService.getUsers(filter || 'all', q);
    } catch (e) {
      this.logger.error(`Get users error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('users/:id')
  async getUserDetail(@Param('id') id: string) {
    try {
      const user = await this.adminService.getUserDetail(id);
      if (!user) throw new NotFoundException('User not found');
      return user;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      this.logger.error(`Get user detail error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('users/:id/contenus')
  async getUserContenus(@Param('id') id: string) {
    try {
      return await this.adminService.getUserContenus(id);
    } catch (e) {
      this.logger.error(`Get user contenus error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('stats')
  async getAdminStats() {
    try {
      return await this.adminService.getGlobalStats();
    } catch (e) {
      this.logger.error(`Get admin stats error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('invoices')
  async getAllInvoices(@Query('limit') limit: string | undefined) {
    try {
      return { invoices: await this.billingService.listAllInvoices(limit ? parseInt(limit, 10) : 100) };
    } catch (e) {
      this.logger.error(`Get all invoices error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('export/users')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename=users_export.csv')
  async exportUsersCsv() {
    try {
      return await this.adminService.exportUsersCsv();
    } catch (e) {
      this.logger.error(`Export users error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('activity')
  async getActivityLogs(@Query('limit') limit: string | undefined) {
    try {
      return await this.adminService.getActivity(limit ? parseInt(limit, 10) : 50);
    } catch (e) {
      this.logger.error(`Get activity error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch('users/:id/activate')
  async activateUser(@Param('id') id: string) {
    const user = await this.prisma.users.update({ where: { telegram_id: id }, data: { actif: true } }).catch(() => null);
    if (!user) throw new NotFoundException('User not found');

    // Le profil de publication (Zernio) n'est plus créé à l'activation : il l'est à la première
    // connexion d'un réseau par le client (SocialService.ensureLateProfile).
    return this.authService.sanitizeUser(user);
  }

  @Post('users/:id/retry-late')
  async retryLateProfile(@Param('id') id: string) {
    const user = await this.prisma.users.findUnique({ where: { telegram_id: id } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.actif) throw new BadRequestException("L'utilisateur doit être actif pour créer un profil Late");
    try {
      const r = await this.socialService.createLateProfile(id, user.nom || '');
      return { late_profile_created: r.created, late_error: r.error };
    } catch (e) {
      this.logger.warn(`Retry Late profile failed for ${id}: ${e instanceof Error ? e.message : e}`);
      return { late_profile_created: false, late_error: e instanceof Error ? e.message : String(e) };
    }
  }

  @Patch('users/:id/deactivate')
  async deactivateUser(@Param('id') id: string) {
    const user = await this.prisma.users.update({ where: { telegram_id: id }, data: { actif: false } }).catch(() => null);
    if (!user) throw new NotFoundException('User not found');
    return this.authService.sanitizeUser(user);
  }

  @Patch('users/:id/plan')
  async setPlan(@Param('id') id: string, @Body() dto: PlanUpdateDto) {
    const user = await this.adminService.updatePlan(id, dto.plan);
    if (!user) throw new NotFoundException('Plan invalide ou user introuvable');
    return user;
  }

  @Get('resiliations')
  async resiliations() {
    return this.adminService.resiliations();
  }

  @Get('users/:id/facturation')
  async facturation(@Param('id') id: string) {
    return this.billingService.carteEnregistree(id);
  }

  @Post('users/:id/demarrer-abonnement')
  async demarrerAbonnement(@Param('id') id: string, @Body() body: { devise?: string }) {
    const res = await this.billingService.demarrerAbonnement(id, body?.devise);
    if (!res.ok) throw new BadRequestException(res.error);
    return res;
  }

  /** Mode Vision : jeton UTILISATEUR temporaire (1h) pour voir/agir comme le client. */
  @Post('users/:id/vision')
  async startVision(@Param('id') id: string, @Req() req: AuthedRequest) {
    const u = await this.prisma.users.findUnique({ where: { telegram_id: id }, select: { nom: true, email: true, password_hash: true } });
    if (!u) throw new NotFoundException('Client introuvable');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.prisma.vision_sessions.create({
      data: { admin_telegram_id: req.user.telegram_id, target_telegram_id: id, expires_at: expiresAt },
    });
    const token = this.authService.issueVisionToken(id, req.user.telegram_id, u.password_hash);
    this.logger.log(`Mode Vision: admin ${req.user.telegram_id} -> client ${id} (1h)`);
    return { token, expires_at: expiresAt.toISOString(), user: { nom: u.nom, email: u.email } };
  }

  @Get('users/:id/usage')
  async getUserUsage(@Param('id') id: string) {
    try {
      const u = await this.quotaService.usage(id);
      const sub = await this.prisma.subscriptions.findFirst({
        where: { user_id: id, status: { in: ['trialing', 'active', 'past_due'] } },
        orderBy: { created_at: 'desc' },
        select: { plan_id: true },
      });
      let planName: string | null = null;
      if (sub) {
        const p = await this.prisma.plans.findUnique({ where: { id: sub.plan_id }, select: { name: true } });
        planName = p?.name ?? null;
      }
      return { ...u, plan_name: planName };
    } catch (e) {
      this.logger.error(`Get user usage error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Fixe le bonus de quota (extra_quantity) d'un client pour UN type d'action, sur la
   * période en cours. N'affecte que ce client. */
  @Patch('users/:id/quota-bonus')
  async setQuotaBonus(@Param('id') id: string, @Body() dto: QuotaBonusDto) {
    const sub = await this.prisma.subscriptions.findFirst({
      where: { user_id: id, status: { in: ['trialing', 'active', 'past_due'] } },
      orderBy: { created_at: 'desc' },
      select: { id: true, current_period_start: true, current_period_end: true },
    });
    if (!sub) throw new NotFoundException('Aucun abonnement actif pour ce client');

    const rows = await this.prisma.usage_counters.findMany({
      where: { subscription_id: sub.id, action_type: dto.action_type },
      select: { id: true, period_start: true },
    });
    const current = rows.filter((r) => Math.abs(r.period_start.getTime() - sub.current_period_start.getTime()) < 5000);
    if (current.length) {
      await this.prisma.usage_counters.update({ where: { id: current[0].id }, data: { extra_quantity: dto.extra_quantity } });
    } else {
      await this.prisma.usage_counters.create({
        data: {
          subscription_id: sub.id,
          action_type: dto.action_type,
          period_start: sub.current_period_start,
          period_end: sub.current_period_end,
          used_quantity: 0,
          extra_quantity: dto.extra_quantity,
        },
      });
    }
    return this.quotaService.usage(id);
  }

  /** Assigne (ou retire) le thème Submagic de marque d'un compte. */
  @Patch('users/:id/submagic-theme')
  async setSubmagicTheme(@Param('id') id: string, @Body() dto: SubmagicThemeUpdateDto) {
    const upd = {
      submagic_theme_id: (dto.submagic_theme_id || '').trim() || null,
      submagic_theme_label: (dto.submagic_theme_label || '').trim() || null,
    };
    await this.prisma.users.update({ where: { telegram_id: id }, data: upd });
    return { success: true, ...upd };
  }

  /** Catalogue des templates de carrousel sur mesure attribuables à un compte. */
  @Get('carrousel-templates')
  async listCarrouselExclusifs() {
    const importes = await this.carrouselCustomService.lister();
    return {
      exclusifs: [...EXCLUSIFS].sort(),
      importes: importes.map((t) => ({ id: t.id, label: t.label })),
      tous: TEMPLATES,
    };
  }

  /** Attribue (ou retire) les templates de carrousel sur mesure d'un compte. */
  @Patch('users/:id/carrousel-templates')
  async setCarrouselTemplates(@Param('id') id: string, @Body() dto: CarrouselTemplatesUpdateDto) {
    const demandes = (dto.templates || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const connus = new Set([...EXCLUSIFS, ...(await this.carrouselCustomService.ids())]);
    const inconnus = demandes.filter((t) => !connus.has(t));
    if (inconnus.length) throw new BadRequestException(`Template(s) inconnu(s) : ${inconnus.join(', ')}`);
    const csv = [...new Set(demandes)].sort().join(',') || null;
    await this.marqueService.enregistrer(id, { carrousel_templates_exclusifs: csv });
    return { success: true, carrousel_templates_exclusifs: csv };
  }

  /** Templates de carrousel importés (HTML stocké en base). */
  @Get('carrousel-templates/custom')
  async listCarrouselCustom() {
    return { templates: await this.carrouselCustomService.lister(), placeholders: PLACEHOLDERS };
  }

  /** Importe un gabarit HTML : validation du contrat, nettoyage, vignette, enregistrement. */
  @Post('carrousel-templates/custom')
  async importCarrouselCustom(@Body() dto: CarrouselTemplateImportDto, @Req() req: AuthedRequest) {
    const tid = (dto.id || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!tid) throw new BadRequestException('Identifiant requis (lettres, chiffres, tirets)');
    if (TEMPLATES.includes(tid)) throw new BadRequestException(`« ${tid} » est déjà un template intégré`);
    const erreurs = this.carrouselCustomService.valider(dto.html || '');
    if (erreurs.length) throw new BadRequestException(erreurs.join(' '));

    let apercu: string | null = null;
    try {
      apercu = await this.carrouselCustomService.apercuCustom(tid, dto.html);
    } catch (e) {
      this.logger.warn(`Vignette template ${tid}: ${e instanceof Error ? e.message : e}`);
    }
    const row = await this.carrouselCustomService.enregistrer(tid, (dto.label || tid).trim(), dto.html, apercu, req.user.telegram_id);
    return { success: true, id: tid, label: row.label, preview_url: apercu };
  }

  @Delete('carrousel-templates/custom/:tplId')
  async deleteCarrouselCustom(@Param('tplId') tplId: string) {
    await this.carrouselCustomService.supprimer(tplId);
    return { success: true };
  }

  @Get('system')
  async getSystem() {
    try {
      return await this.adminService.systemInfo();
    } catch (e) {
      this.logger.error(`System info error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('analytics-produit')
  async getAnalyticsProduit() {
    try {
      return await this.adminService.analyticsProduit();
    } catch (e) {
      this.logger.error(`Analytics produit error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Verdict H2 (mémoire d'évaluation) : note de ressemblance vs taux de réécriture — port
   * de GET /admin/verdict-h2 (backend/routes/admin.py). */
  @Get('verdict-h2')
  async getVerdictH2() {
    try {
      return await this.adminService.verdictH2();
    } catch (e) {
      this.logger.error(`Verdict H2 error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('api-balances')
  async getApiBalances() {
    try {
      return await this.adminService.apiBalances();
    } catch (e) {
      this.logger.error(`API balances error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** TODO (site_service pas porté) : lirait le site d'un prospect/client et proposerait sa
   * fiche de marque. Domaine séparé (analyse de site web), pas encore porté. */
  @Post('analyser-site')
  analyserSiteAdmin() {
    throw new ServiceUnavailableException('Analyse du site indisponible pour le moment (fonctionnalité en cours de portage).');
  }

  /** Pose sur le compte du client la fiche déduite de son site. Le logo suit un autre
   * chemin (TODO site_service : reprise depuis l'URL du site) que les champs texte. */
  @Post('users/:id/appliquer-marque')
  async appliquerMarque(@Param('id') id: string, @Body() body: { champs?: Record<string, unknown>; logo_url?: string }, @Req() req: AuthedRequest) {
    const champs = body.champs || {};
    const ecrits = Object.keys(champs).length ? await this.marqueService.enregistrer(id, champs) : {};

    let logo: string | null = null;
    if (body.logo_url) {
      this.logger.warn(`appliquer-marque: reprise du logo depuis le site non portée (site_service TODO) pour ${id}`);
    }
    this.logger.log(`AUDIT fiche de marque posée sur ${id} par admin ${req.user.telegram_id} — ${Object.keys(ecrits).length} champ(s)`);
    return { champs: Object.keys(ecrits), logo_url: logo };
  }

  /** Rafraîchit le cache analytics (insights Zernio) de tous les comptes actifs. Le cron
   * horaire (pas encore porté) appellera la même méthode. */
  @Post('analytics/refresh')
  async refreshAnalytics() {
    try {
      return await this.analyticsService.refreshAll();
    } catch (e) {
      this.logger.error(`Refresh analytics error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Post('push')
  async sendPush(@Body() dto: PushBroadcastDto) {
    if (!dto.title.trim() || !dto.body.trim()) throw new BadRequestException('Titre et message requis');
    return this.adminService.broadcastPush(dto.title.trim(), dto.body.trim(), dto.telegram_id);
  }

  @Delete('users/:id')
  async deleteUser(@Param('id') id: string) {
    if (!(await this.usersService.deleteUser(id))) throw new NotFoundException('User not found');
    return { success: true, message: 'User deleted' };
  }

  // ---------------------------------------------------------------------------
  // Avatars HeyGen (2 seules fonctions admin portées — voir admin.service.ts)
  // ---------------------------------------------------------------------------
  @Get('avatars')
  async getAllAvatars() {
    try {
      return await this.adminService.getAllAvatars();
    } catch (e) {
      this.logger.error(`Get avatars error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch('avatars/:id')
  async updateAvatar(@Param('id') id: string, @Body() dto: AvatarUpdateDto) {
    const updateData = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (!Object.keys(updateData).length) throw new BadRequestException('Aucune donnée à mettre à jour');
    const result = await this.adminService.updateAvatarByAdmin(id, updateData);
    if (!result) throw new NotFoundException('Avatar non trouvé');
    return result;
  }

  @Delete('avatars/:id')
  async adminDeleteAvatar(@Param('id') id: string) {
    try {
      await this.prisma.heygen_avatars.deleteMany({ where: { telegram_id: id } });
      return { success: true, message: 'Avatar supprimé' };
    } catch (e) {
      this.logger.error(`Admin delete avatar error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Quotas & offres — configuration
  // ---------------------------------------------------------------------------
  @Get('quota-config')
  async quotaConfig() {
    try {
      return await this.adminService.quotaConfig();
    } catch (e) {
      this.logger.error(`quota_config error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Erreur de chargement de la config');
    }
  }

  @Patch('plans/:id')
  async updatePlanRow(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    try {
      const plan = await this.adminService.updatePlanRow(id, body);
      if (!plan) throw new BadRequestException('Rien à mettre à jour');
      return { success: true, plan };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`update_plan error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch('plan-quotas/:id')
  async updatePlanQuota(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    try {
      const quota = await this.adminService.updatePlanQuota(id, body);
      if (!quota) throw new BadRequestException('Rien à mettre à jour');
      return { success: true, quota };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`update_plan_quota error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Post('plan-quotas')
  async createPlanQuota(@Body() body: Record<string, unknown>) {
    const res = await this.adminService.createPlanQuota(body);
    if ('error' in res) throw new BadRequestException(res.error);
    return { success: true, quota: res };
  }

  @Patch('credit-packs/:id')
  async updatePack(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    try {
      const pack = await this.adminService.updateCreditPack(id, body);
      if (!pack) throw new BadRequestException('Rien à mettre à jour');
      return { success: true, pack };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`update_pack error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Post('credit-packs')
  async createPack(@Body() body: Record<string, unknown>) {
    const res = await this.adminService.createCreditPack(body);
    if ('error' in res) throw new BadRequestException(res.error);
    return { success: true, pack: res };
  }

  @Delete('credit-packs/:id')
  async deletePack(@Param('id') id: string) {
    await this.adminService.deleteCreditPack(id);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Codes promo (Stripe)
  // ---------------------------------------------------------------------------
  @Get('promos')
  async listPromos() {
    return { promos: await this.promoService.listPromos() };
  }

  @Post('promos')
  async createPromo(@Body() body: Record<string, unknown>) {
    const res = await this.promoService.createPromo(body || {});
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }

  @Patch('promos/:id')
  async togglePromo(@Param('id') id: string, @Body() body: { active?: boolean }) {
    const res = await this.promoService.togglePromo(id, Boolean(body?.active));
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }
}
