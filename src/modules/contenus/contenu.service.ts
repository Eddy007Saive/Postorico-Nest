import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { delabeliserContenu, labelStatutContenu, normStatutContenu } from '../../common/utils/contenu-enum.util';
import { tauxReecriture } from '../../common/utils/similarite.util';
import { PrismaService } from '../../config/prisma.service';
import { CarrouselRenduService } from '../carrousel/carrousel-rendu.service';
import { LateService } from '../late/late.service';
import { MemoireService } from '../memoire/memoire.service';
import { PlanningService } from '../planning/planning.service';
import { ContenuEvenementService } from './contenu-evenement.service';

/**
 * CRUD principal du contenu (`contenu`) — port direct de backend/services/contenu_service.py.
 *
 * Portée volontairement réduite (documentée à chaque endroit concerné) :
 * - Mesure H2 (`taux_reecriture`, `valide_at`, `valide_par`, `note_ressemblance`,
 *   `motif_refus`) et journal `contenu_evenement` : portés le 2026-10-01 après vérification
 *   que les colonnes et la table EXISTENT bien en base — le schéma Prisma introspecté était
 *   simplement en retard (même cas que `marques.typo_*`), pas la base.
 * - Les routes Story (`/story`, `/story-serie`, `/story-anime`, `/story/apercu`,
 *   `/story/options`) dépendent entièrement de `story_service` (non porté, domaine séparé
 *   « Vidéo/Reels ») — stubs documentés dans le contrôleur, pas dans ce service.
 */

type ContenuRow = Record<string, unknown>;

const RESEAUX_RECYCLAGE: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  googlebusiness: 'GoogleBusiness',
};

// Champs copiés lors d'un recyclage (une copie par réseau cible).
const CHAMPS_COPIE = [
  'titre',
  'contenu',
  'type',
  'script',
  'prompt_image',
  'style_image',
  'carrousel_data',
  'video_url',
  'video_status',
  'video_preview_url',
  'lien_visuel',
] as const;

export interface UploadVisuelResult {
  lien_visuel: string;
  statut: unknown;
  date_publication: unknown;
}

export interface RecyclerResult {
  created?: Array<{ id: string; reseau: string; date_publication: string | null }>;
  error?: string;
}

export interface ReplanifierResult {
  ok: boolean;
  date_publication?: string;
  publish_status?: string;
  error?: string;
}

@Injectable()
export class ContenuService {
  private readonly logger = new Logger(ContenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planningService: PlanningService,
    private readonly lateService: LateService,
    private readonly carrouselRendu: CarrouselRenduService,
    private readonly memoireService: MemoireService,
    private readonly contenuEvenement: ContenuEvenementService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Extrait le public_id (avec dossier, sans extension/version) d'une URL Cloudinary. */
  private publicIdFromUrl(url: string | null | undefined): string | null {
    if (!url || !url.includes('cloudinary.com') || !url.includes('/upload/')) return null;
    const after = url.split('/upload/', 2)[1];
    let parts = after.split('/');
    if (parts.length && /^v\d+$/.test(parts[0])) parts = parts.slice(1);
    const path = parts.join('/').replace(/\.[^./]+$/, '');
    return path || null;
  }

  /** public_id (AVEC extension) d'un asset Cloudinary raw, ex. carrousels/<tg>/<base>_doc.pdf */
  private rawPublicId(url: string | null | undefined): string | null {
    const m = /\/upload\/(?:v\d+\/)?(.+)$/.exec(url || '');
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------
  // NB : ces deux méthodes de lecture sont aussi utilisées EN INTERNE (uploadVisuel,
  // updateContenu, replanifierContenu, recyclerContenu, deleteContenu) pour de la logique
  // métier qui compare/réutilise `statut`/`type` sous leur forme Prisma (ex. `type ===
  // 'Carrousel'`, recopie de `type` dans un nouveau `create()`). Elles renvoient donc les
  // valeurs BRUTES (noms d'enum Prisma), jamais retraduites ici — la traduction vers le
  // libellé attendu par le frontend (`delabeliserContenu`) se fait à la frontière HTTP,
  // dans le contrôleur, pas dans ce service.
  async getContenus(telegramId: string, statut?: string) {
    return this.prisma.contenu.findMany({
      where: { telegram_id: telegramId, ...(statut ? { statut: normStatutContenu(statut) as never } : {}) },
      orderBy: { created_at: 'desc' },
    });
  }

  async getContenu(contenuId: string, telegramId: string) {
    return this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
  }

  // ---------------------------------------------------------------------------
  // Visuel importé par l'utilisateur
  // ---------------------------------------------------------------------------
  /** Importe une image fournie par l'utilisateur comme visuel du contenu. Upload Cloudinary
   * (public_id déterministe -> un ré-import ÉCRASE le même asset, pas d'accumulation),
   * confirme la planification, remplace l'ancien asset. */
  async uploadVisuel(telegramId: string, contenuId: string, fileBytes: Buffer, mimetype: string): Promise<UploadVisuelResult | null> {
    const cur = await this.getContenu(contenuId, telegramId);
    if (!cur) return null;
    const old = cur.lien_visuel;
    const publicId = `contenus/${telegramId}/${contenuId}`;
    const up = await cloudinary.uploader.upload(`data:${mimetype};base64,${fileBytes.toString('base64')}`, {
      resource_type: 'image',
      public_id: publicId,
      overwrite: true,
      invalidate: true,
    });
    const url = up.secure_url;

    const upd: Record<string, unknown> = { lien_visuel: url };
    // Pas de statut "Planifie" optimiste : la route appelante pousse vers Zernio et c'est
    // l'event webhook post.scheduled qui confirmera le statut (source de vérité = Zernio).
    if (!cur.date_publication) {
      const creneau = await this.planningService.prochainCreneau(telegramId, cur.reseau_cible as string | null, cur.type as string | null);
      if (creneau) upd.date_publication = creneau;
    }
    await this.prisma.contenu.updateMany({ where: { id: contenuId, telegram_id: telegramId }, data: upd as never });

    // Supprime l'ancien asset SEULEMENT s'il a un public_id différent (sinon on vient de l'écraser).
    if (old) {
      const pid = this.publicIdFromUrl(old as string);
      if (pid && pid !== publicId) {
        try {
          await cloudinary.uploader.destroy(pid, { invalidate: true });
        } catch (e) {
          this.logger.warn(`destroy old visuel: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    return {
      lien_visuel: url,
      statut: upd.statut ?? cur.statut,
      date_publication: upd.date_publication ?? cur.date_publication,
    };
  }

  // ---------------------------------------------------------------------------
  // Mise à jour (validation, auto-planif, programmation Zernio)
  // ---------------------------------------------------------------------------
  async updateContenu(
    contenuId: string,
    telegramId: string,
    updateData: {
      statut?: string;
      titre?: string;
      contenu?: string;
      date_publication?: string;
      note_ressemblance?: number;
      motif_refus?: string;
    },
  ): Promise<ContenuRow | { error: 'not_found' }> {
    const current = await this.getContenu(contenuId, telegramId);
    if (!current) return { error: 'not_found' };

    const data: Record<string, unknown> = { ...updateData, updated_at: new Date() };
    if (updateData.statut) data.statut = normStatutContenu(updateData.statut);

    // Auto-planification : à la validation, (re)pose une date si absente OU déjà passée (on
    // ne planifie jamais une publication dans le passé).
    if (updateData.statut === 'Valider') {
      const effDateRaw = updateData.date_publication || current.date_publication;
      let past = false;
      if (effDateRaw) {
        const d = new Date(effDateRaw as string | Date);
        if (!Number.isNaN(d.getTime())) {
          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          const dd = new Date(d);
          dd.setUTCHours(0, 0, 0, 0);
          past = dd < today;
        }
      }
      if (!effDateRaw || past) {
        const creneau = await this.planningService.prochainCreneau(
          telegramId,
          current.reseau_cible as string | null,
          current.type as string | null,
        );
        if (creneau) {
          data.date_publication = creneau;
          this.logger.log(`Auto-planif contenu ${contenuId} -> ${creneau} (${!effDateRaw ? 'date absente' : 'date passée'})`);
        }
      }
      // Taux de réécriture (H2) : figé à l'instant de la validation, jamais recalculé ensuite —
      // c'est une mesure ponctuelle, pas une valeur vivante. null si pas de base de
      // comparaison (contenu_original absent : créé avant la migration, ou vidéo/reel/story).
      const texteFinal = updateData.contenu !== undefined ? updateData.contenu : (current.contenu as string | null);
      const taux = tauxReecriture(current.contenu_original as string | null, texteFinal);
      if (taux !== null) data.taux_reecriture = taux;

      // Qui a validé, quand (mémoire d'évaluation) — telegramId est déjà le bon acteur même
      // pour un sous-compte (chaque sous-compte a son propre telegram_id).
      data.valide_at = data.updated_at;
      data.valide_par = telegramId;
    }

    let response: ContenuRow;
    try {
      response = await this.prisma.contenu.update({ where: { id: contenuId }, data: data as never });
    } catch (e) {
      this.logger.error(`update_contenu ${contenuId}: ${e instanceof Error ? e.message : e}`);
      response = { ...current, ...data };
    }

    // Journal du cycle de vie (mémoire d'évaluation) : une édition de texte et une
    // validation/un refus dans le même appel comptent comme deux événements distincts.
    // Best-effort (le service n'échoue jamais l'action appelante).
    if (updateData.contenu !== undefined && updateData.contenu !== current.contenu) {
      await this.contenuEvenement.log(contenuId, 'modifie', telegramId, updateData.contenu);
    }
    if (updateData.statut === 'Valider') {
      await this.contenuEvenement.log(contenuId, 'valide', telegramId);
    } else if (updateData.statut === 'Refuse') {
      await this.contenuEvenement.log(contenuId, 'refuse', telegramId, updateData.motif_refus ?? null);
    }

    // Mémoire de voix : un contenu validé entre dans les exemples donnés à Claude ; un texte
    // modifié est réindexé ; un contenu repassé « À valider » en sort. Best-effort : la
    // validation n'attend ni ne dépend d'OpenAI (indexerContenu n'avale jamais d'exception,
    // mais on protège quand même l'appel — port de update_contenu, backend/services/contenu_service.py).
    if ('statut' in updateData || 'contenu' in updateData || 'titre' in updateData) {
      try {
        await this.memoireService.indexerContenu(response as never);
      } catch (e) {
        this.logger.warn(`mémoire de voix ${contenuId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Validation = programmation : un contenu validé avec une date part sur Zernio tout de
    // suite (l'event post.scheduled confirmera le statut Planifie). Best-effort.
    if (updateData.statut === 'Valider' && (response.date_publication || data.date_publication)) {
      try {
        const pub = await this.lateService.programmerContenu(telegramId, contenuId);
        if (pub.ok) response.publish_status = 'envoi';
      } catch (e) {
        this.logger.warn(`programmation après validation ${contenuId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return response;
  }

  // ---------------------------------------------------------------------------
  // Replanification
  // ---------------------------------------------------------------------------
  /** Replanifie le contenu sur le PROCHAIN créneau libre (jours/heure de la planification du
   * réseau + dates déjà occupées), puis le reprogramme sur Zernio. Un clic, zéro saisie. */
  async replanifierContenu(telegramId: string, contenuId: string): Promise<ReplanifierResult> {
    const cur = (await this.getContenu(contenuId, telegramId)) as ContenuRow | null;
    if (!cur) return { ok: false, error: 'not_found' };
    if (cur.publish_status === 'publié') return { ok: false, error: 'already_published' };

    const slot = await this.planningService.prochainCreneau(telegramId, cur.reseau_cible as string | null, cur.type as string | null);
    if (!slot) return { ok: false, error: 'no_slot' };

    // Nettoie l'ancien post Zernio (échoué ou programmé) avant de reprogrammer.
    if (cur.late_post_id) {
      try {
        await this.lateService.cancelPost(cur.late_post_id as string);
      } catch (e) {
        this.logger.warn(`replanifier: annulation ancien post Zernio ${contenuId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    await this.prisma.contenu.updateMany({
      where: { id: contenuId, telegram_id: telegramId },
      data: { date_publication: slot, late_post_id: null, publish_status: null, publish_error: null } as never,
    });
    const pub = await this.lateService.programmerContenu(telegramId, contenuId);
    return {
      ok: true,
      date_publication: slot,
      publish_status: pub.ok ? 'envoi' : 'échec',
      error: pub.ok ? undefined : pub.error,
    };
  }

  // ---------------------------------------------------------------------------
  // Recyclage vers d'autres réseaux
  // ---------------------------------------------------------------------------
  /** Recycle un contenu vers d'autres réseaux : une COPIE par réseau (cartes jumelles),
   * chacune avec son propre créneau de publication et ses propres assets. */
  async recyclerContenu(telegramId: string, contenuId: string, reseaux: string[]): Promise<RecyclerResult> {
    const cur = (await this.getContenu(contenuId, telegramId)) as ContenuRow | null;
    if (!cur) return { error: 'Contenu introuvable.' };
    const srcNet = String(cur.reseau_cible || '').toLowerCase();
    const targets: string[] = [];
    for (const r of reseaux || []) {
      const cap = RESEAUX_RECYCLAGE[String(r).trim().toLowerCase()];
      if (cap && cap.toLowerCase() !== srcNet && !targets.includes(cap)) targets.push(cap);
    }
    if (!targets.length) return { error: 'Aucun réseau cible valide (choisis un réseau différent de celui du post).' };

    const isCarrousel = cur.type === 'Carrousel' || Boolean(cur.slides_images);
    const created: Array<{ id: string; reseau: string; date_publication: string | null }> = [];

    for (const net of targets) {
      const row: Record<string, unknown> = {};
      for (const k of CHAMPS_COPIE) {
        if (cur[k] !== null && cur[k] !== undefined) row[k] = cur[k];
      }
      if (isCarrousel) delete row.lien_visuel; // re-rendu ci-dessous avec les assets de la copie
      row.telegram_id = telegramId;
      row.reseau_cible = net;
      row.statut = normStatutContenu("A valider");
      row.created_at = new Date();

      const creneau = await this.planningService.prochainCreneau(telegramId, net, cur.type as string | null);
      if (creneau) row.date_publication = creneau;

      let newId: string | undefined;
      try {
        const ins = await this.prisma.contenu.create({ data: row as never });
        newId = ins.id;
      } catch (e) {
        this.logger.warn(`recyclage insertion ${net}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!newId) continue;

      // Assets propres à la copie.
      if (isCarrousel && cur.carrousel_data) {
        try {
          const res = await this.carrouselRendu.genererCarrousel(telegramId, cur.carrousel_data as never, newId, 'creme');
          if (res.images?.length) {
            await this.prisma.contenu.update({
              where: { id: newId },
              data: { slides_images: res.images, lien_visuel: res.images[0], carrousel_pdf: res.pdf } as never,
            });
          }
        } catch (e) {
          this.logger.warn(`recyclage carrousel ${newId}: ${e instanceof Error ? e.message : e}`);
        }
      } else if (cur.lien_visuel && !cur.video_url) {
        try {
          const up = await cloudinary.uploader.upload(cur.lien_visuel as string, {
            resource_type: 'image',
            public_id: `contenus/${telegramId}/${newId}`,
            overwrite: true,
            invalidate: true,
          });
          await this.prisma.contenu.update({ where: { id: newId }, data: { lien_visuel: up.secure_url } });
        } catch (e) {
          this.logger.warn(`recyclage visuel ${newId}: ${e instanceof Error ? e.message : e}`);
        }
      }

      created.push({ id: newId, reseau: net, date_publication: (row.date_publication as string) || null });
    }
    return { created };
  }

  // ---------------------------------------------------------------------------
  // Suppression
  // ---------------------------------------------------------------------------
  /** Supprime les assets Cloudinary liés au contenu (best-effort, pas d'accumulation). */
  private async cleanupAssets(c: ContenuRow): Promise<void> {
    const imgs: string[] = [];
    if (c.lien_visuel) imgs.push(c.lien_visuel as string);
    if (Array.isArray(c.slides_images)) imgs.push(...(c.slides_images as string[]));
    for (const u of imgs) {
      // Le poster d'un reel (…/video/upload/….jpg) dérive de l'asset VIDEO : il disparaît
      // avec lui, ce n'est pas une image à détruire.
      if ((u || '').includes('/video/upload/')) continue;
      const pid = this.publicIdFromUrl(u);
      if (pid) {
        try {
          await cloudinary.uploader.destroy(pid, { resource_type: 'image', invalidate: true });
        } catch (e) {
          this.logger.warn(`cleanup image ${pid}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    // Vidéo du contenu (reel rendu par Remotion ou import) hébergée sur Cloudinary.
    const vu = c.video_url as string | undefined;
    if (vu && vu.includes('cloudinary.com') && vu.includes('/video/upload/')) {
      const pid = this.publicIdFromUrl(vu);
      if (pid) {
        try {
          await cloudinary.uploader.destroy(pid, { resource_type: 'video', invalidate: true });
        } catch (e) {
          this.logger.warn(`cleanup video ${pid}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (c.carrousel_pdf) {
      const pid = this.rawPublicId(c.carrousel_pdf as string);
      if (pid) {
        try {
          await cloudinary.uploader.destroy(pid, { resource_type: 'raw', invalidate: true });
        } catch (e) {
          this.logger.warn(`cleanup pdf ${pid}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  /** Suppression complète : retire le post de Late, nettoie Cloudinary, supprime la ligne. */
  async deleteContenu(contenuId: string, telegramId: string): Promise<boolean> {
    const cur = (await this.getContenu(contenuId, telegramId)) as ContenuRow | null;
    if (!cur) return false;
    if (cur.late_post_id) {
      try {
        await this.lateService.cancelPost(cur.late_post_id as string); // Zernio deletePost
      } catch (e) {
        this.logger.warn(`delete: suppression post Late échouée: ${e instanceof Error ? e.message : e}`);
      }
    }
    await this.cleanupAssets(cur);
    const res = await this.prisma.contenu.deleteMany({ where: { id: contenuId, telegram_id: telegramId } });
    return res.count > 0;
  }
}
