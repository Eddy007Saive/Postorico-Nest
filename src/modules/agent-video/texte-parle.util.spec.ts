import { dureeEstimee, texteParle } from './texte-parle.util';

describe('voix off : texte réellement dit', () => {
  it('script structuré : seules les répliques sont lues, sans titres ni minutages', () => {
    const script = [
      '### **00:00 - 00:03 : Le Hook (Accroche)**',
      '> « Attends, tu passes encore 10 heures par mois sur tes vidéos ? »',
      '>',
      '---',
      '**Visuel :** plan serré sur le téléphone',
      "### **00:51 - 01:00 : Appel à l'action**",
      '> « Contacte-moi et on en parle. »',
    ].join('\n');
    expect(texteParle(script)).toBe(
      'Attends, tu passes encore 10 heures par mois sur tes vidéos ?\nContacte-moi et on en parle.',
    );
  });

  it('texte simple : gardé tel quel, sans la mise en forme', () => {
    expect(
      texteParle(
        'Tu as franchi le cap des **100 biens** ?\nVoici comment passer au x10.',
      ),
    ).toBe(
      'Tu as franchi le cap des 100 biens ?\nVoici comment passer au x10.',
    );
  });

  it('durée estimée à 2,6 mots par seconde', () => {
    expect(dureeEstimee(Array(26).fill('mot').join(' '))).toBe(10);
  });
});
