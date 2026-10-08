import { appliquerNorme, consigneNorme, nbSlidesNorme, normeCarrousel, raccourcir } from './normes-carrousel.util';

const nbMots = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const phrase = (n: number, fin = '.') => `${Array.from({ length: n }, (_, i) => `mot${i}`).join(' ')}${fin}`;

describe('normes des carrousels', () => {
  it('Instagram et Facebook suivent la norme Instagram, le reste LinkedIn', () => {
    expect(normeCarrousel('Instagram').corps).toEqual([5, 25]);
    expect(normeCarrousel('facebook').corps).toEqual([5, 25]);
    expect(normeCarrousel('linkedin').corps).toEqual([20, 60]);
    expect(normeCarrousel(undefined).corps).toEqual([20, 60]);
  });

  it('nombre de slides ramené dans la fourchette du réseau, 10 au plus (rendu)', () => {
    expect(nbSlidesNorme(5, normeCarrousel('instagram'))).toBe(6);
    expect(nbSlidesNorme(5, normeCarrousel('linkedin'))).toBe(7);
    expect(nbSlidesNorme(12, normeCarrousel('linkedin'))).toBe(10);
    expect(nbSlidesNorme(8, normeCarrousel('instagram'))).toBe(8);
  });

  it('la consigne reprend les limites du réseau', () => {
    const c = consigneNorme(normeCarrousel('instagram'));
    expect(c).toContain('5 to 10 words');
    expect(c).toContain('5 to 25 words');
    expect(c).toContain('SAVE or SHARE');
  });

  it('raccourcir coupe à une fin de phrase, sinon au dernier mot entier avec « … »', () => {
    expect(raccourcir(`${phrase(10)} ${phrase(10)} ${phrase(10)}`, 25)).toBe(`${phrase(10)} ${phrase(10)}`);
    const coupe = raccourcir(phrase(40, ''), 25);
    expect(nbMots(coupe)).toBe(25);
    expect(coupe.endsWith('mot24…')).toBe(true);
    expect(raccourcir('Court.', 25)).toBe('Court.');
  });

  it("appliquerNorme : le conseil part d'abord, entier ou pas du tout", () => {
    const ig = normeCarrousel('instagram');
    const r = appliquerNorme({ texte: phrase(18), pro_tip: `${phrase(5)} ${phrase(10)}`, pills: ['a', 'b', 'c', 'd'] }, ig);
    expect(r.texte).toBe(phrase(18));
    expect(r.pro_tip).toBe(phrase(5)); // la 2e phrase ne tient plus
    expect(r.pills).toEqual(['a', 'b']);
    const r2 = appliquerNorme({ texte: phrase(18), pro_tip: phrase(12), pills: [] }, ig);
    expect(r2.pro_tip).toBe(''); // jamais tronqué en « … »
  });

  it('appliquerNorme : texte trop long raccourci, conseil retiré ; LinkedIn garde plus', () => {
    const r = appliquerNorme({ texte: `${phrase(15)} ${phrase(15)}`, pro_tip: phrase(5), pills: [] }, normeCarrousel('instagram'));
    expect(r).toMatchObject({ texte: phrase(15), pro_tip: '' });
    const li = appliquerNorme({ texte: `${phrase(15)} ${phrase(15)}`, pro_tip: phrase(10), pills: [] }, normeCarrousel('linkedin'));
    expect(nbMots(li.texte) + nbMots(li.pro_tip)).toBe(40); // sous 60 : rien ne bouge
  });
});
