import { ConfigService } from '@nestjs/config';
import { AnalyticsService } from './analytics.service';

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