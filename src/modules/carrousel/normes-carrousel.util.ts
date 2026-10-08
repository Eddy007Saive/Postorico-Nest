/**
 * Normes de texte des carrousels, par réseau (validées le 2026-10-08) :
 *
 * |        | Instagram       | LinkedIn                |
 * | Titre  | 5–10 mots       | 5–12 mots               |
 * | Corps  | 5–25 mots       | 20–60 mots              |
 * | Slides | 6–10            | 7–12 (10 max au rendu)  |
 * | Style  | visuel, punchy  | expert, pédagogique     |
 * | CTA    | save / share    | comment / follow / save |
 *
 * « Corps » = texte + pro_tip d'une slide. Facebook suit Instagram ; tout autre réseau, LinkedIn.
 * Les carrousels mesurés avant ces normes faisaient 75 mots par slide en moyenne.
 */

export interface NormeCarrousel {
  titre: [number, number];
  corps: [number, number];
  slides: [number, number];
  pills: number;
  style: string;
  cta: string;
}

/** Plafond technique du rendu (une publication Instagram accepte 10 images). */
export const SLIDES_MAX_RENDU = 10;

const INSTAGRAM: NormeCarrousel = {
  titre: [5, 10],
  corps: [5, 25],
  slides: [6, 10],
  pills: 2,
  style: 'VISUAL and PUNCHY: one idea per slide, one short sentence, readable in 3 seconds on a phone',
  cta: 'ask the reader to SAVE or SHARE the carousel',
};

const LINKEDIN: NormeCarrousel = {
  titre: [5, 12],
  corps: [20, 60],
  slides: [7, 12],
  pills: 3,
  style: 'EXPERT and EDUCATIONAL: explain the why or the how, with a concrete example or figure when relevant',
  cta: 'invite the reader to COMMENT, FOLLOW or SAVE',
};

export function normeCarrousel(reseau?: string | null): NormeCarrousel {
  const r = String(reseau || '').toLowerCase();
  return r === 'instagram' || r === 'facebook' ? INSTAGRAM : LINKEDIN;
}

/** Nombre total de slides (couverture + idées + CTA) ramené dans la fourchette du réseau. */
export function nbSlidesNorme(nb: number, norme: NormeCarrousel): number {
  const max = Math.min(norme.slides[1], SLIDES_MAX_RENDU);
  return Math.max(norme.slides[0], Math.min(max, Math.trunc(nb) || norme.slides[0]));
}

/** Consigne ajoutée au message de génération. */
export function consigneNorme(norme: NormeCarrousel): string {
  return (
    `\n\nTEXT LENGTH RULES (strict, the slides must stay light):\n` +
    `- Style: ${norme.style}.\n` +
    `- Each slide "titre": ${norme.titre[0]} to ${norme.titre[1]} words.\n` +
    `- Each slide body = "texte" + "pro_tip" TOGETHER: ${norme.corps[0]} to ${norme.corps[1]} words in total. ` +
    `"pro_tip" is optional: leave it empty ("") unless it adds a concrete, non-obvious advice.\n` +
    `- "pills": 0 to ${norme.pills} keywords.\n` +
    `- Final CTA: ${norme.cta}.`
  );
}

const mots = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/**
 * Ramène le texte sous `max` mots en coupant à une fin de phrase ; si la première phrase
 * dépasse déjà, coupe au dernier mot entier et termine par « … ». Jamais au milieu d'un mot.
 */
export function raccourcir(texte: string, max: number): string {
  if (mots(texte).length <= max) return texte;
  return phrasesEntieres(texte, max) || `${mots(texte).slice(0, max).join(' ').replace(/[,;:–-]+$/, '')}…`;
}

/** Les premières phrases entières qui tiennent sous `max` mots ('' si aucune ne tient). */
function phrasesEntieres(texte: string, max: number): string {
  const phrases = texte.match(/[^.!?…]+[.!?…]+["»)\]]*|[^.!?…]+$/g) || [texte];
  let out = '';
  for (const p of phrases) {
    const essai = (out + ' ' + p.trim()).trim();
    if (mots(essai).length > max) break;
    out = essai;
  }
  return out;
}

/** Applique la norme à une slide : corps (texte + pro_tip) sous le plafond, pills limitées. */
export function appliquerNorme<T extends { texte: string; pro_tip: string; pills: string[] }>(slide: T, norme: NormeCarrousel): T {
  const max = norme.corps[1];
  let texte = slide.texte;
  let proTip = slide.pro_tip;
  if (mots(texte).length + mots(proTip).length > max) {
    // D'abord on sacrifie le conseil (facultatif), ensuite on raccourcit le texte.
    if (mots(texte).length <= max) {
      // Un conseil se garde entier (phrases complètes) ou pas du tout : jamais tronqué en « … ».
      proTip = phrasesEntieres(proTip, max - mots(texte).length);
      if (mots(proTip).length < 4) proTip = '';
    } else {
      texte = raccourcir(texte, max);
      proTip = '';
    }
  }
  return { ...slide, texte, pro_tip: proTip, pills: slide.pills.slice(0, norme.pills) };
}
