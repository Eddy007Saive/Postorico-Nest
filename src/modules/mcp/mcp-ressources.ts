/** Ressources MCP : le contexte du client, consultable sans déclencher d'action. Chacune
 * réutilise un outil de lecture (mêmes données, mêmes droits). */
import { OUTILS } from './mcp-outils';
import type { Appel } from './outils/commun';

export interface Ressource {
  uri: string;
  name: string;
  title: string;
  description: string;
  outil: string;
  args?: () => Record<string, unknown>;
}

const moisCourant = () => {
  const d = new Date();
  const debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { du: debut.toISOString().slice(0, 10), au: fin.toISOString().slice(0, 10) };
};

export const RESSOURCES: Ressource[] = [
  { uri: 'brand://profile', name: 'profil_marque', title: 'Profil de marque', description: 'Nom, secteur, audience, piliers de contenu, réseaux connectés.', outil: 'get_brand_profile' },
  { uri: 'brand://guidelines', name: 'charte_editoriale', title: 'Charte éditoriale', description: 'Règles de communication, à éviter, piliers, style des images.', outil: 'get_brand_guidelines' },
  { uri: 'brand://voice', name: 'ton_redactionnel', title: 'Ton rédactionnel', description: "Voix, accroches, appels à l'action, à éviter, exemples de posts par réseau.", outil: 'get_brand_voice' },
  { uri: 'content://pending', name: 'contenus_en_attente', title: 'Contenus en attente', description: 'Contenus « A valider » et brouillons pas encore soumis.', outil: 'get_pending_approvals' },
  { uri: 'content://published', name: 'contenus_publies', title: 'Contenus publiés', description: 'Les 50 dernières publications, avec leur lien.', outil: 'get_publication_history', args: () => ({ limite: 50 }) },
  { uri: 'calendar://current-month', name: 'calendrier_du_mois', title: 'Calendrier du mois', description: 'Contenus datés du mois en cours.', outil: 'get_editorial_calendar', args: moisCourant },
  { uri: 'social://accounts', name: 'comptes_connectes', title: 'Comptes connectés', description: 'Réseaux sociaux connectés à Postorico.', outil: 'get_connected_social_accounts' },
  { uri: 'analytics://overview', name: 'performances', title: 'Vue globale des performances', description: 'Statistiques des 30 derniers jours, comparées à la période précédente.', outil: 'get_social_analytics', args: () => ({ jours: 30 }) },
];

export const listeRessources = () =>
  RESSOURCES.map(({ uri, name, title, description }) => ({ uri, name, title, description, mimeType: 'application/json' }));

/** Contenu d'une ressource, ou null si l'URI est inconnue. */
export async function lireRessource(api: Appel, uri: string): Promise<{ uri: string; mimeType: string; text: string } | null> {
  const r = RESSOURCES.find((x) => x.uri === uri);
  if (!r) return null;
  const outil = OUTILS.find((o) => o.name === r.outil)!;
  // Les ressources sont en lecture : pas d'envoi d'image possible depuis elles
  const sansEnvoi = { lienEnvoiImage: () => { throw new Error('Envoi d’image indisponible depuis une ressource.'); } };
  const donnees = await outil.executer(api, r.args ? r.args() : {}, sansEnvoi);
  return { uri, mimeType: 'application/json', text: JSON.stringify(donnees, null, 1) };
}
