/** Rôle d'une personne invitée dans l'équipe d'un compte. */
export type RoleEquipe = 'editeur' | 'admin';

export const ROLES_EQUIPE: RoleEquipe[] = ['editeur', 'admin'];

/** Nombre de personnes qu'un compte peut inviter (invitations en attente comprises). */
export const MAX_MEMBRES_EQUIPE = 2;

type Regle = [methodes: string, chemin: RegExp];

// Réservé au propriétaire du compte, quel que soit le rôle du membre : l'argent (abonnement,
// publicité payante), l'équipe elle-même, le compte (suppression, mot de passe, marques) et
// ce qui est personnel (affiliation, boîte mail connectée).
const PROPRIETAIRE: Regle[] = [
  ['*', /^\/billing(\/|$)/],
  ['*', /^\/equipe(?!\/invitation\/|\/rejoindre$)(\/|$)/],
  ['POST', /^\/accounts$/],
  ['DELETE', /^\/accounts\/[^/]+$/],
  ['DELETE', /^\/users\/me$/],
  ['POST', /^\/users\/me\/password$/],
  ['*', /^\/affiliation\/(demande|demande-externe|moi|mes-releves|mon-iban)$/],
  ['POST', /^\/emails\/boite\/connecter$/],
  ['DELETE', /^\/emails\/boite$/],
  ['POST', /^\/publicite\/booster$/],
  ['PUT', /^\/publicite\/pubs\/[^/]+\/statut$/],
  ['POST', /^\/configuration\/lien-pack$/],
];

// En plus pour l'éditeur : les réseaux connectés et les réglages de la marque, que seul
// l'administrateur de l'équipe touche. Il garde tout le travail sur les contenus.
const ADMIN_SEULEMENT: Regle[] = [
  ['PATCH', /^\/users\/me$/],
  ['POST', /^\/users\/me\/(connect|disconnect|photo|avatar|logo|logo-depuis-site|analyser-site)$/],
  ['DELETE', /^\/users\/me\/logo$/],
  ['POST,DELETE', /^\/users\/me\/inspirations(\/.*)?$/],
  ['POST', /^\/users\/me\/reconnexion\/[^/]+\/ignorer$/],
  ['PUT', /^\/users\/me\/schedules$/],
  ['POST,PATCH,DELETE', /^\/offers(\/[^/]+)?$/],
  ['POST,PATCH,DELETE', /^\/agent\/templates(\/[^/]+)?$/],
  ['POST', /^\/configuration\/(choix|formulaire|analyser-site)$/],
];

function touche(regles: Regle[], methode: string, chemin: string): boolean {
  return regles.some(([m, re]) => (m === '*' || m.split(',').includes(methode)) && re.test(chemin));
}

/** `chemin` sans le préfixe /api ni la requête : /users/me/connect. */
export function routeInterdite(role: RoleEquipe, methode: string, chemin: string): boolean {
  const m = methode.toUpperCase();
  const c = chemin.replace(/^\/api(?=\/)/, '').split('?')[0].replace(/\/+$/, '') || '/';
  if (touche(PROPRIETAIRE, m, c)) return true;
  return role === 'editeur' && touche(ADMIN_SEULEMENT, m, c);
}
