import { ratioRatcliffObershelp, tauxReecriture } from './similarite.util';

// Port des attentes de `_taux_reecriture` (backend/services/contenu_service.py) — valeurs de
// référence calculées avec difflib.SequenceMatcher sur des chaînes courtes (< 200 caractères,
// donc hors heuristique autojunk : parité exacte attendue).
describe('ratioRatcliffObershelp', () => {
  it('chaînes identiques -> 1', () => {
    expect(ratioRatcliffObershelp('bonjour', 'bonjour')).toBe(1);
  });

  it('rien en commun -> 0', () => {
    expect(ratioRatcliffObershelp('abc', 'xyz')).toBe(0);
  });

  it('deux chaînes vides -> 1 (convention difflib)', () => {
    expect(ratioRatcliffObershelp('', '')).toBe(1);
  });

  it('"abcd" vs "bcde" -> 0.75 (2*3/8, valeur difflib)', () => {
    expect(ratioRatcliffObershelp('abcd', 'bcde')).toBeCloseTo(0.75, 10);
  });

  it('est symétrique', () => {
    const a = 'Le dirigeant valide son post.';
    const b = 'Le dirigeant relit puis valide son post.';
    expect(ratioRatcliffObershelp(a, b)).toBeCloseTo(ratioRatcliffObershelp(b, a), 10);
  });
});

describe('tauxReecriture', () => {
  it('texte validé tel quel -> 0', () => {
    expect(tauxReecriture('Même texte', 'Même texte')).toBe(0);
  });

  it('texte totalement réécrit -> 1', () => {
    expect(tauxReecriture('abc', 'xyz')).toBe(1);
  });

  it('pas de contenu_original -> null (créé avant la migration, ou vidéo/reel/story)', () => {
    expect(tauxReecriture(null, 'texte')).toBeNull();
    expect(tauxReecriture(undefined, 'texte')).toBeNull();
    expect(tauxReecriture('', 'texte')).toBeNull();
  });

  it('texte final absent -> null', () => {
    expect(tauxReecriture('original', null)).toBeNull();
    expect(tauxReecriture('original', undefined)).toBeNull();
  });

  it('arrondi à 3 décimales : "abcd" vs "bcde" -> 0.25', () => {
    expect(tauxReecriture('abcd', 'bcde')).toBe(0.25);
  });

  it('retouche légère -> taux faible mais non nul', () => {
    const t = tauxReecriture('Un post LinkedIn sur la productivité.', 'Un post LinkedIn sur la productivité !');
    expect(t).not.toBeNull();
    expect(t as number).toBeGreaterThan(0);
    expect(t as number).toBeLessThan(0.1);
  });
});
