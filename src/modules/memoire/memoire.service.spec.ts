import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { UsageService } from '../usage/usage.service';
import { ContenuMemoireRow, genreDe, MemoireService, texteDe } from './memoire.service';

// Indexation (indexerContenu/reindexerCompte) absente du premier portage NestJS — repérée le
// 2026-09-29 (comparaison systématique Python/NestJS). Port de
// backend/services/memoire_service.py (genre_de, texte_de, indexer_contenu, reindexer_compte).
describe('genreDe / texteDe (fonctions pures)', () => {
  it('un post (type "Post court"/"Post_court"...) est toujours du genre "post"', () => {
    expect(genreDe({ type: 'Post court' })).toBe('post');
    expect(genreDe({ type: 'Post_court' })).toBe('post'); // nom d'enum Prisma, pas le libellé
    expect(genreDe({ type: null })).toBe('post'); // type absent -> post par défaut
  });

  it('un carrousel est du genre "carrousel"', () => {
    expect(genreDe({ type: 'Carrousel' })).toBe('carrousel');
  });

  it('un Reel/Video/Short avec script est du genre "script"', () => {
    expect(genreDe({ type: 'Reel', script: 'Bonjour à tous...' })).toBe('script');
  });

  it('une Story (ou tout type non couvert sans script) est non indexée (null)', () => {
    expect(genreDe({ type: 'Story' })).toBeNull();
    expect(genreDe({ type: 'Reel', script: null })).toBeNull();
  });

  it("texteDe d'un carrousel concatène hook + slides + cta", () => {
    const row: ContenuMemoireRow = {
      id: 'c1',
      telegram_id: 'u1',
      type: 'Carrousel',
      carrousel_data: {
        hook: 'Accroche',
        slides: [{ titre: 'T1', texte: 'Texte 1' }, { pro_tip: 'Astuce' }],
        cta: { titre: 'CTA titre', texte: 'CTA texte' },
      },
    };
    const t = texteDe(row);
    expect(t).toContain('Accroche');
    expect(t).toContain('T1');
    expect(t).toContain('Texte 1');
    expect(t).toContain('Astuce');
    expect(t).toContain('CTA titre');
  });

  it("texteDe d'un carrousel sans carrousel_data retombe sur le champ contenu", () => {
    expect(texteDe({ id: 'c1', telegram_id: 'u1', type: 'Carrousel', contenu: 'texte brut' })).toBe('texte brut');
  });

  it("texteDe d'un script préfère le script, puis le contenu", () => {
    expect(texteDe({ id: 'c1', telegram_id: 'u1', type: 'Reel', script: 'le script', contenu: 'le post' })).toBe('le script');
    expect(texteDe({ id: 'c1', telegram_id: 'u1', type: 'Reel', script: '', contenu: 'le post' })).toBe('le post');
  });
});

describe('MemoireService.indexerContenu', () => {
  let prisma: {
    contenu_embeddings: { deleteMany: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let service: MemoireService;
  let embedSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = { contenu_embeddings: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) }, $executeRaw: jest.fn().mockResolvedValue(1) };
    const usageStub = { log: jest.fn() } as unknown as UsageService;
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    service = new MemoireService(prisma as unknown as PrismaService, usageStub, configStub);
    embedSpy = jest.spyOn(service, 'embed');
  });

  const rowValide: ContenuMemoireRow = {
    id: 'c1',
    telegram_id: 'u1',
    type: 'Post court',
    statut: 'Valider',
    reseau_cible: 'LinkedIn',
    contenu: 'Un texte de post suffisamment long pour dépasser le seuil de quarante caractères.',
  };

  it('indexe un contenu validé, de genre couvert, texte suffisamment long', async () => {
    embedSpy.mockResolvedValue([[0.1, 0.2, 0.3]]);
    const ok = await service.indexerContenu(rowValide);
    expect(ok).toBe(true);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.contenu_embeddings.deleteMany).not.toHaveBeenCalled();
  });

  it('retire le vecteur si le contenu repasse "À valider" (statut non indexé)', async () => {
    const ok = await service.indexerContenu({ ...rowValide, statut: 'A_valider' });
    expect(ok).toBe(false);
    expect(prisma.contenu_embeddings.deleteMany).toHaveBeenCalledWith({ where: { contenu_id: 'c1' } });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('retire le vecteur si le genre est non couvert (ex. Story)', async () => {
    const ok = await service.indexerContenu({ ...rowValide, type: 'Story' });
    expect(ok).toBe(false);
    expect(prisma.contenu_embeddings.deleteMany).toHaveBeenCalled();
  });

  it('retire le vecteur si le texte est trop court (< 40 caractères)', async () => {
    const ok = await service.indexerContenu({ ...rowValide, contenu: 'trop court' });
    expect(ok).toBe(false);
    expect(prisma.contenu_embeddings.deleteMany).toHaveBeenCalled();
  });

  it("n'écrit rien si l'embedding échoue (pas de clé OpenAI, etc.)", async () => {
    embedSpy.mockResolvedValue([]);
    const ok = await service.indexerContenu(rowValide);
    expect(ok).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("n'avale jamais d'exception (contenu sans id -> false, pas de throw)", async () => {
    await expect(service.indexerContenu({ ...rowValide, id: '' })).resolves.toBe(false);
  });
});
