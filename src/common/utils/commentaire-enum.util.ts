/**
 * Traduction label brut <-> nom d'enum Prisma pour `statut_commentaire`, même besoin et
 * même piège que `contenu-enum.util.ts` (voir son en-tête) : Postgres stocke des libellés
 * avec espaces/accents, Prisma exige le nom mappé en écriture et le renvoie tel quel en
 * lecture. Deux libellés distincts existent pour « escalader » (une variante sans accent,
 * une avec) — reflet fidèle des deux membres réels de l'enum, pas une redondance à corriger.
 */

const STATUT_VERS_ENUM: Record<string, string> = {
  Nouveau: 'Nouveau',
  Rèpondu: 'R_pondu',
  'A escalader': 'A_escalader',
  Ignore: 'Ignore',
  'Reponse manuelle': 'Reponse_manuelle',
  'À escalader': 'escalader',
};
const STATUT_VERS_LABEL: Record<string, string> = Object.fromEntries(Object.entries(STATUT_VERS_ENUM).map(([label, enumVal]) => [enumVal, label]));

export function normStatutCommentaire(label: string): string {
  return STATUT_VERS_ENUM[label] ?? label;
}

export function labelStatutCommentaire<T extends string | null | undefined>(enumVal: T): T {
  if (enumVal == null) return enumVal;
  return (STATUT_VERS_LABEL[enumVal] ?? enumVal) as T;
}
