/** Prompts MCP : missions prêtes à lancer, qui enchaînent les outils de Postorico.
 * Règle commune : rien n'est publié sans l'accord explicite du client sur chaque texte. */

export interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  texte: (a: Record<string, string>) => string;
}

const ACCORD =
  "Règle absolue : ne publie, ne programme et n'approuve rien sans l'accord explicite du client sur chaque texte. Montre-lui d'abord, attends sa réponse.";
const QUOTA = 'Les outils generate_* consomment son quota mensuel : regarde get_quota avant de lancer plusieurs générations, et dis-lui ce que ça va consommer.';
const val = (v: string | undefined, defaut: string) => (v && v.trim() ? v.trim() : defaut);

export const PROMPTS: Prompt[] = [
  {
    name: 'create_monthly_strategy',
    title: 'Stratégie éditoriale du mois',
    description: 'Construit la stratégie éditoriale d’un mois : objectifs, thèmes, rythme par réseau, puis remplit le calendrier après validation.',
    arguments: [
      { name: 'mois', description: 'Mois visé, ex. « décembre 2026 » (mois prochain par défaut).' },
      { name: 'objectif', description: 'Objectif principal du mois (notoriété, ventes, recrutement…), facultatif.' },
    ],
    texte: (a) => `Construis la stratégie éditoriale Postorico de ${val(a.mois, 'mois prochain')}${a.objectif ? `, avec pour objectif principal : ${a.objectif}` : ''}.

1. Comprends la marque : lis brand://profile, brand://voice et brand://guidelines (ou get_brand_profile, get_brand_voice, get_brand_guidelines).
2. Fais le bilan : get_social_analytics et get_best_performing_content (90 jours) pour voir ce qui marche ; get_monthly_objectives pour la cadence prévue par réseau et le dernier plan de Rico Coach.
3. Regarde ce qui existe déjà : get_editorial_calendar sur le mois, get_content_ideas pour la réserve d'idées.
4. Propose la stratégie au client, en clair : 2 ou 3 objectifs, les thèmes de la semaine reliés aux piliers de la marque, le rythme par réseau, et la liste des sujets (en réutilisant les bonnes idées de la réserve).
5. Seulement après son accord : create_editorial_plan pour générer les contenus du mois (10 par appel), puis montre-lui get_pending_approvals.

${QUOTA}
${ACCORD}`,
  },
  {
    name: 'analyze_brand',
    title: 'Analyser la marque',
    description: 'Fait le point sur la marque : identité, voix, cohérence avec ce qui est publié, et propose des améliorations du profil.',
    arguments: [],
    texte: () => `Analyse la marque du client dans Postorico.

1. Lis le profil, la voix, la charte et les ressources : get_brand_profile, get_brand_voice, get_brand_guidelines, get_brand_assets.
2. Compare avec ce qui est réellement publié : get_publication_history (20 derniers) et get_best_performing_content.
3. Rends un diagnostic court : ce qui est clair et distinctif, ce qui est flou ou incohérent entre le profil et les posts, ce qui manque (exemples de posts par réseau, règles, appels à l'action…), et ce que les meilleurs posts disent de ce qui plaît.
4. Propose des formulations concrètes pour améliorer le profil (voix, piliers, à éviter…).
5. N'utilise update_brand_profile qu'après l'accord du client sur chaque champ, en lui montrant l'ancien et le nouveau texte.`,
  },
  {
    name: 'generate_weekly_content',
    title: 'Contenus de la semaine',
    description: 'Prépare les posts d’une semaine sur les réseaux du client, à faire valider avant programmation.',
    arguments: [
      { name: 'semaine', description: 'Semaine visée, ex. « du 16 au 22 novembre » (semaine prochaine par défaut).' },
      { name: 'reseaux', description: 'Réseaux visés, ex. « linkedin, instagram » (ceux connectés par défaut).' },
      { name: 'theme', description: 'Thème ou actualité à mettre en avant, facultatif.' },
    ],
    texte: (a) => `Prépare les contenus Postorico de la ${val(a.semaine, 'semaine prochaine')}${a.reseaux ? ` pour ${a.reseaux}` : ''}${a.theme ? `, autour de : ${a.theme}` : ''}.

1. Contexte : brand://voice, get_connected_social_accounts, get_monthly_objectives (cadence par réseau), get_editorial_calendar sur la semaine (pour ne pas doubler ce qui est déjà prévu).
2. Choisis les sujets : d'abord la réserve (get_content_ideas), sinon generate_content_ideas. Propose la liste au client (un sujet par créneau, avec le réseau et le format) et attends son accord.
3. Rédige : generate_social_post (ou approve_content_idea pour une idée de la réserve), generate_carousel quand le format s'y prête. Ajoute un visuel avec generate_image si le réseau en a besoin (Instagram l'exige).
4. Montre chaque texte au client. Applique ses retours avec request_content_revision ou improve_content.
5. Seulement quand il valide un texte : approve_content (prochain créneau libre) ou schedule_publication (date précise).

${QUOTA}
${ACCORD}`,
  },
  {
    name: 'analyze_social_performance',
    title: 'Analyser les performances',
    description: 'Analyse les performances des réseaux et en tire des recommandations concrètes.',
    arguments: [{ name: 'jours', description: 'Période analysée en jours (30 par défaut).' }],
    texte: (a) => `Analyse les performances des réseaux du client sur les ${val(a.jours, '30')} derniers jours.

1. Vue d'ensemble : get_social_analytics (période et comparaison avec la précédente), get_platform_statistics (par réseau).
2. Ce qui marche : get_best_performing_content (par taux d'engagement, puis par portée) ; lis les meilleurs avec get_content_details pour comprendre pourquoi (sujet, accroche, format).
3. Compare 2 à 4 contenus proches avec compare_content_performance si c'est utile.
4. Rends un bilan court et chiffré : tendances, réseau le plus porteur, formats et sujets gagnants, meilleurs créneaux, et ce qui ne marche pas.
5. Termine par 3 à 5 recommandations actionnables (sujets à refaire, formats à pousser, rythme), et propose de les transformer en idées (create_content_idea) si le client le souhaite.

Attention aux petits volumes : un taux d'engagement élevé sur quelques vues ne prouve rien, dis-le.`,
  },
  {
    name: 'repurpose_content',
    title: 'Décliner un contenu',
    description: 'Transforme un contenu existant en plusieurs formats et pour plusieurs réseaux.',
    arguments: [
      { name: 'contenu_id', description: 'Contenu à décliner (sinon, propose les meilleurs contenus récents).' },
      { name: 'formats', description: 'Formats voulus, ex. « carrousel, script vidéo, post Facebook » (à proposer sinon).' },
    ],
    texte: (a) => `Décline un contenu Postorico en plusieurs formats${a.contenu_id ? ` : le contenu ${a.contenu_id}` : ''}${a.formats ? `, en : ${a.formats}` : ''}.

1. ${a.contenu_id ? `Lis-le avec get_content_details (${a.contenu_id}).` : 'Choisis le contenu à décliner avec le client : propose les meilleurs récents (get_best_performing_content, puis get_content_details).'}
2. Propose les déclinaisons pertinentes : version adaptée à chaque autre réseau connecté (get_connected_social_accounts), carrousel, script de reel, post de fiche Google si l'actualité s'y prête. Attends le choix du client.
3. Produis : adapt_content_for_platform avec creer: true pour chaque réseau ; generate_carousel ; generate_video_script ; create_google_business_post.
4. Montre chaque version au client, ajuste avec request_content_revision.
5. Seulement après son accord : approve_content ou schedule_publication, en espaçant les publications (pas tout le même jour).

${QUOTA}
${ACCORD}`,
  },
  {
    name: 'prepare_publication',
    title: 'Préparer une série de publications',
    description: 'Passe en revue les contenus en attente, les fait finaliser et programme ceux que le client valide.',
    arguments: [{ name: 'periode', description: 'Période de publication visée, ex. « les deux prochaines semaines ».' }],
    texte: (a) => `Prépare une série de publications Postorico pour ${val(a.periode, 'les deux prochaines semaines')}.

1. Inventaire : get_pending_approvals (à valider et brouillons), get_publication_queue (déjà programmés, et ceux en échec), get_connected_social_accounts.
2. Pour chaque contenu en attente : montre le texte (get_content_details), vérifie qu'il a un visuel si son réseau en a besoin (generate_image sinon), propose des améliorations (improve_content, generate_hashtags) sans les appliquer d'office.
3. Corrige les échecs : get_content_status pour la raison ; retry_failed_publication si le réseau est bien connecté.
4. Présente au client un planning clair (date, réseau, titre) en évitant deux publications le même jour sur le même réseau.
5. Pour chaque contenu qu'il valide explicitement : approve_content ou schedule_publication. Ceux qu'il refuse : reject_content avec son motif.

${ACCORD}`,
  },
];

export const listePrompts = () => PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));

/** Messages d'un prompt, ou null si le nom est inconnu. */
export function lirePrompt(nom: string, args: Record<string, unknown>) {
  const p = PROMPTS.find((x) => x.name === nom);
  if (!p) return null;
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(args || {})) if (typeof v === 'string' || typeof v === 'number') a[k] = String(v).slice(0, 500);
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.texte(a) } }] };
}
