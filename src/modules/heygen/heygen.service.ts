import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';

/**
 * Avatar IA HeyGen (côté client) — port direct de backend/services/heygen_service.py
 * (fonctions utilisateur ; les fonctions admin équivalentes vivent déjà dans
 * admin.service.ts::getAllAvatars/updateAvatarByAdmin, non dupliquées ici).
 */
export interface HeygenAvatar {
  telegram_id: string;
  avatar_id: string | null;
  avatar_name: string | null;
  status: string;
  preview_image_url: string | null;
  preview_video_url: string | null;
  error_message: string | null;
  training_video_url: string | null;
  consent_url: string | null;
  description: string | null;
  created_at: Date | null;
}

@Injectable()
export class HeygenService {
  private readonly logger = new Logger(HeygenService.name);
  private readonly apiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('app.heygenApiKey') || '';
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  async uploadToCloudinary(fileBytes: Buffer, filename: string, folder = 'heygen_avatars'): Promise<string> {
    const up = await cloudinary.uploader.upload(`data:video/mp4;base64,${fileBytes.toString('base64')}`, {
      resource_type: 'video',
      folder,
      public_id: filename,
      overwrite: true,
    });
    return up.secure_url;
  }

  private async fetchPreviewImages(avatarId: string): Promise<string[]> {
    const resp = await fetch(`https://api.heygen.com/v2/avatar_group/${avatarId}/avatars`, {
      headers: { accept: 'application/json', 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HeyGen ${resp.status}`);
    const data = (await resp.json()) as { data?: { avatars?: Array<{ preview_image_url?: string; thumbnail_url?: string }> } };
    const avatarsList = data.data?.avatars || [];
    const imageUrls: string[] = [];
    for (const av of avatarsList) {
      if (av.preview_image_url) imageUrls.push(av.preview_image_url);
      if (av.thumbnail_url) imageUrls.push(av.thumbnail_url);
    }
    return [...new Set(imageUrls)];
  }

  /** Si avatar_id existe mais preview_image_url est vide : va les chercher chez HeyGen et
   * les enregistre. */
  async autoFillPreview(telegramId: string, avatar: HeygenAvatar): Promise<HeygenAvatar> {
    if (!avatar.avatar_id || avatar.preview_image_url) return avatar;
    try {
      const imageUrls = await this.fetchPreviewImages(avatar.avatar_id);
      if (imageUrls.length) {
        const previewStr = imageUrls.join(',');
        await this.prisma.heygen_avatars.update({ where: { telegram_id: telegramId }, data: { preview_image_url: previewStr } });
        avatar.preview_image_url = previewStr;
        this.logger.log(`Auto-filled preview images for user ${telegramId}`);
      }
    } catch (e) {
      this.logger.warn(`Auto-fetch preview failed for ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    return avatar;
  }

  async saveAvatarRequest(telegramId: string, avatarName: string, description: string, trainingVideoUrl: string): Promise<HeygenAvatar> {
    return (await this.prisma.heygen_avatars.create({
      data: { telegram_id: telegramId, avatar_name: avatarName, description, status: 'pending', training_video_url: trainingVideoUrl },
    })) as HeygenAvatar;
  }

  async getAvatarFromDb(telegramId: string): Promise<HeygenAvatar | null> {
    return (await this.prisma.heygen_avatars.findUnique({ where: { telegram_id: telegramId } })) as HeygenAvatar | null;
  }

  async deleteAvatar(telegramId: string): Promise<void> {
    await this.prisma.heygen_avatars.deleteMany({ where: { telegram_id: telegramId } });
  }
}
