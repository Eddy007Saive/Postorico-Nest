import { PostsService } from './posts.service';
import { selectionFormules } from '../../common/utils/accroche.util';

// Accroches et premier commentaire : Claude et la marque sont simulés.
describe('PostsService : accroches et premier commentaire', () => {
  const messagesCreate = jest.fn().mockResolvedValue({});
  const texte = jest.fn();
  const marque = {
    chargerMarque: jest.fn().mockResolvedValue({ nom: 'Conciergerie Azur' }),
    contexteMarque: jest.fn().mockReturnValue('\n\nBRAND: Conciergerie Azur, 200 biens gérés.'),
    contexteMarqueCourt: jest.fn().mockReturnValue(''),
  };
  const service = new PostsService(
    { messagesCreate, texte } as never,
    marque as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn() } as never,
  );
  const post = 'Chaque semaine, un propriétaire me pose la même question.\n\nVoici ma réponse.';

  it('garde une accroche par formule proposée, sans doublon, et signale un chiffre inventé', async () => {
    const [f1, f2, f3] = selectionFormules(post, '\n\nBRAND: Conciergerie Azur, 200 biens gérés.');
    texte.mockReturnValue(JSON.stringify({
      accroches: [
        { formule: f1.id, texte: '« 200 biens gérés, et toujours la même question. »' },
        { formule: f2.id, texte: '35 000 € perdus en un été.' },
        { formule: f3.id, texte: '200 biens gérés, et toujours la même question.' },
        { formule: 999, texte: 'Formule inconnue' },
        { formule: f3.id, texte: '' },
      ],
    }));
    const r = await service.accroches('u1', post, 'linkedin');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ formule: f1.id, nom: f1.nom, texte: '200 biens gérés, et toujours la même question.', chiffres_non_sources: [] });
    expect(r[1].chiffres_non_sources).toEqual(['35 000']);
  });

  it('renvoie une liste vide si la réponse n’est pas du JSON', async () => {
    texte.mockReturnValue('Désolé, je ne peux pas.');
    await expect(service.accroches('u1', post)).resolves.toEqual([]);
  });

  it('nettoie le premier commentaire et le coupe à la limite du réseau', async () => {
    texte.mockReturnValue('« Et vous, quelle question revient le plus ? »');
    await expect(service.premierCommentaire('u1', post, 'linkedin')).resolves.toBe('Et vous, quelle question revient le plus ?');
    texte.mockReturnValue('a'.repeat(2000));
    await expect(service.premierCommentaire('u1', post, 'linkedin')).resolves.toHaveLength(1250);
  });
});
