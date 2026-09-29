import * as crypto from 'crypto';

/**
 * Helpers PURS partagés entre le scénariste texte (reel.service, à venir) et le monteur
 * vidéo (montage.service) — port direct des petites fonctions transverses de
 * backend/services/reel_service.py (référencées par backend/services/montage_service.py
 * via des imports tardifs pour casser le cycle Python ; ici on casse le même cycle en les
 * mettant dans un fichier sans dépendance d'injection, importé par les deux services).
 */

export const LANGUES: Record<string, string> = { fr: 'French', en: 'English', es: 'Spanish' };
export const EFFETS = ['zoomIn', 'zoomOut', 'panLeft', 'panRight'] as const;
export const REVEALS = ['carte', 'lamelles', 'portes', 'stores', 'iris'] as const;

// Direction artistique par style : injectée dans le prompt scénariste pour que L'ÉCRITURE
// colle à l'habillage (le moteur Remotion fait le reste).
export const GUIDES_STYLE: Record<string, string> = {
  impact:
    'IMPACT STYLE: sentences of 2 to 4 words MAXIMUM, strong verbs, zero filler. Fast pace: dur between 2 and 2.8 s.',
  odyssee:
    'ODYSSEY STYLE: grand, evocative tone (journey, vastness). Favour image shots with the iris reveal; short, airy texts.',
  vlog: 'VLOG STYLE: spoken, direct tone, first person, like a face-to-camera story. Natural and complicit, never corporate.',
  carnet: 'TRAVEL JOURNAL STYLE: intimate logbook tone in the first person, short sensory sentences.',
  avantapres:
    "MANDATORY BEFORE/AFTER STRUCTURE: shot 1 = typo hook; then a strict alternation of images labelled BEFORE then AFTER (fill the label field, in the client's language) following the logical order of the visuals; last shot is the cta. Not enough images? Replace them with typo shots describing the before, then the after.",
  temoignage:
    "TESTIMONIAL STYLE: write the reel as ONE authentic client quote in the first person (concrete result, sincere emotion). On the LAST shot before the cta, set label = 'First name, role' (e.g. 'Sophie, client since 2024').",
  conseils:
    'TIPS STRUCTURE: shot 1 = typo hook (a promise or a common mistake); then 3 to 5 shots = ONE concrete, actionable tip per shot (typo or image); last shot is the cta.',
};

/** Un extrait vidéo de la banque (Cloudinary range l'audio ET la vidéo sous /video/upload/ ;
 * une vignette .jpg extraite d'un clip reste une image). */
export function estClip(url: string | null | undefined): boolean {
  const u = (url || '').toLowerCase();
  return u.includes('/video/upload/') && !/\.(jpg|png|webp)$/.test(u);
}

/** Une vraie image : pas un mp4, pas un poster dérivé d'une vidéo (/video/upload/). */
export function estImageSource(url: string | null | undefined): boolean {
  return Boolean(url) && !url!.endsWith('.mp4') && !url!.includes('/video/upload/');
}

/** Photo ou clip : tout ce qui peut occuper un plan image. */
export function estVisuel(url: string | null | undefined): boolean {
  return estImageSource(url) || estClip(url);
}

/** Version 1200px/q_auto d'une image Cloudinary : chargement rapide au rendu. */
export function imgRendu(url: string | null | undefined): string {
  if (url && url.includes('res.cloudinary.com') && url.includes('/upload/') && !url.includes('/upload/w_')) {
    return url.replace('/upload/', '/upload/w_1200,q_auto/');
  }
  return url || '';
}

/** Clip prêt pour le moteur : recadré 9:16, limité à la durée du plan, en 720p. Découper
 * côté serveur évite de télécharger la vidéo entière à chaque rendu. (`g_auto`, le
 * recadrage intelligent, est un module payant : non utilisé.) */
export function clipRenduSimple(url: string, dur: number): string {
  if (!url?.includes('res.cloudinary.com') || !url.includes('/upload/')) return url;
  const [base, fin] = url.split('/upload/');
  if (fin.startsWith('so_') || fin.startsWith('c_fill')) return url;
  return `${base}/upload/so_0,du_${Math.max(1, Math.round(Number(dur) + 0.5))},c_fill,ar_9:16,w_720,q_auto/${fin}`;
}

export interface VisuelPool {
  id: string;
  url: string;
  desc: string;
  debut?: number | null;
  fin?: number | null;
  asset?: unknown;
}

/** (debut, fin) du morceau choisi par le client sur un clip, sinon null. Bornes : au moins
 * 1 s, au plus 15 s (un plan de reel n'est pas un film). */
export function morceau(v: VisuelPool): [number, number] | null {
  if (v.debut === null || v.debut === undefined || v.fin === null || v.fin === undefined) return null;
  const d = Math.max(0, Number(v.debut));
  const f = Number(v.fin);
  if (Number.isNaN(d) || Number.isNaN(f) || f - d < 1.0) return null;
  return [Math.round(d * 10) / 10, Math.round(Math.min(f, d + 15.0) * 10) / 10];
}

/** Le piment : chaque reel tire sa propre rotation de révélations, ancrée sur le contenu
 * (stable au re-rendu, différente d'un reel à l'autre). Corrige aussi les répétitions du
 * LLM : jamais deux reveals identiques d'affilée. */
export function pimenterReveals<T extends { type: string; reveal?: string }>(segments: T[], graine: string): T[] {
  let seed = parseInt(md5Hex8(graine || 'reel'), 16);
  const ordre = [...REVEALS] as string[];
  for (let i = ordre.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
  }
  let k = 0;
  let precedent: string | undefined;
  for (const seg of segments) {
    if (seg.type !== 'image') continue;
    let r = seg.reveal;
    if (!r || !(REVEALS as readonly string[]).includes(r) || r === precedent) {
      r = ordre[k % ordre.length];
      if (r === precedent) {
        k += 1;
        r = ordre[k % ordre.length];
      }
    }
    precedent = r;
    seg.reveal = r;
    k += 1;
  }
  return segments;
}

function md5Hex8(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
}
