import * as fs from 'fs';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { QuotaService } from '../quota/quota.service';
import { RemotionService } from '../remotion/remotion.service';
import { VoixService } from '../voix/voix.service';

/**
 * File de rendu Remotion en arrière-plan (stories animées, reels) — port direct de
 * backend/services/render_service.py. Un rendu Remotion prend 50-90 s et sature les cœurs
 * du conteneur : impossible de rendre dans une requête HTTP (timeout, onglet fermé =
 * résultat perdu). Ici la ligne `contenu` EST le job (même choix que le montage Submagic
 * avec `video_status`) :
 *
 *   video_status      = "en_traitement" tant que le rendu n'est pas fait
 *   render_job        = {composition, props, prefix, etiquette, upload: {public_id, folder?},
 *                        action_type: "story"|"reel" (quota à rembourser si échec final),
 *                        notif: "story"|"reel", restaurer?, tentatives, erreur}
 *   render_started_at = posé au claim par le worker ; NULL = libre. Un claim périmé
 *                       (> STALE_MIN) est repris : un redémarrage ne perd pas le job, juste
 *                       le MP4 temporaire.
 *
 * Le worker (démarré via OnApplicationBootstrap) appelle `traiterSuivant()` en boucle ; un
 * seul rendu à la fois. Le sémaphore de RemotionService reste en garde-fou.
 */

const MAX_TENTATIVES = 2;
const STALE_MIN = 15;

export interface RenderUpload {
  public_id?: string;
  folder?: string;
  couverture_s?: number;
}

export interface RenderJob {
  composition: string;
  props: Record<string, unknown>;
  prefix: string;
  etiquette: string;
  upload: RenderUpload;
  action_type: string;
  notif: string;
  tentatives: number;
  erreur?: string;
  restaurer?: { video_url?: string | null; video_preview_url?: string | null; reel_data?: unknown };
  voix?: string;
  voix_faite?: boolean;
  voix_echec?: string;
}

interface ContenuRow {
  id: string;
  telegram_id: string;
  reseau_cible: string | null;
  serie_id: string | null;
  render_job: unknown;
  titre: string | null;
}

@Injectable()
export class RenderQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RenderQueueService.name);
  private compositionsConnuesCache: string[] | null = null;
  private readonly workerActif: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly remotionService: RemotionService,
    private readonly voixService: VoixService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
    config: ConfigService,
  ) {
    this.workerActif = config.get<boolean>('app.renderWorkerActive') ?? true;
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Démarre le worker au boot de l'application (30 s de délai, puis tick 10 s quand la
   * file est vide, enchaîne tant qu'il reste des jobs) — port direct de server._render_worker. */
  onApplicationBootstrap(): void {
    if (!this.workerActif) {
      this.logger.log('Worker de rendu Remotion désactivé (RENDER_WORKER_ACTIVE=0)');
      return;
    }
    setTimeout(() => void this.boucle(), 30_000);
  }

  private async boucle(): Promise<void> {
    for (;;) {
      try {
        // eslint-disable-next-line no-empty
        while (await this.traiterSuivant()) {}
      } catch (e) {
        this.logger.error(`render worker loop: ${e instanceof Error ? e.message : e}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // -------------------------------------------------------------- Mise en file

  /** Accroche un job de rendu à une ligne contenu existante et la passe en en_traitement.
   * `extra` = colonnes à poser en même temps (ex. reel_data, video_url=null pour une
   * régénération). Retour immédiat, le worker fait le reste. */
  async enqueue(
    rowId: string,
    _telegramId: string,
    opts: {
      composition: string;
      props: Record<string, unknown>;
      prefix: string;
      etiquette: string;
      upload: RenderUpload;
      actionType: string;
      notif: string;
      restaurer?: RenderJob['restaurer'];
      extra?: Record<string, unknown>;
      voix?: string | null;
    },
  ): Promise<void> {
    const job: RenderJob = {
      composition: opts.composition,
      props: opts.props,
      prefix: opts.prefix,
      etiquette: opts.etiquette,
      upload: opts.upload,
      action_type: opts.actionType,
      notif: opts.notif,
      tentatives: 0,
    };
    if (opts.restaurer) job.restaurer = opts.restaurer;
    if (opts.voix) job.voix = opts.voix; // voix off : synthétisée par le worker juste avant le rendu
    const maj: Record<string, unknown> = { render_job: job, video_status: 'en_traitement', render_started_at: null, ...(opts.extra || {}) };
    await this.prisma.contenu.update({ where: { id: rowId }, data: maj as never });
  }

  // -------------------------------------------------------------- Worker

  /** Envoie le MP4 sur Cloudinary (video) et supprime le fichier local. Renvoie
   * {video_url, video_preview_url} — le poster est la 1re frame via transformation
   * Cloudinary (URL en .jpg), comme partout ailleurs. */
  private async uploadVideo(mp4: string, upload: RenderUpload): Promise<{ video_url: string; video_preview_url: string }> {
    try {
      const up = await cloudinary.uploader.upload(mp4, {
        resource_type: 'video',
        public_id: upload.public_id,
        folder: upload.folder,
        overwrite: true,
        invalidate: true,
      });
      const url = up.secure_url;
      const t = upload.couverture_s;
      if (t !== undefined && t !== null && url.includes('/upload/')) {
        const preview = url.replace('/upload/', `/upload/so_${t.toFixed(2)}/`).replace(/\.[^./]+$/, '') + '.jpg';
        return { video_url: url, video_preview_url: preview };
      }
      return { video_url: url, video_preview_url: url.replace(/\.[^./]+$/, '') + '.jpg' };
    } finally {
      fs.unlink(mp4, () => undefined);
    }
  }

  private async rearmerPerimes(): Promise<void> {
    const limite = new Date(Date.now() - STALE_MIN * 60_000);
    try {
      const res = await this.prisma.contenu.updateMany({
        where: { video_status: 'en_traitement', render_started_at: { lt: limite } },
        data: { render_started_at: null },
      });
      if (res.count) this.logger.warn(`render worker: ${res.count} job(s) périmé(s) réarmé(s)`);
    } catch (e) {
      this.logger.warn(`render worker rearmer: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Mémorisée dès qu'elle est non vide ; une liste vide (service de rendu injoignable au
   * démarrage, par exemple) est redemandée au tick suivant plutôt que figée. */
  private async compositionsConnues(): Promise<string[]> {
    if (this.compositionsConnuesCache === null || !this.compositionsConnuesCache.length) {
      this.compositionsConnuesCache = await this.remotionService.compositionsConnues();
    }
    return this.compositionsConnuesCache;
  }

  /** Prend le plus ancien job libre (parmi les compositions que cette instance sait
   * rendre). L'update conditionnel (render_started_at IS NULL) garantit qu'un seul worker
   * l'obtient, même avec plusieurs instances. */
  private async claim(): Promise<ContenuRow | null> {
    const connues = await this.compositionsConnues();
    // Fermé par défaut : une instance qui ne connaît AUCUNE composition (projet Remotion
    // absent, ex. image Docker sans backend/remotion) ne réclame rien. Avant le 2026-10-01
    // la liste vide court-circuitait le filtre : l'instance réclamait tout, échouait aussitôt
    // (« Remotion non installé ») et, la file étant partagée avec le backend Python,
    // envoyait en « échec » des reels que l'autre worker aurait rendus.
    if (!connues.length) return null;
    const candidats = await this.prisma.contenu.findMany({
      where: { video_status: 'en_traitement', render_started_at: null },
      select: { id: true, telegram_id: true, reseau_cible: true, serie_id: true, render_job: true, titre: true },
      orderBy: { created_at: 'asc' },
      take: 20,
    });
    for (const row of candidats) {
      if (!row.render_job) continue;
      const composition = (row.render_job as { composition?: string } | null)?.composition;
      if (!composition || !connues.includes(composition)) continue;
      const res = await this.prisma.contenu.updateMany({
        where: { id: row.id, render_started_at: null },
        data: { render_started_at: new Date() },
      });
      if (res.count) return row as unknown as ContenuRow;
    }
    return null;
  }

  private async existe(rowId: string): Promise<boolean> {
    try {
      return Boolean(await this.prisma.contenu.findUnique({ where: { id: rowId }, select: { id: true } }));
    } catch {
      return true; // doute -> on tente l'upload plutôt que de perdre le rendu
    }
  }

  /** Vrai quand plus aucun écran de la même série (ou la ligne seule) n'attend. */
  private async serieTerminee(row: ContenuRow): Promise<boolean> {
    if (!row.serie_id) return true;
    const r = await this.prisma.contenu.findFirst({ where: { serie_id: row.serie_id, video_status: 'en_traitement' }, select: { id: true } });
    return !r;
  }

  private async notifierFin(row: ContenuRow & { _echec?: boolean }, job: RenderJob): Promise<void> {
    const { telegram_id: tid, id: cid, reseau_cible: reseau } = row;
    const echec = Boolean(row._echec);
    if ((job.notif || 'story') === 'reel') {
      if (echec) {
        const suite = job.restaurer ? ' La version précédente est conservée.' : ' Supprime le reel et réessaie.';
        await this.notificationService.notifier(tid, cid, reseau, 'reel.echec', 'Reel : rendu échoué ❌', "Le rendu n'a pas abouti." + suite);
      } else if (job.voix_echec) {
        await this.notificationService.notifier(
          tid, cid, reseau, 'reel.ready_sans_voix', 'Ton reel est prêt, mais sans voix ⚠️',
          'La voix off a échoué au rendu (quota remboursé). Régénère le reel pour retenter la voix.',
        );
      } else {
        await this.notificationService.notifier(tid, cid, reseau, 'reel.ready', 'Ton reel est prêt 🎬', 'À valider dans Contenus.');
      }
      return;
    }
    // Stories (série ou unique)
    if (row.serie_id) {
      const rows = await this.prisma.contenu.findMany({ where: { serie_id: row.serie_id }, select: { video_status: true } });
      const statuts = rows.map((x) => x.video_status);
      const echecs = statuts.filter((s) => s === 'echec').length;
      if (echecs === statuts.length) {
        await this.notificationService.notifier(tid, cid, reseau, 'story.anime.echec', 'Série animée : rendu échoué ❌', "Aucun écran n'a pu être rendu. Supprime la série et réessaie.");
      } else if (echecs) {
        await this.notificationService.notifier(
          tid, cid, reseau, 'story.anime.ready', 'Série animée prête (partiellement) ⚠️',
          `${statuts.length - echecs}/${statuts.length} écrans rendus, ${echecs} en échec. À valider dans Contenus.`,
        );
      } else {
        await this.notificationService.notifier(tid, cid, reseau, 'story.anime.ready', 'Ta série animée est prête 🎬', `${statuts.length} écrans rendus, à valider dans Contenus.`);
      }
      return;
    }
    if (echec) {
      await this.notificationService.notifier(tid, cid, reseau, 'story.anime.echec', 'Story animée : rendu échoué ❌', "Le rendu n'a pas abouti. Supprime la story et réessaie.");
    } else {
      await this.notificationService.notifier(tid, cid, reseau, 'story.anime.ready', 'Ta story animée est prête 🎬', 'À valider dans Contenus.');
    }
  }

  /** Rend UN job. Retourne true s'il en a traité un (le worker enchaîne), false si la
   * file est vide. Ne lève jamais : les erreurs finissent sur la ligne. */
  async traiterSuivant(): Promise<boolean> {
    await this.rearmerPerimes();
    const row = await this.claim();
    if (!row) return false;
    const job = (row.render_job || {}) as RenderJob;
    const composition = job.composition || 'StoryAnime';
    let tentatives = Number(job.tentatives || 0);
    const rid = row.id;
    const tid = row.telegram_id;
    const upload: RenderUpload = job.upload || { folder: `stories/${tid}`, public_id: `${(rid || 'tmp').replace(/-/g, '').slice(0, 16)}_anime` };
    let props = job.props || {};
    let jobCourant = job;

    if (job.voix && !job.voix_faite && !job.voix_echec) {
      // Voix off : une phrase par plan, MP3 sur Cloudinary, durées posées dans les props.
      // Persisté dans le job : une nouvelle tentative ne re-paie pas la synthèse.
      try {
        props = await this.voixService.appliquer(tid, props as { segments?: never }, job.voix);
        jobCourant = { ...job, props, voix_faite: true };
        await this.prisma.contenu.update({ where: { id: rid }, data: { render_job: jobCourant as never } });
      } catch (e) {
        // La voix ne doit jamais faire échouer le reel : on rend sans, on rembourse la voix.
        this.logger.warn(`render worker: voix off impossible pour ${rid}, rendu muet : ${e instanceof Error ? e.message : e}`);
        jobCourant = { ...job, voix_echec: String(e instanceof Error ? e.message : e).slice(0, 200) };
        try {
          await this.quotaService.refundByUser(tid, 'voix');
        } catch (e2) {
          this.logger.warn(`render worker refund voix ${rid}: ${e2 instanceof Error ? e2.message : e2}`);
        }
      }
    }

    let echec = false;
    try {
      const mp4 = await this.remotionService.renderMp4(props, composition, {
        telegramId: tid,
        etiquette: jobCourant.etiquette || composition,
        prefix: jobCourant.prefix || 'remotion',
      });
      if (!(await this.existe(rid))) {
        // Supprimé pendant le rendu : rien à uploader, pas de ligne fantôme.
        fs.unlink(mp4, () => undefined);
        this.logger.log(`render worker: ${rid} supprimé pendant le rendu, upload ignoré`);
        return true;
      }
      const res = await this.uploadVideo(mp4, upload);
      await this.prisma.contenu.update({
        where: { id: rid },
        data: {
          video_url: res.video_url,
          video_preview_url: res.video_preview_url,
          lien_visuel: res.video_preview_url,
          video_status: 'ready',
          render_job: null as never,
          render_started_at: null,
        },
      });
      this.logger.log(`render worker: ${composition} ${rid} rendu`);
    } catch (e) {
      tentatives += 1;
      const err = String(e instanceof Error ? e.message : e).slice(0, 400);
      if (tentatives < MAX_TENTATIVES) {
        this.logger.warn(`render worker: ${rid} échec ${tentatives}/${MAX_TENTATIVES}, retentera : ${err}`);
        await this.prisma.contenu.update({
          where: { id: rid },
          data: { render_job: { ...jobCourant, tentatives, erreur: err } as never, render_started_at: null },
        });
        return true;
      }
      this.logger.error(`render worker: ${rid} abandonné après ${tentatives} tentatives : ${err}`);
      const maj: Record<string, unknown> = { render_job: { ...jobCourant, tentatives, erreur: err }, render_started_at: null };
      const restaurer = jobCourant.restaurer;
      if (restaurer) {
        // Régénération : la précédente vidéo n'a pas été touchée (l'upload overwrite n'a
        // lieu qu'en cas de succès) -> on la remet en place.
        maj.video_url = restaurer.video_url ?? null;
        maj.video_preview_url = restaurer.video_preview_url ?? null;
        maj.lien_visuel = restaurer.video_preview_url ?? null;
        maj.reel_data = restaurer.reel_data ?? null;
        maj.video_status = 'ready';
      } else {
        maj.video_status = 'echec';
      }
      await this.prisma.contenu.update({ where: { id: rid }, data: maj as never });
      // Le rendu ne sera jamais publié : on rend son unité de quota.
      try {
        await this.quotaService.refundByUser(tid, jobCourant.action_type || 'story');
        if (jobCourant.voix && !jobCourant.voix_echec) await this.quotaService.refundByUser(tid, 'voix');
      } catch (e2) {
        this.logger.warn(`render worker refund ${rid}: ${e2 instanceof Error ? e2.message : e2}`);
      }
      echec = true;
    }
    try {
      const rowAvecEchec = { ...row, _echec: echec };
      if (await this.serieTerminee(row)) await this.notifierFin(rowAvecEchec, jobCourant);
    } catch (e) {
      this.logger.warn(`render worker notification ${rid}: ${e instanceof Error ? e.message : e}`);
    }
    return true;
  }
}
