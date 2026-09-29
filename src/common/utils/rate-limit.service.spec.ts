import { RateLimitService } from './rate-limit.service';

// Port direct de backend/tests/test_rate_limit.py. Le service lit l'horloge via
// `Date.now()` (pas de module `time` séparé comme côté Python) : on simule directement
// `Date.now` plutôt que de monkeypatcher un module.
function horloge(debut = 1000_000) {
  const t = { ms: debut * 1000 };
  jest.spyOn(Date, 'now').mockImplementation(() => t.ms);
  return t;
}

describe('RateLimitService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clé inconnue non verrouillée', () => {
    const service = new RateLimitService();
    expect(service.lockedFor('ip:1.2.3.4')).toBe(0);
  });

  it('quatre échecs ne verrouillent pas', () => {
    horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 4; i++) service.fail('k', 5, 900, 900);
    expect(service.lockedFor('k')).toBe(0);
  });

  it('le cinquième échec verrouille', () => {
    horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 5; i++) service.fail('k', 5, 900, 900);
    const locked = service.lockedFor('k');
    expect(locked).toBeGreaterThan(0);
    expect(locked).toBeLessThanOrEqual(900);
  });

  it('le verrou expire', () => {
    const t = horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 5; i++) service.fail('k', 5, 900, 600);
    t.ms += 601_000;
    expect(service.lockedFor('k')).toBe(0);
  });

  it('une connexion réussie débloque', () => {
    horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 5; i++) service.fail('k', 5, 900, 900);
    service.clear('k');
    expect(service.lockedFor('k')).toBe(0);
  });

  it("les échecs hors fenêtre ne s'additionnent pas", () => {
    const t = horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 4; i++) service.fail('k', 5, 900, 900);
    t.ms += 901_000;
    service.fail('k', 5, 900, 900);
    expect(service.lockedFor('k')).toBe(0);
  });

  it('les clés sont indépendantes', () => {
    horloge();
    const service = new RateLimitService();
    for (let i = 0; i < 5; i++) service.fail('ip+email:a', 5, 900, 900);
    expect(service.lockedFor('ip+email:a')).toBeGreaterThan(0);
    expect(service.lockedFor('ip+email:b')).toBe(0);
  });
});
