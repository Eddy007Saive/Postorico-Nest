import { ConfigService } from '@nestjs/config';
import { BillingService } from '../billing/billing.service';
import { decouperNom, GhlService, TAGS_GHL } from './ghl.service';

const config = (vals: Record<string, string>) => ({ get: (k: string) => vals[k] }) as unknown as ConfigService;

describe('decouperNom', () => {
  it('prénom puis le reste en nom', () => {
    expect(decouperNom('Jean Dupont')).toEqual({ prenom: 'Jean', nom: 'Dupont' });
    expect(decouperNom('Marie Claire de la Tour')).toEqual({ prenom: 'Marie', nom: 'Claire de la Tour' });
    expect(decouperNom('Cher')).toEqual({ prenom: 'Cher', nom: null });
    expect(decouperNom(null)).toEqual({ prenom: null, nom: null });
  });
});

describe('GhlService', () => {
  const appels: Array<{ url: string; method: string; body: unknown; auth: string; version: string }> = [];
  beforeEach(() => {
    appels.length = 0;
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      appels.push({ url, method: String(init.method), body: JSON.parse(String(init.body)), auth: h.Authorization, version: h.Version });
      const corps = url.endsWith('/contacts/upsert') ? { contact: { id: 'ct_1' } } : { tags: [] };
      return new Response(JSON.stringify(corps), { status: 200 });
    }) as never;
  });

  it('sans jeton : inactif, rien n’est envoyé', () => {
    const g = new GhlService(config({}));
    expect(g.actif()).toBe(false);
    g.taguer({ email: 'a@b.fr' }, [TAGS_GHL.actif], [], 'essai');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('upsert du contact puis ajout et retrait des tags, avec les bons en-têtes', async () => {
    const g = new GhlService(config({ 'app.ghlToken': 'jeton', 'app.ghlLocationId': 'LOC' }));
    const id = await g.appliquer({ email: 'jean@x.fr', prenom: 'Jean', nom: 'Dupont', telephone: '+33600000000' }, [TAGS_GHL.actif], [TAGS_GHL.resilie, TAGS_GHL.echec]);
    expect(id).toBe('ct_1');
    expect(appels.map((a) => `${a.method} ${a.url.replace('https://services.leadconnectorhq.com', '')}`)).toEqual([
      'POST /contacts/upsert',
      'POST /contacts/ct_1/tags',
      'DELETE /contacts/ct_1/tags',
    ]);
    expect(appels[0].body).toEqual({ locationId: 'LOC', email: 'jean@x.fr', firstName: 'Jean', lastName: 'Dupont', phone: '+33600000000' });
    expect(appels[1].body).toEqual({ tags: ['abonnement-actif'] });
    expect(appels[2].body).toEqual({ tags: ['abonnement-resilie', 'paiement-echoue'] });
    expect(appels[0].auth).toBe('Bearer jeton');
    expect(appels[0].version).toBe('2021-07-28');
  });

  it('une erreur GHL remonte (pour les nouveaux essais)', async () => {
    global.fetch = jest.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })) as never;
    const g = new GhlService(config({ 'app.ghlToken': 'jeton', 'app.ghlLocationId': 'LOC' }));
    await expect(g.appliquer({ email: 'a@b.fr' }, ['x'], [])).rejects.toThrow('401');
  });
});

describe('BillingService → tags GHL selon l’événement Stripe', () => {
  function service() {
    const ghl = { actif: () => true, taguer: jest.fn() };
    const prisma = {} as never;
    const cfg = config({});
    const s = new BillingService(prisma, {} as never, {} as never, {} as never, {} as never, cfg, ghl as never);
    const client = { id: 'cus_1', email: 'jean@x.fr', name: 'Jean Dupont', phone: null };
    return { s: s as unknown as { ghlDepuisStripe: (e: string, o: unknown) => Promise<void> }, ghl, client };
  }

  it('abonnement actif : ajoute actif, retire résilié et échec', async () => {
    const { s, ghl, client } = service();
    await s.ghlDepuisStripe('customer.subscription.created', { status: 'active', customer: client });
    expect(ghl.taguer).toHaveBeenCalledWith({ email: 'jean@x.fr', prenom: 'Jean', nom: 'Dupont', telephone: null }, ['abonnement-actif'], ['abonnement-resilie', 'paiement-echoue'], 'customer.subscription.created');
  });

  it('abonnement en essai (trialing) : rien', async () => {
    const { s, ghl, client } = service();
    await s.ghlDepuisStripe('customer.subscription.updated', { status: 'trialing', customer: client });
    expect(ghl.taguer).not.toHaveBeenCalled();
  });

  it('résiliation : ajoute résilié, retire actif', async () => {
    const { s, ghl, client } = service();
    await s.ghlDepuisStripe('customer.subscription.deleted', { status: 'canceled', customer: client });
    expect(ghl.taguer).toHaveBeenCalledWith(expect.objectContaining({ email: 'jean@x.fr' }), ['abonnement-resilie'], ['abonnement-actif'], 'customer.subscription.deleted');
  });

  it('paiement échoué puis facture payée', async () => {
    const { s, ghl } = service();
    const inv = { customer: 'cus_1', customer_email: 'jean@x.fr', customer_name: 'Jean Dupont', customer_phone: '+33611' };
    await s.ghlDepuisStripe('invoice.payment_failed', inv);
    await s.ghlDepuisStripe('invoice.paid', inv);
    expect(ghl.taguer).toHaveBeenNthCalledWith(1, { email: 'jean@x.fr', prenom: 'Jean', nom: 'Dupont', telephone: '+33611' }, ['paiement-echoue'], [], 'invoice.payment_failed');
    expect(ghl.taguer).toHaveBeenNthCalledWith(2, expect.objectContaining({ email: 'jean@x.fr' }), [], ['paiement-echoue'], 'invoice.paid');
  });

  it('autres événements (pack, rappel d’essai) : rien', async () => {
    const { s, ghl } = service();
    await s.ghlDepuisStripe('checkout.session.completed', {});
    await s.ghlDepuisStripe('customer.subscription.trial_will_end', {});
    expect(ghl.taguer).not.toHaveBeenCalled();
  });
});
