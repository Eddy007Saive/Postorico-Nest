/** Suivi des clics et des ouvertures d'un mail de campagne, sans outil tiers : le mail part en
 * HTML depuis la boîte du client (Zernio) ; chaque lien passe par un relais Postorico et, en
 * option, une image invisible d'un pixel signale l'ouverture. Règles pures, testées à part. */
import { createHmac, timingSafeEqual } from 'crypto';

/** Signature courte (HMAC-SHA256 tronqué) : empêche de fabriquer une adresse de suivi ou de
 * détourner le relais vers un autre site. */
export function signer(secret: string, valeur: string): string {
  return createHmac('sha256', `suivi-email:${secret}`).update(valeur).digest('base64url').slice(0, 22);
}

export function signatureValide(secret: string, valeur: string, sig: string): boolean {
  const attendue = Buffer.from(signer(secret, valeur));
  const recue = Buffer.from(String(sig || ''));
  return attendue.length === recue.length && timingSafeEqual(attendue, recue);
}

const echapper = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Liens d'un texte : http(s)://… ou www.… (la ponctuation finale reste hors du lien). */
const RE_LIEN = /\b(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/gi;

function nettoyerLien(brut: string): { url: string; reste: string } {
  const m = /[.,;:!?)\]»]+$/.exec(brut);
  const url = m ? brut.slice(0, m.index) : brut;
  return { url, reste: m ? m[0] : '' };
}

export interface OptionsSuivi {
  /** Adresse publique du serveur, ex. https://api.postorico.com */
  base: string;
  destinataireId: string;
  secret: string;
  clics: boolean;
  ouvertures: boolean;
}

/** Adresse du relais d'un lien : /api/s/c/<dest>?u=<lien>&s=<signature du couple>. */
export function lienSuivi(o: Pick<OptionsSuivi, 'base' | 'destinataireId' | 'secret'>, url: string): string {
  const s = signer(o.secret, `${o.destinataireId}|${url}`);
  return `${o.base}/api/s/c/${o.destinataireId}?u=${encodeURIComponent(url)}&s=${s}`;
}

export function pixelSuivi(o: Pick<OptionsSuivi, 'base' | 'destinataireId' | 'secret'>): string {
  return `${o.base}/api/s/o/${o.destinataireId}.${signer(o.secret, o.destinataireId)}.gif`;
}

/** Le texte du mail en HTML sobre (comme un mail écrit à la main) : paragraphes, retours à la
 * ligne, liens cliquables passés par le relais, pixel en option à la toute fin. */
export function htmlSuivi(texte: string, o: OptionsSuivi): string {
  const paragraphes = String(texte || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => {
      let html = '';
      let dernier = 0;
      for (const m of p.matchAll(RE_LIEN)) {
        const { url, reste } = nettoyerLien(m[0]);
        const cible = url.startsWith('http') ? url : `https://${url}`;
        html += echapper(p.slice(dernier, m.index));
        const href = o.clics ? lienSuivi(o, cible) : cible;
        html += `<a href="${echapper(href)}">${echapper(url)}</a>${echapper(reste)}`;
        dernier = (m.index ?? 0) + m[0].length;
      }
      html += echapper(p.slice(dernier));
      return `<p style="margin:0 0 1em 0">${html.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  const pixel = o.ouvertures ? `\n<img src="${echapper(pixelSuivi(o))}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">\n${paragraphes}${pixel}\n</div>`;
}

/** Une adresse de redirection acceptable : http(s) seulement (jamais javascript:, data:…). */
export function cibleValide(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** GIF transparent de 1×1 pixel. */
export const GIF_TRANSPARENT = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
