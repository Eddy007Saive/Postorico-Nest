import { ConfigService } from '@nestjs/config';
import { AnalyticsService, creneauxLocaux, frequences, seriesAbonnes } from './analytics.service';

// Couvre l'orchestration du cron (refreshAll) sans dépendre d'une vraie base ni de Late :
// Prisma et le rafraîchissement par utilisateur sont simulés.
describe('AnalyticsService.refreshAll', () => {
  function makeService(opts: { lateApiKey?: string; findMany?: jest.Mock }) {
    const findMany = opts.findMany ?? jest.fn().mockResolvedValue([]);
    const prismaStub = { users: { findMany } } as never;
    const zernioStub = {} as never;
    const configStub = {
      get: jest.fn((key: string) => {
        if (key === 'app.lateApiKey') return opts.lateApiKey ?? 'fake-key';
        if (key === 'app.analyticsCronHeures') return 1;
        return undefined;
      }),
    } as unknown as ConfigService;
    const service = new AnalyticsService(prismaStub, zernioStub, configStub);
    return { service, findMany };
  }

  it("renvoie skipped='no_late_key' sans interroger la base quand Late n'est pas configuré", async () => {
    const findMany = jest.fn();
    const { service } = makeService({ lateApiKey: '', findMany });
    const res = await service.refreshAll();
    expect(res).toEqual({ ok: false, skipped: 'no_late_key' });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('ne rafraîchit que les users actifs avec un profil Late', async () => {
    const findMany = jest.fn().mockResolvedValue([{ telegram_id: 'u1' }, { telegram_id: 'u2' }]);
    const { service } = makeService({ findMany });
    jest.spyOn(service, 'refreshUser').mockResolvedValue({ ok: true, connected: true });

    const res = await service.refreshAll();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actif: true, late_profile_id: { not: null } } }),
    );
    expect(service.refreshUser).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ ok: true, refreshed: 2, errors: 0 });
  });

  it("continue les users suivants si l'un d'eux échoue", async () => {
    const findMany = jest.fn().mockResolvedValue([{ telegram_id: 'u1' }, { telegram_id: 'u2' }, { telegram_id: 'u3' }]);
    const { service } = makeService({ findMany });
    jest
      .spyOn(service, 'refreshUser')
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    const res = await service.refreshAll();

    expect(service.refreshUser).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ ok: true, refreshed: 2, errors: 1 });
  });

  it('renvoie ok:false si la requête Prisma échoue', async () => {
    const findMany = jest.fn().mockRejectedValue(new Error('db down'));
    const { service } = makeService({ findMany });
    const res = await service.refreshAll();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('db down');
  });
});
describe('helpers du tableau de performance', () => {
  it('convertit un créneau UTC dans le fuseau du client et trie par engagement', () => {
    const c = creneauxLocaux(
      [
        { day_of_week: 2, hour: 7, avg_engagement: 3, post_count: 1 },
        { day_of_week: 0, hour: 8, avg_engagement: 3.5714, post_count: 7 },
        { day_of_week: 6, hour: 23, avg_engagement: 1, post_count: 2 },
      ],
      'Europe/Paris',
    );
    // Référence en janvier (heure d'hiver, UTC+1) : lundi 8 h UTC -> lundi 9 h.
    expect(c[0]).toEqual({ jour: 0, heure: 9, engagement: 3.6, posts: 7 });
    expect(c[1]).toEqual({ jour: 2, heure: 8, engagement: 3, posts: 1 });
    // Dimanche 23 h UTC -> lundi 0 h à Paris : le jour change aussi.
    expect(c[2]).toEqual({ jour: 0, heure: 0, engagement: 1, posts: 2 });
  });

  it('ignore un fuseau invalide et retombe sur Paris', () => {
    expect(creneauxLocaux([{ day_of_week: 0, hour: 8, avg_engagement: 1, post_count: 1 }], 'Pas/Un_Fuseau')[0].heure).toBe(9);
  });

  it('associe la série d\'abonnés à son compte et filtre par réseau', () => {
    const rep = {
      accounts: [
        { _id: 'a1', platform: 'instagram', username: 'insta', currentFollowers: 62, growth: 6 },
        { _id: 'a2', platform: 'linkedin', displayName: 'Martin', currentFollowers: 1198, growth: 61 },
      ],
      stats: { a1: [{ date: '2026-09-07', followers: 56 }], a2: [{ date: '2026-09-07', followers: 1137 }] },
    };
    expect(seriesAbonnes(rep)).toHaveLength(2);
    expect(seriesAbonnes(rep, 'linkedin')).toEqual([
      { platform: 'linkedin', username: 'Martin', current: 1198, gained: 61, points: [{ date: '2026-09-07', followers: 1137 }] },
    ]);
  });

  it('arrondit la cadence et filtre par réseau', () => {
    const rep = { frequency: [{ platform: 'linkedin', posts_per_week: 1, avg_engagement_rate: 3.388, weeks_count: 4 }, { platform: 'instagram', posts_per_week: 2, avg_engagement_rate: 6.66, weeks_count: 1 }] };
    expect(frequences(rep, 'linkedin')).toEqual([{ platform: 'linkedin', postsParSemaine: 1, tauxEngagement: 3.4, semaines: 4 }]);
  });
});
