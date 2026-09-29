/**
 * Traduction entre les libellés bruts de la base (ce que Python écrit/lit tel quel via
 * Supabase, et ce que parle le frontend React partout — filtres, affichage, PATCH) et les
 * noms TS des enums Prisma `statut_contenu`/`type_contenu` (mappés via `@map` dès que le
 * libellé Postgres contient un espace, Prisma n'acceptant pas d'espace dans un nom de membre).
 *
 * Sans cette traduction aux deux bornes de l'API :
 * - en ÉCRITURE (filtre `WHERE statut = ...`, ou `data.statut = ...`), Prisma rejette le
 *   libellé brut ("A valider") — seul le nom mappé ("A_valider") est un membre valide ;
 * - en LECTURE, Prisma renvoie le nom mappé ("A_valider") alors que le frontend compare
 *   `contenu.statut === 'A valider'` — la comparaison échoue silencieusement.
 * Bug réel trouvé en test live sur `contenus` (2026-09-26) et confirmé déjà présent dans
 * `image.controller.ts` (`out.statut = cur?.statut`, jamais retraduit).
 */

const STATUT_VERS_ENUM: Record<string, string> = {
  'A valider': 'A_valider',
  Valider: 'Valider',
  Planifie: 'Planifie',
  'Pret a publier': 'Pret_a_publier',
  Publie: 'Publie',
  Refuse: 'Refuse',
  'A tourner': 'A_tourner',
};
const STATUT_VERS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(STATUT_VERS_ENUM).map(([label, enumVal]) => [enumVal, label]),
);

const TYPE_VERS_ENUM: Record<string, string> = {
  'Post court': 'Post_court',
  'Post long': 'Post_long',
  Video: 'Video',
  Carrousel: 'Carrousel',
  Reel: 'Reel',
  Short: 'Short',
  'Post moyen': 'Post_moyen',
  Story: 'Story',
};
const TYPE_VERS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_VERS_ENUM).map(([label, enumVal]) => [enumVal, label]),
);

/** Libellé brut (venant d'un filtre/PATCH client) -> nom d'enum Prisma, pour écrire ou filtrer. */
export function normStatutContenu(label: string): string {
  return STATUT_VERS_ENUM[label] ?? label;
}

/** Nom d'enum Prisma (venant d'une lecture) -> libellé brut, pour répondre au client. */
export function labelStatutContenu<T extends string | null | undefined>(enumVal: T): T {
  if (enumVal == null) return enumVal;
  return (STATUT_VERS_LABEL[enumVal] ?? enumVal) as T;
}

export function normTypeContenu(label: string): string {
  return TYPE_VERS_ENUM[label] ?? label;
}

export function labelTypeContenu<T extends string | null | undefined>(enumVal: T): T {
  if (enumVal == null) return enumVal;
  return (TYPE_VERS_LABEL[enumVal] ?? enumVal) as T;
}

/** Retraduit `statut`/`type` (si présents) d'une ligne `contenu` avant de la renvoyer au
 * client — à appeler sur toute réponse HTTP qui expose une ligne (ou un sous-ensemble de
 * champs) lue depuis la table `contenu`. */
export function delabeliserContenu<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  if (typeof out.statut === 'string') out.statut = labelStatutContenu(out.statut);
  if (typeof out.type === 'string') out.type = labelTypeContenu(out.type);
  return out as T;
}
