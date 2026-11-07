import { cibleValide, htmlSuivi, lienSuivi, pixelSuivi, signatureValide, signer } from './suivi-email.util';

const O = { base: 'https://api.exemple.fr', destinataireId: '11111111-2222-3333-4444-555555555555', secret: 's3cret' };

describe('suivi des mails de campagne', () => {
  it('signature : vérifiée, et refusée si la valeur ou le secret change', () => {
    const s = signer('s3cret', 'abc');
    expect(signatureValide('s3cret', 'abc', s)).toBe(true);
    expect(signatureValide('s3cret', 'abd', s)).toBe(false);
    expect(signatureValide('autre', 'abc', s)).toBe(false);
    expect(signatureValide('s3cret', 'abc', '')).toBe(false);
  });

  it('les liens passent par le relais signé, la ponctuation reste dehors', () => {
    const html = htmlSuivi('Bonjour Jean,\n\nVoir https://postorico.com/tarifs. Et www.exemple.fr !', { ...O, clics: true, ouvertures: false });
    const relais1 = lienSuivi(O, 'https://postorico.com/tarifs');
    const relais2 = lienSuivi(O, 'https://www.exemple.fr');
    expect(html).toContain(`href="${relais1.replace(/&/g, '&amp;')}">https://postorico.com/tarifs</a>.`);
    expect(html).toContain(`href="${relais2.replace(/&/g, '&amp;')}">www.exemple.fr</a> !`);
    expect(html).toContain('<p style="margin:0 0 1em 0">Bonjour Jean,</p>');
    expect(html).not.toContain('<img');
    // La signature du relais couvre le couple destinataire + lien
    const u = new URL(relais1);
    expect(signatureValide('s3cret', `${O.destinataireId}|https://postorico.com/tarifs`, u.searchParams.get('s')!)).toBe(true);
  });

  it('sans suivi des clics : liens directs ; pixel seulement si demandé', () => {
    const html = htmlSuivi('Lien : https://a.fr', { ...O, clics: false, ouvertures: true });
    expect(html).toContain('href="https://a.fr"');
    expect(html).toContain(`<img src="${pixelSuivi(O)}"`);
  });

  it('le texte est échappé (aucune balise injectée)', () => {
    const html = htmlSuivi('<script>alert(1)</script> & co', { ...O, clics: true, ouvertures: false });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(html).not.toContain('<script>');
  });

  it('le relais ne redirige que vers du http(s)', () => {
    expect(cibleValide('https://postorico.com')).toBe(true);
    expect(cibleValide('javascript:alert(1)')).toBe(false);
    expect(cibleValide('data:text/html,x')).toBe(false);
    expect(cibleValide('pas une url')).toBe(false);
  });
});
