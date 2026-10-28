import { PlanningService } from './planning.service';

/** Horizon de la recherche de créneau (voir planning.service.ts HORIZON_DAYS) : un lundi et un
 * mercredi existent toujours dans les 7 prochains jours, donc on borne la boucle à 7 itérations
 * pour un test rapide et déterministe. */
function make(row: Record<string, unknown> | null) {
  const prisma = {
    publication_schedules: { findFirst: jest.fn().mockResolvedValue(row) },
    contenu: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { service: new PlanningService(prisma as never), prisma };
}

describe('PlanningService.prochainCreneau — heure par jour (preferred_times)', () => {
  it('sans preferred_times : comportement inchangé, heure unique pour tous les jours cochés', async () => {
    const { service } = make({
      days_of_week: [1, 3], // lundi, mercredi
      preferred_time: new Date(Date.UTC(1970, 0, 1, 9, 0)),
      preferred_times: null,
      is_active: true,
      mode_planification: 'cumule',
    });
    const iso = await service.prochainCreneau('u1', 'LinkedIn', 'Post');
    expect(iso).not.toBeNull();
    const d = new Date(iso!);
    // Heure autour de 9h (jitter -12/+14 min, cf. heureHumanisee) quel que soit le jour trouvé.
    const minutesDepuisMinuit = d.getUTCHours() * 60 + d.getUTCMinutes();
    expect(minutesDepuisMinuit).toBeGreaterThanOrEqual(9 * 60 - 12);
    expect(minutesDepuisMinuit).toBeLessThanOrEqual(9 * 60 + 14);
  });

  it('avec un override sur le mercredi : le jour overridé respecte l’heure personnalisée, les autres jours gardent l’heure par défaut', async () => {
    const { service } = make({
      days_of_week: [1, 3], // lundi, mercredi
      preferred_time: new Date(Date.UTC(1970, 0, 1, 9, 0)),
      preferred_times: { '3': '18:00' }, // mercredi -> 18h
      is_active: true,
      mode_planification: 'cumule',
    });
    const iso = await service.prochainCreneau('u1', 'LinkedIn', 'Post');
    expect(iso).not.toBeNull();
    const d = new Date(iso!);
    const jour = d.getUTCDay();
    const minutesDepuisMinuit = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (jour === 3) {
      expect(minutesDepuisMinuit).toBeGreaterThanOrEqual(18 * 60 - 12);
      expect(minutesDepuisMinuit).toBeLessThanOrEqual(18 * 60 + 14);
    } else {
      expect(jour).toBe(1);
      expect(minutesDepuisMinuit).toBeGreaterThanOrEqual(9 * 60 - 12);
      expect(minutesDepuisMinuit).toBeLessThanOrEqual(9 * 60 + 14);
    }
  });

  it('un override invalide (jour hors days_of_week, ou mal formé) est ignoré : repli sur l’heure par défaut', async () => {
    const { service } = make({
      days_of_week: [1],
      preferred_time: new Date(Date.UTC(1970, 0, 1, 9, 0)),
      preferred_times: { '3': '18:00', '1': 'pas-une-heure' }, // 3 pas coché, 1 mal formé
      is_active: true,
      mode_planification: 'cumule',
    });
    const iso = await service.prochainCreneau('u1', 'LinkedIn', 'Post');
    const d = new Date(iso!);
    expect(d.getUTCDay()).toBe(1);
    const minutesDepuisMinuit = d.getUTCHours() * 60 + d.getUTCMinutes();
    expect(minutesDepuisMinuit).toBeGreaterThanOrEqual(9 * 60 - 12);
    expect(minutesDepuisMinuit).toBeLessThanOrEqual(9 * 60 + 14);
  });

  it('aucune ligne de planification : repli DEFAULT_TIME (9h), inchangé', async () => {
    const { service } = make(null);
    const iso = await service.prochainCreneau('u1', 'LinkedIn', 'Post');
    expect(iso).not.toBeNull();
  });
});
