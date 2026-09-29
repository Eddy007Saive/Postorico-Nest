import { BadRequestException, HttpException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { QuotaResult } from '../../modules/quota/interfaces/quota-result.interface';

/**
 * Erreurs HTTP partagées par les contrôleurs de génération (sujets, rédaction, plus
 * tard carrousel/script) — port direct de `_refus` et `_map_agent_error`
 * (backend/routes/agent.py).
 */

/** Le refus d'une génération, avec sa RAISON lisible par l'interface : distingue
 * « jamais de carte » de « quota épuisé ». */
export function refusQuota(q: QuotaResult): HttpException {
  return new HttpException(
    { raison: q.reason || 'quota', message: q.message || 'Génération indisponible.' },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/** Convertit une erreur métier de l'agent (`{error: string}`) en exception HTTP. */
export function mapAgentError(error: string): never {
  if (error === 'no_api_key') {
    throw new InternalServerErrorException('Clé API IA non configurée');
  }
  // Même forme d'objet que la garde demarrage_service.exigerProfil (filet de sécurité
  // si la garde en tête de route n'a pas joué) : l'intercepteur front sait la traiter.
  throw new BadRequestException({
    raison: 'profil_incomplet',
    message: 'Complète ton profil de marque (secteur, voix, audience, piliers) avant de générer.',
    manquants: ['secteur'],
  });
}
