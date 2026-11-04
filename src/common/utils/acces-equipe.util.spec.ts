import { routeInterdite } from './acces-equipe.util';

describe('routeInterdite', () => {
  it('réserve l’argent, l’équipe et le compte au propriétaire', () => {
    for (const role of ['editeur', 'admin'] as const) {
      expect(routeInterdite(role, 'POST', '/api/billing/checkout')).toBe(true);
      expect(routeInterdite(role, 'GET', '/api/billing/invoices')).toBe(true);
      expect(routeInterdite(role, 'POST', '/api/equipe')).toBe(true);
      expect(routeInterdite(role, 'DELETE', '/api/equipe/abc')).toBe(true);
      expect(routeInterdite(role, 'DELETE', '/api/users/me')).toBe(true);
      expect(routeInterdite(role, 'POST', '/api/users/me/password')).toBe(true);
      expect(routeInterdite(role, 'POST', '/api/accounts')).toBe(true);
      expect(routeInterdite(role, 'POST', '/api/publicite/booster')).toBe(true);
    }
  });

  it('laisse rejoindre une équipe et basculer de compte', () => {
    expect(routeInterdite('editeur', 'POST', '/api/equipe/rejoindre')).toBe(false);
    expect(routeInterdite('editeur', 'GET', '/api/equipe/invitation/xyz')).toBe(false);
    expect(routeInterdite('editeur', 'POST', '/api/accounts/switch')).toBe(false);
  });

  it('garde les réseaux et les réglages de marque à l’administrateur', () => {
    expect(routeInterdite('editeur', 'POST', '/api/users/me/connect')).toBe(true);
    expect(routeInterdite('admin', 'POST', '/api/users/me/connect')).toBe(false);
    expect(routeInterdite('editeur', 'PATCH', '/api/users/me')).toBe(true);
    expect(routeInterdite('admin', 'PATCH', '/api/users/me')).toBe(false);
    expect(routeInterdite('editeur', 'POST', '/api/agent/templates')).toBe(true);
  });

  it('laisse l’éditeur travailler sur les contenus', () => {
    expect(routeInterdite('editeur', 'GET', '/api/users/me')).toBe(false);
    expect(routeInterdite('editeur', 'POST', '/api/agent/enregistrer')).toBe(false);
    expect(routeInterdite('editeur', 'GET', '/api/agent/templates')).toBe(false);
    expect(routeInterdite('editeur', 'POST', '/api/late/publier/123')).toBe(false);
  });
});
