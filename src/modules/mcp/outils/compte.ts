import { enc, exiger, LECTURE, Outil, PUBLIC, RESEAUX, reseauValide, texte } from './commun';

/** Hors liste : commentaires des réseaux et quotas du compte. */

export const OUTILS_COMPTE: Outil[] = [
  {
    name: 'get_comments_inbox',
    title: 'Publications commentées',
    description: "Publications récentes qui ont reçu des commentaires, tous réseaux confondus. Pour lire les commentaires d'une publication : get_post_comments avec son post_id et son account_id.",
    inputSchema: { type: 'object', properties: { reseau: { type: 'string', enum: RESEAUX } } },
    annotations: LECTURE,
    executer: async (api, args) => api('GET', `/inbox${texte(args.reseau) ? `?platform=${reseauValide(args.reseau)}` : ''}`),
  },
  {
    name: 'get_post_comments',
    title: "Commentaires d'une publication",
    description: "Commentaires d'une publication (ids issus de get_comments_inbox).",
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, account_id: { type: 'string' } }, required: ['post_id', 'account_id'] },
    annotations: LECTURE,
    executer: async (api, args) => api('GET', `/inbox/post/${enc(exiger(args, 'post_id'))}?account_id=${enc(exiger(args, 'account_id'))}`),
  },
  {
    name: 'reply_to_comment',
    title: 'Répondre à un commentaire',
    description: "Publie une réponse, au nom du client, sous une publication ou à un commentaire précis. Réponse publique : à n'envoyer qu'après accord du client sur le texte.",
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
        account_id: { type: 'string' },
        comment_id: { type: 'string', description: 'Commentaire auquel répondre (absent : réponse sous la publication).' },
        message: { type: 'string' },
      },
      required: ['post_id', 'account_id', 'message'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) =>
      api('POST', '/inbox/reply', {
        post_id: exiger(args, 'post_id'),
        account_id: exiger(args, 'account_id'),
        message: exiger(args, 'message'),
        ...(texte(args.comment_id) ? { comment_id: texte(args.comment_id) } : {}),
      }),
  },
  {
    name: 'get_quota',
    title: 'Quotas du mois',
    description: "Ce qui reste au client ce mois-ci, par type d'action (posts, sujets, images, images HD, carrousels, vidéos…), et l'état de son abonnement.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => api('GET', '/agent/usage'),
  },
];
