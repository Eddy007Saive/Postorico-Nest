import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from '../auth.service';

// Port direct de backend/tests/test_dependencies.py::verify_token. Un vrai JwtService
// (secret réel, `jsonwebtoken` réel) est utilisé plutôt qu'un mock, pour vérifier le
// comportement de sécurité effectif — pas seulement le câblage du guard.
const SECRET = 'secret-de-test-de-plus-de-32-caracteres-xxxxxxxx';

function contextWithToken(token: string | undefined): ExecutionContext {
  const request: Record<string, unknown> = token ? { headers: { authorization: `Bearer ${token}` } } : { headers: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function jeton(claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}, secret: string = SECRET): string {
  const data = { telegram_id: 'u1', is_admin: false, ...claims };
  return jwt.sign(data, secret, { expiresIn: '1h', ...opts });
}

function makeGuard(sessionValidImpl?: (tg: string, fp: string) => Promise<boolean>) {
  const jwtService = new JwtService({ secret: SECRET });
  const authServiceStub = {
    sessionValid: jest.fn(sessionValidImpl ?? (async () => true)),
  } as unknown as AuthService;
  return new JwtAuthGuard(jwtService, authServiceStub);
}

describe('JwtAuthGuard', () => {
  it('jeton valide accepté', async () => {
    const guard = makeGuard();
    const ctx = contextWithToken(jeton());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { telegram_id: string } }>();
    expect(req.user.telegram_id).toBe('u1');
  });

  it('jeton expiré refusé', async () => {
    const guard = makeGuard();
    const ctx = contextWithToken(jeton({}, { expiresIn: '-5s' }));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('jeton mal signé refusé', async () => {
    const guard = makeGuard();
    const ctx = contextWithToken(jeton({}, {}, 'autre-secret-de-plus-de-32-caracteres-xxxx'));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('texte quelconque refusé', async () => {
    const guard = makeGuard();
    const ctx = contextWithToken('pas-un-jeton');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('algorithme none refusé', async () => {
    const guard = makeGuard();
    const sansSignature = jwt.sign({ telegram_id: 'u1', is_admin: true }, null as unknown as string, { algorithm: 'none' });
    const ctx = contextWithToken(sansSignature);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("extension d'en-tête « crit » inconnue refusée (RFC 7515 — jsonwebtoken ne le fait pas nativement, contrairement à PyJWT patché pour CVE-2026-32597)", async () => {
    const guard = makeGuard();
    const piege = jwt.sign({ telegram_id: 'u1', is_admin: true }, SECRET, {
      header: { alg: 'HS256', crit: ['extension-inconnue'], 'extension-inconnue': 1 } as never,
    });
    const ctx = contextWithToken(piege);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('session invalidée par un changement de mot de passe', async () => {
    const guard = makeGuard(async () => false);
    const ctx = contextWithToken(jeton({ fp: 'ancienne-empreinte' }));
    await expect(guard.canActivate(ctx)).rejects.toThrow(/Session/);
  });

  it('session valide acceptée', async () => {
    const guard = makeGuard(async () => true);
    const ctx = contextWithToken(jeton({ fp: 'empreinte' }));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { fp: string } }>();
    expect(req.user.fp).toBe('empreinte');
  });
});
