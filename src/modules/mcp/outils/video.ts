/** Vidéo : reels animés (rendu Remotion) et vidéos montées par l'agent IA du VPS.
 * Les deux se rendent en arrière-plan : l'outil lance, get_video_status suit. */
import { Appel, Args, ErreurOutil, LECTURE, Outil, choisir, enc, entier, exiger, lireContenu, texte } from './commun';

/** Réseaux vidéo, tels que les routes reels et agent vidéo les attendent. */
const RESEAUX_VIDEO: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
};

function reseauVideo(v: unknown): string {
  const r = texte(v).toLowerCase() || 'instagram';
  const nom = RESEAUX_VIDEO[r];
  if (!nom) throw new ErreurOutil(`Réseau « ${r} » non pris en charge pour une vidéo. Possibles : ${Object.keys(RESEAUX_VIDEO).join(', ')}.`);
  return nom;
}

/** Liste d'URL (chaînes) ou d'objets { url, description }. */
function urls(v: unknown, max: number): Array<{ url: string; description?: string }> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ErreurOutil('Liste attendue (URL de la banque de médias, voir get_video_options).');
  return v
    .map((x) => (typeof x === 'string' ? { url: x.trim() } : { url: texte((x as Args)?.url), description: texte((x as Args)?.description) || undefined }))
    .filter((x) => x.url)
    .slice(0, max);
}

type Banque = { images?: Array<{ url: string; description?: string | null; type?: string | null; duree_s?: number | null }> };
const estVideo = (m: { url: string; type?: string | null }) => m.type === 'video' || m.url.includes('/video/upload/');

const SUIVI = 'Le rendu tourne en arrière-plan : suis-le avec get_video_status (toutes les 30 à 60 secondes), la vidéo arrive « À valider ».';

async function etatAgent(api: Appel, contenuId: string): Promise<Record<string, unknown> | null> {
  try {
    return (await api('GET', `/agent-video/contenu/${enc(contenuId)}`)) as Record<string, unknown>;
  } catch {
    return null; // pas un montage de l'agent (reel animé) : rien à ajouter
  }
}

export const OUTILS_VIDEO: Outil[] = [
  {
    name: 'get_video_options',
    title: 'Options vidéo',
    description:
      "Ce qu'il faut pour lancer une vidéo : modèles de reel (id, durée, usage), voix off disponibles, musiques de la bibliothèque, et les photos et vidéos de la banque de médias du client (seules sources acceptées pour images et clips). Ne consomme rien.",
    inputSchema: { type: 'object', properties: {} },
    annotations: LECTURE,
    executer: async (api) => {
      const [tpl, voix, banque] = await Promise.all([
        api('GET', '/reels/templates').catch(() => ({})) as Promise<{
          templates?: Array<Record<string, unknown>>;
          musiques?: Array<Record<string, unknown>>;
        }>,
        api('GET', '/reels/voix').catch(() => null) as Promise<Record<string, unknown> | null>,
        api('GET', '/reels/banque').catch(() => ({})) as Promise<Banque>,
      ]);
      const medias = banque.images || [];
      return {
        modeles_reel: (tpl.templates || []).map((t) => choisir(t, ['id', 'label', 'duree', 'desc', 'tags'])),
        voix: voix
          ? {
              disponible: voix.disponible,
              defaut: voix.defaut,
              choix: ((voix.voix as Array<Record<string, unknown>>) || []).map((v) => choisir(v, ['id', 'genre'])),
              voix_clonee: (voix.clone as Record<string, unknown>)?.existe ? 'moi' : null,
            }
          : null,
        musiques: (tpl.musiques || []).map((m) => choisir(m, ['id', 'label', 'category'])),
        banque_photos: medias.filter((m) => !estVideo(m)).map((m) => choisir(m, ['url', 'description'])),
        banque_videos: medias.filter(estVideo).map((m) => choisir(m, ['url', 'description', 'duree_s'])),
        note: "Les photos et vidéos s'ajoutent à la banque depuis Postorico (Studio Reel ou Banque de médias) ; une URL extérieure est refusée.",
      };
    },
  },
  {
    name: 'generate_reel',
    title: 'Créer un reel animé',
    description:
      "Crée un reel vidéo animé à la charte (textes animés, visuels, musique, voix off en option). Avec contenu_id : met en vidéo un post existant, selon le modèle choisi. Avec brief : reel libre sur ce sujet. Consomme 1 reel du quota (+ 1 voix off si voix est donné). Le rendu prend une à trois minutes en arrière-plan ; le reel arrive « À valider ».",
    inputSchema: {
      type: 'object',
      properties: {
        contenu_id: { type: 'string', description: 'Post existant à mettre en vidéo.' },
        brief: { type: 'string', description: 'Ou le sujet du reel libre (ce qu’il doit dire, à qui).' },
        modele: { type: 'string', description: "Modèle de reel (id de get_video_options, « sequence » par défaut). Avec contenu_id seulement ; un reel libre est toujours une séquence." },
        style: { type: 'string', description: 'Style de séquence (signature, cinema, editorial, impact, odyssee, vlog, carnet, avantapres, temoignage, conseils).' },
        reseau: { type: 'string', enum: Object.keys(RESEAUX_VIDEO), description: 'Réseau du reel libre (instagram par défaut).' },
        voix: { type: 'string', description: 'Voix off (id de get_video_options). Absente : pas de voix, musique seule. Modèles « sequence » uniquement.' },
        musique: { type: 'string', description: 'Musique (id de get_video_options).' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Photos de la banque à utiliser (URL), 8 au plus.' },
        plans_video: { type: 'boolean', description: 'Ajouter des plans vidéo d’illustration (vrai par défaut).' },
      },
    },
    journal: true,
    executer: async (api, args) => {
      const contenuId = texte(args.contenu_id);
      const brief = texte(args.brief);
      if (!contenuId && !brief) throw new ErreurOutil('Donne un contenu_id (post à mettre en vidéo) ou un brief (reel libre).');
      const images = urls(args.images, 8).map((i) => ({ url: i.url, desc: i.description }));
      const commun = {
        ...(images.length ? { images } : {}),
        ...(texte(args.style) ? { style: texte(args.style) } : {}),
        ...(texte(args.musique) ? { musique: texte(args.musique) } : {}),
        ...(texte(args.voix) ? { voix: texte(args.voix) } : {}),
        ...(typeof args.plans_video === 'boolean' ? { plans_video: args.plans_video } : {}),
      };
      const r = (contenuId
        ? await api('POST', '/reels/generer', { contenu_id: contenuId, template: texte(args.modele) || 'sequence', ...(brief ? { brief } : {}), ...commun })
        : await api('POST', '/reels/creer', { brief, reseau: reseauVideo(args.reseau), ...commun })) as Record<string, unknown>;
      return {
        contenu_id: r.id ?? contenuId ?? null,
        video_status: r.video_status ?? 'en_traitement',
        accroche: r.hook ?? null,
        reseau: r.reseau ?? null,
        date_publication: r.date_publication ?? null,
        note: SUIVI,
      };
    },
  },
  {
    name: 'generate_ai_video',
    title: "Faire monter une vidéo par l'agent IA",
    description:
      "Confie une vidéo à l'agent de montage IA (le plus abouti : coupes, sous-titres, illustrations, zooms, musique, logo). Deux modes : avec clips (vidéos de la banque du client) il monte ses rushes ; sans clips, avec script, il crée une vidéo motion design lue par la voix off. Consomme 1 vidéo agent du quota (le plus serré). Le montage prend 5 à 20 minutes ; la vidéo arrive « À valider ». Fais valider le script et les consignes par le client avant de lancer.",
    inputSchema: {
      type: 'object',
      properties: {
        clips: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Vidéos à monter (URL de banque_videos, get_video_options), 10 au plus.' },
        script: { type: 'string', description: 'Sans clips : le texte que la voix off lit (20 à 3 000 caractères).' },
        voix: { type: 'string', description: 'Voix off du mode script (id de get_video_options).' },
        consignes: { type: 'string', description: 'Ce que le montage doit donner : style, rythme, textes à l’écran, couleurs… (1 500 caractères au plus).' },
        reseau: { type: 'string', enum: Object.keys(RESEAUX_VIDEO), description: 'Réseau visé (instagram par défaut).' },
        format: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: '9:16 par défaut.' },
        duree_max_s: { type: 'integer', minimum: 5, maximum: 180, description: 'Durée maximale en secondes.' },
        illustrations: { type: 'boolean', description: 'Ajouter des illustrations (vrai par défaut).' },
        logo: { type: 'boolean', description: 'Afficher le logo de la marque (vrai par défaut).' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Photos de la banque à placer (URL).' },
        musique: { type: 'string', description: 'Musique (id de get_video_options).' },
      },
    },
    journal: true,
    executer: async (api, args) => {
      const clips = urls(args.clips, 10);
      const script = texte(args.script);
      if (!clips.length && !script) throw new ErreurOutil('Donne des clips (vidéos de la banque) ou un script pour une vidéo motion design.');
      const r = (await api('POST', '/agent-video', {
        mode: clips.length ? 'video' : 'motion',
        ...(clips.length ? { clips: clips.map((c) => ({ url: c.url })) } : { script }),
        ...(texte(args.voix) ? { voix: texte(args.voix) } : {}),
        ...(texte(args.consignes) ? { consignes: texte(args.consignes) } : {}),
        reseau: reseauVideo(args.reseau).toLowerCase(),
        ...(texte(args.format) ? { format: texte(args.format) } : {}),
        ...(args.duree_max_s !== undefined ? { duree_max_s: entier(args.duree_max_s, 60, 5, 180) } : {}),
        ...(typeof args.illustrations === 'boolean' ? { illustrations: args.illustrations } : {}),
        ...(typeof args.logo === 'boolean' ? { logo: args.logo } : {}),
        ...(Array.isArray(args.images) ? { images: urls(args.images, 10) } : {}),
        ...(texte(args.musique) ? { musique: texte(args.musique) } : {}),
      })) as { id?: string; contenu_id?: string; video_status?: string };
      return {
        contenu_id: r.contenu_id ?? null,
        montage_id: r.id ?? null,
        video_status: r.video_status ?? 'en_traitement',
        note: "Le montage tourne sur le serveur de l'agent (5 à 20 minutes) : suis-le avec get_video_status, toutes les une à deux minutes.",
      };
    },
  },
  {
    name: 'get_video_status',
    title: "Suivre une vidéo",
    description:
      "Où en est une vidéo (reel animé ou montage de l'agent) : en cours, prête (avec son lien) ou en échec. Pour un montage de l'agent : l'étape en cours et les corrections encore possibles.",
    inputSchema: { type: 'object', properties: { contenu_id: { type: 'string' } }, required: ['contenu_id'] },
    annotations: LECTURE,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const c = await lireContenu(api, id);
      const agent = await etatAgent(api, id);
      const vs = texte(c.video_status);
      const statut = agent ? texte(agent.statut) : vs;
      const pret = agent ? statut === 'termine' : vs === 'pret' || vs === 'ready';
      const echec = statut === 'echec';
      return {
        contenu_id: id,
        titre: c.titre ?? null,
        statut_contenu: c.statut ?? null,
        video: pret ? 'prete' : echec ? 'echec' : statut ? 'en_cours' : 'aucune',
        video_url: pret ? (agent?.video_url ?? c.video_url ?? null) : null,
        ...(agent
          ? choisir(agent, ['progression', 'erreur', 'resume', 'version', 'corrections_gratuites_restantes', 'correction_possible', 'erreur_correction'])
          : {}),
        ...(echec && !agent ? { erreur: ((c.reel_data as Args | null)?.erreur as string) ?? null } : {}),
        ...(pret ? { note: 'Fais-la regarder au client, puis approve_content pour la valider et la programmer.' } : {}),
      };
    },
  },
  {
    name: 'request_video_correction',
    title: 'Demander une correction de montage',
    description:
      "Demande à l'agent une nouvelle version d'un montage terminé (consignes de correction, autre musique, autres photos). Les premières corrections sont gratuites (voir corrections_gratuites_restantes dans get_video_status), les suivantes consomment 1 vidéo agent. Possible pendant environ 6 jours après la dernière version.",
    inputSchema: {
      type: 'object',
      properties: {
        contenu_id: { type: 'string' },
        consignes: { type: 'string', description: 'Ce qu’il faut changer (1 500 caractères au plus).' },
        musique: { type: 'string', description: 'Nouvelle musique (id), ou « none » pour la retirer.' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Photos de la banque à placer (URL).' },
      },
      required: ['contenu_id'],
    },
    journal: true,
    executer: async (api, args) => {
      const id = exiger(args, 'contenu_id');
      const consignes = texte(args.consignes);
      if (!consignes && !texte(args.musique) && !Array.isArray(args.images)) throw new ErreurOutil('Dis ce qu’il faut changer : consignes, musique ou images.');
      const agent = await etatAgent(api, id);
      if (!agent) throw new ErreurOutil("Ce contenu n'est pas un montage de l'agent IA : pour un reel animé, relance generate_reel.");
      if (!agent.correction_possible) throw new ErreurOutil('Ce montage ne peut pas être corrigé pour le moment (pas terminé, ou version trop ancienne).');
      await api('POST', `/agent-video/${enc(String(agent.id))}/corrections`, {
        ...(consignes ? { consignes } : {}),
        ...(texte(args.musique) ? { musique: texte(args.musique) } : {}),
        ...(Array.isArray(args.images) ? { images: urls(args.images, 10) } : {}),
      });
      return { contenu_id: id, video_status: 'en_traitement', note: "Nouvelle version en cours : suis-la avec get_video_status." };
    },
  },
];
