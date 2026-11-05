import { Appel, choisir, ErreurOutil, LECTURE, Outil, texte } from './commun';

/** 01. Marque : ce qui fait que les contenus ressemblent au client. */

const moi = async (api: Appel) => (await api('GET', '/users/me')) as Record<string, unknown>;

/** Champs de marque modifiables par l'assistant (le reste se règle dans Postorico). */
const MODIFIABLES: Record<string, string> = {
  secteur: 'Secteur et activité',
  audience: 'Audience cible',
  piliers: 'Piliers de contenu (thèmes récurrents)',
  voix_marque: 'Voix et ton de la marque',
  a_eviter: 'Mots, sujets ou tournures à éviter',
  hooks: "Façons d'accrocher qui marchent pour cette marque",
  ctas: "Appels à l'action habituels",
  regles: 'Règles de communication',
  exemples_linkedin: 'Exemples de posts LinkedIn du client',
  exemples_instagram: 'Exemples de posts Instagram du client',
  exemples_facebook: 'Exemples de posts Facebook du client',
  exemples_tiktok: 'Exemples de textes TikTok du client',
  exemples_googlebusiness: 'Exemples de posts de fiche Google du client',
};

export const OUTILS_MARQUE: Outil[] = [
  {
    name: 'get_brand_profile',
    title: 'Profil de marque',
    description: "Profil de marque du client : nom, secteur, audience, piliers de contenu, réseaux connectés. Point de départ pour comprendre l'entreprise.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const u = await moi(api);
      const reseaux = Object.keys(u)
        .filter((k) => k.startsWith('late_account_') && u[k])
        .map((k) => k.replace('late_account_', ''));
      return {
        ...choisir(u, ['nom', 'email', 'secteur', 'audience', 'piliers', 'langue', 'timezone']),
        reseaux_connectes: reseaux,
        profil_complet: !!(texte(u.secteur) && texte(u.voix_marque) && texte(u.audience) && texte(u.piliers)),
      };
    },
  },
  {
    name: 'update_brand_profile',
    title: 'Modifier le profil de marque',
    description:
      "Modifie un ou plusieurs champs du profil de marque. Chaque champ donné REMPLACE l'ancien : lis d'abord la valeur actuelle (get_brand_profile, get_brand_voice, get_brand_guidelines) et fais valider le nouveau texte par le client. Ces informations guident toute la rédaction de Postorico.",
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(MODIFIABLES).map(([k, d]) => [k, { type: 'string', description: d }])),
    },
    journal: true,
    executer: async (api, args) => {
      const maj: Record<string, string> = {};
      for (const k of Object.keys(MODIFIABLES)) {
        if (typeof args[k] === 'string') maj[k] = (args[k] as string).trim().slice(0, 8000);
      }
      if (!Object.keys(maj).length) throw new ErreurOutil(`Rien à modifier. Champs possibles : ${Object.keys(MODIFIABLES).join(', ')}.`);
      const u = (await api('PATCH', '/users/me', maj)) as Record<string, unknown>;
      return { modifie: Object.keys(maj), profil: choisir(u, Object.keys(maj)) };
    },
  },
  {
    name: 'get_brand_voice',
    title: 'Voix de marque',
    description: "Ton et style rédactionnel du client : voix, accroches qui marchent, appels à l'action, à éviter, et ses exemples de posts par réseau.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) =>
      choisir(await moi(api), [
        'voix_marque', 'hooks', 'ctas', 'a_eviter',
        'exemples_linkedin', 'exemples_instagram', 'exemples_facebook', 'exemples_tiktok', 'exemples_googlebusiness',
      ]),
  },
  {
    name: 'get_brand_guidelines',
    title: 'Règles de communication',
    description: 'Règles de communication de la marque : règles éditoriales, sujets et mots à éviter, piliers, style des images.',
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => choisir(await moi(api), ['regles', 'a_eviter', 'piliers', 'style_image', 'use_photo']),
  },
  {
    name: 'get_brand_assets',
    title: 'Ressources de marque',
    description: 'Logo, couleurs, polices, photo du dirigeant, modèles de visuels de la marque et mises en page disponibles pour les images.',
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const u = await moi(api);
      const [modeles, gabarits] = await Promise.all([
        api('GET', '/agent/templates').catch(() => []) as Promise<Array<{ nom: string; images?: string[]; note?: string }>>,
        api('GET', '/agent/gabarits').catch(() => ({})) as Promise<{ labels?: Record<string, string> }>,
      ]);
      return {
        logo: u.logo_url ?? null,
        couleurs: choisir(u, ['couleur_principale', 'couleur_secondaire', 'couleur_accent']),
        polices: choisir(u, ['typo_primaire', 'typo_secondaire', 'typo_tertiaire']),
        carrousels: choisir(u, ['carrousel_couleur_principale', 'carrousel_couleur_secondaire', 'carrousel_couleur_accent', 'carrousel_font', 'carrousel_font_corps']),
        photo_dirigeant: u.use_photo ? (u.photo_url ?? null) : null,
        modeles_de_visuels: (Array.isArray(modeles) ? modeles : []).map((m) => ({ nom: m.nom, images: m.images ?? [], consigne: m.note ?? null })),
        mises_en_page: Object.values(gabarits?.labels ?? {}),
      };
    },
  },
];
