/**
 * Texte réellement lu par la voix off d'un motion design. Les scripts écrits par le Studio IA sont
 * structurés (titres « ### 00:00 - 00:03 : L'accroche », citations « > « … » », gras, séparateurs) :
 * envoyés tels quels à la synthèse vocale, la voix lirait aussi les titres et les minutages.
 */

const TIMECODE = /\b\d{1,2}:\d{2}(?:\s*[-–à]\s*\d{1,2}:\d{2})?\b/g;
// Indications de réalisation qui ne se lisent pas : « Visuel : … », « [Plan serré] », « (musique) »
const INDICATION =
  /^\s*[[(]?\s*(visuel|plan|b-?roll|texte à l'écran|texte écran|écran|musique|son|transition|cut|ambiance|note)\b[^:\]]*[:\])]/i;

/** Le texte à faire lire, débarrassé de la mise en forme et des indications. */
export function texteParle(script: string): string {
  const brut = String(script || '');
  const lignes = brut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l && !/^#/.test(l) && !/^[-*_]{3,}$/.test(l) && !INDICATION.test(l),
    )
    .map((l) =>
      l
        .replace(/^>\s*/, '')
        .replace(/^[-*•]\s+/, '')
        .replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, '')
        .replace(TIMECODE, '')
        .trim(),
    )
    .filter((l) => l && l !== '>');
  const texte = lignes.join('\n');
  // Script « dialogué » : seules les répliques entre guillemets sont dites
  const repliques = [...texte.matchAll(/«\s*([^»]+?)\s*»/g)].map((m) =>
    m[1].trim(),
  );
  const parle = repliques.length ? repliques.join('\n') : texte;
  return parle
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Durée estimée de la voix (≈ 2,6 mots par seconde en français). */
export function dureeEstimee(texte: string): number {
  return Math.round(texte.split(/\s+/).filter(Boolean).length / 2.6);
}
