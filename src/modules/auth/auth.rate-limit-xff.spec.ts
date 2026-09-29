import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

const adminUser = {
  telegram_id: 'admin-1',
  email: 'admin@example.com',
  nom: 'Admin',
  is_admin: true,
  password_hash: 'hash',
  actif: true,
};

function buildController() {
  const authService = {
    verifyCredentials: jest.fn().mockResolvedValue(null),
  } as unknown as AuthService;

  const mfaService = {
    verifier: jest.fn().mockRejectedValue(new Error('code_faux')),
  } as unknown as MfaService;

  const mailService = {} as never;
  const rateLimit = new RateLimitService();
  const config = { get: jest.fn() } as never;
  const socialService = {} as never;
  const affiliationService = {} as never;

  const controller = new AuthController(authService, mfaService, mailService, rateLimit, config, socialService, affiliationService);
  return { controller };
}

function reqFrom(remoteAddress: string, forwardedFor: string): Request {
  return {
    headers: { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress },
  } as unknown as Request;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    throw error;
  }
}

async function statusesFor(
  attempts: number,
  runner: (request: Request) => Promise<unknown>,
  forwardedFor: (index: number) => string,
): Promise<number[]> {
  const remoteAddress = '127.0.0.1';
  const statuses: number[] = [];
  for (let index = 0; index < attempts; index += 1) {
    statuses.push(await statusOf(runner(reqFrom(remoteAddress, forwardedFor(index)))));
  }
  return statuses;
}

describe('AuthController rate limits trust user-supplied X-Forwarded-For', () => {
  it('locks repeated login failures for one X-Forwarded-For value but not for rotated spoofed values from the same socket origin', async () => {
    const fixed = buildController();
    const fixedStatuses = await statusesFor(
      6,
      (request) => fixed.controller.login({ email: 'victim@example.com', password: 'bad', appareil: 'browser' } as never, request),
      () => '1.1.1.1',
    );
    expect(fixedStatuses).toEqual([401, 401, 401, 401, 401, 429]);

    const rotated = buildController();
    const rotatedStatuses = await statusesFor(
      25,
      (request) =>
        rotated.controller.login({ email: 'victim@example.com', password: 'bad', appareil: 'browser' } as never, request),
      (index) => `10.0.0.${index}`,
    );
    expect(rotatedStatuses).toEqual(Array(25).fill(401));
  });

  it('locks repeated admin-login failures for one X-Forwarded-For value but not for rotated spoofed values from the same socket origin', async () => {
    const fixed = buildController();
    const fixedStatuses = await statusesFor(
      6,
      (request) => fixed.controller.adminLogin({ email: 'admin@example.com', password: 'bad' } as never, request),
      () => '1.1.1.1',
    );
    expect(fixedStatuses).toEqual([401, 401, 401, 401, 401, 429]);

    const rotated = buildController();
    const rotatedStatuses = await statusesFor(
      25,
      (request) => rotated.controller.adminLogin({ email: 'admin@example.com', password: 'bad' } as never, request),
      (index) => `10.0.1.${index}`,
    );
    expect(rotatedStatuses).toEqual(Array(25).fill(401));
  });

  it('locks repeated MFA code failures for one X-Forwarded-For value but not for rotated spoofed values from the same socket origin', async () => {
    const fixed = buildController();
    const fixedStatuses = await statusesFor(
      21,
      (request) =>
        fixed.controller.codeVerifier(
          { jeton: 'waiting-token', code: '000000', confiance: false } as never,
          request,
        ),
      () => '1.1.1.1',
    );
    expect(fixedStatuses).toEqual([...Array(20).fill(401), 429]);

    const rotated = buildController();
    const rotatedStatuses = await statusesFor(
      25,
      (request) =>
        rotated.controller.codeVerifier(
          { jeton: 'waiting-token', code: '000000', confiance: false } as never,
          request,
        ),
      (index) => `10.0.2.${index}`,
    );
    expect(rotatedStatuses).toEqual(Array(25).fill(401));
  });
});