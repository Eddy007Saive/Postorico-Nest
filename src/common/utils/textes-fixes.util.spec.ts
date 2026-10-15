import { guillemets, langueCode, tf } from './textes-fixes.util';

describe('textes fixes', () => {
  it('normalise users.langue, français par défaut', () => {
    expect(langueCode('es')).toBe('es');
    expect(langueCode('EN-us')).toBe('en');
    expect(langueCode('')).toBe('fr');
    expect(langueCode(null)).toBe('fr');
    expect(langueCode('de')).toBe('fr');
  });

  it('donne le texte dans la langue du compte', () => {
    expect(tf('es', 'reponds')).toBe('Respóndeme por DM 👉');
    expect(tf('en', 'lienEnBio')).toBe('Link in bio →');
    expect(tf(undefined, 'onEnParle')).toBe('On en parle ?');
  });

  it("ne change rien pour les comptes français (ce qu'ils voient déjà)", () => {
    expect(tf('fr', 'swipe')).toBe('Swipe →');
    expect(tf('fr', 'proTip')).toBe('Pro tip');
    expect(tf('fr', 'suisNous')).toBe('Suis-nous');
  });

  it('pose les guillemets de la langue', () => {
    expect(guillemets('fr', 'x')).toBe('« x »');
    expect(guillemets('en', 'x')).toBe('“x”');
  });
});
