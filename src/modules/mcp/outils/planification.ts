import {
  Appel, Contenu, dateFuture, dejaPublie, enc, entier, ErreurOutil, exiger, LECTURE, lireContenu, Outil, programmeChezReseau,
  RESEAUX, reseauValide, resume, texte, tousContenus,
} from './commun';

/** 04. Planification éditoriale. */

const JOUR = 86_400_000;
const VALIDES = ['Valider', 'Planifie', 'Pret a publier'];

function periode(args: Record<string, unknown>): [Date, Date] {
  const du = texte(args.du) ? new Date(texte(args.du)) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  const au = texte(args.au) ? new Date(texte(args.au)) : new Date(du.getTime() + 30 * JOUR);
  if (Number.isNaN(du.getTime()) || Number.isNaN(au.getTime())) throw new ErreurOutil('du / au invalides (format AAAA-MM-JJ attendu).');
  if (au.getTime() - du.getTime() > 366 * JOUR) throw new ErreurOutil('Période trop longue (un an au plus).');
  return [du, au];
}

const dansPeriode = (c: Contenu, du: Date, au: Date) => {
  const d = c.date_publication ? new Date(String(c.date_publication)).getTime() : NaN;
  return d >= du.getTime() && d <= au.getTime() + JOUR - 1;
};
const parDate = (a: Contenu, b: Contenu) => String(a.date_publication).localeCompare(String(b.date_publication));
const reseauDe = (c: Contenu) => texte(c.reseau_cible).toLowerCase();

/** Applique une nouvelle date (et/ou un nouveau texte) ; renvoie la programmation chez le réseau si elle existait. */
async function deplacer(api: Appel, c: Contenu, date: Date | null, nouveauTexte?: string) {
  const id = String(c.id);
  if (date) {
    await api('PATCH', `/contenus/${enc(id)}`, { date_publication: date.toISOString(), ...(nouveauTexte ? { contenu: nouveauTexte } : {}) });
  } else if (nouveauTexte) {
    await api('PATCH', `/contenus/${enc(id)}`, { contenu: nouveauTexte });
  } else {
    // Sans date : prochain créneau libre (ne part chez le réseau que si le contenu est validé)
    await api('POST', `/contenus/${enc(id)}/replanifier`);
    return lireContenu(api, id);
  }
  // Validé : la programmation chez le réseau suit (l'ancien post y est annulé puis recréé).
  // Un échec d'envoi n'annule pas la modification : il est rapporté.
  if (programmeChezReseau(c) || VALIDES.includes(String(c.statut))) {
    try {
      await api('POST', `/late/publier/${enc(id)}`);
    } catch (e) {
      return { ...(await lireContenu(api, id)), echec_envoi: e instanceof Error ? e.message : String(e) };
    }
  }
  return lireContenu(api, id);
}

export const OUTILS_PLANIFICATION: Outil[] = [
  {
    name: 'get_editorial_calendar',
    title: 'Calendrier éditorial',
    description: 'Contenus datés sur une période (30 prochains jours par défaut), par date : statut, réseau, état de publication. Les refusés sont exclus.',
    inputSchema: {
      type: 'object',
      properties: {
        du: { type: 'string', description: "Début (AAAA-MM-JJ, aujourd'hui par défaut)." },
        au: { type: 'string', description: 'Fin incluse (AAAA-MM-JJ, début + 30 jours par défaut).' },
        reseau: { type: 'string', enum: RESEAUX },
      },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const [du, au] = periode(args);
      const reseau = texte(args.reseau) ? reseauValide(args.reseau) : '';
      const liste = (await tousContenus(api))
        .filter((c) => c.statut !== 'Refuse' && dansPeriode(c, du, au) && (!reseau || reseauDe(c) === reseau))
        .sort(parDate);
      return { du: du.toISOString().slice(0, 10), au: au.toISOString().slice(0, 10), total: liste.length, contenus: liste.map((c) => resume(c)) };
    },
  },
  {
    name: 'get_monthly_objectives',
    title: 'Objectifs du mois',
    description:
      "Objectifs d'un mois : par réseau, le nombre de publications prévu par la planification du client, déjà rempli et restant ; plus le dernier plan de Rico Coach (recommandations tirées des statistiques), s'il existe.",
    inputSchema: {
      type: 'object',
      properties: { annee: { type: 'integer' }, mois: { type: 'integer', minimum: 1, maximum: 12, description: 'Mois en cours par défaut.' } },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const now = new Date();
      const annee = entier(args.annee, now.getUTCFullYear(), 2024, 2100);
      const mois = entier(args.mois, now.getUTCMonth() + 1, 1, 12);
      const [plan, coach] = await Promise.all([
        api('GET', `/agent/plan?year=${annee}&month=${mois}`) as Promise<{ plan: Array<Record<string, unknown>> }>,
        api('GET', '/coach/plan').catch(() => ({ plan: null })) as Promise<{ plan: Record<string, unknown> | null }>,
      ]);
      return {
        annee,
        mois,
        cadence_par_reseau: plan.plan.map((p) => ({ reseau: p.platform, format: p.format, prevu: p.needed, rempli: p.filled, restant: p.remaining, stories: p.stories })),
        plan_rico_coach: coach.plan
          ? { mois: coach.plan.mois, introduction: coach.plan.intro, recommandations: coach.plan.recommandations, calcule_le: coach.plan.calcule_le }
          : null,
      };
    },
  },
  {
    name: 'create_editorial_plan',
    title: 'Remplir le mois',
    description:
      "Génère en une fois plusieurs contenus pour un mois (un par sujet et réseau), dans la voix de la marque, enregistrés « À valider » sur les créneaux libres du mois. Consomme 1 post (ou 1 carrousel selon le format du réseau) par contenu. 10 contenus au plus par appel ; montrer d'abord la liste au client.",
    inputSchema: {
      type: 'object',
      properties: {
        annee: { type: 'integer' },
        mois: { type: 'integer', minimum: 1, maximum: 12 },
        contenus: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: { sujet: { type: 'string' }, idea_id: { type: 'string', description: "Ou l'id d'une idée de la réserve." }, reseau: { type: 'string', enum: RESEAUX } },
            required: ['reseau'],
          },
        },
      },
      required: ['contenus'],
    },
    journal: true,
    executer: async (api, args) => {
      const now = new Date();
      const annee = entier(args.annee, now.getUTCFullYear(), 2024, 2100);
      const mois = entier(args.mois, now.getUTCMonth() + 1, 1, 12);
      const brut = (Array.isArray(args.contenus) ? args.contenus : []).slice(0, 10) as Array<Record<string, unknown>>;
      if (!brut.length) throw new ErreurOutil('Donne au moins un contenu (sujet ou idea_id, et reseau).');
      const idees = brut.some((x) => texte(x.idea_id))
        ? ((await api('GET', '/agent/sujets')) as Array<{ id: string; titre: string; dimensions: unknown }>)
        : [];
      const items = brut.map((x) => {
        const idee = texte(x.idea_id) ? idees.find((i) => i.id === texte(x.idea_id)) : undefined;
        if (texte(x.idea_id) && !idee) throw new ErreurOutil(`Idée introuvable : ${texte(x.idea_id)}.`);
        const sujet = texte(x.sujet) || idee?.titre || '';
        if (!sujet) throw new ErreurOutil('Chaque contenu a besoin d’un sujet ou d’un idea_id.');
        return { sujet, reseau: reseauValide(x.reseau), ...(idee?.dimensions ? { dimensions: idee.dimensions } : {}) };
      });
      const r = (await api('POST', '/agent/rafale', { items, year: annee, month: mois })) as {
        created: number;
        errors: Array<{ sujet?: string; reseau?: string }>;
        usage: unknown;
      };
      // Une idée ne quitte la réserve que si son contenu a bien été créé
      const rates = new Set(r.errors.map((e) => `${e.sujet}|${e.reseau}`));
      for (const [i, x] of brut.entries()) {
        if (texte(x.idea_id) && !rates.has(`${items[i].sujet}|${items[i].reseau}`)) {
          await api('DELETE', `/agent/sujets/${enc(texte(x.idea_id))}`).catch(() => undefined);
        }
      }
      return {
        crees: r.created,
        echecs: r.errors,
        note: r.created
          ? `${r.created} contenu(s) enregistré(s) « À valider » : voir get_pending_approvals.${r.errors.length ? ' Certains ont échoué : voir echecs.' : ''}`
          : 'Aucun contenu créé : voir echecs (quota épuisé, réseau invalide…).',
      };
    },
  },
  {
    name: 'add_content_to_calendar',
    title: 'Placer un contenu dans le calendrier',
    description:
      "Donne une date de publication à un contenu pas encore validé (à la date choisie, ou au prochain créneau libre de son réseau). Rien ne part tant qu'il n'est pas approuvé. Pour un contenu déjà validé ou programmé : update_scheduled_content.",
    inputSchema: {
      type: 'object',
      properties: { contenu_id: { type: 'string' }, date_publication: { type: 'string', description: 'ISO 8601. Absente : prochain créneau libre.' } },
      required: ['contenu_id'],
    },
    journal: true,
    executer: async (api, args) => {
      const c = await lireContenu(api, exiger(args, 'contenu_id'));
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      if (VALIDES.includes(String(c.statut))) throw new ErreurOutil('Ce contenu est déjà validé : utilise update_scheduled_content pour changer sa date.');
      const date = texte(args.date_publication) ? dateFuture(args.date_publication) : null;
      const r = await deplacer(api, c, date);
      return { ...resume(r), note: r.date_publication ? 'Daté. Il partira une fois approuvé (approve_content).' : 'Aucun créneau libre pour ce réseau.' };
    },
  },
  {
    name: 'update_scheduled_content',
    title: 'Modifier un contenu programmé',
    description:
      "Change la date et/ou le texte d'un contenu validé ou programmé, avant sa publication. S'il est déjà programmé chez le réseau, la programmation est mise à jour. Sans date ni texte : passe au prochain créneau libre.",
    inputSchema: {
      type: 'object',
      properties: {
        contenu_id: { type: 'string' },
        date_publication: { type: 'string', description: 'Nouvelle date, ISO 8601.' },
        texte: { type: 'string', description: 'Nouveau texte complet (à faire valider par le client).' },
      },
      required: ['contenu_id'],
    },
    annotations: { openWorldHint: true },
    journal: true,
    executer: async (api, args) => {
      const c = await lireContenu(api, exiger(args, 'contenu_id'));
      if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      const date = texte(args.date_publication) ? dateFuture(args.date_publication) : null;
      const r = await deplacer(api, c, date, texte(args.texte) || undefined);
      return {
        ...resume(r, true),
        note: r.echec_envoi
          ? `Modification enregistrée, mais l'envoi au réseau a échoué : ${String(r.echec_envoi)}`
          : VALIDES.includes(String(c.statut))
            ? 'Programmation mise à jour chez le réseau.'
            : 'Enregistré (il partira une fois approuvé).',
      };
    },
  },
  {
    name: 'get_publication_queue',
    title: "File d'attente de publication",
    description: "Contenus validés qui attendent leur publication, du plus proche au plus lointain, avec leur état chez le réseau (envoi, programmé, échec).",
    inputSchema: { type: 'object', properties: { reseau: { type: 'string', enum: RESEAUX } } },
    annotations: LECTURE,
    executer: async (api, args) => {
      const reseau = texte(args.reseau) ? reseauValide(args.reseau) : '';
      const liste = (await tousContenus(api))
        .filter((c) => VALIDES.includes(String(c.statut)) && !dejaPublie(c) && (!reseau || reseauDe(c) === reseau))
        .sort(parDate);
      return { total: liste.length, en_echec: liste.filter((c) => c.publish_status === 'échec').length, contenus: liste.map((c) => resume(c)) };
    },
  },
];
