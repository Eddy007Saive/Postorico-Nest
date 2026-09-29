import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { BanqueService } from '../banque/banque.service';
import { MontagePocService } from '../video/montage-poc.service';
import { MusicLibraryService } from '../music/music-library.service';
import { QuotaService } from '../quota/quota.service';
import { RenderQueueService } from '../render-queue/render-queue.service';
import { VoixService } from '../voix/voix.service';
import { EditeurService, MontageRow } from './editeur.service';

jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

// Port de backend/services/editeur_service.py::importer_audio / restaurer_rendu — deux
// fonctionnalités absentes de la première version portée (repérées par une comparaison
// systématique Python/NestJS le 2026-09-29).
describe('EditeurService — audio-import & restaurer', () => {
  let prisma: { montages: { findFirst: jest.Mock; update: jest.Mock }; contenu: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock } };
  let service: EditeurService;

  function montage(over: Partial<MontageRow> = {}): MontageRow {
    return {
      id: 'm1',
      telegram_id: 'u1',
      titre: 'Montage',
      projet: { version: 1, elements: [] },
      projet_rendu: null,
      source_contenu_id: null,
      contenu_id: null,
      statut: 'brouillon',
      video_url: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...over,
    };
  }

  beforeEach(() => {
    prisma = {
      montages: { findFirst: jest.fn(), update: jest.fn() },
      contenu: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'c1' }) },
    };
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    service = new EditeurService(
      prisma as never,
      {} as unknown as BanqueService,
      {} as unknown as MusicLibraryService,
      {} as unknown as QuotaService,
      {} as unknown as RenderQueueService,
      {} as unknown as MontagePocService,
      {} as unknown as VoixService,
      configStub,
    );
    (cloudinary.uploader.upload as jest.Mock).mockReset();
  });

  describe('restaurerRendu', () => {
    it('renvoie null si le montage est introuvable', async () => {
      prisma.montages.findFirst.mockResolvedValue(null);
      await expect(service.restaurerRendu('u1', 'm1')).resolves.toBeNull();
    });

    it("renvoie null si aucune version n'a jamais été exportée (projet_rendu absent)", async () => {
      prisma.montages.findFirst.mockResolvedValue(montage({ projet_rendu: null }));
      await expect(service.restaurerRendu('u1', 'm1')).resolves.toBeNull();
      expect(prisma.montages.update).not.toHaveBeenCalled();
    });

    it("restaure le projet figé au dernier export et repasse le montage en brouillon", async () => {
      const projetRendu = { version: 1, elements: [{ id: 'e1', piste: 'p-texte', type: 'texte', debut: 0, duree: 2, texte: 'Salut' }] };
      prisma.montages.findFirst.mockResolvedValue(montage({ statut: 'rendu', projet_rendu: projetRendu }));
      prisma.montages.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(montage({ ...data, statut: data.statut as string })),
      );
      const res = await service.restaurerRendu('u1', 'm1');
      expect(prisma.montages.update).toHaveBeenCalledTimes(1);
      const data = prisma.montages.update.mock.calls[0][0].data;
      expect(data.projet).toMatchObject(projetRendu);
      expect(data.statut).toBe('brouillon'); // un montage "rendu" redevient brouillon après restauration
      expect(res).not.toBeNull();
    });
  });

  describe('importerAudio', () => {
    const fichierValide = { buffer: Buffer.alloc(1000, 1), mimetype: 'audio/mpeg', originalname: 'voix.mp3' };

    it('refuse un fichier qui n\'est ni un mimetype audio ni une extension audio connue', async () => {
      const res = await service.importerAudio('u1', { buffer: Buffer.alloc(10), mimetype: 'image/png', originalname: 'photo.png' });
      expect(res).toHaveProperty('error');
      expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    });

    it('accepte une extension audio connue même avec un mimetype générique', async () => {
      (cloudinary.uploader.upload as jest.Mock).mockResolvedValue({ secure_url: 'https://cdn/x.mp3', duration: 12.34 });
      const res = await service.importerAudio('u1', { buffer: Buffer.alloc(10), mimetype: 'application/octet-stream', originalname: 'piste.wav' });
      expect(res).toEqual({ url: 'https://cdn/x.mp3', duree_s: 12.34 });
    });

    it('refuse un fichier trop lourd (> 25 Mo)', async () => {
      const gros = { buffer: Buffer.alloc(26 * 1024 * 1024), mimetype: 'audio/mpeg', originalname: 'gros.mp3' };
      const res = await service.importerAudio('u1', gros);
      expect(res).toEqual({ error: 'Fichier trop lourd (max 25 Mo).' });
      expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    });

    it('upload réussi : renvoie url + durée arrondie', async () => {
      (cloudinary.uploader.upload as jest.Mock).mockResolvedValue({ secure_url: 'https://cdn/audio.mp3', duration: 42.5678 });
      const res = await service.importerAudio('u1', fichierValide);
      expect(res).toEqual({ url: 'https://cdn/audio.mp3', duree_s: 42.57 });
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        expect.stringMatching(/^data:audio\/mpeg;base64,/),
        expect.objectContaining({ folder: 'editeur-audio/u1', resource_type: 'video' }),
      );
    });

    it('échec Cloudinary : renvoie une erreur au lieu de planter', async () => {
      (cloudinary.uploader.upload as jest.Mock).mockRejectedValue(new Error('boom'));
      const res = await service.importerAudio('u1', fichierValide);
      expect(res).toEqual({ error: "Échec de l'import." });
    });
  });

  describe('rendre — fige projet_rendu (sans quoi restaurerRendu ne peut jamais rien restaurer)', () => {
    it('persiste projet_rendu = projet au moment du rendu', async () => {
      const quotaService = { consume: jest.fn().mockResolvedValue({ ok: true, used: 1, limit: 10 }), confirm: jest.fn(), refund: jest.fn() };
      const renderQueueService = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const svc = new EditeurService(
        prisma as never,
        {} as unknown as BanqueService,
        {} as unknown as MusicLibraryService,
        quotaService as unknown as QuotaService,
        renderQueueService as unknown as RenderQueueService,
        {} as unknown as MontagePocService,
        {} as unknown as VoixService,
        { get: jest.fn().mockReturnValue('') } as unknown as ConfigService,
      );
      const projet = { version: 1, elements: [{ id: 'e1', piste: 'p-video', type: 'video', debut: 0, duree: 3, src: 'https://exemple.com/v.mp4' }] };
      prisma.montages.findFirst.mockResolvedValue(montage({ projet, statut: 'brouillon' }));
      prisma.montages.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(montage(data)));
      await svc.rendre('u1', 'm1', 'Instagram', 'Mon titre');
      const data = prisma.montages.update.mock.calls[0][0].data;
      expect(data.projet_rendu).toBeDefined();
      expect(data.projet_rendu).toEqual(data.projet);
    });
  });
});
