/** Outils du connecteur MCP. Chacun passe par les routes HTTP existantes (avec un jeton du
 * client), donc par les mêmes quotas, règles et suivi des coûts que l'application. */

import { ImageRefusee, telechargerImage } from './image-distante';

/** `corps` : objet envoyé en JSON, ou FormData pour un envoi de fichier. */
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
// Réseaux où un post peut être un texte (+ image) : TikTok et YouTube demandent une vidéo
const RESEAUX_TEXTE = ['linkedin', 'instagram', 'facebook', 'googlebusiness'];
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
        sujet_id: { type: 'string', description: "Ou l'id d'un sujet enregistré (lister_sujets) : son titre et ses réglages (objectif, angle, cible, format) sont repris." },
        reseau: { type: 'string', enum: RESEAUX, description: 'Réseau cible (linkedin par défaut).' },
      },
    },
    executer: async (api, args) => {
      const reseau = texte(args.reseau).toLowerCase() || 'linkedin';
      if (!RESEAUX.includes(reseau)) throw new ErreurOutil(`Réseau inconnu : ${reseau}.`);
      let sujet = texte(args.sujet);
      let dimensions: unknown;
      const sujetId = texte(args.sujet_id);
      if (sujetId) {
        const sujets = (await api('GET', '/agent/sujets')) as Array<{ id: string; titre: string | null; dimensions: unknown }>;
        const trouve = sujets.find((x) => x.id === sujetId);
        if (!trouve) throw new ErreurOutil('Sujet introuvable : vérifie son id avec lister_sujets.');
        sujet = sujet || trouve.titre || '';
        if (trouve.dimensions && typeof trouve.dimensions === 'object') dimensions = trouve.dimensions;
      }
      if (!sujet) throw new ErreurOutil('Donne un sujet, ou un sujet_id.');
      const r = (await api('POST', '/agent/rediger', { sujet, reseau, brouillon: true, ...(dimensions ? { dimensions } : {}) })) as Contenu;
      return { contenu_id: r.contenu_id, reseau, statut: 'Brouillon', texte: r.contenu, quota: r.quota };
    },
  },
  {
    name: 'creer_post',
    title: 'Créer un post avec mon texte',
    description:
      "Enregistre dans Postorico un post dont le client fournit lui-même le texte, tel quel, sans IA et sans consommer de quota. Visuel facultatif : une image par son adresse https, ou le visuel automatique de Postorico (consomme 1 image du quota). Sans « programmer », le post attend sa validation dans Postorico ; avec, il est validé et programmé au prochain créneau libre ou à la date donnée, et part donc réellement : à n'utiliser qu'avec l'accord explicite du client. Instagram exige un visuel.",
    inputSchema: {
      type: 'object',
      properties: {
        texte: { type: 'string', description: 'Texte complet du post, tel qu\'il sera publié.' },
        reseau: { type: 'string', enum: RESEAUX_TEXTE, description: 'Réseau cible.' },
        titre: { type: 'string', description: 'Titre interne (facultatif, sinon le début du texte).' },
        image_url: { type: 'string', description: "Adresse https d'une image (jpg, png, webp, gif ; 10 Mo au plus) à publier avec le post." },
        visuel_auto: { type: 'boolean', description: 'Faire créer le visuel par Postorico avec la charte du client (ignoré si image_url est donnée).' },
        programmer: { type: 'boolean', description: 'Valider et programmer tout de suite (publication réelle). Faux par défaut.' },
        date_publication: { type: 'string', description: 'Avec programmer : date et heure ISO 8601. Absente : prochain créneau libre.' },
      },
      required: ['texte', 'reseau'],
    },
    annotations: { openWorldHint: true },
    journal: true,
    executer: async (api, args) => {
      const corps = exiger(args, 'texte');
      if (corps.length > 5000) throw new ErreurOutil('Texte trop long (5 000 caractères au plus).');
      const reseau = texte(args.reseau).toLowerCase();
      if (!RESEAUX_TEXTE.includes(reseau)) {
        throw new ErreurOutil(`Réseau non pris en charge pour un post texte : ${reseau || '(vide)'}. Possibles : ${RESEAUX_TEXTE.join(', ')}.`);
      }
      const imageUrl = texte(args.image_url);
      const visuelAuto = !imageUrl && args.visuel_auto === true;
      const programmer = args.programmer === true;
      const date = texte(args.date_publication);
      if (date && !programmer) throw new ErreurOutil('date_publication ne sert qu\'avec programmer: true.');
      if (date) {
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) throw new ErreurOutil('date_publication invalide (format ISO 8601 attendu).');
        if (d.getTime() < Date.now()) throw new ErreurOutil('date_publication est dans le passé.');
      }
      if (reseau === 'instagram' && !imageUrl && !visuelAuto) {
        throw new ErreurOutil('Instagram exige un visuel : donne image_url, ou visuel_auto: true.');
      }
      // L'image d'abord : si elle est refusée, rien n'est créé
      let image: { octets: Buffer; type: string } | null = null;
      if (imageUrl) {
        try {
          image = await telechargerImage(imageUrl);
        } catch (e) {
          throw new ErreurOutil(e instanceof ImageRefusee ? e.message : "L'image n'a pas pu être téléchargée.");
        }
      }
      const cree = (await api('POST', '/agent/enregistrer', {
        contenu: corps,
        reseau,
        ...(texte(args.titre) ? { titre: texte(args.titre).slice(0, 120) } : {}),
        ...(visuelAuto ? { visuel_auto: true } : {}),
      })) as { contenu_id?: string; visuel_auto?: { en_cours: boolean; message?: string } };
      const id = cree.contenu_id;
      if (!id) throw new ErreurOutil("Le post n'a pas pu être enregistré.");
      const notes: string[] = [];
      if (image) {
        const form = new FormData();
        const ext = image.type.split('/')[1].replace('jpeg', 'jpg');
        form.append('file', new Blob([new Uint8Array(image.octets)], { type: image.type }), `visuel.${ext}`);
        try {
          await api('POST', `/contenus/${enc(id)}/image`, form);
        } catch (e) {
          notes.push(`Post enregistré, mais l'image n'a pas pu être jointe : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (visuelAuto) {
        notes.push(cree.visuel_auto?.en_cours
          ? 'Visuel automatique en cours de création (environ une minute).'
          : `Visuel automatique non lancé : ${cree.visuel_auto?.message || 'raison inconnue'}.`);
      }
      if (!programmer) {
        const r = (await api('GET', `/contenus/${enc(id)}`)) as Contenu;
        return { ...resume(r, false), contenu_id: id, note: ['Enregistré « À valider » : rien ne part tant qu\'il n\'est pas validé (dans Postorico, ou avec valider_et_programmer).', ...notes].join(' ') };
      }
      const r = (await api('PATCH', `/contenus/${enc(id)}`, { statut: 'Valider', ...(date ? { date_publication: new Date(date).toISOString() } : {}) })) as Contenu;
      notes.unshift(
        !r.date_publication
          ? 'Validé, mais aucun créneau libre : vérifie la planification de ce réseau dans Postorico.'
          : visuelAuto
            ? 'Validé et programmé : il partira dès que le visuel automatique sera prêt.'
            : r.publish_status === 'envoi'
              ? 'Validé et envoyé au réseau ; le statut passe à « Planifie » dès que le réseau confirme.'
              : "Validé et placé dans le planning, mais pas encore envoyé au réseau : vérifie qu'il est bien connecté dans Postorico.",
      );
      return { ...resume(r, false), contenu_id: id, note: notes.join(' ') };
    },
  },
  {
    name: 'lister_sujets',
    title: 'Lister les sujets',
    description:
      "Liste les idées de sujets enregistrées du client (générées par Postorico ou gardées depuis la matrice), avec leurs réglages (objectif, angle, cible, format). Pour en faire un post : rediger_post avec sujet_id.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executer: async (api) => {
      const rows = (await api('GET', '/agent/sujets')) as Array<{ id: string; titre: string | null; dimensions: unknown; created_at: string }>;
      return { total: rows.length, sujets: rows.map((x) => ({ id: x.id, sujet: x.titre, reglages: x.dimensions ?? null, cree_le: x.created_at })) };
    },
  },
  {
    name: 'generer_sujets',
    title: 'Trouver des sujets',
    description:
      "Génère de nouvelles idées de sujets adaptées à la marque du client et les enregistre (visibles ensuite dans lister_sujets et dans Postorico). Consomme 1 génération de sujets du quota mensuel, quel que soit le nombre d'idées.",
    inputSchema: {
      type: 'object',
      properties: { nombre: { type: 'integer', minimum: 1, maximum: 20, description: "Nombre d'idées (6 par défaut)." } },
    },
    journal: true,
    executer: async (api, args) => {
      const nombre = Math.min(Math.max(Number(args.nombre) || 6, 1), 20);
      const r = (await api('POST', '/agent/sujets', { nombre })) as { sujets: Array<{ id: string | null; titre: string; dimensions: unknown }>; quota: unknown };
      return { sujets: r.sujets.map((x) => ({ id: x.id, sujet: x.titre, reglages: x.dimensions ?? null })), quota: r.quota };
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
        decalage: { type: 'integer', minimum: 0, description: 'Sauter les N plus récents, pour voir la suite (0 par défaut).' },
      },
    },
    annotations: { readOnlyHint: true },
    executer: async (api, args) => {
      const statut = texte(args.statut);
      const limite = Math.min(Math.max(Number(args.limite) || 20, 1), 50);
      const decalage = Math.max(Number(args.decalage) || 0, 0);
      const rows = (await api('GET', `/contenus${statut ? `?statut=${enc(statut)}` : ''}`)) as Contenu[];
      const page = rows.slice(decalage, decalage + limite);
      return {
        total: rows.length,
        affiches: `${page.length ? decalage + 1 : 0} à ${decalage + page.length}`,
        ...(decalage + page.length < rows.length ? { suite: `decalage: ${decalage + page.length} pour voir la suite` } : {}),
        contenus: page.map((c) => resume(c)),
      };
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
