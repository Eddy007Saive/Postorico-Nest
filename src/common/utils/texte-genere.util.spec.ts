import { nettoyerProfond, nettoyerTexteGenere } from './texte-genere.util';

// Un client a signalé des « ** » et des tirets cadratins dans ses posts (1er octobre 2026) :
// 6 posts sur 41 en septembre. Le prompt les interdit, ce filet rattrape la désobéissance.
describe('nettoyerTexteGenere', () => {
  it('retire le gras et l\'italique Markdown', () => {
    expect(nettoyerTexteGenere('Un **mot fort** et *un autre*.')).toBe('Un mot fort et un autre.');
    expect(nettoyerTexteGenere('__souligné__')).toBe('souligné');
  });

  it('retire les titres # mais garde les hashtags', () => {
    expect(nettoyerTexteGenere('## Mon titre\nTexte #postorico #pme')).toBe('Mon titre\nTexte #postorico #pme');
  });

  it('remplace les puces * et — par •', () => {
    expect(nettoyerTexteGenere('* premier\n* second\n— troisième')).toBe('• premier\n• second\n• troisième');
  });

  it('transforme les tirets cadratins en virgules', () => {
    expect(nettoyerTexteGenere('Publier souvent — même imparfait – compte.')).toBe('Publier souvent, même imparfait, compte.');
  });

  it('retire les backticks et compacte les espaces', () => {
    expect(nettoyerTexteGenere('Tape `yarn start`  deux  fois.')).toBe('Tape yarn start deux fois.');
  });

  it('laisse un texte propre inchangé (idempotent)', () => {
    const propre = 'Trois erreurs, une solution.\nOn en parle ?\n\n#linkedin';
    expect(nettoyerTexteGenere(propre)).toBe(propre);
    expect(nettoyerTexteGenere(nettoyerTexteGenere('**a** — b'))).toBe(nettoyerTexteGenere('**a** — b'));
  });

  it('ne touche pas aux astérisques collés à un mot (2*3) ni aux traits d\'union', () => {
    expect(nettoyerTexteGenere('2*3 = 6, un savoir-faire')).toBe('2*3 = 6, un savoir-faire');
  });
});

describe('nettoyerProfond', () => {
  it('nettoie toutes les chaînes d\'un contenu de carrousel', () => {
    const content = { hook: '**Hook**', slides: [{ titre: '# Un', texte: 'a — b', pills: ['*x*'] }], cta: { titre: 'ok' } };
    expect(nettoyerProfond(content)).toEqual({ hook: 'Hook', slides: [{ titre: 'Un', texte: 'a, b', pills: ['x'] }], cta: { titre: 'ok' } });
  });
});
