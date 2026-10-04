import { readFileSync } from 'fs';
import { join } from 'path';
import { CarrouselContentShape, parts } from './common.util';

/**
 * Styles écrits une seule fois en JS (Kraft, Surligné, Grand chiffre et les styles photo) —
 * port de `_style_partage` (carrousel_service.py). Le générateur (assets/carrousel/styles_carrousel.js,
 * copie identique de frontend/src/lib/stylesCarrousel.js) construit les slides dans la page
 * Playwright : même code que l'aperçu du navigateur.
 */
export const STYLES_PARTAGES = new Set(['kraft', 'surligne', 'grand-chiffre', 'duo', 'organique', 'poudre', 'maison', 'cafe']);
export const STYLES_PHOTOS = new Set(['duo', 'organique', 'poudre', 'maison', 'cafe']);

let generateur: string | null = null;
const lireGenerateur = () => {
  generateur ??= readFileSync(join(process.cwd(), 'assets', 'carrousel', 'styles_carrousel.js'), 'utf-8');
  return generateur;
};

/** JSON sûr dans un <script> : « </ » ne peut pas fermer la balise (contenu IA et client). */
const lit = (o: unknown) => JSON.stringify(o).replace(/<\//g, '<\\/');

export function stylePartage(
  template: string,
  content: CarrouselContentShape,
  p: string,
  s: string,
  a: string,
  nom: string,
  secteur: string,
  logo: string | null | undefined,
  photos: string[] = [],
): string {
  const [hook, slides, cta] = parts(content);
  const donnees = { hook, slides, cta, nom: nom || '', secteur: secteur || '', logo: logo || null, photos };
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>' +
    `<script>${lireGenerateur()}</script><script>(function(){var S=window.StylesCarrousel;` +
    `var l=document.createElement('link');l.rel='stylesheet';l.href=S.lienPolices(${lit(template)});document.head.appendChild(l);` +
    `document.body.insertAdjacentHTML('beforeend',S.rendre(${lit(template)},${lit(donnees)},${lit({ p, s, a })}).join(''));})();</script>` +
    '</body></html>'
  );
}
