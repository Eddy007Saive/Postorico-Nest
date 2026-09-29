import type { Request } from 'express';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

// VULN-0002 (scan Strix du 2026-09-28) : POST /auth/google rendait une session admin
// complète sans jamais passer par le code MFA par email, contrairement à
// /auth/admin-login qui l'exige systématiquement (mfaService.exigeCode). Ces tests
// verrouillent le correctif : un compte is_admin authentifié via Google doit recevoir
// un jeton d'ATTENTE (code_requis), jamais un jeton de session direct.
describe('AuthController.google — MFA admin', () => {
  const adminUser = {
    telegram_id: 'admin-1',
    email: 'admin@example.com',
    nom: 'Admin',
    is_admin: true,
    password_hash: null,
    actif: true,
  };
  const normalUser = {
    telegram_id: 'user-1',
    email: 'user@example.com',
    nom: 'User',
    is_admin: false,
    password_hash: null,
    actif: true,
  };

  function buildController(loginGoogleResult: { user: typeof adminUser | typeof normalUser; nouveau: boolean }) {
    const authService = {
      loginGoogle: jest.fn().mockResolvedValue(loginGoogleResult),
      sessionFromUser: jest.fn().mockResolvedValue({
        token: 'session-jwt',
        user: {},
        is_admin: loginGoogleResult.user.is_admin,
        pending: false,
      }),
    } as unknown as AuthService;

    const mfaService = {
      creerCode: jest.fn().mockResolvedValue('123456'),
      jetonAttente: jest.fn().mockReturnValue('waiting-jwt'),
      masquerEmail: jest.fn().mockReturnValue('a***@example.com'),
    } as unknown as MfaService;

    const mailService = {
      codeConnexionHtml: jest.fn().mockReturnValue({ subject: 's', html: '<p/>' }),
      sendEmail: jest.fn().mockResolvedValue({ error: null }),
    } as never;

    const rateLimit = {
      lockedFor: jest.fn().mockReturnValue(0),
      fail: jest.fn(),
      clear: jest.fn(),
    } as unknown as RateLimitService;

    const config = { get: jest.fn() } as never;
    const socialService = { createLateProfile: jest.fn().mockResolvedValue(undefined) } as never;
    const affiliationService = { attribuer: jest.fn().mockResolvedValue(undefined) } as never;

    const controller = new AuthController(authService, mfaService, mailService, rateLimit, config, socialService, affiliationService);
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    return { controller, authService, mfaService, req };
  }

  it('exige le code MFA pour un compte admin authentifié via Google (ne renvoie pas de session)', async () => {
    const { controller, authService, mfaService, req } = buildController({ user: adminUser, nouveau: false });

    const res = await controller.google({ access_token: 'tok' } as never, req);

    expect(res).toMatchObject({ code_requis: true, jeton: 'waiting-jwt' });
    expect(res).not.toHaveProperty('token');
    expect(mfaService.creerCode).toHaveBeenCalledWith('admin-1');
    expect(authService.sessionFromUser).not.toHaveBeenCalled();
  });

  it('rend une session directe pour un compte non-admin (comportement inchangé)', async () => {
    const { controller, authService, mfaService, req } = buildController({ user: normalUser, nouveau: false });

    const res = await controller.google({ access_token: 'tok' } as never, req);

    expect(res).toMatchObject({ token: 'session-jwt', is_admin: false });
    expect(authService.sessionFromUser).toHaveBeenCalledWith(normalUser);
    expect(mfaService.creerCode).not.toHaveBeenCalled();
  });
});
