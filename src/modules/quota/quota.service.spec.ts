import { QuotaService, imageAction } from './quota.service';

// Port direct de backend/tests/test_quota.py. Les tests de parsing de date (_parse) n'ont
// pas d'équivalent ici : Prisma renvoie déjà des objets Date natifs, il n'y a rien à
// parser défensivement contrairement au client Supabase Python qui reçoit des chaînes ISO.
describe('imageAction', () => {
  it('nano3 -> image_pro', () => {
    expect(imageAction('nano3')).toBe('image_pro');
  });

  it.each(['nano2', '', undefined as unknown as string, 'autre'])(
    '%s -> image_standard par défaut',
    (modele) => {
      expect(imageAction(modele)).toBe('image_standard');
    },
  );
});

describe('QuotaService.message (privé)', () => {
  function makeService() {
    return new QuotaService({} as never, {} as never);
  }
  const msg = (service: QuotaService, actionType: string, reason?: string, limit?: number) =>
    (service as unknown as { message(a: string, r?: string, l?: number): string }).message(actionType, reason, limit);

  it.each([
    ['no_subscription', "14 jours d'essai"],
    ['canceled', 'Réactive ton abonnement'],
    ['impaye', 'dernier prélèvement'],
    ['suspendu', 'réseaux ont été déconnectés'],
    ['expired', 'essai est terminé'],
    ['inconnue', 'Quota indisponible'],
  ])('message pour la raison %s', (reason, fragment) => {
    expect(msg(makeService(), 'post', reason)).toContain(fragment);
  });

  it('hors forfait nomme le type', () => {
    expect(msg(makeService(), 'post', 'not_in_plan')).toContain('Les posts sont inclus');
  });

  it('type réservé au Pro quand la limite est nulle', () => {
    expect(msg(makeService(), 'image_pro', 'quota', 0)).toContain("réservés à l'offre Pro");
  });

  it('quota épuisé', () => {
    expect(msg(makeService(), 'post', 'quota', 10)).toContain('tous tes posts');
  });

  it('type inconnu utilise un libellé générique', () => {
    expect(msg(makeService(), 'type-inconnu', 'not_in_plan')).toContain('générations');
  });

  it('le client ne voit jamais de symbole €', () => {
    for (const r of ['no_subscription', 'canceled', 'impaye', 'suspendu', 'expired', 'not_in_plan', 'quota']) {
      expect(msg(makeService(), 'post', r, 5)).not.toContain('€');
    }
  });
});

describe('QuotaService.ensureSubscription', () => {
  function makeService(billingReady: boolean, existingSubscription: unknown = null) {
    const findFirst = jest.fn().mockResolvedValue(existingSubscription);
    const create = jest.fn().mockResolvedValue(undefined);
    const plansFindFirst = jest.fn().mockResolvedValue({ id: 'plan-essai' });
    const prismaStub = {
      subscriptions: { findFirst, create },
      plans: { findFirst: plansFindFirst },
    } as never;
    const billingStub = { ready: billingReady } as never;
    const service = new QuotaService(prismaStub, billingStub);
    return { service, create, findFirst };
  }

  it("ne pose PAS d'essai local quand Stripe est configuré (porte dérobée fermée)", async () => {
    const { service, create } = makeService(true);
    await service.ensureSubscription('u1');
    expect(create).not.toHaveBeenCalled();
  });

  it("pose un essai local quand Stripe n'est PAS configuré (filet de dev)", async () => {
    const { service, create } = makeService(false);
    await service.ensureSubscription('u1');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ data: { user_id: 'u1', status: 'trialing' } });
  });

  it('ne touche jamais un compte qui a déjà un abonnement, Stripe configuré ou non', async () => {
    for (const ready of [true, false]) {
      const { service, create } = makeService(ready, { id: 'existing' });
      await service.ensureSubscription('u1');
      expect(create).not.toHaveBeenCalled();
    }
  });
});

describe('QuotaService.consume', () => {
  function makeService(queryRawResult: Record<string, unknown> = { ok: true, subscription_id: 's1' }) {
    const queryRaw = jest.fn().mockResolvedValue([{ result: queryRawResult }]);
    const prismaStub = { $queryRaw: queryRaw } as never;
    const service = new QuotaService(prismaStub, {} as never);
    // Compte actif, ni en pause ni impayé, ni « boss » — état de base pour ces tests.
    jest.spyOn(service, 'ensureSubscription').mockResolvedValue(undefined);
    jest.spyOn(service, 'enPause').mockResolvedValue(null);
    jest.spyOn(service, 'statutAbonnement').mockResolvedValue('active');
    jest.spyOn(service, 'estBoss').mockResolvedValue(false);
    return { service, queryRaw };
  }

  it('consommation acceptée transmet le type et la quantité', async () => {
    const { service, queryRaw } = makeService({ ok: true, subscription_id: 's1' });
    const r = await service.consume('u1', 'post', 2);
    expect(r.ok).toBe(true);
    expect(r.action_type).toBe('post');
    expect(r.qty).toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('dépassement refusé avec le message du type', async () => {
    const { service } = makeService({ ok: false, reason: 'quota', limit: 10 });
    const r = await service.consume('u1', 'post');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('tous tes posts');
  });

  it('compte en pause refuse sans appeler la base', async () => {
    const { service, queryRaw } = makeService({ ok: true });
    jest.spyOn(service, 'enPause').mockResolvedValue(new Date());
    const r = await service.consume('u1', 'post');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pause');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['past_due', 'impaye'],
    ['suspended', 'suspendu'],
  ])('%s refuse sans appeler la base (raison %s)', async (statut, raison) => {
    const { service, queryRaw } = makeService({ ok: true });
    jest.spyOn(service, 'statutAbonnement').mockResolvedValue(statut);
    const r = await service.consume('u1', 'post');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(raison);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("le compte Boss n'est pas bloqué par l'impayé", async () => {
    const { service } = makeService({ ok: true });
    jest.spyOn(service, 'statutAbonnement').mockResolvedValue('past_due');
    jest.spyOn(service, 'estBoss').mockResolvedValue(true);
    const r = await service.consume('u1', 'post');
    expect(r.ok).toBe(true);
  });

  it('une erreur de la base renvoie un refus propre', async () => {
    const { service } = makeService();
    (service as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw = jest
      .fn()
      .mockRejectedValue(new Error('base injoignable'));
    const r = await service.consume('u1', 'post');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('error');
  });

  it('sans abonnement, la raison est affinée', async () => {
    const { service } = makeService({ ok: false, reason: 'no_subscription' });
    jest
      .spyOn(service as unknown as { raisonSansAbonnement(tg: string): Promise<{ reason: string; message: string }> }, 'raisonSansAbonnement')
      .mockResolvedValue({ reason: 'canceled', message: 'x' });
    const r = await service.consume('u1', 'post');
    expect(r.reason).toBe('canceled');
    expect(r.message).toContain('Réactive');
  });
});
