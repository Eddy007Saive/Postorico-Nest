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

export { ErreurOutil } from './outils/commun';
export type { Appel, Outil } from './outils/commun';

export const OUTILS: Outil[] = [
  ...OUTILS_MARQUE,
  ...OUTILS_IDEES,
  ...OUTILS_GENERATION,
  ...OUTILS_PLANIFICATION,
  ...OUTILS_VALIDATION,
  ...OUTILS_PUBLICATION,
  ...OUTILS_ANALYTICS,
  ...OUTILS_GOOGLE,
  ...OUTILS_COMPTE,
];

/** Deux outils du même nom : erreur dès le démarrage plutôt qu'un outil masqué. */
const noms = new Set<string>();
for (const o of OUTILS) {
  if (noms.has(o.name)) throw new Error(`Outil MCP en double : ${o.name}`);
  noms.add(o.name);
}
