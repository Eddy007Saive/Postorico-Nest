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
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BanqueService } from '../banque/banque.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { IMAGE_MODELS, ImageService } from '../image/image.service';
import { MusicLibraryService } from '../music/music-library.service';
import { QuotaService, imageAction } from '../quota/quota.service';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { VoixClientError, VoixService } from '../voix/voix.service';
import { DecoupageMusiqueDto } from './dto/decoupage-musique.dto';
import { MiniatureRequestDto } from './dto/miniature-request.dto';
import { ReelCreerDto } from './dto/reel-creer.dto';
import { ReelGenererDto } from './dto/reel-generer.dto';
import { ReelImageGenDto } from './dto/reel-image-gen.dto';
import { ReelImagePromptDto } from './dto/reel-image-prompt.dto';
import { ReelRegenererDto } from './dto/reel-regenerer.dto';
import { ReelVisuelsProposerDto } from './dto/reel-visuels-proposer.dto';
import { VoixDefautDto } from './dto/voix-defaut.dto';
import { MiniatureService } from './miniature.service';
import { ReelService } from './reel.service';

type AuthedRequest = Request & { user: JwtPayload };

function requireTelegramId(req: AuthedRequest): string {
  const id = req.user?.telegram_id;
  if (!id) throw new BadRequestException('Invalid token');
  return id;
}

function quotaHttpException(q: { reason?: string; message?: string }): HttpException {
  return new HttpException({ raison: q.reason || 'quota', message: q.message || 'Génération indisponible.' }, HttpStatus.PAYMENT_REQUIRED);
}

/** Port direct de backend/routes/reels.py. */
@Controller('reels')
@UseGuards(JwtAuthGuard)
export class ReelController {
  private readonly logger = new Logger(ReelController.name);

  constructor(
    private readonly reelService: ReelService,
    private readonly miniatureService: MiniatureService,
    private readonly banqueService: BanqueService,
    private readonly musicLibraryService: MusicLibraryService,
    private readonly voixService: VoixService,
    private readonly quotaService: QuotaService,
    private readonly demarrageService: DemarrageService,
    private readonly imageService: ImageService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  /** Voix off demandée : valide le choix, puis consomme 1 « voix ». En cas de refus, le
   * quota reel déjà réservé est rendu (rien n'a été produit). */
  private async consommerVoix(telegramId: string, voix: string | null | undefined, qReel: { ok: boolean; action_type: string; qty: number; subscription_id?: string; unit_cost?: number }) {
    if (!voix || voix === 'none') return null;
    try {
      await this.voixService.validerChoix(telegramId, voix);
    } catch (e) {
      await this.quotaService.refund(qReel as never);
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
    const qv = await this.quotaService.consume(telegramId, 'voix');
    if (!qv.ok) {
      await this.quotaService.refund(qReel as never);
      throw quotaHttpException(qv);
    }
    return qv;
  }

  private async rendreVoix(qv: Awaited<ReturnType<QuotaService['consume']>> | null): Promise<void> {
    if (qv) await this.quotaService.refund(qv);
  }

  private async confirmerVoix(qv: Awaited<ReturnType<QuotaService['consume']>> | null): Promise<void> {
    if (qv) await this.quotaService.confirm(qv);
  }

  @Get('templates')
  async templates(@Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const [cats, pistes] = await this.musicLibraryService.bibliotheque(telegramId);
    return {
      templates: this.reelService.listeTemplates(),
      musiques: pistes.map((m) => ({ id: m.id, label: m.label, category: m.category, url: m.url })),
      categories: cats,
    };
  }

  @Post('musique')
  @UseInterceptors(FileInterceptor('file'))
  async importerMusique(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const ct = (file?.mimetype || '').toLowerCase();
    const nom = (file?.originalname || '').toLowerCase();
    const ok = ct.startsWith('audio/') || ['video/mp4', 'application/octet-stream'].includes(ct) || /\.(mp3|m4a|wav|aac|ogg)$/.test(nom);
    if (!file || !ok) throw new BadRequestException('Le fichier doit etre un audio (MP3, M4A, WAV…)');
    const res = await this.reelService.importerMusique(telegramId, file.buffer, file.originalname);
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }

  @Patch('musique/:musiqueId')
  async decouperMusique(@Param('musiqueId') musiqueId: string, @Body() body: DecoupageMusiqueDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const res = await this.musicLibraryService.decouper(telegramId, musiqueId, body.debut_s, body.duree_s);
    if ('error' in res) throw new NotFoundException(res.error);
    return res;
  }

  @Delete('musique/:musiqueId')
  async supprimerMusique(@Param('musiqueId') musiqueId: string, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const res = await this.reelService.supprimerMusique(telegramId, musiqueId);
    if ('error' in res) throw new NotFoundException(res.error);
    return res;
  }

  @Get('recommander/:contenuId')
  async recommander(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    return this.reelService.recommanderTemplate(telegramId, contenuId);
  }

  @Post('generer')
  async genererReel(@Body() body: ReelGenererDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    await this.quotaService.exigerAbonnement(telegramId); // sans carte -> popup mur de paiement
    const q = await this.quotaService.consume(telegramId, 'reel');
    if (!q.ok) throw quotaHttpException(q);
    let template = body.template || 'affiche';
    if (body.duree === 'long') template = 'long'; // retro-compat
    const voix = template.startsWith('sequence') ? body.voix : null;
    const qv = await this.consommerVoix(telegramId, voix, q);
    const images = (body.images || []).slice(0, 8).map((i) => ({ url: i.url, desc: i.desc, debut: i.debut, fin: i.fin }));
    let res: Record<string, unknown> | { error: string };
    try {
      res = await this.reelService.genererReel(telegramId, body.contenu_id, {
        template,
        images: images.length ? images : null,
        brief: (body.brief || '').trim() || null,
        style: body.style,
        musique: body.musique,
        voix,
        montageIa: body.montage_ia,
      });
    } catch (e) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      this.logger.error(`generer reel: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Echec de la generation du reel');
    }
    if ('error' in res) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      throw new BadRequestException(res.error);
    }
    await this.quotaService.confirm(q);
    await this.confirmerVoix(qv);
    return res;
  }

  @Post('creer')
  async creer(@Body() body: ReelCreerDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    await this.quotaService.exigerAbonnement(telegramId);
    const q = await this.quotaService.consume(telegramId, 'reel');
    if (!q.ok) throw quotaHttpException(q);
    const qv = await this.consommerVoix(telegramId, body.voix, q);
    const images = (body.images || []).slice(0, 8).map((i) => ({ url: i.url, desc: i.desc, debut: i.debut, fin: i.fin }));
    let res: Record<string, unknown> | { error: string };
    try {
      res = await this.reelService.creerReelLibre(telegramId, body.brief, {
        images: images.length ? images : null,
        reseau: body.reseau || 'Instagram',
        style: body.style,
        musique: body.musique,
        voix: body.voix,
        montageIa: body.montage_ia,
      });
    } catch (e) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      this.logger.error(`creer reel libre: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Echec de la creation du reel');
    }
    if ('error' in res) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      throw new BadRequestException(res.error);
    }
    await this.quotaService.confirm(q);
    await this.confirmerVoix(qv);
    return res;
  }

  @Post('regenerer')
  async regenerer(@Body() body: ReelRegenererDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    await this.quotaService.exigerAbonnement(telegramId);
    const q = await this.quotaService.consume(telegramId, 'reel');
    if (!q.ok) throw quotaHttpException(q);
    let voix = body.voix;
    if (voix === undefined) {
      // Non précisée : on garde celle du reel, et elle se re-synthétise -> elle compte.
      voix = null;
      // (la valeur réelle est relue par reelService.regenererReel via l'ancien scénario)
    }
    const qv = await this.consommerVoix(telegramId, voix, q);
    const images = (body.images || []).slice(0, 8).map((i) => ({ url: i.url, desc: i.desc, debut: i.debut, fin: i.fin }));
    let res: Record<string, unknown> | { error: string };
    try {
      res = await this.reelService.regenererReel(telegramId, body.reel_id, {
        images: images.length ? images : undefined,
        brief: body.brief !== undefined ? (body.brief || '').trim() || null : undefined,
        style: body.style,
        musique: body.musique,
        voix: body.voix !== undefined ? body.voix || 'none' : undefined,
        montageIa: body.montage_ia,
      });
    } catch (e) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      this.logger.error(`regenerer reel: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Echec de la regeneration du reel');
    }
    if ('error' in res) {
      await this.quotaService.refund(q);
      await this.rendreVoix(qv);
      throw new BadRequestException(res.error);
    }
    await this.quotaService.confirm(q);
    await this.confirmerVoix(qv);
    return res;
  }

  @Post('upload-image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadReelImage(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    if (!file?.mimetype?.startsWith('image/')) throw new BadRequestException('Le fichier doit etre une image');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('Image trop lourde (max 10 Mo)');
    try {
      return await this.reelService.uploadImageSource(telegramId, file.buffer);
    } catch (e) {
      this.logger.error(`reel upload image: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Echec de l'upload");
    }
  }

  @Get('banque')
  async banque(@Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    return { images: await this.banqueService.lister(telegramId) };
  }

  @Post('banque')
  @UseInterceptors(FileInterceptor('file'))
  async banqueAjouter(@UploadedFile() file: Express.Multer.File, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const ct = (file?.mimetype || '').toLowerCase();
    const nom = (file?.originalname || '').toLowerCase();
    const estVideo = ct.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/.test(nom);
    if (!file || !(estVideo || ct.startsWith('image/'))) throw new BadRequestException('Le fichier doit etre une image ou une video');
    const limite = estVideo ? 60 : 10;
    if (file.size > limite * 1024 * 1024) throw new BadRequestException(`Fichier trop lourd (max ${limite} Mo${estVideo ? ' pour une video' : ''})`);
    let res: Awaited<ReturnType<BanqueService['ajouter']>>;
    try {
      res = await this.banqueService.ajouter(telegramId, file.buffer, file.mimetype, estVideo);
    } catch (e) {
      this.logger.error(`banque ajouter: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Echec de l'upload");
    }
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }

  @Post('visuels/proposer')
  async visuelsProposer(@Body() body: ReelVisuelsProposerDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    if (!(body.texte || '').trim()) throw new BadRequestException("Le reel n'a pas encore de texte.");
    // Garde-fou anti-boucle : 20 analyses par heure et par compte (chacune ≈ 0,002 $), puis 10 min de pause.
    const cle = `casting:${telegramId}`;
    if (this.rateLimitService.lockedFor(cle) > 0) {
      throw new HttpException('Tu as beaucoup sollicité l’IA. Réessaie dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.rateLimitService.fail(cle, 20, 3600, 600);
    const res = await this.reelService.proposerVisuels(telegramId, body.texte, body.brief, body.maximum);
    if ('error' in res) throw new BadRequestException(res.error);
    return res;
  }

  @Post('image/prompt')
  async imagePrompt(@Body() body: ReelImagePromptDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const brief = (body.brief || '').trim();
    if (!brief) throw new BadRequestException("Décris d'abord ton reel.");
    let res: Awaited<ReturnType<ImageService['genererPrompt']>>;
    try {
      res = await this.imageService.genererPrompt(telegramId, brief, 'instagram');
    } catch (e) {
      this.logger.error(`reel image prompt: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Impossible de proposer une idée d'image.");
    }
    if ('error' in res) throw new InternalServerErrorException("Impossible de proposer une idée d'image.");
    return { prompt: res.prompt };
  }

  @Post('image')
  async imageGenerer(@Body() body: ReelImageGenDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    let prompt = (body.prompt || '').trim();
    const idee = (body.idee || '').trim();
    if (!prompt && !idee) throw new BadRequestException("Décris l'image en quelques mots.");
    await this.demarrageService.exigerProfil(telegramId);
    await this.quotaService.exigerAbonnement(telegramId);
    if (!prompt) {
      // Plan proposé par « Laisser l'IA proposer les visuels » : le prompt complet est écrit
      // maintenant, une fois le client d'accord.
      try {
        prompt = (await this.reelService.promptPourIdee(telegramId, idee, body.texte)) || '';
      } catch (e) {
        this.logger.error(`reel image prompt_pour_idee: ${e instanceof Error ? e.message : e}`);
        prompt = '';
      }
      if (prompt.length < 8) throw new InternalServerErrorException('Impossible de préparer cette image, réessaie.');
    }
    if (prompt.length < 8) throw new BadRequestException("Décris l'image en quelques mots.");
    const modele = body.modele && body.modele in IMAGE_MODELS ? body.modele : 'nano2';
    const q = await this.quotaService.consume(telegramId, imageAction(modele));
    if (!q.ok) throw quotaHttpException(q);
    const publicId = `banque/${telegramId}/ia-${Math.random().toString(16).slice(2, 12)}`;
    let res: Awaited<ReturnType<ImageService['genererImage']>>;
    try {
      res = await this.imageService.genererImage(telegramId, prompt, false, IMAGE_MODELS[modele], null, undefined, undefined, false, '9:16', undefined, publicId);
    } catch (e) {
      await this.quotaService.refund(q);
      this.logger.error(`reel image: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException("Échec de la génération d'image.");
    }
    if ('error' in res) {
      await this.quotaService.refund(q);
      throw new HttpException("Le générateur n'a pas renvoyé d'image. Réessaie, ou simplifie la description.", HttpStatus.BAD_GATEWAY);
    }
    let asset: Awaited<ReturnType<BanqueService['ajouterUrl']>>;
    try {
      asset = await this.banqueService.ajouterUrl(telegramId, res.lien_visuel, prompt, ['ia']);
    } catch (e) {
      this.logger.error(`reel image banque: ${e instanceof Error ? e.message : e}`);
      asset = { error: e instanceof Error ? e.message : String(e) };
    }
    await this.quotaService.confirm(q);
    if ('error' in asset) {
      // L'image existe (Cloudinary) mais n'a pu entrer dans la banque : on la rend quand même.
      return { url: res.lien_visuel, description: prompt, type: 'image', hors_banque: true };
    }
    return asset;
  }

  // ---------------------------------------------------------------- miniature (couverture)

  @Get('miniature/gabarits')
  miniatureGabarits() {
    return { gabarits: this.miniatureService.gabarits(), styles: this.miniatureService.styles(), polices: this.miniatureService.polices() };
  }

  @Post(':contenuId/miniature/textes')
  async miniatureTextes(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    let c: Awaited<ReturnType<MiniatureService['contenu']>>;
    try {
      c = await this.miniatureService.contenu(telegramId, contenuId);
    } catch (e) {
      throw new NotFoundException(e instanceof Error ? e.message : String(e));
    }
    // Proposés UNE fois puis mémorisés sur le reel : rouvrir le dialogue ne rappelle pas
    // l'IA (le client retrouve ses textes, éventuellement déjà retouchés).
    const rd = { ...((c.reel_data as Record<string, unknown>) || {}) };
    const memo = ((rd.miniature as { textes?: Record<string, string> } | undefined)?.textes || rd.miniature_textes) as Record<string, string> | undefined;
    if (memo && memo.titre) return memo;
    try {
      const textes = await this.miniatureService.proposerTextes(telegramId, c);
      rd.miniature_textes = textes;
      await this.miniatureService.memoriserTextes(contenuId, rd);
      return textes;
    } catch (e) {
      this.logger.error(`miniature textes: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Impossible de proposer les textes.');
    }
  }

  @Post(':contenuId/miniature')
  async miniatureGenerer(@Param('contenuId') contenuId: string, @Body() body: MiniatureRequestDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    let c: Awaited<ReturnType<MiniatureService['contenu']>>;
    try {
      c = await this.miniatureService.contenu(telegramId, contenuId);
    } catch (e) {
      throw new NotFoundException(e instanceof Error ? e.message : String(e));
    }
    const textesIn = body.textes || {};
    const textes = {
      kicker: String(textesIn.kicker || '').trim().slice(0, 60),
      titre: String(textesIn.titre || '').trim().slice(0, 60),
      sous: String(textesIn.sous || '').trim().slice(0, 60),
      objet: String(textesIn.objet || '').trim().slice(0, 60),
    };
    const ratio = body.ratio && ['9:16', '16:9'].includes(body.ratio) ? body.ratio : '9:16';
    const gabarit = body.gabarit || 'affiche';
    const style = body.style && body.style in { photo: 1, cinema: 1, '3d': 1, illustration: 1, neon: 1, pop: 1 } ? body.style : 'photo';
    const police = body.police || undefined;
    const ancienne = ((c.reel_data as { miniature?: { fond?: string; style?: string; ref?: string | null } } | undefined)?.miniature) || {};
    if (body.reutiliser_fond && ancienne.fond) {
      try {
        const mini = await this.miniatureService.finaliser(telegramId, c, ancienne.fond, gabarit, textes, ratio, ancienne.style || 'photo', police, ancienne.ref);
        return { miniature: mini };
      } catch (e) {
        this.logger.error(`miniature recomposer: ${e instanceof Error ? e.message : e}`);
        throw new InternalServerErrorException('Échec de la composition de la miniature.');
      }
    }
    await this.demarrageService.exigerProfil(telegramId);
    await this.quotaService.exigerAbonnement(telegramId);
    const modele = body.modele && body.modele in IMAGE_MODELS ? body.modele : 'nano2';
    const q = await this.quotaService.consume(telegramId, imageAction(modele));
    if (!q.ok) throw quotaHttpException(q);
    let fond: string;
    try {
      fond = await this.miniatureService.genererFond(telegramId, c, gabarit, textes, ratio, modele, style, body.ref || null);
    } catch (e) {
      await this.quotaService.refund(q);
      this.logger.error(`miniature generer (fond): ${e instanceof Error ? e.message : e}`);
      throw new HttpException("Échec de la génération de l'image de fond. Réessaie.", HttpStatus.BAD_GATEWAY);
    }
    // Le fond est là (et payé) : la composition du texte se réessaie plutôt que de tout perdre.
    let mini: Awaited<ReturnType<MiniatureService['finaliser']>> | null = null;
    let derniere: unknown;
    for (let essai = 0; essai < 2; essai++) {
      try {
        mini = await this.miniatureService.finaliser(telegramId, c, fond, gabarit, textes, ratio, style, police, body.ref || null);
        break;
      } catch (e) {
        derniere = e;
        this.logger.warn(`miniature composer essai ${essai + 1}/2 : ${e instanceof Error ? e.message : e}`);
      }
    }
    if (mini === null) {
      await this.quotaService.refund(q);
      this.logger.error(`miniature generer (composition): ${derniere instanceof Error ? derniere.message : derniere}`);
      throw new HttpException('Échec de la composition de la miniature. Réessaie.', HttpStatus.BAD_GATEWAY);
    }
    await this.quotaService.confirm(q);
    return { miniature: mini };
  }

  @Delete('banque/:assetId')
  async banqueSupprimer(@Param('assetId') assetId: string, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    const res = await this.banqueService.supprimer(telegramId, assetId);
    if ('error' in res) throw new NotFoundException(res.error);
    return res;
  }

  // ---------------------------------------------------------------- voix off

  @Get('voix')
  async voixCatalogue(@Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    return this.voixService.catalogue(telegramId);
  }

  @Post('voix/clone')
  @UseInterceptors(FileInterceptor('file'))
  async voixCloner(@UploadedFile() file: Express.Multer.File, @Body('consentement') consentement: string, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    if (!(await this.quotaService.isPaid(telegramId))) {
      throw new HttpException({ raison: 'quota', message: 'La voix personnalisée est réservée à l’offre Pro.' }, HttpStatus.PAYMENT_REQUIRED);
    }
    if (!file) throw new BadRequestException('Fichier audio manquant.');
    try {
      return await this.voixService.creerClone(telegramId, file.buffer, file.originalname, consentement === 'true' || consentement === '1');
    } catch (e) {
      if (e instanceof VoixClientError) throw new BadRequestException(e.message);
      this.logger.error(`voix clone ${telegramId}: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('Le clonage a échoué, réessaie.');
    }
  }

  @Delete('voix/clone')
  async voixSupprimer(@Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    return this.voixService.supprimerClone(telegramId);
  }

  @Patch('voix/defaut')
  async voixDefaut(@Body() body: VoixDefautDto, @Req() req: AuthedRequest) {
    const telegramId = requireTelegramId(req);
    try {
      return await this.voixService.choisirDefaut(telegramId, body.voix ?? null);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }
}
