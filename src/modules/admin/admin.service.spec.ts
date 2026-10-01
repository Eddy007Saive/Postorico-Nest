import { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';

// Port de `verdict_h2` (backend/services/admin_service.py) : tableau de bord de l'hypothèse
// H2 du mémoire — note de ressemblance perçue (1-5, saisie à la validation) croisée avec le
// taux de réécriture objectif (figé à la validation), motifs de refus, et cache de 10 min.
type Row = {
  id: string;
  note_ressemblance: number | null;
  taux_reecriture: number | null;
  statut: string | null;
  motif_refus: string | null;
  valide_at: Date | null;
  reseau_cible: string | null;
};

const V = new Date('2026-09-30T10:00:00Z');
const ROWS: Row[] = [
  { id: 'r1', note_ressemblance: 5, taux_reecriture: 0.1, statut: 'Publie', motif_refus: null, valide_at: V, reseau_cible: 'LinkedIn' },
  { id: 'r2', note_ressemblance: 3, taux_reecriture: 0.5, statut: 'Valider', motif_refus: null, valide_at: V, reseau_cible: 'LinkedIn' },
  { id: 'r3', note_ressemblance: 4, taux_reecriture: null, statut: 'Publie', motif_refus: null, valide_at: V, reseau_cible: 'Instagram' },
  { id: 'r4', note_ressemblance: null, taux_reecriture: null, statut: 'Refuse', motif_refus: 'Trop long', valide_at: null, reseau_cible: 'LinkedIn' },
  { id: 'r5', note_ressemblance: null, taux_reecriture: null, statut: 'Refuse', motif_refus: null, valide_at: null, reseau_cible: null },
  { id: 'r6', note_ressemblance: null, taux_reecriture: null, statut: 'A_valider', motif_refus: null, valide_at: null, reseau_cible: 'LinkedIn' },
];

function makeService(rows: Row[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prismaStub = { contenu: { findMany } } as never;
  const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
  const service = new AdminService(prismaStub, {} as never, {} as never, {} as never, configStub);
  return { service, findMany };
}

describe('AdminService.verdictH2', () => {
  it('compte validés / notés / avec taux / refusés / motifs', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.n_valides).toBe(3);
    expect(v.n_note).toBe(3);
    expect(v.n_taux).toBe(2);
    expect(v.n_refuses).toBe(2);
    expect(v.n_motifs).toBe(1);
  });

  it('moyennes arrondies (note à 2 décimales, taux à 3)', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.moyenne_note).toBe(4); // (5+3+4)/3
    expect(v.moyenne_taux_reecriture).toBe(0.3); // (0.1+0.5)/2
  });

  it('distribution des notes 1..5, zéros inclus', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.distribution_note).toEqual({ '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 });
  });

  it('croisement note x taux : seulement les contenus ayant LES DEUX mesures, trié par note', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.croisement_note_taux).toEqual([
      { note: 3, n: 1, taux_reecriture_moyen: 0.5 },
      { note: 5, n: 1, taux_reecriture_moyen: 0.1 },
    ]);
  });

  it('moyenne de note par réseau, trié par réseau', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.moyenne_note_par_reseau).toEqual([
      { reseau: 'Instagram', n: 1, moyenne_note: 4 },
      { reseau: 'LinkedIn', n: 2, moyenne_note: 4 },
    ]);
  });

  it('derniers motifs de refus (non vides) et horodatage', async () => {
    const { service } = makeService(ROWS);
    const v = await service.verdictH2();
    expect(v.derniers_motifs_refus).toEqual(['Trop long']);
    expect(typeof v.genere_a).toBe('string');
    expect(Number.isNaN(Date.parse(v.genere_a as string))).toBe(false);
  });

  it('table vide : moyennes null, compteurs à 0', async () => {
    const { service } = makeService([]);
    const v = await service.verdictH2();
    expect(v.n_valides).toBe(0);
    expect(v.moyenne_note).toBeNull();
    expect(v.moyenne_taux_reecriture).toBeNull();
    expect(v.croisement_note_taux).toEqual([]);
    expect(v.derniers_motifs_refus).toEqual([]);
  });

  it('cache 10 min : un second appel ne relit pas la base', async () => {
    const { service, findMany } = makeService(ROWS);
    await service.verdictH2();
    await service.verdictH2();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
