import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { MarqueService } from '../marque/marque.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';
import {
  Brand,
  buildHtml,
  DSF,
  GAB_H,
  GAB_LABELS,
  GAB_W,
  GABARITS,
  PHOTO_GABARITS,
  Slots,
} from './templates/gabarit-builders';

/**
 * Gabarits de post (feed cohérent) : HTML brandé FIXE → PNG via Playwright → Cloudinary.
 * Port direct de la partie rendu de backend/services/gabarit_service.py (`render_gabarit`,
 * `previews`, `_brand_of`). La régénération des vignettes statiques
 * (`_render_previews`/`scripts/render_static_previews`) est un outil admin ponctuel, hors
 * périmètre de ce portage — `previews()` sert les vignettes déjà rendues côté Python.
 */
export interface RenderGabaritResult {
  ok: boolean;
  url?: string;
  error?: string;
}

@Injectable()
export class GabaritService {
  private readonly logger = new Logger(GabaritService.name);
  private readonly staticPreviews: Record<string, string>;

  constructor(
    private readonly marqueService: MarqueService,
    private readonly playwrightBrowser: PlaywrightBrowserService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
    const cloudName = config.get<string>('app.cloudinaryCloudName');
    const base = `https://res.cloudinary.com/${cloudName}/image/upload/gabarits/_static`;
    this.staticPreviews = Object.fromEntries(GABARITS.map((g) => [g, `${base}/${g}.png`]));
  }

  async brandOf(telegramId: string): Promise<Brand> {
    const u = await this.marqueService.chargerMarque(telegramId);
    return {
      accent: (u.couleur_accent as string) || '#7c5cff',
      accent2: (u.couleur_secondaire as string) || '#ff2d2d',
      bg: '#07070e',
      logo: (u.logo_url as string) || null,
      nom: (u.nom as string) || (u.user_name as string) || '',
    };
  }

  private async renderOne(telegramId: string, gabarit: string, slots: Slots, brand: Brand): Promise<string> {
    const htmlStr = buildHtml(gabarit, slots, brand);
    const browser = await this.playwrightBrowser.launch();
    let png: Buffer;
    try {
      const page = await browser.newPage({ viewport: { width: GAB_W, height: GAB_H }, deviceScaleFactor: DSF });
      await page.setContent(htmlStr, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      png = await page.locator('.frame').screenshot({ type: 'png' });
    } finally {
      await browser.close();
    }
    const up = await cloudinary.uploader.upload(`data:image/png;base64,${png.toString('base64')}`, {
      resource_type: 'image',
      folder: `gabarits/${telegramId}`,
      public_id: (slots.public_id as string) || `post_${gabarit}`,
      overwrite: true,
      invalidate: true,
    });
    return up.secure_url;
  }

  async renderGabarit(telegramId: string, gabarit: string, slots: Slots): Promise<RenderGabaritResult> {
    if (!GABARITS.includes(gabarit)) return { ok: false, error: 'Gabarit inconnu.' };
    const brand = await this.brandOf(telegramId);
    try {
      const url = await this.renderOne(telegramId, gabarit, slots || {}, brand);
      return { ok: true, url };
    } catch (e) {
      this.logger.error(`render_gabarit error ${telegramId}/${gabarit}: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Échec du rendu du visuel.' };
    }
  }

  /** URL Cloudinary redimensionnée + optimisée (q_auto + format auto) pour des vignettes légères. */
  private thumb(url: string, size = 240): string {
    return url.includes('/upload/') ? url.replace('/upload/', `/upload/c_fill,w_${size},h_${size},q_auto,f_auto/`) : url;
  }

  /** Vignettes d'aperçu STATIQUES (instantanées). Elles montrent la mise en page ; le
   * visuel final utilise les vraies couleurs de la marque. */
  previews(): { previews: Record<string, string>; labels: Record<string, string>; photo: string[] } {
    const previews = Object.fromEntries(Object.entries(this.staticPreviews).map(([k, v]) => [k, this.thumb(v)]));
    return { previews, labels: GAB_LABELS, photo: PHOTO_GABARITS };
  }
}
