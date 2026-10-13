/**
 * Options d'un post de fiche Google (colonne contenu.google_options) : type de post (nouveauté,
 * événement, offre), bouton d'action, dates de l'événement, détails de l'offre. Vérifiées avant
 * l'envoi (messages clairs en français) puis converties en platformSpecificData pour Zernio.
 * Doc : https://docs.zernio.com/platforms/google-business/reference et /events-offers
 */

export type TypePostGoogle = 'STANDARD' | 'EVENT' | 'OFFER';
export const BOUTONS_GOOGLE = [
  'LEARN_MORE',
  'BOOK',
  'ORDER',
  'SHOP',
  'SIGN_UP',
  'CALL',
] as const;
export type BoutonGoogle = (typeof BOUTONS_GOOGLE)[number];

export interface OptionsGoogle {
  type?: TypePostGoogle | null;
  bouton?: { type?: BoutonGoogle | null; url?: string | null } | null;
  /** debut / fin : « AAAA-MM-JJ » ou « AAAA-MM-JJTHH:MM » (heure locale de l'établissement). */
  evenement?: {
    titre?: string | null;
    debut?: string | null;
    fin?: string | null;
  } | null;
  offre?: {
    code?: string | null;
    lien?: string | null;
    conditions?: string | null;
  } | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** « 2026-12-24T18:30 » -> { date: {year, month, day}, time?: {hours, minutes} } */
export function dateGoogle(v: string): {
  date: { year: number; month: number; day: number };
  time?: { hours: number; minutes: number };
} | null {
  const m = DATE.exec(String(v || '').trim());
  if (!m) return null;
  const date = { year: +m[1], month: +m[2], day: +m[3] };
  return m[4] !== undefined
    ? { date, time: { hours: +m[4], minutes: +m[5] } }
    : { date };
}

const https = (u?: string | null) =>
  typeof u === 'string' && /^https:\/\/\S+$/.test(u.trim());

/** Message d'erreur lisible si les options ne permettent pas de publier, sinon null. */
export function verifierOptionsGoogle(
  o: OptionsGoogle | null | undefined,
): string | null {
  if (!o) return null;
  const type = o.type || 'STANDARD';
  if (!['STANDARD', 'EVENT', 'OFFER'].includes(type))
    return 'Type de post Google inconnu.';
  if (o.bouton?.type) {
    if (!BOUTONS_GOOGLE.includes(o.bouton.type))
      return "Bouton d'action Google inconnu.";
    // « Appeler » utilise le numéro de la fiche ; les autres boutons ouvrent un lien
    if (o.bouton.type !== 'CALL' && !https(o.bouton.url))
      return "Le bouton d'action a besoin d'un lien commençant par https://.";
  }
  if (type === 'EVENT' || (type === 'OFFER' && o.evenement?.debut)) {
    const e = o.evenement || {};
    if (type === 'EVENT' && !String(e.titre || '').trim())
      return "Donne un titre à l'événement.";
    const debut = dateGoogle(e.debut || '');
    const fin = dateGoogle(e.fin || e.debut || '');
    if (!debut || !fin)
      return type === 'EVENT'
        ? "Indique la date de début de l'événement."
        : "Dates de l'offre invalides.";
    const t = (x: NonNullable<ReturnType<typeof dateGoogle>>) =>
      Date.UTC(
        x.date.year,
        x.date.month - 1,
        x.date.day,
        x.time?.hours ?? 0,
        x.time?.minutes ?? 0,
      );
    if (t(fin) < t(debut)) return 'La date de fin est avant la date de début.';
  }
  if (type === 'OFFER') {
    const off = o.offre || {};
    if (off.lien && !https(off.lien))
      return "Le lien de l'offre doit commencer par https://.";
    if (!off.code && !off.lien && !off.conditions && !o.evenement?.titre)
      return "Précise l'offre : un code promo, un lien ou des conditions.";
  }
  return null;
}

/** platformSpecificData Zernio pour googlebusiness (options déjà vérifiées). */
export function donneesGoogle(
  o: OptionsGoogle | null | undefined,
  titreParDefaut = '',
): Record<string, unknown> | null {
  if (!o) return null;
  const type = o.type || 'STANDARD';
  const d: Record<string, unknown> = { topicType: type };
  if (o.bouton?.type)
    d.callToAction =
      o.bouton.type === 'CALL'
        ? { type: 'CALL' }
        : { type: o.bouton.type, url: String(o.bouton.url).trim() };
  const e = o.evenement;
  if ((type === 'EVENT' || type === 'OFFER') && e?.debut) {
    const debut = dateGoogle(e.debut)!;
    const fin = dateGoogle(e.fin || e.debut)!;
    const schedule: Record<string, unknown> = {
      startDate: debut.date,
      endDate: fin.date,
    };
    if (debut.time) schedule.startTime = debut.time;
    if (fin.time) schedule.endTime = fin.time;
    d.event = {
      title: String(e.titre || titreParDefaut || 'Offre')
        .trim()
        .slice(0, 58),
      schedule,
    };
  }
  if (type === 'OFFER') {
    const off = o.offre || {};
    const offer: Record<string, string> = {};
    if (off.code) offer.couponCode = String(off.code).trim().slice(0, 58);
    if (off.lien) offer.redeemOnlineUrl = String(off.lien).trim();
    if (off.conditions)
      offer.termsConditions = String(off.conditions).trim().slice(0, 5000);
    d.offer = offer;
  }
  return d;
}
