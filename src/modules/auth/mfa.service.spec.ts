import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';

// Ne couvre que masquerEmail, seule logique pure de ce service — équivalent des cas
// paramétrés de backend/tests/test_mfa.py::test_masquer_email.
describe('MfaService (logique pure)', () => {
  let service: MfaService;

  beforeEach(() => {
    const prismaStub = {} as never;
    const jwtStub = {} as JwtService;
    const configStub = { get: jest.fn() } as unknown as ConfigService;
    const authStub = {} as AuthService;
    service = new MfaService(prismaStub, jwtStub, configStub, authStub);
  });

  it.each([
    ['martin@gmail.com', 'm***n@gmail.com'],
    ['jo@test.fr', 'j***@test.fr'], // nom <= 2 caractères
    ['a@b.io', 'a***@b.io'],
  ])('masque %s en %s', (email, attendu) => {
    expect(service.masquerEmail(email)).toBe(attendu);
  });

  it('renvoie *** sur une entrée sans arobase', () => {
    expect(service.masquerEmail('pas-un-email')).toBe('***');
  });
});
