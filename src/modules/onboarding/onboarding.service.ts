import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../config/prisma.service';

/**
 * Audit de marque / onboarding public (lead anonyme) — port direct de
 * backend/services/onboarding_service.py. Stocke les réponses du questionnaire public
 * dans `brand_audits`. Aucune authentification : formulaire de capture de lead.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Upload public (logo / image d'inspiration) sur Cloudinary. Anonyme : pas de telegram_id,
   * rangé sous onboarding_audits/<kind>/<uuid>. */
  async uploadAsset(fileBytes: Buffer, kind: string, mimetype: string): Promise<string> {
    const safeKind = kind === 'logo' || kind === 'image' ? kind : 'image';
    const publicId = `onboarding_audits/${safeKind}/${randomUUID().replace(/-/g, '')}`;
    const dataUri = `data:${mimetype};base64,${fileBytes.toString('base64')}`;
    const up = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'image',
      public_id: publicId,
      overwrite: true,
    });
    return up.secure_url;
  }

  async saveAudit(
    marque: string,
    email: string,
    answers: Record<string, unknown>,
    recap: string,
    userAgent = '',
  ): Promise<{ success: true; id: string }> {
    const row = {
      marque: (marque || '').trim().slice(0, 200) || null,
      email: (email || '').trim().slice(0, 200) || null,
      answers: (answers || {}) as Prisma.InputJsonValue,
      recap: (recap || '').slice(0, 60000) || null,
      user_agent: (userAgent || '').slice(0, 400) || null,
      status: 'nouveau',
    };
    const created = await this.prisma.brand_audits.create({ data: row });
    this.logger.log(`Nouvel audit de marque enregistré: ${row.marque} (${row.email}) -> ${created.id}`);
    return { success: true, id: created.id };
  }

  async listAudits(limit = 100) {
    return this.prisma.brand_audits.findMany({
      select: { id: true, marque: true, email: true, status: true, created_at: true },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async getAudit(auditId: string) {
    return this.prisma.brand_audits.findUnique({ where: { id: auditId } });
  }

  async updateStatus(auditId: string, status: string): Promise<void> {
    await this.prisma.brand_audits.update({ where: { id: auditId }, data: { status } });
  }
}