/**
 * Similarité de chaînes — port de `difflib.SequenceMatcher(None, a, b).ratio()` (Python),
 * utilisé par `_taux_reecriture` (backend/services/contenu_service.py) pour la mesure H2.
 *
 * Algorithme de Ratcliff/Obershelp : ratio = 2 * M / (len(a) + len(b)), où M est le nombre
 * de caractères appariés en prenant récursivement la plus longue sous-chaîne commune.
 *
 * Divergence assumée : Python ajoute une heuristique « autojunk » (caractères très fréquents
 * ignorés comme points d'ancrage) dès que la chaîne la plus longue dépasse 200 caractères.
 * Elle n'est pas reproduite ici — sur un post long, la 3e décimale peut différer de la
 * valeur Python. La mesure reste comparable d'un contenu à l'autre, ce qui est tout ce que
 * le tableau Verdict H2 exige.
 */

interface Bloc {
  i: number;
  j: number;
  taille: number;
}

/** Plus longue sous-chaîne commune entre a[aLo:aHi] et b[bLo:bHi] (programmation dynamique
 * sur une seule ligne glissante — O(n*m) temps, O(m) mémoire). */
function plusLongBloc(a: string, aLo: number, aHi: number, b: string, bLo: number, bHi: number): Bloc {
  let meilleur: Bloc = { i: aLo, j: bLo, taille: 0 };
  let prev = new Int32Array(bHi - bLo + 1);
  let cur = new Int32Array(bHi - bLo + 1);
  for (let i = aLo; i < aHi; i++) {
    const ca = a.charCodeAt(i);
    for (let j = bLo; j < bHi; j++) {
      const k = j - bLo + 1;
      if (ca === b.charCodeAt(j)) {
        const t = prev[k - 1] + 1;
        cur[k] = t;
        if (t > meilleur.taille) meilleur = { i: i - t + 1, j: j - t + 1, taille: t };
      } else {
        cur[k] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return meilleur;
}

function caracteresApparies(a: string, aLo: number, aHi: number, b: string, bLo: number, bHi: number): number {
  if (aLo >= aHi || bLo >= bHi) return 0;
  const bloc = plusLongBloc(a, aLo, aHi, b, bLo, bHi);
  if (bloc.taille === 0) return 0;
  return (
    bloc.taille +
    caracteresApparies(a, aLo, bloc.i, b, bLo, bloc.j) +
    caracteresApparies(a, bloc.i + bloc.taille, aHi, b, bloc.j + bloc.taille, bHi)
  );
}

/** Équivalent de `difflib.SequenceMatcher(None, a, b).ratio()` : 1 = identiques, 0 = rien en commun. */
export function ratioRatcliffObershelp(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * caracteresApparies(a, 0, a.length, b, 0, b.length)) / total;
}

/** Port de `_taux_reecriture` : 0 = texte validé tel quel, proche de 1 = quasi totalement
 * réécrit. null si pas de base de comparaison (contenu_original absent — créé avant la
 * migration, ou format hors périmètre : vidéo, reel, story). Arrondi à 3 décimales. */
export function tauxReecriture(original: string | null | undefined, final: string | null | undefined): number | null {
  if (!original || final === null || final === undefined) return null;
  const ratio = ratioRatcliffObershelp(original, final);
  return Math.round((1 - ratio) * 1000) / 1000;
}
