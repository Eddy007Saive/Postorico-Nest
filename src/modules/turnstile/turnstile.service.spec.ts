import { ConfigService } from '@nestjs/config';
import { TurnstileService } from './turnstile.service';

// Port direct des vérifications de backend/services/turnstile_service.py.
describe('TurnstileService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeService(secret: string | undefined): TurnstileService {
    const config = { get: jest.fn().mockReturnValue(secret) } as unknown as ConfigService;
    return new TurnstileService(config);
  }

  it('laisse passer sans secret configuré (dev)', async () => {
    const service = makeService(undefined);
    await expect(service.verify('')).resolves.toBe(true);
    await expect(service.verify('un-token')).resolves.toBe(true);
  });

  it('mode test (clé absente ou clé de test Cloudflare) : avertit au démarrage', () => {
    for (const cle of [undefined, '', TurnstileService.CLE_TEST]) {
      const service = makeService(cle);
      const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
      expect(service.enModeTest).toBe(true);
      service.onModuleInit();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MODE TEST'));
    }
    const vraie = makeService('0x4AAAAAAA-vraie-cle');
    const warn = jest.spyOn((vraie as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
    vraie.onModuleInit();
    expect(vraie.enModeTest).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejette un token vide quand un secret est configuré', async () => {
    const service = makeService('secret-key');
    await expect(service.verify('')).resolves.toBe(false);
  });

  it('accepte un token valide (success:true côté Cloudflare)', async () => {
    const service = makeService('secret-key');
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true }) }) as never;
    await expect(service.verify('bon-token', '1.2.3.4')).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejette un token invalide (success:false côté Cloudflare)', async () => {
    const service = makeService('secret-key');
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: false }) }) as never;
    await expect(service.verify('mauvais-token')).resolves.toBe(false);
  });

  it('ne lève jamais si Cloudflare est injoignable', async () => {
    const service = makeService('secret-key');
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
    await expect(service.verify('un-token')).resolves.toBe(false);
  });
});