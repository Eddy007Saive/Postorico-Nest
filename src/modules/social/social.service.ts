import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu } from '../../common/utils/contenu-enum.util';
import { NotificationService } from '../notifications/notification.service';
import { QuotaService } from '../quota/quota.service';
import { ZernioClientService } from '../zernio/zernio-client.service';

/** Port de backend/services/social_service.py — comptes connectés (table
 * `comptes_sociaux`, source de vérité depuis la normalisation du 14/08/2026),
 * connexion/déconnexion OAuth et profil Late. `annulerProgrammations`/`disconnectAll`
 * appellent Zernio directement via ZernioClientService (pas LateService : LateModule
 * importe déjà SocialModule, un import réciproque créerait un cycle). */

export const VALID_PLATFORMS = new Set(['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'googlebusiness', 'twitter']);

const FIELD_MAP: Record<string, string> = {
  instagram: 'late_account_instagram',
  facebook: 'late_account_facebook',
  linkedin: 'late_account_linkedin',
  youtube: 'late_account_youtube',
  tiktok: 'late_account_tiktok',
  googlebusiness: 'late_account_googlebusiness',
  twitter: 'late_account_twitter',
};

function normPlatform(p: unknown): string {
  // p peut être "Platform12.FACEBOOK" (valeur d'enum côté Zernio) -> on coerce en "facebook".
  return String(p || '').toLowerCase().split('.').pop() || '';
}

export interface FinalizeConnectionResult {
  ok: boolean;
  account_id?: string;
  error?: string;
  /** Le compte du réseau a changé (ou première connexion) : les posts à venir sont à reprogrammer. */
  compte_change?: boolean;
}

export interface CreateLateProfileResult {
  created: boolean;
  late_profile_id?: string;
  reused?: boolean;
  error?: string;
}

export interface ConnectPlatformResult {
  success: boolean;
  authUrl?: string;
  error?: string;
}

export interface ConnectedAccountInfo {
  username: string | null;
  name: string | null;
  avatar: string | null;
  url: string | null;
  followers: number | null;
  is_active: boolean;
}

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);
  private readonly backendUrl: string;
  private readonly lateApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
    config: ConfigService,
  ) {
    this.backendUrl = config.get<string>('app.backendUrl') || 'http://localhost:3000';
    this.lateApiKey = config.get<string>('app.lateApiKey') || '';
  }

  /** {plateforme: late_account_id} des comptes connectés de ce compte. */
  async comptes(telegramId: string): Promise<Record<string, string>> {
    try {
      const rows = await this.prisma.comptes_sociaux.findMany({
        where: { telegram_id: telegramId },
        select: { plateforme: true, late_account_id: true },
      });
      const out: Record<string, string> = {};
      for (const r of rows) {
        if (r.late_account_id) out[r.plateforme] = r.late_account_id;
      }
      return out;
    } catch (e) {
      this.logger.error(`lecture comptes_sociaux ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return {};
    }
  }

  /** L'identifiant Late d'un réseau, ou undefined s'il n'est pas connecté. */
  async compte(telegramId: string, plateforme: string): Promise<string | undefined> {
    return (await this.comptes(telegramId))[normPlatform(plateforme)];
  }

  /** Connecte un réseau (une ligne par compte, remplacée si elle existe déjà).
   *
   * Portée réduite par rapport au Python : les effets de bord `demarrage_service.oublier`
   * (invalidation d'un cache TTL que ce portage n'a pas — DemarrageService reste sans état)
   * et `impaye_service.marquer_retabli` (domaine explicitement hors périmètre) ne sont pas
   * reproduits ici. */
  async enregistrerCompte(telegramId: string, plateforme: string, accountId: string): Promise<boolean> {
    const p = normPlatform(plateforme);
    if (!VALID_PLATFORMS.has(p) || !accountId) return false;
    try {
      await this.prisma.comptes_sociaux.upsert({
        where: { telegram_id_plateforme: { telegram_id: telegramId, plateforme: p } },
        update: { late_account_id: accountId },
        create: { telegram_id: telegramId, plateforme: p, late_account_id: accountId },
      });
      return true;
    } catch (e) {
      this.logger.error(`enregistrerCompte ${telegramId}/${p}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** Après l'OAuth (Zernio a connecté le compte au profil), enregistre l'accountId dans
   * comptes_sociaux. accountId : fourni par Zernio dans le callback (le plus fiable) ;
   * sinon on interroge l'API Zernio pour retrouver le compte du bon réseau sur ce profil. */
  async finalizeConnection(telegramId: string, platform: string, accountId?: string): Promise<FinalizeConnectionResult> {
    const p = normPlatform(platform);
    if (!VALID_PLATFORMS.has(p)) return { ok: false, error: 'Plateforme inconnue.' };
    const ancien = await this.compte(telegramId, p); // pour savoir si le compte change

    if (accountId) {
      if (await this.enregistrerCompte(telegramId, p, accountId)) {
        this.logger.log(`Compte ${p} connecté pour ${telegramId}: ${accountId} (via callback)`);
        return { ok: true, account_id: accountId, compte_change: ancien !== accountId };
      }
      return { ok: false, error: "Erreur lors de l'enregistrement du compte." };
    }

    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    const profileId = user?.late_profile_id;
    if (!profileId) return { ok: false, error: 'Profil introuvable.' };
    try {
      const res = await this.zernio.listAccounts(profileId);
      const accounts = res.accounts || res.data || [];
      const matches = accounts.filter((a) => normPlatform(a.platform) === p);
      if (!matches.length) {
        this.logger.warn(`finalizeConnection: aucun compte ${p} trouvé pour profil ${profileId}`);
        return { ok: false, error: 'Compte non trouvé après connexion.' };
      }
      const chosen = matches[matches.length - 1]; // le plus récent (modèle 1 compte/réseau)
      const chosenId = chosen.field_id || chosen._id || chosen.id;
      if (!chosenId) return { ok: false, error: 'Compte non trouvé après connexion.' };
      await this.enregistrerCompte(telegramId, p, chosenId);
      this.logger.log(`Compte ${p} connecté pour ${telegramId}: ${chosenId}`);
      return { ok: true, account_id: chosenId, compte_change: ancien !== chosenId };
    } catch (e) {
      this.logger.error(`finalizeConnection error ${telegramId}/${p}: ${e instanceof Error ? e.message : e}`);
      return { ok: false, error: "Erreur lors de l'enregistrement du compte." };
    }
  }

  /** Les clés late_account_<réseau> attendues par le frontend, recomposées depuis
   * comptes_sociaux : la normalisation ne change pas le contrat de l'API. */
  async champsLate(telegramId: string): Promise<Record<string, string | undefined>> {
    const c = await this.comptes(telegramId);
    const out: Record<string, string | undefined> = {};
    for (const [p, champ] of Object.entries(FIELD_MAP)) out[champ] = c[p];
    return out;
  }

  /** Déconnecte un réseau EN BASE (nettoyage `comptes_sociaux`). N'appelle PAS Zernio —
   * voir `disconnectPlatform` pour la déconnexion complète (Zernio + base). Public :
   * réutilisé par ImpayeService (cran 2, séquence de suspension déjà maîtresse de son
   * propre appel Zernio par compte). */
  async supprimerCompte(telegramId: string, plateforme: string): Promise<boolean> {
    const p = normPlatform(plateforme);
    if (!VALID_PLATFORMS.has(p)) return false;
    try {
      await this.prisma.comptes_sociaux.deleteMany({ where: { telegram_id: telegramId, plateforme: p } });
      return true;
    } catch (e) {
      this.logger.error(`supprimerCompte ${telegramId}/${p}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** Fin d'abonnement : les publications déjà programmées ne partiront jamais (les comptes
   * Late vont être supprimés). Sans ça, elles resteraient affichées « Planifié »
   * indéfiniment. Pour chaque contenu programmé ou en cours d'envoi : annulation côté
   * Zernio (best-effort, AVANT la suppression des comptes, sinon l'appel n'a plus de
   * sens), puis en base statut « Validé » + publish_status « échec » avec la raison —
   * c'est exactement l'état que l'interface sait déjà afficher (badge rouge, raison dans
   * le détail, bouton « Réessayer ») : après réabonnement et reconnexion des réseaux, un
   * clic reprogramme. Retourne le nombre de publications annulées. */
  async annulerProgrammations(telegramId: string, raison?: string | null, titreNotif?: string | null): Promise<number> {
    let rows: Array<{ id: string; late_post_id: string | null; titre: string | null; reseau_cible: string | null }>;
    try {
      rows = await this.prisma.contenu.findMany({
        where: {
          telegram_id: telegramId,
          statut: { not: normStatutContenu('Publie') as never },
          OR: [{ statut: normStatutContenu('Planifie') as never }, { publish_status: { in: ['envoi', 'programmé'] } }],
        },
        select: { id: true, late_post_id: true, titre: true, reseau_cible: true },
      });
    } catch (e) {
      this.logger.warn(`annuler_programmations ${telegramId}: lecture impossible: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
    if (!rows.length) return 0;
    for (const c of rows) {
      if (c.late_post_id) {
        try {
          await this.zernio.deletePost(c.late_post_id);
        } catch (e) {
          this.logger.warn(`annuler_programmations: cancel Late ${c.late_post_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    const raisonEff =
      raison ||
      "Abonnement résilié : tes réseaux ont été déconnectés, la publication a été annulée. Reconnecte tes réseaux puis clique « Réessayer » pour la reprogrammer.";
    try {
      await this.prisma.contenu.updateMany({
        where: { id: { in: rows.map((c) => c.id) } },
        data: { statut: normStatutContenu('Valider') as never, publish_status: 'échec', publish_error: raisonEff, late_post_id: null },
      });
    } catch (e) {
      this.logger.error(`annuler_programmations ${telegramId}: update impossible: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
    try {
      const n = rows.length;
      await this.notificationService.notifier(
        telegramId,
        rows[0].id,
        rows[0].reseau_cible,
        'post.cancelled',
        `${n} publication${n > 1 ? 's' : ''} annulée${n > 1 ? 's' : ''}`,
        (titreNotif ? `${titreNotif} : les publications programmées ne partiront pas. ` : 'Ton abonnement est terminé : les publications programmées ne partiront pas. ') +
          'Elles restent dans Contenus, prêtes à être reprogrammées si tu reviens.',
      );
    } catch (e) {
      this.logger.warn(`annuler_programmations notification: ${e instanceof Error ? e.message : e}`);
    }
    this.logger.log(`annuler_programmations : ${rows.length} publication(s) annulée(s) pour ${telegramId}`);
    return rows.length;
  }

  /** Déconnecte TOUS les réseaux du compte (libère les slots Late -> stoppe le coût
   * récurrent). Appelé quand un abonnement se termine définitivement (canceled/unpaid).
   * Retourne le nombre de réseaux déconnectés. */
  async disconnectAll(telegramId: string): Promise<number> {
    // D'abord les publications programmées (elles ne partiront jamais sans réseau), tant
    // que les comptes Late existent encore pour pouvoir les annuler côté Zernio.
    try {
      await this.annulerProgrammations(telegramId);
    } catch (e) {
      this.logger.error(`disconnect_all annuler_programmations ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    let n = 0;
    for (const [plateforme, accountId] of Object.entries(await this.comptes(telegramId))) {
      if (this.lateApiKey) {
        try {
          await this.zernio.deleteAccount(accountId);
        } catch (e) {
          // Late n'a pas pu supprimer (ex. clé d'un AUTRE workspace) -> on GARDE le compte
          // pour rester cohérent avec Late (jamais de faux "déconnecté" en base).
          this.logger.warn(`disconnect_all Late ${telegramId}/${plateforme} (${accountId}) -> compte conservé: ${e instanceof Error ? e.message : e}`);
          continue;
        }
      }
      if (await this.supprimerCompte(telegramId, plateforme)) n += 1;
    }
    if (n) this.logger.log(`disconnect_all : ${n} réseau(x) déconnecté(s) pour ${telegramId} (abonnement terminé)`);
    return n;
  }

  /** Crée le profil Late (Zernio) directement via le SDK et enregistre late_profile_id. */
  async createLateProfile(telegramId: string, nom: string): Promise<CreateLateProfileResult> {
    if (!this.zernio.isConfigured) {
      return { created: false, error: 'Service de publication non configuré (contacte le support).' };
    }
    const name = (nom || '').trim() || `Profil ${telegramId.slice(0, 8)}`;
    const link = async (pid: string, reused: boolean): Promise<CreateLateProfileResult> => {
      await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { late_profile_id: pid } });
      this.logger.log(`Profil Late ${reused ? 'réutilisé' : 'créé'} pour ${telegramId}: ${pid} (${name})`);
      return { created: true, late_profile_id: pid, reused };
    };
    try {
      // 1) Réutiliser un profil existant du même nom (évite doublons + limite de profils).
      try {
        const lst = await this.zernio.listProfiles();
        for (const p of lst.profiles || lst.data || []) {
          const pid = p._id || p.field_id;
          if (pid && (p.name || '').trim().toLowerCase() === name.toLowerCase()) {
            return await link(pid, true);
          }
        }
      } catch (e) {
        this.logger.warn(`createLateProfile: liste profils impossible (${e instanceof Error ? e.message : e}) — on tente la création`);
      }
      // 2) Sinon, créer un nouveau profil.
      const r = await this.zernio.createProfile(name);
      const pid = r.profile?._id || r.profile?.field_id;
      if (!pid) {
        this.logger.error(`createLateProfile: id absent dans la réponse pour ${telegramId}: ${JSON.stringify(r).slice(0, 300)}`);
        return { created: false, error: "Le profil de publication n'a pas pu être créé (réponse invalide)." };
      }
      return await link(pid, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`createLateProfile error pour ${telegramId}: ${msg}`);
      if (msg.toLowerCase().includes('limit')) {
        return {
          created: false,
          error:
            'Limite de profils atteinte sur le compte de publication (le plan gratuit n\'autorise que 2 profils). ' +
            'Libère un profil inutilisé ou passe à un plan supérieur.',
        };
      }
      return { created: false, error: 'Impossible de créer le profil de publication. Réessaie dans un instant.' };
    }
  }

  /**
   * Le profil de publication (Zernio) est créé ICI, à la première connexion d'un réseau — plus à
   * l'inscription : un compte qui ne connecte jamais rien ne consomme pas de profil (le plan Zernio
   * en limite le nombre). Si un identifiant est déjà enregistré, on vérifie qu'il existe encore chez
   * Zernio ; sinon (profil supprimé, autre clé API) on le recrée, au lieu de laisser le client sur
   * « profile not found / access denied ». Port de `_ensure_late_profile` (social_service.py).
   */
  private async ensureLateProfile(telegramId: string): Promise<{ ok: boolean; error?: string }> {
    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true, nom: true } });
    if (!user) return { ok: false, error: 'Compte introuvable.' };
    const pid = user.late_profile_id;
    if (pid) {
      let ids: Set<string>;
      try {
        const lst = await this.zernio.listProfiles();
        ids = new Set((lst.profiles || lst.data || []).map((p) => (p._id || p.field_id) as string));
      } catch (e) {
        // Zernio injoignable : on ne bloque pas, la connexion dira elle-même ce qui ne va pas.
        this.logger.warn(`ensureLateProfile: vérification du profil ${pid} impossible (${e instanceof Error ? e.message : e})`);
        return { ok: true };
      }
      if (ids.has(pid)) return { ok: true };
      this.logger.warn(`connect: profil Late ${pid} introuvable chez Zernio pour ${telegramId} -> recréation`);
      await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { late_profile_id: null } });
    } else {
      this.logger.log(`connect: pas encore de profil Late pour ${telegramId} -> création`);
    }
    const cr = await this.createLateProfile(telegramId, user.nom || '');
    if (cr.created && cr.late_profile_id) return { ok: true };
    return { ok: false, error: cr.error || 'Impossible de créer le profil de publication.' };
  }

  /** Génère l'URL OAuth via le SDK Zernio. Zernio héberge l'OAuth puis redirige vers notre
   * callback backend qui enregistre le compte (voir LateController.oauthCallback). */
  async connectPlatform(telegramId: string, platform: string): Promise<ConnectPlatformResult> {
    // Connexion de réseau : abonnement actif OU essai en cours (quelqu'un en essai a déjà
    // donné sa carte — l'exclure priverait de voir le produit avant le premier prélèvement).
    if (!(await this.quotaService.peutPublier(telegramId))) {
      return {
        success: false,
        error: "Ajoute ta carte pour connecter tes réseaux — 14 jours d'essai, rien n'est prélevé aujourd'hui.",
      };
    }
    // Pendant l'essai : un seul réseau à la fois (borne le coût d'un compte qui ne restera
    // peut-être pas). Posé ici et pas seulement côté UI : un bouton grisé n'empêche pas
    // un appel direct à l'API.
    const limite = await this.quotaService.reseauxAutorises(telegramId);
    if (limite !== null) {
      const deja = Object.keys(await this.comptes(telegramId));
      if (!deja.includes(platform) && deja.length >= limite) {
        return {
          success: false,
          error:
            'Pendant l\'essai, tu peux connecter un réseau à la fois. Les autres se débloquent dès le premier ' +
            "prélèvement — ou déconnecte celui-ci pour en essayer un autre.",
        };
      }
    }

    const ensured = await this.ensureLateProfile(telegramId);
    if (!ensured.ok) return { success: false, error: ensured.error };

    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    const profileId = user?.late_profile_id;
    if (!profileId) return { success: false, error: 'Profil de publication introuvable. Réessaie.' };

    const redirectUrl = `${this.backendUrl}/api/late/oauth-callback?telegram_id=${telegramId}&platform=${platform}`;
    try {
      const r = await this.zernio.getConnectUrl(platform, profileId, redirectUrl);
      const url = r.authUrl || r.url || r.connectUrl;
      if (!url) {
        this.logger.error(`connect: pas d'authUrl dans la réponse pour ${telegramId}/${platform}: ${JSON.stringify(r).slice(0, 300)}`);
        return { success: false, error: 'URL de connexion indisponible. Réessaie.' };
      }
      return { success: true, authUrl: url };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { statusCode?: number })?.statusCode;
      this.logger.error(`connect error ${telegramId}/${platform}: [${status}] ${msg}`);
      if (status === 402 || msg.toLowerCase().includes('payment') || msg.toLowerCase().includes('more than 2')) {
        return {
          success: false,
          error:
            'Limite de comptes connectés atteinte (2 gratuits sur le compte de publication). Ajoute un moyen de ' +
            'paiement sur Late pour en connecter plus.',
        };
      }
      return { success: false, error: msg || 'Impossible de démarrer la connexion. Réessaie.' };
    }
  }

  /** Déconnecte un réseau via le SDK Zernio (supprime le compte côté Late -> libère un
   * slot), puis nettoie la base. Best-effort côté Zernio : on nettoie quand même la base
   * si Zernio échoue (compte déjà supprimé côté plateforme, par exemple). */
  async disconnectPlatform(telegramId: string, platform: string): Promise<{ success: boolean; error?: string }> {
    const p = normPlatform(platform);
    if (!VALID_PLATFORMS.has(p)) return { success: false, error: 'Plateforme inconnue.' };

    const accountId = await this.compte(telegramId, p);
    if (accountId && this.lateApiKey) {
      try {
        await this.zernio.deleteAccount(accountId);
        this.logger.log(`Compte ${p} déconnecté côté Late pour ${telegramId} (${accountId})`);
      } catch (e) {
        this.logger.warn(`disconnect Late ${telegramId}/${p} (${accountId}): ${e instanceof Error ? e.message : e}`);
      }
    }

    if (!(await this.supprimerCompte(telegramId, p))) {
      return { success: false, error: 'Erreur lors de la déconnexion.' };
    }
    return { success: true };
  }

  /** Métadonnées des comptes connectés (via Zernio) : {plateforme: {username, name, avatar,
   * url, followers, is_active}}. is_active=false -> le compte doit être reconnecté. */
  async listConnectedAccounts(telegramId: string): Promise<Record<string, ConnectedAccountInfo>> {
    if (!this.lateApiKey) return {};
    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    const pid = user?.late_profile_id;
    if (!pid) return {};
    const out: Record<string, ConnectedAccountInfo> = {};
    try {
      const r = await this.zernio.listAccounts(pid);
      const accounts = r.accounts || r.data || [];
      for (const a of accounts) {
        // Sécurité : ne garder que les comptes de CE profil.
        const prof = a.profileId;
        if (prof && typeof prof === 'object' && prof.field_id && prof.field_id !== pid) continue;
        const plat = normPlatform(a.platform);
        if (!plat) continue;
        out[plat] = {
          username: a.username ?? null,
          name: a.displayName ?? null,
          avatar: a.profilePicture ?? null,
          url: a.profileUrl ?? null,
          followers: (a as unknown as { followersCount?: number }).followersCount ?? null,
          // Zernio signale l'état de connexion via isActive : false = token expiré/révoqué ->
          // le compte doit être RECONNECTÉ. None/absent = considéré actif (pas de fausse alerte).
          is_active: a.isActive !== false,
        };
      }
    } catch (e) {
      this.logger.warn(`listConnectedAccounts ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    return out;
  }
}
