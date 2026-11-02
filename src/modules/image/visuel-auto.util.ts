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
  commande: string;
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
  const commande = typeof o.commande === 'string' ? o.commande.trim() : '';
  if (!commande) return null;
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
  return { gabarit, inspirations, commande: commande.slice(0, 3000) };
}
