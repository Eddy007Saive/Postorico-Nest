/** Envoi direct d'une image dans un post par un agent (connecteur MCP) : au lieu de recopier le
 * fichier dans l'appel d'outil (impossible au-delà de quelques Ko), l'agent lance une commande
 * d'envoi avec une autorisation signée, valable 30 minutes, pour UN post et UNE position.
 * Règles pures (sans base ni réseau), testées à part. */
import { createHmac, timingSafeEqual } from 'crypto';

export const VALIDITE_ENVOI_MS = 30 * 60 * 1000;
export const TAILLE_MAX_IMAGE = 10 * 1024 * 1024;

export interface AutorisationEnvoi {
  /** Clé API qui a demandé l'envoi (révoquée = autorisation morte). */
  cle: string;
  /** Compte visé (le titulaire de la clé, ou un de ses sous-comptes). */
  compte: string;
  contenu: string;
  /** 0 = image unique du post ; 1 à 10 = photo n° de carrousel. */
  position: number;
  /** Expiration (ms depuis 1970). */
  expire: number;
}

const signature = (secret: string, charge: string) =>
  createHmac('sha256', `envoi-image:${secret}`).update(charge).digest('base64url').slice(0, 32);

export function signerEnvoi(secret: string, a: AutorisationEnvoi): string {
  const charge = Buffer.from(JSON.stringify([a.cle, a.compte, a.contenu, a.position, a.expire])).toString('base64url');
  return `${charge}.${signature(secret, charge)}`;
}

/** L'autorisation, ou la raison du refus. */
export function lireEnvoi(secret: string, jeton: string, maintenant = Date.now()): AutorisationEnvoi | { refus: string } {
  const [charge, sig] = String(jeton || '').split('.');
  if (!charge || !sig) return { refus: 'Adresse d’envoi invalide.' };
  const attendue = Buffer.from(signature(secret, charge));
  const recue = Buffer.from(sig);
  if (attendue.length !== recue.length || !timingSafeEqual(attendue, recue)) return { refus: 'Adresse d’envoi invalide.' };
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(charge, 'base64url').toString('utf8'));
  } catch {
    return { refus: 'Adresse d’envoi invalide.' };
  }
  if (!Array.isArray(v) || v.length !== 5) return { refus: 'Adresse d’envoi invalide.' };
  const [cle, compte, contenu, position, expire] = v as [string, string, string, number, number];
  if (maintenant > Number(expire)) return { refus: 'Adresse d’envoi expirée (30 minutes) : redemande-la avec get_post_image_upload.' };
  return { cle: String(cle), compte: String(compte), contenu: String(contenu), position: Number(position) || 0, expire: Number(expire) };
}

/** Type réel d'un fichier d'après ses premiers octets (pas son nom) : JPG, PNG ou WEBP. */
export function typeImage(octets: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (octets.length >= 3 && octets[0] === 0xff && octets[1] === 0xd8 && octets[2] === 0xff) return 'image/jpeg';
  if (octets.length >= 8 && octets.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (octets.length >= 12 && octets.toString('ascii', 0, 4) === 'RIFF' && octets.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Adresse publique du serveur vue par le client MCP (Railway passe par un proxy). */
export function adresseServeur(entetes: Record<string, string | string[] | undefined>, protocole: string): string {
  const un = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
  const proto = un(entetes['x-forwarded-proto']) || protocole || 'https';
  const hote = un(entetes['x-forwarded-host']) || un(entetes.host);
  return `${proto}://${hote}`;
}

/** Commande prête à lancer pour l'agent. */
export function commandeEnvoi(url: string): string {
  return `curl -sS -F "file=@CHEMIN/DE/L/IMAGE.jpg" "${url}"`;
}
