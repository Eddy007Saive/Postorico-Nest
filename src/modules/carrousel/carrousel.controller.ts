import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { mapAgentError, refusQuota } from '../../common/utils/agent-http-errors';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ContenuEvenementService } from '../contenus/contenu-evenement.service';
import { QUALITE_MODELS } from '../claude/claude.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { PlanService } from '../planning/plan.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';
import { CarrouselCustomService } from './carrousel-custom.service';
import { AtelierSatureError, CarrouselRenduService } from './carrousel-rendu.service';
import { CarrouselTexteService } from './carrousel-texte.service';
import { CarrouselDto } from './dto/carrousel.dto';
import { RecolorDto } from './dto/recolor.dto';
import { CarrouselContent } from './interfaces/carrousel-content.interface';

type AuthedRequest = Request & { user: JwtPayload };

// Le réseau côté front est en minuscule ; l'enum contenu.reseau_cible est capitalisé.
const RESEAU_MAP: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  googlebusiness: 'GoogleBusiness',
};

/** Légende COURTE du post carrousel (hook + CTA), publiée au-dessus du carrousel — port
 * direct de `_carrousel_legende` (backend/routes/agent.py). */
function carrouselLegende(content: CarrouselContent | undefined): string {
  if (!content) return '';
  const leg = (content.legende || '').trim();
  if (leg) return leg;
  const parts = [(content.hook || '').trim(), (content.cta?.titre || '').trim()];
  return parts.filter(Boolean).join('\n\n');
}

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class CarrouselController {
  private readonly logger = new Logger(CarrouselController.name);

  constructor(
    private readonly carrouselTexteService: CarrouselTexteService,
    private readonly carrouselRenduService: CarrouselRenduService,
    private readonly carrouselCustomService: CarrouselCustomService,
    private readonly demarrageService: DemarrageService,
    private readonly planningService: PlanningService,
    private readonly planService: PlanService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
    private readonly contenuEvenement: ContenuEvenementService,
  ) {}

  /** Templates de carrousel proposables à ce compte (les sur-mesure non attribués sont
   * exclus). Les templates importés n'ont pas d'aperçu JS : on renvoie leur vignette. */
  @Get('carrousel-templates')
  async listTemplates(@Req() req: AuthedRequest) {
    const autorises = await this.carrouselRenduService.templatesAutorises(req.user.telegram_id);
    const tous = await this.carrouselCustomService.lister();
    const importes = tous
      .filter((t) => autorises.includes(t.id))
      .map((t) => ({ id: t.id, label: t.label, preview_url: t.preview_url }));
    return { templates: autorises, importes };
  }

  /** Génère un carrousel : slides (Claude) + rendu images (Playwright) -> Cloudinary -> Contenus. */
  @Post('carrousel')
  async carrousel(@Body() dto: CarrouselDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const sujet = dto.sujet.trim();
    if (!sujet) throw new BadRequestException('sujet requis');
    const reseau = (dto.reseau || 'linkedin').toLowerCase();
    const nb = Math.max(3, Math.min(10, dto.nb_slides ?? 5));
    const qualite = dto.qualite ?? 'equilibre';
    // Gabarit du carrousel : override explicite sinon celui configuré pour ce réseau.
    let tmpl = dto.template;
    if (!tmpl) {
      const schedules = await this.planService.schedules(telegramId);
      tmpl = schedules.find((s) => s.platform === reseau)?.carrousel_template || 'bold';
    }

    await this.demarrageService.exigerProfil(telegramId);
    const q = await this.quotaService.consume(telegramId, 'carousel');
    if (!q.ok) throw refusQuota(q);

    const depart = process.hrtime.bigint();
    let result: Awaited<ReturnType<CarrouselTexteService['redigerCarrousel']>>;
    try {
      result = await this.carrouselTexteService.redigerCarrousel(
        telegramId,
        sujet,
        nb,
        QUALITE_MODELS[qualite],
        false,
        dto.dimensions,
      );
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Carrousel texte error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
    if ('error' in result) {
      await this.quotaService.refund(q);
      if (result.error === 'parse') {
        throw new HttpException('Échec de génération des slides', HttpStatus.BAD_GATEWAY);
      }
      mapAgentError(result.error);
    }
    await this.quotaService.confirm(q);
    await this.usageService.log(
      telegramId,
      'carrousel',
      QUALITE_MODELS[qualite],
      result.usage,
      q.unit_cost ?? 0,
      qualite,
      undefined,
      dureeS,
    );

    const content = result.content;
    const texte = carrouselLegende(content);
    let contenuId: string | null;
    if (dto.contenu_id) {
      // Régénération : met à jour le contenu existant (+ slides structurées pour la
      // retouche live). contenu_original suit la régénération : c'est une nouvelle
      // proposition de l'IA, pas une retouche du client, donc la base de comparaison
      // pour le taux de modification (H2) doit repartir de ce nouveau texte.
      await this.prisma.contenu.update({
        where: { id: dto.contenu_id },
        data: { contenu: texte, contenu_original: texte, type: 'Carrousel', carrousel_data: content as object },
      });
      contenuId = dto.contenu_id;
    } else {
      const row: Record<string, unknown> = {
        telegram_id: telegramId,
        titre: sujet.slice(0, 120),
        contenu: texte,
        contenu_original: texte,
        statut: 'A_valider',
        type: 'Carrousel',
        carrousel_data: content as object,
      };
      if (RESEAU_MAP[reseau]) {
        row.reseau_cible = RESEAU_MAP[reseau];
        // Réservation du créneau DÈS la création : évite que deux contenus non encore
        // datés calculent le même "prochain jour libre" (chevauchements).
        const creneau = await this.planningService.prochainCreneau(telegramId, row.reseau_cible as string, 'Carrousel');
        if (creneau) row.date_publication = creneau;
      }
      const ins = await this.prisma.contenu.create({ data: row as never });
      contenuId = ins.id;
    }
    // Journal H2 : une (re)génération est une nouvelle proposition de l'IA (même pour un
    // contenu existant), port de routes/agent.py::carrousel.
    await this.contenuEvenement.log(contenuId as string, 'genere', telegramId, texte);

    // Rendu des slides en images + PDF
    let slidesImages: string[] = [];
    let pdfUrl: string | null = null;
    try {
      const res = await this.carrouselRenduService.genererCarrousel(telegramId, content, contenuId, tmpl);
      slidesImages = res.images;
      pdfUrl = res.pdf;
      if (contenuId && slidesImages.length) {
        await this.prisma.contenu.update({
          where: { id: contenuId },
          data: { slides_images: slidesImages, lien_visuel: slidesImages[0], carrousel_pdf: pdfUrl },
        });
      }
    } catch (e) {
      if (e instanceof AtelierSatureError) {
        this.logger.warn('carrousel: atelier saturé');
      } else {
        this.logger.error(`Carrousel render error: ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      contenu_id: contenuId,
      content,
      slides_images: slidesImages,
      carrousel_pdf: pdfUrl,
      quota: { action: 'carousel', used: q.used, limit: q.limit },
    };
  }

  /** Re-rend un carrousel à partir de ses slides stockées, avec de nouvelles
   * couleurs/police. Le TEXTE ne change pas (pas de re-génération IA). Gratuit. */
  @Post('carrousel/recolor')
  async recolor(@Body() dto: RecolorDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const row = await this.prisma.contenu.findFirst({
      where: { id: dto.contenu_id, telegram_id: telegramId },
      select: { carrousel_data: true, reseau_cible: true },
    });
    if (!row || !row.carrousel_data) {
      throw new UnprocessableEntityException(
        "Ce carrousel n'a pas ses slides enregistrées (généré avant cette fonction). Régénère-le une fois pour activer la retouche.",
      );
    }
    // Style : choix ponctuel pour CE carrousel s'il est fourni, sinon celui configuré pour
    // le réseau du contenu. templateValide() retombe sur « creme » si le client n'y a pas droit.
    let templateVoulu = dto.template;
    if (!templateVoulu) {
      const reseau = (row.reseau_cible || 'LinkedIn').toLowerCase();
      const schedules = await this.planService.schedules(telegramId);
      templateVoulu = schedules.find((s) => s.platform === reseau)?.carrousel_template ?? undefined;
    }
    const template = await this.carrouselRenduService.templateValide(templateVoulu, telegramId);
    try {
      const res = await this.carrouselRenduService.genererCarrousel(
        telegramId,
        row.carrousel_data as unknown as CarrouselContent,
        dto.contenu_id,
        template,
        dto.colors,
        dto.font,
        dto.font_corps,
      );
      if (res.images.length) {
        await this.prisma.contenu.update({
          where: { id: dto.contenu_id },
          data: { slides_images: res.images, lien_visuel: res.images[0], carrousel_pdf: res.pdf },
        });
      }
      return { images: res.images, pdf: res.pdf };
    } catch (e) {
      this.logger.error(`carrousel recolor error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Échec du re-rendu du carrousel.');
    }
  }
}
