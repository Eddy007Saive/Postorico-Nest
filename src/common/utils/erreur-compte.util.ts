/** Erreurs d'un fournisseur d'IA qui viennent de NOTRE compte chez lui (crédits épuisés,
 * clé refusée) : aucun nouvel essai ne les corrige, seul l'admin peut agir. */
export type ErreurCompte = 'credits' | 'cle';

export function erreurDeCompte(status: number | undefined, texte: string): ErreurCompte | null {
  const t = (texte || '').toLowerCase();
  if (
    status === 402 ||
    t.includes('credit balance is too low') ||
    t.includes('insufficient credits') ||
    t.includes('insufficient_quota') ||
    t.includes('purchase credits')
  ) {
    return 'credits';
  }
  if (status === 401 || t.includes('invalid x-api-key') || t.includes('invalid api key') || t.includes('authentication_error')) {
    return 'cle';
  }
  return null;
}
