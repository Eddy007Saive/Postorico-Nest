import { Langue, langueCode } from './textes-fixes.util';

/**
 * Textes des notifications (cloche de l'app + push sur le téléphone) dans la langue du compte.
 *
 * Avant, ils étaient écrits en dur en français : un client en espagnol recevait « Ton reel est
 * prêt 🎬 » sur son téléphone (retour client du 15/10/2026). Le français est inchangé.
 */
type Vars = Record<string, string | number>;
type Texte = (v: Vars) => string;
type Notif = Record<Langue, [Texte, Texte]>;

const NOTIFS = {
  // Rendus en arrière-plan (reels, stories animées)
  reelEchec: {
    fr: [
      () => 'Reel : rendu échoué ❌',
      (v) =>
        "Le rendu n'a pas abouti." +
        (v.garde
          ? ' La version précédente est conservée.'
          : ' Supprime le reel et réessaie.'),
    ],
    en: [
      () => 'Reel: render failed ❌',
      (v) =>
        'The render did not complete.' +
        (v.garde
          ? ' The previous version is kept.'
          : ' Delete the reel and try again.'),
    ],
    es: [
      () => 'Reel: error de renderizado ❌',
      (v) =>
        'El renderizado no se completó.' +
        (v.garde
          ? ' Se conserva la versión anterior.'
          : ' Elimina el reel y vuelve a intentarlo.'),
    ],
  },
  reelSansVoix: {
    fr: [
      () => 'Ton reel est prêt, mais sans voix ⚠️',
      () =>
        'La voix off a échoué au rendu (quota remboursé). Régénère le reel pour retenter la voix.',
    ],
    en: [
      () => 'Your reel is ready, but without voice ⚠️',
      () =>
        'The voice-over failed during rendering (quota refunded). Regenerate the reel to retry the voice.',
    ],
    es: [
      () => 'Tu reel está listo, pero sin voz ⚠️',
      () =>
        'La voz en off falló en el renderizado (cuota reembolsada). Regenera el reel para volver a intentarlo.',
    ],
  },
  reelPret: {
    fr: [() => 'Ton reel est prêt 🎬', () => 'À valider dans Contenus.'],
    en: [() => 'Your reel is ready 🎬', () => 'Ready to approve in Contents.'],
    es: [
      () => 'Tu reel está listo 🎬',
      () => 'Listo para validar en Contenidos.',
    ],
  },
  serieEchec: {
    fr: [
      () => 'Série animée : rendu échoué ❌',
      () => "Aucun écran n'a pu être rendu. Supprime la série et réessaie.",
    ],
    en: [
      () => 'Animated series: render failed ❌',
      () => 'No screen could be rendered. Delete the series and try again.',
    ],
    es: [
      () => 'Serie animada: error de renderizado ❌',
      () =>
        'No se pudo renderizar ninguna pantalla. Elimina la serie y vuelve a intentarlo.',
    ],
  },
  seriePartielle: {
    fr: [
      () => 'Série animée prête (partiellement) ⚠️',
      (v) =>
        `${v.ok}/${v.total} écrans rendus, ${v.echecs} en échec. À valider dans Contenus.`,
    ],
    en: [
      () => 'Animated series ready (partly) ⚠️',
      (v) =>
        `${v.ok}/${v.total} screens rendered, ${v.echecs} failed. Ready to approve in Contents.`,
    ],
    es: [
      () => 'Serie animada lista (en parte) ⚠️',
      (v) =>
        `${v.ok}/${v.total} pantallas renderizadas, ${v.echecs} con error. Lista para validar en Contenidos.`,
    ],
  },
  seriePrete: {
    fr: [
      () => 'Ta série animée est prête 🎬',
      (v) => `${v.total} écrans rendus, à valider dans Contenus.`,
    ],
    en: [
      () => 'Your animated series is ready 🎬',
      (v) => `${v.total} screens rendered, ready to approve in Contents.`,
    ],
    es: [
      () => 'Tu serie animada está lista 🎬',
      (v) =>
        `${v.total} pantallas renderizadas, listas para validar en Contenidos.`,
    ],
  },
  storyEchec: {
    fr: [
      () => 'Story animée : rendu échoué ❌',
      () => "Le rendu n'a pas abouti. Supprime la story et réessaie.",
    ],
    en: [
      () => 'Animated story: render failed ❌',
      () => 'The render did not complete. Delete the story and try again.',
    ],
    es: [
      () => 'Story animada: error de renderizado ❌',
      () =>
        'El renderizado no se completó. Elimina la story y vuelve a intentarlo.',
    ],
  },
  storyPrete: {
    fr: [
      () => 'Ta story animée est prête 🎬',
      () => 'À valider dans Contenus.',
    ],
    en: [
      () => 'Your animated story is ready 🎬',
      () => 'Ready to approve in Contents.',
    ],
    es: [
      () => 'Tu story animada está lista 🎬',
      () => 'Lista para validar en Contenidos.',
    ],
  },
  // Montage par l'agent IA
  montagePret: {
    fr: [
      (v) =>
        v.corrige
          ? 'Ta vidéo corrigée est prête 🎬'
          : 'Ton montage IA est prêt 🎬',
      () => 'À valider dans Contenus.',
    ],
    en: [
      (v) =>
        v.corrige
          ? 'Your corrected video is ready 🎬'
          : 'Your AI edit is ready 🎬',
      () => 'Ready to approve in Contents.',
    ],
    es: [
      (v) =>
        v.corrige
          ? 'Tu vídeo corregido está listo 🎬'
          : 'Tu montaje IA está listo 🎬',
      () => 'Listo para validar en Contenidos.',
    ],
  },
  montageEchec: {
    fr: [
      () => 'Montage IA : échec ❌',
      () =>
        "Le montage n'a pas abouti (montage rendu sur ton quota). Supprime-le et réessaie.",
    ],
    en: [
      () => 'AI edit: failed ❌',
      () =>
        'The edit did not complete (credit returned to your quota). Delete it and try again.',
    ],
    es: [
      () => 'Montaje IA: error ❌',
      () =>
        'El montaje no se completó (devuelto a tu cuota). Elimínalo y vuelve a intentarlo.',
    ],
  },
  correctionImpossible: {
    fr: [
      () => 'Correction impossible',
      () =>
        'Ta vidéo précédente est conservée. Reformule la correction et réessaie.',
    ],
    en: [
      () => 'Correction not possible',
      () =>
        'Your previous video is kept. Rephrase the correction and try again.',
    ],
    es: [
      () => 'Corrección imposible',
      () =>
        'Se conserva tu vídeo anterior. Reformula la corrección y vuelve a intentarlo.',
    ],
  },
  // Facturation
  paiementRecu: {
    fr: [
      () => 'Paiement reçu, merci',
      () =>
        'Ton compte est de nouveau actif. Reconnecte tes réseaux pour reprendre la publication.',
    ],
    en: [
      () => 'Payment received, thank you',
      () =>
        'Your account is active again. Reconnect your networks to resume publishing.',
    ],
    es: [
      () => 'Pago recibido, gracias',
      () =>
        'Tu cuenta vuelve a estar activa. Reconecta tus redes para retomar la publicación.',
    ],
  },
  reseauxSuspendus: {
    fr: [
      () => 'Réseaux déconnectés',
      () =>
        "Ton paiement n'a pas été régularisé : tes réseaux ont été déconnectés. Mets à jour ta carte, puis reconnecte-les en trois clics.",
    ],
    en: [
      () => 'Networks disconnected',
      () =>
        'Your payment was not settled: your networks have been disconnected. Update your card, then reconnect them in three clicks.',
    ],
    es: [
      () => 'Redes desconectadas',
      () =>
        'Tu pago no se ha regularizado: tus redes se han desconectado. Actualiza tu tarjeta y vuelve a conectarlas en tres clics.',
    ],
  },
  publicationsAnnulees: {
    fr: [
      (v) =>
        `${v.n} publication${Number(v.n) > 1 ? 's' : ''} annulée${Number(v.n) > 1 ? 's' : ''}`,
      (v) =>
        (v.paiement
          ? 'Paiement en attente : '
          : 'Ton abonnement est terminé : ') +
        'les publications programmées ne partiront pas. Elles restent dans Contenus, prêtes à être reprogrammées si tu reviens.',
    ],
    en: [
      (v) => `${v.n} post${Number(v.n) > 1 ? 's' : ''} cancelled`,
      (v) =>
        (v.paiement ? 'Payment pending: ' : 'Your subscription has ended: ') +
        'scheduled posts will not go out. They stay in Contents, ready to be rescheduled if you come back.',
    ],
    es: [
      (v) =>
        `${v.n} publicaci${Number(v.n) > 1 ? 'ones canceladas' : 'ón cancelada'}`,
      (v) =>
        (v.paiement ? 'Pago pendiente: ' : 'Tu suscripción ha terminado: ') +
        'las publicaciones programadas no saldrán. Se quedan en Contenidos, listas para reprogramarse si vuelves.',
    ],
  },
  // Publication (événements Zernio)
  publie: {
    fr: [
      () => 'Post publié ✅',
      (v) => `« ${v.titre} » a été publié sur ${v.reseau}.`,
    ],
    en: [
      () => 'Post published ✅',
      (v) => `“${v.titre}” was published on ${v.reseau}.`,
    ],
    es: [
      () => 'Post publicado ✅',
      (v) => `«${v.titre}» se ha publicado en ${v.reseau}.`,
    ],
  },
  partiel: {
    fr: [
      () => 'Publication partielle ⚠️',
      (v) => `« ${v.titre} » a été publié partiellement sur ${v.reseau}.`,
    ],
    en: [
      () => 'Partial publication ⚠️',
      (v) => `“${v.titre}” was partly published on ${v.reseau}.`,
    ],
    es: [
      () => 'Publicación parcial ⚠️',
      (v) => `«${v.titre}» se ha publicado parcialmente en ${v.reseau}.`,
    ],
  },
  echecPublication: {
    fr: [
      () => 'Échec de publication ❌',
      (v) =>
        `« ${v.titre} » n'a pas pu être publié sur ${v.reseau} : ${v.raison}`,
    ],
    en: [
      () => 'Publication failed ❌',
      (v) => `“${v.titre}” could not be published on ${v.reseau}: ${v.raison}`,
    ],
    es: [
      () => 'Error de publicación ❌',
      (v) => `«${v.titre}» no se pudo publicar en ${v.reseau}: ${v.raison}`,
    ],
  },
  programme: {
    fr: [
      () => 'Publication programmée ⏱',
      (v) => `« ${v.titre} » est programmé sur ${v.reseau}.`,
    ],
    en: [
      () => 'Post scheduled ⏱',
      (v) => `“${v.titre}” is scheduled on ${v.reseau}.`,
    ],
    es: [
      () => 'Publicación programada ⏱',
      (v) => `«${v.titre}» está programado en ${v.reseau}.`,
    ],
  },
  annule: {
    fr: [
      () => 'Publication annulée',
      (v) => `La publication de « ${v.titre} » sur ${v.reseau} a été annulée.`,
    ],
    en: [
      () => 'Publication cancelled',
      (v) => `The publication of “${v.titre}” on ${v.reseau} was cancelled.`,
    ],
    es: [
      () => 'Publicación cancelada',
      (v) => `Se ha cancelado la publicación de «${v.titre}» en ${v.reseau}.`,
    ],
  },
  recycle: {
    fr: [
      () => 'Post recyclé ♻️',
      (v) => `« ${v.titre} » a été reprogrammé sur ${v.reseau}.`,
    ],
    en: [
      () => 'Post recycled ♻️',
      (v) => `“${v.titre}” was rescheduled on ${v.reseau}.`,
    ],
    es: [
      () => 'Post reciclado ♻️',
      (v) => `«${v.titre}» se ha reprogramado en ${v.reseau}.`,
    ],
  },
  reseauDeconnecte: {
    fr: [
      () => 'Réseau déconnecté ⚠️',
      (v) =>
        `Ton compte ${v.reseau} a été déconnecté. Reconnecte-le dans Paramètres → Réseaux pour continuer à publier.`,
    ],
    en: [
      () => 'Network disconnected ⚠️',
      (v) =>
        `Your ${v.reseau} account was disconnected. Reconnect it in Settings → Networks to keep publishing.`,
    ],
    es: [
      () => 'Red desconectada ⚠️',
      (v) =>
        `Tu cuenta de ${v.reseau} se ha desconectado. Vuelve a conectarla en Ajustes → Redes para seguir publicando.`,
    ],
  },
  // Commentaires reçus
  commentaire: {
    fr: [
      (v) => `💬 Nouveau commentaire · ${v.reseau}`,
      (v) =>
        v.texte ? `${v.auteur}: ${v.texte}` : `${v.auteur} a commenté ton post`,
    ],
    en: [
      (v) => `💬 New comment · ${v.reseau}`,
      (v) =>
        v.texte
          ? `${v.auteur}: ${v.texte}`
          : `${v.auteur} commented on your post`,
    ],
    es: [
      (v) => `💬 Nuevo comentario · ${v.reseau}`,
      (v) =>
        v.texte ? `${v.auteur}: ${v.texte}` : `${v.auteur} comentó tu post`,
    ],
  },
} satisfies Record<string, Notif>;

export type CleNotif = keyof typeof NOTIFS;

/** Titre et message de la notification `cle`, dans la langue du compte. */
export function texteNotif(
  langue: unknown,
  cle: CleNotif,
  vars: Vars = {},
): { titre: string; message: string } {
  const [titre, message] = (NOTIFS[cle] as Notif)[langueCode(langue)];
  return { titre: titre(vars), message: message(vars) };
}

/** Mots de secours glissés dans les notifications (titre de post absent, auteur inconnu…). */
const MOTS = {
  tonPost: { fr: 'Ton post', en: 'Your post', es: 'Tu post' },
  quelquun: { fr: "Quelqu'un", en: 'Someone', es: 'Alguien' },
  raisonInconnue: {
    fr: 'raison inconnue',
    en: 'unknown reason',
    es: 'motivo desconocido',
  },
} as const;

export function motNotif(langue: unknown, cle: keyof typeof MOTS): string {
  return MOTS[cle][langueCode(langue)];
}

/** Langue d'un compte (users.langue) pour ses notifications ; français si introuvable. */
export async function langueDuCompte(
  prisma: {
    users: {
      findUnique: (a: {
        where: { telegram_id: string };
        select: { langue: true };
      }) => Promise<{ langue: string | null } | null>;
    };
  },
  telegramId: string,
): Promise<Langue> {
  try {
    const u = await prisma.users.findUnique({
      where: { telegram_id: telegramId },
      select: { langue: true },
    });
    return langueCode(u?.langue);
  } catch {
    return 'fr';
  }
}
