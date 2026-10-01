import { ContenuEvenementService } from './contenu-evenement.service';

// Port de `log_evenement` (backend/services/contenu_service.py) : une ligne par étape du
// cycle de vie, toujours best-effort — une panne de journalisation ne doit jamais remonter.
describe('ContenuEvenementService.log', () => {
  function makeService(create: jest.Mock) {
    const prismaStub = { contenu_evenement: { create } } as never;
    return new ContenuEvenementService(prismaStub);
  }

  it('insère une ligne avec contenu_id, type, acteur et texte', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = makeService(create);
    await service.log('c1', 'refuse', 'u1', 'Trop long');
    expect(create).toHaveBeenCalledWith({
      data: { contenu_id: 'c1', type: 'refuse', acteur: 'u1', texte: 'Trop long' },
    });
  });

  it("acteur et texte absents -> null (événement système, ex. 'publie' confirmé par Zernio)", async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = makeService(create);
    await service.log('c1', 'publie');
    expect(create).toHaveBeenCalledWith({
      data: { contenu_id: 'c1', type: 'publie', acteur: null, texte: null },
    });
  });

  it("n'échoue JAMAIS l'action appelante : une erreur base est avalée", async () => {
    const create = jest.fn().mockRejectedValue(new Error('base injoignable'));
    const service = makeService(create);
    await expect(service.log('c1', 'valide', 'u1')).resolves.toBeUndefined();
  });
});
