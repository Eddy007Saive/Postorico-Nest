import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

/** Étapes du cycle de vie d'un contenu journalisées dans `contenu_evenement`. */
export type TypeEvenement = 'genere' | 'modifie' | 'valide' | 'refuse' | 'publie';

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
}
