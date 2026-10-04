import { accDark, inkOn, mix } from './color.util';
import { CarrouselContentShape, esc, parts, pills } from './common.util';

/**
 * Templates de carrousel IMPORTÉS depuis le back-office — port direct des fonctions
 * pures de backend/services/carrousel_custom.py (nettoyer/bloc/remplacer/construire).
 * La persistance (lister/charger/ids, CRUD admin) vit dans carrousel-custom.service.ts.
 *
 * Un template importé est un HTML qui décrit TROIS slides seulement ; le moteur répète
 * celle du milieu autant de fois que le contenu l'exige :
 *   <div class="slide" data-role="couverture"> … {{hook}} … </div>
 *   <div class="slide" data-role="etape">      … {{numero}} {{titre}} {{texte}} … </div>
 *   <div class="slide" data-role="final">      … {{cta_titre}} … </div>
 *
 * Sécurité : le HTML vient d'un admin de confiance mais est rendu par un navigateur SUR
 * LE SERVEUR — on retire donc scripts, iframes et gestionnaires d'évènements.
 */

const BALISES_INTERDITES =
  /<\s*(script|iframe|object|embed|form|input|button|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>|<\s*(script|iframe|object|embed|form|input|meta|base)\b[^>]*\/?>/gi;
const ATTR_EVENT = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_JS = /(href|src|action)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi;

/** Retire tout ce qui pourrait exécuter du code au moment du rendu. */
export function nettoyer(html: string): string {
  let out = (html || '').replace(BALISES_INTERDITES, '');
  out = out.replace(ATTR_EVENT, '');
  out = out.replace(URL_JS, '');
  return out;
}

/** Extrait le bloc <div data-role="role"> … </div> en gérant les div imbriquées. */
function bloc(html: string, role: string): string {
  const openRe = new RegExp(`<div[^>]*data-role\\s*=\\s*["']${role}["'][^>]*>`, 'i');
  const m = openRe.exec(html);
  if (!m) return '';
  const start = m.index;
  let i = m.index + m[0].length;
  let profondeur = 1;
  const tagRe = /<\s*(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = i;
  let tag: RegExpExecArray | null;
  let pos = i;
  while ((tag = tagRe.exec(html))) {
    profondeur += tag[1] ? -1 : 1;
    if (profondeur === 0) {
      return html.slice(start, tag.index + tag[0].length);
    }
    pos = tag.index;
  }
  return html.slice(start, pos);
}

/** Renvoie la liste des problèmes bloquants (vide = template utilisable). */
export function valider(html: string): string[] {
  const erreurs: string[] = [];
  for (const role of ['couverture', 'etape', 'final']) {
    if (!bloc(html, role)) {
      erreurs.push(`Bloc manquant : aucun élément avec data-role="${role}".`);
    }
  }
  if (!html.includes('{{hook}}')) {
    erreurs.push("Le marqueur {{hook}} est absent : la couverture n'affichera aucun titre.");
  }
  if (!html.includes('{{titre}}')) {
    erreurs.push('Le marqueur {{titre}} est absent : les slides d\'étape seront vides.');
  }
  return erreurs;
}

function remplacer(blocHtml: string, valeurs: Record<string, string>): string {
  let out = blocHtml;
  for (const [cle, val] of Object.entries(valeurs)) {
    out = out.split(`{{${cle}}}`).join(val);
  }
  // Un marqueur non fourni (ex. {{pro_tip}} sans pro tip) disparaît proprement.
  return out.replace(/\{\{[a-z_]+\}\}/g, '');
}

/** Assemble le document final : entête + N slides issues des 3 blocs du gabarit. */
export function construire(
  htmlGabarit: string,
  content: CarrouselContentShape,
  p: string,
  s: string,
  a: string,
  nom: string,
  secteur: string,
  logo: string | null | undefined,
  stylesGlobaux = '',
): string {
  const gabarit = nettoyer(htmlGabarit);
  const [hook, slides, cta] = parts(content);
  const n = 2 + slides.length;
  const A = accDark(a || '#3AFFA3');
  const commun = { nom: esc(nom), secteur: esc(secteur), total: String(n), logo: logo || '' };

  const bCov = bloc(gabarit, 'couverture');
  const bEtape = bloc(gabarit, 'etape');
  const bFin = bloc(gabarit, 'final');

  const out = [remplacer(bCov, { ...commun, hook: esc(hook), index: '1' })];
  slides.forEach((sl, i) => {
    out.push(
      remplacer(bEtape, {
        ...commun,
        numero: String(i + 1).padStart(2, '0'),
        titre: esc(sl.titre),
        texte: esc(sl.texte),
        pills: pills(sl.pills),
        pro_tip: esc(sl.pro_tip),
        index: String(i + 2),
      }),
    );
  });
  out.push(
    remplacer(bFin, { ...commun, cta_titre: esc(cta.titre), cta_texte: esc(cta.texte), index: String(n) }),
  );

  // Tout ce qui précède le premier bloc (styles, polices) est conservé tel quel.
  const tete = bCov ? gabarit.slice(0, gabarit.indexOf(bCov)) : gabarit;
  const variables =
    ':root{' +
    `--principale:${p};--secondaire:${s};--accent:${A};` +
    `--encre:${inkOn(p)};--sourdine:${mix(inkOn(p), p, 0.45)};` +
    // couleurs brutes de la marque (modèles créés dans l'éditeur)
    `--marque-p:${p};--marque-s:${s};--marque-a:${a};` +
    '}';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<style>${variables}${stylesGlobaux}</style>${tete}</head><body>${out.join('')}</body></html>`
  );
}
