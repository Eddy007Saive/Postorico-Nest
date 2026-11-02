/** Sites autorisés à appeler l'API depuis un navigateur (CORS). */

/** Toujours acceptés : l'appli mobile Capacitor (Android `https://localhost`, iOS
 * `capacitor://localhost`) et le site lancé en local. Aucun site tiers ne peut se faire passer
 * pour ces origines. */
const TOUJOURS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
  'http://localhost:3000',
];

function origine(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Liste blanche : CORS_ORIGINS (séparées par des virgules) + FRONTEND_URL, avec et sans
 * « www. », + les origines toujours acceptées. Vide si CORS_ORIGINS n'est pas posée : l'API
 * reste alors ouverte, comme avant (aucun déploiement ne casse faute d'avoir réglé la variable). */
export function originesAutorisees(
  corsOrigins: string,
  frontendUrl: string,
): Set<string> {
  const listees = corsOrigins
    .split(',')
    .map((o) => origine(o))
    .filter((o): o is string => !!o);
  if (!listees.length) return new Set();
  const toutes = new Set([...listees, ...TOUJOURS]);
  const front = origine(frontendUrl);
  if (front) {
    toutes.add(front);
    const u = new URL(front);
    toutes.add(
      u.hostname.startsWith('www.')
        ? front.replace('://www.', '://')
        : front.replace('://', '://www.'),
    );
  }
  return toutes;
}

/** Un appel sans en-tête Origin (serveur à serveur : webhooks Stripe et Zernio, rendus, curl)
 * n'est pas concerné par le CORS et passe toujours. */
export function origineAcceptee(
  origin: string | undefined,
  autorisees: Set<string>,
): boolean {
  return !origin || !autorisees.size || autorisees.has(origin);
}
