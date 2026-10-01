import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { CarrouselRenduService } from '../carrousel/carrousel-rendu.service';
import { LateService } from '../late/late.service';
import { MemoireService } from '../memoire/memoire.service';
import { PlanningService } from '../planning/planning.service';
import { ContenuEvenementService } from './contenu-evenement.service';
import { ContenuService } from './contenu.service';

// Port de la mesure H2 de update_contenu (backend/services/contenu_service.py) : à la
// validation, le taux de réécriture est figé (contenu_original vs texte final), et
// valide_at / valide_par sont posés ; chaque étape est journalisée dans contenu_evenement
// (modifié, validé, refusé). Absent du premier portage (colonnes crues manquantes en base —
// à tort : elles existent, seul le schéma Prisma était en retard).
describe('ContenuService.updateContenu — mesure H2 et journal', () => {
  function buildService(row: Record<string, unknown>) {
    const update = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...row, ...args.data }));
    const prisma = {
      contenu: { findFirst: jest.fn().mockResolvedValue(row), update },
    } as unknown as PrismaService;
    const planningService = { prochainCreneau: jest.fn().mockResolvedValue(null) } as unknown as PlanningService;
    const lateService = { programmerContenu: jest.fn().mockResolvedValue({ ok: false }) } as unknown as LateService;
    const carrouselRendu = {} as unknown as CarrouselRenduService;
    const memoireService = { indexerContenu: jest.fn().mockResolvedValue(true) } as unknown as MemoireService;
    const log = jest.fn().mockResolvedValue(undefined);
    const contenuEvenement = { log } as unknown as ContenuEvenementService;
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const service = new ContenuService(prisma, planningService, lateService, carrouselRendu, memoireService, contenuEvenement, configStub);
    return { service, update, log };
  }

  const row = { id: 'c1', telegram_id: 'u1', statut: 'A_valider', type: 'Post_court', contenu_original: 'abcd', contenu: 'abcd' };

  it('validation : fige taux_reecriture, pose valide_at et valide_par', async () => {
    const { service, update } = buildService(row);
    await service.updateContenu('c1', 'u1', { statut: 'Valider', contenu: 'bcde' });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.taux_reecriture).toBe(0.25); // "abcd" -> "bcde", valeur difflib
    expect(data.valide_at).toBeInstanceOf(Date);
    expect(data.valide_at).toBe(data.updated_at);
    expect(data.valide_par).toBe('u1');
  });

  it('validation sans contenu_original : pas de taux (null -> non écrit), mais valide_at posé', async () => {
    const { service, update } = buildService({ ...row, contenu_original: null });
    await service.updateContenu('c1', 'u1', { statut: 'Valider' });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('taux_reecriture');
    expect(data.valide_par).toBe('u1');
  });

  it('validation avec texte modifié : deux événements distincts, "modifie" puis "valide"', async () => {
    const { service, log } = buildService(row);
    await service.updateContenu('c1', 'u1', { statut: 'Valider', contenu: 'texte retouché' });
    expect(log.mock.calls).toEqual([
      ['c1', 'modifie', 'u1', 'texte retouché'],
      ['c1', 'valide', 'u1'],
    ]);
  });

  it('refus : événement "refuse" avec le motif, aucune donnée H2 de validation', async () => {
    const { service, log, update } = buildService(row);
    await service.updateContenu('c1', 'u1', { statut: 'Refuse', motif_refus: 'Trop long' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('c1', 'refuse', 'u1', 'Trop long');
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.motif_refus).toBe('Trop long'); // écrit sur la ligne, lu par le Verdict H2
    expect(data).not.toHaveProperty('valide_at');
  });

  it('note_ressemblance est transmise telle quelle à la base', async () => {
    const { service, update } = buildService(row);
    await service.updateContenu('c1', 'u1', { statut: 'Valider', note_ressemblance: 4 });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.note_ressemblance).toBe(4);
  });

  it('texte identique au texte courant : pas d\'événement "modifie"', async () => {
    const { service, log } = buildService(row);
    await service.updateContenu('c1', 'u1', { contenu: 'abcd' });
    expect(log).not.toHaveBeenCalled();
  });

  it('changement de titre seul : aucun événement', async () => {
    const { service, log } = buildService(row);
    await service.updateContenu('c1', 'u1', { titre: 'Nouveau titre' });
    expect(log).not.toHaveBeenCalled();
  });
});
