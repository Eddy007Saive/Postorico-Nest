import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { refusQuota } from '../../common/utils/agent-http-errors';
import { labelStatutContenu } from '../../common/utils/contenu-enum.util';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DemarrageService } from '../demarrage/demarrage.service';
import { GabaritComposeService } from '../gabarit/gabarit-compose.service';
import { LateService } from '../late/late.service';
import { PlanningService } from '../planning/planning.service';
import { imageAction, QuotaService } from '../quota/quota.service';
import { IMAGE_PRICES, UsageService } from '../usage/usage.service';
import { ImageEditerDto } from './dto/image-editer.dto';
import { ImageDto } from './dto/image.dto';
import { ImagePromptDto } from './dto/image-prompt.dto';
import { PhotoDto } from './dto/photo.dto';
import { IMAGE_MODELS, ImageService } from './image.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Convertit une erreur métier de génération d'image en exception HTTP — port direct du
 * bloc d'erreurs de POST /agent/image (backend/routes/agent.py). */
function mapImageError(error: string): never {
  if (error === 'no_openrouter_key') {
    throw new InternalServerErrorException(
      "Génération d'image indisponible : clé image non configurée (contacte le support).",
    );
  }
  if (error === 'no_image') {
    throw new HttpException(
      "Le générateur n'a pas renvoyé d'image. Réessaie, ou simplifie la description.",
      HttpStatus.BAD_GATEWAY,
    );
  }
  if (error.startsWith('image_failed_')) {
    const code = error.replace('image_failed_', '');
    if (code === '402') {
      throw new HttpException(
        "Service de génération d'image momentanément indisponible (crédit du fournisseur d'IA épuisé). " +
          "Contacte le support — ton quota n'a pas été décompté.",
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (code === '429') {
      throw new HttpException('Trop de demandes d\'image en même temps. Réessaie dans un instant.', HttpStatus.BAD_GATEWAY);
    }
    if (code === '400') {
      throw new HttpException(
        'Le générateur a refusé la requête (image de référence invalide ou description non conforme). ' +
          'Vérifie ta photo/inspirations dans Paramètres.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    throw new HttpException(
      `Le générateur d'image a renvoyé une erreur (${code}). Réessaie — ton quota n'a pas été décompté.`,
      HttpStatus.BAD_GATEWAY,
    );
  }
  throw new HttpException("Échec de la génération d'image. Réessaie.", HttpStatus.BAD_GATEWAY);
}

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class ImageController {
  private readonly logger = new Logger(ImageController.name);

  constructor(
    private readonly imageService: ImageService,
    private readonly demarrageService: DemarrageService,
    private readonly planningService: PlanningService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
    private readonly lateService: LateService,
    private readonly gabaritComposeService: GabaritComposeService,
  ) {}

  /** Claude écrit un prompt d'image à partir du post (gratuit, éditable). */
  @Post('image-prompt')
  async imagePrompt(@Body() dto: ImagePromptDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const texte = dto.texte.trim();
    if (!texte) throw new BadRequestException('texte requis');
    const style =
      dto.style && (dto.style in this.imageService.stylesImage() || dto.style === 'auto') ? dto.style : 'photo';
    const res = await this.imageService.genererPrompt(telegramId, texte, dto.reseau || 'linkedin', Boolean(dto.avec_photo), style);
    if ('error' in res && res.error === 'no_api_key') {
      throw new InternalServerErrorException('Clé API IA non configurée');
    }
    // Sauvegarde immédiate du prompt sur le contenu -> pas de régénération à la réouverture.
    if (dto.contenu_id && 'prompt' in res && res.prompt) {
      try {
        await this.prisma.contenu.updateMany({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          data: { prompt_image: res.prompt, style_image: res.style },
        });
      } catch (e) {
        this.logger.warn(`save prompt_image error: ${e instanceof Error ? e.message : e}`);
      }
    }
    return res;
  }

  /** Génère l'image (nano-banana) → Cloudinary → contenu.lien_visuel. */
  @Post('image')
  async image(@Body() dto: ImageDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    let prompt = (dto.prompt || '').trim();
    const userInstr = prompt; // instruction BRUTE de l'utilisateur (avant combinaison template)

    // Mode template : le TEXTE vient TOUJOURS du post (accroche composée par Claude à partir
    // du gabarit "statement") ; les consignes de l'utilisateur pilotent le VISUEL (fond, décor,
    // ambiance) et s'y AJOUTENT — elles ne remplacent le texte que si elles le demandent
    // explicitement (« écris plutôt… »). Port de la logique de POST /agent/image
    // (backend/routes/agent.py) restée manquante au premier portage NestJS (repéré le
    // 2026-09-29) : sans elle, le prompt du template ne reflétait plus le texte réel du post.
    if (dto.template_mode && dto.contenu_id) {
      let accroche = '';
      try {
        const c = await this.prisma.contenu.findFirst({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          select: { contenu: true, titre: true },
        });
        const textePost = c?.contenu || c?.titre || '';
        const comp = await this.gabaritComposeService.composerGabarit(telegramId, 'statement', textePost);
        if (!('error' in comp)) {
          const titleLines = (comp.slots.title_lines as Array<{ t?: string }> | undefined) || [];
          accroche = titleLines.map((l) => l.t || '').join(' ').trim();
        }
      } catch (e) {
        this.logger.warn(`template accroche ${dto.contenu_id}: ${e instanceof Error ? e.message : e}`);
      }
      if (userInstr && accroche) {
        prompt =
          `Texte à afficher : ${accroche}\n` +
          `Consignes de l'utilisateur (elles concernent le VISUEL — fond, décor, ambiance — et ` +
          `s'appliquent EN PLUS du « Texte à afficher », qui reste affiché tel quel, SAUF si elles ` +
          `demandent explicitement un autre texte) : ${userInstr}`;
      } else if (userInstr) {
        prompt = `Consignes de l'utilisateur : ${userInstr}`;
      } else if (accroche) {
        prompt = `Texte à afficher : ${accroche}`;
      }
    }
    if (!prompt) throw new BadRequestException('prompt requis');
    const modele = dto.modele || 'nano2';
    const modelId = IMAGE_MODELS[modele] || undefined;
    const actionType = imageAction(modele);
    await this.demarrageService.exigerProfil(telegramId);
    const q = await this.quotaService.consume(telegramId, actionType);
    if (!q.ok) throw refusQuota(q);

    const style = dto.style && dto.style in this.imageService.stylesImage() ? dto.style : 'photo';
    let ratio = '4:5';
    if (dto.contenu_id) {
      try {
        const t = await this.prisma.contenu.findFirst({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          select: { type: true },
        });
        if (t?.type === 'Story') ratio = '9:16';
      } catch {
        // Repli silencieux : ratio feed par défaut.
      }
    }

    const depart = process.hrtime.bigint();
    let res: Awaited<ReturnType<ImageService['genererImage']>>;
    try {
      res = await this.imageService.genererImage(
        telegramId,
        prompt,
        Boolean(dto.avec_photo),
        modelId,
        dto.contenu_id,
        dto.refs ?? null,
        dto.style_note?.trim() || null,
        Boolean(dto.template_mode),
        ratio,
        dto.integrate_refs ?? null,
        undefined,
        false,
        style,
        dto.ecran_refs ?? null,
      );
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent image error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
    if ('error' in res) {
      await this.quotaService.refund(q);
      mapImageError(res.error);
    }
    await this.quotaService.confirm(q);

    const out: Record<string, unknown> = { lien_visuel: res.lien_visuel };
    if (dto.contenu_id) {
      // prompt_image = la DESCRIPTION du mode IA, mémorisée. En template, on n'y écrit plus les
      // instructions (elles se retrouvaient préremplies dans la description).
      const upd: Record<string, unknown> = { lien_visuel: res.lien_visuel };
      if (!dto.template_mode) {
        upd.prompt_image = prompt;
        upd.style_image = style;
      }
      // Le visuel est prêt -> on fixe la date puis on POUSSE vers Zernio. Le statut ne passe
      // PLUS à "Planifié" ici : seul l'event webhook post.scheduled le confirme (source de
      // vérité = Zernio ; fini les posts "Planifié" qui n'existent nulle part).
      const cur = await this.prisma.contenu.findFirst({
        where: { id: dto.contenu_id, telegram_id: telegramId },
        select: { statut: true, reseau_cible: true, date_publication: true, type: true },
      });
      if (!cur?.date_publication) {
        const creneau = await this.planningService.prochainCreneau(telegramId, cur?.reseau_cible, cur?.type);
        if (creneau) upd.date_publication = creneau;
      }
      await this.prisma.contenu.updateMany({ where: { id: dto.contenu_id, telegram_id: telegramId }, data: upd });
      // labelStatutContenu : Prisma renvoie le nom d'enum mappé (ex. "A_valider"), pas le
      // libellé brut ("A valider") que compare le frontend — voir contenu-enum.util.ts.
      out.statut = labelStatutContenu(cur?.statut);
      const datePublication = upd.date_publication || cur?.date_publication;
      out.date_publication = datePublication;
      // BUG CORRIGÉ : "A_valider" ne doit JAMAIS pousser vers Zernio — sinon un brouillon
      // part se programmer dès qu'on lui génère/régénère une image, avant toute validation
      // explicite. Seul un contenu déjà "Valider" (posté par l'utilisateur) ou déjà "Planifie"
      // (déjà poussé, on rafraîchit juste) déclenche l'auto-programmation ici.
      if ((cur?.statut === 'Valider' || cur?.statut === 'Planifie') && datePublication) {
        try {
          const pub = await this.lateService.programmerContenu(telegramId, dto.contenu_id);
          out.publish_status = pub.ok ? 'envoi' : pub.skipped ? 'ignoré' : 'échec';
        } catch (e) {
          this.logger.warn(`auto-programmation après visuel ${dto.contenu_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    await this.usageService.log(
      telegramId,
      'image',
      modelId || modele,
      {},
      q.unit_cost ?? 0,
      undefined,
      IMAGE_PRICES[modele] ?? 0.04,
      dureeS,
    );
    out.quota = { action: actionType, used: q.used, limit: q.limit };
    return out;
  }

  /** Retouche une image DÉJÀ générée avec une instruction libre. Consomme un quota image. */
  @Post('image/editer')
  async imageEditer(@Body() dto: ImageEditerDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const modele = dto.modele || 'nano2';
    const modelId = IMAGE_MODELS[modele] || undefined;
    const actionType = imageAction(modele);
    let ratio = '4:5';
    if (dto.contenu_id) {
      try {
        const t = await this.prisma.contenu.findFirst({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          select: { type: true },
        });
        if (t?.type === 'Story') ratio = '9:16';
      } catch {
        // Repli silencieux : ratio feed par défaut.
      }
    }
    await this.demarrageService.exigerProfil(telegramId);
    const q = await this.quotaService.consume(telegramId, actionType);
    if (!q.ok) throw refusQuota(q);

    const depart = process.hrtime.bigint();
    let res: Awaited<ReturnType<ImageService['editerImage']>>;
    try {
      res = await this.imageService.editerImage(telegramId, dto.image_url, dto.instruction, modelId, dto.contenu_id, undefined, ratio);
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent image editer error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    const dureeS = Number(process.hrtime.bigint() - depart) / 1e9;
    if ('error' in res) {
      await this.quotaService.refund(q);
      throw new HttpException("Échec de la retouche. Réessaie, ou reformule l'instruction.", HttpStatus.BAD_GATEWAY);
    }
    await this.quotaService.confirm(q);
    if (dto.contenu_id) {
      await this.prisma.contenu.updateMany({
        where: { id: dto.contenu_id, telegram_id: telegramId },
        data: { lien_visuel: res.lien_visuel },
      });
    }
    await this.usageService.log(
      telegramId,
      'image_edit',
      modelId || modele,
      {},
      q.unit_cost ?? 0,
      undefined,
      IMAGE_PRICES[modele] ?? 0.04,
      dureeS,
    );
    return { lien_visuel: res.lien_visuel, quota: { action: actionType, used: q.used, limit: q.limit } };
  }

  /** Génère une PHOTO à partir d'une description (Nano Banana), à utiliser comme photo d'un
   * gabarit / template. Consomme un quota image. */
  @Post('photo')
  async photo(@Body() dto: PhotoDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const description = dto.description.trim();
    if (!description) throw new BadRequestException('Décris la photo à générer.');
    const modele = dto.modele || 'nano2';
    const modelId = IMAGE_MODELS[modele] || undefined;
    const actionType = imageAction(modele);
    await this.demarrageService.exigerProfil(telegramId);
    const q = await this.quotaService.consume(telegramId, actionType);
    if (!q.ok) throw refusQuota(q);

    let res: Awaited<ReturnType<ImageService['genererImage']>>;
    try {
      res = await this.imageService.genererImage(telegramId, description, false, modelId, null);
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent photo error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    if ('error' in res) {
      await this.quotaService.refund(q);
      throw new HttpException('Échec de la génération de la photo. Réessaie ou simplifie la description.', HttpStatus.BAD_GATEWAY);
    }
    await this.quotaService.confirm(q);
    return { url: res.lien_visuel, quota: { action: actionType, used: q.used, limit: q.limit } };
  }
}
