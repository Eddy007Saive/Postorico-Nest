import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** Téléchargement d'une image désignée par un assistant (outil creer_post). Le serveur va
 * chercher une adresse qu'il ne choisit pas : on refuse tout ce qui pourrait viser le réseau
 * interne (localhost, Railway privé, métadonnées cloud), on suit au plus 3 redirections en
 * revérifiant chacune, et on coupe au-delà de 10 Mo ou 15 secondes. */

export const TAILLE_MAX_IMAGE = 10 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export class ImageRefusee extends Error {}

/** Adresse IP privée, locale, réservée ou de métadonnées. */
export function ipInterne(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mappee = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappee) return ipInterne(mappee[1]);
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

async function verifierAdresse(brute: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(brute);
  } catch {
    throw new ImageRefusee("Adresse d'image invalide.");
  }
  if (url.protocol !== 'https:') throw new ImageRefusee("L'image doit être en https.");
  if (url.username || url.password) throw new ImageRefusee("Adresse d'image refusée.");
  const hote = url.hostname.replace(/^\[|\]$/g, '');
  const adresses = isIP(hote) ? [{ address: hote }] : await lookup(hote, { all: true }).catch(() => []);
  if (!adresses.length) throw new ImageRefusee("Le site de l'image est introuvable.");
  if (adresses.some((a) => ipInterne(a.address))) throw new ImageRefusee("Adresse d'image refusée.");
  return url;
}

export async function telechargerImage(adresse: string): Promise<{ octets: Buffer; type: string }> {
  let url = await verifierAdresse(adresse);
  for (let sauts = 0; ; sauts++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { Accept: 'image/*' } }).catch(() => {
      throw new ImageRefusee("L'image n'a pas pu être téléchargée.");
    });
    if (r.status >= 300 && r.status < 400) {
      const suite = r.headers.get('location');
      if (!suite || sauts >= 3) throw new ImageRefusee("L'image n'a pas pu être téléchargée (trop de redirections).");
      url = await verifierAdresse(new URL(suite, url).toString());
      continue;
    }
    if (!r.ok || !r.body) throw new ImageRefusee(`L'image n'a pas pu être téléchargée (erreur ${r.status}).`);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.has(type)) throw new ImageRefusee("Ce lien n'est pas une image (jpg, png, webp ou gif attendu).");
    if (Number(r.headers.get('content-length') || 0) > TAILLE_MAX_IMAGE) throw new ImageRefusee('Image trop lourde (10 Mo au plus).');
    const morceaux: Buffer[] = [];
    let total = 0;
    for await (const m of r.body as unknown as AsyncIterable<Uint8Array>) {
      total += m.length;
      if (total > TAILLE_MAX_IMAGE) throw new ImageRefusee('Image trop lourde (10 Mo au plus).');
      morceaux.push(Buffer.from(m));
    }
    return { octets: Buffer.concat(morceaux), type };
  }
}
