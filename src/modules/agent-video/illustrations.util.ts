/**
 * Illustrations préparées par Postorico avant l'agent du VPS. Une IA choisit les moments du propos
 * (même méthode que le POC, brolls_ai.py) et, pour chacun, la bonne forme :
 * - « broll » : un concept concret et filmable -> plan vidéo vertical trouvé sur Pexels ;
 * - « schema » : une idée abstraite (étapes, avant/après, chiffre, liste) -> petit schéma animé que
 *   l'agent dessine lui-même, d'après la description fournie.
 */
import type { Mot } from './pretraitement.util';

export const ILLUSTRATIONS_MAX = 5;
/** Écart minimal entre deux illustrations, pour laisser voir la personne qui parle. */
export const ECART_MIN_S = 4;

export type TypeIllustration = 'broll' | 'schema';

export interface Choix {
  i: number;
  type: TypeIllustration;
  /** broll : requête Pexels en anglais. schema : ce que le schéma montre, en français. */
  query: string;
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
): string {
  const numerotes = mots.map((m, i) => `${i}: ${m.text}`).join('\n');
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
    `Mélange les deux formes quand le propos s'y prête.\n\n` +
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
      return (
        (c?.type === undefined || c.type === 'broll' || c.type === 'schema') &&
        Number.isInteger(c?.i) &&
        (c.i as number) >= 0 &&
        (c.i as number) < mots.length &&
        typeof c.query === 'string' &&
        c.query.trim().length > 0
      );
    })
    .map((c): Choix => {
      const type: TypeIllustration = c.type === 'schema' ? 'schema' : 'broll';
      return {
        i: c.i,
        type,
        query: c.query.trim().slice(0, type === 'schema' ? 160 : 60),
      };
    })
    .sort((a, b) => a.i - b.i);
  const retenus: Choix[] = [];
  for (const c of valides) {
    const precedent = retenus[retenus.length - 1];
    if (precedent && mots[c.i].start - mots[precedent.i].start < ECART_MIN_S)
      continue;
    retenus.push(c);
  }
  return retenus.slice(0, max);
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
