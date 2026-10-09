import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envoyerGrosFichier } from '../../common/utils/cloudinary-envoi.util';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService } from '../claude/claude.service';
import { UsageService } from '../usage/usage.service';
import { TranscodageService, VideoTropLongue } from '../transcodage/transcodage.service';

/**
 * Banque de visuels de la marque (table `brand_assets`) — port direct de
 * backend/services/banque_service.py. Le client dépose ses photos ; chaque image est
 * envoyée sur Cloudinary puis DÉCRITE une seule fois par une IA de vision (description +
 * tags). C'est cette banque qui donne des « yeux » à l'agent scénariste des reels.
 */

export const MAX_ASSETS = 30; // par compte — garde-fou de stockage

const ROLE_VISION =
  "Tu décris une image de banque visuelle d'une marque, pour qu'une IA de montage vidéo puisse la choisir plus tard. Réponds UNIQUEMENT en JSON strict :\n" +
  '{"description": "une phrase concrète de 8 à 20 mots (sujet, cadrage, ambiance)", "tags": ["3 à 6 mots-clés simples"]}';

export interface BrandAsset {
  id: string;
  url: string;
  description: string | null;
  tags: string[];
  type: string;
  duree_s: number | null;
  apercu_url: string | null;
  created_at: Date;
}

/** Au-delà, un clip est envoyé par tranches (l'envoi d'un seul bloc dépasse les 60 s du SDK). */
const SEUIL_GROS_CLIP = 20 * 1024 * 1024;

@Injectable()
export class BanqueService {
  private readonly logger = new Logger(BanqueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly usageService: UsageService,
    config: ConfigService,
    private readonly transcodage: TranscodageService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Description + tags par IA vision ; repli neutre si l'appel échoue. Public : réutilisé
   * par ReelService pour décrire un visuel source de reel (upload_image_source côté Python). */
  async decrire(url: string, telegramId?: string): Promise<{ description: string; tags: string[] }> {
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        system: ROLE_VISION,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url } },
              { type: 'text', text: 'Décris cette image. Donne le JSON.' },
            ],
          },
        ],
      });
      if (telegramId) {
        try {
          await this.usageService.log(telegramId, 'banque_vision', 'claude-haiku-4-5', this.claude.usage(resp), 0);
        } catch (e) {
          this.logger.warn(`journal banque_vision: ${e instanceof Error ? e.message : e}`);
        }
      }
      const raw = this.claude.texte(resp);
      const m = /\{.*\}/s.exec(raw);
      const data = JSON.parse(m ? m[0] : raw) as { description?: string; tags?: string[] };
      return {
        description: String(data.description || '').slice(0, 200),
        tags: (data.tags || []).slice(0, 6).map((t) => String(t).slice(0, 30)),
      };
    } catch (e) {
      this.logger.warn(`banque vision: ${e instanceof Error ? e.message : e}`);
      return { description: '', tags: [] };
    }
  }

  async lister(telegramId: string): Promise<BrandAsset[]> {
    const rows = await this.prisma.brand_assets.findMany({
      where: { telegram_id: telegramId },
      select: { id: true, url: true, description: true, tags: true, type: true, duree_s: true, apercu_url: true, created_at: true },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => ({ ...r, duree_s: r.duree_s == null ? null : Number(r.duree_s) }));
  }

  /** Image fixe extraite d'un clip (2e seconde) : sert d'aperçu ET de base à la
   * description par vision — le modèle ne sait pas regarder une vidéo. */
  private vignette(url: string): string {
    const [base, fin] = url.split('/upload/');
    return `${base}/upload/so_2,w_800,q_auto/${fin.replace(/\.[^./]+$/, '')}.jpg`;
  }

  /** Envoi d'un clip de plus de SEUIL_GROS_CLIP.
   * En un seul bloc (data URI + passage en 720p à l'arrivée), un clip de ~50 Mo dépassait les
   * 60 s du SDK (« Request Timeout », constaté le 2026-10-08). Ici : envoi par tranches, et
   * l'URL gardée est celle de l'ORIGINAL, lisible tout de suite — la version 720p n'est que
   * préparée en arrière-plan (eager_async) : tant qu'elle n'est pas prête, son URL ne répond
   * pas, ce qui casserait l'aperçu dans l'éditeur juste après l'import. */
  private async envoyerGrosClip(telegramId: string, data: Buffer): Promise<{ secure_url: string; duration?: number }> {
    const tmp = path.join(os.tmpdir(), `banque_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    await fs.promises.writeFile(tmp, data);
    try {
      const up = await envoyerGrosFichier(tmp, {
        resource_type: 'video',
        folder: `banque/${telegramId}`,
        eager: [{ width: 1280, crop: 'limit', quality: 'auto' }],
        eager_async: true,
      });
      return { secure_url: up.secure_url, duration: up.duration };
    } finally {
      fs.unlink(tmp, () => undefined);
    }
  }

  /** Ajoute un visuel à la banque : Cloudinary -> description vision -> insert.
   * `estVideo=true` : un extrait vidéo, décrit depuis une image extraite du clip. */
  async ajouter(telegramId: string, fileBytes: Buffer, mimetype: string, estVideo = false): Promise<BrandAsset | { error: string }> {
    try {
      if ((await this.lister(telegramId)).length >= MAX_ASSETS) {
        return { error: `Banque pleine (${MAX_ASSETS} visuels maximum). Supprime des visuels d'abord.` };
      }
    } catch (e) {
      this.logger.warn(`banque comptage: ${e instanceof Error ? e.message : e}`);
    }

    // Clip vidéo : passage par ffmpeg avant Cloudinary (H.264 720p, bien plus léger). En cas
    // d'échec de la conversion, l'original part tel quel : l'import n'échoue jamais pour ça.
    if (estVideo) {
      let t: Awaited<ReturnType<TranscodageService['preparer']>>;
      try {
        t = await this.transcodage.preparer(fileBytes, { coteMax: 1280, crf: 20 });
      } catch (e) {
        if (e instanceof VideoTropLongue) return { error: e.message };
        throw e;
      }
      if (t.transcode) {
        fileBytes = t.data;
        mimetype = 'video/mp4';
      }
    }

    let up: { secure_url: string; duration?: number } | undefined;
    // Un gros clip ne passe pas en un seul envoi (délai de 60 s du SDK) : envoi par tranches.
    const grosClip = estVideo && fileBytes.length > SEUIL_GROS_CLIP;
    if (grosClip) {
      up = await this.envoyerGrosClip(telegramId, fileBytes);
    }
    const dataUri = `data:${mimetype};base64,${fileBytes.toString('base64')}`;
    for (let attempt = 1; !grosClip && attempt <= 2; attempt++) {
      try {
        up = await cloudinary.uploader.upload(dataUri, {
          folder: `banque/${telegramId}`,
          resource_type: estVideo ? 'video' : 'image',
          // Les clips sont ramenés en 720p : c'est la largeur servie au rendu.
          transformation: estVideo ? [{ width: 1280, crop: 'limit' }, { quality: 'auto' }] : [{ width: 1600, crop: 'limit' }, { quality: 'auto' }],
        });
        break;
      } catch (e) {
        this.logger.warn(`banque cloudinary (essai ${attempt}): ${e instanceof Error ? e.message : e}`);
        if (attempt === 2) throw e;
      }
    }
    const url = up!.secure_url;
    // Le modèle de vision ne lit pas une vidéo : on lui montre une image du clip.
    const desc = await this.decrire(estVideo ? this.vignette(url) : url, telegramId);
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      url,
      description: desc.description,
      tags: desc.tags,
      type: estVideo ? 'video' : 'image',
    };
    if (estVideo) {
      row.duree_s = Math.round((up!.duration || 0) * 100) / 100 || null;
      row.apercu_url = this.vignette(url);
    }
    try {
      const created = await this.prisma.brand_assets.create({ data: row as never });
      return { ...created, duree_s: created.duree_s == null ? null : Number(created.duree_s) };
    } catch (e) {
      this.logger.error(`banque insert: ${e instanceof Error ? e.message : e}`);
      return { error: 'Enregistrement impossible.' };
    }
  }

  /** Range dans la banque une image DÉJÀ sur Cloudinary (ex. générée par l'IA depuis le
   * Studio Reel). La description est connue : pas d'appel vision. */
  async ajouterUrl(telegramId: string, url: string, description: string, tags?: string[]): Promise<BrandAsset | { error: string }> {
    try {
      if ((await this.lister(telegramId)).length >= MAX_ASSETS) {
        return { error: `Banque pleine (${MAX_ASSETS} visuels maximum). Supprime des visuels d'abord.` };
      }
    } catch (e) {
      this.logger.warn(`banque comptage: ${e instanceof Error ? e.message : e}`);
    }
    const row = {
      telegram_id: telegramId,
      url,
      description: (description || '').slice(0, 300).trim() || 'Image générée par l\'IA',
      tags: (tags && tags.length ? tags : ['ia']).slice(0, 6),
      type: 'image',
    };
    try {
      const created = await this.prisma.brand_assets.create({ data: row });
      return { ...created, duree_s: created.duree_s == null ? null : Number(created.duree_s) };
    } catch {
      return { error: 'Enregistrement impossible.' };
    }
  }

  async modifierDescription(telegramId: string, assetId: string, description: string): Promise<BrandAsset | { error: string }> {
    try {
      const res = await this.prisma.brand_assets.updateMany({
        where: { id: assetId, telegram_id: telegramId },
        data: { description: (description || '').slice(0, 200) },
      });
      if (!res.count) return { error: 'Image introuvable.' };
      const row = await this.prisma.brand_assets.findUnique({ where: { id: assetId } });
      return row ? { ...row, duree_s: row.duree_s == null ? null : Number(row.duree_s) } : { error: 'Image introuvable.' };
    } catch {
      return { error: 'Image introuvable.' };
    }
  }

  /** Supprime la ligne ET l'asset Cloudinary (pas d'accumulation). */
  async supprimer(telegramId: string, assetId: string): Promise<{ ok: true } | { error: string }> {
    const row = await this.prisma.brand_assets.findFirst({ where: { id: assetId, telegram_id: telegramId }, select: { url: true, type: true } });
    if (!row) return { error: 'Visuel introuvable.' };
    try {
      const m = /\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(row.url);
      if (m) {
        // un clip est rangé en resource_type "video" chez Cloudinary
        await cloudinary.uploader.destroy(m[1], { resource_type: row.type === 'video' ? 'video' : 'image', invalidate: true });
      }
    } catch (e) {
      this.logger.warn(`banque destroy cloudinary: ${e instanceof Error ? e.message : e}`);
    }
    await this.prisma.brand_assets.deleteMany({ where: { id: assetId, telegram_id: telegramId } });
    return { ok: true };
  }
}
