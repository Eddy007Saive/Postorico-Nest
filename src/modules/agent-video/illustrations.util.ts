/**
 * Illustrations préparées par Postorico avant l'agent du VPS. Une IA choisit les moments du propos
 * (même méthode que le POC, brolls_ai.py) et, pour chacun, la bonne forme :
 * - « broll » : un concept concret et filmable -> plan vidéo vertical trouvé sur Pexels ;
 * - « schema » : une idée abstraite (étapes, avant/après, chiffre, liste) -> petit schéma animé que
 *   l'agent dessine lui-même, d'après la description fournie ;
 * - « client » : une vidéo de la banque du client (ses propres plans de coupe), préférée aux
 *   plans Pexels là où elle colle au propos. Chaque vidéo choisie par le client sert au moins une fois.
 */
import type { Mot } from './pretraitement.util';

export const ILLUSTRATIONS_MAX = 5;
/** Écart minimal entre deux illustrations, pour laisser voir la personne qui parle. */
export const ECART_MIN_S = 4;

export type TypeIllustration = 'broll' | 'schema';

/** Une vidéo de la banque du client, à placer en plan de coupe. */
export interface ClipClient {
  url: string;
  description?: string | null;
}

export interface Choix {
  i: number;
  type: TypeIllustration | 'client';
  /** broll : requête Pexels en anglais. schema : ce que le schéma montre, en français. client : ce que montre le plan. */
  query: string;
  /** client : numéro de la vidéo du client (à partir de 1). */
  clip?: number;
}

export interface Illustration {
  type: TypeIllustration;
  /** Plan vidéo (broll) ; absent pour un schéma, que l'agent dessine. */
  url?: string;
  rush: number;
  debut: number;
  duree: number;
  description: string;
}

export function consigneMoments(
  mots: Mot[],
  langue: string,
  max = ILLUSTRATIONS_MAX,
  opts: { clips?: ClipClient[]; stock?: boolean } = {},
): string {
  const numerotes = mots.map((m, i) => `${i}: ${m.text}`).join('\n');
  const clips = opts.clips || [];
  if (opts.stock === false) {
    // Illustrations désactivées : seulement les vidéos du client, rien de Pexels ni de schéma.
    return (
      `Voici la transcription d'une vidéo face caméra pour les réseaux sociaux, un mot numéroté par ligne ` +
      `(langue : ${langue}). Le client fournit ses propres vidéos de plans de coupe :\n` +
      clips.map((c, k) => `${k + 1}. ${c.description || 'vidéo sans description'}`).join('\n') +
      `\nPlace CHAQUE vidéo une fois, sur le moment où elle colle le mieux au propos, jamais sur la toute ` +
      `première phrase ni sur la dernière, et espace-les d'au moins 6 secondes.\n\n` +
      `Réponds uniquement en JSON : {"picks":[{"i":12,"type":"client","clip":1,"query":"ce que montre la vidéo"}]}\n\n` +
      numerotes
    );
  }
  const blocClips = clips.length
    ? `- "client" : une des VIDÉOS DU CLIENT ci-dessous, ses propres plans de coupe. Préfère-les à "broll" ` +
      `quand le passage s'y prête, et place CHAQUE vidéo du client au moins une fois (champ "clip" = son numéro) :\n` +
      clips.map((c, k) => `  ${k + 1}. ${c.description || 'vidéo sans description'}`).join('\n') +
      '\n'
    : '';
  return (
    `Voici la transcription d'une vidéo face caméra pour les réseaux sociaux, un mot numéroté par ligne ` +
    `(langue : ${langue}). Choisis entre 2 et ${max} moments où une illustration renforcerait le ` +
    `propos, jamais sur la toute première phrase (l'accroche) ni sur la dernière (l'appel à l'action) : ` +
    `là, on reste sur la personne. Espace-les d'au ` +
    `moins 6 secondes. Pour chacun, le numéro du mot concerné et la forme :\n` +
    `- "broll" si le passage évoque quelque chose de CONCRET et filmable (objet, lieu, action, métier) : ` +
    `une requête de recherche COURTE EN ANGLAIS (2 à 4 mots) pour une banque de vidéos (Pexels) ;\n` +
    `- "schema" si le passage est une idée abstraite qui se dessine (étapes d'une méthode, avant/après, ` +
    `chiffre clé, liste, comparaison) : en une phrase, ce que le petit schéma montre, avec ses mots ` +
    `exacts écrits DANS LA LANGUE DE LA VIDÉO (${langue}), car ils s'affichent à l'écran ` +
    `(ex. en français « 3 étapes : Comprendre → Analyser → Construire »).\n` +
    blocClips +
    `Mélange les formes quand le propos s'y prête.\n\n` +
    `Réponds uniquement en JSON : {"picks":[{"i":12,"type":"broll","query":"team meeting office"},` +
    `{"i":40,"type":"schema","query":"3 étapes : Comprendre → Analyser → Construire"}]}\n\n` +
    numerotes
  );
}

/** Lit la réponse de l'IA ; ignore tout choix invalide, en double ou trop proche du précédent. */
export function lireChoix(
  texte: string,
  mots: Mot[],
  max = ILLUSTRATIONS_MAX,
  nbClips = 0,
): Choix[] {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut < 0 || fin <= debut) return [];
  let picks: unknown;
  try {
    picks = (JSON.parse(texte.slice(debut, fin + 1)) as { picks?: unknown })
      .picks;
  } catch {
    return [];
  }
  if (!Array.isArray(picks)) return [];
  const valides = picks
    .filter((p): p is Choix => {
      const c = p as Partial<Choix>;
      const clipOk = c?.type !== 'client' || (Number.isInteger(c.clip) && (c.clip as number) >= 1 && (c.clip as number) <= nbClips);
      return (
        (c?.type === undefined || c.type === 'broll' || c.type === 'schema' || c.type === 'client') &&
        clipOk &&
        Number.isInteger(c?.i) &&
        (c.i as number) >= 0 &&
        (c.i as number) < mots.length &&
        (c.type === 'client' || (typeof c.query === 'string' && c.query.trim().length > 0))
      );
    })
    .map((c): Choix => {
      if (c.type === 'client')
        return { i: c.i, type: 'client', clip: c.clip, query: String(c.query || '').trim().slice(0, 120) };
      const type: TypeIllustration = c.type === 'schema' ? 'schema' : 'broll';
      return {
        i: c.i,
        type,
        query: c.query.trim().slice(0, type === 'schema' ? 160 : 60),
      };
    })
    .sort((a, b) => a.i - b.i);
  const retenus: Choix[] = [];
  const clipsPris = new Set<number>();
  for (const c of valides) {
    if (c.type === 'client' && clipsPris.has(c.clip as number)) continue;
    const precedent = retenus[retenus.length - 1];
    if (precedent && mots[c.i].start - mots[precedent.i].start < ECART_MIN_S)
      continue;
    retenus.push(c);
    if (c.type === 'client') clipsPris.add(c.clip as number);
  }
  // Les vidéos du client passent avant le plafond : on garde toutes les siennes.
  const clientes = retenus.filter((c) => c.type === 'client');
  const autres = retenus.filter((c) => c.type !== 'client').slice(0, Math.max(0, max - clientes.length));
  return [...clientes, ...autres].sort((a, b) => a.i - b.i);
}

/**
 * Les vidéos du client que l'IA n'a pas placées : posées sur des moments libres, répartis entre
 * 15 % et 85 % de la vidéo (ni l'accroche ni l'appel à l'action), à distance des autres plans.
 * Une vidéo sans place libre est posée au plus loin des autres, pour qu'aucune ne soit oubliée.
 */
export function placerClipsRestants(choix: Choix[], mots: Mot[], nbClips: number): Choix[] {
  if (!nbClips || !mots.length) return choix;
  const pris = new Set(choix.filter((c) => c.type === 'client').map((c) => c.clip));
  const manquants = Array.from({ length: nbClips }, (_, k) => k + 1).filter((n) => !pris.has(n));
  const out = [...choix];
  const duree = mots[mots.length - 1].end || mots[mots.length - 1].start;
  for (const [k, clip] of manquants.entries()) {
    const cible = duree * (0.15 + (0.7 * (k + 1)) / (manquants.length + 1));
    const candidats = mots
      .map((m, i) => ({ i, t: m.start }))
      .filter(({ t }) => t >= duree * 0.15 && t <= duree * 0.85);
    if (!candidats.length) continue;
    const distance = (t: number) => Math.min(...out.map((c) => Math.abs(mots[c.i].start - t)), Infinity);
    const libres = candidats.filter(({ t }) => distance(t) >= ECART_MIN_S);
    const parmi = libres.length ? libres : candidats;
    parmi.sort((a, b) => (libres.length ? Math.abs(a.t - cible) - Math.abs(b.t - cible) : distance(b.t) - distance(a.t)));
    out.push({ i: parmi[0].i, type: 'client', clip, query: '' });
  }
  return out.sort((a, b) => a.i - b.i);
}

/** Le passage où tombe l'illustration (quelques mots autour), pour guider l'agent. */
export function contexte(mots: Mot[], i: number): string {
  return mots
    .slice(Math.max(0, i - 4), i + 5)
    .map((m) => m.text)
    .join(' ');
}

interface FichierPexels {
  link?: string;
  width?: number;
  height?: number;
  file_type?: string;
}

/** Le fichier vidéo le plus proche de 1080 de large, sans agrandir si possible. */
export function meilleurFichier(
  fichiers: FichierPexels[],
  largeurCible = 1080,
): string | null {
  const mp4 = fichiers.filter(
    (f) =>
      f.link &&
      f.width &&
      f.height &&
      (!f.file_type || f.file_type === 'video/mp4'),
  );
  if (!mp4.length) return null;
  mp4.sort(
    (a, b) =>
      Number((a.width as number) < largeurCible) -
        Number((b.width as number) < largeurCible) ||
      Math.abs((a.width as number) - largeurCible) -
        Math.abs((b.width as number) - largeurCible),
  );
  return mp4[0].link as string;
}
