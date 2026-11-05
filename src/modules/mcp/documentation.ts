/** Référence du connecteur, générée depuis le code : la page Documentation de Postorico
 * l'affiche telle quelle, donc elle suit chaque ajout d'outil sans rien recopier. */
import { CATEGORIES } from './mcp-outils';
import { PROMPTS } from './mcp-prompts';
import { RESSOURCES } from './mcp-ressources';
import { DELAI_REPONSE_MS, OUTIL_SUIVI } from './taches-mcp';

export function documentationMcp() {
  const outils = CATEGORIES.flatMap((c) =>
    c.outils.map(({ name, title, description, inputSchema, annotations, journal }) => ({
      name, title, description, inputSchema, annotations: annotations ?? {}, journal: !!journal, categorie: c.id,
    })),
  );
  outils.push({ ...OUTIL_SUIVI, annotations: OUTIL_SUIVI.annotations, journal: false, categorie: 'compte' });
  return {
    outils,
    ressources: RESSOURCES.map(({ uri, name, title, description, outil }) => ({ uri, name, title, description, outil })),
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments, texte: p.texte({}) })),
    delai_secondes: DELAI_REPONSE_MS / 1000,
  };
}
