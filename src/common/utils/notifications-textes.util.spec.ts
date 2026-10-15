import { motNotif, texteNotif } from './notifications-textes.util';

describe('textes des notifications', () => {
  it('garde le français tel quel', () => {
    expect(texteNotif('fr', 'reelPret')).toEqual({
      titre: 'Ton reel est prêt 🎬',
      message: 'À valider dans Contenus.',
    });
    expect(texteNotif('fr', 'reelEchec', { garde: '' }).message).toBe(
      "Le rendu n'a pas abouti. Supprime le reel et réessaie.",
    );
    expect(
      texteNotif('fr', 'publie', { titre: 'X', reseau: 'linkedin' }).message,
    ).toBe('« X » a été publié sur linkedin.');
  });

  it('parle la langue du compte', () => {
    expect(texteNotif('es', 'reelPret').titre).toBe('Tu reel está listo 🎬');
    expect(
      texteNotif('en', 'commentaire', {
        reseau: 'Instagram',
        auteur: 'Ana',
        texte: '',
      }).message,
    ).toBe('Ana commented on your post');
    expect(
      texteNotif('es', 'publicationsAnnulees', { n: 2, paiement: '' }).titre,
    ).toBe('2 publicaciones canceladas');
    expect(motNotif('es', 'tonPost')).toBe('Tu post');
  });
});
