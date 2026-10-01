import { ConfigService } from '@nestjs/config';
import { RenderQueueService } from './render-queue.service';

// La file de rendu (lignes contenu video_status='en_traitement') est PARTAGÉE entre le
// backend Python et cette instance. Un worker ne doit réclamer que les compositions qu'il
// sait rendre ; une instance sans projet Remotion (liste vide) ne doit rien réclamer —
// avant le 2026-10-01 elle réclamait tout et envoyait les reels en « échec ».
describe('RenderQueueService.claim — fermé par défaut', () => {
  function build(connues: string[], rows: Array<Record<string, unknown>>, actif = true) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { contenu: { findMany: jest.fn().mockResolvedValue(rows), updateMany } } as never;
    const remotion = { compositionsConnues: jest.fn().mockReturnValue(connues) } as never;
    const config = { get: jest.fn((k: string) => (k === 'app.renderWorkerActive' ? actif : '')) } as unknown as ConfigService;
    const service = new RenderQueueService(prisma, remotion, {} as never, {} as never, {} as never, config);
    return { service, updateMany };
  }
  const rows = [
    { id: 'r1', telegram_id: 'u1', render_job: { composition: 'ReelSequence' } },
    { id: 'r2', telegram_id: 'u1', render_job: { composition: 'StoryAnimee' } },
  ];
  const claim = (s: RenderQueueService) => (s as unknown as { claim: () => Promise<unknown> }).claim();

  it('aucune composition connue : ne réclame rien', async () => {
    const { service, updateMany } = build([], rows);
    expect(await claim(service)).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ne réclame que les compositions connues', async () => {
    const { service, updateMany } = build(['StoryAnimee'], rows);
    const row = (await claim(service)) as { id: string };
    expect(row.id).toBe('r2');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: 'r2', render_started_at: null });
  });

  it('RENDER_WORKER_ACTIVE=0 : la boucle ne démarre pas', () => {
    jest.useFakeTimers();
    const { service } = build(['ReelSequence'], rows, false);
    const boucle = jest.spyOn(service as unknown as { boucle: () => Promise<void> }, 'boucle').mockResolvedValue();
    service.onApplicationBootstrap();
    jest.advanceTimersByTime(60_000);
    expect(boucle).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
