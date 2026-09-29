import { buildHtml, TEMPLATES } from './build-html';
import { CarrouselContentShape } from './common.util';
import { tplChiffres } from './tpl-chiffres';

// Style "chiffres" (slides gros chiffres/stats) — absent du premier portage NestJS
// (repéré le 2026-09-29, comparaison systématique Python/NestJS ; déjà présent côté
// frontend dans carrouselPreview.js, seul le rendu serveur manquait).
describe('tplChiffres', () => {
  const content: CarrouselContentShape = {
    hook: 'Les vrais chiffres du secteur',
    slides: [
      { titre: 'Croissance', chiffre: '+92%', texte: "En un an d'activité." },
      { titre: 'Sans chiffre fourni' },
    ],
    cta: { titre: 'On en discute ?', texte: 'Réponds en story.' },
  };

  it('rend un document HTML complet avec une slide par élément (couverture + slides + CTA)', () => {
    const html = tplChiffres(content, '#003D2E', '#0077FF', '#3AFFA3', 'Rico', 'Coaching', null);
    expect(html).toContain('<!DOCTYPE html>');
    const nbSlides = (html.match(/class="slide"/g) || []).length;
    expect(nbSlides).toBe(2 + content.slides!.length); // couverture + slides + CTA
    expect(html).toContain('+92%');
    expect(html).toContain('Les vrais chiffres du secteur');
    expect(html).toContain('On en discute ?');
  });

  it('numérote automatiquement quand aucun chiffre n\'est fourni pour une slide', () => {
    const html = tplChiffres(content, undefined, undefined, undefined, 'Rico', '', null);
    // 2e slide (index 1, sans `chiffre`) retombe sur "02".
    expect(html).toContain('>02<');
  });

  it('échappe le HTML injecté dans le texte des slides', () => {
    const html = tplChiffres(
      { hook: '<script>x</script>', slides: [{ titre: 't', chiffre: '<b>1</b>' }], cta: {} },
      undefined,
      undefined,
      undefined,
      'Rico',
      '',
      null,
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('est déclaré dans le catalogue des templates et routé par buildHtml', () => {
    expect(TEMPLATES).toContain('chiffres');
    const html = buildHtml(content, '#003D2E', '#0077FF', '#3AFFA3', 'Rico', 'Coaching', 'chiffres', null);
    expect(html).toContain('+92%');
    expect(html).toContain('Chiffres clés');
  });
});
