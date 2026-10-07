import { lookup as dnsLookup } from 'dns/promises';
import { normaliserUrl, SiteIllisible, SiteService } from './site.service';

jest.mock('dns/promises');

// Port direct de backend/tests/test_fonctions_pures.py (section anti-SSRF) : l'adresse
// vient du client et la requête part de NOTRE serveur, donc toute résolution qui pointe
// vers le réseau interne ou les métadonnées cloud doit être refusée. `dns.lookup` est
// simulé pour chaque cas plutôt que de dépendre d'une vraie résolution DNS en CI.
describe('normaliserUrl (anti-SSRF)', () => {
  const mockLookup = dnsLookup as jest.MockedFunction<typeof dnsLookup>;

  beforeEach(() => {
    mockLookup.mockReset();
  });

  function dns(...adresses: string[]) {
    mockLookup.mockResolvedValue(adresses.map((address) => ({ address, family: 4 })) as never);
  }

  it('refuse une adresse vide', async () => {
    await expect(normaliserUrl('   ')).rejects.toThrow(SiteIllisible);
  });

  it('complète le schéma manquant', async () => {
    dns('93.184.216.34');
    await expect(normaliserUrl('example.com')).resolves.toBe('https://example.com');
  });

  it('conserve une adresse publique déjà complète', async () => {
    dns('93.184.216.34');
    await expect(normaliserUrl('http://example.com/page')).resolves.toBe('http://example.com/page');
  });

  it.each([
    ['http://127.0.0.1', '127.0.0.1'],
    ['http://localhost', '127.0.0.1'],
    ['http://10.0.0.5/admin', '10.0.0.5'],
    ['http://192.168.1.1', '192.168.1.1'],
    ['http://169.254.169.254/latest/meta-data', '169.254.169.254'],
  ])('refuse les adresses internes (%s)', async (url, resolved) => {
    dns(resolved);
    await expect(normaliserUrl(url)).rejects.toThrow(SiteIllisible);
  });

  it('refuse un nom de domaine qui pointe vers une adresse privée', async () => {
    dns('10.0.0.7');
    await expect(normaliserUrl('https://interne.exemple.com')).rejects.toThrow(SiteIllisible);
  });

  it('un seul résultat DNS privé suffit à refuser', async () => {
    dns('93.184.216.34', '127.0.0.1');
    await expect(normaliserUrl('https://piege.exemple.com')).rejects.toThrow(SiteIllisible);
  });

  it("refuse un domaine inexistant", async () => {
    mockLookup.mockRejectedValue(Object.assign(new Error('inconnu'), { code: 'ENOTFOUND' }));
    await expect(normaliserUrl('https://nexiste-pas.exemple')).rejects.toThrow(
      /n'existe pas/,
    );
  });
});

describe('SiteService.telechargerLogo (logo reçu en data:)', () => {
  const service = new SiteService({} as never, {} as never);
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  it('accepte une image PNG encodée', async () => {
    const { donnees, type } = await service.telechargerLogo(`data:image/png;base64,${PNG_1PX}`);
    expect(type).toBe('image/png');
    expect(donnees.length).toBeGreaterThan(0);
  });

  it("refuse ce qui n'est pas une image", async () => {
    await expect(service.telechargerLogo('data:text/html;base64,PGgxPg==')).rejects.toThrow(SiteIllisible);
  });

  it('refuse un contenu non base64', async () => {
    await expect(service.telechargerLogo('data:image/png;base64,<script>')).rejects.toThrow(SiteIllisible);
  });

  it('refuse une adresse vide', async () => {
    await expect(service.telechargerLogo('')).rejects.toThrow(SiteIllisible);
  });
});
