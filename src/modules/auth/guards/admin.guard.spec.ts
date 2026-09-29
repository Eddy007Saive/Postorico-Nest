import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import { AdminGuard } from './admin.guard';
import { AuthService } from '../auth.service';

// Port direct de backend/tests/test_dependencies.py::verify_admin_token.
const SECRET = 'secret-de-test-de-plus-de-32-caracteres-xxxxxxxx';

function contextWithToken(token: string): ExecutionContext {
  const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard() {
  const jwtService = new JwtService({ secret: SECRET });
  const authServiceStub = { sessionValid: jest.fn(async () => true) } as unknown as AuthService;
  return new AdminGuard(jwtService, authServiceStub);
}

describe('AdminGuard', () => {
  it('jeton utilisateur (is_admin=false) refusé sur route admin', async () => {
    const guard = makeGuard();
    const token = jwt.sign({ telegram_id: 'u1', is_admin: false }, SECRET, { expiresIn: '1h' });
    await expect(guard.canActivate(contextWithToken(token))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("jeton sans indicateur admin refusé sur route admin", async () => {
    const token = jwt.sign({ telegram_id: 'u1' }, SECRET, { expiresIn: '1h' });
    const guard = makeGuard();
    await expect(guard.canActivate(contextWithToken(token))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('jeton admin accepté sur route admin', async () => {
    const guard = makeGuard();
    const token = jwt.sign({ telegram_id: 'u1', is_admin: true }, SECRET, { expiresIn: '1h' });
    const ctx = contextWithToken(token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { is_admin: boolean } }>();
    expect(req.user.is_admin).toBe(true);
  });
});
