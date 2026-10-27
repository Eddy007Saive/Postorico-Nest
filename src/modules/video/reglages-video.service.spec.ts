import { nettoyerMontage, ReglagesVideoService } from './reglages-video.service';

describe('ReglagesVideoService', () => {
  let stocke: unknown = null;
  const prisma = {
    users: {
      findUnique: jest.fn(async () => ({ reglages_video: stocke })),
      update: jest.fn(async ({ data }: { data: { reglages_video: unknown } }) => { stocke = data.reglages_video; return {}; }),
    },
  };
  const service = new ReglagesVideoService(prisma as never);
  beforeEach(() => { stocke = null; });

  it('ne garde que les réglages connus, au bon type', () => {
    expect(nettoyerMontage({ template: 'hormozi', zooms: true, volume: 30, brollPct: '45', inconnu: 1, customId: null, subColor: 'x'.repeat(200) }))
      .toEqual({ template: 'hormozi', zooms: true, volume: 30, customId: null, subColor: 'x'.repeat(80) });
    expect(nettoyerMontage('pas un objet')).toEqual({});
  });

  it('une consigne par onglet, chacune remplacée sans toucher aux autres', async () => {
    await service.ecrire('u1', 'consigne_video', '  Reel nerveux, sous-titres en couleur  ');
    await service.ecrire('u1', 'consigne_motion', 'Ton calme');
    await service.ecrire('u1', 'montage', { template: 'beast', music: 'calme-1' });
    expect(await service.lire('u1')).toEqual({ consigne_video: 'Reel nerveux, sous-titres en couleur', consigne_motion: 'Ton calme', montage: { template: 'beast', music: 'calme-1' } });
  });

  it('effacer : consigne vide ou montage null', async () => {
    await service.ecrire('u1', 'consigne_video', 'A');
    await service.ecrire('u1', 'montage', { zooms: false });
    await service.ecrire('u1', 'consigne_video', '');
    await service.ecrire('u1', 'montage', null);
    expect(await service.lire('u1')).toEqual({});
  });

  it('consigne coupée à 1500 caractères', async () => {
    const r = await service.ecrire('u1', 'consigne_motion', 'a'.repeat(2000));
    expect(r.consigne_motion).toHaveLength(1500);
  });
});
