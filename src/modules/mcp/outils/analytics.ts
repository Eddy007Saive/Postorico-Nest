import { Appel, entier, ErreurOutil, exiger, LECTURE, Outil, RESEAUX, reseauValide, texte } from './commun';

/** 07. Statistiques : relevés des réseaux (via Zernio) rattachés aux contenus Postorico. */

type Perf = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

const perfs = async (api: Appel) => (await api('GET', '/analytics/performance')) as Perf[];

function vuePerf(p: Perf) {
  return {
    contenu_id: p.contenu_id ?? null,
    reseau: p.reseau,
    format: p.format,
    publie_le: p.publie_le,
    lien: p.url ?? null,
    vues: num(p.vues),
    portee: num(p.portee),
    impressions: num(p.impressions),
    likes: num(p.likes),
    commentaires: num(p.commentaires),
    partages: num(p.partages),
    enregistrements: num(p.enregistrements),
    clics: num(p.clics),
    taux_engagement: num(p.taux_engagement),
    performant: p.post_performant ?? null,
  };
}

const SANS_STATS = "Pas encore de statistiques pour ce contenu : elles arrivent quelques heures après la publication (et seulement si le réseau en fournit).";

export const OUTILS_ANALYTICS: Outil[] = [
  {
    name: 'get_social_analytics',
    title: 'Statistiques globales',
    description:
      "Statistiques réelles des réseaux sur une période : portée, impressions, vues, engagement, abonnés gagnés, comparaison avec la période précédente, rythme de publication, meilleurs créneaux.",
    inputSchema: {
      type: 'object',
      properties: { jours: { type: 'integer', minimum: 7, maximum: 365, description: '30 par défaut.' }, reseau: { type: 'string', enum: RESEAUX } },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const jours = entier(args.jours, 30, 7, 365);
      const reseau = texte(args.reseau) ? reseauValide(args.reseau) : '';
      const r = (await api('GET', `/analytics/insights?days=${jours}${reseau ? `&platform=${reseau}` : ''}`)) as Record<string, unknown>;
      if (r.connected === false) return { connecte: false, note: 'Aucun réseau connecté.' };
      if (r.addon_required) return { note: "Statistiques indisponibles : l'option statistiques n'est pas active sur ce compte." };
      const comp = (r.comparaison ?? {}) as Record<string, unknown>;
      return {
        jours,
        reseau: reseau || 'tous',
        indicateurs: r.kpis,
        periode_precedente: comp.previousTotals ?? null,
        abonnes: r.abonnes ?? null,
        rythme: r.frequence ?? null,
        meilleurs_creneaux: Array.isArray(r.creneaux) ? (r.creneaux as unknown[]).slice(0, 5) : null,
        publications_suivies: (r.overview as Record<string, unknown> | undefined)?.totalPosts ?? null,
      };
    },
  },
  {
    name: 'get_content_performance',
    title: "Performance d'un contenu",
    description: "Statistiques d'un contenu publié : vues, portée, likes, commentaires, partages, enregistrements, clics, taux d'engagement.",
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    annotations: LECTURE,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const lignes = (await perfs(api)).filter((p) => p.contenu_id === id);
      if (!lignes.length) return { contenu_id: id, note: SANS_STATS };
      return { contenu_id: id, statistiques: lignes.map(vuePerf) };
    },
  },
  {
    name: 'compare_content_performance',
    title: 'Comparer des contenus',
    description: "Compare les statistiques de 2 à 10 contenus publiés, côte à côte, et indique lequel a le mieux marché (taux d'engagement, puis portée).",
    inputSchema: {
      type: 'object',
      properties: { contenu_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 } },
      required: ['contenu_ids'],
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const ids = [...new Set((Array.isArray(args.contenu_ids) ? args.contenu_ids : []).map(texte).filter(Boolean))].slice(0, 10);
      if (ids.length < 2) throw new ErreurOutil('Donne au moins 2 contenu_ids.');
      const toutes = await perfs(api);
      const lignes = ids.map((id) => {
        const p = toutes.find((x) => x.contenu_id === id);
        return p ? vuePerf(p) : { contenu_id: id, note: SANS_STATS };
      });
      const mesurees = lignes.filter((l): l is ReturnType<typeof vuePerf> => 'taux_engagement' in l);
      const meilleur = [...mesurees].sort((a, b) => (b.taux_engagement ?? 0) - (a.taux_engagement ?? 0) || (b.portee ?? 0) - (a.portee ?? 0))[0];
      return { comparaison: lignes, meilleur: meilleur?.contenu_id ?? null };
    },
  },
  {
    name: 'get_best_performing_content',
    title: 'Meilleurs contenus',
    description: "Les contenus publiés qui ont le mieux marché sur une période, classés par taux d'engagement (ou par portée, vues, commentaires).",
    inputSchema: {
      type: 'object',
      properties: {
        jours: { type: 'integer', minimum: 7, maximum: 365, description: '90 par défaut.' },
        reseau: { type: 'string', enum: RESEAUX },
        critere: { type: 'string', enum: ['taux_engagement', 'portee', 'vues', 'commentaires', 'partages'], description: 'taux_engagement par défaut.' },
        limite: { type: 'integer', minimum: 1, maximum: 20, description: '5 par défaut.' },
      },
    },
    annotations: LECTURE,
    executer: async (api, args) => {
      const jours = entier(args.jours, 90, 7, 365);
      const reseau = texte(args.reseau) ? reseauValide(args.reseau) : '';
      const critere = ['taux_engagement', 'portee', 'vues', 'commentaires', 'partages'].includes(texte(args.critere)) ? texte(args.critere) : 'taux_engagement';
      const depuis = Date.now() - jours * 86_400_000;
      const lignes = (await perfs(api))
        .filter((p) => new Date(String(p.publie_le)).getTime() >= depuis && (!reseau || p.reseau === reseau))
        .map(vuePerf)
        .sort((a, b) => ((b as Record<string, number | null>)[critere] ?? 0) - ((a as Record<string, number | null>)[critere] ?? 0));
      return { jours, critere, total_mesures: lignes.length, meilleurs: lignes.slice(0, entier(args.limite, 5, 1, 20)) };
    },
  },
  {
    name: 'get_platform_statistics',
    title: 'Statistiques par réseau',
    description: "Bilan par réseau sur une période : nombre de publications mesurées, totaux (vues, likes, commentaires, partages) et taux d'engagement moyen ; plus l'état des contenus du compte.",
    inputSchema: { type: 'object', properties: { jours: { type: 'integer', minimum: 7, maximum: 365, description: '30 par défaut.' } } },
    annotations: LECTURE,
    executer: async (api, args) => {
      const jours = entier(args.jours, 30, 7, 365);
      const depuis = Date.now() - jours * 86_400_000;
      const [lignes, stats] = await Promise.all([perfs(api), api('GET', '/analytics/stats').catch(() => null) as Promise<Record<string, unknown> | null>]);
      const parReseau = new Map<string, { publications: number; vues: number; likes: number; commentaires: number; partages: number; engagement: number }>();
      for (const p of lignes.filter((x) => new Date(String(x.publie_le)).getTime() >= depuis)) {
        const r = String(p.reseau);
        const acc = parReseau.get(r) ?? { publications: 0, vues: 0, likes: 0, commentaires: 0, partages: 0, engagement: 0 };
        acc.publications += 1;
        acc.vues += num(p.vues) ?? 0;
        acc.likes += num(p.likes) ?? 0;
        acc.commentaires += num(p.commentaires) ?? 0;
        acc.partages += num(p.partages) ?? 0;
        acc.engagement += num(p.taux_engagement) ?? 0;
        parReseau.set(r, acc);
      }
      return {
        jours,
        reseaux: [...parReseau.entries()].map(([reseau, a]) => ({
          reseau,
          publications: a.publications,
          vues: a.vues,
          likes: a.likes,
          commentaires: a.commentaires,
          partages: a.partages,
          taux_engagement_moyen: Math.round((a.engagement / a.publications) * 100) / 100,
        })),
        contenus_par_statut: stats?.contenus_stats ?? null,
      };
    },
  },
];
