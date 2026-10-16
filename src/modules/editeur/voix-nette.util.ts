/**
 * « Améliorer la voix » de l'éditeur vidéo : la chaîne de filtres ffmpeg appliquée au son d'un
 * plan. Idée tirée de Concat (éditeur sous AGPL : seule la description en mots est reprise,
 * pas son code) : un seul curseur qui dose ensemble débruitage, dé-essage et compression.
 *
 *   coupe-bas 80 Hz        retire le grondement (vent, clim, manipulations du téléphone)
 *   débruitage FFT         force 6 à 24 dB selon le curseur
 *   dé-esseur (≥ 30 %)     adoucit les « s » sifflants
 *   compresseur            ratio 2 à 4 : voix plus égale, plus présente
 *   normalisation          -14 LUFS, pic -1,5 dB : le niveau attendu par TikTok, Reels, YouTube
 *                          (sinon un simple limiteur évite la saturation)
 */
export function chaineVoix(forceIn: unknown, normaliser = true): string {
  const f = Math.max(0, Math.min(100, Number(forceIn) || 0));
  const nr = Math.round(6 + f * 0.18);
  const ratio = Math.round((2 + f / 50) * 10) / 10;
  return [
    'highpass=f=80',
    `afftdn=nr=${nr}:nf=-25`,
    ...(f >= 30 ? ['deesser'] : []),
    `acompressor=threshold=-18dB:ratio=${ratio}:attack=5:release=80`,
    normaliser ? 'loudnorm=I=-14:TP=-1.5:LRA=11' : 'alimiter=limit=0.95',
  ].join(',');
}

/** Arguments ffmpeg : la vidéo est recopiée telle quelle (aucune perte d'image, rapide), seul
 * le son est retraité. Pour un fichier audio, sortie en m4a. */
export function argumentsVoix(entree: string, sortie: string, video: boolean, force: unknown, normaliser: boolean): string[] {
  const commun = ['-y', '-i', entree];
  const filtre = ['-af', chaineVoix(force, normaliser), '-c:a', 'aac', '-b:a', '160k'];
  return video
    ? [...commun, '-map', '0:v:0?', '-map', '0:a:0', '-c:v', 'copy', ...filtre, '-movflags', '+faststart', sortie]
    : [...commun, '-vn', ...filtre, sortie];
}
