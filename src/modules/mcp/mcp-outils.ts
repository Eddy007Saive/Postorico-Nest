/** Outils du connecteur MCP. Chacun passe par les routes HTTP existantes (avec un jeton du
 * client), donc par les mêmes quotas, règles et suivi des coûts que l'application. */

export type Appel = (methode: 'GET' | 'POST' | 'PATCH', chemin: string, corps?: unknown) => Promise<unknown>;

export class ErreurOutil extends Error {}

type Args = Record<string, unknown>;

export interface Outil {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  /** Action qui change quelque chose (création, modification, publication) : tracée dans journal_mcp. */
  journal?: boolean;
  executer: (api: Appel, args: Args) => Promise<unknown>;
}

const RESEAUX = ['linkedin', 'instagram', 'facebook', 'tiktok', 'youtube', 'googlebusiness'];
const STATUTS = ['Brouillon', 'A valider', 'Valider', 'Planifie', 'Publie', 'Refuse'];

const texte = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const exiger = (args: Args, cle: string) => {
  const v = texte(args[cle]);
  if (!v) throw new ErreurOutil(`Paramètre « ${cle} » requis.`);
  return v;
};
const enc = encodeURIComponent;

type Contenu = Record<string, unknown>;

/** Vue courte d'un contenu : ce qu'un assistant a besoin de lire, sans les champs techniques. */
function resume(c: Contenu, extrait = true) {
  const corps = typeof c.contenu === 'string' ? c.contenu : '';
  return {
    id: c.id,
    titre: c.titre,
    statut: c.statut,
    reseau: c.reseau_cible,
    type: c.type,
    date_publication: c.date_publication ?? null,
    publication: c.publish_status ?? null,
    erreur_publication: c.publish_error ?? null,
    visuel: c.lien_visuel ?? null,
    lien: c.lien_publication ?? null,
    ...(extrait ? { extrait: corps.length > 220 ? `${corps.slice(0, 220)}…` : corps } : { contenu: corps, premier_commentaire: c.premier_commentaire ?? null }),
  };
}

export const OUTILS: Outil[] = [
  {
    name: 'rediger_post',
    journal: true,
    title: 'Rédiger un post',
    description:
      "Rédige un post dans la voix de la marque du client (profil de marque, piliers, exemples validés) et l'enregistre en brouillon dans Postorico. Consomme 1 post du quota mensuel. Renvoie le texte et l'id du contenu, à faire relire au client avant de le valider.",
    inputSchema: {
      type: 'object',
      properties: {
        sujet: { type: 'string', description: 'Sujet, idée ou angle du post (une phrase ou quelques notes).' },
        reseau: { type: 'string', enum: RESEAUX, description: 'Réseau cible (linkedin par défaut).' },
      },
      required: ['sujet'],
    },
    executer: async (api, args) => {
      const reseau = texte(args.reseau).toLowerCase() || 'linkedin';
      if (!RESEAUX.includes(reseau)) throw new ErreurOutil(`Réseau inconnu : ${reseau}.`);
      const r = (await api('POST', '/agent/rediger', { sujet: exiger(args, 'sujet'), reseau, brouillon: true })) as Contenu;
      return { contenu_id: r.contenu_id, reseau, statut: 'Brouillon', texte: r.contenu, quota: r.quota };
    },
  },
  {
    name: 'lister_contenus',
    title: 'Lister les contenus',
    description:
      'Liste les contenus du client (posts, carrousels, reels, stories), les plus récents en premier, avec leur statut et leur date de publication. Filtre facultatif par statut.',
    inputSchema: {
      type: 'object',
      properties: {
        statut: { type: 'string', enum: STATUTS, description: 'Ne garder que ce statut. « A valider » = en attente de validation, « Valider » = validé, en cours de programmation.' },
        limite: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximum de contenus (20 par défaut).' },
      },
    },
    annotations: { readOnlyHint: true },
    executer: async (api, args) => {
      const statut = texte(args.statut);
      const limite = Math.min(Math.max(Number(args.limite) || 20, 1), 50);
      const rows = (await api('GET', `/contenus${statut ? `?statut=${enc(statut)}` : ''}`)) as Contenu[];
      return { total: rows.length, contenus: rows.slice(0, limite).map((c) => resume(c)) };
    },
  },
  {
    name: 'lire_contenu',
    title: 'Lire un contenu',
    description: "Renvoie le texte complet d'un contenu, son statut, sa date, son visuel et l'état de sa publication.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Id du contenu.' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
    executer: async (api, args) => resume((await api('GET', `/contenus/${enc(exiger(args, 'id'))}`)) as Contenu, false),
  },
  {
    name: 'modifier_contenu',
    journal: true,
    title: 'Modifier un contenu',
    description: "Remplace le texte, le titre ou le premier commentaire d'un contenu qui n'est pas encore publié.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id du contenu.' },
        texte: { type: 'string', description: 'Nouveau texte complet du post.' },
        titre: { type: 'string', description: 'Nouveau titre interne.' },
        premier_commentaire: { type: 'string', description: 'Commentaire publié sous le post juste après sa publication.' },
      },
      required: ['id'],
    },
    executer: async (api, args) => {
      const id = exiger(args, 'id');
      const maj: Record<string, unknown> = {};
      if (texte(args.texte)) maj.contenu = texte(args.texte);
      if (texte(args.titre)) maj.titre = texte(args.titre);
      if (texte(args.premier_commentaire)) {
        maj.premier_commentaire = texte(args.premier_commentaire);
        maj.premier_commentaire_auto = true;
      }
      if (!Object.keys(maj).length) throw new ErreurOutil('Rien à modifier : donne au moins texte, titre ou premier_commentaire.');
      const cur = (await api('GET', `/contenus/${enc(id)}`)) as Contenu;
      if (cur.publish_status === 'publié' || cur.statut === 'Publie') throw new ErreurOutil('Ce contenu est déjà publié.');
      return resume((await api('PATCH', `/contenus/${enc(id)}`, maj)) as Contenu, false);
    },
  },
  {
    name: 'valider_et_programmer',
    journal: true,
    title: 'Valider et programmer',
    description:
      "Valide un contenu et le programme sur son réseau : au prochain créneau libre de la planification du client, ou à la date donnée. La publication part ensuite automatiquement. À n'utiliser qu'après accord explicite du client sur le texte.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id du contenu.' },
        date_publication: { type: 'string', description: 'Date et heure ISO 8601 (ex. 2026-11-12T09:00:00+01:00). Absente : prochain créneau libre.' },
      },
      required: ['id'],
    },
    annotations: { destructiveHint: false, openWorldHint: true },
    executer: async (api, args) => {
      const id = exiger(args, 'id');
      const date = texte(args.date_publication);
      if (date) {
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) throw new ErreurOutil('date_publication invalide (format ISO 8601 attendu).');
        if (d.getTime() < Date.now()) throw new ErreurOutil('date_publication est dans le passé.');
      }
      const cur = (await api('GET', `/contenus/${enc(id)}`)) as Contenu;
      if (cur.statut === 'Publie' || cur.publish_status === 'publié') throw new ErreurOutil('Ce contenu est déjà publié.');
      if (!cur.reseau_cible) throw new ErreurOutil("Ce contenu n'a pas de réseau cible : choisis-le dans Postorico avant de le programmer.");
      // Un brouillon du Studio passe d'abord « À valider », comme dans l'application
      if (cur.statut === 'Brouillon') {
        await api('POST', '/agent/enregistrer', {
          contenu: cur.contenu || '',
          titre: cur.titre || undefined,
          reseau: texte(cur.reseau_cible).toLowerCase(),
          contenu_id: id,
          ...(cur.type === 'Story' ? { type: 'Story' } : {}),
        });
      }
      const r = (await api('PATCH', `/contenus/${enc(id)}`, { statut: 'Valider', ...(date ? { date_publication: new Date(date).toISOString() } : {}) })) as Contenu;
      return {
        ...resume(r),
        note: !r.date_publication
          ? 'Validé, mais aucun créneau libre : vérifie la planification de ce réseau dans Postorico.'
          : r.publish_status === 'envoi'
            ? 'Validé et envoyé au réseau ; le statut passe à « Planifie » dès que le réseau confirme la programmation.'
            : "Validé et placé dans le planning, mais pas encore envoyé au réseau : vérifie qu'il est bien connecté dans Postorico, puis « Replanifier » ce contenu.",
      };
    },
  },
  {
    name: 'performances',
    title: 'Performances',
    description: 'Statistiques réelles des publications du client (portée, impressions, engagement, meilleurs posts) sur une période.',
    inputSchema: {
      type: 'object',
      properties: {
        jours: { type: 'integer', minimum: 7, maximum: 365, description: 'Période en jours (30 par défaut).' },
        reseau: { type: 'string', enum: RESEAUX, description: 'Un seul réseau (tous par défaut).' },
      },
    },
    annotations: { readOnlyHint: true },
    executer: async (api, args) => {
      const jours = Math.min(Math.max(Number(args.jours) || 30, 7), 365);
      const reseau = texte(args.reseau).toLowerCase();
      return api('GET', `/analytics/insights?days=${jours}${reseau ? `&platform=${enc(reseau)}` : ''}`);
    },
  },
  {
    name: 'lister_commentaires',
    title: 'Posts commentés',
    description:
      "Liste les publications récentes qui ont reçu des commentaires, tous réseaux confondus. Pour lire les commentaires d'une publication : lire_commentaires avec son post_id et son account_id.",
    inputSchema: { type: 'object', properties: { reseau: { type: 'string', enum: RESEAUX, description: 'Un seul réseau.' } } },
    annotations: { readOnlyHint: true },
    executer: async (api, args) => {
      const reseau = texte(args.reseau).toLowerCase();
      return api('GET', `/inbox${reseau ? `?platform=${enc(reseau)}` : ''}`);
    },
  },
  {
    name: 'lire_commentaires',
    title: "Commentaires d'une publication",
    description: "Renvoie les commentaires d'une publication (ids issus de lister_commentaires).",
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' }, account_id: { type: 'string' } },
      required: ['post_id', 'account_id'],
    },
    annotations: { readOnlyHint: true },
    executer: async (api, args) =>
      api('GET', `/inbox/post/${enc(exiger(args, 'post_id'))}?account_id=${enc(exiger(args, 'account_id'))}`),
  },
  {
    name: 'repondre_commentaire',
    journal: true,
    title: 'Répondre à un commentaire',
    description:
      "Publie une réponse, au nom du client, sous une publication ou à un commentaire précis. La réponse est publique : à n'envoyer qu'après accord du client sur le texte.",
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
        account_id: { type: 'string' },
        comment_id: { type: 'string', description: 'Commentaire auquel répondre (absent : réponse sous la publication).' },
        message: { type: 'string', description: 'Texte de la réponse.' },
      },
      required: ['post_id', 'account_id', 'message'],
    },
    annotations: { openWorldHint: true },
    executer: async (api, args) =>
      api('POST', '/inbox/reply', {
        post_id: exiger(args, 'post_id'),
        account_id: exiger(args, 'account_id'),
        message: exiger(args, 'message'),
        ...(texte(args.comment_id) ? { comment_id: texte(args.comment_id) } : {}),
      }),
  },
  {
    name: 'quotas',
    title: 'Quotas du mois',
    description: "Ce qui reste au client ce mois-ci, par type d'action (posts, visuels, carrousels, vidéos…), et l'état de son abonnement.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executer: async (api) => api('GET', '/agent/usage'),
  },
];
