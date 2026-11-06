/** Règles pures du visuel automatique (sans réseau), testées à part. */

/** Gabarits et inspirations montrés à Claude : au-delà, le choix se dilue et l'appel coûte plus. */
export const MAX_GABARITS = 8;
export const MAX_INSPIRATIONS = 8;
/** Inspirations envoyées au générateur avec le visuel. */
export const MAX_INSPIRATIONS_CHOISIES = 3;

export interface Direction {
  /** Numéro du gabarit choisi (1…n), 0 = aucun. */
  gabarit: number;
  /** Numéros des inspirations choisies (1…n), sans doublon. */
  inspirations: number[];
  /** Sans gabarit : la description complète de l'image. Avec gabarit : vide ou complément. */
  commande: string;
  /** Avec gabarit : la photo NEUVE à mettre dans le cadre photo du gabarit. */
  scene?: string;
  /** Avec gabarit : titre et sous-titre exacts à afficher aux emplacements du gabarit. */
  titre?: string;
  sous_titre?: string;
}

/** Lit la réponse de Claude : un objet JSON, éventuellement entouré de texte ou d'une clôture
 * ```json. Les numéros hors limites sont écartés. null si la commande manque. */
export function lireDirection(
  texte: string,
  nbGabarits: number,
  nbInspirations: number,
): Direction | null {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut < 0 || fin <= debut) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(texte.slice(debut, fin + 1));
  } catch {
    return null;
  }
  if (!brut || typeof brut !== 'object') return null;
  const o = brut as Record<string, unknown>;
  const lire = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const commande = lire(o.commande, 3000);
  const scene = lire(o.scene, 2000);
  if (!commande && !scene) return null;
  const g = Math.trunc(Number(o.gabarit));
  const gabarit = Number.isFinite(g) && g >= 1 && g <= nbGabarits ? g : 0;
  const inspirations: number[] = [];
  for (const v of Array.isArray(o.inspirations) ? o.inspirations : []) {
    const n = Math.trunc(Number(v));
    if (
      Number.isFinite(n) &&
      n >= 1 &&
      n <= nbInspirations &&
      !inspirations.includes(n)
    )
      inspirations.push(n);
    if (inspirations.length >= MAX_INSPIRATIONS_CHOISIES) break;
  }
  const titre = lire(o.titre, 140);
  const sousTitre = lire(o.sous_titre, 220);
  return {
    gabarit,
    inspirations,
    // Sans gabarit, la scène sert de commande si Claude n'en a pas écrit d'autre
    commande: commande || scene,
    ...(scene ? { scene } : {}),
    ...(titre ? { titre } : {}),
    ...(sousTitre ? { sous_titre: sousTitre } : {}),
  };
}
