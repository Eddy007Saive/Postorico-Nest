import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { AuthService } from '../auth/auth.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { MarqueService } from '../marque/marque.service';
import { SocialService } from '../social/social.service';

/**
 * Compte utilisateur (profil, médias, inspirations, RGPD) — port direct de
 * backend/services/user_service.py.
 */

// Rôle d'une image de référence à la génération : style (défaut), integrate (contenu à
// reproduire littéralement, ex. la mascotte), ecran (capture d'écran réelle à afficher DANS
// l'écran du mockup au lieu d'une interface inventée).
export const ROLES_REFERENCE = ['style', 'integrate', 'ecran'] as const;
export type RoleReference = (typeof ROLES_REFERENCE)[number];

// Clés que `getUser` RECOMPOSE à la lecture depuis d'autres tables : elles n'existent plus
// comme colonnes de `users`. Le frontend renvoyant l'objet utilisateur entier à
// l'enregistrement, elles reviendraient en écriture et feraient échouer toute la sauvegarde.
const DERIVEES = new Set([
  'is_subaccount',
  ...['instagram', 'facebook', 'linkedin', 'youtube', 'tiktok', 'googlebusiness', 'twitter'].map((p) => `late_account_${p}`),
]);

// Tables « enfants » à EFFACER quand un compte est supprimé (données personnelles, de
// marque et de contenu — aucune obligation de conservation). Clé : telegram_id.
const PURGE_DELETE_TABLES = [
  'analytics_cache',
  'analytics_performance',
  'affiliate_referrals',
  'brand_assets',
  'brand_musiques',
  'brand_templates',
  'brouillons',
  'commentaires',
  'comptes_sociaux',
  'contenu',
  'device_tokens',
  'heygen_avatars',
  'marques',
  'notifications',
  'offers',
  'publication_schedules',
  'studio',
  'studio_drafts',
  'usage_log',
] as const;

export class RoleInvalideError extends Error {}
export class ImageInvalideError extends Error {}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly marqueService: MarqueService,
    private readonly socialService: SocialService,
    private readonly demarrageService: DemarrageService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  // ---------------------------------------------------------------------------
  // Médias (photo de profil, avatar, logo)
  // ---------------------------------------------------------------------------
  /** Extrait le public_id (avec dossier, sans extension/version) d'une URL Cloudinary. */
  private publicIdFromUrl(url: string | null | undefined): string | null {
    if (!url || !url.includes('cloudinary.com') || !url.includes('/upload/')) return null;
    const after = url.split('/upload/', 2)[1];
    let parts = after.split('/');
    if (parts.length && /^v\d+$/.test(parts[0])) parts = parts.slice(1); // enlève le préfixe de version vNNNN
    const path = parts.join('/').replace(/\.[^./]+$/, '');
    return path || null;
  }

  /** Supprime l'ancien asset Cloudinary (sauf si c'est le même public_id qu'on vient d'écrire). */
  private async deleteOldPhoto(oldUrl: string | null | undefined, keepPublicId: string): Promise<void> {
    const pid = this.publicIdFromUrl(oldUrl);
    if (!pid || pid === keepPublicId) return; // rien à supprimer, ou déjà écrasé par l'upload (overwrite)
    try {
      await cloudinary.uploader.destroy(pid, { resource_type: 'image', invalidate: true });
      this.logger.log(`Ancienne photo Cloudinary supprimée: ${pid}`);
    } catch (e) {
      this.logger.warn(`Échec suppression ancienne photo Cloudinary (${pid}): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Upload la photo de profil sur Cloudinary et met à jour users.photo_url. Remplace
   * l'ancienne photo : même public_id + overwrite (pas d'accumulation). */
  async uploadPhoto(telegramId: string, fileBytes: Buffer, mimetype: string): Promise<string> {
    const prev = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { photo_url: true } });
    const publicId = `avatars/${telegramId}/profil`;
    const up = await cloudinary.uploader.upload(this.dataUri(fileBytes, mimetype), {
      resource_type: 'image',
      public_id: publicId,
      overwrite: true,
      invalidate: true, // purge le cache CDN pour voir la nouvelle image tout de suite
    });
    await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { photo_url: up.secure_url } });
    await this.deleteOldPhoto(prev?.photo_url, publicId);
    return up.secure_url;
  }

  /** Upload le logo de marque sur Cloudinary et met à jour marques.logo_url. */
  async uploadLogo(telegramId: string, fileBytes: Buffer, mimetype: string): Promise<string> {
    const oldUrl = (await this.marqueService.fiche(telegramId)).logo_url as string | undefined;
    const publicId = `logos/${telegramId}/logo`;
    const up = await cloudinary.uploader.upload(this.dataUri(fileBytes, mimetype), {
      resource_type: 'image',
      public_id: publicId,
      overwrite: true,
      invalidate: true,
    });
    await this.marqueService.enregistrer(telegramId, { logo_url: up.secure_url });
    await this.deleteOldPhoto(oldUrl, publicId);
    return up.secure_url;
  }

  /** Upload l'avatar (photo de profil) sur Cloudinary et met à jour users.avatar_url. */
  async uploadAvatar(telegramId: string, fileBytes: Buffer, mimetype: string): Promise<string> {
    const prev = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { avatar_url: true } });
    const publicId = `avatars/${telegramId}/avatar`;
    const up = await cloudinary.uploader.upload(this.dataUri(fileBytes, mimetype), {
      resource_type: 'image',
      public_id: publicId,
      overwrite: true,
      invalidate: true,
    });
    await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { avatar_url: up.secure_url } });
    await this.deleteOldPhoto(prev?.avatar_url, publicId);
    return up.secure_url;
  }

  /** Supprime le logo (Cloudinary + marques.logo_url). */
  async deleteLogo(telegramId: string): Promise<void> {
    const oldUrl = (await this.marqueService.fiche(telegramId)).logo_url as string | undefined;
    await this.marqueService.enregistrer(telegramId, { logo_url: null });
    await this.deleteOldPhoto(oldUrl, '');
  }

  private dataUri(fileBytes: Buffer, mimetype: string): string {
    return `data:${mimetype};base64,${fileBytes.toString('base64')}`;
  }

  // ---------------------------------------------------------------------------
  // Inspirations visuelles (Cloudinary : inspirations/{telegram_id}/)
  // ---------------------------------------------------------------------------
  async listInspirations(telegramId: string): Promise<string[]> {
    try {
      const res = await cloudinary.api.resources({ type: 'upload', prefix: `inspirations/${telegramId}/`, max_results: 30 });
      return ((res.resources ?? []) as Array<{ secure_url?: string }>).map((r) => r.secure_url).filter((u): u is string => Boolean(u));
    } catch (e) {
      this.logger.warn(`list_inspirations error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** URLs des inspirations dont le context Cloudinary porte `cle=1`. Le marqueur vit sur
   * l'asset, pas dans Supabase — pas de table dédiée pour un simple drapeau. */
  private async flags(telegramId: string, cle: string): Promise<string[]> {
    try {
      const res = await cloudinary.api.resources({ type: 'upload', prefix: `inspirations/${telegramId}/`, max_results: 30, context: true });
      const resources = (res.resources ?? []) as Array<{ secure_url?: string; context?: { custom?: Record<string, string> } }>;
      return resources.filter((r) => r.secure_url && r.context?.custom?.[cle] === '1').map((r) => r.secure_url as string);
    } catch (e) {
      this.logger.warn(`flags ${cle} error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Inspirations « à toujours intégrer littéralement » (ex. la mascotte). */
  listIntegrateFlags(telegramId: string): Promise<string[]> {
    return this.flags(telegramId, 'integrate');
  }

  /** Inspirations « écran à reproduire » (captures d'écran réelles). */
  listEcranFlags(telegramId: string): Promise<string[]> {
    return this.flags(telegramId, 'ecran');
  }

  /** Donne un rôle (exclusif) à une inspiration. Vérifie que l'asset appartient au compte. */
  async setRole(telegramId: string, url: string, role: string): Promise<void> {
    if (!ROLES_REFERENCE.includes(role as RoleReference)) throw new RoleInvalideError('rôle invalide');
    const pid = this.publicIdFromUrl(url);
    if (!pid || !pid.startsWith(`inspirations/${telegramId}/`)) throw new ImageInvalideError('image invalide');
    await cloudinary.api.update(pid, {
      resource_type: 'image',
      context: `integrate=${role === 'integrate' ? 1 : 0}|ecran=${role === 'ecran' ? 1 : 0}`,
    });
  }

  /** Compat : marque (ou démarque) une inspiration comme « à toujours intégrer ». */
  setIntegration(telegramId: string, url: string, integrate: boolean): Promise<void> {
    return this.setRole(telegramId, url, integrate ? 'integrate' : 'style');
  }

  async addInspiration(telegramId: string, fileBytes: Buffer, mimetype: string): Promise<string[]> {
    await cloudinary.uploader.upload(this.dataUri(fileBytes, mimetype), { resource_type: 'image', folder: `inspirations/${telegramId}` });
    return this.listInspirations(telegramId);
  }

  async removeInspiration(telegramId: string, url: string): Promise<string[]> {
    const pid = this.publicIdFromUrl(url);
    if (pid) {
      try {
        await cloudinary.uploader.destroy(pid, { resource_type: 'image', invalidate: true });
      } catch (e) {
        this.logger.warn(`remove_inspiration destroy error (${pid}): ${e instanceof Error ? e.message : e}`);
      }
    }
    return this.listInspirations(telegramId);
  }

  // ---------------------------------------------------------------------------
  // Profil (compte + marque fusionnés)
  // ---------------------------------------------------------------------------
  /** Le compte, avec la marque fusionnée et les clés dérivées recomposées (late_account_*,
   * is_subaccount) — exactement le contrat attendu par le frontend. */
  async getUser(telegramId: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId } });
    if (!row) return null;
    const user: Record<string, unknown> = this.authService.sanitizeUser(row);
    // Les comptes sociaux vivent dans `comptes_sociaux` depuis la normalisation, mais le
    // frontend lit toujours user.late_account_<réseau> : on recompose ces clés ici.
    Object.assign(user, await this.socialService.champsLate(telegramId));
    // Idem pour la fiche de marque : le frontend continue de lire user.voix_marque,
    // user.couleur_accent, etc.
    Object.assign(user, await this.marqueService.fiche(telegramId));
    // Facturation PAR COMPTE : on expose seulement le flag sous-compte (pour l'UI), sans
    // écraser crédits/plan.
    if (row.master_id) user.is_subaccount = true;
    return user;
  }

  /** La page Paramètres envoie compte et marque dans la même requête : chaque champ part
   * dans sa table, `users` ne reçoit plus que ce qui décrit le compte. */
  async updateUser(telegramId: string, updateData: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updateData || {})) {
      if (!DERIVEES.has(k)) filtered[k] = v;
    }
    const [champsCompte, champsMarque] = this.marqueService.separer(filtered);
    if (Object.keys(champsMarque).length) {
      await this.marqueService.enregistrer(telegramId, champsMarque);
      this.demarrageService.oublier(telegramId); // APRÈS l'écriture, sinon un GET concurrent remet l'ancien état en cache
    }
    if (!Object.keys(champsCompte).length) {
      return this.getUser(telegramId); // mise à jour purement marque
    }

    let updated;
    try {
      updated = await this.prisma.users.update({ where: { telegram_id: telegramId }, data: champsCompte as never });
    } catch (e) {
      this.logger.error(`update_user ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    if (!updated) return null;
    const user: Record<string, unknown> = this.authService.sanitizeUser(updated);
    this.demarrageService.oublier(telegramId);
    Object.assign(user, await this.marqueService.fiche(telegramId)); // la réponse reflète la marque enregistrée
    return user;
  }

  // ---------------------------------------------------------------------------
  // Suppression / RGPD
  // ---------------------------------------------------------------------------
  /** Efface toutes les données rattachées à un utilisateur, SAUF la ligne `users` (l'appelant
   * la supprime après). Deux régimes : effacement pur (perso/marque/contenu) et
   * anonymisation des pièces à valeur comptable (abonnements, commissions, résiliations). */
  async purgeUserData(telegramId: string): Promise<void> {
    for (const t of PURGE_DELETE_TABLES) {
      try {
        await (this.prisma[t] as { deleteMany: (args: unknown) => Promise<unknown> }).deleteMany({ where: { telegram_id: telegramId } });
      } catch (e) {
        this.logger.warn(`purge_user_data: delete ${t} échoué (${telegramId}): ${e instanceof Error ? e.message : e}`);
      }
    }

    try {
      await this.prisma.affiliate_commissions.updateMany({ where: { telegram_id: telegramId }, data: { telegram_id: null, filleul_email: null } });
    } catch (e) {
      this.logger.warn(`purge_user_data: anonymisation affiliate_commissions échouée (${telegramId}): ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.prisma.resiliations.updateMany({ where: { telegram_id: telegramId }, data: { commentaire: null, detail: null } });
    } catch (e) {
      this.logger.warn(`purge_user_data: anonymisation resiliations échouée (${telegramId}): ${e instanceof Error ? e.message : e}`);
    }
    try {
      await this.prisma.affiliates.updateMany({
        where: { telegram_id: telegramId },
        data: { telegram_id: null, nom: 'anonymisé', email: '', iban_chiffre: null },
      });
    } catch (e) {
      this.logger.warn(`purge_user_data: anonymisation affiliates échouée (${telegramId}): ${e instanceof Error ? e.message : e}`);
    }
    // `subscriptions` (clé user_id) : conservée telle quelle — aucune PII directe, requise
    // pour la compta.
  }

  /** Purge les données rattachées puis supprime la ligne `users`. */
  async deleteUser(telegramId: string): Promise<boolean> {
    await this.purgeUserData(telegramId);
    try {
      await this.prisma.users.delete({ where: { telegram_id: telegramId } });
      return true;
    } catch {
      return false;
    }
  }
}
