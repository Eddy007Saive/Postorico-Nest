import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../config/prisma.service';
import { ContenuEvenementService } from '../contenus/contenu-evenement.service';
import { MailService } from '../mail/mail.service';
import { PushService } from '../notifications/push.service';
import { PlanningService } from '../planning/planning.service';
import { SocialService } from '../social/social.service';
import { ZernioClientService, ZernioError } from '../zernio/zernio-client.service';
import { ZernioMediaItem, ZernioPlatformEntry } from '../zernio/interfaces/zernio.interface';

/**
 * Publication sociale via Late / Zernio (backend-direct, sans n8n) — port direct de
 * backend/services/late_service.py.
 *
 * Flux : on pousse le contenu validé dans Zernio avec sa date (`scheduledFor`). Zernio le
 * met en file et publie tout seul à l'heure, puis envoie un webhook (post.published /
 * post.failed) -> on met à jour le statut + le lien.
 *
 * Portée volontairement réduite (documentée à chaque endroit concerné) :
 * - `_handle_account_event` utilisait côté Python les colonnes `users.late_account_<réseau>`
 *   — DEVENUES OBSOLÈTES depuis la normalisation du 14/08/2026 (déplacées vers
 *   `comptes_sociaux`, confirmé par introspection du schéma réel : ces colonnes n'existent
 *   plus sur `users`). Ce port utilise directement `comptes_sociaux`, la vraie source de
 *   vérité actuelle.
 */

const PLATFORMS = new Set(['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'googlebusiness', 'twitter']);

// Limite de légende par plateforme (caractères) — vérifiée AVANT l'envoi à Zernio.
const CAPTION_LIMITS: Record<string, number> = {
  instagram: 2200,
  tiktok: 2200,
  googlebusiness: 1500,
  twitter: 280,
  linkedin: 3000,
  facebook: 63000,
  youtube: 5000,
};
const DEFAULT_TZ = 'Europe/Paris';

// Où chaque plateforme attend la couverture d'une vidéo (doc Zernio, septembre 2026).
const COUVERTURE_DANS_MEDIA = new Set(['facebook', 'linkedin']);

type ContenuRow = Record<string, unknown>;

export interface PublishResult {
  ok: boolean;
  late_post_id?: string;
  status?: string;
  error?: string;
  duplicate?: boolean;
}

export interface ProgrammerResult {
  ok: boolean;
  late_post_id?: string;
  already?: boolean;
  skipped?: string;
  error?: string;
}

// Réseaux qui refusent un post sans média (Late répond sinon « require media content »)
const MEDIA_OBLIGATOIRE: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

/** Erreur de Late (souvent en anglais) -> message compréhensible — port de `_erreur_lisible`. */
export function erreurLisible(msg: string, reseau = ''): string {
  const low = (msg || '').toLowerCase();
  const nom = MEDIA_OBLIGATOIRE[reseau] || (reseau ? reseau.charAt(0).toUpperCase() + reseau.slice(1) : 'Ce réseau');
  if (low.includes('require media') || low.includes('media content')) {
    return `${nom} ne publie pas de texte seul : ajoute une image ou une vidéo, puis revalide.`;
  }
  if (low.includes('do not belong') || low.includes('account not found') || low.includes('not found for this user')) {
    return `Ton compte ${nom} n'est plus relié à ton espace de publication. Reconnecte-le dans Paramètres, puis revalide.`;
  }
  if (low.includes('token') && (low.includes('expired') || low.includes('invalid'))) {
    return `La connexion à ${nom} a expiré. Reconnecte-le dans Paramètres, puis revalide.`;
  }
  if (low.includes('aspect ratio')) return `${nom} refuse le format de l'image (proportions). Change de visuel, puis revalide.`;
  if (low.includes('rate limit') || low.includes('too many')) {
    return `${nom} limite le nombre de publications pour le moment. Réessaie un peu plus tard.`;
  }
  return `${nom} a refusé la publication : ${msg}`;
}

const RESEAUX_ENUM: Record<string, string> = {
  linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook',
  tiktok: 'TikTok', youtube: 'YouTube', googlebusiness: 'GoogleBusiness',
};

@Injectable()
export class LateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LateService.name);
  private readonly webhookSecret: string;
  private readonly sweepActif: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
    private readonly mailService: MailService,
    private readonly socialService: SocialService,
    private readonly pushService: PushService,
    private readonly contenuEvenement: ContenuEvenementService,
    private readonly planningService: PlanningService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>('app.lateWebhookSecret') || '';
    this.sweepActif = config.get<boolean>('app.publishSweepActive') ?? true;
  }

  /** Filet de sécurité : toutes les 10 min, programme sur Zernio les contenus 'Planifie' à
   * date future jamais poussés — port direct de backend/server.py::_publish_sweep_cron. */
  onApplicationBootstrap(): void {
    if (!this.sweepActif) {
      this.logger.log('Rattrapage des publications désactivé (PUBLISH_SWEEP_ACTIVE=0)');
      return;
    }
    setTimeout(() => {
      void this.sweepPlanifies();
      setInterval(() => void this.sweepPlanifies(), 10 * 60 * 1000);
    }, 90_000);
  }

  // ---------------------------------------------------------------------------
  // Médias
  // ---------------------------------------------------------------------------
  /** Conforme une image Cloudinary au ratio accepté par Instagram [0.8 ; 1.91] via un
   * PADDING conditionnel : ne touche pas les images déjà dans la plage, ne rogne jamais. */
  private igFit(url: string): string {
    if (!url || !url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
    const t = 'if_ar_lt_0.8/ar_4:5,c_pad,b_auto/if_end/if_ar_gt_1.91/ar_191:100,c_pad,b_auto/if_end';
    return url.replace('/image/upload/', `/image/upload/${t}/`);
  }

  /** Une couverture doit être un JPEG ou un PNG : nos miniatures sont servies en f_auto
   * (WebP/AVIF selon le navigateur), on force le JPEG pour les plateformes. */
  private jpg(url: string): string {
    if (url.includes('res.cloudinary.com') && url.includes('/image/upload/')) {
      if (url.includes('f_auto')) return url.replace('f_auto', 'f_jpg');
      if (!url.includes('/image/upload/q_auto') && !url.includes('/image/upload/f_')) {
        return url.replace('/image/upload/', '/image/upload/q_auto,f_jpg/');
      }
    }
    return url;
  }

  /** Image de couverture d'une vidéo (JPEG). On préfère la miniature composée par le
   * client, puis la vignette déjà calculée, à défaut on dérive une frame de la vidéo. */
  private couverture(contenu: ContenuRow): string | null {
    const reelData = (contenu.reel_data as Record<string, unknown>) || {};
    const mini = ((reelData.miniature as Record<string, unknown>) || {}).url as string | undefined;
    if (mini) return this.jpg(mini);
    for (const cle of ['lien_visuel', 'video_preview_url']) {
      const u = contenu[cle] as string | undefined;
      if (u && u.includes('res.cloudinary.com') && u.includes('/image/upload/')) return this.jpg(u);
    }
    const v = (contenu.video_url as string) || '';
    if (v.includes('res.cloudinary.com') && v.includes('/video/upload/')) {
      return v.replace(/\.[^./]+$/, '').replace('/upload/', '/upload/so_3.0,q_auto/') + '.jpg';
    }
    return null;
  }

  /** Construit les médias Zernio selon le type de contenu et le réseau. */
  private mediaItems(contenu: ContenuRow, reseau: string): ZernioMediaItem[] {
    if (contenu.video_url) {
      const item: ZernioMediaItem = { url: contenu.video_url as string, type: 'video' };
      if (COUVERTURE_DANS_MEDIA.has(reseau)) {
        const cover = this.couverture(contenu);
        if (cover) item.thumbnail = cover;
      }
      return [item];
    }
    const ig = reseau === 'instagram'; // Instagram impose un ratio 0.8–1.91 -> on conforme l'image
    const slidesImages = (contenu.slides_images as string[]) || [];
    const isCarrousel = contenu.type === 'Carrousel' || slidesImages.length > 0;
    if (isCarrousel) {
      if (reseau === 'linkedin' && contenu.carrousel_pdf) {
        return [{ url: contenu.carrousel_pdf as string, type: 'document' }];
      }
      if (slidesImages.length) {
        return slidesImages.slice(0, 10).map((u) => ({ url: ig ? this.igFit(u) : u, type: 'image' }));
      }
    }
    if (contenu.lien_visuel) {
      const u = contenu.lien_visuel as string;
      return [{ url: ig ? this.igFit(u) : u, type: 'image' }];
    }
    return [];
  }

  /** L'entrée `platforms[]` d'un post, avec la couverture au bon endroit pour une vidéo. */
  private plateforme(contenu: ContenuRow, reseau: string, accountId: string): ZernioPlatformEntry {
    const entry: ZernioPlatformEntry = { platform: reseau, accountId };
    if (!contenu.video_url) return entry;
    const cover = this.couverture(contenu);
    if (reseau === 'instagram' && cover) {
      // Sans elle Instagram choisit une frame au hasard.
      entry.platformSpecificData = { instagramThumbnail: cover };
    } else if (reseau === 'tiktok') {
      // Par défaut TikTok prend la frame à 1s : trop tôt pour nos reels (animation d'entrée).
      const reelData = (contenu.reel_data as Record<string, unknown>) || {};
      const mini = ((reelData.miniature as Record<string, unknown>) || {}).url as string | undefined;
      entry.platformSpecificData = mini ? { video_cover_image_url: this.jpg(mini) } : { videoCoverTimestampMs: 3000 };
    }
    return entry;
  }

  private tzOffsetMinutes(date: Date, tz: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
    const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return (asUtc - date.getTime()) / 60000;
  }

  /** Convertit une date (UTC ou naïve) en ISO 8601 avec le décalage du fuseau `tz`
   * explicite, pour que Zernio publie à l'heure murale du client sans ambiguïté. */
  private toTzIso(value: string, tz: string): string {
    try {
      const raw = String(value).trim();
      const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
      const date = new Date(hasOffset ? raw : `${raw}Z`);
      if (Number.isNaN(date.getTime())) throw new Error(`date invalide: ${raw}`);
      const zone = tz || DEFAULT_TZ;
      const offsetMin = this.tzOffsetMinutes(date, zone);
      const sign = offsetMin >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMin);
      const oh = String(Math.floor(abs / 60)).padStart(2, '0');
      const om = String(Math.round(abs % 60)).padStart(2, '0');
      const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const map: Record<string, string> = {};
      for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
      return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${sign}${oh}:${om}`;
    } catch (e) {
      this.logger.warn(`toTzIso fallback (${e instanceof Error ? e.message : e}) pour ${JSON.stringify(value)} tz=${JSON.stringify(tz)}`);
      return String(value);
    }
  }

  // ---------------------------------------------------------------------------
  // Publication
  // ---------------------------------------------------------------------------
  /** Pousse un contenu dans Zernio. Retourne {ok, late_post_id, status} ou {ok:false, error}. */
  async publishContenu(telegramId: string, contenu: ContenuRow, publishNow = false): Promise<PublishResult> {
    if (!this.zernio.isConfigured) {
      return { ok: false, error: 'Publication indisponible : clé Late non configurée (contacte le support).' };
    }
    const reseau = String(contenu.reseau_cible || '').toLowerCase();
    if (!PLATFORMS.has(reseau)) return { ok: false, error: 'Aucun réseau cible défini sur ce contenu.' };

    const accountId = await this.socialCompte(telegramId, reseau);
    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { timezone: true } });
    const userTz = user?.timezone || DEFAULT_TZ;
    if (!accountId) {
      return { ok: false, error: `Compte ${capitalize(reseau)} non connecté. Connecte-le dans Paramètres.` };
    }

    const content = String(contenu.contenu || '');
    const media = this.mediaItems(contenu, reseau);
    if (!content && !media.length) return { ok: false, error: 'Le contenu est vide (ni texte ni visuel).' };
    if (MEDIA_OBLIGATOIRE[reseau] && !media.length) {
      // Vérifié ICI plutôt que de laisser Late refuser (en anglais) après coup
      return { ok: false, error: erreurLisible('require media content', reseau) };
    }

    const limite = CAPTION_LIMITS[reseau];
    if (limite && content.length > limite) {
      return {
        ok: false,
        error: `Post trop long pour ${capitalize(reseau)} : ${content.length} caractères (limite ${limite}). Raccourcis le texte puis revalide.`,
      };
    }

    const platEntry = this.plateforme(contenu, reseau, accountId);
    // Story (Instagram/Facebook) : éphémère 24h, 1 média requis, pas de légende côté plateforme.
    if (contenu.type === 'Story' && (reseau === 'instagram' || reseau === 'facebook')) {
      if (!media.length) return { ok: false, error: "Une story nécessite un visuel — génère ou importe une image d'abord." };
      platEntry.platformSpecificData = { contentType: 'story' };
    }

    const payload: {
      content: string;
      platforms: ZernioPlatformEntry[];
      timezone: string;
      mediaItems?: ZernioMediaItem[];
      publishNow?: boolean;
      scheduledFor?: string;
    } = { content, platforms: [platEntry], timezone: userTz };
    if (media.length) payload.mediaItems = media;
    if (publishNow) {
      payload.publishNow = true;
    } else if (contenu.date_publication) {
      payload.scheduledFor = this.toTzIso(String(contenu.date_publication), userTz);
    }

    let resp;
    try {
      resp = await this.zernio.createPost(payload);
    } catch (e) {
      if (e instanceof ZernioError) {
        this.logger.error(`Late publish error: ${e.message}`);
        const low = e.message.toLowerCase();
        if (low.includes('already') && (low.includes('24 hours') || low.includes('posted to this account') || low.includes('scheduled'))) {
          return {
            ok: false,
            duplicate: true,
            error:
              'Doublon : ce contenu (texte identique) a déjà été publié ou programmé sur ce compte il y a moins de 24 h. ' +
              'Modifie légèrement le texte pour pouvoir republier.',
          };
        }
        return { ok: false, error: erreurLisible(e.message, reseau) };
      }
      this.logger.error(`Late publish exception: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: 'Late injoignable, réessaie.' };
    }

    const post = resp.post;
    const lateId = post?.id;
    const status = post?.status || 'scheduled';
    if (!lateId) this.logger.error(`Late publish: id introuvable dans la réponse SDK: ${JSON.stringify(resp)}`);
    return { ok: true, late_post_id: lateId, status };
  }

  private async socialCompte(telegramId: string, reseau: string): Promise<string | undefined> {
    const row = await this.prisma.comptes_sociaux.findUnique({
      where: { telegram_id_plateforme: { telegram_id: telegramId, plateforme: reseau } },
      select: { late_account_id: true },
    });
    return row?.late_account_id;
  }

  /** Vérifie la signature HMAC d'un webhook Late (fail-closed dès que LATE_WEBHOOK_SECRET
   * est configuré — voir VULN Strix du 2026-09-28 : cette fonction acceptait AUPARAVANT
   * toute requête sans signature, et journalisait sans jamais rejeter une signature
   * présente mais fausse. Une route publique sans ce garde-fou permettait de forger un
   * événement (post.published/failed/scheduled) pour n'importe quel late_post_id connu ou
   * deviné — y compris statut=Planifie, censé n'être posé QUE sur confirmation Zernio.
   *
   * Contrepartie assumée : le bouton "Test" du dashboard Late envoie un ping SANS
   * signature et sera désormais rejeté — vérifier la connectivité webhook en planifiant un
   * contenu réel plutôt qu'avec ce bouton. Si aucun secret n'est configuré du tout, la
   * vérification reste impossible et la requête est acceptée (comportement legacy, à
   * corriger en configurant LATE_WEBHOOK_SECRET). */
  verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret) return true;
    if (!signature) return false;
    try {
      const hexd = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
      const b64 = createHmac('sha256', this.webhookSecret).update(rawBody).digest('base64');
      // Ne retire qu'un préfixe littéral "sha256=" (convention style GitHub/Stripe) — ne
      // JAMAIS découper sur le premier/dernier "=" rencontré : un digest base64 de 32
      // octets se termine toujours par un "=" de padding, donc `split('=').slice(-1)[0]`
      // (ancien code) rendait une chaîne VIDE pour toute vraie signature base64 et cassait
      // silencieusement la comparaison (masqué avant par le `return true` inconditionnel).
      const sig = signature.startsWith('sha256=') ? signature.slice('sha256='.length).trim() : signature.trim();
      const matches = (a: string, b: string) => {
        const ba = Buffer.from(a);
        const bb = Buffer.from(b);
        return ba.length === bb.length && timingSafeEqual(ba, bb);
      };
      if (matches(hexd, sig) || matches(b64, sig)) return true;
      this.logger.warn(
        `Late webhook signature non matchée, rejetée — format reçu=${signature.slice(0, 24)} (len=${signature.length}) | ` +
          `attendu_hex_prefix=${hexd.slice(0, 8)} | attendu_b64_prefix=${b64.slice(0, 8)}`,
      );
      return false;
    } catch (e) {
      this.logger.warn(`Late webhook signature check error: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  private async notify(telegramId: string, contenuId: string, reseau: string, event: string, titre: string, message: string): Promise<void> {
    try {
      await this.prisma.notifications.create({
        data: { telegram_id: telegramId, type: 'publication', event, titre, message, contenu_id: contenuId, reseau },
      });
    } catch (e) {
      this.logger.warn(`notif insert error: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Notification in-app + push FCM pour un événement de compte (déconnexion réseau) —
   * port complet de `_notify_account` (backend/services/late_service.py) ; le push FCM
   * manquait dans le premier portage (repéré le 2026-09-29). */
  private async notifyAccount(telegramId: string, platform: string, event: string, titre: string, message: string): Promise<void> {
    try {
      await this.prisma.notifications.create({
        data: { telegram_id: telegramId, type: 'reseau', event, titre, message, reseau: platform },
      });
    } catch (e) {
      this.logger.warn(`notif account insert error: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.pushService.sendToUser(telegramId, titre, message, { event, reseau: platform });
    } catch (e) {
      this.logger.warn(`push account error: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** account.disconnected : vide la connexion `comptes_sociaux` + prévient l'utilisateur de
   * reconnecter. (account.connected et autres : gérés par le flux de connexion de l'app,
   * ignorés ici.) Adapté à `comptes_sociaux` — voir le TODO en tête de fichier. */
  private async handleAccountEvent(event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.logger.log(`Late account event: ${event} | payload keys=${Object.keys(payload)}`);
    if (!event.includes('disconnect')) return { ok: true, ignored: event };

    const accRaw = (payload.account as Record<string, unknown>) || (payload.data as Record<string, unknown>) || {};
    const acc = typeof accRaw === 'object' && accRaw ? accRaw : {};
    const ids = [acc.field_id, acc._id, acc.id, payload.accountId, payload.account_id]
      .filter((i): i is string | number => i !== undefined && i !== null)
      .map(String);
    const platformRaw = (acc.platform as string) || (payload.platform as string) || '';
    const platform = String(platformRaw).toLowerCase().split('.').pop() || '';
    const cols = PLATFORMS.has(platform) ? [platform] : [...PLATFORMS];

    for (const p of cols) {
      for (const aid of ids) {
        const row = await this.prisma.comptes_sociaux.findFirst({
          where: { plateforme: p, late_account_id: aid },
          select: { telegram_id: true },
        });
        if (row) {
          const tg = row.telegram_id;
          await this.prisma.comptes_sociaux.deleteMany({ where: { telegram_id: tg, plateforme: p } });
          await this.notifyAccount(
            tg,
            p,
            event,
            'Réseau déconnecté ⚠️',
            `Ton compte ${capitalize(p)} a été déconnecté. Reconnecte-le dans Paramètres → Réseaux pour continuer à publier.`,
          );
          // Email d'alerte avec lien de reconnexion : la notification in-app ne suffit pas.
          try {
            const u = await this.prisma.users.findUnique({ where: { telegram_id: tg }, select: { email: true, nom: true } });
            if (u?.email) {
              const link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/parametres?s=connections`;
              const html = this.mailService.accountDisconnectedHtml(u.nom, p, link);
              await this.mailService.sendEmail(u.email, `⚠️ Ton compte ${capitalize(p)} est déconnecté, reconnecte-le`, html);
            }
          } catch (e) {
            this.logger.warn(`email compte déconnecté ${tg}/${p}: ${e instanceof Error ? e.message : e}`);
          }
          this.logger.log(`account.disconnected: ${tg} / ${p} -> comptes_sociaux nettoyé`);
          return { ok: true, telegram_id: tg, platform: p, action: 'disconnected' };
        }
      }
    }
    this.logger.log(`account.disconnected: compte introuvable (ids=${JSON.stringify(ids)} platform=${platform})`);
    return { ok: true, ignored: event, reason: 'account_not_found' };
  }

  /** Pousse un contenu PLANIFIÉ vers Zernio (programmé à sa date) et met à jour la ligne.
   * Best-effort : ne lève jamais, retourne {ok, ...} ou {ok:false, skipped?/error?}. */
  async programmerContenu(telegramId: string, contenuId: string, publishNow = false): Promise<ProgrammerResult> {
    try {
      const contenu = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
      if (!contenu) return { ok: false, skipped: 'introuvable' };
      if (contenu.publish_status === 'publié') return { ok: false, skipped: 'déjà publié' };
      if (contenu.late_post_id && (contenu.publish_status === 'programmé' || contenu.publish_status === 'envoi')) {
        return { ok: true, late_post_id: contenu.late_post_id, already: true };
      }
      const isVideo = contenu.type === 'Reel' || contenu.type === 'Video' || contenu.type === 'Short' || Boolean(contenu.video_status);
      if (isVideo && !contenu.video_url) return { ok: false, skipped: 'vidéo non montée' };
      if (!publishNow && !contenu.date_publication) return { ok: false, skipped: 'aucune date de publication definie' };

      const res = await this.publishContenu(telegramId, contenu as ContenuRow, publishNow);
      if (res.ok) {
        await this.prisma.contenu.update({
          where: { id: contenuId },
          data: { late_post_id: res.late_post_id, publish_status: 'envoi', publish_error: null },
        });
        this.logger.log(`Auto-programmation Zernio ok: contenu ${contenuId} -> ${res.late_post_id}`);
      } else {
        await this.prisma.contenu.update({
          where: { id: contenuId },
          data: { publish_status: 'échec', publish_error: res.error },
        });
        this.logger.warn(`Auto-programmation Zernio échec: contenu ${contenuId}: ${res.error}`);
      }
      return res;
    } catch (e) {
      this.logger.error(`programmerContenu ${contenuId}: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Filet de sécurité quand le compte d'un réseau CHANGE (reconnexion avec un autre compte, profil
   * Zernio recréé, première connexion après des posts validés sans réseau) : les posts pas encore
   * publiés de ce réseau sont reprogrammés chez Zernio sur le nouveau compte.
   * - date encore à venir : on GARDE la date ;
   * - date déjà passée (post jamais parti, au plus 30 jours) : prochain créneau libre.
   * L'ancien post Zernio éventuel est supprimé d'abord (sinon double publication si l'ancien compte
   * existe encore). Best-effort. Port de `reprogrammer_reseau` (late_service.py).
   */
  /** Posts pas encore publiés d'un réseau, programmés ou validés (date à venir, ou passée depuis
   * au plus 30 jours) : ceux qu'on PROPOSE de reprogrammer quand le compte du réseau change. */
  async candidatsReprogrammation(telegramId: string, plateforme: string) {
    const reseau = RESEAUX_ENUM[(plateforme || '').toLowerCase()];
    if (!reseau) return [];
    const now = new Date();
    const rows = await this.prisma.contenu.findMany({
      where: {
        telegram_id: telegramId,
        reseau_cible: reseau as never,
        statut: { in: ['Planifie', 'Valider'] as never },
        date_publication: { gte: new Date(now.getTime() - 30 * 86_400_000) },
      },
      select: { id: true, titre: true, late_post_id: true, publish_status: true, date_publication: true, type: true },
      orderBy: { date_publication: 'asc' },
      take: 100,
    });
    return rows
      .filter((c) => c.publish_status !== 'publié' && c.date_publication)
      .map((c) => ({ ...c, type: c.type as string | null, en_retard: (c.date_publication as Date) <= now }));
  }

  async reprogrammerReseau(telegramId: string, plateforme: string, ids?: string[]): Promise<number> {
    const reseau = RESEAUX_ENUM[(plateforme || '').toLowerCase()];
    if (!reseau) return 0;
    let n = 0;
    let rows: Awaited<ReturnType<LateService['candidatsReprogrammation']>>;
    try {
      rows = await this.candidatsReprogrammation(telegramId, plateforme);
    } catch (e) {
      this.logger.error(`reprogrammerReseau lecture ${telegramId}/${reseau}: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
    if (ids) {
      const voulus = new Set(ids);
      rows = rows.filter((c) => voulus.has(c.id));
    }
    for (const c of rows) {
      try {
        if (c.late_post_id) await this.cancelPost(c.late_post_id); // ancienne programmation retirée
        const data: Record<string, unknown> = { late_post_id: null, publish_status: null, publish_error: null };
        if (c.en_retard) {
          const creneau = await this.planningService.prochainCreneau(telegramId, reseau, c.type);
          if (!creneau) continue;
          data.date_publication = new Date(creneau);
        }
        await this.prisma.contenu.update({ where: { id: c.id }, data: data as never });
        const res = await this.programmerContenu(telegramId, c.id);
        if (res.ok) n += 1;
      } catch (e) {
        this.logger.error(`reprogrammerReseau contenu ${c.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (rows.length) this.logger.log(`reprogrammerReseau ${telegramId}/${reseau}: ${n}/${rows.length} post(s) reprogrammé(s)`);
    return n;
  }

  /** Vrai si ce post Zernio est encore programmé (ou en cours) à cette date, à la minute près.
   * Sert à ne pas recréer un post déjà en place : la validation programme déjà le contenu côté
   * serveur, et un second envoi du même texte est refusé par Zernio comme doublon (le contenu
   * passait alors en « échec » alors que le post restait bien programmé). En cas de doute
   * (erreur de lecture, date absente), renvoie false : le comportement d'avant s'applique. */
  async dejaProgrammeA(latePostId: string, date: Date | string | null | undefined): Promise<boolean> {
    if (!date || !this.zernio.isConfigured) return false;
    try {
      const p = await this.zernio.getPost(latePostId);
      const status = (p.post?.status || '').toLowerCase();
      if (!['schedul', 'pending', 'queue', 'publishing'].some((s) => status.includes(s))) return false;
      const prevu = Date.parse(p.post?.scheduledFor || '');
      const voulu = new Date(date).getTime();
      return Number.isFinite(prevu) && Number.isFinite(voulu) && Math.abs(prevu - voulu) < 60_000;
    } catch (e) {
      this.logger.warn(`dejaProgrammeA ${latePostId}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** Supprime un post dans Zernio — annulation d'envoi ou suppression. */
  async cancelPost(latePostId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.zernio.isConfigured) return { ok: false, error: 'Clé Late non configurée' };
    try {
      await this.zernio.deletePost(latePostId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof ZernioError ? e.message : e instanceof Error ? e.message : String(e) };
    }
  }

  /** Passe 3 — PUBLICATIONS DU JOUR : les posts ÉCHOUÉS des dernières 24 h sont relancés via
   * l'endpoint officiel Zernio POST /v1/posts/{id}/retry (publication immédiate). Garde-fous :
   * compte encore actif chez Zernio (sinon inutile, l'email de reconnexion est déjà parti), et
   * espacement de 2 h entre deux tentatives (pas de spam du retry). Au-delà de 24 h, on ne
   * relance plus automatiquement, c'est le bouton « Replanifier » qui prend le relais. */
  private async retryEchecsDuJour(): Promise<number> {
    let n = 0;
    try {
      const now = new Date();
      const rows = await this.prisma.contenu.findMany({
        where: {
          publish_status: 'échec',
          late_post_id: { not: null },
          date_publication: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), lte: now },
        },
        select: { id: true, telegram_id: true, reseau_cible: true, late_post_id: true, updated_at: true },
        take: 10,
      });
      for (const c of rows) {
        // Espacement : pas plus d'une tentative toutes les 2 h par post.
        if (c.updated_at && now.getTime() - c.updated_at.getTime() < 2 * 60 * 60 * 1000) continue;
        // Compte déconnecté -> le retry échouera forcément, on saute.
        const reseau = String(c.reseau_cible || '').toLowerCase();
        try {
          const accs = await this.socialService.listConnectedAccounts(c.telegram_id!);
          if (accs[reseau]?.is_active === false) continue;
        } catch {
          /* best-effort : en cas d'erreur, on tente quand même le retry */
        }
        try {
          await this.zernio.retryPost(c.late_post_id!);
          await this.prisma.contenu.update({
            where: { id: c.id },
            data: { publish_status: 'envoi', publish_error: null, updated_at: now },
          });
          n += 1;
          this.logger.log(`sweep retry: contenu ${c.id} relancé via /posts/retry`);
        } catch (e) {
          await this.prisma.contenu.update({ where: { id: c.id }, data: { updated_at: now } });
          this.logger.warn(`sweep retry ${c.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      this.logger.error(`retryEchecsDuJour: ${e instanceof Error ? e.message : e}`);
    }
    return n;
  }

  /** Filet de sécurité en 3 passes — port direct de backend/services/late_service.py::sweep_planifies :
   * 1) RATTRAPAGE — contenus 'Planifie' à date FUTURE jamais poussés (late_post_id absent) : on
   *    les programme sur Zernio.
   * 2) RÉCONCILIATION — contenus poussés mais restés en publish_status='envoi' (webhook
   *    post.scheduled raté) : on lit l'état réel du post chez Zernio et on aligne la base.
   * 3) PUBLICATIONS DU JOUR — posts échoués des dernières 24 h relancés via /posts/{id}/retry. */
  async sweepPlanifies(): Promise<number> {
    let n = 0;

    // --- Passe 1 : rattrapage des jamais-poussés ---
    try {
      const now = new Date();
      const rows = await this.prisma.contenu.findMany({
        where: { statut: 'Planifie', late_post_id: null, publish_status: null, date_publication: { gt: now } },
        select: { id: true, telegram_id: true },
        take: 20,
      });
      for (const c of rows) {
        const res = await this.programmerContenu(c.telegram_id!, c.id);
        if (res.ok) n += 1;
      }
      if (rows.length) this.logger.log(`sweepPlanifies: ${n}/${rows.length} contenu(s) rattrapé(s) -> Zernio`);
    } catch (e) {
      this.logger.error(`sweepPlanifies (rattrapage): ${e instanceof Error ? e.message : e}`);
    }

    // --- Passe 2 : réconciliation des 'envoi' avec l'état réel Zernio ---
    try {
      const rows2 = await this.prisma.contenu.findMany({
        where: { publish_status: 'envoi', late_post_id: { not: null } },
        select: { id: true, late_post_id: true },
        take: 10,
      });
      for (const c of rows2) {
        try {
          const p = await this.zernio.getPost(c.late_post_id!);
          const status = (p.post?.status || '').toLowerCase();
          let upd: Record<string, unknown> | null = null;
          if (status.includes('publish')) {
            upd = { publish_status: 'publié', statut: 'Publie' };
          } else if (status.includes('schedul') || status.includes('pending') || status.includes('queue')) {
            upd = { publish_status: 'programmé', statut: 'Planifie', publish_error: null };
          } else if (status.includes('fail')) {
            upd = { publish_status: 'échec', publish_error: 'Échec côté Zernio (réconciliation)' };
          } else {
            continue;
          }
          await this.prisma.contenu.update({ where: { id: c.id }, data: upd });
          this.logger.log(`sweep réconciliation: contenu ${c.id} -> ${upd.publish_status}`);
        } catch (e) {
          const msg = (e instanceof ZernioError ? e.message : e instanceof Error ? e.message : String(e)).toLowerCase();
          if (msg.includes('not found') || msg.includes('404')) {
            // Le post n'existe plus côté Zernio -> on libère la ligne pour re-programmation.
            await this.prisma.contenu.update({ where: { id: c.id }, data: { late_post_id: null, publish_status: null } });
            this.logger.warn(`sweep réconciliation: post Zernio disparu, contenu ${c.id} libéré`);
          } else {
            this.logger.warn(`sweep réconciliation ${c.id}: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    } catch (e) {
      this.logger.error(`sweepPlanifies (réconciliation): ${e instanceof Error ? e.message : e}`);
    }

    // --- Passe 3 : publications du jour (retry officiel des échecs < 24 h) ---
    n += await this.retryEchecsDuJour();
    return n;
  }

  /** Traite TOUS les événements Zernio : met à jour le statut du contenu + crée une
   * notification. */
  async handleWebhook(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const event = String(payload.event || payload.type || '').toLowerCase();
    if (event.startsWith('account.')) return this.handleAccountEvent(event, payload);

    const post = (payload.post as Record<string, unknown>) || (payload.data as Record<string, unknown>) || payload;
    const platforms = Array.isArray(post.platforms) ? (post.platforms as Array<Record<string, unknown>>) : [];
    const plat0 = platforms[0] || {};
    const postId = post.id || post._id || payload.postId || post.postId;
    if (!postId) return { ok: false, error: 'no post id' };

    let c: { id: string; telegram_id: string; titre: string | null; reseau_cible: string | null } | null = null;
    const found = await this.prisma.contenu.findFirst({
      where: { late_post_id: String(postId) },
      select: { id: true, telegram_id: true, titre: true, reseau_cible: true },
    });
    if (found && found.telegram_id) {
      c = { id: found.id, telegram_id: found.telegram_id, titre: found.titre, reseau_cible: found.reseau_cible };
    } else {
      // Filet de sécurité : retrouver par le TEXTE du post, puis réattacher l'id.
      const content = String(post.content || '');
      const reseauW = String(plat0.platform || post.platform || '').toLowerCase();
      let cand: Array<{ id: string; telegram_id: string | null; titre: string | null; reseau_cible: string | null; late_post_id: string | null }> = [];
      if (content) {
        const rows = await this.prisma.contenu.findMany({
          where: { contenu: content },
          select: { id: true, telegram_id: true, titre: true, reseau_cible: true, late_post_id: true },
        });
        cand = rows.filter((x) => !x.late_post_id);
        if (reseauW) {
          const filtered = cand.filter((x) => (x.reseau_cible || '').toLowerCase() === reseauW);
          if (filtered.length) cand = filtered;
        }
      }
      if (!cand.length || !cand[0].telegram_id) return { ok: false, error: 'contenu introuvable' };
      const first = cand[0];
      c = { id: first.id, telegram_id: first.telegram_id as string, titre: first.titre, reseau_cible: first.reseau_cible };
      await this.prisma.contenu.update({ where: { id: c.id }, data: { late_post_id: String(postId) } });
      this.logger.log(`Webhook: contenu ${c.id} ré-attaché à late_post_id=${postId} (via texte)`);
    }

    const cid = c.id;
    const tg = c.telegram_id;
    const reseau = c.reseau_cible || '';
    const titreC = (c.titre || 'Ton post').slice(0, 60);

    const platObj = (typeof payload.platform === 'object' && payload.platform) ? (payload.platform as Record<string, unknown>) : {};
    const pubUrl =
      (platObj.publishedUrl as string) ||
      (platObj.url as string) ||
      (platObj.platformPostUrl as string) ||
      (plat0.publishedUrl as string) ||
      (plat0.platformPostUrl as string) ||
      (plat0.url as string) ||
      (post.publishedUrl as string) ||
      (post.platformPostUrl as string) ||
      (post.url as string);

    let upd: Record<string, unknown> = {};
    let notif: [string, string] | null = null;
    if (event.includes('published')) {
      upd = { publish_status: 'publié', statut: 'Publie', publish_error: null };
      if (pubUrl) upd.lien_publication = pubUrl;
      notif = ['Post publié ✅', `« ${titreC} » a été publié sur ${reseau}.`];
    } else if (event.includes('partial')) {
      upd = { publish_status: 'partiel' };
      notif = ['Publication partielle ⚠️', `« ${titreC} » a été publié partiellement sur ${reseau}.`];
    } else if (event.includes('failed')) {
      const reason = plat0.error || post.error || payload.error || 'raison inconnue';
      upd = { publish_status: 'échec', publish_error: String(reason).slice(0, 400) };
      notif = ['Échec de publication ❌', `« ${titreC} » n'a pas pu être publié sur ${reseau} : ${reason}`];
    } else if (event.includes('scheduled')) {
      // SEUL endroit qui pose statut=Planifie : la planification est confirmée PAR Zernio.
      upd = { publish_status: 'programmé', statut: 'Planifie', publish_error: null };
      notif = ['Publication programmée ⏱', `« ${titreC} » est programmé sur ${reseau}.`];
    } else if (event.includes('cancelled')) {
      upd = { publish_status: 'annulé' };
      notif = ['Publication annulée', `La publication de « ${titreC} » sur ${reseau} a été annulée.`];
    } else if (event.includes('recycled')) {
      upd = { publish_status: 'programmé' };
      notif = ['Post recyclé ♻️', `« ${titreC} » a été reprogrammé sur ${reseau}.`];
    } else {
      return { ok: true, ignored: event };
    }

    if (Object.keys(upd).length) {
      await this.prisma.contenu.update({ where: { id: cid }, data: upd as never });
      // Événement système (mémoire d'évaluation H2) : pas d'acteur humain, confirmé par Zernio
      // — port de late_service.py::handle_webhook (log_evenement(cid, "publie")).
      if (upd.statut === 'Publie') await this.contenuEvenement.log(cid, 'publie');
    }
    if (notif) {
      await this.notify(tg, cid, reseau, event, notif[0], notif[1]);
      try {
        await this.pushService.sendToUser(tg, notif[0], notif[1], { contenu_id: cid, event });
      } catch (e) {
        this.logger.warn(`push send error: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { ok: true, contenu_id: cid, event };
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
