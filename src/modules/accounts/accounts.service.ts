import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { ROLES_EQUIPE, RoleEquipe } from '../../common/utils/acces-equipe.util';

/**
 * Comptes liés : un master gère plusieurs sous-comptes (marques) — port direct de
 * backend/routes/accounts.py. master_id sur `users` : un sous-compte pointe vers son
 * master. Bascule : jeton scopé sur le sous-compte (toutes les routes existantes
 * marchent), avec l'identité du master conservée dans le claim `master_id`.
 */

export interface AccountSummary {
  telegram_id: string;
  nom: string | null;
  email: string | null;
  photo_url: string | null;
  logo_url: string | null;
  is_master: boolean;
  is_current: boolean;
  /** Compte d'une autre personne que l'on gère comme membre de son équipe. */
  role_equipe?: RoleEquipe;
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Le master de la « famille » : le compte qui possède les autres. Le jeton ne porte
   * `master_id` qu'après une bascule ; celui obtenu à la connexion ne l'a pas — on relit
   * alors le rattachement en base pour qu'un compte qui EST lui-même une sous-marque
   * retrouve ses marques sœurs plutôt que de se croire seul au monde. */
  async effectiveMaster(payload: JwtPayload): Promise<string> {
    // Membre d'équipe en train de gérer un autre compte : sa famille est celle de la
    // personne connectée (origine), pas celle du compte qu'il regarde.
    if (payload.equipe) return this.effectiveMaster({ ...payload, equipe: undefined, master_id: null, telegram_id: payload.origine });
    if (payload.master_id) return payload.master_id;
    const me = payload.telegram_id;
    try {
      const row = await this.prisma.users.findUnique({ where: { telegram_id: me }, select: { master_id: true } });
      if (row?.master_id) return row.master_id;
    } catch (e) {
      this.logger.warn(`effectiveMaster ${me}: ${e instanceof Error ? e.message : e}`);
    }
    return me;
  }

  /** Liste les comptes de la famille (le master + ses sous-comptes) pour le sélecteur. */
  async listAccounts(payload: JwtPayload): Promise<{ master_id: string; accounts: AccountSummary[] }> {
    const master = await this.effectiveMaster(payload);
    let rows: Array<{ telegram_id: string; nom: string | null; email: string | null; photo_url: string | null; master_id: string | null }>;
    try {
      rows = await this.prisma.users.findMany({
        where: { OR: [{ telegram_id: master }, { master_id: master }] },
        select: { telegram_id: true, nom: true, email: true, photo_url: true, master_id: true },
      });
    } catch (e) {
      this.logger.error(`list_accounts error: ${e instanceof Error ? e.message : e}`);
      rows = [];
    }

    // Le logo appartient à la fiche de marque depuis la normalisation : une seule requête
    // pour toute la famille (pas d'appel par compte).
    const logos = new Map<string, string | null>();
    if (rows.length) {
      try {
        const lm = await this.prisma.marques.findMany({
          where: { telegram_id: { in: rows.map((r) => r.telegram_id) } },
          select: { telegram_id: true, logo_url: true },
        });
        for (const m of lm) logos.set(m.telegram_id, m.logo_url);
      } catch (e) {
        this.logger.warn(`list_accounts logos: ${e instanceof Error ? e.message : e}`);
      }
    }

    const accounts: AccountSummary[] = rows.map((r) => ({
      telegram_id: r.telegram_id,
      nom: r.nom,
      email: r.email,
      photo_url: r.photo_url,
      logo_url: logos.get(r.telegram_id) ?? null,
      is_master: r.telegram_id === master,
      is_current: r.telegram_id === payload.telegram_id,
    }));
    // Master en premier.
    accounts.sort((a, b) => {
      if (a.is_master !== b.is_master) return a.is_master ? -1 : 1;
      return (a.nom || '').toLowerCase().localeCompare((b.nom || '').toLowerCase());
    });
    // Puis les comptes d'autres personnes dont on fait partie de l'équipe.
    for (const e of await this.comptesEquipe(payload.origine || payload.telegram_id)) {
      if (accounts.some((a) => a.telegram_id === e.telegram_id)) continue;
      accounts.push({ ...e, is_master: false, is_current: e.telegram_id === payload.telegram_id });
    }
    return { master_id: master, accounts };
  }

  /** Comptes que `personne` gère comme membre d'équipe (invitation acceptée). */
  async comptesEquipe(personne: string): Promise<Array<Omit<AccountSummary, 'is_master' | 'is_current'> & { role_equipe: RoleEquipe }>> {
    try {
      const liens = await this.prisma.membres_equipe.findMany({ where: { membre_id: personne, statut: 'actif' }, select: { compte_id: true, role: true } });
      if (!liens.length) return [];
      const ids = liens.map((l) => l.compte_id);
      const [users, marques] = await Promise.all([
        this.prisma.users.findMany({ where: { telegram_id: { in: ids } }, select: { telegram_id: true, nom: true, email: true, photo_url: true } }),
        this.prisma.marques.findMany({ where: { telegram_id: { in: ids } }, select: { telegram_id: true, logo_url: true } }),
      ]);
      const logo = new Map(marques.map((m) => [m.telegram_id, m.logo_url]));
      return users.map((u) => {
        const role = liens.find((l) => l.compte_id === u.telegram_id)!.role;
        return { ...u, logo_url: logo.get(u.telegram_id) ?? null, role_equipe: ((ROLES_EQUIPE as string[]).includes(role) ? role : 'editeur') as RoleEquipe };
      });
    } catch (e) {
      this.logger.warn(`comptesEquipe ${personne}: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Autorisé, cible, et si c'est un sous-compte — pour la bascule et la suppression. */
  async resoudreCible(
    payload: JwtPayload,
    target: string,
  ): Promise<{
    master: string;
    row: { telegram_id: string; email: string | null; master_id: string | null; nom: string | null; is_admin: boolean; password_hash: string | null };
  }> {
    const master = await this.effectiveMaster(payload);
    const row = await this.prisma.users.findUnique({
      where: { telegram_id: target },
      select: { telegram_id: true, email: true, master_id: true, nom: true, is_admin: true, password_hash: true },
    });
    if (!row) throw new NotFoundException('Compte introuvable');
    if (!(target === master || row.master_id === master)) {
      throw new ForbiddenException('Accès non autorisé à ce compte');
    }
    return { master, row };
  }

  /** Supprime un sous-compte possédé par le master (jamais le master lui-même). */
  async verifierSuppressible(payload: JwtPayload, telegramId: string): Promise<void> {
    const master = await this.effectiveMaster(payload);
    if (telegramId === master) throw new BadRequestException('Impossible de supprimer le compte principal');
    const row = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { master_id: true } });
    if (!row || row.master_id !== master) throw new ForbiddenException('Accès non autorisé à ce compte');
  }
}
