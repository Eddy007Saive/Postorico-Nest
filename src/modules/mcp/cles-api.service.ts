import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../config/prisma.service';

/** Préfixe visible des clés : reconnaissable dans un fichier de configuration. */
export const PREFIXE_CLE = 'pst_';
const MAX_CLES_ACTIVES = 5;

export const hacherCle = (cle: string) => crypto.createHash('sha256').update(cle).digest('hex');

export interface TitulaireCle {
  telegram_id: string;
  email: string | null;
  password_hash: string | null;
}

/** Clés API personnelles du connecteur MCP. La clé n'est montrée qu'une fois, à la création :
 * la base n'en garde que le sha256 et un préfixe pour la reconnaître dans la liste. */
@Injectable()
export class ClesApiService {
  constructor(private readonly prisma: PrismaService) {}

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
    const cle = PREFIXE_CLE + crypto.randomBytes(32).toString('base64url');
    const ligne = await this.prisma.cles_api.create({
      data: { telegram_id: telegramId, nom: propre, prefixe: cle.slice(0, 10), hash: hacherCle(cle) },
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

  /** Titulaire d'une clé valide (non révoquée, compte toujours actif), ou null. */
  async verifier(cle: string): Promise<TitulaireCle | null> {
    if (!cle || !cle.startsWith(PREFIXE_CLE) || cle.length > 100) return null;
    const ligne = await this.prisma.cles_api.findUnique({ where: { hash: hacherCle(cle) } });
    if (!ligne || ligne.revoquee_le) return null;
    const user = await this.prisma.users.findUnique({
      where: { telegram_id: ligne.telegram_id },
      select: { telegram_id: true, email: true, password_hash: true, actif: true },
    });
    if (!user || user.actif === false) return null;
    // Au plus une écriture par minute et par clé
    if (!ligne.derniere_utilisation || Date.now() - ligne.derniere_utilisation.getTime() > 60_000) {
      await this.prisma.cles_api.update({ where: { id: ligne.id }, data: { derniere_utilisation: new Date() } }).catch(() => undefined);
    }
    return { telegram_id: user.telegram_id, email: user.email, password_hash: user.password_hash };
  }
}
