import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';
import { construire, nettoyer, valider } from './templates/custom-template.util';

/**
 * Templates de carrousel importés depuis le back-office — port de
 * backend/services/carrousel_custom.py : lecture (`lister`/`charger`/`ids`, utilisés par
 * le moteur de rendu) + CRUD admin (`enregistrer`/`supprimer`/`apercuCustom`).
 */

// Marqueurs reconnus (documentés à l'identique dans l'écran d'import).
export const PLACEHOLDERS = {
  commun: ['{{nom}}', '{{secteur}}', '{{logo}}', '{{index}}', '{{total}}'],
  couverture: ['{{hook}}'],
  etape: ['{{numero}}', '{{titre}}', '{{texte}}', '{{pills}}', '{{pro_tip}}'],
  final: ['{{cta_titre}}', '{{cta_texte}}'],
};

const SLIDE_W = 360;
const SLIDE_H = 450;

@Injectable()
export class CarrouselCustomService {
  private readonly logger = new Logger(CarrouselCustomService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playwrightBrowser: PlaywrightBrowserService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Renvoie la liste des problèmes bloquants (vide = template utilisable). */
  valider(html: string): string[] {
    return valider(html);
  }

  async lister(): Promise<Array<{ id: string; label: string; preview_url: string | null }>> {
    try {
      return await this.prisma.carrousel_templates_custom.findMany({
        select: { id: true, label: true, preview_url: true },
        orderBy: { created_at: 'desc' },
      });
    } catch (e) {
      this.logger.warn(`carrousels custom: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  async charger(tplId: string): Promise<{ id: string; label: string; html: string } | null> {
    try {
      return await this.prisma.carrousel_templates_custom.findUnique({ where: { id: tplId } });
    } catch (e) {
      this.logger.warn(`carrousel custom ${tplId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async ids(): Promise<Set<string>> {
    return new Set((await this.lister()).map((t) => t.id));
  }

  async enregistrer(
    tplId: string,
    label: string,
    html: string,
    previewUrl: string | null | undefined,
    adminId: string | null | undefined,
  ): Promise<{ id: string; label: string; html: string; preview_url?: string; created_by: string | null }> {
    const row = { id: tplId, label, html: nettoyer(html), created_by: adminId ?? null, ...(previewUrl ? { preview_url: previewUrl } : {}) };
    await this.prisma.carrousel_templates_custom.upsert({
      where: { id: tplId },
      update: row,
      create: row,
    });
    return row;
  }

  async supprimer(tplId: string): Promise<void> {
    await this.prisma.carrousel_templates_custom.deleteMany({ where: { id: tplId } });
  }

  /** Vignette d'un template importé : rend la couverture avec un contenu de démonstration
   * et l'envoie sur Cloudinary. Faite UNE fois à l'import — le sélecteur reste instantané. */
  async apercuCustom(tplId: string, htmlGabarit: string): Promise<string | null> {
    const demo = {
      hook: 'Le sujet de ton carrousel',
      slides: [{ titre: 'Idée forte 01', texte: 'Une phrase qui appuie ton idée.', pills: ['Mot-clé'], pro_tip: 'Un conseil actionnable.' }],
      cta: { titre: 'Passe à l\'action', texte: 'Ton appel à l\'action final.' },
    };
    const html = construire(htmlGabarit, demo, '#5B6CFF', '#8A6CFF', '#3AFFA3', 'Ta marque', 'Ton secteur', null);

    const browser = await this.playwrightBrowser.launch();
    let png: Buffer;
    try {
      const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H }, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const el = (await page.$('.slide')) || (await page.$('body'));
      png = (await el!.screenshot({ type: 'png' })) as Buffer;
    } finally {
      await browser.close();
    }

    const up = await cloudinary.uploader.upload(`data:image/png;base64,${png.toString('base64')}`, {
      folder: 'carrousels/_templates',
      public_id: tplId,
      overwrite: true,
      resource_type: 'image',
      format: 'png',
    });
    const url = up.secure_url || '';
    // Vignette de galerie : la servir en pleine définition ferait ramer le sélecteur.
    return url ? url.replace('/upload/', '/upload/w_400,q_auto,f_auto/') : url;
  }
}
