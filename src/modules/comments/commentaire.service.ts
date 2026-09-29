import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { labelStatutCommentaire, normStatutCommentaire } from '../../common/utils/commentaire-enum.util';

/** Port direct de backend/services/commentaire_service.py. */
@Injectable()
export class CommentaireService {
  constructor(private readonly prisma: PrismaService) {}

  /** Commentaires du compte, enrichis du titre + réseau du contenu associé. */
  async getCommentaires(telegramId: string, statut?: string | null): Promise<Record<string, unknown>[]> {
    const comments = await this.prisma.commentaires.findMany({
      where: { telegram_id: telegramId, ...(statut ? { statut: normStatutCommentaire(statut) as never } : {}) },
      orderBy: { created_at: 'desc' },
    });
    const ids = [...new Set(comments.map((c) => c.contenu_id).filter((id): id is string => Boolean(id)))];
    const infos = new Map<string, { titre: string | null; reseau_cible: string | null }>();
    if (ids.length) {
      const rows = await this.prisma.contenu.findMany({ where: { id: { in: ids } }, select: { id: true, titre: true, reseau_cible: true } });
      for (const row of rows) infos.set(row.id, { titre: row.titre, reseau_cible: row.reseau_cible });
    }
    return comments.map((c) => {
      const info = c.contenu_id ? infos.get(c.contenu_id) : undefined;
      return {
        ...c,
        statut: labelStatutCommentaire(c.statut as string | null),
        contenu_titre: info?.titre ?? null,
        contenu_reseau: info?.reseau_cible ?? null,
      };
    });
  }

  async updateCommentaire(commentaireId: string, telegramId: string, updateData: { statut?: string; reponse_ia?: string }): Promise<Record<string, unknown> | null> {
    const data: Record<string, unknown> = { ...updateData };
    if (data.statut) data.statut = normStatutCommentaire(data.statut as string);
    const res = await this.prisma.commentaires.updateMany({ where: { id: commentaireId, telegram_id: telegramId }, data: data as never });
    if (!res.count) return null;
    const row = await this.prisma.commentaires.findUnique({ where: { id: commentaireId } });
    if (!row) return null;
    return { ...row, statut: labelStatutCommentaire(row.statut as string | null) };
  }
}
