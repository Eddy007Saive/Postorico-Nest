import { applyFont, CUSTOM_FONTS, parseFontSpec } from './carrousel-rendu.service';

// Port de `_apply_font` / `_parse_font_spec` / `_font_face_css` / `_CUSTOM_FONTS`
// (backend/services/carrousel_service.py). Les polices de marque (Circular Bold, Wotfard,
// TT Norms Pro) ne sont PAS sur Google Fonts : elles sont servies depuis
// frontend/public/fonts/ via @font-face. Le suffixe "|b"/"|i"/"|bi" de la chaîne de police
// force gras/italique (même convention que parseFontSpec() côté front, carrouselPreview.js).
const HTML = '<style>h1{font-family:Anton}h2{font-family:Fraunces}p{font-family:Inter}</style><div class="slide"></div>';
const FRONT = 'https://app.test';

describe('parseFontSpec', () => {
  it('vide -> aucune famille, ni gras ni italique', () => {
    expect(parseFontSpec(null)).toEqual({ famille: null, gras: false, italique: false });
    expect(parseFontSpec('')).toEqual({ famille: null, gras: false, italique: false });
  });

  it('famille seule', () => {
    expect(parseFontSpec('Sora')).toEqual({ famille: 'Sora', gras: false, italique: false });
  });

  it.each([
    ['Sora|b', true, false],
    ['Sora|i', false, true],
    ['TT Norms Pro|bi', true, true],
    ['TT Norms Pro|ib', true, true],
  ])('%s -> gras=%s italique=%s', (spec, gras, italique) => {
    const r = parseFontSpec(spec);
    expect(r.gras).toBe(gras);
    expect(r.italique).toBe(italique);
    expect(r.famille).toBe(spec.split('|')[0]);
  });
});

describe('applyFont', () => {
  it('aucune police -> HTML inchangé', () => {
    expect(applyFont(HTML, null, null, FRONT)).toBe(HTML);
    expect(applyFont(HTML, undefined, undefined, FRONT)).toBe(HTML);
  });

  it('police Google : lien fonts.googleapis, pas de @font-face, remplacement des polices d\'affichage', () => {
    const out = applyFont(HTML, 'Sora', null, FRONT);
    expect(out).toContain('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800;900&display=swap');
    expect(out).not.toContain('@font-face');
    expect(out).toContain("h1{font-family:'Sora';}");
    expect(out).toContain("h2{font-family:'Sora';}");
    expect(out).toContain('p{font-family:Inter}'); // le corps n\'est pas touché sans fontCorps
  });

  it('police de marque : @font-face servi depuis FRONTEND_URL, et AUCUN appel Google Fonts', () => {
    const out = applyFont(HTML, 'Circular Bold', null, FRONT);
    expect(out).not.toContain('fonts.googleapis.com');
    expect(out).toContain(
      "@font-face{font-family:'Circular Bold';src:url('https://app.test/fonts/CircularBold.ttf') format('truetype');font-weight:100 900;font-display:swap;}",
    );
    expect(out).toContain("h1{font-family:'Circular Bold';}");
  });

  it('TT Norms Pro|bi : 4 graisses en @font-face + gras et italique forcés sur l\'affichage', () => {
    const out = applyFont(HTML, 'TT Norms Pro|bi', null, FRONT);
    expect(CUSTOM_FONTS['TT Norms Pro']).toHaveLength(4);
    expect(out.match(/@font-face\{font-family:'TT Norms Pro'/g)).toHaveLength(4);
    expect(out).toContain("https://app.test/fonts/TTNormsPro-ExtraBold.otf') format('opentype');font-weight:800 900;");
    expect(out).toContain("h1{font-family:'TT Norms Pro';font-weight:700 !important;font-style:italic !important;}");
    expect(out).not.toContain('fonts.googleapis.com');
  });

  it('police de corps : remplace Inter, avec son propre override', () => {
    const out = applyFont(HTML, null, 'Wotfard|b', FRONT);
    expect(out).toContain("p{font-family:'Wotfard';font-weight:700 !important;}");
    expect(out).toContain("src:url('https://app.test/fonts/Wotfard-Regular.woff2') format('woff2');font-weight:100 500;");
    expect(out).toContain('h1{font-family:Anton}'); // l\'affichage n\'est pas touché sans font
  });

  it('mixte Google (affichage) + marque (corps) : lien Google pour l\'une, @font-face pour l\'autre', () => {
    const out = applyFont(HTML, 'Anton', 'Wotfard', FRONT);
    expect(out).toContain('family=Anton:wght@400;500;600;700;800;900');
    expect(out).not.toContain('family=Wotfard');
    expect(out).toContain("@font-face{font-family:'Wotfard'");
    expect(out).toContain("h1{font-family:'Anton';}");
    expect(out).toContain("p{font-family:'Wotfard';}");
  });

  it('deux polices Google distinctes -> un seul lien avec les deux familles', () => {
    const out = applyFont(HTML, 'Sora', 'Open Sans', FRONT);
    expect(out).toContain('family=Sora:wght@400;500;600;700;800;900&family=Open+Sans:wght@400;500;600;700;800;900&display=swap');
  });
});
