import type { Request } from 'express';
import { HttpException } from '@nestjs/common';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { AdresseRefusee, SiteIllisible } from '../site/site.service';
import { OnboardingController } from './onboarding.controller';
import { cleDomaine, GardeAnalyseSite, jourParis } from './analyse-site.garde';

// POST /onboarding/analyser-site : public, et chaque analyse réelle coûte un appel Claude.
// Turnstile, puis cache par domaine, 1 analyse / IP / 24 h, plafond global / jour.
describe('OnboardingController.analyserSite', () => {
  const req = (ip = '1.2.3.4') => ({ headers: {}, socket: { remoteAddress: ip } }) as unknown as Request;

  function build(opts: { turnstileOk?: boolean; maxJour?: number; parIp?: number } = {}) {
    const turnstile = { verify: jest.fn().mockResolvedValue(opts.turnstileOk ?? true) };
    const valeurs: Record<string, number> = {
      'app.onboardingAnalysesMaxJour': opts.maxJour ?? 100,
      'app.onboardingAnalysesParIp': opts.parIp ?? 1,
      'app.onboardingFenetreIpH': 24,
    };
    const config = { get: jest.fn((k: string) => valeurs[k]) };
    const garde = new GardeAnalyseSite(config as never);
    // « Claude » est compté via preRemplir : un appel = une analyse réelle.
    const site = {
      preRemplir: jest.fn(async (url: string) => ({
        url: `https://${cleDomaine(url)}`,
        champs: { site: `https://${cleDomaine(url)}` },
        pages_lues: [`https://${cleDomaine(url)}`],
        cout: { modele: 'claude-haiku-4-5', tokensEntree: 4000, tokensSortie: 900, dureeS: 9 },
      })),
    };
    const ctrl = new OnboardingController(
      {} as never,
      turnstile as never,
      {} as never,
      new RateLimitService(),
      config as never,
      site as never,
      garde,
    );
    return { ctrl, turnstile, site, garde };
  }

  async function statut(p: Promise<unknown>): Promise<number> {
    const e = await p.then(
      () => null,
      (x) => x,
    );
    return e instanceof HttpException ? e.getStatus() : 0;
  }

  const corps = (url: string) => ({ url, cf_turnstile_token: 't' });

  it('renvoie le pré-remplissage, sans le détail de coût', async () => {
    const { ctrl, site, turnstile } = build();
    await expect(ctrl.analyserSite(corps('x.fr'), req())).resolves.toEqual({
      url: 'https://x.fr',
      champs: { site: 'https://x.fr' },
      pages_lues: ['https://x.fr'],
    });
    expect(turnstile.verify).toHaveBeenCalledWith('t', '1.2.3.4');
    expect(site.preRemplir).toHaveBeenCalledWith('x.fr');
  });

  it('turnstile refusé → 403, sans lire le site', async () => {
    const { ctrl, site } = build({ turnstileOk: false });
    expect(await statut(ctrl.analyserSite({ url: 'x.fr', cf_turnstile_token: 'faux' }, req()))).toBe(403);
    expect(site.preRemplir).not.toHaveBeenCalled();
  });

  it('cache par domaine : deux analyses du même domaine (www, casse) = un seul appel Claude', async () => {
    const { ctrl, site } = build();
    const a = await ctrl.analyserSite(corps('https://www.Dupont.fr/'), req('1.1.1.1'));
    const b = await ctrl.analyserSite(corps('dupont.fr/contact'), req('2.2.2.2'));
    expect(b).toEqual(a);
    expect(site.preRemplir).toHaveBeenCalledTimes(1);
  });

  it('même IP, même domaine en cache : rechargement gratuit, non compté', async () => {
    const { ctrl, site } = build();
    for (let i = 0; i < 4; i++) await ctrl.analyserSite(corps('dupont.fr'), req());
    expect(site.preRemplir).toHaveBeenCalledTimes(1);
  });

  it('même IP, autre domaine dans les 24 h → 429 avec le message attendu', async () => {
    const { ctrl, site } = build();
    await ctrl.analyserSite(corps('dupont.fr'), req());
    const e = await ctrl.analyserSite(corps('martin.fr'), req()).catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(429);
    expect(e.message).toBe('Tu as déjà analysé un site : continue le questionnaire, tes réponses sont gardées.');
    expect(site.preRemplir).toHaveBeenCalledTimes(1);
  });

  it("un domaine en cache servi à une nouvelle IP compte pour cette IP", async () => {
    const { ctrl } = build();
    await ctrl.analyserSite(corps('dupont.fr'), req('1.1.1.1'));
    await ctrl.analyserSite(corps('dupont.fr'), req('2.2.2.2')); // depuis le cache
    expect(await statut(ctrl.analyserSite(corps('martin.fr'), req('2.2.2.2')))).toBe(429);
  });

  it('la fenêtre par IP expire après 24 h (et la limite est réglable)', async () => {
    const { ctrl, garde, site } = build({ parIp: 2 });
    let t = Date.UTC(2026, 9, 20, 8);
    garde.maintenant = () => t;
    await ctrl.analyserSite(corps('a.fr'), req());
    await ctrl.analyserSite(corps('b.fr'), req());
    expect(await statut(ctrl.analyserSite(corps('c.fr'), req()))).toBe(429);
    t += 24 * 3600 * 1000 + 1;
    await ctrl.analyserSite(corps('c.fr'), req());
    expect(site.preRemplir).toHaveBeenCalledTimes(3);
  });

  it('plafond global atteint → 503 ; le cache reste servi', async () => {
    const { ctrl, site } = build({ maxJour: 2 });
    await ctrl.analyserSite(corps('a.fr'), req('1.1.1.1'));
    await ctrl.analyserSite(corps('b.fr'), req('2.2.2.2'));
    const e = await ctrl.analyserSite(corps('c.fr'), req('3.3.3.3')).catch((x) => x);
    expect(e.getStatus()).toBe(503);
    expect(e.message).toBe(
      "L'analyse automatique est très demandée aujourd'hui : remplis le questionnaire à la main, ça va vite.",
    );
    await expect(ctrl.analyserSite(corps('a.fr'), req('4.4.4.4'))).resolves.toMatchObject({ url: 'https://a.fr' });
    expect(site.preRemplir).toHaveBeenCalledTimes(2);
  });

  it('le plafond global repart à zéro le lendemain (Europe/Paris)', async () => {
    const { ctrl, garde } = build({ maxJour: 1 });
    let t = Date.UTC(2026, 9, 20, 21, 30); // 23 h 30 à Paris
    garde.maintenant = () => t;
    await ctrl.analyserSite(corps('a.fr'), req('1.1.1.1'));
    expect(await statut(ctrl.analyserSite(corps('b.fr'), req('2.2.2.2')))).toBe(503);
    t = Date.UTC(2026, 9, 20, 22, 30); // 0 h 30 à Paris, le 21
    expect(jourParis(t)).toBe('2026-10-21');
    await expect(ctrl.analyserSite(corps('b.fr'), req('2.2.2.2'))).resolves.toBeTruthy();
  });

  it('url manquante ou invalide → 400', async () => {
    const { ctrl } = build();
    expect(await statut(ctrl.analyserSite(corps('  '), req()))).toBe(400);
    expect(await statut(ctrl.analyserSite(corps('javascript:alert(1)'), req()))).toBe(400);
  });

  it('adresse non publique → 400, site illisible → 422, et rien n\'est décompté', async () => {
    const { ctrl, site } = build({ maxJour: 1 });
    site.preRemplir.mockRejectedValueOnce(new AdresseRefusee("Cette adresse n'est pas publique."));
    expect(await statut(ctrl.analyserSite(corps('interne.fr'), req()))).toBe(400);
    site.preRemplir.mockRejectedValueOnce(new SiteIllisible('vide'));
    expect(await statut(ctrl.analyserSite(corps('vide.fr'), req()))).toBe(422);
    // Ni l'IP ni le plafond (1/jour) n'ont été consommés : une vraie analyse passe encore.
    await expect(ctrl.analyserSite(corps('x.fr'), req())).resolves.toMatchObject({ url: 'https://x.fr' });
  });
});

describe('GardeAnalyseSite — cache', () => {
  it('expire après 7 jours et évince les plus anciennes au-delà de 500', () => {
    const garde = new GardeAnalyseSite({ get: () => undefined } as never);
    let t = 0;
    garde.maintenant = () => t;
    const r = { url: 'u', champs: {}, pages_lues: [] };
    for (let i = 0; i < 501; i++) garde.mettreEnCache(`d${i}.fr`, r);
    expect(garde.lireCache('d0.fr')).toBeNull();
    expect(garde.lireCache('d1.fr')).toBe(r);
    t = 7 * 24 * 3600 * 1000;
    expect(garde.lireCache('d1.fr')).toBeNull();
  });
});
