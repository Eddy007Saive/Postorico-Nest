import { AsyncLocalStorage } from 'async_hooks';

/** Qui déclenche un appel IA et pour quelle action, sans le passer à chaque fonction.
 * Posé pour chaque requête HTTP (main.ts), complété par JwtAuthGuard une fois le compte
 * connu ; un appel parti en arrière-plan depuis cette requête en hérite. Hors requête
 * (tâches planifiées), il n'y a pas de contexte : l'appel est noté « tache_fond ». */
export interface ContexteIa {
  telegramId: string | null;
  action: string | null;
}

export const contexteIa = new AsyncLocalStorage<ContexteIa>();

/** Une route lisible et regroupable : les identifiants deviennent « :id ». */
export function routeGenerique(methode: string, chemin: string): string {
  const c = chemin
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${methode.toUpperCase()} ${c}`;
}
