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
  Put,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { v2 as cloudinary } from 'cloudinary';
import type { Request } from 'express';
import { mapAgentError, refusQuota } from '../../common/utils/agent-http-errors';
import { labelTypeContenu } from '../../common/utils/contenu-enum.util';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { ContenuEvenementService } from '../contenus/contenu-evenement.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CarrouselContent } from '../carrousel/interfaces/carrousel-content.interface';
import { AtelierSatureError, CarrouselRenduService } from '../carrousel/carrousel-rendu.service';
import { CarrouselTexteService } from '../carrousel/carrousel-texte.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { PlanService } from '../planning/plan.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { ScriptService } from '../script/script.service';
import { LlmUsage } from '../usage/interfaces/llm-usage.interface';
import { UsageService } from '../usage/usage.service';
import { RafaleDto } from './dto/rafale.dto';
import { RedigerPhotoDto } from './dto/rediger-photo.dto';
import { RedigerDto } from './dto/rediger.dto';
import { EnregistrerDto } from './dto/enregistrer.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { PutDraftsDto } from './dto/put-drafts.dto';
import { PostsService, QUALITE_MODELS } from './posts.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Légende COURTE du post carrousel (hook + CTA), publiée au-dessus du carrousel — c'est
 * le texte du post, jamais le dump complet des slides. */
function carrouselLegende(content: CarrouselContent | null | undefined): string {
  if (!content) return '';
  const leg = (content.legende || '').trim();
  if (leg) return leg;
  const parts = [(content.hook || '').trim(), (content.cta?.titre || '').trim()];
  return parts.filter(Boolean).join('\n\n');
}

// Le réseau côté front est en minuscule ; l'enum contenu.reseau_cible est capitalisé.
const RESEAU_MAP: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  googlebusiness: 'GoogleBusiness',
};

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly postsService: PostsService,
    private readonly demarrageService: DemarrageService,
    private readonly planningService: PlanningService,
    private readonly planService: PlanService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
    private readonly carrouselTexteService: CarrouselTexteService,
    private readonly carrouselRenduService: CarrouselRenduService,
    private readonly scriptService: ScriptService,
    private readonly contenuEvenement: ContenuEvenementService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  @Post('rediger')
  async rediger(@Body() dto: RedigerDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const sujet = dto.sujet.trim();
    if (!sujet) throw new BadRequestException('sujet requis');
    const qualite = dto.qualite ?? 'equilibre';
    await this.demarrageService.exigerProfil(telegramId); // profil de marque minimum, avant de consommer
    const q = await this.quotaService.consume(telegramId, 'post');
    if (!q.ok) throw refusQuota(q);

    const depart = process.hrtime.bigint();
    let result: Awaited<ReturnType<PostsService['redigerPost']>>;
    try {
      result = await this.postsService.redigerPost(
        telegramId,
        sujet,
        dto.reseau || 'linkedin',
        QUALITE_MODELS[qualite],
        false,
        dto.dimensions,
      );
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent rediger error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
    if ('error' in result) {
      await this.quotaService.refund(q);
      mapAgentError(result.error);
    }
    await this.quotaService.confirm(q);
    await this.usageService.log(
      telegramId,
      'post',
      QUALITE_MODELS[qualite],
      result.usage,
      q.unit_cost ?? 0,
      qualite,
      undefined,
      dureeS,
    );

    const out: { contenu: string; usage: unknown; contenu_id?: string | null; quota: unknown } = {
      contenu: result.contenu,
      usage: result.usage,
      quota: { action: 'post', used: q.used, limit: q.limit },
    };
    if (dto.save || dto.brouillon) {
      const data: Record<string, unknown> = {
        telegram_id: telegramId,
        titre: sujet.slice(0, 120),
        contenu: result.contenu,
        contenu_original: result.contenu,
      };
      if (dto.brouillon) {
        // Studio IA : le post vit en base dès sa rédaction, au statut « Brouillon » (pas de
        // créneau : il n'entre dans le planning qu'à la validation, via /agent/enregistrer).
        data.statut = 'Brouillon';
        if (dto.reseau && RESEAU_MAP[dto.reseau]) data.reseau_cible = RESEAU_MAP[dto.reseau];
        if (dto.type === 'Story') data.type = 'Story';
      }
      const row = await this.prisma.contenu.create({ data: data as never });
      out.contenu_id = row.id;
      await this.contenuEvenement.log(row.id, 'genere', telegramId, result.contenu);
    }
    return out;
  }

  /** Vision : génère un post à partir d'une photo (la photo devient aussi le visuel) -> Contenus. */
  @Post('rediger-photo')
  @UseInterceptors(FileInterceptor('file'))
  async redigerPhoto(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: RedigerPhotoDto,
    @Req() req: AuthedRequest,
  ) {
    const telegramId = req.user.telegram_id;
    if (!file) throw new BadRequestException('Le fichier doit être une image (jpg, png, webp…)');
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Le fichier doit être une image (jpg, png, webp…)');
    }
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('Image trop lourde (max 10 Mo)');
    const reseau = (dto.reseau || 'linkedin').toLowerCase();
    const qualite = dto.qualite ?? 'equilibre';
    await this.demarrageService.exigerProfil(telegramId);
    const q = await this.quotaService.consume(telegramId, 'post');
    if (!q.ok) throw refusQuota(q);

    const depart = process.hrtime.bigint();
    let r: Awaited<ReturnType<PostsService['redigerDepuisPhoto']>>;
    try {
      r = await this.postsService.redigerDepuisPhoto(
        telegramId,
        file.buffer.toString('base64'),
        file.mimetype,
        reseau,
        QUALITE_MODELS[qualite],
      );
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`rediger-photo error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
    if ('error' in r) {
      await this.quotaService.refund(q);
      mapAgentError(r.error);
    }
    await this.quotaService.confirm(q);
    await this.usageService.log(telegramId, 'post', QUALITE_MODELS[qualite], r.usage, q.unit_cost ?? 0, qualite, undefined, dureeS);

    const texte = r.contenu;
    let lien: string | null = null;
    try {
      // La photo devient le visuel du post.
      const up = await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`, {
        resource_type: 'image',
        folder: `contenus/${telegramId}`,
        invalidate: true,
      });
      lien = up.secure_url;
    } catch (e) {
      this.logger.error(`rediger-photo cloudinary error: ${e instanceof Error ? e.message : e}`);
    }
    const titre = ((texte ? texte.split('\n', 1)[0] : '') || 'Post photo').slice(0, 120);
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre,
      contenu: texte,
      contenu_original: texte,
      statut: 'A_valider',
    };
    if (RESEAU_MAP[reseau]) {
      row.reseau_cible = RESEAU_MAP[reseau];
      const creneau = await this.planningService.prochainCreneau(telegramId, row.reseau_cible as string);
      if (creneau) row.date_publication = creneau;
    }
    if (lien) row.lien_visuel = lien;
    const ins = await this.prisma.contenu.create({ data: row as never });
    await this.contenuEvenement.log(ins.id, 'genere', telegramId, texte);
    return { contenu_id: ins.id, contenu: texte, lien_visuel: lien, quota: { action: 'post', used: q.used, limit: q.limit } };
  }

  // --- Brouillons du Studio IA (lignes de contenu au statut « Brouillon ») ---
  @Get('brouillons-contenus')
  async brouillonsContenus(@Req() req: AuthedRequest) {
    const rows = await this.prisma.contenu.findMany({
      where: { telegram_id: req.user.telegram_id, statut: 'Brouillon' as never },
      select: { id: true, titre: true, contenu: true, contenu_original: true, reseau_cible: true, type: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({ ...r, type: labelTypeContenu(r.type as string | null) }));
  }

  /** Retouche du texte d'un brouillon (sauvegarde auto du Studio). Ne touche QUE les brouillons. */
  @Patch('brouillons-contenus/:id')
  async majBrouillonContenu(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const data: Record<string, unknown> = { updated_at: new Date() };
    if (typeof body.contenu === 'string') data.contenu = body.contenu;
    if (typeof body.contenu_original === 'string' && body.contenu_original.trim()) data.contenu_original = body.contenu_original;
    const r = await this.prisma.contenu.updateMany({
      where: { id, telegram_id: req.user.telegram_id, statut: 'Brouillon' as never },
      data: data as never,
    });
    if (!r.count) throw new NotFoundException('Brouillon introuvable');
    return { success: true };
  }

  @Delete('brouillons-contenus/:id')
  async supprimerBrouillonContenu(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.prisma.contenu.deleteMany({
      where: { id, telegram_id: req.user.telegram_id, statut: 'Brouillon' as never },
    });
    return { success: true };
  }

  /** Enregistre le texte (éventuellement édité) dans la table contenu. Gratuit. */
  @Post('enregistrer')
  async enregistrer(@Body() dto: EnregistrerDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const contenu = (dto.contenu || '').trim();
    if (!contenu) throw new BadRequestException('contenu requis');
    const titre = (dto.titre || contenu.slice(0, 80)).trim();
    try {
      const row: Record<string, unknown> = { telegram_id: telegramId, titre: titre.slice(0, 120), contenu };
      const reseau = dto.reseau;
      // Story (Instagram/Facebook uniquement) : publiée en éphémère 24h chez Zernio.
      if (dto.type === 'Story') {
        if (reseau !== 'instagram' && reseau !== 'facebook') {
          throw new BadRequestException('Les stories ne sont possibles que sur Instagram ou Facebook.');
        }
        row.type = 'Story';
      }
      if (reseau && RESEAU_MAP[reseau]) {
        row.reseau_cible = RESEAU_MAP[reseau]; // enum single value (LinkedIn, Instagram…)
        // Réservation du créneau DÈS la création (anti-chevauchement, famille story/feed).
        const creneau = await this.planningService.prochainCreneau(telegramId, row.reseau_cible as string, row.type as string | undefined);
        if (creneau) row.date_publication = creneau;
      }
      const contenuOriginal = (dto.contenu_original || '').trim();
      // Brouillon du Studio IA déjà en base : on le PROMEUT (même ligne, même id) en « A valider ».
      if (dto.contenu_id) {
        const ex = await this.prisma.contenu.findFirst({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          select: { statut: true },
        });
        if (ex?.statut === 'Brouillon') {
          const { telegram_id: _t, ...maj } = row;
          await this.prisma.contenu.update({
            where: { id: dto.contenu_id },
            data: { ...maj, statut: 'A_valider', updated_at: new Date() } as never,
          });
          return { success: true, contenu_id: dto.contenu_id };
        }
      }
      if (contenuOriginal) row.contenu_original = contenuOriginal;
      const ins = await this.prisma.contenu.create({ data: row as never });
      await this.contenuEvenement.log(ins.id, 'genere', telegramId, contenuOriginal || contenu);
      return { success: true, contenu_id: ins.id };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`Agent enregistrer error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Jauge de résultats (par type) + état de l'abonnement, pour le dashboard. */
  @Get('usage')
  async usage(@Req() req: AuthedRequest) {
    return this.quotaService.usage(req.user.telegram_id);
  }

  // --- Templates de marque (style réutilisable : images de référence + note) ---
  @Get('templates')
  async listTemplates(@Req() req: AuthedRequest) {
    try {
      return await this.prisma.brand_templates.findMany({
        where: { telegram_id: req.user.telegram_id },
        select: { id: true, nom: true, images: true, note: true, created_at: true },
        orderBy: { created_at: 'desc' },
      });
    } catch (e) {
      this.logger.error(`List templates error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  @Post('templates')
  async createTemplate(@Body() dto: CreateTemplateDto, @Req() req: AuthedRequest) {
    const nom = (dto.nom || '').trim();
    if (!nom) throw new BadRequestException('Nom requis');
    try {
      return await this.prisma.brand_templates.create({
        data: {
          telegram_id: req.user.telegram_id,
          nom: nom.slice(0, 80),
          images: (dto.images || []) as never,
          note: (dto.note || '').trim() || null,
        },
      });
    } catch (e) {
      this.logger.error(`Create template error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Delete('templates/:id')
  async deleteTemplate(@Param('id') id: string, @Req() req: AuthedRequest) {
    try {
      await this.prisma.brand_templates.deleteMany({ where: { id, telegram_id: req.user.telegram_id } });
      return { success: true };
    } catch (e) {
      this.logger.error(`Delete template error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  // --- Brouillons du Studio (persistés côté compte, suivent l'user partout) ---
  @Get('drafts')
  async getDrafts(@Req() req: AuthedRequest) {
    try {
      const row = await this.prisma.studio_drafts.findUnique({ where: { telegram_id: req.user.telegram_id }, select: { data: true } });
      return row?.data ?? [];
    } catch (e) {
      this.logger.error(`Get drafts error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  @Put('drafts')
  async putDrafts(@Body() dto: PutDraftsDto, @Req() req: AuthedRequest) {
    if (!Array.isArray(dto.items)) throw new BadRequestException('items (liste) requis');
    try {
      const telegramId = req.user.telegram_id;
      await this.prisma.studio_drafts.upsert({
        where: { telegram_id: telegramId },
        update: { data: dto.items as never, updated_at: new Date() },
        create: { telegram_id: telegramId, data: dto.items as never, updated_at: new Date() },
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`Put drafts error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Plan éditorial du mois : besoin/rempli/reste/format par réseau actif. */
  @Get('plan')
  async plan(@Query('year') yearQ: string | undefined, @Query('month') monthQ: string | undefined, @Req() req: AuthedRequest) {
    const now = new Date();
    const year = yearQ ? parseInt(yearQ, 10) : now.getUTCFullYear();
    const month = monthQ ? parseInt(monthQ, 10) : now.getUTCMonth() + 1;
    return { year, month, plan: await this.planService.computePlan(req.user.telegram_id, year, month) };
  }

  /** Génère en rafale un lot de contenus (sujet × réseau), les enregistre dans Contenus
   * (statut 'A valider') et les planifie sur des créneaux libres du mois choisi. */
  @Post('rafale')
  async rafale(@Body() dto: RafaleDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    if (!dto.items?.length) throw new BadRequestException('items requis');
    const { year, month } = dto;

    const scheds = await this.planService.schedules(telegramId);
    const formats = new Map(scheds.map((s) => [s.platform, s.format || 'post']));
    const templatesParPlatform = new Map(scheds.map((s) => [s.platform, s.carrousel_template || 'bold']));
    const [start, end] = this.planService.monthBounds(year, month);
    const occupied = new Map<string, Set<string>>();

    const occFor = async (reseauCap: string, famille = 'feed', mode?: string): Promise<Set<string>> => {
      // Occupation PAR FAMILLE en rythme « cumulé » (un reel peut partager le jour d'un
      // post) ; en « à la suite », tous les formats sont dans la même file.
      const key = `${reseauCap}|${famille}`;
      if (!occupied.has(key)) {
        const dates = await this.planService.datesOccupees(telegramId, reseauCap, start, end, famille, mode);
        occupied.set(key, new Set(dates.map((d) => d.slice(0, 10))));
      }
      return occupied.get(key)!;
    };

    let created = 0;
    const errors: Array<Record<string, unknown>> = [];

    for (const it of dto.items) {
      const sujet = (it.sujet || '').trim();
      const dims = it.dimensions;
      const reseauLow = (it.reseau || '').toLowerCase();
      const qualite = it.qualite || 'equilibre';
      const reseauCap = RESEAU_MAP[reseauLow];
      if (!sujet || !reseauCap) {
        errors.push({ sujet, reseau: reseauLow, err: 'invalide' });
        continue;
      }
      // format : choisi par l'utilisateur (par réseau), sinon cadence du réseau. Story =
      // texte court (accroche du visuel) -> même pipeline que post ; le visuel 9:16 suit.
      const fmt = it.format || formats.get(reseauLow) || 'post';
      const action = fmt === 'post' || fmt === 'story' ? 'post' : fmt === 'carrousel' ? 'carrousel' : 'script';
      const qtype = action === 'carrousel' ? 'carousel' : 'post'; // script compte comme un post

      await this.demarrageService.exigerProfil(telegramId); // profil de marque minimum, avant de consommer
      const q = await this.quotaService.consume(telegramId, qtype);
      if (!q.ok) {
        errors.push({ sujet, reseau: reseauLow, err: 'quota', message: q.message });
        break; // quota atteint -> on arrête la rafale
      }
      try {
        const model = QUALITE_MODELS[qualite];
        let ccontent: CarrouselContent | undefined;
        let texte = '';
        let genError: string | undefined;
        let usage: LlmUsage | undefined;

        if (action === 'post') {
          const res = await this.postsService.redigerPost(telegramId, sujet, reseauLow, model, true, dims);
          if ('error' in res) genError = res.error;
          else {
            texte = res.contenu;
            usage = res.usage;
          }
        } else if (action === 'carrousel') {
          const res = await this.carrouselTexteService.redigerCarrousel(telegramId, sujet, 5, model, true, dims);
          if ('error' in res) genError = res.error;
          else {
            ccontent = res.content;
            texte = carrouselLegende(ccontent);
            usage = res.usage;
          }
        } else {
          const tv = fmt === 'reel' ? 'Reel' : 'Video';
          const res = await this.scriptService.redigerScript(telegramId, sujet, tv, model, true, dims);
          if ('error' in res) genError = res.error;
          else {
            texte = res.script;
            usage = res.usage;
          }
        }
        if (genError) {
          await this.quotaService.refund(q);
          errors.push({ sujet, reseau: reseauLow, err: genError });
          continue;
        }
        await this.usageService.log(telegramId, action, model, usage, q.unit_cost ?? 0, qualite);

        const modeReseau = await this.planningService.modeDuReseau(telegramId, reseauLow);
        const typePourFamille = action === 'script' ? 'Video' : fmt === 'story' ? 'Story' : 'Carrousel';
        const famille = this.planningService.familleDe(typePourFamille, modeReseau);
        const oc = await occFor(reseauCap, famille, modeReseau);
        const slots = await this.planService.creneauxLibres(telegramId, reseauCap, year, month, oc);
        const datePub = slots[0];
        if (datePub) oc.add(datePub.slice(0, 10));

        const row: Record<string, unknown> = {
          telegram_id: telegramId,
          titre: sujet.slice(0, 120),
          contenu: texte,
          reseau_cible: reseauCap,
          statut: 'A_valider',
        };
        if (action === 'post' || action === 'carrousel') {
          // Base de comparaison pour le taux de réécriture (H2) — absente pour les scripts.
          row.contenu_original = texte;
        }
        if (datePub) row.date_publication = datePub;
        if (fmt === 'story') {
          // Story : publiée en éphémère 24h chez Zernio, visuel 9:16 requis.
          row.type = 'Story';
        }
        if (action === 'carrousel') {
          row.type = 'Carrousel';
          if (ccontent) row.carrousel_data = ccontent as never; // slides structurées -> re-render sans re-générer le texte
        } else if (action === 'script') {
          // Reel/Vidéo : le texte généré est un SCRIPT, pas un post publiable -> À tourner.
          row.type = fmt === 'reel' ? 'Reel' : 'Video';
          row.statut = 'A_tourner';
          row.script = texte || null;
          row.contenu = null;
        }

        let cid: string | undefined;
        try {
          const ins = await this.prisma.contenu.create({ data: row as never });
          cid = ins.id;
          await this.contenuEvenement.log(cid, 'genere', telegramId, (row.contenu_original as string | null) || texte);
        } catch (e) {
          this.logger.error(`rafale insert error: ${e instanceof Error ? e.message : e}`);
          await this.quotaService.refund(q);
          errors.push({ sujet, reseau: reseauLow, err: 'gen' });
          continue;
        }

        // Carrousel : rendu des images de slides.
        if (action === 'carrousel' && ccontent && cid) {
          try {
            const res = await this.carrouselRenduService.genererCarrousel(telegramId, ccontent, cid, templatesParPlatform.get(reseauLow) || 'creme');
            if (res.images?.length) {
              await this.prisma.contenu.update({
                where: { id: cid },
                data: { slides_images: res.images, lien_visuel: res.images[0], carrousel_pdf: res.pdf },
              });
            } else {
              errors.push({ sujet, reseau: reseauLow, err: 'render_vide' });
            }
          } catch (e) {
            if (e instanceof AtelierSatureError) {
              this.logger.warn('rafale carrousel : atelier saturé');
              errors.push({ sujet, reseau: reseauLow, err: 'atelier_sature' });
            } else {
              this.logger.error(`rafale carrousel render error: ${e instanceof Error ? e.message : e}`);
              errors.push({ sujet, reseau: reseauLow, err: 'render' });
            }
          }
        }
        await this.quotaService.confirm(q);
        created += 1;
      } catch (e) {
        await this.quotaService.refund(q);
        this.logger.error(`rafale item error: ${e instanceof Error ? e.message : e}`);
        errors.push({ sujet, reseau: reseauLow, err: 'gen' });
      }
    }

    return { created, errors, usage: await this.quotaService.usage(telegramId) };
  }
}
