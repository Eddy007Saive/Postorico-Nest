import {
  dateFuture, dejaPublie, enc, entier, ErreurOutil, exiger, LECTURE, lireContenu, noteProgrammation, Outil, PUBLIC, resume,
  STATUTS, texte, tousContenus, validerEtProgrammer,
} from './commun';
import { enregistrerTexte } from './generation';

/** 05. Validation et workflow : les étapes de validation humaine. */

const ETAPES =
  'Étapes : Brouillon (rédigé, pas encore soumis) → A valider (attend la décision du client) → Valider (approuvé, programmé) → Planifie (confirmé par le réseau) → Publie. Refuse = écarté.';

export const OUTILS_VALIDATION: Outil[] = [
  {
    name: 'get_pending_approvals',
    title: 'Contenus à valider',
    description: `Contenus qui attendent la décision du client (statut « A valider »), et les brouillons pas encore soumis. ${ETAPES}`,
    inputSchema: { type: 'object', properties: { avec_brouillons: { type: 'boolean', description: 'Inclure les brouillons (vrai par défaut).' } } },
    annotations: LECTURE,
    executer: async (api, args) => {
      const tous = await tousContenus(api);
      const aValider = tous.filter((c) => c.statut === 'A valider');
      const brouillons = args.avec_brouillons === false ? [] : tous.filter((c) => c.statut === 'Brouillon');
      return { a_valider: aValider.map((c) => resume(c)), brouillons: brouillons.map((c) => resume(c)), etapes: ETAPES };
    },
  },
  {
    name: 'get_content_details',
    title: "Détail d'un contenu",
    description: "Texte complet d'un contenu, son statut, sa date, son visuel, ses slides, son premier commentaire et l'état de sa publication.",
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    annotations: LECTURE,
    executer: async (api, args) => resume(await lireContenu(api, exiger(args, 'contenu_id')), true),
  },
  {
    name: 'get_content_status',
    title: "Statut d'un contenu",
    description: `Où en est un contenu : étape de validation, date prévue, état chez le réseau (envoi, programmé, publié, échec et sa raison), lien une fois publié. ${ETAPES}`,
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    annotations: LECTURE,
    executer: async (api, args) => {
      const c = await lireContenu(api, exiger(args, 'contenu_id'));
      return {
        id: c.id,
        titre: c.titre,
        statut: c.statut,
        reseau: c.reseau_cible,
        date_publication: c.date_publication ?? null,
        publication: c.publish_status ?? null,
        erreur_publication: c.publish_error ?? null,
        lien: c.lien_publication ?? null,
        motif_refus: c.motif_refus ?? null,
      };
    },
  },
  {
    name: 'list_contents',
    title: 'Lister les contenus',
    description: 'Tous les contenus du client (posts, carrousels, reels, stories), les plus récents en premier, avec un filtre facultatif par statut. Paginé.',
    inputSchema: {
      type: 'object',
      properties: {
        statut: { type: 'string', enum: STATUTS },
        limite: { type: 'integer', minimum: 1, maximum: 50, description: '20 par défaut.' },
        decalage: { type: 'integer', minimum: 0, description: 'Sauter les N plus récents, pour voir la suite.' },
      },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const limite = entier(args.limite, 20, 1, 50);
      const decalage = entier(args.decalage, 0, 0, 100000);
      const rows = await tousContenus(api, texte(args.statut) || undefined);
      const page = rows.slice(decalage, decalage + limite);
      return {
        total: rows.length,
        affiches: `${page.length ? decalage + 1 : 0} à ${decalage + page.length}`,
        ...(decalage + page.length < rows.length ? { suite: `decalage: ${decalage + page.length}` } : {}),
        contenus: page.map((c) => resume(c)),
      };
    },
  },
  {
    name: 'approve_content',
    title: 'Approuver un contenu',
    description:
      "Approuve un contenu au nom du client et le programme : au prochain créneau libre de son réseau, ou à la date donnée. Il sera publié automatiquement. À n'utiliser qu'après accord explicite du client sur ce texte.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, date_publication: { type: 'string', description: 'ISO 8601. Absente : prochain créneau libre.' } },
      required: ['contenu_id'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const date = texte(args.date_publication) ? dateFuture(args.date_publication) : undefined;
      const r = await validerEtProgrammer(api, exiger(args, 'contenu_id'), date);
      return { ...resume(r), note: noteProgrammation(r) };
    },
  },
  {
    name: 'reject_content',
    title: 'Refuser un contenu',
    description: "Refuse un contenu (il sort du circuit de publication). Le motif aide Postorico à mieux écrire la prochaine fois.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, motif: { type: 'string', description: 'Pourquoi ce contenu ne convient pas.' } },
      required: ['contenu_id'],
    },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const c = await lireContenu(api, id);
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      if (c.late_post_id && (c.publish_status === 'programmé' || c.publish_status === 'envoi')) {
        await api('POST', `/late/annuler/${enc(id)}`); // il ne doit plus partir
      }
      const r = await api('PATCH', `/contenus/${enc(id)}`, { statut: 'Refuse', ...(texte(args.motif) ? { motif_refus: texte(args.motif).slice(0, 1000) } : {}) });
      return resume(r as Record<string, unknown>);
    },
  },
  {
    name: 'request_content_revision',
    title: 'Demander une révision',
    description:
      "Fait réviser un contenu selon une consigne du client (« plus court », « enlève la question finale »…) : Postorico réécrit le texte dans la voix de la marque, l'enregistre, et le contenu repasse « A valider ». Gratuit (40 retouches par heure).",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, consigne: { type: 'string', description: 'Ce qui doit changer.' } },
      required: ['contenu_id', 'consigne'],
    },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const consigne = exiger(args, 'consigne');
      const c = await lireContenu(api, id);
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      const corps = texte(c.contenu);
      if (!corps) throw new ErreurOutil("Ce contenu n'a pas de texte à réviser.");
      const r = (await api('POST', '/agent/retravailler', { texte: corps, action: 'reviser', consigne, reseau: texte(c.reseau_cible).toLowerCase() || 'linkedin' })) as { texte: string };
      // Programmé : on le retire du circuit, le client doit le revoir
      if (c.late_post_id && (c.publish_status === 'programmé' || c.publish_status === 'envoi')) {
        await api('POST', `/late/annuler/${enc(id)}`).catch(() => undefined);
      }
      await enregistrerTexte(api, { ...c, late_post_id: null }, r.texte);
      const apres = (await api('PATCH', `/contenus/${enc(id)}`, { statut: 'A valider' })) as Record<string, unknown>;
      return { ...resume(apres, true), note: 'Révisé et repassé « A valider » : à relire avant approve_content.' };
    },
  },
];
