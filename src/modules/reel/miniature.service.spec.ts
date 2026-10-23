import { v2 as cloudinary } from 'cloudinary';
import { MiniatureService } from './miniature.service';

jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), api: { update: jest.fn().mockResolvedValue({}) }, uploader: { destroy: jest.fn().mockResolvedValue({}) } },
}));

describe('MiniatureService.planRetouche', () => {
  const messagesCreate = jest.fn().mockResolvedValue({});
  const texte = jest.fn();
  const marque = { chargerMarque: jest.fn().mockResolvedValue({ langue: 'fr' }), contexteMarqueCourt: jest.fn().mockReturnValue('') };
  const service = new MiniatureService(
    {} as never,
    { messagesCreate, texte } as never,
    marque as never,
    {} as never,
    {} as never,
    { get: jest.fn().mockReturnValue('nuage') } as never,
  );
  const mini = { gabarit: 'affiche', textes: { kicker: 'NOUVEAU', titre: 'Le secret des pros', sous: 'ce que personne ne dit', objet: 'a key' }, police: 'cinema' };

  it('ne change que les textes demandés, recomposés sans retouche du fond', async () => {
    texte.mockReturnValue('{"textes": {"titre": "200 biens"}, "police": null, "fond": null, "reponse": "J’ai raccourci le titre."}');
    const plan = await service.planRetouche('u1', mini, 'titre plus court');
    expect(plan.textes).toEqual({ ...mini.textes, titre: '200 biens' });
    expect(plan.police).toBe('cinema');
    expect(plan.fond).toBeNull();
    expect(plan.reponse).toBe('J’ai raccourci le titre.');
  });

  it('transmet une retouche du fond et ignore une police inconnue ou un champ hors gabarit', async () => {
    texte.mockReturnValue('Voici : {"textes": {"objet": "x", "inconnu": "y"}, "police": "comic-sans", "fond": "Remove the cap.", "reponse": "Casquette retirée."}');
    const plan = await service.planRetouche('u1', mini, 'enlève la casquette');
    expect(plan.fond).toBe('Remove the cap.');
    expect(plan.police).toBe('cinema');
    expect(plan.textes).toEqual(mini.textes);
  });

  it('accepte une police de la liste et tronque un titre trop long', async () => {
    texte.mockReturnValue(JSON.stringify({ textes: { titre: 'x'.repeat(80) }, police: 'comics', fond: null, reponse: 'ok' }));
    const plan = await service.planRetouche('u1', mini, 'police bd et titre');
    expect(plan.police).toBe('comics');
    expect(plan.textes.titre).toHaveLength(50);
  });

  it('réponse illisible : rien ne change, aucune retouche payante', async () => {
    texte.mockReturnValue('désolé');
    const plan = await service.planRetouche('u1', mini, '???');
    expect(plan).toEqual({ textes: mini.textes, police: 'cinema', fond: null, reponse: '' });
  });
});

describe('MiniatureService.supprimerFond', () => {
  const service = new MiniatureService({} as never, {} as never, {} as never, {} as never, {} as never, { get: jest.fn() } as never);
  beforeEach(() => (cloudinary.uploader.destroy as jest.Mock).mockClear());

  it('supprime un fond du dossier miniatures du compte', async () => {
    await service.supprimerFond('u1', 'https://res.cloudinary.com/n/image/upload/c_fill,ar_9:16/v1712/miniatures/u1/r1-fond-1712.png');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('miniatures/u1/r1-fond-1712', { resource_type: 'image', invalidate: true });
  });

  it('ne touche jamais à une image d’un autre compte ou hors du dossier miniatures', async () => {
    await service.supprimerFond('u1', 'https://res.cloudinary.com/n/image/upload/v1/miniatures/u2/r1-fond-1.png');
    await service.supprimerFond('u1', 'https://res.cloudinary.com/n/image/upload/v1/inspirations/u1/sujet-1.png');
    await service.supprimerFond('u1', '');
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });
});

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

describe('MiniatureService.objetEnAnglais', () => {
  const messagesCreate = jest.fn().mockResolvedValue({});
  const texte = jest.fn();
  const service = new MiniatureService(
    {} as never,
    { messagesCreate, texte } as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn().mockReturnValue('nuage') } as never,
  );
  beforeEach(() => { messagesCreate.mockClear(); messagesCreate.mockResolvedValue({}); });

  it('traduit l’objet saisi en français pour le générateur', async () => {
    texte.mockReturnValue('"a giant golden key."');
    await expect(service.objetEnAnglais('une clé dorée géante')).resolves.toBe('a giant golden key');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it('remplace un objet vide sans appeler l’IA', async () => {
    await expect(service.objetEnAnglais('  ')).resolves.toBe('a glowing object');
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('garde le texte du client si la traduction échoue', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('panne'));
    await expect(service.objetEnAnglais('une boussole')).resolves.toBe('une boussole');
  });
});
