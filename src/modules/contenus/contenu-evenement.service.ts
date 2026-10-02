import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

/** Étapes du cycle de vie d'un contenu journalisées dans `contenu_evenement`. */
export type TypeEvenement = 'genere' | 'regenere' | 'modifie' | 'soumis' | 'valide' | 'refuse' | 'publie';

/** Retouches d'un même acteur regroupées en un seul événement « modifie » (minutes). */
const RETOUCHE_SESSION_MIN = 10;

/**
 * Journal du cycle de vie d'un contenu (mémoire d'évaluation, hypothèse H2 du mémoire) —
 * port de `log_evenement` (backend/services/contenu_service.py). Une ligne par étape :
 * généré, modifié, validé, refusé, publié.
 *
 * Service volontairement isolé dans son propre module (dépend uniquement de Prisma) : il
 * est appelé depuis les contrôleurs de génération, ContenuService ET LateService, et
 * ContenusModule importe déjà LateModule — le mettre dans ContenuService fermerait un cycle.
 *
 * Toujours best-effort : un souci de journalisation ne doit jamais faire échouer l'action
 * réelle qui l'entoure.
 */
@Injectable()
export class ContenuEvenementService {
  private readonly logger = new Logger(ContenuEvenementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(contenuId: string, type: TypeEvenement, acteur?: string | null, texte?: string | null): Promise<void> {
    try {
      await this.prisma.contenu_evenement.create({
        data: { contenu_id: contenuId, type, acteur: acteur ?? null, texte: texte ?? null },
      });
    } catch (e) {
      this.logger.warn(`contenu_evenement ${type} ${contenuId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Retouche d'un brouillon (sauvegarde auto du Studio) : UN événement « modifie » par session.
   * Port de `log_retouche` : si le dernier événement est une retouche du même acteur de moins de
   * RETOUCHE_SESSION_MIN minutes, son texte est mis à jour au lieu d'en créer un nouveau.
   */
  async logRetouche(contenuId: string, acteur: string, texte: string): Promise<void> {
    try {
      const der = await this.prisma.contenu_evenement.findFirst({
        where: { contenu_id: contenuId },
        orderBy: { created_at: 'desc' },
        select: { id: true, type: true, acteur: true, created_at: true },
      });
      if (
        der && der.type === 'modifie' && der.acteur === acteur && der.created_at &&
        Date.now() - der.created_at.getTime() < RETOUCHE_SESSION_MIN * 60_000
      ) {
        await this.prisma.contenu_evenement.update({ where: { id: der.id }, data: { texte } });
        return;
      }
    } catch (e) {
      this.logger.warn(`contenu_evenement retouche ${contenuId}: ${e instanceof Error ? e.message : e}`);
    }
    await this.log(contenuId, 'modifie', acteur, texte);
  }
}
