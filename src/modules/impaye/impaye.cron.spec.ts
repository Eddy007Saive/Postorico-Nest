import { ConfigService } from '@nestjs/config';
import { ImpayeService } from './impaye.service';

// Port de `_impaye_cron` (backend/server.py) : une passe par jour, à partir de 6 h Europe/Paris,
// jamais deux fois le même jour, jamais avant 6 h. La boucle manquait dans le premier portage.
describe('ImpayeService.pollQuotidien — fenêtre horaire', () => {
  function build(actif = true) {
    const configStub = {
      get: jest.fn((k: string) => (k === 'app.impayesCronActive' ? actif : '')),
    } as unknown as ConfigService;
    const service = new ImpayeService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, configStub);
    const traiter = jest.spyOn(service, 'traiterQuotidien').mockResolvedValue({ comptes: 0, mail2: 0, suspendus: 0, mail4: 0, resilies: 0, echecs: 0 });
    const setNow = (iso: string) => jest.spyOn(service as never as { now: () => Date }, 'now').mockReturnValue(new Date(iso));
    return { service, traiter, setNow };
  }

  it("ne fait rien avant 6 h (Paris)", async () => {
    const { service, traiter, setNow } = build();
    setNow('2026-10-01T03:30:00+02:00'); // 03:30 Paris
    await service.pollQuotidien();
    expect(traiter).not.toHaveBeenCalled();
  });

  it('lance la passe à partir de 6 h, une seule fois dans la journée', async () => {
    const { service, traiter, setNow } = build();
    setNow('2026-10-01T06:10:00+02:00');
    await service.pollQuotidien();
    setNow('2026-10-01T06:40:00+02:00');
    await service.pollQuotidien();
    setNow('2026-10-01T18:00:00+02:00');
    await service.pollQuotidien();
    expect(traiter).toHaveBeenCalledTimes(1);
  });

  it('relance le lendemain', async () => {
    const { service, traiter, setNow } = build();
    setNow('2026-10-01T07:00:00+02:00');
    await service.pollQuotidien();
    setNow('2026-10-02T07:00:00+02:00');
    await service.pollQuotidien();
    expect(traiter).toHaveBeenCalledTimes(2);
  });

  it("le jour est celui de Paris, pas d'UTC (23 h UTC = 1 h Paris le lendemain)", async () => {
    const { service, traiter, setNow } = build();
    setNow('2026-10-01T07:00:00+02:00');
    await service.pollQuotidien();
    setNow('2026-10-01T23:30:00Z'); // 01:30 Paris le 2 : nouveau jour mais avant 6 h
    await service.pollQuotidien();
    expect(traiter).toHaveBeenCalledTimes(1);
  });

  it('IMPAYES_CRON_ACTIVE=0 coupe la boucle', async () => {
    const { service, traiter, setNow } = build(false);
    setNow('2026-10-01T09:00:00+02:00');
    await service.pollQuotidien();
    expect(traiter).not.toHaveBeenCalled();
  });
});
