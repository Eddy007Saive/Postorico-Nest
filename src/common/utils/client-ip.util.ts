import type { Request } from 'express';

/** Adresse IP du client, pour le rate-limiting anti-bruteforce et les logs — PAS pour du
 * contrôle d'accès fin. Prend le DERNIER maillon de `X-Forwarded-For` (celui ajouté par
 * notre propre proxy amont, ex. l'edge Railway), jamais le premier.
 *
 * VULN Strix du 2026-09-28 : les implémentations précédentes (dupliquées dans
 * auth/affiliation/onboarding) prenaient le PREMIER maillon (`split(',')[0]`) — or un
 * client direct peut écrire n'importe quelle valeur en tête de cet en-tête ; un proxy de
 * confiance AJOUTE la vraie IP en fin de chaîne, il ne réécrit pas ce que le client a
 * fourni. Prendre le premier maillon revenait donc à laisser l'appelant choisir sa propre
 * clé de rate-limit à chaque requête, ce qui vide le throttling anti-bruteforce
 * (5 échecs/15 min par ip+email, 20/15 min par ip) de son effet. */
export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd.join(',') : fwd || '';
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return req.socket.remoteAddress || req.ip || '?';
}
