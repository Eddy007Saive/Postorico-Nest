import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { PlaywrightBrowserService } from '../playwright/playwright-browser.service';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { construire, nettoyer, valider } from './templates/custom-template.util';
import {
  FIT_JS, HAUTEUR, ID_MODELE, LARGEUR, MAX_MODELES, ModeleInvalide, PagePropre, ROLES_PAGES,
  htmlDepuisPages, nettoyerPage, verifierRoles,
} from './templates/modele-client.util';

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

  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playwrightBrowser: PlaywrightBrowserService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
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

  /** Templates importés par l'admin (les modèles créés par les clients n'y figurent pas). */
  async lister(): Promise<Array<{ id: string; label: string; preview_url: string | null }>> {
    try {
      return await this.prisma.carrousel_templates_custom.findMany({
        where: { owner_id: null },
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

  /** Modèles créés par ce client dans l'éditeur (ils lui sont réservés). */
  async listerDuCompte(telegramId: string): Promise<
    Array<{
      id: string;
      label: string;
      preview_url: string | null;
      html: string;
    }>
  > {
    if (!telegramId) return [];
    try {
      return await this.prisma.carrousel_templates_custom.findMany({
        where: { owner_id: telegramId },
        select: { id: true, label: true, preview_url: true, html: true },
        orderBy: { created_at: 'desc' },
      });
    } catch (e) {
      this.logger.warn(
        `modèles carrousel de ${telegramId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  async idsDuCompte(telegramId: string): Promise<Set<string>> {
    return new Set((await this.listerDuCompte(telegramId)).map((t) => t.id));
  }

  /** « Enregistrer comme modèle » : le gabarit est construit ici, jamais reçu du navigateur. */
  async creerModele(
    owner: string,
    nomBrut: unknown,
    pages: unknown,
    existant?: string,
  ): Promise<{ id: string; label: string; preview_url: string | null }> {
    const nom = (typeof nomBrut === 'string' ? nomBrut : '')
      .trim()
      .slice(0, 60);
    if (!nom) throw new ModeleInvalide('Donne un nom à ton modèle.');
    if (!Array.isArray(pages) || pages.length !== 3) {
      throw new ModeleInvalide(
        'Un modèle se compose de trois slides : couverture, étape et finale.',
      );
    }
    if (!existant && (await this.listerDuCompte(owner)).length >= MAX_MODELES) {
      throw new ModeleInvalide(
        `Tu as atteint la limite de ${MAX_MODELES} modèles. Supprimes-en un pour en créer un autre.`,
      );
    }
    verifierRoles(pages);
    const tid = existant || `perso-${randomBytes(5).toString('hex')}`;
    const heberger = async (brut: Buffer, nomImg: string) => {
      const up = await cloudinary.uploader.upload(
        `data:image/png;base64,${brut.toString('base64')}`,
        {
          folder: `carrousels/modeles/${owner}`,
          public_id: `${tid}_${nomImg}`,
          overwrite: true,
          resource_type: 'image',
        },
      );
      return up.secure_url;
    };
    const propres: PagePropre[] = [];
    for (let i = 0; i < 3; i += 1)
      propres.push(
        await nettoyerPage(
          pages[i],
          ROLES_PAGES[i],
          this.frontendUrl,
          heberger,
        ),
      );
    const html = htmlDepuisPages(propres, this.frontendUrl);
    const erreurs = valider(html);
    if (erreurs.length) throw new ModeleInvalide(erreurs.join(' '));
    let apercu: string | null = null;
    try {
      apercu = await this.apercuCustom(tid, html);
    } catch (e) {
      this.logger.warn(
        `vignette modèle ${tid}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const donnees = {
      label: nom,
      html: nettoyer(html),
      design: { v: 1, w: LARGEUR, h: HAUTEUR, pages: propres } as unknown as Prisma.InputJsonValue,
      ...(apercu ? { preview_url: apercu } : {}),
    };
    await this.prisma.carrousel_templates_custom.upsert({
      where: { id: tid },
      update: donnees,
      create: { id: tid, created_by: owner, owner_id: owner, ...donnees },
    });
    return { id: tid, label: nom, preview_url: apercu };
  }

  /** Un modèle du client, avec son design (pour le rouvrir dans l'éditeur). */
  async chargerModele(owner: string, tid: string) {
    if (!ID_MODELE.test(tid || '')) return null;
    return this.prisma.carrousel_templates_custom.findFirst({
      where: { id: tid, owner_id: owner },
      select: { id: true, label: true, preview_url: true, design: true },
    });
  }

  /** Met à jour un modèle existant (design, rôles, nom) : gabarit et vignette refaits. */
  async modifierModele(owner: string, tid: string, nom: unknown, pages: unknown) {
    if (!(await this.chargerModele(owner, tid))) return null;
    return this.creerModele(owner, nom, pages, tid);
  }

  async supprimerModele(owner: string, tid: string): Promise<boolean> {
    if (!ID_MODELE.test(tid || '')) return false;
    const r = await this.prisma.carrousel_templates_custom.deleteMany({
      where: { id: tid, owner_id: owner },
    });
    if (!r.count) return false;
    try {
      await cloudinary.api.delete_resources_by_prefix(
        `carrousels/modeles/${owner}/${tid}_`,
      );
      await cloudinary.uploader.destroy(`carrousels/_templates/${tid}`, {
        resource_type: 'image',
      });
    } catch (e) {
      this.logger.warn(
        `nettoyage Cloudinary du modèle ${tid}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return true;
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
      await page.evaluate(FIT_JS).catch(() => undefined);
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
