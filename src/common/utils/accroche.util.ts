import * as crypto from 'crypto';

/**
 * Accroches : formules, présélection et garde-fous — port de backend/services/accroche_service.py
 * (idées reprises du skill « instagram-agent-skill », licence MIT, adaptées au français et aux PME).
 *
 * Le CODE fait tout ce qui est objectif et gratuit ; l'IA n'écrit l'accroche que dans l'appel de
 * rédaction existant. Étape 0 (octobre 2026) : l'essentiel dès le début (+0,43) et un fait concret
 * (+0,22) suivent les interactions ; la consigne insiste sur ces deux points.
 */
export interface FormuleAccroche {
  id: number;
  nom: string;
  modele: string;
  chiffre: boolean;
}

export const FORMULES: FormuleAccroche[] = [
  { id: 1, nom: 'Ce que ça a coûté', modele: "{montant précis} : ce qu'{une erreur} a coûté.", chiffre: true },
  { id: 2, nom: 'Arrête / fais plutôt', modele: 'Arrête de {habitude courante}. Fais {alternative}.', chiffre: false },
  { id: 3, nom: 'Personne ne le dit', modele: 'Personne ne dit aux {public} que {vérité inconfortable}.', chiffre: false },
  { id: 4, nom: 'Le remplacement', modele: '{Ceci} a remplacé {chose coûteuse} pour {prix}.', chiffre: true },
  { id: 5, nom: 'Avant / maintenant', modele: 'Avant, {tâche} prenait {durée longue}. Maintenant, {durée courte}.', chiffre: true },
  { id: 6, nom: 'Le relevé', modele: "J'ai {fait quelque chose} pendant {durée}. Voici les vrais chiffres.", chiffre: true },
  { id: 7, nom: 'Mal fait, pas ta faute', modele: "Tu {fais X} de travers, et ce n'est pas ta faute.", chiffre: false },
  { id: 8, nom: 'Les coulisses', modele: "{N années} à {faire ce métier}. Voici ce qu'on ne dit jamais.", chiffre: false },
  { id: 9, nom: 'La vraie question', modele: '« {question telle que les clients la posent} » {réponse courte et tranchée}.', chiffre: false },
  { id: 10, nom: "L'objection", modele: "« {objection réelle} » D'accord. Voici ce qui marche quand même.", chiffre: false },
  { id: 11, nom: 'La scène', modele: '{Moment précis, en pleine action} : {le problème arrive}.', chiffre: false },
  { id: 12, nom: 'Le contre-pied', modele: '{Idée reçue du secteur, retournée.}', chiffre: false },
  { id: 13, nom: "L'échéance", modele: '{Ceci} change le {date}. Fais {action} avant.', chiffre: false },
  { id: 14, nom: 'Liste avec une préférée', modele: '{N} {choses} qui {résultat}. La {k}e, presque personne ne la fait.', chiffre: true },
];
const IDS = new Set(FORMULES.map((f) => f.id));
const NB_PROPOSEES = 7;

export const A_EVITER = [
  'Dans un monde en constante évolution', "À l'ère du numérique", 'Il est important de noter',
  "N'hésitez pas à", 'Plongeons dans', 'Que vous soyez', "Ce n'est pas seulement X, c'est Y",
  'Non seulement… mais aussi', 'Et si je vous disais', 'Le résultat ?', 'Spoiler :',
  "Voici ce que j'ai appris", 'Imaginez un monde où', "La vérité, c'est que",
];

const NOMBRE = /\d+(?:[ .,  ]\d+)*/g;
const LIGNE_FORMULE = /^\s*FORMULE\s*[:：]\s*(\d{1,2})\s*$/gim;
const INVISIBLES = /[​‌‍⁠﻿­᠎؜⁡-⁤]/g;

export function selectionFormules(sujet: string, infos = '', dimensions?: Record<string, unknown> | null): FormuleAccroche[] {
  const sources = `${sujet} ${infos} ${Object.values(dimensions || {}).map(String).join(' ')}`;
  const aChiffre = /\d/.test(sources);
  const possibles = FORMULES.filter((f) => aChiffre || !f.chiffre);
  const hex = crypto.createHash('md5').update(sujet || '', 'utf-8').digest('hex');
  const depart = Number(BigInt(`0x${hex}`) % BigInt(possibles.length));
  return [...possibles.slice(depart), ...possibles.slice(0, depart)].slice(0, NB_PROPOSEES);
}

export function blocConsigneAccroche(sujet: string, infos = '', dimensions?: Record<string, unknown> | null): string {
  const lignes = selectionFormules(sujet, infos, dimensions).map((f) => `${f.id}. ${f.nom} : ${f.modele}`).join('\n');
  return (
    '\n\n## HOOK (the first line decides whether people read on)\n' +
    'Before writing, silently draft three different first lines, each from a DIFFERENT formula ' +
    'below, and keep the strongest one. Do not show the drafts.\n' +
    `${lignes}\n` +
    'Rules for the first line: put the key fact or the stake in the FIRST words (no warm-up, ' +
    'no greeting); prefer one concrete, real detail (a figure, a moment, a name) taken ONLY from ' +
    'the topic, the brief or the brand information above. NEVER invent a number, a client or a ' +
    'result; if no real figure is given, use a formula without one. Keep it short (about 12 ' +
    'words at most) and specific to this brand, not a line any competitor could post. Never ' +
    'claim something about the client that is not in the information above (how often they ' +
    'are asked something, how many clients they have, results).\n' +
    'Avoid these AI-sounding phrasings (and their equivalents in the output language): ' +
    A_EVITER.map((x) => `« ${x} »`).join('; ') +
    '.\nAfter the post, add one last separate line exactly like: FORMULE: <number of the formula used>.'
  );
}

export function extraireFormule(texte: string): { texte: string; formule: number | null } {
  const trouves = [...(texte || '').matchAll(LIGNE_FORMULE)].map((m) => Number(m[1]));
  const propre = (texte || '').replace(LIGNE_FORMULE, '').trimEnd();
  const n = trouves.length ? trouves[trouves.length - 1] : null;
  return { texte: propre, formule: n !== null && IDS.has(n) ? n : null };
}

export function sansInvisibles(texte: string): string {
  return (texte || '').replace(INVISIBLES, '');
}

export function premiereLigne(texte: string): string {
  return ((texte || '').split('\n').find((l) => l.trim()) || '').trim();
}

/** Nombres de l'accroche absents des infos fournies (hors petits nombres 1 à 9). */
export function chiffresNonSources(accroche: string, sources: string): string[] {
  const norm = (s: string) => s.replace(/[ .,  ]/g, '');
  const dispo = new Set((sources.match(NOMBRE) || []).map(norm));
  return (accroche.match(NOMBRE) || []).filter((x) => {
    const n = norm(x);
    return !dispo.has(n) && !(/^\d+$/.test(n) && Number(n) < 10);
  });
}
