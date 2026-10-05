import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';

// Ne couvre que la logique indépendante de la base (hash, empreinte, sanitize) —
// équivalent des tests purs de backend/tests/test_auth.py côté Python. Les parcours
// avec Prisma (register/login réels) attendent une base de test dédiée.
describe('AuthService (logique pure)', () => {
  let service: AuthService;
  let signSpy: jest.Mock;

  function pwdFingerprint(hash: string | null): string {
    // Même formule que AuthService.pwdFingerprint (privée) : sha256(hash || '').slice(0,16).
    return crypto.createHash('sha256').update(hash || '').digest('hex').slice(0, 16);
  }

  beforeEach(() => {
    const prismaStub = {} as never;
    signSpy = jest.fn().mockReturnValue('signed-jwt');
    const jwtStub = { sign: signSpy } as unknown as JwtService;
    const configStub = { get: jest.fn().mockReturnValue(8) } as unknown as ConfigService;
    service = new AuthService(prismaStub, jwtStub, configStub);
  });

  it('hash puis vérifie le même mot de passe', async () => {
    const hash = await service.hashPassword('correcthorsebatterystaple');
    await expect(service.verifyPassword('correcthorsebatterystaple', hash)).resolves.toBe(true);
  });

  it('rejette un mauvais mot de passe', async () => {
    const hash = await service.hashPassword('correcthorsebatterystaple');
    await expect(service.verifyPassword('mauvais-mdp', hash)).resolves.toBe(false);
  });

  it('rejette sans planter un compte sans mot de passe (créé par Google)', async () => {
    await expect(service.verifyPassword('quelconque', null)).resolves.toBe(false);
    await expect(service.verifyPassword('', 'un-hash')).resolves.toBe(false);
  });

  it('retire password_hash de sanitizeUser', () => {
    const user = { telegram_id: '1', email: 'a@b.c', password_hash: 'secret' };
    const clean = service.sanitizeUser(user);
    expect(clean).not.toHaveProperty('password_hash');
    expect(clean.email).toBe('a@b.c');
  });

  // VULN Strix du 2026-09-28 : ces trois jetons ne portaient pas `fp` (empreinte du mot de
  // passe) — JwtAuthGuard tolère un `fp` absent comme un "vieux jeton", donc ils
  // survivaient à un changement de mot de passe jusqu'à leur propre expiration (7 jours
  // pour l'inscription et la bascule de compte, 1h pour le Mode Vision). Ces tests
  // verrouillent la présence d'une empreinte correcte sur les trois chemins.
  describe('fp porté sur tous les jetons émis (fix session invalidation)', () => {
    it('issueRegistrationToken porte l\'empreinte du mot de passe qui vient d\'être posé', () => {
      service.issueRegistrationToken('u1', 'a@b.c', 'hash-du-mdp');
      const claims = signSpy.mock.calls[0][0];
      expect(claims.fp).toBe(pwdFingerprint('hash-du-mdp'));
      expect(claims.fp).not.toBe('');
    });

    it('issueSwitchToken porte l\'empreinte du mot de passe de la CIBLE, pas de l\'appelant', () => {
      service.issueSwitchToken('cible-1', 'cible@b.c', false, 'origine-1', null, 'hash-de-la-cible');
      const claims = signSpy.mock.calls[0][0];
      expect(claims.telegram_id).toBe('cible-1');
      expect(claims.fp).toBe(pwdFingerprint('hash-de-la-cible'));
    });

    it('issueVisionToken porte l\'empreinte du mot de passe du client visé', () => {
      service.issueVisionToken('client-1', 'admin-1', 'hash-du-client');
      const claims = signSpy.mock.calls[0][0];
      expect(claims.telegram_id).toBe('client-1');
      expect(claims.fp).toBe(pwdFingerprint('hash-du-client'));
    });
  });

  describe('révocation à la déconnexion (sessions_invalidees_le)', () => {
    // Déconnexion posée à t = 1000 s.
    function serviceAvec(invalideesLe: Date | null, passwordHash = 'h'): AuthService {
      const prisma = {
        users: { findUnique: jest.fn().mockResolvedValue({ password_hash: passwordHash, sessions_invalidees_le: invalideesLe }) },
      } as never;
      return new AuthService(prisma, { sign: jest.fn() } as unknown as JwtService, { get: jest.fn() } as unknown as ConfigService);
    }
    const fp = pwdFingerprint('h');

    it.each([
      [999, false],
      [1000, true],
      [1001, true],
      [undefined, false],
    ])('jeton émis à iat=%s -> %s', async (iat, attendu) => {
      await expect(serviceAvec(new Date(1_000_000)).sessionValid('u1', fp, iat)).resolves.toBe(attendu);
    });

    it('sans déconnexion, un jeton sans iat reste valable', async () => {
      await expect(serviceAvec(null).sessionValid('u1', fp, undefined)).resolves.toBe(true);
    });

    it('le mot de passe changé invalide toujours le jeton', async () => {
      await expect(serviceAvec(null, 'autre-hash').sessionValid('u1', fp, 2000)).resolves.toBe(false);
    });
  });
});
