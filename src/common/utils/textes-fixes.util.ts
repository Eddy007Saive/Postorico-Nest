/**
 * Textes FIXES posés par le code dans les livrables du client (étiquettes de carrousel, appels à
 * l'action de secours des stories et reels, libellés des gabarits…), dans la langue du compte.
 *
 * Avant, ces textes étaient écrits en dur en français : un compte en espagnol recevait des
 * slides « Étape 01 · À toi de jouer » et des reels qui disaient « Suis-nous » (retour client
 * du 15/10/2026). Tout texte fixe qui finit sous les yeux du PUBLIC du client passe par ici.
 */
export type Langue = 'fr' | 'en' | 'es';

/** Normalise users.langue (« es », « ES », « es-ES », vide…) ; français par défaut. */
export function langueCode(v: unknown): Langue {
  const l = (typeof v === 'string' ? v : '').trim().toLowerCase().slice(0, 2);
  return l === 'en' || l === 'es' ? l : 'fr';
}

const TEXTES = {
  // Carrousels (modèles intégrés et styles partagés)
  carrousel: { fr: 'Carrousel', en: 'Carousel', es: 'Carrusel' },
  swipe: { fr: 'Swipe →', en: 'Swipe →', es: 'Desliza →' },
  // « Pro tip » reste tel quel en français : c'est ce que voient les clients français aujourd'hui.
  proTip: { fr: 'Pro tip', en: 'Pro tip', es: 'Consejo' },
  etape: { fr: 'Étape', en: 'Step', es: 'Paso' },
  idee: { fr: 'Idée', en: 'Idea', es: 'Idea' },
  aToiDeJouer: { fr: 'À toi de jouer', en: 'Your turn', es: 'Te toca' },
  aToi: { fr: 'À toi', en: 'Your turn', es: 'Te toca' },
  lienEnBio: {
    fr: 'Lien en bio →',
    en: 'Link in bio →',
    es: 'Enlace en la bio →',
  },
  chiffresCles: { fr: 'Chiffres clés', en: 'Key figures', es: 'Cifras clave' },
  leGeste: { fr: 'Le geste', en: 'Quick win', es: 'El gesto' },
  // Appels à l'action et titres de secours (stories, reels, slide finale)
  onEnParle: { fr: 'On en parle ?', en: "Let's talk?", es: '¿Hablamos?' },
  reponds: {
    fr: 'Réponds en DM 👉',
    en: 'Reply by DM 👉',
    es: 'Respóndeme por DM 👉',
  },
  suisNous: { fr: 'Suis-nous', en: 'Follow us', es: 'Síguenos' },
  decouvrir: { fr: 'Découvrir', en: 'Discover', es: 'Descubrir' },
  maMarque: { fr: 'Ma marque', en: 'My brand', es: 'Mi marca' },
  regarde: { fr: 'Regarde.', en: 'Watch.', es: 'Mira.' },
  contenuQuiTravaille: {
    fr: 'Un contenu qui travaille pour toi.',
    en: 'Content that works for you.',
    es: 'Un contenido que trabaja para ti.',
  },
  messageQuiCompte: {
    fr: 'Un message qui compte.',
    en: 'A message that matters.',
    es: 'Un mensaje que importa.',
  },
  simple: { fr: 'Simple.', en: 'Simple.', es: 'Simple.' },
  rapide: { fr: 'Rapide.', en: 'Fast.', es: 'Rápido.' },
  aTaMarque: { fr: 'À ta marque.', en: 'On brand.', es: 'Con tu marca.' },
  simpleRapide: {
    fr: 'Simple et rapide',
    en: 'Simple and fast',
    es: 'Simple y rápido',
  },
  aTaMarqueCourt: { fr: 'À ta marque', en: 'On brand', es: 'Con tu marca' },
  tuGardes: {
    fr: 'Tu gardes le contrôle',
    en: 'You stay in control',
    es: 'Tú mantienes el control',
  },
  avant: { fr: 'AVANT', en: 'BEFORE', es: 'ANTES' },
  apres: { fr: 'APRÈS', en: 'AFTER', es: 'DESPUÉS' },
  offre: { fr: 'Offre', en: 'Offer', es: 'Oferta' },
  // Gabarits de post : étiquettes affichées quand le champ est vide
  gVision: { fr: 'Vision', en: 'Vision', es: 'Visión' },
  gAcquisition: { fr: 'Acquisition', en: 'Acquisition', es: 'Captación' },
  gTemoignage: { fr: 'Témoignage', en: 'Testimonial', es: 'Testimonio' },
  gDonnees: { fr: 'Vos données', en: 'Your data', es: 'Tus datos' },
  gIa: { fr: "Boosté par l'IA", en: 'AI-powered', es: 'Impulsado por IA' },
  gReponse: {
    fr: 'Réponse client',
    en: 'Customer reply',
    es: 'Respuesta al cliente',
  },
  gDelegation: { fr: 'Délégation', en: 'Delegation', es: 'Delegación' },
  gMission: { fr: 'Notre mission', en: 'Our mission', es: 'Nuestra misión' },
  gIntegrations: {
    fr: 'Intégrations natives',
    en: 'Native integrations',
    es: 'Integraciones nativas',
  },
  gClients: { fr: 'Nos clients', en: 'Our clients', es: 'Nuestros clientes' },
  gEquipe: { fr: "L'équipe", en: 'The team', es: 'El equipo' },
} as const;

export type CleTexte = keyof typeof TEXTES;

/** Le texte fixe `cle` dans la langue du compte. */
export function tf(langue: unknown, cle: CleTexte): string {
  return TEXTES[cle][langueCode(langue)];
}

/** Guillemets d'une citation dans la langue du compte (« » en français et espagnol, “ ” en anglais). */
export function guillemets(langue: unknown, texte: string): string {
  const l = langueCode(langue);
  return l === 'en' ? `“${texte}”` : `« ${texte} »`;
}
