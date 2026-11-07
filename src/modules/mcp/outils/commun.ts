/** Socle commun des outils du connecteur MCP. Chaque outil passe par les routes HTTP
 * existantes (avec un jeton du client) : mêmes quotas, règles d'accès et suivi des coûts
 * que l'application. */

/** `corps` : objet envoyé en JSON, ou FormData pour un envoi de fichier. */
export type Appel = (methode: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', chemin: string, corps?: unknown) => Promise<unknown>;

/** Erreur attendue (paramètre manquant, refus métier) : renvoyée telle quelle à l'assistant. */
export class ErreurOutil extends Error {}

export type Args = Record<string, unknown>;

/** Ce que le serveur fournit à un outil en plus de l'API : l'adresse d'envoi direct d'une image
 * dans un post (autorisation signée de 30 minutes, voir envoi-image.ts). */
export interface ContexteOutil {
  lienEnvoiImage: (contenuId: string, position: number) => { url: string; expire: string; commande: string };
}

export interface Outil {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  /** Action qui change quelque chose (création, modification, publication) : tracée dans journal_mcp. */
  journal?: boolean;
  executer: (api: Appel, args: Args, ctx: ContexteOutil) => Promise<unknown>;
}

export const RESEAUX = ['linkedin', 'instagram', 'facebook', 'tiktok', 'youtube', 'googlebusiness'];
/** Réseaux où un post peut être un texte (+ image) : TikTok et YouTube demandent une vidéo. */
export const RESEAUX_TEXTE = ['linkedin', 'instagram', 'facebook', 'googlebusiness'];
export const STATUTS = ['Brouillon', 'A valider', 'Valider', 'Planifie', 'Publie', 'Refuse'];

export const LECTURE = { readOnlyHint: true };
export const PUBLIC = { openWorldHint: true };

export const texte = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export const enc = encodeURIComponent;

export const exiger = (args: Args, cle: string) => {
  const v = texte(args[cle]);
  if (!v) throw new ErreurOutil(`Paramètre « ${cle} » requis.`);
  return v;
};

export function reseauValide(v: unknown, permis = RESEAUX, defaut?: string): string {
  const r = texte(v).toLowerCase() || defaut || '';
  if (!permis.includes(r)) throw new ErreurOutil(`Réseau ${r ? `« ${r} » ` : ''}non pris en charge ici. Possibles : ${permis.join(', ')}.`);
  return r;
}

export function entier(v: unknown, defaut: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : defaut;
}

/** Date ISO 8601 future, ou erreur claire. */
export function dateFuture(v: unknown, nom = 'date_publication'): Date {
  const d = new Date(texte(v));
  if (Number.isNaN(d.getTime())) throw new ErreurOutil(`${nom} invalide (format ISO 8601 attendu, ex. 2026-11-12T09:00:00+01:00).`);
  if (d.getTime() < Date.now()) throw new ErreurOutil(`${nom} est dans le passé.`);
  return d;
}

export type Contenu = Record<string, unknown>;

/** Vue d'un contenu : ce qu'un assistant a besoin de lire, sans les champs techniques. */
export function resume(c: Contenu, complet = false) {
  const corps = typeof c.contenu === 'string' ? c.contenu : '';
  return {
    id: c.id,
    titre: c.titre,
    statut: c.statut,
    reseau: c.reseau_cible,
    type: c.type,
    date_publication: c.date_publication ?? null,
    publication: c.publish_status ?? null,
    erreur_publication: c.publish_error ?? null,
    visuel: c.lien_visuel ?? null,
    ...(Array.isArray(c.slides_images) && c.slides_images.length ? { slides: c.slides_images.length } : {}),
    lien: c.lien_publication ?? null,
    ...(complet
      ? { texte: corps, premier_commentaire: c.premier_commentaire ?? null, motif_refus: c.motif_refus ?? null }
      : { extrait: corps.length > 220 ? `${corps.slice(0, 220)}…` : corps }),
  };
}

export const lireContenu = async (api: Appel, id: string) => (await api('GET', `/contenus/${enc(id)}`)) as Contenu;
export const tousContenus = async (api: Appel, statut?: string) =>
  (await api('GET', `/contenus${statut ? `?statut=${enc(statut)}` : ''}`)) as Contenu[];

export const dejaPublie = (c: Contenu) => c.statut === 'Publie' || c.publish_status === 'publié';
/** Programmé chez le réseau (Zernio) : une modification doit y être renvoyée. */
export const programmeChezReseau = (c: Contenu) =>
  !!c.late_post_id && (c.publish_status === 'programmé' || c.publish_status === 'envoi');

/** Valide un contenu (brouillon du Studio compris) et le programme : au prochain créneau
 * libre, ou à la date donnée. Même chemin que le bouton « Valider » de l'application. */
export async function validerEtProgrammer(api: Appel, id: string, date?: Date): Promise<Contenu> {
  const cur = await lireContenu(api, id);
  if (dejaPublie(cur)) throw new ErreurOutil('Ce contenu est déjà publié.');
  if (!cur.reseau_cible) throw new ErreurOutil("Ce contenu n'a pas de réseau cible : choisis-le dans Postorico avant de le programmer.");
  if (cur.statut === 'Brouillon') {
    await api('POST', '/agent/enregistrer', {
      contenu: cur.contenu || '',
      titre: cur.titre || undefined,
      reseau: texte(cur.reseau_cible).toLowerCase(),
      contenu_id: id,
      ...(cur.type === 'Story' ? { type: 'Story' } : {}),
    });
  }
  return (await api('PATCH', `/contenus/${enc(id)}`, { statut: 'Valider', ...(date ? { date_publication: date.toISOString() } : {}) })) as Contenu;
}

export function noteProgrammation(r: Contenu): string {
  if (!r.date_publication) return 'Validé, mais aucun créneau libre : vérifie la planification de ce réseau dans Postorico.';
  if (r.publish_status === 'envoi') return 'Validé et envoyé au réseau ; le statut passe à « Planifie » dès que le réseau confirme la programmation.';
  return "Validé et placé dans le planning, mais pas encore envoyé au réseau : vérifie qu'il est bien connecté (get_connected_social_accounts), puis retry_failed_publication.";
}

/** Sous-ensemble d'un objet, sans les champs vides. */
export function choisir(o: Record<string, unknown>, cles: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of cles) {
    const v = o[k];
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}
