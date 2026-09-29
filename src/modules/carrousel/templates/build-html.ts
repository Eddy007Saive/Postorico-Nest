import { CarrouselContentShape } from './common.util';
import { construire } from './custom-template.util';
import { tplAlterne } from './tpl-alterne';
import { tplChiffres } from './tpl-chiffres';
import { tplClean } from './tpl-clean';
import { tplEditorial } from './tpl-editorial';
import { tplNeon } from './tpl-neon';
import { tplPop } from './tpl-pop';
import { tplPostorico } from './tpl-postorico';
import { tplCreme, tplSombre } from './tpl-reference';
import { tplRicoScene } from './tpl-rico-scene';
import { tplRicoStudio } from './tpl-rico-studio';

/** Le catalogue des templates codés en dur — port direct de TEMPLATES
 * (backend/services/carrousel_service.py). */
export const TEMPLATES = [
  'creme', 'sombre', 'alterne', 'editorial', 'pop', 'clean', 'neon', 'chiffres',
  'postorico', 'rico-studio', 'rico-scene',
];

// Templates sur mesure : invisibles par défaut, attribués compte par compte depuis le
// back-office (colonne marques.carrousel_templates_exclusifs, liste CSV).
export const EXCLUSIFS = new Set(['postorico', 'rico-studio', 'rico-scene']);

type TplFn = (
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  logo?: string | null,
) => string;

const DISPATCH: Record<string, TplFn> = {
  creme: tplCreme,
  sombre: tplSombre,
  alterne: tplAlterne,
  editorial: tplEditorial,
  pop: tplPop,
  clean: tplClean,
  neon: tplNeon,
  chiffres: tplChiffres,
  postorico: tplPostorico,
  bold: tplSombre,
  instagram: tplClean,
};

const RICO_TEMPLATES = new Set(['rico-studio', 'rico-scene']);

/** Construit le HTML final du carrousel pour un template donné.
 *
 * `poseUrls` : requis (et utilisé) seulement pour rico-studio/rico-scene, résolu en
 * amont par RicoPosesService (appel Claude) — voir CarrouselRenduService.
 * `custom` : le HTML d'un template importé déjà chargé (évite une dépendance base de
 * données dans ce fichier, qui reste une pure fonction de dispatch). */
export function buildHtml(
  content: CarrouselContentShape,
  p: string | undefined,
  s: string | undefined,
  a: string | undefined,
  nom: string,
  secteur: string,
  template = 'creme',
  logo?: string | null,
  poseUrls?: string[],
  custom?: { html: string } | null,
): string {
  let secteurCourt = (secteur || '').trim();
  if (secteurCourt.length > 42) secteurCourt = secteurCourt.slice(0, 42).trimEnd() + '…';

  // Un template importé n'est utilisé que si l'appelant l'a déjà résolu (CarrouselRenduService
  // a déjà vérifié qu'il existe ET qu'il est attribué à ce compte). Sinon, on retombe TOUJOURS
  // sur le dispatch codé en dur — y compris pour les alias historiques ("bold", "instagram")
  // qui ne figurent pas dans TEMPLATES mais restent des clés valides de DISPATCH (même repli
  // que le dict.get(template, _tpl_creme) du Python).
  if (custom) {
    return construire(custom.html, content, p || '#003D2E', s || '#0077FF', a || '#3AFFA3', nom, secteurCourt, logo);
  }

  if (RICO_TEMPLATES.has(template)) {
    const fn = template === 'rico-studio' ? tplRicoStudio : tplRicoScene;
    return fn(content, p, s, a, nom, secteurCourt, logo, poseUrls || []);
  }

  const fn = DISPATCH[template] ?? tplCreme;
  return fn(content, p, s, a, nom, secteurCourt, logo);
}
