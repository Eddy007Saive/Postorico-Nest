/** Mois au format AAAA-MM-01 (Rico Coach : collecte et diagnostic). */

const TZ = 'Europe/Paris';

/** Mois (AAAA-MM-01) d'une date, à l'heure de Paris. */
export function moisParis(d: Date): string {
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}-01`;
}

/** Ajoute n mois à un mois AAAA-MM-01. */
export function decalerMois(mois: string, n: number): string {
  const [y, m] = mois.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** Jour du mois (1-31) à l'heure de Paris. */
export function moisJour(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, day: 'numeric' }).format(d));
}
