/**
 * Préparation d'un rush avant l'agent du VPS : coupe des silences à partir de la transcription
 * mot à mot (service POC), et transcription recalée sur la vidéo coupée. Mêmes seuils que le
 * POC (submagic_poc2.keep_segments) : pause > 0,40 s coupée, 0,22 s de respiration gardée.
 */

export interface Mot {
  text: string;
  start: number;
  end: number;
}

export const PAUSE_MIN_S = 0.4;
export const RESPIRATION_S = 0.22;

/** Morceaux [début, fin] à garder (temps de la vidéo d'origine). */
export function segmentsGardes(
  mots: Mot[],
  dureeTotale: number,
): Array<[number, number]> {
  if (!mots.length) return [[0, dureeTotale]];
  const segs: Array<[number, number]> = [];
  let debut = Math.max(0, mots[0].start - 0.3);
  for (let i = 0; i < mots.length - 1; i++) {
    const a = mots[i];
    const b = mots[i + 1];
    if (b.start - a.end > PAUSE_MIN_S) {
      segs.push([debut, a.end + RESPIRATION_S / 2]);
      debut = b.start - RESPIRATION_S / 2;
    }
  }
  segs.push([debut, Math.min(dureeTotale, mots[mots.length - 1].end + 0.6)]);
  return segs;
}

/** Temps d'origine -> temps sur la vidéo coupée. */
export function recaler(t: number, segs: Array<[number, number]>): number {
  let nouveau = 0;
  for (const [a, b] of segs) {
    if (t < a) return nouveau;
    if (t <= b) return nouveau + (t - a);
    nouveau += b - a;
  }
  return nouveau;
}

export function motsRecales(mots: Mot[], segs: Array<[number, number]>): Mot[] {
  const r = (x: number) => Math.round(recaler(x, segs) * 1000) / 1000;
  return mots.map((m) => ({ text: m.text, start: r(m.start), end: r(m.end) }));
}

/** Durée gardée, en secondes. */
export function dureeGardee(segs: Array<[number, number]>): number {
  return segs.reduce((s, [a, b]) => s + (b - a), 0);
}

/** Arguments ffmpeg : garde les morceaux et les recolle (image + son), sans sous-titres. */
export function argumentsCoupe(
  entree: string,
  sortie: string,
  segs: Array<[number, number]>,
  avecSon: boolean,
): string[] {
  const parts = segs
    .map(([a, b], i) => {
      const v = `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
      return avecSon
        ? `${v}[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`
        : v;
    })
    .join('');
  const entrees = segs
    .map((_, i) => (avecSon ? `[v${i}][a${i}]` : `[v${i}]`))
    .join('');
  const concat = `${entrees}concat=n=${segs.length}:v=1:a=${avecSon ? 1 : 0}[v]${avecSon ? '[a]' : ''}`;
  return [
    '-v',
    'error',
    '-y',
    '-i',
    entree,
    '-filter_complex',
    parts + concat,
    '-map',
    '[v]',
    ...(avecSon ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    sortie,
  ];
}
