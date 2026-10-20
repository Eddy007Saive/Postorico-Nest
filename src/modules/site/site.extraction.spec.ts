import {
  couleursDominantes,
  estNeutre,
  extrairePage,
  pagesUtiles,
  polices,
  reseauxSociaux,
  trouverLogo,
  versHex,
} from './site.extraction';
import { parse } from 'node-html-parser';

const ACCUEIL = `<!doctype html>
<html lang="fr">
<head>
  <title>Boulangerie Dupont — Pains au levain à Nantes</title>
  <meta name="description" content="Boulangerie artisanale à Nantes depuis 1998.">
  <meta property="og:site_name" content="Boulangerie Dupont">
  <meta property="og:image" content="/img/partage-banniere.jpg">
  <meta name="theme-color" content="#C0392B">
  <link rel="icon" href="/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
  <link rel="stylesheet" href="/wp-content/themes/dupont/style.css">
  <link rel="stylesheet" href="https://cdn.ailleurs.com/lib.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Lato&display=swap">
  <style>:root { --brand-primary: #1e8449; --text: #333333; } .btn { background: #e67e22; } .x{color:#e67e22}</style>
  <script>var tracking = "ne doit pas apparaitre";</script>
  <script type="application/ld+json">{"@type":"Bakery","name":"Boulangerie Dupont","foundingDate":"1998","sameAs":["https://www.youtube.com/@dupontpain"]}</script>
</head>
<body class="cookie-ok">
  <nav><a href="/">Accueil</a><a href="/a-propos">Qui sommes-nous</a><a href="/nos-prestations">Prestations</a></nav>
  <header><img src="/img/logo-dupont.svg" alt="Dupont"></header>
  <main>
    <h1>Du pain au levain, cuit chaque matin</h1>
    <p>Nous <b>pétrissons</b> à la main depuis 1998.</p>
    <p style="color: rgb(230, 126, 34)">Commandez vos viennoiseries.</p>
  </main>
  <div class="cookie-banner">Nous utilisons des cookies.</div>
  <footer>
    <a href="https://www.instagram.com/boulangerie.dupont/">Instagram</a>
    <a href="https://www.instagram.com/p/ABC123/">Un post</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">Partager</a>
    <a href="https://www.facebook.com/boulangeriedupont">Facebook</a>
    <a href="https://www.linkedin.com/company/dupont-pain/?utm_source=site">LinkedIn</a>
    <a href="https://twitter.com/intent/tweet?text=x">Tweet</a>
    <a href="https://x.com/dupontpain">X</a>
    <a href="https://www.tiktok.com/@dupontpain">TikTok</a>
    <a href="/contact">Nous contacter</a>
    <a href="/tarifs.pdf">Tarifs PDF</a>
    <a href="https://autre-site.fr/a-propos">Partenaire</a>
  </footer>
</body>
</html>`;

describe('extrairePage', () => {
  const p = extrairePage(ACCUEIL, 'https://www.dupont.fr/');

  it('lit titre, description, og, theme-color, langue', () => {
    expect(p.titre).toBe('Boulangerie Dupont — Pains au levain à Nantes');
    expect(p.description).toBe('Boulangerie artisanale à Nantes depuis 1998.');
    expect(p.og['og:site_name']).toBe('Boulangerie Dupont');
    expect(p.themeColor).toBe('#C0392B');
    expect(p.langue).toBe('fr');
  });

  it('garde le texte visible, sans script, nav ni bandeau cookies', () => {
    expect(p.texte).toContain('Du pain au levain, cuit chaque matin');
    expect(p.texte).toContain('Nous pétrissons à la main depuis 1998.');
    expect(p.texte).not.toContain('tracking');
    expect(p.texte).not.toContain('Qui sommes-nous'); // dans la nav
    expect(p.texte).not.toContain('cookies');
  });

  it('conserve les données structurées', () => {
    expect(p.jsonLd).toContain('"foundingDate":"1998"');
  });

  it('trouve un profil par réseau, sans les liens de partage ni les posts', () => {
    expect(p.reseaux).toEqual([
      'https://www.instagram.com/boulangerie.dupont',
      'https://www.linkedin.com/company/dupont-pain',
      'https://www.facebook.com/boulangeriedupont',
      'https://www.tiktok.com/@dupontpain',
      'https://www.youtube.com/@dupontpain', // via sameAs du JSON-LD
      'https://x.com/dupontpain',
    ]);
  });

  it("og:image qui n'est pas un logo → la plus grande icône", () => {
    expect(p.logo).toBe('https://www.dupont.fr/apple-180.png');
    expect(p.logoType).toBe('favicon');
  });

  it('relève les feuilles CSS et Google Fonts', () => {
    expect(p.feuillesCss).toContain('https://www.dupont.fr/wp-content/themes/dupont/style.css');
    expect(p.googleFonts).toEqual(['Playfair Display', 'Lato']);
  });

  it('retire header/footer sur une page interne', () => {
    const interne = extrairePage(ACCUEIL, 'https://www.dupont.fr/a-propos', true);
    expect(interne.texte).not.toContain('Instagram');
  });
});

describe('trouverLogo', () => {
  it("og:image nommée logo d'abord", () => {
    const r = parse('<head><meta property="og:image" content="https://cdn.x.fr/logo.png"><link rel="icon" href="/f.ico"></head>');
    expect(trouverLogo(r, 'https://x.fr/')).toEqual({ logo: 'https://cdn.x.fr/logo.png', logoType: 'og' });
  });

  it('sans icône, une image dont la classe ou le conteneur parle de logo', () => {
    const r = parse('<body><img src="/hero.jpg" alt="Accueil"><a class="site-logo"><img src="/marque.png"></a></body>');
    expect(trouverLogo(r, 'https://x.fr/page')).toEqual({ logo: 'https://x.fr/marque.png', logoType: 'image' });
  });

  it('rien → vide', () => {
    expect(trouverLogo(parse('<p>rien</p>'), 'https://x.fr/')).toEqual({ logo: '', logoType: '' });
  });
});

describe('couleurs', () => {
  it('convertit hex court, rgb, hsl', () => {
    expect(versHex('#F0a')).toBe('#ff00aa');
    expect(versHex('rgb(230, 126, 34)')).toBe('#e67e22');
    expect(versHex('rgba(0,0,0,0)')).toBe('');
    expect(versHex('hsl(120, 100%, 25%)')).toBe('#008000');
  });

  it('écarte blancs, noirs, gris', () => {
    expect(estNeutre('#ffffff')).toBe(true);
    expect(estNeutre('#111111')).toBe(true);
    expect(estNeutre('#f1f5f9')).toBe(true);
    expect(estNeutre('#c0392b')).toBe(false);
  });

  it('ordre : theme-color, variable de marque, puis fréquence', () => {
    const p = extrairePage(ACCUEIL, 'https://www.dupont.fr/');
    expect(couleursDominantes(p.themeColor, [p.cssInline])).toEqual(['#c0392b', '#1e8449', '#e67e22']);
  });

  it('dédoublonne les teintes quasi identiques', () => {
    expect(couleursDominantes('', ['a{color:#0077ff} b{color:#0078fe} c{color:#3affa3}'])).toEqual(['#0077ff', '#3affa3']);
  });
});

describe('polices', () => {
  it('Google Fonts puis familles CSS, sans polices système ni icônes', () => {
    const css = [
      `body{font-family: "Montserrat", Arial, sans-serif} h1{font-family:'Montserrat'}
       .fa{font-family:"Font Awesome 6 Free"} code{font-family: monospace} p{font-family: var(--f)}`,
    ];
    expect(polices(['Playfair Display'], css)).toEqual(['Playfair Display', 'Montserrat']);
  });
});

describe('réseaux sociaux', () => {
  it('ignore YouTube watch et LinkedIn de partage', () => {
    expect(
      reseauxSociaux([
        'https://www.youtube.com/watch?v=1',
        'https://www.linkedin.com/shareArticle?url=x',
        'https://www.youtube.com/channel/UC123',
      ]),
    ).toEqual(['https://www.youtube.com/channel/UC123']);
  });
});

describe('pagesUtiles', () => {
  it('une page par catégorie, même domaine, pas de PDF ni de domaine tiers', () => {
    const p = extrairePage(ACCUEIL, 'https://www.dupont.fr/');
    expect(pagesUtiles(p.liens, 'https://www.dupont.fr/')).toEqual([
      'https://www.dupont.fr/a-propos',
      'https://www.dupont.fr/nos-prestations',
      'https://www.dupont.fr/contact',
    ]);
  });

  it('au plus 4', () => {
    const liens = ['about', 'services', 'tarifs', 'contact', 'equipe', 'offres'].map((s) => ({
      href: `https://x.fr/${s}`,
      texte: '',
    }));
    expect(pagesUtiles(liens, 'https://x.fr/')).toHaveLength(4);
  });
});
