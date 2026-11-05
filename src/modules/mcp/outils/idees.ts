import { Appel, Contenu, enc, entier, ErreurOutil, exiger, LECTURE, Outil, RESEAUX, reseauValide, texte } from './commun';

/** 02. Idées et sujets : la réserve de sujets du Studio IA (table brouillons). */

type Sujet = { id: string; titre: string | null; dimensions: unknown; created_at?: string };
const vue = (s: Sujet) => ({ id: s.id, sujet: s.titre, reglages: s.dimensions ?? null, ...(s.created_at ? { cree_le: s.created_at } : {}) });
const REGLAGES = {
  type: 'object',
  description: "Réglages facultatifs : objectif, angle, cible, format, offre. Valeurs possibles : voir get_content_ideas (valeurs_possibles). Une valeur inconnue est ignorée.",
  properties: { objectif: { type: 'string' }, angle: { type: 'string' }, cible: { type: 'string' }, format: { type: 'string' }, offre: { type: 'string' } },
};

const sujets = async (api: Appel) => (await api('GET', '/agent/sujets')) as Sujet[];
async function trouverSujet(api: Appel, id: string): Promise<Sujet> {
  const s = (await sujets(api)).find((x) => x.id === id);
  if (!s) throw new ErreurOutil('Idée introuvable : vérifie son id avec get_content_ideas.');
  return s;
}

/** Rédige un post à partir d'un sujet (ou d'un texte libre) : utilisé par generate_social_post et approve_content_idea. */
export async function redigerDepuis(api: Appel, args: Record<string, unknown>) {
  const reseau = reseauValide(args.reseau ?? args.platform, RESEAUX, 'linkedin');
  let sujet = texte(args.sujet);
  let dimensions: unknown;
  const ideeId = texte(args.idea_id);
  if (ideeId) {
    const s = await trouverSujet(api, ideeId);
    sujet = sujet || s.titre || '';
    if (s.dimensions && typeof s.dimensions === 'object') dimensions = s.dimensions;
  }
  if (!sujet) throw new ErreurOutil('Donne un sujet, ou un idea_id.');
  const r = (await api('POST', '/agent/rediger', { sujet, reseau, brouillon: true, ...(dimensions ? { dimensions } : {}) })) as Contenu;
  return { contenu_id: r.contenu_id as string, reseau, statut: 'Brouillon', texte: r.contenu, quota: r.quota };
}

export const OUTILS_IDEES: Outil[] = [
  {
    name: 'generate_content_ideas',
    title: 'Trouver des idées de sujets',
    description:
      "Génère de nouvelles idées de sujets adaptées à la marque et les ajoute à la réserve d'idées du client. Consomme 1 génération de sujets du quota mensuel, quel que soit le nombre d'idées.",
    inputSchema: { type: 'object', properties: { nombre: { type: 'integer', minimum: 1, maximum: 20, description: "Nombre d'idées (6 par défaut)." } } },
    journal: true,
    executer: async (api, args) => {
      const r = (await api('POST', '/agent/sujets', { nombre: entier(args.nombre, 6, 1, 20) })) as { sujets: Sujet[]; quota: unknown };
      return { idees: r.sujets.map(vue), quota: r.quota };
    },
  },
  {
    name: 'get_content_ideas',
    title: "Réserve d'idées",
    description: "Liste les idées de sujets en réserve (générées ou ajoutées), avec leurs réglages, et les valeurs de réglage possibles.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const [liste, valeurs] = await Promise.all([sujets(api), api('GET', '/agent/dimensions').catch(() => null)]);
      return { total: liste.length, idees: liste.map(vue), valeurs_possibles: valeurs };
    },
  },
  {
    name: 'create_content_idea',
    title: 'Ajouter une idée',
    description: "Ajoute une ou plusieurs idées du client à sa réserve, telles quelles (sans IA, sans quota).",
    inputSchema: {
      type: 'object',
      properties: {
        idees: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: { sujet: { type: 'string', description: "L'idée, en une phrase." }, objectif: { type: 'string' }, angle: { type: 'string' }, format: { type: 'string' }, pilier: { type: 'string' } },
            required: ['sujet'],
          },
        },
      },
      required: ['idees'],
    },
    journal: true,
    executer: async (api, args) => {
      const idees = (Array.isArray(args.idees) ? args.idees : [])
        .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
        .filter((x) => texte(x.sujet))
        .slice(0, 40)
        .map((x) => ({
          sujet: texte(x.sujet).slice(0, 200),
          ...Object.fromEntries(['objectif', 'angle', 'format', 'pilier'].filter((k) => texte(x[k])).map((k) => [k, texte(x[k])])),
        }));
      if (!idees.length) throw new ErreurOutil('Donne au moins une idée (champ sujet).');
      const r = (await api('POST', '/agent/sujets/ajouter', { sujets: idees })) as { sujets: Sujet[] };
      return { ajoutees: r.sujets.map(vue) };
    },
  },
  {
    name: 'update_content_idea',
    title: 'Modifier une idée',
    description: "Modifie le texte d'une idée et/ou ses réglages (objectif, angle, cible, format, offre).",
    inputSchema: {
      type: 'object',
      properties: { idea_id: { type: 'string' }, sujet: { type: 'string', description: "Nouveau texte de l'idée." }, reglages: REGLAGES },
      required: ['idea_id'],
    },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'idea_id');
      const cur = await trouverSujet(api, id);
      const nouveau = texte(args.sujet);
      const reglages = args.reglages && typeof args.reglages === 'object' ? (args.reglages as Record<string, unknown>) : null;
      if (!nouveau && !reglages) throw new ErreurOutil('Rien à modifier : donne sujet et/ou reglages.');
      // Les réglages sont réécrits en entier : on part des actuels
      const base = cur.dimensions && typeof cur.dimensions === 'object' ? (cur.dimensions as Record<string, unknown>) : {};
      const r = (await api('PATCH', `/agent/sujets/${enc(id)}`, {
        ...(nouveau ? { titre: nouveau } : {}),
        dimensions: reglages ? { ...base, ...reglages } : base,
      })) as { dimensions: unknown; titre?: string };
      return { id, sujet: r.titre ?? cur.titre, reglages: r.dimensions };
    },
  },
  {
    name: 'approve_content_idea',
    title: 'Retenir une idée (en faire un post)',
    description:
      "Retient une idée de la réserve : Postorico en rédige le post dans la voix de la marque (brouillon à relire), puis retire l'idée de la réserve, comme dans le Studio IA. Consomme 1 post du quota.",
    inputSchema: {
      type: 'object',
      properties: { idea_id: { type: 'string' }, reseau: { type: 'string', enum: RESEAUX, description: 'Réseau du post (linkedin par défaut).' } },
      required: ['idea_id'],
    },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'idea_id');
      const post = await redigerDepuis(api, { idea_id: id, reseau: args.reseau });
      await api('DELETE', `/agent/sujets/${enc(id)}`).catch(() => undefined);
      return { ...post, note: "Post rédigé en brouillon, l'idée a quitté la réserve. À relire avant approve_content." };
    },
  },
  {
    name: 'delete_content_idea',
    title: 'Supprimer une idée',
    description: "Retire définitivement une idée de la réserve.",
    inputSchema: { type: 'object', properties: { idea_id: { type: 'string' } }, required: ['idea_id'] },
    annotations: { destructiveHint: true },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'idea_id');
      const s = await trouverSujet(api, id);
      await api('DELETE', `/agent/sujets/${enc(id)}`);
      return { supprimee: { id, sujet: s.titre } };
    },
  },
];
