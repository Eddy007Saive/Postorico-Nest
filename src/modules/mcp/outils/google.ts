import {
  Appel, dateFuture, dejaPublie, enc, ErreurOutil, exiger, LECTURE, lireContenu, noteProgrammation, Outil, PUBLIC, resume, texte,
  validerEtProgrammer,
} from './commun';

/** 08. Fiche Google (Google Business Profile). */

type Avis = { id: string; auteur: string | null; note: number; texte: string; date: string | null; reponse: { texte: string } | null };
const tousAvis = async (api: Appel) => (await api('GET', '/google-business/avis')) as { moyenne: number | null; total: number; avis: Avis[]; suite: string | null };

const OPTIONS_POST = {
  type: { type: 'string', enum: ['STANDARD', 'EVENT', 'OFFER'], description: 'Nouveauté (par défaut), événement ou offre.' },
  bouton: { type: 'string', enum: ['LEARN_MORE', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP', 'CALL'], description: "Bouton d'action (facultatif)." },
  bouton_url: { type: 'string', description: 'Adresse https du bouton (sauf CALL).' },
  evenement_titre: { type: 'string', description: 'EVENT / OFFER : titre.' },
  evenement_debut: { type: 'string', description: 'EVENT / OFFER : début, AAAA-MM-JJ ou AAAA-MM-JJTHH:MM (heure locale).' },
  evenement_fin: { type: 'string', description: 'EVENT / OFFER : fin, même format.' },
  offre_code: { type: 'string', description: 'OFFER : code promo.' },
  offre_lien: { type: 'string', description: "OFFER : lien vers l'offre (https)." },
  offre_conditions: { type: 'string', description: 'OFFER : conditions.' },
};

function optionsGoogle(args: Record<string, unknown>): Record<string, unknown> | null {
  const type = texte(args.type) || 'STANDARD';
  const o: Record<string, unknown> = { type };
  if (texte(args.bouton)) o.bouton = { type: texte(args.bouton), url: texte(args.bouton_url) || null };
  if (type !== 'STANDARD') o.evenement = { titre: texte(args.evenement_titre) || null, debut: texte(args.evenement_debut) || null, fin: texte(args.evenement_fin) || null };
  if (type === 'OFFER') o.offre = { code: texte(args.offre_code) || null, lien: texte(args.offre_lien) || null, conditions: texte(args.offre_conditions) || null };
  return type === 'STANDARD' && !o.bouton ? null : o;
}

export const OUTILS_GOOGLE: Outil[] = [
  {
    name: 'get_google_business_profile',
    title: 'Fiche Google',
    description: "Informations de la fiche Google de l'établissement : nom, description, téléphone, site, catégorie, horaires, note moyenne et nombre d'avis.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const [infos, avis] = await Promise.all([api('GET', '/google-business/infos'), tousAvis(api).catch(() => null)]);
      return { ...(infos as Record<string, unknown>), note_moyenne: avis?.moyenne ?? null, nombre_avis: avis?.total ?? null };
    },
  },
  {
    name: 'get_google_business_reviews',
    title: 'Avis Google',
    description: "Avis Google de l'établissement (les plus récents d'abord), avec la note, le texte et la réponse déjà publiée s'il y en a une. sans_reponse: true pour ne garder que ceux qui attendent une réponse.",
    inputSchema: { type: 'object', properties: { sans_reponse: { type: 'boolean' } } },
    annotations: LECTURE,
    executer: async (api, args) => {
      const r = await tousAvis(api);
      const avis = args.sans_reponse === true ? r.avis.filter((a) => !a.reponse) : r.avis;
      return { note_moyenne: r.moyenne, total: r.total, affiches: avis.length, avis: avis.map(({ id, auteur, note, texte: t, date, reponse }) => ({ id, auteur, note, texte: t, date, reponse: reponse?.texte ?? null })) };
    },
  },
  {
    name: 'generate_review_response',
    title: 'Proposer une réponse à un avis',
    description: "Propose une réponse à un avis Google, dans la voix de la marque, adaptée à la note. Ne publie rien : pour publier, reply_to_google_review après accord du client.",
    inputSchema: { type: 'object', properties: { avis_id: { type: 'string' } }, required: ['avis_id'] },
    executer: async (api, args) => {
      const id = exiger(args, 'avis_id');
      const a = (await tousAvis(api)).avis.find((x) => x.id === id);
      if (!a) throw new ErreurOutil('Avis introuvable parmi les plus récents : vérifie son id avec get_google_business_reviews.');
      const r = (await api('POST', '/google-business/avis/suggestion', { auteur: a.auteur, note: a.note, texte: a.texte })) as { texte: string };
      return { avis_id: id, note: a.note, avis: a.texte, reponse_proposee: r.texte };
    },
  },
  {
    name: 'reply_to_google_review',
    title: 'Répondre à un avis Google',
    description: "Publie une réponse à un avis Google, au nom de l'établissement. Réponse publique (elle remplace une réponse existante) : à n'envoyer qu'après accord explicite du client sur le texte.",
    inputSchema: { type: 'object', properties: { avis_id: { type: 'string' }, reponse: { type: 'string' } }, required: ['avis_id', 'reponse'] },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'avis_id');
      await api('POST', `/google-business/avis/${enc(id)}/reponse`, { message: exiger(args, 'reponse').slice(0, 4000) });
      return { avis_id: id, publiee: true };
    },
  },
  {
    name: 'create_google_business_post',
    title: 'Créer un post de fiche Google',
    description:
      "Crée un post pour la fiche Google (nouveauté, événement ou offre, avec bouton d'action facultatif), « À valider » : rien ne part avant publish_google_business_post. Sans texte, Postorico le rédige dans la voix de la marque à partir du sujet (1 post du quota).",
    inputSchema: {
      type: 'object',
      properties: {
        texte: { type: 'string', description: 'Texte du post (1 500 caractères au plus), tel quel.' },
        sujet: { type: 'string', description: 'Ou un sujet : Postorico rédige le texte.' },
        ...OPTIONS_POST,
      },
    },
    journal: true,
    executer: async (api, args) => {
      const options = optionsGoogle(args);
      let id: string;
      let corps: string;
      if (texte(args.texte)) {
        corps = texte(args.texte);
        if (corps.length > 1500) throw new ErreurOutil('Texte trop long pour une fiche Google (1 500 caractères au plus).');
        const r = (await api('POST', '/agent/enregistrer', { contenu: corps, reseau: 'googlebusiness' })) as { contenu_id: string };
        id = r.contenu_id;
      } else {
        const sujet = texte(args.sujet);
        if (!sujet) throw new ErreurOutil('Donne le texte, ou un sujet.');
        const r = (await api('POST', '/agent/rediger', { sujet, reseau: 'googlebusiness', brouillon: true })) as { contenu_id: string; contenu: string };
        id = r.contenu_id;
        corps = r.contenu;
        // Brouillon du Studio → « À valider », comme un post écrit à la main
        await api('POST', '/agent/enregistrer', { contenu: corps, reseau: 'googlebusiness', contenu_id: id });
      }
      if (options) {
        try {
          await api('PATCH', `/contenus/${enc(id)}`, { google_options: options });
        } catch (e) {
          throw new ErreurOutil(`Post enregistré (${id}) mais options refusées : ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { ...resume(await lireContenu(api, id), true), options: options ?? { type: 'STANDARD' }, note: 'À valider : publish_google_business_post pour le publier.' };
    },
  },
  {
    name: 'publish_google_business_post',
    title: 'Publier un post de fiche Google',
    description:
      "Approuve et publie un post de fiche Google : tout de suite (dans les 2 minutes) ou à la date donnée. Publication réelle sur la fiche : accord explicite du client requis.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, date_publication: { type: 'string', description: 'ISO 8601. Absente : dans les 2 minutes.' } },
      required: ['contenu_id'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const c = await lireContenu(api, id);
      if (texte(c.reseau_cible).toLowerCase() !== 'googlebusiness') throw new ErreurOutil("Ce contenu n'est pas un post de fiche Google : utilise publish_content.");
      if (dejaPublie(c)) throw new ErreurOutil('Ce post est déjà publié.');
      const date = texte(args.date_publication) ? dateFuture(args.date_publication) : new Date(Date.now() + 2 * 60_000);
      const r = await validerEtProgrammer(api, id, date);
      return { ...resume(r), note: noteProgrammation(r) };
    },
  },
];
