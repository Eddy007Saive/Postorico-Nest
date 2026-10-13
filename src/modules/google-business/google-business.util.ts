/**
 * Conversions entre le format de l'API Google Business Information (relayé tel quel par Zernio) et
 * le format simple manipulé par l'écran « Fiche Google » de Postorico.
 */

export const JOURS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type Jour = (typeof JOURS)[number];
/** Une plage d'ouverture : « 09:00 » -> « 18:00 » (« 24:00 » = minuit). */
export interface Plage {
  debut: string;
  fin: string;
}
export type Horaires = Partial<Record<Jour, Plage[]>>;
/** Horaire exceptionnel (jour férié, fermeture, horaires spéciaux) : date « AAAA-MM-JJ ». */
export interface HoraireSpecial {
  date: string;
  ferme: boolean;
  debut?: string;
  fin?: string;
}

interface TimeOfDay {
  hours?: number;
  minutes?: number;
}
interface DateGoogle {
  year: number;
  month: number;
  day: number;
}

const deux = (n: number) => String(n).padStart(2, '0');
const HEURE = /^([01]\d|2[0-4]):([0-5]\d)$/;

/** {hours: 9, minutes: 30} -> « 09:30 » ; {} -> « 00:00 » (Google omet les zéros). */
export function versHeure(t: TimeOfDay | string | null | undefined): string {
  if (typeof t === 'string') return t;
  return `${deux(t?.hours ?? 0)}:${deux(t?.minutes ?? 0)}`;
}

export function versTimeOfDay(h: string): TimeOfDay {
  const [hh, mm] = h.split(':').map(Number);
  return mm ? { hours: hh, minutes: mm } : { hours: hh };
}

export function heureValide(h: unknown): h is string {
  // « 24:00 » (minuit en fin de plage) est la seule heure en 24 acceptée
  return (
    typeof h === 'string' &&
    HEURE.test(h) &&
    (!h.startsWith('24') || h === '24:00')
  );
}

/** regularHours.periods (Google) -> { MONDAY: [{debut, fin}] … } */
export function horairesDepuisGoogle(
  periods: Array<Record<string, unknown>> | undefined,
): Horaires {
  const h: Horaires = {};
  for (const p of periods || []) {
    const jour = p.openDay as Jour;
    if (!JOURS.includes(jour)) continue;
    (h[jour] ||= []).push({
      debut: versHeure(p.openTime as TimeOfDay),
      fin: versHeure(p.closeTime as TimeOfDay),
    });
  }
  return h;
}

/** { MONDAY: [{debut, fin}] … } -> regularHours (Google). Une plage qui finit avant de commencer
 * (ex. 19:00 -> 02:00) se ferme le lendemain. */
export function horairesVersGoogle(h: Horaires): {
  periods: Array<Record<string, unknown>>;
} {
  const periods: Array<Record<string, unknown>> = [];
  for (const [i, jour] of JOURS.entries()) {
    for (const p of h[jour] || []) {
      const nuit = p.fin !== '24:00' && p.fin <= p.debut;
      periods.push({
        openDay: jour,
        openTime: versTimeOfDay(p.debut),
        closeDay: nuit ? JOURS[(i + 1) % 7] : jour,
        closeTime: versTimeOfDay(p.fin),
      });
    }
  }
  return { periods };
}

/** Message d'erreur si les horaires sont incohérents, sinon null. */
export function verifierHoraires(h: Horaires): string | null {
  for (const jour of Object.keys(h)) {
    if (!JOURS.includes(jour as Jour)) return `Jour inconnu : ${jour}.`;
    for (const p of h[jour as Jour] || []) {
      if (!heureValide(p.debut) || !heureValide(p.fin))
        return 'Heures au format HH:MM attendues (ex. 09:00).';
      if (p.debut === p.fin)
        return 'Une plage horaire ne peut pas commencer et finir à la même heure.';
    }
  }
  return null;
}

const versDateGoogle = (d: string): DateGoogle => {
  const [year, month, day] = d.split('-').map(Number);
  return { year, month, day };
};
const depuisDateGoogle = (d: DateGoogle) =>
  `${d.year}-${deux(d.month)}-${deux(d.day)}`;

export function horairesSpeciauxDepuisGoogle(
  p: Array<Record<string, unknown>> | undefined,
): HoraireSpecial[] {
  return (p || []).map((s) => ({
    date: depuisDateGoogle(s.startDate as DateGoogle),
    ferme: Boolean(s.closed),
    ...(s.closed
      ? {}
      : {
          debut: versHeure(s.openTime as TimeOfDay),
          fin: versHeure(s.closeTime as TimeOfDay),
        }),
  }));
}

export function horairesSpeciauxVersGoogle(liste: HoraireSpecial[]): {
  specialHourPeriods: Array<Record<string, unknown>>;
} {
  return {
    specialHourPeriods: liste.map((s) =>
      s.ferme
        ? { startDate: versDateGoogle(s.date), closed: true }
        : {
            startDate: versDateGoogle(s.date),
            openTime: versTimeOfDay(s.debut!),
            closeTime: versTimeOfDay(s.fin!),
          },
    ),
  };
}

export function verifierHorairesSpeciaux(
  liste: HoraireSpecial[],
): string | null {
  for (const s of liste) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || ''))
      return 'Date au format AAAA-MM-JJ attendue.';
    if (!s.ferme && (!heureValide(s.debut) || !heureValide(s.fin)))
      return 'Indique les heures du jour exceptionnel (HH:MM).';
  }
  return null;
}

/** Catégories de photo acceptées par Google. */
export const CATEGORIES_PHOTO = [
  'COVER',
  'PROFILE',
  'LOGO',
  'EXTERIOR',
  'INTERIOR',
  'PRODUCT',
  'FOOD_AND_DRINK',
  'MENU',
  'COMMON_AREA',
  'ROOMS',
  'TEAMS',
  'AT_WORK',
  'ADDITIONAL',
] as const;

/** Types de liens d'action (prise de rendez-vous, commande…). */
export const TYPES_LIEN = [
  'APPOINTMENT',
  'ONLINE_APPOINTMENT',
  'DINING_RESERVATION',
  'FOOD_ORDERING',
  'FOOD_DELIVERY',
  'FOOD_TAKEOUT',
  'SHOP_ONLINE',
] as const;

/** Avis Google -> format écran. */
export function avisDepuisGoogle(r: Record<string, unknown>) {
  const auteur = (r.reviewer as Record<string, unknown>) || {};
  const reponse = r.reviewReply as Record<string, unknown> | null;
  return {
    id: (r.id as string) || ((r.name as string) || '').split('/').pop() || '',
    auteur: auteur.isAnonymous ? null : (auteur.displayName as string) || null,
    photo: (auteur.profilePhotoUrl as string) || null,
    note:
      Number(r.rating) ||
      { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[String(r.starRating)] ||
      0,
    texte: (r.comment as string) || '',
    date: (r.createTime as string) || null,
    reponse: reponse?.comment
      ? {
          texte: reponse.comment as string,
          date: (reponse.updateTime as string) || null,
        }
      : null,
  };
}

/** Photo de la fiche -> format écran (l'identifiant est la fin du nom de ressource). */
export function photoDepuisGoogle(m: Record<string, unknown>) {
  return {
    id: ((m.name as string) || '').split('/').pop() || '',
    url: (m.googleUrl as string) || null,
    miniature: (m.thumbnailUrl as string) || (m.googleUrl as string) || null,
    categorie:
      ((m.locationAssociation as Record<string, unknown>)
        ?.category as string) || 'ADDITIONAL',
    description: (m.description as string) || '',
    date: (m.createTime as string) || null,
    video: m.mediaFormat === 'VIDEO',
  };
}
