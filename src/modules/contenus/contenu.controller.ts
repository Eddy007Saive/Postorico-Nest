import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { delabeliserContenu, labelStatutContenu, normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../config/prisma.service';
import { LateService } from '../late/late.service';
import { MarqueService } from '../marque/marque.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { AtelierSatureError, CANDIDATS_SERIE, DEFAULT_SIGNATURE, STORY_TEMPLATES, StoryService } from '../story/story.service';
import { ContenuService } from './contenu.service';
import { ContenuUpdateDto } from './dto/contenu-update.dto';
import { RecyclerDto } from './dto/recycler.dto';
import { StoryApercuDto } from './dto/story-apercu.dto';
import { StoryDeclinerDto } from './dto/story-decliner.dto';
import { StorySerieDto } from './dto/story-serie.dto';
import { StoryAnimeeDto } from './dto/story-animee.dto';

type AuthedRequest = Request & { user: JwtPayload };

interface StoryBody {
  accroche?: string | null;
  sous?: string | null;
  cta?: string | null;
  image_source?: string | null;
  rico_pose?: string | null;
  points?: Array<{ titre?: string; desc?: string; icon?: string }> | null;
  baseline?: string | null;
}

/** Port direct de backend/routes/contenus.py. */
@Controller('contenus')
@UseGuards(JwtAuthGuard)
export class ContenuController {
  private readonly logger = new Logger(ContenuController.name);

  constructor(
    private readonly contenuService: ContenuService,
    private readonly lateService: LateService,
    private readonly storyService: StoryService,
    private readonly marqueService: MarqueService,
    private readonly planningService: PlanningService,
    private readonly quotaService: QuotaService,
    private readonly prisma: PrismaService,
  ) {}

  /** Assemble le contenu de la story {accroche, sous, cta, image, rico_pose} à partir du
   * post et des valeurs éditées côté client (retouche). */
  private storyContenu(cur: { lien_visuel?: string | null; slides_images?: unknown }, body: StoryBody) {
    const base = this.storyService.partsDepuisContenu(cur as { titre?: string | null; contenu?: string | null; lien_visuel?: string | null });
    const slides = (Array.isArray(cur.slides_images) ? cur.slides_images : []) as string[];
    const visuelsConnus = new Set([cur.lien_visuel, ...slides].filter(Boolean));
    const imageChoisie = body.image_source;
    const image = imageChoisie && visuelsConnus.has(imageChoisie) ? imageChoisie : cur.lien_visuel;
    return {
      accroche: (body.accroche !== undefined && body.accroche !== null ? body.accroche : base.accroche) || '',
      sous: (body.sous !== undefined && body.sous !== null ? body.sous : base.sous) || '',
      cta: (body.cta || base.cta || 'Réponds en DM 👉').trim(),
      image: image || null,
      rico_pose: body.rico_pose || null,
      points: Array.isArray(body.points) ? body.points : null,
      baseline: body.baseline ?? null,
    };
  }

  /** Importe une image fournie par l'utilisateur comme visuel du contenu. */
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadContenuImage(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    if (!file || !file.mimetype || !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Le fichier doit être une image (jpg, png, webp…)');
    }
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('Image trop lourde (max 10 Mo)');
    let res: Awaited<ReturnType<ContenuService['uploadVisuel']>>;
    try {
      res = await this.contenuService.uploadVisuel(telegramId, id, file.buffer, file.mimetype);
    } catch (e) {
      this.logger.error(`Upload contenu image error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de l'import de l'image");
    }
    if (!res) throw new NotFoundException('Contenu introuvable');
    // Visuel prêt + date -> on programme sur Zernio (le webhook post.scheduled posera le statut Planifie).
    const out: Record<string, unknown> = { ...res, statut: labelStatutContenu(res.statut as string | null | undefined) };
    if (res.date_publication) {
      try {
        const pub = await this.lateService.programmerContenu(telegramId, id);
        out.publish_status = pub.ok ? 'envoi' : pub.skipped ? 'ignoré' : 'échec';
      } catch (e) {
        this.logger.warn(`auto-programmation après import visuel ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  @Post(':id/replanifier')
  async replanifier(@Param('id') id: string, @Req() req: AuthedRequest) {
    const res = await this.contenuService.replanifierContenu(req.user.telegram_id, id);
    if (!res.ok) {
      if (res.error === 'not_found') throw new NotFoundException('Contenu introuvable');
      if (res.error === 'already_published') throw new HttpException('Déjà publié — rien à replanifier.', HttpStatus.CONFLICT);
      if (res.error === 'no_slot') {
        throw new HttpException(
          'Aucun créneau libre trouvé — vérifie ta planification (jours actifs) pour ce réseau.',
          HttpStatus.CONFLICT,
        );
      }
    }
    return { date_publication: res.date_publication, publish_status: res.publish_status, error: res.error ?? null };
  }

  @Post(':id/recycler')
  async recycler(@Param('id') id: string, @Body() dto: RecyclerDto, @Req() req: AuthedRequest) {
    let res: Awaited<ReturnType<ContenuService['recyclerContenu']>>;
    try {
      res = await this.contenuService.recyclerContenu(req.user.telegram_id, id, dto.reseaux || []);
    } catch (e) {
      this.logger.error(`Recycler contenu error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Échec du recyclage');
    }
    if (res.error) throw new BadRequestException(res.error);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Stories
  // ---------------------------------------------------------------------------

  /** Ce dont le sélecteur a besoin : le texte pré-rempli (tiré du post), les modèles
   * proposés à ce compte, et les couleurs de marque par défaut. */
  @Get(':id/story/options')
  async storyOptions(@Param('id') id: string, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId); // sans carte -> popup mur de paiement
    const cur = await this.contenuService.getContenu(id, telegramId);
    if (!cur) throw new NotFoundException('Contenu introuvable');
    if (!['Instagram', 'Facebook'].includes(String(cur.reseau_cible))) {
      throw new HttpException('Les stories ne sont possibles que sur Instagram ou Facebook.', HttpStatus.CONFLICT);
    }
    // Cet appel écrit le texte via Claude (et bientôt choisit le gabarit) : ça consomme,
    // comme post/carrousel/image.
    const q = await this.quotaService.consume(telegramId, 'story');
    if (!q.ok) {
      throw new HttpException({ raison: q.reason || 'quota', message: q.message || 'Génération indisponible.' }, HttpStatus.PAYMENT_REQUIRED);
    }
    const u = await this.marqueService.chargerMarque(telegramId);
    const aUnVisuel = Boolean(cur.lien_visuel);
    // Le FORMAT suit le type de contenu : un carrousel devient une SÉRIE narrative
    // réécrite par l'IA ; un post texte reste une story unique.
    const estSerie = cur.type === 'Carrousel' && Boolean(cur.carrousel_data);
    let ecrans: unknown = null;
    let parts: { accroche: string; sous: string; cta: string };
    let templateSuggere: string;
    let points: unknown = null;
    let fmt: 'serie' | 'unique';
    let modeles: Awaited<ReturnType<StoryService['modelesPour']>>;
    if (estSerie) {
      const prep = await this.storyService.preparerSerieCarrousel(telegramId, cur as never);
      ecrans = prep.ecrans.map((e) => ({ role: e.role, interaction: e.interaction, accroche: e.accroche, sous: e.sous || '', cta: e.cta || '', image_source: e.image }));
      const first = prep.ecrans[0];
      parts = { accroche: first.accroche, sous: first.sous || '', cta: first.cta || '' };
      templateSuggere = prep.template;
      fmt = 'serie';
      const tous = await this.storyService.modelesPour(telegramId, aUnVisuel);
      modeles = tous.filter((m) => this.storyService.templateValide(m.id) && ['epure', 'sombre', 'editorial', 'bloc', 'photo', 'photo-flou', 'split'].includes(m.id));
    } else {
      const choix = await this.storyService.choisirStoryIa(telegramId, cur as never);
      parts = { accroche: choix.accroche, sous: choix.sous, cta: choix.cta };
      templateSuggere = choix.template;
      points = choix.points;
      fmt = 'unique';
      modeles = await this.storyService.modelesPour(telegramId, aUnVisuel);
    }
    await this.quotaService.confirm(q);
    return {
      format: fmt,
      ecrans,
      parts,
      template_suggere: templateSuggere,
      points_suggeres: points,
      a_un_visuel: aUnVisuel,
      modeles,
      signature: DEFAULT_SIGNATURE,
      couleurs: {
        p: (u.carrousel_couleur_principale as string) || (u.couleur_principale as string) || '#003D2E',
        s: (u.carrousel_couleur_secondaire as string) || (u.couleur_secondaire as string) || '#0077FF',
        a: (u.carrousel_couleur_accent as string) || (u.couleur_accent as string) || '#3AFFA3',
      },
    };
  }

  /** Rend UNE story 9:16 (modèle + texte + couleurs) et renvoie son URL — pour la
   * prévisualisation live du sélecteur/retouche, sans encore créer de contenu. */
  @Post(':id/story/apercu')
  async storyApercu(@Param('id') id: string, @Body() body: StoryApercuDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId);
    const cur = await this.contenuService.getContenu(id, telegramId);
    if (!cur) throw new NotFoundException('Contenu introuvable');
    const content = this.storyContenu(cur, body);
    const template = this.storyService.templateEffectif(body.template, content);
    let res: Awaited<ReturnType<StoryService['genererStory']>>;
    try {
      res = await this.storyService.genererStory(telegramId, content, template, body.colors, id);
    } catch (e) {
      if (e instanceof AtelierSatureError) throw new HttpException('Trop de rendus en cours, réessaie dans un instant.', HttpStatus.SERVICE_UNAVAILABLE);
      throw e;
    }
    if (!res.image) throw new InternalServerErrorException('Le rendu de la story a échoué, réessaie.');
    return res;
  }

  /** Crée la SÉRIE de stories d'un carrousel à partir des écrans édités dans le dialog. */
  @Post(':id/story-serie')
  async storySerie(@Param('id') id: string, @Body() body: StorySerieDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId);
    const cur = await this.contenuService.getContenu(id, telegramId);
    if (!cur) throw new NotFoundException('Contenu introuvable');
    if (!['Instagram', 'Facebook'].includes(String(cur.reseau_cible))) {
      throw new HttpException('Les stories ne sont possibles que sur Instagram ou Facebook.', HttpStatus.CONFLICT);
    }
    if (await this.storyService.aDejaUneStory(telegramId, id)) {
      throw new HttpException('Ce post a déjà une story. Supprime-la pour en refaire une.', HttpStatus.CONFLICT);
    }
    const ecrans = body.ecrans || [];
    if (ecrans.length < 2 || ecrans.length > 6 || !ecrans.every((e) => (e.accroche || '').trim())) {
      throw new BadRequestException('Entre 2 et 6 écrans avec une accroche requis.');
    }
    const anime = Boolean(body.anime);
    let template = this.storyService.templateValide(body.template);
    if (!CANDIDATS_SERIE.has(template)) template = 'epure';
    const contents = ecrans.map((e) => this.storyContenu(cur, e));
    const res = await this.storyService.creerSerieStories(telegramId, id, contents, template, body.colors, anime);
    if ('error' in res) {
      const code = res.quota ? HttpStatus.PAYMENT_REQUIRED : res.conflict ? HttpStatus.CONFLICT : HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(res.error, code);
    }
    return res;
  }

  /** Crée une STORY ANIMÉE (Remotion, ~5s) à partir du texte déjà écrit/édité dans le
   * dialog — aucun nouvel appel IA ici. Rendu en arrière-plan (render_queue). */
  @Post(':id/story-anime')
  async storyAnimee(@Param('id') id: string, @Body() body: StoryAnimeeDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId);
    const cur = await this.contenuService.getContenu(id, telegramId);
    if (!cur) throw new NotFoundException('Contenu introuvable');
    if (!['Instagram', 'Facebook'].includes(String(cur.reseau_cible))) {
      throw new HttpException('Les stories ne sont possibles que sur Instagram ou Facebook.', HttpStatus.CONFLICT);
    }
    const accroche = (body.accroche || '').trim();
    if (!accroche) throw new BadRequestException('Accroche requise.');
    if (await this.storyService.aDejaUneStory(telegramId, id)) {
      throw new HttpException('Ce post a déjà une story. Supprime-la pour en refaire une.', HttpStatus.CONFLICT);
    }
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre: (cur.titre || '').slice(0, 120),
      contenu: cur.contenu,
      reseau_cible: cur.reseau_cible,
      type: normTypeContenu('Story'),
      statut: normStatutContenu('A valider'),
      story_source_id: id,
      created_at: new Date(),
    };
    const creneau = await this.planningService.prochainCreneau(telegramId, cur.reseau_cible as string | null, 'Story');
    if (creneau) row.date_publication = creneau;
    const ins = await this.prisma.contenu.create({ data: row as never });
    if (!ins.id) throw new InternalServerErrorException('Création du contenu impossible.');
    try {
      await this.storyService.enqueueStoryAnimee(ins.id, telegramId, accroche, body.sous, body.cta, body.colors);
    } catch (e) {
      this.logger.error(`story anime enqueue ${ins.id}: ${e instanceof Error ? e.message : e}`);
      await this.prisma.contenu.delete({ where: { id: ins.id } });
      throw new InternalServerErrorException('Impossible de lancer le rendu, réessaie.');
    }
    return { id: ins.id, video_status: 'en_traitement', date_publication: row.date_publication ?? null };
  }

  /** Crée la STORY (Instagram/Facebook) à partir du post : visuel 9:16 rendu (modèle
   * choisi + texte + couleurs), statut « À valider », créneau famille story. Le post
   * d'origine n'est PAS modifié. */
  @Post(':id/story')
  async story(@Param('id') id: string, @Body() body: StoryDeclinerDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId);
    const cur = await this.contenuService.getContenu(id, telegramId);
    if (!cur) throw new NotFoundException('Contenu introuvable');
    if (!['Instagram', 'Facebook'].includes(String(cur.reseau_cible))) {
      throw new HttpException('Les stories ne sont possibles que sur Instagram ou Facebook.', HttpStatus.CONFLICT);
    }
    if (await this.storyService.aDejaUneStory(telegramId, id)) {
      throw new HttpException('Ce post a déjà une story. Supprime-la pour en refaire une.', HttpStatus.CONFLICT);
    }
    const template = this.storyService.templateValide(body.template);
    const tinfo = STORY_TEMPLATES.find((t) => t.id === template);
    if (tinfo?.image && !cur.lien_visuel) {
      throw new HttpException('Ce modèle utilise le visuel du post — ajoute une image ou choisis un modèle texte.', HttpStatus.CONFLICT);
    }
    // On réutilise l'image du dernier aperçu si le client la renvoie ; sinon on rend.
    let imageUrl = body.image;
    const content = this.storyContenu(cur, body);
    if (!imageUrl) {
      let res: Awaited<ReturnType<StoryService['genererStory']>>;
      try {
        res = await this.storyService.genererStory(telegramId, content, template, body.colors, id);
      } catch (e) {
        if (e instanceof AtelierSatureError) throw new HttpException('Trop de rendus en cours, réessaie dans un instant.', HttpStatus.SERVICE_UNAVAILABLE);
        throw e;
      }
      imageUrl = res.image ?? undefined;
    }
    if (!imageUrl) throw new InternalServerErrorException('Le rendu de la story a échoué, réessaie.');
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre: (cur.titre || '').slice(0, 120),
      contenu: cur.contenu,
      lien_visuel: imageUrl,
      reseau_cible: cur.reseau_cible,
      type: normTypeContenu('Story'),
      statut: normStatutContenu('A valider'),
      story_source_id: id,
      created_at: new Date(),
    };
    const creneau = await this.planningService.prochainCreneau(telegramId, cur.reseau_cible as string | null, 'Story');
    if (creneau) row.date_publication = creneau;
    const ins = await this.prisma.contenu.create({ data: row as never });
    return { contenu_id: ins.id, date_publication: row.date_publication ?? null, lien_visuel: imageUrl };
  }

  // ---------------------------------------------------------------------------
  // CRUD de base
  // ---------------------------------------------------------------------------
  @Get()
  async getContenus(@Query('statut') statut: string | undefined, @Req() req: AuthedRequest) {
    try {
      const rows = await this.contenuService.getContenus(req.user.telegram_id, statut);
      return rows.map((r) => delabeliserContenu(r));
    } catch (e) {
      this.logger.error(`Get contenus error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get(':id')
  async getContenu(@Param('id') id: string, @Req() req: AuthedRequest) {
    try {
      const contenu = await this.contenuService.getContenu(id, req.user.telegram_id);
      if (!contenu) throw new NotFoundException('Contenu not found');
      return delabeliserContenu(contenu);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      this.logger.error(`Get contenu error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch(':id')
  async updateContenu(@Param('id') id: string, @Body() dto: ContenuUpdateDto, @Req() req: AuthedRequest) {
    try {
      const updateData = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined && v !== null));
      const result = await this.contenuService.updateContenu(id, req.user.telegram_id, updateData);
      if ('error' in result && result.error === 'not_found') throw new NotFoundException('Contenu not found');
      return delabeliserContenu(result);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      this.logger.error(`Update contenu error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Delete(':id')
  async deleteContenu(@Param('id') id: string, @Req() req: AuthedRequest) {
    try {
      if (!(await this.contenuService.deleteContenu(id, req.user.telegram_id))) {
        throw new NotFoundException('Contenu not found');
      }
      return { success: true };
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      this.logger.error(`Delete contenu error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
