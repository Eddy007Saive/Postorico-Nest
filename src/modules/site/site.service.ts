import { Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'dns/promises';
import * as ipaddr from 'ipaddr.js';

/** Le site n'a pas pu être lu : adresse invalide, injoignable, ou vide.
 * Port direct de backend/services/site_service.py::SiteIllisible. */
export class SiteIllisible extends Error {}

/** Complète le schéma manquant et refuse tout ce qui n'est pas du web public.
 * Port direct de backend/services/site_service.py::normaliser.
 *
 * Anti-SSRF : l'adresse vient du client et la requête part de NOTRE serveur. Sans ce
 * garde-fou, un client pourrait nous faire lire le réseau interne de l'hébergeur
 * (métadonnées cloud, bases internes…). `ipaddr.js` classe une IP résolue dans une
 * plage nommée ('unicast', 'private', 'loopback', 'linkLocal', 'reserved',
 * 'carrierGradeNat', 'multicast'...) — seule 'unicast' est publique ; tout le reste est
 * refusé, ce qui couvre au moins les quatre cas exclus côté Python (is_private,
 * is_loopback, is_link_local, is_reserved) et déborde volontairement plus large. */
export async function normaliserUrl(urlInput: string): Promise<string> {
  let url = (urlInput || '').trim();
  if (!url) throw new SiteIllisible('Adresse vide.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SiteIllisible('Adresse invalide.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new SiteIllisible('Adresse invalide.');
  }

  let adresses: Array<{ address: string }>;
  try {
    adresses = await dnsLookup(parsed.hostname, { all: true });
  } catch {
    throw new SiteIllisible("Ce domaine n'existe pas.");
  }
  for (const { address } of adresses) {
    if (ipaddr.process(address).range() !== 'unicast') {
      throw new SiteIllisible("Cette adresse n'est pas publique.");
    }
  }
  return url;
}

/** Analyse d'un site client (logo, couleurs) pour préremplir la fiche de marque —
 * port de backend/services/site_service.py. Scaffold : extraction logo/couleurs à porter
 * (le garde-fou anti-SSRF, lui, est porté — voir `normaliserUrl` ci-dessus). */
@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);

  async analyserSite(url: string) {
    await normaliserUrl(url);
    // TODO: porter backend/services/site_service.py (extraction logo + couleurs dominantes
    // depuis le HTML/CSS du site, favicon en repli).
    return {
      logo: '',
      couleurPrincipale: '',
      couleurSecondaire: '',
      couleurAccent: '',
    };
  }
}