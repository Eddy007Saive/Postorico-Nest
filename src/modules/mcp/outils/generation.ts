import { ImageRefusee, telechargerImage } from '../image-distante';
import {
  Appel, Contenu, dateFuture, dejaPublie, enc, entier, ErreurOutil, exiger, lireContenu, noteProgrammation, Outil,
  programmeChezReseau, PUBLIC, RESEAUX, RESEAUX_TEXTE, reseauValide, resume, texte, validerEtProgrammer,
} from './commun';
import { redigerDepuis } from './idees';

/** 03. Génération : le cœur de Postorico. */

const SOURCE = {
  contenu_id: { type: 'string', description: 'Id du contenu Postorico à retravailler.' },
  texte: { type: 'string', description: 'Ou un texte libre (sans contenu Postorico).' },
};

/** Texte à retravailler : celui du contenu, ou le texte libre donné. */
async function source(api: Appel, args: Record<string, unknown>): Promise<{ contenu: Contenu | null; texte: string; reseau: string }> {
  const id = texte(args.contenu_id);
  if (id) {
    const c = await lireContenu(api, id);
    const corps = texte(c.contenu);
    if (!corps) throw new ErreurOutil("Ce contenu n'a pas de texte.");
    return { contenu: c, texte: corps, reseau: texte(c.reseau_cible).toLowerCase() || 'linkedin' };
  }
  const libre = texte(args.texte);
  if (!libre) throw new ErreurOutil('Donne contenu_id, ou texte.');
  return { contenu: null, texte: libre, reseau: 'linkedin' };
}

/** Remplace le texte d'un contenu ; s'il est déjà programmé chez le réseau, la programmation suit. */
export async function enregistrerTexte(api: Appel, c: Contenu, nouveau: string): Promise<string> {
  if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié : son texte ne peut plus changer.');
  await api('PATCH', `/contenus/${enc(String(c.id))}`, { contenu: nouveau });
  if (programmeChezReseau(c)) {
    await api('POST', `/late/publier/${enc(String(c.id))}`).catch(() => undefined);
    return 'Texte enregistré et programmation mise à jour chez le réseau.';
  }
  return 'Texte enregistré dans le contenu.';
}

async function retoucher(api: Appel, args: Record<string, unknown>, action: string, reseauForce?: string) {
  const src = await source(api, args);
  const reseau = reseauForce || (texte(args.reseau) ? reseauValide(args.reseau) : src.reseau);
  const r = (await api('POST', '/agent/retravailler', { texte: src.texte, action, reseau, consigne: texte(args.consigne) || undefined })) as {
    texte?: string;
    hashtags?: string[];
  };
  return { src, reseau, r };
}

const ENREGISTRER = {
  type: 'boolean',
  description: "Avec contenu_id : remplace le texte du contenu par le résultat. Faux par défaut (le résultat est seulement proposé, à faire valider par le client).",
};

export const OUTILS_GENERATION: Outil[] = [
  {
    name: 'generate_social_post',
    title: 'Rédiger un post',
    description:
      "Rédige un post dans la voix de la marque (profil, piliers, exemples validés), à partir d'un sujet libre ou d'une idée de la réserve, et l'enregistre en brouillon dans Postorico. Consomme 1 post du quota. À faire relire au client avant approve_content.",
    inputSchema: {
      type: 'object',
      properties: {
        sujet: { type: 'string', description: 'Sujet, idée ou angle du post (une phrase ou quelques notes).' },
        idea_id: { type: 'string', description: "Ou l'id d'une idée de la réserve (get_content_ideas) : son texte et ses réglages sont repris." },
        reseau: { type: 'string', enum: RESEAUX, description: 'Réseau cible (linkedin par défaut).' },
      },
    },
    journal: true,
    executer: (api, args) => redigerDepuis(api, args),
  },
  {
    name: 'create_social_post',
    title: 'Créer un post avec le texte du client',
    description:
      "Enregistre un post dont le client fournit lui-même le texte, tel quel, sans IA et sans quota. Visuel facultatif : une image par son adresse https, ou le visuel automatique de Postorico (1 image du quota). Sans « programmer », le post attend sa validation ; avec, il est validé et programmé (publication réelle, accord explicite du client requis). Instagram exige un visuel.",
    inputSchema: {
      type: 'object',
      properties: {
        texte: { type: 'string', description: "Texte complet du post, tel qu'il sera publié." },
        reseau: { type: 'string', enum: RESEAUX_TEXTE, description: 'Réseau cible.' },
        titre: { type: 'string', description: 'Titre interne (facultatif).' },
        image_url: { type: 'string', description: "Adresse https d'une image (jpg, png, webp, gif ; 10 Mo au plus)." },
        visuel_auto: { type: 'boolean', description: 'Faire créer le visuel par Postorico avec la charte du client (ignoré si image_url est donnée).' },
        programmer: { type: 'boolean', description: 'Valider et programmer tout de suite (publication réelle). Faux par défaut.' },
        date_publication: { type: 'string', description: 'Avec programmer : date et heure ISO 8601. Absente : prochain créneau libre.' },
      },
      required: ['texte', 'reseau'],
    },
    annotations: PUBLIC,
    journal: true,
    executer: async (api, args) => {
      const corps = exiger(args, 'texte');
      if (corps.length > 5000) throw new ErreurOutil('Texte trop long (5 000 caractères au plus).');
      const reseau = reseauValide(args.reseau, RESEAUX_TEXTE);
      const imageUrl = texte(args.image_url);
      const visuelAuto = !imageUrl && args.visuel_auto === true;
      const programmer = args.programmer === true;
      if (texte(args.date_publication) && !programmer) throw new ErreurOutil("date_publication ne sert qu'avec programmer: true.");
      const date = texte(args.date_publication) ? dateFuture(args.date_publication) : undefined;
      if (reseau === 'instagram' && !imageUrl && !visuelAuto) throw new ErreurOutil('Instagram exige un visuel : donne image_url, ou visuel_auto: true.');
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
        form.append('file', new Blob([new Uint8Array(image.octets)], { type: image.type }), `visuel.${image.type.split('/')[1].replace('jpeg', 'jpg')}`);
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
        return { ...resume(await lireContenu(api, id), true), note: ["Enregistré « À valider » : rien ne part tant qu'il n'est pas approuvé (approve_content).", ...notes].join(' ') };
      }
      const r = await validerEtProgrammer(api, id, date);
      notes.unshift(visuelAuto && r.date_publication ? 'Validé et programmé : il partira dès que le visuel automatique sera prêt.' : noteProgrammation(r));
      return { ...resume(r, true), note: notes.join(' ') };
    },
  },
  {
    name: 'generate_carousel',
    title: 'Créer un carrousel',
    description:
      "Crée un carrousel (slides rédigées dans la voix de la marque puis mises en page à la charte) et l'enregistre « À valider » avec un créneau. Consomme 1 carrousel du quota. Le rendu prend jusqu'à une minute.",
    inputSchema: {
      type: 'object',
      properties: {
        sujet: { type: 'string', description: 'Sujet du carrousel.' },
        idea_id: { type: 'string', description: "Ou l'id d'une idée de la réserve." },
        reseau: { type: 'string', enum: ['linkedin', 'instagram', 'facebook'], description: 'Réseau (linkedin par défaut).' },
        nb_slides: { type: 'integer', minimum: 3, maximum: 10, description: 'Nombre de slides (5 par défaut).' },
      },
    },
    journal: true,
    executer: async (api, args) => {
      const reseau = reseauValide(args.reseau, ['linkedin', 'instagram', 'facebook'], 'linkedin');
      let sujet = texte(args.sujet);
      let dimensions: unknown;
      if (texte(args.idea_id)) {
        const s = ((await api('GET', '/agent/sujets')) as Array<{ id: string; titre: string; dimensions: unknown }>).find((x) => x.id === texte(args.idea_id));
        if (!s) throw new ErreurOutil('Idée introuvable : vérifie son id avec get_content_ideas.');
        sujet = sujet || s.titre;
        dimensions = s.dimensions ?? undefined;
      }
      if (!sujet) throw new ErreurOutil('Donne un sujet, ou un idea_id.');
      const r = (await api('POST', '/agent/carrousel', { sujet, reseau, nb_slides: entier(args.nb_slides, 5, 3, 10), ...(dimensions ? { dimensions } : {}) })) as {
        contenu_id?: string;
        slides_images?: string[];
        carrousel_pdf?: string;
        quota?: unknown;
        content?: { legende?: string };
      };
      if (texte(args.idea_id) && r.contenu_id) await api('DELETE', `/agent/sujets/${enc(texte(args.idea_id))}`).catch(() => undefined);
      return {
        contenu_id: r.contenu_id ?? null,
        statut: 'A valider',
        legende: r.content?.legende ?? null,
        slides: r.slides_images ?? [],
        pdf: r.carrousel_pdf ?? null,
        quota: r.quota,
        ...(r.slides_images?.length ? {} : { note: "Le texte est prêt mais la mise en page n'a pas abouti : régénère le visuel depuis Postorico." }),
      };
    },
  },
  {
    name: 'generate_image',
    title: 'Créer un visuel',
    description:
      "Crée un visuel. Sans description et avec contenu_id : le visuel automatique de Postorico (il choisit la mise en page de la marque d'après le texte, environ une minute, en arrière-plan). Avec description : une image générée d'après la description, à la charte. hd: true = haute définition (quota HD, plus serré). Consomme 1 image du quota.",
    inputSchema: {
      type: 'object',
      properties: {
        contenu_id: { type: 'string', description: 'Contenu auquel joindre le visuel (recommandé).' },
        description: { type: 'string', description: "Ce que l'image doit montrer. Absente : visuel automatique (contenu_id requis)." },
        hd: { type: 'boolean', description: 'Haute définition (faux par défaut).' },
      },
    },
    journal: true,
    executer: async (api, args) => {
      const id = texte(args.contenu_id);
      const description = texte(args.description);
      if (id) {
        const c = await lireContenu(api, id);
        if (dejaPublie(c)) throw new ErreurOutil('Ce contenu est déjà publié.');
      }
      if (!description) {
        if (!id) throw new ErreurOutil('Donne une description, ou un contenu_id pour le visuel automatique.');
        await api('POST', '/agent/visuel-auto', { contenu_id: id });
        return { contenu_id: id, en_cours: true, note: 'Visuel automatique lancé : il sera joint au contenu dans environ une minute (lire avec get_content_details).' };
      }
      const r = (await api('POST', '/agent/image', { prompt: description.slice(0, 2000), modele: args.hd === true ? 'nano3' : 'nano2', ...(id ? { contenu_id: id } : {}) })) as {
        lien_visuel?: string;
        quota?: unknown;
      };
      return { image: r.lien_visuel ?? null, ...(id ? { contenu_id: id, joint_au_contenu: true } : {}), quota: r.quota };
    },
  },
  {
    name: 'generate_video_script',
    title: 'Écrire un script vidéo',
    description: "Écrit le script d'une vidéo courte (reel, short…) dans la voix de la marque et l'enregistre en brouillon. Consomme 1 post du quota.",
    inputSchema: {
      type: 'object',
      properties: {
        sujet: { type: 'string' },
        idea_id: { type: 'string', description: "Ou l'id d'une idée de la réserve." },
        type_video: { type: 'string', enum: ['Reel', 'Short', 'Video', 'Interview'], description: 'Reel par défaut.' },
        reseau: { type: 'string', enum: ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin'], description: 'Instagram par défaut.' },
      },
    },
    journal: true,
    executer: async (api, args) => {
      let sujet = texte(args.sujet);
      if (texte(args.idea_id)) {
        const s = ((await api('GET', '/agent/sujets')) as Array<{ id: string; titre: string }>).find((x) => x.id === texte(args.idea_id));
        if (!s) throw new ErreurOutil('Idée introuvable : vérifie son id avec get_content_ideas.');
        sujet = sujet || s.titre;
      }
      if (!sujet) throw new ErreurOutil('Donne un sujet, ou un idea_id.');
      const reseau = reseauValide(args.reseau, ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin'], 'instagram');
      const type = ['Reel', 'Short', 'Video', 'Interview'].includes(texte(args.type_video)) ? texte(args.type_video) : 'Reel';
      const r = (await api('POST', '/agent/script', { sujet, type_video: type, reseau, brouillon: true })) as Record<string, unknown>;
      return { contenu_id: r.contenu_id ?? null, statut: 'Brouillon', script: r.script, ...(r.titre ? { titre: r.titre } : {}), quota: r.quota };
    },
  },
  {
    name: 'rewrite_content',
    title: 'Réécrire un texte',
    description: "Réécrit un post avec une autre formulation, même message, dans la voix de la marque. Gratuit (40 retouches par heure). consigne : précision facultative (« plus court », « plus personnel »…).",
    inputSchema: { type: 'object', properties: { ...SOURCE, consigne: { type: 'string' }, enregistrer: ENREGISTRER } },
    journal: true,
    executer: async (api, args) => {
      const { src, r } = await retoucher(api, args, texte(args.consigne) ? 'reviser' : 'reecrire');
      const note = src.contenu && args.enregistrer === true ? await enregistrerTexte(api, src.contenu, r.texte!) : 'Proposition seulement : rien n’est modifié.';
      return { texte: r.texte, note };
    },
  },
  {
    name: 'improve_content',
    title: 'Améliorer un texte',
    description: "Améliore un post sans en changer le message : accroche plus forte, structure plus claire, phrases resserrées, fin naturelle. Gratuit (40 retouches par heure).",
    inputSchema: { type: 'object', properties: { ...SOURCE, consigne: { type: 'string', description: 'Point à améliorer en priorité (facultatif).' }, enregistrer: ENREGISTRER } },
    journal: true,
    executer: async (api, args) => {
      const { src, r } = await retoucher(api, args, 'ameliorer');
      const note = src.contenu && args.enregistrer === true ? await enregistrerTexte(api, src.contenu, r.texte!) : 'Proposition seulement : rien n’est modifié.';
      return { texte: r.texte, note };
    },
  },
  {
    name: 'adapt_content_for_platform',
    title: 'Adapter à un autre réseau',
    description:
      "Adapte un post à un autre réseau (longueur, ton, conventions). Avec contenu_id et creer: true, crée la version pour ce réseau dans Postorico (copie avec le visuel, « À valider », sur un créneau libre de ce réseau). Gratuit (40 retouches par heure).",
    inputSchema: {
      type: 'object',
      properties: {
        ...SOURCE,
        reseau_cible: { type: 'string', enum: RESEAUX_TEXTE, description: 'Réseau visé.' },
        creer: { type: 'boolean', description: 'Avec contenu_id : créer la version adaptée dans Postorico. Faux par défaut.' },
      },
      required: ['reseau_cible'],
    },
    journal: true,
    executer: async (api, args) => {
      const cible = reseauValide(args.reseau_cible, RESEAUX_TEXTE);
      const { src, r } = await retoucher(api, args, 'adapter', cible);
      if (!(src.contenu && args.creer === true)) return { reseau: cible, texte: r.texte, note: 'Proposition seulement : rien n’est créé.' };
      if (src.reseau === cible) throw new ErreurOutil('Ce contenu est déjà pour ce réseau : utilise improve_content.');
      const rec = (await api('POST', `/contenus/${enc(String(src.contenu.id))}/recycler`, { reseaux: [cible] })) as {
        created?: Array<{ id: string; reseau: string; date_publication: string | null }>;
      };
      const copie = rec.created?.[0];
      if (!copie) throw new ErreurOutil("La version pour ce réseau n'a pas pu être créée.");
      await api('PATCH', `/contenus/${enc(copie.id)}`, { contenu: r.texte });
      return { contenu_id: copie.id, reseau: cible, statut: 'A valider', date_publication: copie.date_publication, texte: r.texte };
    },
  },
  {
    name: 'generate_hashtags',
    title: 'Proposer des hashtags',
    description: "Propose 5 à 12 hashtags adaptés au post et à la marque. Avec contenu_id et ajouter: true, les ajoute à la fin du texte. Gratuit (40 retouches par heure).",
    inputSchema: {
      type: 'object',
      properties: { ...SOURCE, reseau: { type: 'string', enum: RESEAUX }, ajouter: { type: 'boolean', description: 'Avec contenu_id : ajouter les hashtags au texte. Faux par défaut.' } },
    },
    journal: true,
    executer: async (api, args) => {
      const { src, r } = await retoucher(api, args, 'hashtags');
      const tags = r.hashtags ?? [];
      if (!(src.contenu && args.ajouter === true && tags.length)) return { hashtags: tags };
      const note = await enregistrerTexte(api, src.contenu, `${src.texte}\n\n${tags.join(' ')}`);
      return { hashtags: tags, note };
    },
  },
];
