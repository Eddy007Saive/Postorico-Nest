import { ConfigService } from '@nestjs/config';
import { lookup as dnsLookup } from 'dns/promises';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { ImageService } from './image.service';

jest.mock('dns/promises');

// Scan Strix du 2026-09-28 : prepRefs() fetchait les URLs fournies par le client
// (refs/integrate_refs/ecran_refs, ImageDto) sans aucune validation anti-SSRF, contrairement
// à normaliserUrl() (site.service.ts) utilisée pour le même problème sur /site/analyser.
// Ces tests verrouillent le correctif : résolution DNS + rejet des IP non publiques, y
// compris derrière une redirection (redirect-based SSRF / DNS rebinding).
describe('ImageService.prepRefs (anti-SSRF)', () => {
  const mockLookup = dnsLookup as jest.MockedFunction<typeof dnsLookup>;
  let service: ImageService;
  let fetchSpy: jest.SpyInstance;

  function prepRefs(urls: string[]): Promise<string[]> {
    return (service as unknown as { prepRefs(urls: string[]): Promise<string[]> }).prepRefs(urls);
  }

  function dns(...adresses: string[]) {
    mockLookup.mockResolvedValue(adresses.map((address) => ({ address, family: 4 })) as never);
  }

  function imageResponse(): Response {
    return new Response(Buffer.alloc(200, 1), { status: 200, headers: { 'content-type': 'image/png' } });
  }

  beforeEach(() => {
    mockLookup.mockReset();
    const claudeStub = {} as unknown as ClaudeService;
    const marqueStub = {} as unknown as MarqueService;
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    service = new ImageService(claudeStub, marqueStub, configStub);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuse une référence qui résout vers une adresse privée', async () => {
    dns('127.0.0.1');
    const res = await prepRefs(['http://interne.exemple.com/photo.png']);
    expect(res).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuse une référence qui résout vers les métadonnées cloud', async () => {
    dns('169.254.169.254');
    const res = await prepRefs(['http://169.254.169.254/latest/meta-data/']);
    expect(res).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepte une image publique valide', async () => {
    dns('93.184.216.34');
    fetchSpy.mockResolvedValue(imageResponse());
    const res = await prepRefs(['https://exemple.com/photo.png']);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('revalide chaque saut de redirection et refuse si la cible finale est interne', async () => {
    // 1er saut : hôte public qui redirige ; 2e saut : hôte interne — chaque hôte a sa
    // propre résolution DNS mockée dans l'ordre des appels.
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://interne.exemple.com/photo.png' } }),
    );
    const res = await prepRefs(['https://public.exemple.com/redir']);
    expect(res).toEqual([]);
    // Le second saut n'a jamais dû être fetché : normaliserUrl l'a rejeté avant.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('suit une redirection publique vers une image publique', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '93.184.216.35', family: 4 }] as never);
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.exemple.com/photo.png' } }),
      )
      .mockResolvedValueOnce(imageResponse());
    const res = await prepRefs(['https://public.exemple.com/redir']);
    expect(res).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
