import { ConsoleLogger, LogLevel } from '@nestjs/common';

/** Contextes internes de NestJS qui ne parlent qu'au démarrage, une ligne par route ou par
 * module (~330 lignes dans la même seconde avec nos 240 routes). Railway plafonne le débit
 * de logs par service et jette l'excédent (« rate limit reached … Messages dropped ») : on
 * garde nos propres logs (bilans de crons, erreurs) et on tait seulement ce bavardage. */
const CONTEXTES_TUS = new Set(['RouterExplorer', 'RoutesResolver', 'InstanceLoader']);

export class LoggerSilencieux extends ConsoleLogger {
  log(message: unknown, ...optionalParams: unknown[]): void {
    if (this.estTu(optionalParams)) return;
    super.log(message, ...optionalParams);
  }

  // Les contextes tus ne loguent qu'en niveau `log` ; on ne filtre pas error/warn pour
  // ne jamais masquer un vrai problème de démarrage.
  private estTu(optionalParams: unknown[]): boolean {
    const contexte = optionalParams[optionalParams.length - 1];
    return typeof contexte === 'string' && CONTEXTES_TUS.has(contexte);
  }
}

/** Niveaux actifs : tout en dev, pas de `debug`/`verbose` en production. */
export function niveauxLog(): LogLevel[] {
  return process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'];
}
