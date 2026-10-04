/** Polices de marque (fichiers, PAS sur Google Fonts) : servies depuis frontend/public/fonts/
 * — mêmes fichiers que l'aperçu navigateur (cf. carrouselPreview.js côté front). Plusieurs
 * graisses -> une seule famille CSS, comme Google Fonts. Port de `_CUSTOM_FONTS`
 * (backend/services/carrousel_service.py). */
export const CUSTOM_FONTS: Record<string, Array<{ file: string; format: string; weight: string }>> = {
  'Circular Bold': [{ file: 'CircularBold.ttf', format: 'truetype', weight: '100 900' }],
  Wotfard: [{ file: 'Wotfard-Regular.woff2', format: 'woff2', weight: '100 500' }],
  'TT Norms Pro': [
    { file: 'TTNormsPro-Regular.otf', format: 'opentype', weight: '400' },
    { file: 'TTNormsPro-Medium.otf', format: 'opentype', weight: '500' },
    { file: 'TTNormsPro-Bold.otf', format: 'opentype', weight: '700' },
    { file: 'TTNormsPro-ExtraBold.otf', format: 'opentype', weight: '800 900' },
  ],
};

/** @font-face pour les polices de marque parmi `fams` (les Google Fonts sont ignorées ici).
 * `frontendUrl` est l'origine qui sert /fonts/… — port de `_font_face_css`. */
export function fontFaceCss(fams: string[], frontendUrl: string): string {
  const blocks: string[] = [];
  for (const fam of fams) {
    for (const face of CUSTOM_FONTS[fam] ?? []) {
      const url = `${frontendUrl}/fonts/${face.file}`;
      blocks.push(
        `@font-face{font-family:'${fam}';src:url('${url}') format('${face.format}');font-weight:${face.weight};font-display:swap;}`,
      );
    }
  }
  return blocks.length ? `<style>${blocks.join('')}</style>` : '';
}
