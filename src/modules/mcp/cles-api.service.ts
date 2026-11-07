import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../config/prisma.service';
import { AuthService } from '../auth/auth.service';

/** Préfixe visible des clés : reconnaissable dans un fichier de configuration. */
export const PREFIXE_CLE = 'pst_';
const MAX_CLES_ACTIVES = 5;

export const hacherCle = (cle: string) => crypto.createHash('sha256').update(cle).digest('hex');

export interface FiltreActivite {
  page?: number;
  parPage?: number;
  du?: string;
  au?: string;
  echecs?: boolean;
}

export interface TitulaireCle {
  cle_id: string;
  telegram_id: string;
  email: string | null;
  password_hash: string | null;
}

/** Une clé ne sert plus si le mot de passe a changé depuis sa création (réflexe d'un client
 * qui se croit piraté). La déconnexion, elle, ne touche pas aux clés : ici elle ferme toutes
 * les sessions du compte, et chaque déconnexion du site couperait sinon l'assistant. */
export function cleToujoursValide(cle: { empreinte: string | null }, empreinteActuelle: string): boolean {
  return !cle.empreinte || cle.empreinte === empreinteActuelle;
}

/** Clés API personnelles du connecteur MCP. La clé n'est montrée qu'une fois, à la création :
 * la base n'en garde que le sha256 et un préfixe pour la reconnaître dans la liste. */
@Injectable()
export class ClesApiService {
  private readonly logger = new Logger(ClesApiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async lister(telegramId: string) {
    return this.prisma.cles_api.findMany({
      where: { telegram_id: telegramId, revoquee_le: null },
      orderBy: { created_at: 'desc' },
      select: { id: true, nom: true, prefixe: true, created_at: true, derniere_utilisation: true },
    });
  }

  async creer(telegramId: string, nom: string) {
    const propre = (nom || '').trim().slice(0, 60) || 'Ma clé';
    const actives = await this.prisma.cles_api.count({ where: { telegram_id: telegramId, revoquee_le: null } });
    if (actives >= MAX_CLES_ACTIVES) {
      throw new BadRequestException(`${MAX_CLES_ACTIVES} clés actives au maximum : révoque d'abord une clé inutilisée.`);
    }
    const user = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { password_hash: true } });
    const cle = PREFIXE_CLE + crypto.randomBytes(32).toString('base64url');
    const ligne = await this.prisma.cles_api.create({
      data: {
        telegram_id: telegramId,
        nom: propre,
        prefixe: cle.slice(0, 10),
        hash: hacherCle(cle),
        empreinte: this.auth.empreinteMotDePasse(user?.password_hash ?? null),
      },
      select: { id: true, nom: true, prefixe: true, created_at: true, derniere_utilisation: true },
    });
    return { ...ligne, cle };
  }

  async revoquer(telegramId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const r = await this.prisma.cles_api.updateMany({
      where: { id, telegram_id: telegramId, revoquee_le: null },
      data: { revoquee_le: new Date() },
    });
    return r.count > 0;
  }

  /** Titulaire d'une clé valide (non révoquée, compte actif, mot de passe inchangé depuis
   * sa création), ou null. Une clé devenue invalide est révoquée pour de bon. */
  async verifier(cle: string): Promise<TitulaireCle | null> {
    if (!cle || !cle.startsWith(PREFIXE_CLE) || cle.length > 100) return null;
    const ligne = await this.prisma.cles_api.findUnique({ where: { hash: hacherCle(cle) } });
    if (!ligne || ligne.revoquee_le) return null;
    const user = await this.prisma.users.findUnique({
      where: { telegram_id: ligne.telegram_id },
      select: { telegram_id: true, email: true, password_hash: true, actif: true },
    });
    if (!user || user.actif === false) return null;
    if (!cleToujoursValide(ligne, this.auth.empreinteMotDePasse(user.password_hash))) {
      await this.prisma.cles_api.update({ where: { id: ligne.id }, data: { revoquee_le: new Date() } }).catch(() => undefined);
      this.logger.log(`clé ${ligne.prefixe}… révoquée : mot de passe changé`);
      return null;
    }
    // Au plus une écriture par minute et par clé
    if (!ligne.derniere_utilisation || Date.now() - ligne.derniere_utilisation.getTime() > 60_000) {
      await this.prisma.cles_api.update({ where: { id: ligne.id }, data: { derniere_utilisation: new Date() } }).catch(() => undefined);
    }
    return { cle_id: ligne.id, telegram_id: user.telegram_id, email: user.email, password_hash: user.password_hash };
  }

  /** Titulaire d'une clé encore valable, retrouvée par son id (autorisation d'envoi d'image). */
  async titulaireParId(cleId: string): Promise<TitulaireCle | null> {
    const ligne = await this.prisma.cles_api.findUnique({ where: { id: cleId } }).catch(() => null);
    if (!ligne || ligne.revoquee_le) return null;
    const user = await this.prisma.users.findUnique({
      where: { telegram_id: ligne.telegram_id },
      select: { telegram_id: true, email: true, password_hash: true, actif: true },
    });
    if (!user || user.actif === false) return null;
    if (!cleToujoursValide(ligne, this.auth.empreinteMotDePasse(user.password_hash))) return null;
    return { cle_id: ligne.id, telegram_id: user.telegram_id, email: user.email, password_hash: user.password_hash };
  }

  /** Trace d'une action faite via le connecteur. Ne lève jamais. */
  async journaliser(t: TitulaireCle, outil: string, ok: boolean, details: Record<string, unknown>, erreur?: string): Promise<void> {
    try {
      await this.prisma.journal_mcp.create({
        data: {
          telegram_id: t.telegram_id,
          cle_id: t.cle_id,
          outil: outil.slice(0, 60),
          ok,
          details: details as Prisma.InputJsonValue,
          erreur: erreur ? erreur.slice(0, 300) : null,
        },
      });
    } catch (e) {
      this.logger.warn(`journal MCP : ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Actions faites via le connecteur, les plus récentes d'abord, par page, sur une période
   * facultative (bornes ISO calculées par le navigateur, dans le fuseau du client). */
  async activite(telegramId: string, f: FiltreActivite = {}) {
    const parPage = Math.min(Math.max(Math.floor(f.parPage || 20), 1), 100);
    const page = Math.max(Math.floor(f.page || 1), 1);
    const date = (v?: string) => {
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : undefined;
    };
    const du = date(f.du);
    const au = date(f.au);
    const where = {
      telegram_id: telegramId,
      ...(du || au ? { created_at: { ...(du ? { gte: du } : {}), ...(au ? { lte: au } : {}) } } : {}),
      ...(f.echecs ? { ok: false } : {}),
    };
    const [total, lignes] = await Promise.all([
      this.prisma.journal_mcp.count({ where }),
      this.prisma.journal_mcp.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * parPage,
        take: parPage,
        select: { id: true, created_at: true, cle_id: true, outil: true, ok: true, details: true, erreur: true },
      }),
    ]);
    const ids = [...new Set(lignes.map((l) => l.cle_id).filter((x): x is string => !!x))];
    const cles = ids.length ? await this.prisma.cles_api.findMany({ where: { id: { in: ids } }, select: { id: true, nom: true } }) : [];
    const noms = new Map(cles.map((c) => [c.id, c.nom]));
    return {
      total,
      page,
      par_page: parPage,
      pages: Math.max(Math.ceil(total / parPage), 1),
      actions: lignes.map(({ cle_id, ...l }) => ({ ...l, cle: cle_id ? noms.get(cle_id) ?? null : null })),
    };
  }
}
