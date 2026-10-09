import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { envoyerGrosFichier } from '../../common/utils/cloudinary-envoi.util';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { QuotaService } from '../quota/quota.service';
import { ContenuEvenementService } from '../contenus/contenu-evenement.service';
import { DONE, FAILED, MontagePocService } from './montage-poc.service';
import { TranscodageService } from '../transcodage/transcodage.service';

/**
 * Studio Vidéo / Reels — montage via Studio Montage (submagic-poc, self-hosted) — port
 * direct de backend/routes/video.py. Flux : upload vidéo brute (Cloudinary) → démarrage
 * d'un job Studio Montage (sous-titres + b-roll + zooms + musique optionnelle) → rendu
 * async (polling, pas de webhook côté submagic-poc) → le MP4 est déjà sur Cloudinary
 * (studio-montage/{job_id}/video) une fois `done`, on l'attache directement au contenu.
 */

export const RESEAU_MAP: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  googlebusiness: 'GoogleBusiness',
};

/** Réseaux cibles capitalisés + dédupliqués. Accepte `reseaux` (liste) ou `reseau` (str). */
export function targets(body: { reseaux?: unknown; reseau?: unknown }): string[] {
  let raw: unknown[] = Array.isArray(body.reseaux) ? body.reseaux : body.reseau ? [body.reseau] : [];
  const out: string[] = [];
  for (const r of raw) {
    const cap = RESEAU_MAP[String(r).toLowerCase()];
    if (cap && !out.includes(cap)) out.push(cap);
  }
  return out;
}

/** Miniature d'une vidéo Cloudinary : une frame à ~1,5s (évite une 1ʳᵉ frame noire) + q_auto. */
export function poster(videoUrl: string | null | undefined): string | null {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  const stem = videoUrl.replace(/\.[^./]+$/, '');
  return stem.replace('/upload/', '/upload/so_1.5,q_auto/') + '.jpg';
}

export interface FinalizeResult {
  video_status: string;
  video_url?: string | null;
  video_preview_url?: string | null;
  stage?: string;
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly montagePoc: MontagePocService,
    private readonly quotaService: QuotaService,
    private readonly contenuEvenement: ContenuEvenementService,
    config: ConfigService,
    private readonly transcodage: TranscodageService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Upload la vidéo brute de l'utilisateur → Cloudinary (video) → {video_url, ...}. */
  async uploadRaw(telegramId: string, data: Buffer): Promise<{ video_url: string; public_id?: string; duration?: number; width?: number; height?: number }> {
    // upload_large lit un CHEMIN DE FICHIER (envoi par tranches) : on écrit le buffer sur
    // disque le temps de l'upload plutôt que de lui passer une data URI (qu'il ne sait pas lire).
    // Passage par ffmpeg avant Cloudinary : H.264 1080p max (ce sont des vidéos publiées, on
    // garde la définition), envoi bien plus léger. Échec de conversion = envoi de l'original.
    // VideoTropLongue (au-delà de la durée max) remonte au contrôleur, qui répond 400.
    data = (await this.transcodage.preparer(data, { coteMax: 1920, crf: 19 })).data;
    const tmp = path.join(os.tmpdir(), `video_raw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    await fs.promises.writeFile(tmp, data);
    try {
      // Forme avec callback obligatoire : sans elle, upload_large rend un flux et non une
      // promesse (voir envoyerGrosFichier).
      const up = await envoyerGrosFichier(tmp, {
        resource_type: 'video',
        folder: `videos_raw/${telegramId}`,
        overwrite: true,
      });
      return { video_url: up.secure_url, public_id: up.public_id, duration: up.duration, width: up.width, height: up.height };
    } finally {
      fs.unlink(tmp, () => undefined);
    }
  }

  async suggestHooks(data: Buffer, filename: string, contentType: string | undefined): Promise<string[]> {
    const res = await this.montagePoc.suggestHooks(data, filename, contentType);
    if (!res.ok) throw new Error(res.error || 'Suggestion indisponible.');
    return res.hooks || [];
  }

  /** Crée un contenu-script (statut « À tourner ») depuis un script — apparaît dans Contenus. */
  async draft(
    telegramId: string,
    script?: string | null,
    titre?: string | null,
    reseau?: string | null,
    brouillonId?: string | null,
  ): Promise<{ contenu_id: string | null }> {
    const scriptTxt = (script || '').trim();
    const titreEff = (titre || (scriptTxt ? scriptTxt.slice(0, 80) : 'Vidéo')).trim().slice(0, 120);
    const row: Record<string, unknown> = {
      telegram_id: telegramId,
      titre: titreEff,
      type: normTypeContenu('Reel'),
      statut: normStatutContenu('A tourner'),
      script: scriptTxt || null,
    };
    const net = RESEAU_MAP[(reseau || '').toLowerCase()];
    if (net) row.reseau_cible = net;
    // Script du Studio IA déjà en base (statut Brouillon) : on le PROMEUT (même ligne) en « A tourner ».
    if (brouillonId) {
      const ex = await this.prisma.contenu.findFirst({
        where: { id: brouillonId, telegram_id: telegramId },
        select: { statut: true, script: true },
      });
      if (ex?.statut === 'Brouillon') {
        const { telegram_id: _t, ...maj } = row;
        await this.prisma.contenu.update({ where: { id: brouillonId }, data: { ...maj, updated_at: new Date() } as never });
        if (scriptTxt && scriptTxt !== (ex.script || '').trim()) {
          await this.contenuEvenement.logRetouche(brouillonId, telegramId, scriptTxt);
        }
        await this.contenuEvenement.log(brouillonId, 'soumis', telegramId, scriptTxt);
        return { contenu_id: brouillonId };
      }
    }
    const ins = await this.prisma.contenu.create({ data: row as never });
    return { contenu_id: ins.id };
  }

  /** Lance le montage Studio Montage sur une vidéo déjà uploadée. */
  async create(
    telegramId: string,
    body: {
      video_url: string;
      titre?: string;
      template?: string;
      brolls?: boolean;
      broll_pct?: number | null;
      zooms?: boolean;
      silence_pace?: string | null;
      clean_audio?: boolean;
      music?: string;
      music_volume?: number;
      hook?: string;
      hook_auto?: boolean;
      hook_position?: string;
      hook_fontscale?: number;
      emojis?: boolean;
      font?: string | null;
      hl_color?: string | null;
      fontscale?: number;
      position?: number;
      uppercase?: boolean;
      broll_urls?: string[] | null;
      contenu_id?: string | null;
      raw_public_id?: string | null;
      reseaux?: unknown;
      reseau?: unknown;
    },
  ): Promise<{ contenu_id: string | null; submagic_project_id: string; video_status: string } | { error: string }> {
    const videoUrl = (body.video_url || '').trim();
    if (!videoUrl) return { error: 'video_url requise (upload d\'abord).' };

    const title = (body.titre || 'Vidéo').slice(0, 120);
    const nets = targets(body).length ? targets(body) : ['Instagram'];
    const res = await this.montagePoc.createProject({
      title,
      videoUrl,
      templateName: body.template || 'classic',
      magicBrolls: body.brolls ?? true,
      magicBrollsPercentage: body.broll_pct ?? null,
      magicZooms: body.zooms ?? true,
      removeSilencePace: body.silence_pace || null,
      cleanAudio: body.clean_audio ?? false,
      musicId: body.music || 'none',
      musicVolume: body.music_volume ?? 25,
      hook: body.hook || '',
      hookAuto: Boolean(body.hook_auto),
      hookPosition: body.hook_position || 'top',
      hookFontscale: body.hook_fontscale ?? 1.0,
      emojis: Boolean(body.emojis),
      font: body.font || null,
      hlColor: body.hl_color || null,
      fontscale: body.fontscale ?? 1.0,
      position: body.position ?? 0.3,
      uppercase: body.uppercase ?? true,
      brollUrls: body.broll_urls || null,
    });
    if (!res.ok) return { error: res.error || "Le montage n'a pas pu démarrer." };

    const pid = res.id!;
    const patch: Record<string, unknown> = {
      type: normTypeContenu('Reel'),
      statut: normStatutContenu('A valider'),
      submagic_project_id: pid,
      video_status: 'en_traitement',
      video_raw_id: body.raw_public_id || null,
    };
    const existingId = body.contenu_id || null;
    let scriptTxt: string | null = null;
    let contenuId: string | null;
    let primaryNet: string;
    if (existingId) {
      const ex = await this.prisma.contenu.findFirst({ where: { id: existingId, telegram_id: telegramId }, select: { script: true, reseau_cible: true } });
      scriptTxt = ex?.script ?? null;
      primaryNet = (ex?.reseau_cible as string | undefined) || nets[0];
      const p: Record<string, unknown> = { ...patch };
      if (!ex?.reseau_cible) p.reseau_cible = primaryNet;
      await this.prisma.contenu.update({ where: { id: existingId }, data: p as never });
      contenuId = existingId;
    } else {
      primaryNet = nets[0];
      const row = { telegram_id: telegramId, titre: title, reseau_cible: primaryNet, ...patch };
      const ins = await this.prisma.contenu.create({ data: row as never });
      contenuId = ins.id;
    }
    // Réseaux supplémentaires → contenus « jumeaux » (même montage, publiés/planifiés séparément).
    for (const net of nets) {
      if (net === primaryNet) continue;
      await this.prisma.contenu.create({
        data: {
          telegram_id: telegramId,
          titre: title,
          type: normTypeContenu('Reel'),
          statut: normStatutContenu('A valider'),
          submagic_project_id: pid,
          video_status: 'en_traitement',
          reseau_cible: net,
          script: scriptTxt,
        } as never,
      });
    }
    return { contenu_id: contenuId, submagic_project_id: pid, video_status: 'en_traitement' };
  }

  /** Import DIRECT d'une vidéo déjà prête — SANS montage, SANS quota vidéo. */
  async importVideo(
    telegramId: string,
    body: { video_url: string; titre?: string; contenu_id?: string | null; as_story?: boolean; reseaux?: unknown; reseau?: unknown },
  ): Promise<{ contenu_id: string | null; video_status: string; video_url: string }> {
    const videoUrl = (body.video_url || '').trim();
    if (!videoUrl) throw new Error("video_url requise (upload d'abord).");
    const title = (body.titre || 'Vidéo').slice(0, 120);
    const nets = targets(body).length ? targets(body) : ['Instagram'];
    const posterUrl = poster(videoUrl);
    const asStory = Boolean(body.as_story);
    const typeFor = (net: string) => (asStory && ['Instagram', 'Facebook'].includes(net) ? normTypeContenu('Story') : normTypeContenu('Reel'));

    const patch: Record<string, unknown> = {
      statut: normStatutContenu('A valider'),
      video_status: 'pret',
      video_url: videoUrl,
      video_preview_url: null,
      lien_visuel: posterUrl,
      submagic_project_id: null,
      video_raw_id: null,
    };
    const existingId = body.contenu_id || null;
    let scriptTxt: string | null = null;
    let contenuId: string | null;
    let primaryNet: string;
    if (existingId) {
      const ex = await this.prisma.contenu.findFirst({ where: { id: existingId, telegram_id: telegramId }, select: { script: true, reseau_cible: true } });
      scriptTxt = ex?.script ?? null;
      primaryNet = (ex?.reseau_cible as string | undefined) || nets[0];
      const p: Record<string, unknown> = { ...patch, type: typeFor(primaryNet) };
      if (!ex?.reseau_cible) p.reseau_cible = primaryNet;
      await this.prisma.contenu.update({ where: { id: existingId }, data: p as never });
      contenuId = existingId;
    } else {
      primaryNet = nets[0];
      const row = { telegram_id: telegramId, titre: title, reseau_cible: primaryNet, type: typeFor(primaryNet), ...patch };
      const ins = await this.prisma.contenu.create({ data: row as never });
      contenuId = ins.id;
    }
    for (const net of nets) {
      if (net === primaryNet) continue;
      await this.prisma.contenu.create({
        data: {
          telegram_id: telegramId,
          titre: title,
          type: typeFor(net),
          statut: normStatutContenu('A valider'),
          video_status: 'pret',
          video_url: videoUrl,
          video_preview_url: null,
          lien_visuel: posterUrl,
          reseau_cible: net,
          script: scriptTxt,
        } as never,
      });
    }
    return { contenu_id: contenuId, video_status: 'pret', video_url: videoUrl };
  }

  /** Si le montage Studio Montage est prêt : attache le MP4 (déjà sur Cloudinary) au
   * contenu. Idempotent : si déjà 'pret'/'echec', ne refait rien. */
  async finalize(contenu: { video_status?: string | null; video_url?: string | null; video_preview_url?: string | null; submagic_project_id?: string | null; telegram_id?: string | null }): Promise<FinalizeResult> {
    if (contenu.video_status === 'pret' || contenu.video_status === 'echec') {
      return { video_status: contenu.video_status, video_url: contenu.video_url, video_preview_url: contenu.video_preview_url };
    }
    const pid = contenu.submagic_project_id;
    const tid = contenu.telegram_id;
    if (!pid) return { video_status: 'en_traitement' };
    let info: Awaited<ReturnType<MontagePocService['getProject']>>;
    try {
      info = await this.montagePoc.getProject(pid);
    } catch (e) {
      this.logger.error(`finalize get_project ${pid}: ${e instanceof Error ? e.message : e}`);
      return { video_status: 'en_traitement' };
    }

    if (info.status === FAILED) {
      await this.prisma.contenu.updateMany({ where: { submagic_project_id: pid }, data: { video_status: 'echec' } });
      if (tid) await this.quotaService.refundByUser(tid, 'video');
      return { video_status: 'echec' };
    }
    if (info.status !== DONE) return { video_status: 'en_traitement', stage: info.status };

    let videoUrl = info.direct_url || info.download_url;
    if (!videoUrl) return { video_status: 'en_traitement' };
    // Édition après rendu : Cloudinary garde le même public_id mais change la version dans
    // l'URL ; si l'URL n'a pas bougé (cache), on force un paramètre pour rafraîchir les lecteurs.
    if (contenu.video_url && videoUrl === contenu.video_url) {
      const sep = videoUrl.includes('?') ? '&' : '?';
      videoUrl = `${videoUrl}${sep}v=${Math.floor(Date.now() / 1000)}`;
    }

    const patch = {
      video_status: 'pret',
      video_url: videoUrl,
      video_preview_url: info.preview_url,
      lien_visuel: poster(videoUrl),
    };
    await this.prisma.contenu.updateMany({ where: { submagic_project_id: pid }, data: patch as never });
    // La vidéo brute (portée par le contenu primaire) ne sert plus → suppression.
    const raws = await this.prisma.contenu.findMany({ where: { submagic_project_id: pid }, select: { id: true, video_raw_id: true } });
    for (const rr of raws) {
      if (!rr.video_raw_id) continue;
      try {
        await cloudinary.uploader.destroy(rr.video_raw_id, { resource_type: 'video', invalidate: true });
      } catch (e) {
        this.logger.warn(`cleanup vidéo brute ${rr.video_raw_id}: ${e instanceof Error ? e.message : e}`);
      }
      await this.prisma.contenu.update({ where: { id: rr.id }, data: { video_raw_id: null } });
    }
    return { video_status: 'pret', video_url: videoUrl, video_preview_url: info.preview_url };
  }

  async status(telegramId: string, contenuId: string): Promise<FinalizeResult> {
    const c = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!c) throw new Error('not_found');
    return this.finalize(c);
  }

  async contenuDuClient(contenuId: string, telegramId: string) {
    const c = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!c) throw new Error('not_found');
    return c;
  }

  /** Tout ce qu'il faut pour modifier une vidéo déjà montée : les mots avec leurs temps, la
   * langue, les réglages du montage, les passages déjà supprimés. */
  async edition(contenuId: string, telegramId: string) {
    const c = await this.contenuDuClient(contenuId, telegramId);
    const pid = c.submagic_project_id;
    if (!pid) throw new Error("Cette vidéo n'a pas été montée par le Studio Vidéo.");
    const d = await this.montagePoc.getTranscript(pid);
    if (!d.ok) throw new Error((d.error as string) || 'Montage introuvable.');
    return {
      contenu_id: contenuId,
      job_id: pid,
      video_url: c.video_url || d.video_url,
      video_status: c.video_status,
      words: d.words || [],
      language: d.language || 'fr',
      options: d.options || {},
      removed: d.removed || [],
      editable: Boolean(d.editable),
      titre: c.titre,
      reseau: c.reseau_cible,
    };
  }

  private static readonly OPTIONS_AUTORISEES = new Set([
    'preset', 'hook', 'hook_auto', 'hook_preset', 'hook_position', 'hook_fontscale', 'music_id', 'music_volume',
    'emojis', 'brolls', 'brolls_count', 'font', 'hl_color', 'fontscale', 'position', 'uppercase',
    'cuts', 'cuts_pace', 'zoom', 'audio_clean',
  ]);

  /** Re-monte la vidéo sur place avec les corrections du client. Sans quota. */
  async rerenderVideo(
    contenuId: string,
    telegramId: string,
    body: { words?: Array<{ text?: string; start: number; end: number }> | null; removed?: Array<[number, number]> | null; options?: Record<string, unknown> | null },
  ): Promise<{ contenu_id: string; submagic_project_id: string; video_status: string }> {
    const c = await this.contenuDuClient(contenuId, telegramId);
    const pid = c.submagic_project_id;
    if (!pid) throw new Error("Cette vidéo n'a pas été montée par le Studio Vidéo.");
    if (c.video_status === 'en_traitement') throw new Error('conflict:Un rendu est déjà en cours pour cette vidéo.');
    if (!['A_valider', 'Refuse'].includes(String(c.statut))) {
      throw new Error('conflict:Cette vidéo a déjà été validée : elle ne peut plus être modifiée.');
    }
    let words: Array<{ text: string; start: number; end: number }> | undefined;
    if (Array.isArray(body.words)) {
      words = [];
      for (const w of body.words.slice(0, 5000)) {
        const start = Number(w.start);
        const end = Number(w.end);
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        words.push({ text: String(w.text || '').trim().slice(0, 60), start, end });
      }
    }
    const removed: Array<[number, number]> = [];
    for (const r of (body.removed || []).slice(0, 500)) {
      const a = Number(r[0]);
      const b = Number(r[1]);
      if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) removed.push([Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
    }
    const optionsIn = body.options && typeof body.options === 'object' ? body.options : {};
    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(optionsIn)) {
      if (VideoService.OPTIONS_AUTORISEES.has(k)) options[k] = v;
    }
    const res = await this.montagePoc.rerender(pid, options, words, removed);
    if (!res.ok) throw new Error(res.error || "Le re-rendu n'a pas pu démarrer.");
    await this.prisma.contenu.updateMany({ where: { submagic_project_id: pid }, data: { video_status: 'en_traitement' } });
    return { contenu_id: contenuId, submagic_project_id: pid, video_status: 'en_traitement' };
  }
}
