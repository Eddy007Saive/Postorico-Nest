import type { Request } from 'express';
import { clientIp } from './client-ip.util';

// VULN Strix du 2026-09-28 : les anciennes implémentations (auth/affiliation/onboarding,
// chacune dupliquée) prenaient le PREMIER maillon de X-Forwarded-For, que le client peut
// écrire librement — ce qui viderait le throttling anti-bruteforce de son effet (une
// nouvelle "ip" à chaque requête). Ces tests verrouillent le choix du DERNIER maillon.
describe('clientIp (anti-spoofing X-Forwarded-For)', () => {
  function req(headers: Record<string, string | string[] | undefined>, remoteAddress = '10.0.0.1'): Request {
    return { headers, socket: { remoteAddress }, ip: remoteAddress } as unknown as Request;
  }

  it('prend le DERNIER maillon, pas le premier écrit par le client', () => {
    // Le client prétend venir de 1.2.3.4 ; seul notre proxy de confiance a pu ajouter
    // 203.0.113.9 en bout de chaîne.
    const r = req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(clientIp(r)).toBe('203.0.113.9');
  });

  it('un seul maillon (accès direct via le proxy) fonctionne normalement', () => {
    const r = req({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIp(r)).toBe('203.0.113.9');
  });

  it('plusieurs instances de l\'en-tête sont fusionnées, dernier maillon retenu', () => {
    const r = req({ 'x-forwarded-for': ['1.2.3.4', '203.0.113.9'] });
    expect(clientIp(r)).toBe('203.0.113.9');
  });

  it("retombe sur l'adresse socket si l'en-tête est absent", () => {
    const r = req({});
    expect(clientIp(r)).toBe('10.0.0.1');
  });
});
