import { applyFont } from '../carrousel-rendu.service';
import { construire, valider } from './custom-template.util';
import { htmlDepuisPages, ModeleInvalide, nettoyerPage, PagePropre, ROLES_PAGES, verifierRoles } from './modele-client.util';

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/fond.jpg';
const FRONT = 'https://postorico.test';
const pasDHebergement = async () => {
  throw new Error('aucune data URL attendue');
};

const texte = (role: string, text: string, y = 100, extra: Record<string, unknown> = {}) => ({
  type: 'texte', role, text, x: 90, y, width: 900, height: 200,
  fontSize: 60, fontFamily: 'Sora', fill: '#ffffff', gras: true, align: 'left', ...extra,
});

const pages = (): any[] => [
  {
    fond: '#05060C', fondImage: IMG, elements: [
      texte('nom', 'Postorico', 40), texte('compteur', '1/5', 40), texte('accroche', 'Ancienne accroche', 300),
      { type: 'image', src: '/images/mascotte.png', x: 300, y: 600, width: 400, height: 400, ombre: { couleur: '#000000', opacite: 0.6, x: 0, y: 30, flou: 40 } },
    ],
  },
  {
    fond: '#05060C', elements: [
      texte('numero', 'ÉTAPE 01', 200), texte('titre', 'Ancien titre', 300), texte('texte', 'Ancien texte', 500),
      texte('fixe', 'LE GESTE', 900), texte('astuce', 'Ancienne astuce', 950),
    ],
  },
  { fond: '#111111', degrade: { angle: 160, stops: [[0, '#5B6CFF'], [1, '#8A6CFF']] }, elements: [texte('cta', 'Ancien CTA', 400)] },
];

const propres = async (p = pages()): Promise<PagePropre[]> =>
  Promise.all(p.map((x, i) => nettoyerPage(x, ROLES_PAGES[i], FRONT, pasDHebergement)));

describe('modèles de carrousel créés dans l’éditeur', () => {
  it('respecte le contrat des templates importés', async () => {
    const html = htmlDepuisPages(await propres(), FRONT);
    expect(valider(html)).toEqual([]);
    for (const m of ['{{hook}}', '{{titre}}', '{{texte}}', '{{pro_tip}}', '{{cta_titre}}', '{{nom}}', '{{index}}/{{total}}']) {
      expect(html).toContain(m);
    }
    expect(html).toContain('ÉTAPE {{numero}}');
    expect(html).toContain('LE GESTE');
    expect(html).not.toContain('Ancien titre');
    expect(html).toContain(`${FRONT}/images/mascotte.png`);
    expect(html).toContain('linear-gradient(160deg');
    expect(html).toContain('fonts.googleapis.com');
    expect(html).toContain("font-family:'Sora'");
    // un guillemet double dans style="…" couperait l'attribut
    expect(html).not.toMatch(/style="[^"]*"(?![\s>/])/);
  });

  it('injecte le vrai contenu et répète la slide d’étape', async () => {
    const html = htmlDepuisPages(await propres(), FRONT);
    const doc = construire(html, { hook: 'Mon accroche', slides: [{ titre: 'Idée A', texte: 'A' }, { titre: 'Idée B', texte: 'B' }], cta: { titre: 'Écris-moi' } } as any,
      '#000', '#111', '#3AFFA3', 'Ma marque', '', null);
    expect(doc.match(/class="slide"/g)).toHaveLength(4);
    expect(doc).toContain('Idée B');
    expect(doc).toContain('ÉTAPE 02');
    expect(doc).toContain('1/4');
    expect(doc).not.toContain('{{');
  });

  it('neutralise les valeurs hostiles', async () => {
    const p = pages();
    p[0].elements.push(texte('fixe', '<script>alert(1)</script>{{hook}}', 100, { fill: 'red;background:url(x)', fontFamily: 'Sora";}</style><script>' }));
    p[0].elements.push({ type: 'image', src: 'https://evil.example/x.png', x: 0, y: 0, width: 10, height: 10 });
    p[0].elements.push({ type: 'image', src: '/../../etc/passwd', x: 0, y: 0, width: 10, height: 10 });
    const html = htmlDepuisPages(await propres(p), FRONT);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('passwd');
    expect(html).not.toContain('background:url(x)');
    expect(html.match(/\{\{hook\}\}/g)).toHaveLength(1);
  });

  it('exige une accroche et un titre', () => {
    const p = pages();
    p[0].elements = p[0].elements.filter((e: any) => e.role !== 'accroche');
    expect(() => verifierRoles(p)).toThrow(ModeleInvalide);
  });
  it('logo, couleurs de marque et mots en couleur', async () => {
    const p = pages();
    p[0].fondMarque = 'principale';
    p[0].elements.push({ type: 'image', role: 'logo', rond: true, src: IMG, x: 40, y: 40, width: 90, height: 90 });
    Object.assign(p[0].elements[2], { couleurMarque: 'accent', accentMots: 2, accentCouleur: '#3AFFA3', accentMarque: 'secondaire' });
    const html = htmlDepuisPages(await propres(p), FRONT);
    expect(html).toContain('src="{{logo}}"');
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('background:var(--marque-p,#05060C)');
    expect(html).toContain('color:var(--marque-a,#ffffff)');
    expect(html).toContain('data-accent-mots="2" data-accent="var(--marque-s,#3AFFA3)"');
    const doc = construire(html, { hook: 'A B C', slides: [{ titre: 'T' }], cta: {} } as any, '#111111', '#222222', '#333333', 'M', '', 'https://res.cloudinary.com/x/logo.png');
    expect(doc).toContain('src="https://res.cloudinary.com/x/logo.png"');
    expect(doc).toContain('--marque-p:#111111;--marque-s:#222222;--marque-a:#333333;');
  });

  it('ignore les valeurs de marque inconnues', async () => {
    const p = pages();
    p[0].fondMarque = 'url(x)';
    Object.assign(p[0].elements[2], { couleurMarque: '};body{', accentMots: 99, accentMarque: 'x' });
    const [cov] = await propres(p);
    expect(cov.fondMarque).toBeNull();
    const acc = cov.elements.find((e) => e.role === 'accroche')!;
    expect(acc.couleurMarque).toBeNull();
    expect(acc.accentMarque).toBeNull();
    expect(acc.accentMots).toBe(5);
  });
  it('applique la police choisie aux titres et au texte', async () => {
    const p = pages();
    p[1].elements[2].fontFamily = 'Inter';
    p[1].elements[4].fontFamily = 'Inter';
    const html = htmlDepuisPages(await propres(p), FRONT);
    expect(html).toMatch(/data-police="titre" style="[^"]*">LE GESTE</);
    expect(html).toContain('data-police="corps"');
    const doc = construire(html, { hook: 'H', slides: [{ titre: 'T' }], cta: {} } as any, '#000', '#111', '#222', 'M', '', null);
    const rendu = applyFont(doc, 'Anton|b', 'Lora');
    expect(rendu).toContain("[data-police=titre]{font-family:'Anton',sans-serif !important;letter-spacing:normal !important;font-weight:700 !important;}");
    expect(rendu).toContain("[data-police=corps]{font-family:'Lora',sans-serif !important;letter-spacing:normal !important;}");
    expect(applyFont(doc, null, null)).toBe(doc);
  });
});
