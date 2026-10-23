/**
 * Structures de post au choix du client (Studio IA). « auto » = rien d'imposé : le rédacteur
 * garde son format habituel. Méthode inspirée de la skill post-formatter
 * (charlie947/social-media-skills, MIT).
 */
export const STRUCTURES: Record<string, string> = {
  aida:
    'AIDA. 1) Attention: a first line that stops the scroll (a surprising fact, a bold claim the brand can back, or a sharp question). ' +
    '2) Interest: why it matters to the reader, with one concrete detail. 3) Desire: the benefit or result the reader wants, made tangible. ' +
    '4) Action: one clear, specific call to action.',
  pas:
    'PAS. 1) Problem: name a pain the reader really lives, in their words. 2) Agitation: show what it costs them (time, money, stress), ' +
    'one or two concrete consequences, without exaggerating. 3) Solution: the way out, how the brand approaches it, then a soft call to action.',
  bab:
    'BEFORE / AFTER / BRIDGE. 1) Before: the situation and frustration before (a client, the founder, or the reader). ' +
    '2) After: the situation once solved, concrete and believable. 3) Bridge: what made the difference, the method or the key decision. End with a question or a call to action.',
  star:
    'STAR, a story. 1) Situation: set the scene in one or two lines (who, where, when). 2) Task: the challenge or what was at stake. ' +
    '3) Action: what was actually done, step by step. 4) Result: the outcome, with a fact or a reaction, then the lesson in one line.',
  slay:
    'SLAY, a personal lesson. 1) Story: a short real anecdote from the founder. 2) Lesson: what it taught them. ' +
    '3) Actionable advice: one thing the reader can apply today. 4) You: end with a question to the reader that invites a comment.',
};

export const CLES_STRUCTURES = ['auto', ...Object.keys(STRUCTURES)];

/** Consigne de structure à ajouter à la demande de rédaction ; vide pour « auto » ou inconnu. */
export function blocStructure(cle: unknown): string {
  const consigne = typeof cle === 'string' ? STRUCTURES[cle] : undefined;
  if (!consigne) return '';
  return (
    `\n\nMANDATORY POST STRUCTURE (it overrides the default format order above, keep the hook rules): ${consigne} ` +
    'Follow these parts in this order, as natural paragraphs, without writing their names or labels in the post.'
  );
}

/** Réseaux où Zernio publie le premier commentaire (pas TikTok, X ni la fiche Google ; pas les stories). */
export const RESEAUX_PREMIER_COMMENTAIRE = ['linkedin', 'facebook', 'instagram', 'youtube'];

export const LIMITE_PREMIER_COMMENTAIRE: Record<string, number> = {
  linkedin: 1250,
  instagram: 2200,
  facebook: 8000,
  youtube: 10000,
};
