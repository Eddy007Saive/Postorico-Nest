import { v2 as cloudinary } from 'cloudinary';
import { StockVideoService } from './stock-video.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    api: { resource: jest.fn() },
    uploader: { upload: jest.fn() },
  },
}));

const fichier = (w: number, h: number, link: string) => ({ link, width: w, height: h, file_type: 'video/mp4' });

describe('StockVideoService', () => {
  const messagesCreate = jest.fn().mockResolvedValue({});
  const texte = jest.fn();
  const avecCle = (cle = 'cle-pexels') =>
    new StockVideoService({ messagesCreate, texte } as never, { get: (k: string) => (k === 'app.pexelsApiKey' ? cle : 'x') } as never);
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sans clé Pexels : aucun plan, aucun appel', async () => {
    const s = avecCle('');
    expect(await s.pool('Un chantier de rénovation')).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extrait jusqu’à n recherches propres, et rien si la réponse est illisible', async () => {
    const s = avecCle();
    texte.mockReturnValueOnce('{"queries": ["hotel room cleaning", "x", "keys handover", "laundry machines", "extra"]}');
    expect(await s.requetes('texte', 3)).toEqual(['hotel room cleaning', 'keys handover', 'laundry machines']);
    texte.mockReturnValueOnce('désolé');
    expect(await s.requetes('texte')).toEqual([]);
  });

  it('ne garde que les plans verticaux d’au moins 4 s, pas déjà pris', async () => {
    const s = avecCle();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        videos: [
          { id: 1, duration: 10, width: 1920, height: 1080, video_files: [fichier(1920, 1080, 'paysage')] },
          { id: 2, duration: 2, width: 1080, height: 1920, video_files: [fichier(1080, 1920, 'court')] },
          { id: 3, duration: 8, width: 1080, height: 1920, video_files: [fichier(1080, 1920, 'deja')] },
          { id: 4, duration: 8, width: 1080, height: 1920, video_files: [fichier(720, 1280, 'petit'), fichier(1080, 1920, 'bon')] },
        ],
      }),
    });
    expect(await s.chercher('hotel room', new Set([3]))).toEqual({ id: 4, lien: 'bon' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('cle-pexels');
  });

  it('réutilise une vidéo déjà copiée dans Cloudinary au lieu de la réimporter', async () => {
    const s = avecCle();
    (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ secure_url: 'https://res.cloudinary.com/n/video/upload/v1/stock/pexels-4.mp4' });
    expect(await s.importer({ id: 4, lien: 'bon' })).toBe('https://res.cloudinary.com/n/video/upload/v1/stock/pexels-4.mp4');
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();

    (cloudinary.api.resource as jest.Mock).mockRejectedValueOnce(new Error('not found'));
    (cloudinary.uploader.upload as jest.Mock).mockResolvedValueOnce({ secure_url: 'https://res.cloudinary.com/n/video/upload/v2/stock/pexels-5.mp4' });
    expect(await s.importer({ id: 5, lien: 'lien5' })).toContain('pexels-5');
    expect(cloudinary.uploader.upload).toHaveBeenCalledWith('lien5', { resource_type: 'video', public_id: 'stock/pexels-5', overwrite: false });
  });

  it('pool : un plan par recherche trouvée, au format attendu par le scénariste ; les échecs sont sautés', async () => {
    const s = avecCle();
    texte.mockReturnValueOnce('{"queries": ["hotel room cleaning", "nothing here"]}');
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ videos: [{ id: 9, duration: 6, width: 1080, height: 1920, video_files: [fichier(1080, 1920, 'l9')] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ videos: [] }) });
    (cloudinary.api.resource as jest.Mock).mockRejectedValue(new Error('not found'));
    (cloudinary.uploader.upload as jest.Mock).mockResolvedValue({ secure_url: 'https://res.cloudinary.com/n/video/upload/v1/stock/pexels-9.mp4' });

    expect(await s.pool('Ménage des chambres entre deux voyageurs')).toEqual([
      { id: 'stock_1', url: 'https://res.cloudinary.com/n/video/upload/v1/stock/pexels-9.mp4', desc: 'Real stock footage (Pexels): hotel room cleaning' },
    ]);
  });

  it('pool : Claude en panne → aucun plan, sans erreur', async () => {
    const s = avecCle();
    messagesCreate.mockRejectedValueOnce(new Error('overloaded'));
    expect(await s.pool('texte')).toEqual([]);
  });
});
