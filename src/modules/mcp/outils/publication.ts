import {
  Appel, dateFuture, dejaPublie, enc, entier, ErreurOutil, exiger, LECTURE, lireContenu, noteProgrammation, Outil, PUBLIC, RESEAUX,
  reseauValide, resume, texte, tousContenus, validerEtProgrammer,
} from './commun';

/** 06. Publication multicanale. */

const VALIDES = ['Valider', 'Planifie', 'Pret a publier'];

/** Renvoie la programmation chez le réseau ; un échec d'envoi est rapporté (pas levé) : la
 * date, elle, est déjà enregistrée. */
async function envoyer(api: Appel, id: string): Promise<string | null> {
  try {
    await api('POST', `/late/publier/${enc(id)}`);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const noteEnvoi = (echec: string | null, r: Record<string, unknown>) =>
  echec ? `Date enregistrée, mais l'envoi au réseau a échoué : ${echec}` : noteProgrammation(r);

export const OUTILS_PUBLICATION: Outil[] = [
  {
    name: 'get_connected_social_accounts',
    title: 'Réseaux connectés',
    description: "Comptes sociaux connectés à Postorico (nom, abonnés, actif ou non). Un réseau absent ici ne peut pas recevoir de publication : le client le connecte dans Postorico › Paramètres › Réseaux.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const r = (await api('GET', '/users/me/social-accounts')) as { accounts: Record<string, Record<string, unknown>> };
      return {
        comptes: Object.entries(r.accounts || {}).map(([reseau, a]) => ({
          reseau,
          nom: a.name ?? a.username ?? null,
          identifiant: a.username ?? null,
          abonnes: a.followers ?? null,
          actif: a.is_active ?? null,
          lien: a.url ?? null,
        })),
      };
    },
  },
  {
    name: 'schedule_publication',
    title: 'Programmer une publication',
    description:
      "Programme la publication d'un contenu à une date précise (et l'approuve s'il ne l'était pas). Publication réelle : accord explicite du client requis. Pour le prochain créneau libre : approve_content.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, date_publication: { type: 'string', description: 'Date et heure ISO 8601, ex. 2026-11-12T09:00:00+01:00.' } },
      required: ['contenu_id', 'date_publication'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const date = dateFuture(args.date_publication);
      const c = await lireContenu(api, id);
      if (VALIDES.includes(String(c.statut)) && c.late_post_id) {
        // Déjà programmé : on déplace (l'ancien post est annulé chez le réseau puis recréé)
        await api('PATCH', `/contenus/${enc(id)}`, { date_publication: date.toISOString() });
        const echec = await envoyer(api, id);
        const r = await lireContenu(api, id);
        return { ...resume(r), note: noteEnvoi(echec, r) };
      }
      const r = await validerEtProgrammer(api, id, date);
      return { ...resume(r), note: noteProgrammation(r) };
    },
  },
  {
    name: 'publish_content',
    title: 'Publier maintenant',
    description:
      "Publie un contenu tout de suite (dans les 2 minutes), en l'approuvant s'il ne l'était pas. Publication réelle et immédiate au nom du client : n'utiliser qu'après son accord explicite sur ce texte et ce visuel.",
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const c = await lireContenu(api, id);
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      const bientot = new Date(Date.now() + 2 * 60_000);
      let echec: string | null = null;
      if (VALIDES.includes(String(c.statut)) && c.late_post_id) {
        await api('PATCH', `/contenus/${enc(id)}`, { date_publication: bientot.toISOString() });
        echec = await envoyer(api, id);
      } else {
        await validerEtProgrammer(api, id, bientot);
      }
      const r = await lireContenu(api, id);
      return {
        ...resume(r),
        note: echec
          ? noteEnvoi(echec, r)
          : r.publish_status === 'envoi' || r.publish_status === 'programmé'
          ? 'Envoyé au réseau pour une publication dans les 2 minutes. Le lien apparaîtra dans get_content_status une fois publié.'
          : noteProgrammation(r),
      };
    },
  },
  {
    name: 'cancel_publication',
    title: 'Annuler une publication',
    description: "Annule la programmation d'un contenu chez le réseau, avant sa publication. Le contenu reste approuvé mais n'est plus planifié (le reprogrammer avec schedule_publication ou approve_content).",
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      await api('POST', `/late/annuler/${enc(id)}`);
      return { ...resume(await lireContenu(api, id)), note: 'Programmation annulée : rien ne partira.' };
    },
  },
  {
    name: 'retry_failed_publication',
    title: 'Relancer une publication échouée',
    description:
      "Relance un contenu approuvé dont la publication a échoué ou n'est pas partie : il est reprogrammé au prochain créneau libre de son réseau (ou à la date donnée). Vérifier d'abord la raison de l'échec (get_content_status) : un réseau déconnecté doit être reconnecté dans Postorico.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, date_publication: { type: 'string', description: 'ISO 8601. Absente : prochain créneau libre.' } },
      required: ['contenu_id'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const c = await lireContenu(api, id);
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      if (!VALIDES.includes(String(c.statut))) throw new ErreurOutil("Ce contenu n'est pas approuvé : utilise approve_content.");
      if (texte(args.date_publication)) {
        await api('PATCH', `/contenus/${enc(id)}`, { date_publication: dateFuture(args.date_publication).toISOString() });
        const echec = await envoyer(api, id);
        if (echec) return { ...resume(await lireContenu(api, id)), note: noteEnvoi(echec, {}) };
      } else {
        await api('POST', `/contenus/${enc(id)}/replanifier`);
      }
      const r = await lireContenu(api, id);
      return { ...resume(r), note: r.publish_status === 'échec' ? `Nouvel échec : ${r.publish_error ?? 'raison inconnue'}.` : noteProgrammation(r) };
    },
  },
  {
    name: 'get_publication_history',
    title: 'Historique des publications',
    description: 'Contenus publiés, du plus récent au plus ancien, avec leur lien sur le réseau.',
    inputSchema: {
      type: 'object',
      properties: {
        reseau: { type: 'string', enum: RESEAUX },
        limite: { type: 'integer', minimum: 1, maximum: 50, description: '20 par défaut.' },
        decalage: { type: 'integer', minimum: 0 },
      },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const reseau = texte(args.reseau) ? reseauValide(args.reseau) : '';
      const limite = entier(args.limite, 20, 1, 50);
      const decalage = entier(args.decalage, 0, 0, 100000);
      const publies = (await tousContenus(api, 'Publie'))
        .filter((c) => !reseau || texte(c.reseau_cible).toLowerCase() === reseau)
        .sort((a, b) => String(b.date_publication).localeCompare(String(a.date_publication)));
      const page = publies.slice(decalage, decalage + limite);
      return {
        total: publies.length,
        ...(decalage + page.length < publies.length ? { suite: `decalage: ${decalage + page.length}` } : {}),
        publications: page.map((c) => ({ id: c.id, titre: c.titre, reseau: c.reseau_cible, publie_le: c.date_publication, lien: c.lien_publication ?? null })),
      };
    },
  },
];
