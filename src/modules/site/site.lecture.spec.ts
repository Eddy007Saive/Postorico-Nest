import { lookup as dnsLookup } from 'dns/promises';
import { AdresseRefusee, MODELE_EXTRACTION, SiteIllisible, SiteService, telechargerSur } from './site.service';

jest.mock('dns/promises');

// Lecture réseau : `fetch` et le DNS sont simulés, aucune requête ne sort.
describe('lecture du site (fetch simulé)', () => {
  const mockLookup = dnsLookup as jest.MockedFunction<typeof dnsLookup>;
  let fetchMock: jest.SpyInstance;

  const html = (corps: string, head = '') =>
    new Response(`<html lang="fr"><head>${head}</head><body>${corps}</body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  beforeEach(() => {
    mockLookup.mockReset();
    // Par défaut tout résout vers une IP publique ; « interne.* » vers le réseau privé.
    mockLookup.mockImplementation((async (host: string) => [
      { address: host.startsWith('interne') ? '10.0.0.8' : '93.184.216.34', family: 4 },
    ]) as never);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('refuse une redirection vers une adresse privée (sans la suivre)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://interne.exemple.com/admin' } }),
    );
    await expect(telechargerSur('https://piege.exemple.com', /.*/)).rejects.toThrow(AdresseRefusee);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuse une redirection vers un port exotique', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'http://site.fr:6379/' } }));
    await expect(telechargerSur('https://site.fr', /.*/)).rejects.toThrow(AdresseRefusee);
  });

  it('suit au plus 3 redirections', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/encore' } }));
    await expect(telechargerSur('https://boucle.fr', /.*/)).rejects.toThrow('Trop de redirections.');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('tronque une page au-delà de la taille maximale', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(5000), { headers: { 'content-type': 'text/html' } }));
    const t = await telechargerSur('https://gros.fr', /^text\/html$/, 1000);
    expect(t.corps.length).toBe(1000);
  });

  it("lit l'accueil + les pages utiles et remplit les champs factuels", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://dupont.fr') {
        return html(
          `<a href="/a-propos">À propos</a><a href="https://www.instagram.com/dupont/">IG</a>
           <img class="logo" src="/logo.png"><h1>Boulangerie Dupont à Nantes</h1>
           <p>Pain au levain, viennoiseries et gâteaux faits maison chaque matin.</p>`,
          '<title>Dupont</title><meta name="theme-color" content="#c0392b"><link rel="stylesheet" href="/s.css">',
        );
      }
      if (url === 'https://dupont.fr/a-propos') return html('<p>Fondée en 1998 par Marie Dupont.</p>');
      if (url === 'https://dupont.fr/s.css') {
        return new Response('body{font-family:"Lora",serif} .b{background:#1e8449}', {
          headers: { 'content-type': 'text/css' },
        });
      }
      return new Response('', { status: 404 });
    });
    const claude = {
      messagesCreate: jest.fn().mockResolvedValue({}),
      usage: jest.fn().mockReturnValue({ input: 3500, cache_read: 0, cache_write: 0, output: 600 }),
      texte: jest
        .fn()
        .mockReturnValue(
          JSON.stringify({
            marque: { value: 'Boulangerie Dupont', evidence: 'Boulangerie Dupont à Nantes' },
            anciennete: { value: '1998', evidence: 'Fondée en 1998 par Marie Dupont.' },
            zone: { value: 'Nantes', evidence: 'Livraison partout en Bretagne' }, // extrait absent du site
            histoire: 'Une belle histoire', // sans preuve
            position: { value: 'luxe', evidence: 'Pain au levain, viennoiseries' },
            col1: { value: '#000000', evidence: 'Boulangerie Dupont à Nantes' },
          }),
        ),
    };
    const usage = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new SiteService(claude as never, usage as never);
    const r = await service.preRemplir('dupont.fr');

    expect(r.pages_lues).toEqual(['https://dupont.fr', 'https://dupont.fr/a-propos']);
    expect(r.champs).toEqual({
      marque: 'Boulangerie Dupont',
      anciennete: '1998',
      site: 'https://dupont.fr',
      profils: 'https://www.instagram.com/dupont',
      col1: '#c0392b',
      col2: '#1e8449',
      charte: 'https://dupont.fr/logo.png',
      polices: 'Lora',
    });
    // Le texte envoyé à Claude est balisé comme donnée.
    const envoi = claude.messagesCreate.mock.calls[0][0];
    expect(envoi.messages[0].content).toContain('<website_content>');
    expect(envoi.messages[0].content).toContain('Fondée en 1998');
    // Appel unique, modèle économique, sortie bornée ; coût journalisé sans telegram_id.
    expect(claude.messagesCreate).toHaveBeenCalledTimes(1);
    expect(envoi.model).toBe(MODELE_EXTRACTION);
    expect(envoi.max_tokens).toBeLessThanOrEqual(1500);
    expect(claude.messagesCreate.mock.calls[0][1]).toEqual({ essais: 1 });
    expect(usage.log).toHaveBeenCalledWith(
      null,
      'onboarding_analyse_site',
      MODELE_EXTRACTION,
      expect.objectContaining({ input: 3500, output: 600 }),
      0,
      undefined,
      undefined,
      expect.any(Number),
    );
    expect(r.cout).toMatchObject({ tokensEntree: 3500, tokensSortie: 600 });
  });

  it('Claude en panne : les champs factuels reviennent quand même', async () => {
    fetchMock.mockImplementation(async () =>
      html('<h1>Atelier Martin</h1><p>Menuiserie sur mesure en bois massif depuis toujours.</p>'),
    );
    const claude = { messagesCreate: jest.fn().mockRejectedValue(new Error('surcharge')), texte: jest.fn() };
    const r = await new SiteService(claude as never, { log: jest.fn() } as never).preRemplir('https://martin.fr');
    expect(r.champs).toEqual({ site: 'https://martin.fr' });
  });

  it('budget global dépassé : on garde ce qui a été lu', async () => {
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === 'https://lent.fr') {
        return Promise.resolve(
          html('<a href="/contact">Contact</a><h1>Atelier lent</h1><p>Menuiserie artisanale, escaliers et cuisines sur mesure.</p>'),
        );
      }
      // Page interne qui ne répond jamais : seule l'interruption la débloque.
      return new Promise((_, rejeter) => init.signal?.addEventListener('abort', () => rejeter(new Error('abort'))));
    });
    const debut = Date.now();
    const l = await new SiteService({} as never, {} as never).lireSite('https://lent.fr', 300);
    expect(Date.now() - debut).toBeLessThan(2000);
    expect(l.pages.map((p) => p.url)).toEqual(['https://lent.fr']);
  });

  it('page sans texte lisible → SiteIllisible (pas AdresseRefusee)', async () => {
    fetchMock.mockImplementation(async () => html('<div id="root"></div><script>app()</script>'));
    const err = await new SiteService({} as never, {} as never).preRemplir('https://spa.fr').catch((e) => e);
    expect(err).toBeInstanceOf(SiteIllisible);
    expect(err).not.toBeInstanceOf(AdresseRefusee);
  });
});
