import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';

// Port direct de backend/tests/test_webhooks.py (section Stripe). `dejaTraite` est simulé
// à `true` pour isoler la vérification de signature de toute la logique métier par type
// d'événement (applyPack, applySubscription...), hors périmètre de ce fichier — exactement
// comme le fait la fixture Python `stripe_configure` en simulant `_deja_traite`.
const SECRET_STRIPE = 'whsec_secret_de_test';

function enteteStripe(corps: Buffer, secret = SECRET_STRIPE, horodatage?: number): string {
  const t = Math.floor(horodatage ?? Date.now() / 1000);
  const signe = Buffer.concat([Buffer.from(`${t}.`), corps]);
  const v1 = createHmac('sha256', secret).update(signe).digest('hex');
  return `t=${t},v1=${v1}`;
}

function evenement(type = 'invoice.paid', id = 'evt_1'): Buffer {
  return Buffer.from(JSON.stringify({ id, object: 'event', type, data: { object: {} } }));
}

function makeService(opts: { secretConfigured?: boolean; webhookSecret?: string } = {}) {
  const { secretConfigured = true, webhookSecret = SECRET_STRIPE } = opts;
  const configStub = {
    get: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        'app.stripeSecretKey': secretConfigured ? 'sk_test_fake' : '',
        'app.stripeWebhookSecret': webhookSecret,
        'app.frontendUrl': 'http://localhost:3000',
        'app.stripeAutoTax': true,
        'app.packDelaiJours': 14,
      };
      return map[key] ?? '';
    }),
  } as unknown as ConfigService;
  const prismaStub = {} as never;
  const impayeStub = {} as never;
  const demarrageStub = { oublier: jest.fn() } as never;
  const notificationStub = {} as never;
  const affiliationStub = {} as never;
  const service = new BillingService(prismaStub, impayeStub, demarrageStub, notificationStub, affiliationStub, configStub);
  jest.spyOn(service as unknown as { dejaTraite(id?: string, t?: string): Promise<boolean> }, 'dejaTraite').mockResolvedValue(true);
  return service;
}

describe('BillingService.handleWebhook (signature Stripe)', () => {
  it('signature valide acceptée', async () => {
    const service = makeService();
    const corps = evenement();
    const r = await service.handleWebhook(corps, enteteStripe(corps));
    expect(r).toEqual({ ok: true, event: 'invoice.paid', duplicate: true });
  });

  it('mauvaise signature rejetée', async () => {
    const service = makeService();
    const corps = evenement();
    const r = await service.handleWebhook(corps, enteteStripe(corps, 'autre_secret'));
    expect(r).toEqual({ ok: false, error: 'bad signature' });
  });

  it('corps modifié après signature rejeté', async () => {
    const service = makeService();
    const original = evenement();
    const entete = enteteStripe(original);
    const falsifie = evenement('checkout.session.completed');
    const r = await service.handleWebhook(falsifie, entete);
    expect(r.ok).toBe(false);
  });

  it('signature trop ancienne rejetée', async () => {
    const service = makeService();
    const corps = evenement();
    const entete = enteteStripe(corps, SECRET_STRIPE, Date.now() / 1000 - 3600);
    const r = await service.handleWebhook(corps, entete);
    expect(r.ok).toBe(false);
  });

  it('en-tête absent rejeté', async () => {
    const service = makeService();
    const r = await service.handleWebhook(evenement(), '');
    expect(r.ok).toBe(false);
  });

  it('sans secret configuré refuse tout (échec fermé)', async () => {
    const service = makeService({ webhookSecret: '' });
    const corps = evenement();
    const r = await service.handleWebhook(corps, enteteStripe(corps, ''));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('non configuré');
  });

  it('Stripe désactivé (pas de clé) refuse', async () => {
    const service = makeService({ secretConfigured: false });
    const r = await service.handleWebhook(evenement(), 'x');
    expect(r).toEqual({ ok: false });
  });
});
