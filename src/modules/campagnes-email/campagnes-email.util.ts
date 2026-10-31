/** Règles pures des campagnes email (sans base ni réseau), testées à part. */

export interface ContactCampagne {
  email: string;
  prenom?: string | null;
  entreprise?: string | null;
  note?: string | null;
}

/** Au-delà, ce n'est plus une « petite campagne » : la boîte du client n'est pas faite pour ça. */
export const MAX_DESTINATAIRES = 500;
/** Zernio met la boîte en pause si le même corps part à plus de 50 destinataires en une heure :
 * on reste en dessous même si les textes sont personnalisés. */
export const PAR_HEURE_MAX = 40;
export const PAR_HEURE_DEFAUT = 30;
/** Part du plafond quotidien laissée aux campagnes : le reste sert au courrier normal du client. */
export const PART_PLAFOND_CAMPAGNES = 0.8;

/** Une valeur reçue de l'extérieur (JSON, base) en texte : seulement les chaînes et nombres. */
export function chaine(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

const RE_EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

export function emailValide(e: string): boolean {
  return RE_EMAIL.test(e.trim());
}

function propre(v: unknown, max: number): string | null {
  const s = chaine(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Nettoie une liste de contacts : adresses valides, en minuscules, sans doublon (ni avec
 * `deja`), plafonnée à `place` entrées. Renvoie aussi le nombre d'entrées écartées. */
export function nettoyerContacts(
  contacts: ContactCampagne[],
  deja: Iterable<string> = [],
  place = MAX_DESTINATAIRES,
): { gardes: ContactCampagne[]; ecartes: number } {
  const vus = new Set([...deja].map((e) => e.toLowerCase()));
  const gardes: ContactCampagne[] = [];
  let ecartes = 0;
  for (const c of contacts || []) {
    const email = String(c?.email ?? '')
      .trim()
      .toLowerCase();
    if (!emailValide(email) || vus.has(email) || gardes.length >= place) {
      ecartes++;
      continue;
    }
    vus.add(email);
    gardes.push({
      email,
      prenom: propre(c.prenom, 80),
      entreprise: propre(c.entreprise, 120),
      note: propre(c.note, 500),
    });
  }
  return { gardes, ecartes };
}

/** Plafond quotidien d'envoi de la boîte (chiffres publiés par Zernio). */
export function plafondJour(
  fournisseur: string,
  adresse?: string | null,
): number {
  if (fournisseur === 'microsoft') return 1000;
  if (/@(gmail|googlemail)\.com$/i.test(adresse || '')) return 200;
  return 500;
}

/** Combien de mails partent à ce passage du planificateur (toutes les 2 min), pour étaler
 * l'envoi sur l'heure au lieu de tout envoyer d'un coup. */
export function envoisParPassage(
  parHeure: number,
  minutesEntrePassages = 2,
): number {
  return Math.max(1, Math.ceil((parHeure * minutesEntrePassages) / 60));
}

export function bornerParHeure(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return PAR_HEURE_DEFAUT;
  return Math.min(PAR_HEURE_MAX, Math.max(5, v));
}

/** Lit la réponse de l'IA : un tableau JSON [{email, objet, corps}], éventuellement entouré
 * de texte ou d'une clôture ```json. Les entrées incomplètes sont ignorées. */
export function lireRedactions(
  texte: string,
): { email: string; objet: string; corps: string }[] {
  const debut = texte.indexOf('[');
  const fin = texte.lastIndexOf(']');
  if (debut < 0 || fin <= debut) return [];
  let brut: unknown;
  try {
    brut = JSON.parse(texte.slice(debut, fin + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(brut)) return [];
  const out: { email: string; objet: string; corps: string }[] = [];
  for (const r of brut) {
    const email = chaine((r as Record<string, unknown>)?.email)
      .trim()
      .toLowerCase();
    const objet = chaine((r as Record<string, unknown>)?.objet).trim();
    const corps = chaine((r as Record<string, unknown>)?.corps).trim();
    if (email && objet && corps)
      out.push({
        email,
        objet: objet.slice(0, 200),
        corps: corps.slice(0, 5000),
      });
  }
  return out;
}

/** Texte lisible d'un message (le texte brut s'il existe, sinon le HTML sans balises). */
export function texteMessage(m: {
  text?: string | null;
  html?: string | null;
  snippet?: string | null;
}): string {
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.html) {
    return m.html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return (m.snippet || '').trim();
}
