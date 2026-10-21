import { v2 as cloudinary } from 'cloudinary';
import { MiniatureService } from './miniature.service';

jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), api: { update: jest.fn().mockResolvedValue({}) } },
}));

describe('MiniatureService.genererSujet', () => {
  const genererImage = jest.fn();
  const config = { get: jest.fn().mockReturnValue('nuage') };
  const service = new MiniatureService(
    {} as never,
    {} as never,
    {} as never,
    { genererImage } as never,
    {} as never,
    config as never,
  );

  beforeEach(() => {
    genererImage.mockReset();
    (cloudinary.api.update as jest.Mock).mockClear();
  });

  it('range le sujet dans la banque du compte, sans références de style, marqué « intégrer »', async () => {
    genererImage.mockResolvedValue({ lien_visuel: 'https://res.cloudinary.com/x/sujet.png' });

    const url = await service.genererSujet('u1', 'Une mascotte poulet violet en casquette', '3d');

    expect(url).toBe('https://res.cloudinary.com/x/sujet.png');
    const args = genererImage.mock.calls[0];
    expect(args[0]).toBe('u1');
    expect(args[1]).toContain('Une mascotte poulet violet en casquette');
    expect(args[1]).toContain('NO TEXT');
    expect(args[2]).toBe(false); // pas la photo du compte
    expect(args[5]).toEqual([]); // pas les inspirations comme références de style
    expect(args[10]).toMatch(/^inspirations\/u1\/sujet-\d+$/);
    expect(args[12]).toBe('3d');
    expect(cloudinary.api.update).toHaveBeenCalledWith(args[10], { resource_type: 'image', context: 'integrate=1|ecran=0' });
  });

  it('remonte l’échec de génération (le contrôleur rembourse le quota)', async () => {
    genererImage.mockResolvedValue({ error: 'no_image' });
    await expect(service.genererSujet('u1', 'Une clé dorée')).rejects.toThrow('no_image');
    expect(cloudinary.api.update).not.toHaveBeenCalled();
  });

  it('garde le sujet même si le rôle « intégrer » ne peut pas être posé', async () => {
    genererImage.mockResolvedValue({ lien_visuel: 'https://res.cloudinary.com/x/s.png' });
    (cloudinary.api.update as jest.Mock).mockRejectedValueOnce(new Error('cloudinary down'));
    await expect(service.genererSujet('u1', 'Un trophée')).resolves.toBe('https://res.cloudinary.com/x/s.png');
  });
});
