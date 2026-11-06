/** Outils du connecteur MCP, par catégorie (voir outils/). */
import { OUTILS_ANALYTICS } from './outils/analytics';
import { Outil } from './outils/commun';
import { OUTILS_COMPTE } from './outils/compte';
import { OUTILS_GENERATION } from './outils/generation';
import { OUTILS_GOOGLE } from './outils/google';
import { OUTILS_IDEES } from './outils/idees';
import { OUTILS_MARQUE } from './outils/marque';
import { OUTILS_PLANIFICATION } from './outils/planification';
import { OUTILS_PUBLICATION } from './outils/publication';
import { OUTILS_VALIDATION } from './outils/validation';
import { OUTILS_VIDEO } from './outils/video';

export { ErreurOutil } from './outils/commun';
export type { Appel, Outil } from './outils/commun';

/** Catégories dans l'ordre de la documentation. */
export const CATEGORIES: Array<{ id: string; outils: Outil[] }> = [
  { id: 'marque', outils: OUTILS_MARQUE },
  { id: 'idees', outils: OUTILS_IDEES },
  { id: 'generation', outils: OUTILS_GENERATION },
  { id: 'video', outils: OUTILS_VIDEO },
  { id: 'planification', outils: OUTILS_PLANIFICATION },
  { id: 'validation', outils: OUTILS_VALIDATION },
  { id: 'publication', outils: OUTILS_PUBLICATION },
  { id: 'analytics', outils: OUTILS_ANALYTICS },
  { id: 'google', outils: OUTILS_GOOGLE },
  { id: 'compte', outils: OUTILS_COMPTE },
];

export const OUTILS: Outil[] = CATEGORIES.flatMap((c) => c.outils);

/** Deux outils du même nom : erreur dès le démarrage plutôt qu'un outil masqué. */
const noms = new Set<string>();
for (const o of OUTILS) {
  if (noms.has(o.name)) throw new Error(`Outil MCP en double : ${o.name}`);
  noms.add(o.name);
}
