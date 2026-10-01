import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { LateService } from './late.service';
import { ZernioError } from '../zernio/zernio-client.service';

// Couvre le filet de sécurité sweepPlanifies (les 3 passes) et retryEchecsDuJour — port
// direct de backend/services/late_service.py::sweep_planifies. Prisma, Zernio et
// SocialService sont simulés ; le flux de publication direct (publishContenu) est hors
// périmètre de ce fichier (nécessiterait une base de test dédiée).
describe('LateService.sweepPlanifies', () => {
  function makeService(overrides: {
    findManyImpl?: (args: unknown) => Promise<unknown[]>;
    update?: jest.Mock;
    getPost?: jest.Mock;
    retryPost?: jest.Mock;
    listConnectedAccounts?: jest.Mock;
  }) {
    const findMany = jest.fn(overrides.findManyImpl ?? (async () => []));
    const update = overrides.update ?? jest.fn().mockResolvedValue({});
    const prismaStub = { contenu: { findMany, update } } as never;
    const zernioStub = {
      getPost: overrides.getPost ?? jest.fn(),
      retryPost: overrides.retryPost ?? jest.fn().mockResolvedValue({}),
    } as never;
    const mailStub = {} as never;
    const socialStub = {
      listConnectedAccounts: overrides.listConnectedAccounts ?? jest.fn().mockResolvedValue({}),
    } as never;
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const pushStub = { sendToUser: jest.fn().mockResolvedValue(true) } as never;
    const evenementStub = { log: jest.fn().mockResolvedValue(undefined) } as never;
    const service = new LateService(prismaStub, zernioStub, mailStub, socialStub, pushStub, evenementStub, configStub);
    return { service, findMany, update };
  }

  it('passe 1 — programme sur Zernio les contenus Planifie jamais poussés', async () => {
    let call = 0;
    const { service, findMany } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 1) return [{ id: 'c1', telegram_id: 'u1' }, { id: 'c2', telegram_id: 'u1' }];
        return []; // passes 2 et 3 : rien
      },
    });
    jest.spyOn(service, 'programmerContenu').mockResolvedValue({ ok: true, late_post_id: 'zp1' });

    const n = await service.sweepPlanifies();

    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { statut: 'Planifie', late_post_id: null, publish_status: null, date_publication: { gt: expect.any(Date) } },
      }),
    );
    expect(service.programmerContenu).toHaveBeenCalledTimes(2);
    expect(n).toBe(2);
  });

  it('passe 2 — aligne la base sur un post publié côté Zernio', async () => {
    let call = 0;
    const { service, update } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 2) return [{ id: 'c1', late_post_id: 'zp1' }];
        return [];
      },
      getPost: jest.fn().mockResolvedValue({ post: { status: 'PUBLISHED' } }),
    });

    await service.sweepPlanifies();

    expect(update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { publish_status: 'publié', statut: 'Publie' } });
  });

  it("passe 2 — libère la ligne quand le post a disparu chez Zernio (404)", async () => {
    let call = 0;
    const { service, update } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 2) return [{ id: 'c1', late_post_id: 'zp-disparu' }];
        return [];
      },
      getPost: jest.fn().mockRejectedValue(new ZernioError('Post not found', 404)),
    });

    await service.sweepPlanifies();

    expect(update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { late_post_id: null, publish_status: null } });
  });

  it('passe 3 — relance un échec récent (<24h, compte actif, pas de retry depuis 2h)', async () => {
    let call = 0;
    const vieuxUpdatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h : au-delà du garde-fou 2h
    const { service, update, findMany } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 3) {
          return [{ id: 'c1', telegram_id: 'u1', reseau_cible: 'LinkedIn', late_post_id: 'zp1', updated_at: vieuxUpdatedAt }];
        }
        return [];
      },
      listConnectedAccounts: jest.fn().mockResolvedValue({ linkedin: { is_active: true } }),
      retryPost: jest.fn().mockResolvedValue({}),
    });

    const n = await service.sweepPlanifies();

    expect(findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ where: expect.objectContaining({ publish_status: 'échec', late_post_id: { not: null } }) }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { publish_status: 'envoi', publish_error: null, updated_at: expect.any(Date) },
    });
    expect(n).toBe(1);
  });

  it('passe 3 — saute un échec dont le compte est déconnecté', async () => {
    let call = 0;
    const { service, update } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 3) {
          return [{ id: 'c1', telegram_id: 'u1', reseau_cible: 'LinkedIn', late_post_id: 'zp1', updated_at: new Date(0) }];
        }
        return [];
      },
      listConnectedAccounts: jest.fn().mockResolvedValue({ linkedin: { is_active: false } }),
    });

    const n = await service.sweepPlanifies();

    expect(update).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('passe 3 — respecte l\'espacement de 2h entre deux tentatives', async () => {
    let call = 0;
    const recent = new Date(Date.now() - 30 * 60 * 1000); // 30 min : sous le garde-fou 2h
    const { service, update } = makeService({
      findManyImpl: async () => {
        call += 1;
        if (call === 3) {
          return [{ id: 'c1', telegram_id: 'u1', reseau_cible: 'LinkedIn', late_post_id: 'zp1', updated_at: recent }];
        }
        return [];
      },
    });

    const n = await service.sweepPlanifies();

    expect(update).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});

const SECRET_LATE = 'secret-late-de-test';

function hmacHex(corps: Buffer, secret = SECRET_LATE): string {
  return createHmac('sha256', secret).update(corps).digest('hex');
}

function makeServiceForSignature(webhookSecret: string) {
  const prismaStub = {} as never;
  const zernioStub = {} as never;
  const mailStub = {} as never;
  const socialStub = {} as never;
  const pushStub = {} as never;
  const configStub = {
    get: jest.fn().mockReturnValue(webhookSecret),
  } as unknown as ConfigService;
  return new LateService(prismaStub, zernioStub, mailStub, socialStub, pushStub, { log: jest.fn() } as never, configStub);
}

// Port direct de backend/tests/test_webhooks.py (section Late), corrigé suite au scan
// Strix du 2026-09-28 : `verifySignature` est désormais fail-closed dès qu'un secret est
// configuré (comme Stripe) — voir le commentaire de la fonction pour la contrepartie
// assumée (le bouton "Test" non signé du dashboard Late est désormais rejeté).
describe('LateService.verifySignature', () => {
  it('signature hex valide acceptée', () => {
    const service = makeServiceForSignature(SECRET_LATE);
    const corps = Buffer.from('{"event":"post.published"}');
    expect(service.verifySignature(corps, hmacHex(corps))).toBe(true);
  });

  it('signature base64 valide acceptée', () => {
    const service = makeServiceForSignature(SECRET_LATE);
    const corps = Buffer.from('{"event":"post.published"}');
    const b64 = createHmac('sha256', SECRET_LATE).update(corps).digest('base64');
    expect(service.verifySignature(corps, b64)).toBe(true);
  });

  it('sans signature, rejetée quand un secret est configuré', () => {
    const service = makeServiceForSignature(SECRET_LATE);
    expect(service.verifySignature(Buffer.from('{}'), '')).toBe(false);
  });

  it('sans secret configuré, acceptée (vérification impossible — comportement legacy)', () => {
    const service = makeServiceForSignature('');
    expect(service.verifySignature(Buffer.from('{}'), "n'importe quoi")).toBe(true);
  });

  it('signature invalide (mais présente) est rejetée', () => {
    const service = makeServiceForSignature(SECRET_LATE);
    expect(service.verifySignature(Buffer.from('{"event":"post.published"}'), 'signature-forgee')).toBe(false);
  });
});

// Port de backend/services/late_service.py::_notify_account — le push FCM manquait dans le
// premier portage (repéré le 2026-09-29, comparaison systématique Python/NestJS). Ce test
// verrouille le fait qu'une déconnexion de compte social déclenche bien la notif in-app ET
// le push, pas seulement la notif.
describe('LateService.handleWebhook — account.disconnected déclenche le push', () => {
  it('envoie le push FCM en plus de la notif in-app quand un compte se déconnecte', async () => {
    const prismaStub = {
      comptes_sociaux: {
        findFirst: jest.fn().mockResolvedValue({ telegram_id: 'u1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      notifications: { create: jest.fn().mockResolvedValue({}) },
      users: { findUnique: jest.fn().mockResolvedValue(null) },
    } as never;
    const zernioStub = {} as never;
    const mailStub = { sendEmail: jest.fn(), accountDisconnectedHtml: jest.fn() } as never;
    const socialStub = {} as never;
    const pushStub = { sendToUser: jest.fn().mockResolvedValue(true) };
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const service = new LateService(prismaStub, zernioStub, mailStub, socialStub, pushStub as never, { log: jest.fn().mockResolvedValue(undefined) } as never, configStub);

    await service.handleWebhook({ event: 'account.disconnected', account: { platform: 'instagram', id: 'acc-1' } });

    expect(pushStub.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('déconnecté'),
      expect.any(String),
      expect.objectContaining({ event: 'account.disconnected', reseau: 'instagram' }),
    );
  });
});

// Port de backend/services/late_service.py::handle_webhook (appel à push_service.send_to_user
// juste après _notify, lignes 564-570) — le push FCM manquait dans le premier portage pour les
// événements post.* (published/partial/failed/scheduled/cancelled/recycled), contrairement à
// account.disconnected qui l'avait déjà (repéré le 2026-09-30, comparaison Python/NestJS).
describe('LateService.handleWebhook — post.published déclenche aussi le push', () => {
  it('envoie le push FCM en plus de la notif in-app quand un post est publié', async () => {
    const prismaStub = {
      contenu: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', telegram_id: 'u1', titre: 'Mon post', reseau_cible: 'linkedin' }),
        update: jest.fn().mockResolvedValue({}),
      },
      notifications: { create: jest.fn().mockResolvedValue({}) },
    } as never;
    const zernioStub = {} as never;
    const mailStub = {} as never;
    const socialStub = {} as never;
    const pushStub = { sendToUser: jest.fn().mockResolvedValue(true) };
    const configStub = { get: jest.fn().mockReturnValue('') } as unknown as ConfigService;
    const service = new LateService(prismaStub, zernioStub, mailStub, socialStub, pushStub as never, { log: jest.fn().mockResolvedValue(undefined) } as never, configStub);

    await service.handleWebhook({ event: 'post.published', post: { id: 'late-1' } });

    expect(pushStub.sendToUser).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('publié'),
      expect.any(String),
      expect.objectContaining({ event: 'post.published', contenu_id: 'c1' }),
    );
  });
});