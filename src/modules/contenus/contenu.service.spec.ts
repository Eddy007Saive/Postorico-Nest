import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { CarrouselRenduService } from '../carrousel/carrousel-rendu.service';
import { LateService } from '../late/late.service';
import { MemoireService } from '../memoire/memoire.service';
import { PlanningService } from '../planning/planning.service';
import { ContenuService } from './contenu.service';

// Port de la section "mémoire de voix" de update_contenu (backend/services/contenu_service.py) :
// un contenu dont statut/contenu/titre changent doit (re)passer par indexerContenu — absent
// du premier portage NestJS (repéré le 2026-09-29, comparaison systématique Python/NestJS).
describe('ContenuService.updateContenu — déclenche indexerContenu', () => {
  function buildService(row: Record<string, unknown>) {
    const prisma = {
      contenu: {
        findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    } as unknown as PrismaService;
    const planningService = { prochainCreneau: jest.fn() } as unknown as PlanningService;
    const lateService = { programmerContenu: jest.fn() } as unknown as LateService;
    const carrouselRendu = {} as unknown as CarrouselRenduService;
    const memoireService = { indexerContenu: jest.fn().mockResolvedValue(true) } as unknown as MemoireService;
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const service = new ContenuService(prisma, planningService, lateService, carrouselRendu, memoireService, configStub);
    return { service, memoireService };
  }

  const rowBase = { id: 'c1', telegram_id: 'u1', statut: 'A_valider', type: 'Post_court' };

  it('appelle indexerContenu quand `titre` change', async () => {
    const { service, memoireService } = buildService(rowBase);
    await service.updateContenu('c1', 'u1', { titre: 'Nouveau titre' });
    expect(memoireService.indexerContenu).toHaveBeenCalledTimes(1);
  });

  it('appelle indexerContenu quand `contenu` change', async () => {
    const { service, memoireService } = buildService(rowBase);
    await service.updateContenu('c1', 'u1', { contenu: 'Nouveau texte' });
    expect(memoireService.indexerContenu).toHaveBeenCalledTimes(1);
  });

  it('appelle indexerContenu quand `statut` change (ex. validation)', async () => {
    const { service, memoireService } = buildService(rowBase);
    await service.updateContenu('c1', 'u1', { statut: 'Publie' });
    expect(memoireService.indexerContenu).toHaveBeenCalledTimes(1);
  });

  it("n'appelle PAS indexerContenu pour une modification qui ne touche ni statut, ni contenu, ni titre", async () => {
    const { service, memoireService } = buildService(rowBase);
    await service.updateContenu('c1', 'u1', { date_publication: '2026-10-01' });
    expect(memoireService.indexerContenu).not.toHaveBeenCalled();
  });

  it("un échec d'indexation ne fait pas planter la mise à jour du contenu", async () => {
    const { service, memoireService } = buildService(rowBase);
    (memoireService.indexerContenu as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(service.updateContenu('c1', 'u1', { titre: 'X' })).resolves.toBeDefined();
  });
});
