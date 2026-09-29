import type { Request } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { GabaritComposeService } from '../gabarit/gabarit-compose.service';
import { LateService } from '../late/late.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';

// Port de POST /agent/image (backend/routes/agent.py) : en mode template, le texte affiché
// vient TOUJOURS du post via l'accroche composée par Claude (composer_gabarit), pas du
// prompt brut de l'utilisateur — logique restée manquante au premier portage NestJS
// (repérée le 2026-09-29, comparaison systématique Python/NestJS).
describe('ImageController.image — auto-accroche en mode template', () => {
  function buildController(opts: {
    composerResult: unknown;
    contenu?: { contenu: string | null; titre: string | null } | null;
  }) {
    const imageService = {
      stylesImage: jest.fn().mockReturnValue({ photo: {} }),
      genererImage: jest.fn().mockResolvedValue({ lien_visuel: 'https://cdn/x.png' }),
    } as unknown as ImageService;
    const demarrageService = { exigerProfil: jest.fn().mockResolvedValue(undefined) } as unknown as DemarrageService;
    const planningService = { prochainCreneau: jest.fn().mockResolvedValue(null) } as unknown as PlanningService;
    const quotaService = {
      consume: jest.fn().mockResolvedValue({ ok: true, used: 1, limit: 10 }),
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    } as unknown as QuotaService;
    const usageService = { log: jest.fn().mockResolvedValue(undefined) } as unknown as UsageService;
    const prisma = {
      contenu: {
        findFirst: jest.fn().mockResolvedValue(opts.contenu ?? null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const lateService = {} as unknown as LateService;
    const gabaritComposeService = {
      composerGabarit: jest.fn().mockResolvedValue(opts.composerResult),
    } as unknown as GabaritComposeService;

    const controller = new ImageController(
      imageService,
      demarrageService,
      planningService,
      quotaService,
      usageService,
      prisma,
      lateService,
      gabaritComposeService,
    );
    const req = { user: { telegram_id: 'u1' } as JwtPayload } as Request & { user: JwtPayload };
    return { controller, imageService, gabaritComposeService, req };
  }

  it('sans instruction utilisateur : le prompt devient "Texte à afficher : <accroche>"', async () => {
    const { controller, imageService } = buildController({
      contenu: { contenu: 'Le vrai texte du post', titre: null },
      composerResult: { slots: { title_lines: [{ t: 'GRANDE' }, { t: 'ANNONCE' }] }, usage: {} },
    });
    await controller.image({ template_mode: true, contenu_id: 'c1', prompt: '' } as never, {
      user: { telegram_id: 'u1' },
    } as never);
    const promptEnvoye = (imageService.genererImage as jest.Mock).mock.calls[0][1];
    expect(promptEnvoye).toBe('Texte à afficher : GRANDE ANNONCE');
  });

  it("avec instruction utilisateur ET accroche : les deux sont combinées", async () => {
    const { controller, imageService } = buildController({
      contenu: { contenu: 'Post', titre: null },
      composerResult: { slots: { title_lines: [{ t: 'ACCROCHE' }] }, usage: {} },
    });
    await controller.image({ template_mode: true, contenu_id: 'c1', prompt: 'fond bleu néon' } as never, {
      user: { telegram_id: 'u1' },
    } as never);
    const promptEnvoye = (imageService.genererImage as jest.Mock).mock.calls[0][1];
    expect(promptEnvoye).toContain('Texte à afficher : ACCROCHE');
    expect(promptEnvoye).toContain('fond bleu néon');
  });

  it("si la composition échoue, retombe sur les seules consignes de l'utilisateur", async () => {
    const { controller, imageService } = buildController({
      contenu: { contenu: 'Post', titre: null },
      composerResult: { error: 'no_api_key' },
    });
    await controller.image({ template_mode: true, contenu_id: 'c1', prompt: 'fond bleu' } as never, {
      user: { telegram_id: 'u1' },
    } as never);
    const promptEnvoye = (imageService.genererImage as jest.Mock).mock.calls[0][1];
    expect(promptEnvoye).toBe("Consignes de l'utilisateur : fond bleu");
  });

  it('sans instruction ni accroche disponible : 400 (prompt requis)', async () => {
    const { controller } = buildController({
      contenu: null,
      composerResult: { error: 'no_api_key' },
    });
    await expect(
      controller.image({ template_mode: true, contenu_id: 'c1', prompt: '' } as never, { user: { telegram_id: 'u1' } } as never),
    ).rejects.toThrow('prompt requis');
  });

  it('hors mode template : le prompt brut est utilisé tel quel (comportement inchangé)', async () => {
    const { controller, imageService, gabaritComposeService } = buildController({ composerResult: { error: 'no_api_key' } });
    await controller.image({ template_mode: false, prompt: 'un chat sur un vélo' } as never, {
      user: { telegram_id: 'u1' },
    } as never);
    expect(gabaritComposeService.composerGabarit).not.toHaveBeenCalled();
    const promptEnvoye = (imageService.genererImage as jest.Mock).mock.calls[0][1];
    expect(promptEnvoye).toBe('un chat sur un vélo');
  });
});
