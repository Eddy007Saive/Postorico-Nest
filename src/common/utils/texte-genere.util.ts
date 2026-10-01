/**
 * Filet de sécurité après génération (posts, légendes, slides, scripts) — port de
 * `nettoyer_texte_genere` (backend/services/agent_service.py). Le prompt interdit le
 * Markdown et les tirets cadratins, mais le modèle désobéit parfois (6 posts sur 41 en
 * septembre 2026 : « **gras** », tirets). Les réseaux affichent ces caractères tels quels,
 * un lecteur voit les astérisques. On retire les marqueurs (gras, italique, titres #,
 * backticks), on transforme les puces « * » / « — » en « • », puis les tirets cadratins /
 * demi-cadratins restants deviennent des virgules. Les hashtags (#mot, sans espace) sont
 * préservés. Idempotent.
 */
const MD_GRAS = /\*\*([\s\S]+?)\*\*/g;
const MD_GRAS_US = /__([\s\S]+?)__/g;
const MD_ITALIQUE = /(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g;
const MD_TITRE = /^[ \t]*#{1,6}[ \t]+/gm;
const MD_PUCE = /^[ \t]*\*[ \t]+/gm;
const TIRET_PUCE = /^[ \t]*[—–][ \t]*/gm;

/** Port de `_sans_tiret` : aucun tiret cadratin/demi-cadratin, remplacé par une virgule. */
export function sansTiret(txt: string): string {
  let t = txt
    .split(' — ').join(', ').split(' – ').join(', ')
    .split(' —').join(', ').split(' –').join(', ')
    .split('— ').join(', ').split('– ').join(', ')
    .split('—').join(', ').split('–').join(', ');
  while (t.includes('  ')) t = t.replace(/ {2}/g, ' ');
  return t.replace(/ ,/g, ',').replace(/,,/g, ',').replace(/^[ ,]+|[ ,]+$/g, '');
}

export function nettoyerTexteGenere(txt: string): string {
  let t = txt.replace(MD_GRAS, '$1').replace(MD_GRAS_US, '$1').replace(MD_ITALIQUE, '$1');
  t = t.split('**').join('');
  t = t.replace(MD_TITRE, '').replace(MD_PUCE, '• ');
  t = t.split('`').join('');
  t = t.replace(TIRET_PUCE, '• ');
  t = sansTiret(t);
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** nettoyerTexteGenere appliqué à toutes les chaînes d'une structure (objet/tableau). */
export function nettoyerProfond<T>(obj: T): T {
  if (typeof obj === 'string') return nettoyerTexteGenere(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((x) => nettoyerProfond(x)) as unknown as T;
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = nettoyerProfond(v);
    return out as T;
  }
  return obj;
}
