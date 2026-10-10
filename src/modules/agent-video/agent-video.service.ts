import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { MarqueService } from '../marque/marque.service';
import { MusicLibraryService } from '../music/music-library.service';
import { NotificationService } from '../notifications/notification.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';

/**
 * Montage par l'agent IA du VPS (Claude Code lancé sans interface).
 *
 * Postorico ne se connecte JAMAIS au VPS : le client crée un travail (`en_attente`), le worker du
 * VPS vient le réserver (`prendre`), signale qu'il est vivant (`battement`), demande une
 * signature pour envoyer le MP4 directement sur Cloudinary (il ne connaît pas le secret
 * Cloudinary), puis rend compte (`terminer` / `echouer`). Le contenu suit le même cycle que les
 * reels : `video_status` en_traitement -> ready | echec, et Contenus se rafraîchit seul.
 *
 * Quota `video_agent` : consommé à la demande, confirmé au succès, rendu à l'échec définitif.
 */

export const ACTION_QUOTA = 'video_agent';
/** Un travail `en_cours` sans battement depuis ce délai est considéré comme perdu. */
export const PERIME_MIN = 20;
export const MAX_TENTATIVES = 2;
const FORMATS = ['9:16', '16:9', '1:1'] as const;
const RESEAUX: Record<string, string> = {
  instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook',
};

export interface Rush { url: string; debut?: number | null; fin?: number | null }

export interface DemandeMontage {
  clips: Rush[];
  consignes?: string | null;
  reseau?: string | null;
  format?: string | null;
  duree_cible_s?: number | null;
  musique?: string | null;
}

/** Un rush n'est accepté que s'il vient du Cloudinary de Postorico ET du dossier du client. */
export function rushAutorise(url: string, cloud: string, telegramId: string): boolean {
  if (typeof url !== 'string' || !url.startsWith(`https://res.cloudinary.com/${cloud}/video/upload/`)) return false;
  return url.includes(`/banque/${telegramId}/`) || url.includes(`/videos_raw/${telegramId}/`);
}

/** Aperçu (image) d'une vidéo Cloudinary : même dérivation que la file de rendu. */
export function apercuDe(videoUrl: string, couvertureS = 1): string {
  if (!videoUrl.includes('/upload/')) return videoUrl;
  return videoUrl.replace('/upload/', `/upload/so_${couvertureS.toFixed(2)}/`).replace(/\.[^./]+$/, '') + '.jpg';
}

@Injectable()
export class AgentVideoService {
  private readonly logger = new Logger(AgentVideoService.name);
  readonly jeton: string;
  private readonly budgetUsd: number;
  private readonly dureeMaxS: number;
  private readonly cloud: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly marque: MarqueService,
    private readonly musique: MusicLibraryService,
    private readonly planning: PlanningService,
    private readonly notifications: NotificationService,
    private readonly usage: UsageService,
    config: ConfigService,
  ) {
    this.jeton = config.get<string>('app.agentVideoWorkerToken') || '';
    this.budgetUsd = config.get<number>('app.agentVideoBudgetUsd') || 3;
    this.dureeMaxS = config.get<number>('app.agentVideoDureeMaxS') || 180;
    this.cloud = config.get<string>('app.cloudinaryCloudName') || '';
    this.apiKey = config.get<string>('app.cloudinaryApiKey') || '';
    this.apiSecret = config.get<string>('app.cloudinaryApiSecret') || '';
    cloudinary.config({ cloud_name: this.cloud, api_key: this.apiKey, api_secret: this.apiSecret });
  }

  get actif(): boolean {
    return Boolean(this.jeton);
  }

  // -------------------------------------------------------------------------------- client

  /** Valide la demande, consomme le quota, crée le contenu « en cours » et le travail. */
  async creer(telegramId: string, d: DemandeMontage): Promise<{ id: string; travail_id: string; video_status: string } | { error: string; status?: number }> {
    if (!this.actif) return { error: "Le montage par l'IA est momentanément indisponible.", status: 503 };
    const clips = (d.clips || []).slice(0, 10);
    if (!clips.length) return { error: 'Ajoute au moins une vidéo à monter.' };
    if (clips.some((c) => !rushAutorise(c.url, this.cloud, telegramId))) return { error: 'Une des vidéos ne vient pas de ton espace Postorico.' };
    const format = FORMATS.includes(d.format as (typeof FORMATS)[number]) ? (d.format as string) : '9:16';
    const reseau = RESEAUX[String(d.reseau || '').toLowerCase()] || 'Instagram';
    const consignes = String(d.consignes || '').trim().slice(0, 2000);
    const dureeCible = d.duree_cible_s ? Math.max(5, Math.min(this.dureeMaxS, Math.round(Number(d.duree_cible_s)))) : null;

    await this.quota.exigerAbonnement(telegramId);
    const q = await this.quota.consume(telegramId, ACTION_QUOTA);
    if (!q.ok) return { error: q.message || 'Quota de montages IA atteint.', status: 402 };

    try {
      const u = await this.marque.chargerMarque(telegramId);
      const musiqueUrl = d.musique ? await this.musique.urlDe(d.musique, telegramId) : null;
      const brief = {
        consignes,
        clips: clips.map((c) => ({ url: c.url, debut: c.debut ?? null, fin: c.fin ?? null })),
        format,
        reseau,
        duree_cible_s: dureeCible,
        duree_max_s: this.dureeMaxS,
        budget_usd: this.budgetUsd,
        musique_url: musiqueUrl || null,
        langue: 'fr',
        charte: {
          nom: u.nom || u.user_name || 'Ma marque',
          couleur_principale: u.couleur_principale || null,
          couleur_secondaire: u.couleur_secondaire || null,
          couleur_accent: u.couleur_accent || null,
          logo_url: u.logo_url || null,
          police_titre: u.typo_primaire || null,
          police_texte: u.typo_secondaire || null,
          ton: u.ton || u.tone || null,
        },
      };
      const creneau = await this.planning.prochainCreneau(telegramId, reseau, 'Reel');
      const contenu = await this.prisma.contenu.create({
        data: {
          telegram_id: telegramId,
          titre: (consignes || 'Montage par l\'IA').slice(0, 60),
          contenu: consignes || null,
          type: normTypeContenu('Reel'),
          reseau_cible: reseau,
          statut: normStatutContenu('A valider'),
          video_status: 'en_traitement',
          reel_data: { agent: { statut: 'en_attente', format } },
          created_at: new Date(),
          ...(creneau ? { date_publication: creneau } : {}),
        } as never,
      });
      const travail = await this.prisma.travaux_agent_video.create({
        data: { contenu_id: contenu.id, telegram_id: telegramId, brief: brief as never },
      });
      await this.quota.confirm(q);
      return { id: contenu.id, travail_id: travail.id, video_status: 'en_traitement' };
    } catch (e) {
      await this.quota.refund(q);
      this.logger.error(`agent vidéo création ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Impossible de lancer le montage, réessaie.' };
    }
  }

  // -------------------------------------------------------------------------------- worker

  /** Remet en file les travaux perdus (plus de battement), ou les passe en échec après 2 essais. */
  async rearmerPerimes(maintenant = new Date()): Promise<void> {
    const limite = new Date(maintenant.getTime() - PERIME_MIN * 60_000);
    const perdus = await this.prisma.travaux_agent_video.findMany({
      where: { statut: 'en_cours', OR: [{ vu_le: { lt: limite } }, { vu_le: null, pris_le: { lt: limite } }] },
      select: { id: true, tentatives: true },
    });
    for (const p of perdus) {
      if (p.tentatives < MAX_TENTATIVES) {
        await this.prisma.travaux_agent_video.updateMany({ where: { id: p.id, statut: 'en_cours' }, data: { statut: 'en_attente', pris_le: null, vu_le: null, progression: 'Relancé après une coupure du worker' } });
      } else {
        await this.echouer(p.id, "Le worker ne répond plus (après plusieurs essais).");
      }
    }
  }

  /** Réserve atomiquement le plus ancien travail en attente (plusieurs workers possibles). */
  async prendre(): Promise<{ id: string; contenu_id: string; brief: unknown; tentative: number } | null> {
    await this.rearmerPerimes();
    const candidats = await this.prisma.travaux_agent_video.findMany({
      where: { statut: 'en_attente' },
      orderBy: { created_at: 'asc' },
      take: 5,
      select: { id: true, contenu_id: true, brief: true, tentatives: true },
    });
    for (const c of candidats) {
      const maintenant = new Date();
      const r = await this.prisma.travaux_agent_video.updateMany({
        where: { id: c.id, statut: 'en_attente' },
        data: { statut: 'en_cours', pris_le: maintenant, vu_le: maintenant, tentatives: { increment: 1 }, progression: 'Pris en charge', erreur: null },
      });
      if (r.count === 1) {
        await this.majContenuAgent(c.contenu_id, { statut: 'en_cours' });
        return { id: c.id, contenu_id: c.contenu_id, brief: c.brief, tentative: c.tentatives + 1 };
      }
    }
    return null;
  }

  async battement(id: string, progression?: string | null): Promise<boolean> {
    const r = await this.prisma.travaux_agent_video.updateMany({
      where: { id, statut: 'en_cours' },
      data: { vu_le: new Date(), ...(progression ? { progression: String(progression).slice(0, 300) } : {}) },
    });
    return r.count === 1;
  }

  /** Paramètres d'un envoi signé vers Cloudinary : le worker envoie le MP4 sans le secret. */
  async signature(id: string): Promise<Record<string, unknown> | null> {
    const t = await this.prisma.travaux_agent_video.findFirst({ where: { id, statut: 'en_cours' }, select: { telegram_id: true, contenu_id: true } });
    if (!t) return null;
    const params = { public_id: this.publicId(t.telegram_id, t.contenu_id), overwrite: 'true', invalidate: 'true', timestamp: Math.floor(Date.now() / 1000) };
    const signature = cloudinary.utils.api_sign_request(params, this.apiSecret);
    return { url: `https://api.cloudinary.com/v1_1/${this.cloud}/video/upload`, api_key: this.apiKey, ...params, signature };
  }

  private publicId(telegramId: string, contenuId: string): string {
    return `reels/${telegramId}/${contenuId}`;
  }

  /** Le worker a envoyé la vidéo : on vérifie chez Cloudinary, puis le contenu passe « prêt ». */
  async terminer(id: string, r: { duree_s?: number | null; cout_usd?: number | null; resume?: string | null }): Promise<{ ok: true } | { error: string }> {
    const t = await this.prisma.travaux_agent_video.findFirst({ where: { id, statut: 'en_cours' } });
    if (!t) return { error: 'Travail introuvable ou déjà clos.' };
    let video: { secure_url: string; duration?: number };
    try {
      video = await cloudinary.api.resource(this.publicId(t.telegram_id, t.contenu_id), { resource_type: 'video' });
    } catch {
      return { error: "Vidéo introuvable sur Cloudinary : envoie-la avant d'appeler terminer." };
    }
    const duree = Number(video.duration ?? r.duree_s ?? 0);
    if (duree > this.dureeMaxS + 1) {
      await this.echouer(id, `Vidéo trop longue (${Math.round(duree)} s, ${this.dureeMaxS} s maximum).`, r.cout_usd);
      return { error: 'Vidéo trop longue.' };
    }
    const cout = typeof r.cout_usd === 'number' && Number.isFinite(r.cout_usd) ? r.cout_usd : null;
    const apercu = apercuDe(video.secure_url);
    await this.prisma.travaux_agent_video.update({
      where: { id },
      data: { statut: 'termine', fini_le: new Date(), duree_s: duree || null, cout_usd: cout, progression: 'Terminé', erreur: null },
    });
    const c = await this.prisma.contenu.findUnique({ where: { id: t.contenu_id }, select: { reel_data: true, reseau_cible: true } });
    if (c) {
      await this.prisma.contenu.update({
        where: { id: t.contenu_id },
        data: {
          video_url: video.secure_url,
          video_preview_url: apercu,
          lien_visuel: apercu,
          video_status: 'ready',
          reel_data: { ...((c.reel_data as Record<string, unknown>) || {}), agent: { statut: 'termine', resume: (r.resume || '').slice(0, 1000) || null, cout_usd: cout, duree_s: duree || null } } as never,
        },
      });
      await this.notifications.notifier(t.telegram_id, t.contenu_id, c.reseau_cible as string | null, 'reel.ready', 'Ton montage IA est prêt 🎬', 'À valider dans Contenus.');
    }
    if (cout !== null) await this.usage.log(t.telegram_id, ACTION_QUOTA, 'claude-code', undefined, 0, undefined, cout).catch(() => undefined);
    return { ok: true };
  }

  /** Échec signalé par le worker : nouvel essai si possible, sinon échec définitif + quota rendu. */
  async echouer(id: string, erreur: string, coutUsd?: number | null): Promise<{ relance: boolean } | null> {
    const t = await this.prisma.travaux_agent_video.findFirst({ where: { id, statut: { in: ['en_cours', 'en_attente'] } } });
    if (!t) return null;
    const message = String(erreur || 'Erreur inconnue').slice(0, 500);
    const cout = typeof coutUsd === 'number' && Number.isFinite(coutUsd) ? coutUsd : null;
    if (cout !== null) await this.usage.log(t.telegram_id, ACTION_QUOTA, 'claude-code', undefined, 0, undefined, cout).catch(() => undefined);
    if (t.tentatives < MAX_TENTATIVES) {
      await this.prisma.travaux_agent_video.update({ where: { id }, data: { statut: 'en_attente', pris_le: null, vu_le: null, erreur: message, progression: 'Nouvel essai' } });
      await this.majContenuAgent(t.contenu_id, { statut: 'en_attente' });
      return { relance: true };
    }
    await this.prisma.travaux_agent_video.update({ where: { id }, data: { statut: 'echec', fini_le: new Date(), erreur: message, cout_usd: cout } });
    const c = await this.prisma.contenu.findUnique({ where: { id: t.contenu_id }, select: { reel_data: true, reseau_cible: true } });
    if (c) {
      await this.prisma.contenu.update({
        where: { id: t.contenu_id },
        data: { video_status: 'echec', reel_data: { ...((c.reel_data as Record<string, unknown>) || {}), agent: { statut: 'echec', erreur: message } } as never },
      });
      await this.notifications.notifier(t.telegram_id, t.contenu_id, c.reseau_cible as string | null, 'reel.echec', 'Montage IA : échec ❌', "Le montage n'a pas abouti (montage rendu sur ton quota). Supprime-le et réessaie.");
    }
    await this.quota.refundByUser(t.telegram_id, ACTION_QUOTA);
    return { relance: false };
  }

  private async majContenuAgent(contenuId: string, agent: Record<string, unknown>): Promise<void> {
    try {
      const c = await this.prisma.contenu.findUnique({ where: { id: contenuId }, select: { reel_data: true } });
      if (!c) return;
      const rd = (c.reel_data as Record<string, unknown>) || {};
      await this.prisma.contenu.update({ where: { id: contenuId }, data: { reel_data: { ...rd, agent: { ...((rd.agent as object) || {}), ...agent } } as never } });
    } catch (e) {
      this.logger.warn(`agent vidéo maj contenu ${contenuId}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
