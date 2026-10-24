import { SujetsService } from './sujets.service';
import { DimensionsService } from '../dimensions/dimensions.service';

// Matrice piliers × formats : Claude, la marque et l'historique sont simulés.
describe('SujetsService.genererMatrice', () => {
  const messagesCreate = jest.fn().mockResolvedValue({ stop_reason: 'end_turn' });
  const texte = jest.fn();
  const prisma = {
    brouillons: { findMany: jest.fn().mockResolvedValue([{ titre: 'Déjà proposé : 5 erreurs de ménage' }]) },
    contenu: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const marque = {
    chargerMarque: jest.fn().mockResolvedValue({ secteur: 'Conciergerie', piliers: 'Ménage\nRevenus' }),
    contexteMarque: jest.fn().mockReturnValue('\n\nBRAND'),
    langueSortie: jest.fn().mockReturnValue('French'),
  };
  const dims = Object.create(DimensionsService.prototype) as DimensionsService;
  dims.formatsDisponibles = jest.fn().mockResolvedValue(['Reel', 'Post', 'Carrousel', 'Article']);
  const service = new SujetsService(
    prisma as never,
    { isConfigured: true, messagesCreate, texte, usage: jest.fn().mockReturnValue({}) } as never,
    marque as never,
    dims,
    {} as never,
  );

  it('une idée par case pilier × format, sans Article, sans doublon ni sujet déjà vu', async () => {
    texte.mockReturnValue(JSON.stringify({
      piliers: ['Ménage', 'Revenus'],
      idees: [
        { pilier: 'Ménage', format: 'Reel', sujet: '30 secondes pour refaire un lit d’hôtel', objectif: 'Engagement', angle: 'Démonstration' },
        { pilier: 'Ménage', format: 'Reel', sujet: 'Deuxième idée pour la même case', objectif: 'Engagement' },
        { pilier: 'Ménage', format: 'Post', sujet: 'Déjà proposé : 5 erreurs de ménage' },
        { pilier: 'Revenus', format: 'Carrousel', sujet: '7 réglages qui font monter le prix moyen', objectif: 'Inventé', angle: 'Astuce' },
        { pilier: 'Revenus', format: 'Article', sujet: 'Un article long' },
        { pilier: 'Pilier inconnu', format: 'Post', sujet: 'Hors matrice' },
      ],
    }));
    const r = await service.genererMatrice('u1');
    if ('error' in r) throw new Error(r.error);
    expect(r.formats).toEqual(['Reel', 'Post', 'Carrousel']);
    expect(r.piliers).toEqual(['Ménage', 'Revenus']);
    expect(r.idees.map((i) => `${i.pilier}|${i.format}`)).toEqual(['Ménage|Reel', 'Revenus|Carrousel', 'Revenus|Post']);
    expect(r.idees[1]).toMatchObject({ objectif: undefined, angle: 'Astuce' });
  });

  it('réponse illisible : erreur, pour rembourser le quota', async () => {
    texte.mockReturnValue('Je ne peux pas.');
    await expect(service.genererMatrice('u1')).resolves.toEqual({ error: 'reponse_illisible' });
  });

  it('profil sans secteur : refusé avant tout appel', async () => {
    marque.chargerMarque.mockResolvedValueOnce({ secteur: '' });
    messagesCreate.mockClear();
    await expect(service.genererMatrice('u1')).resolves.toEqual({ error: 'profil_incomplet' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
