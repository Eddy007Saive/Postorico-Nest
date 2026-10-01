import { nettoyerProfond } from '../../common/utils/texte-genere.util';
import { ICON_HINTS } from './carrousel-texte.service';
import { CarrouselContent, CarrouselSlide } from './interfaces/carrousel-content.interface';

/**
 * Slides d'un carrousel RETOUCHÉES À LA MAIN par le client (retouche avant validation) —
 * port de `agent_service.normaliser_carrousel_data` (2026-10-01). Même forme que la
 * rédaction IA (hook, legende, slides[titre, texte, pills, pro_tip, icon, chiffre],
 * cta{titre, texte}), longueurs bornées, filet anti-Markdown, et l'icône de chaque slide
 * reprise de l'ancienne version si la nouvelle est absente ou inconnue (non éditable).
 * Un `nouveau` inexploitable renvoie `ancien` tel quel.
 */
export function normaliserCarrouselData(nouveau: unknown, ancien: CarrouselContent): CarrouselContent {
  if (!nouveau || typeof nouveau !== 'object' || Array.isArray(nouveau)) return ancien;
  const n = nouveau as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v : '').trim().slice(0, max);
  const anciennes = Array.isArray(ancien.slides) ? ancien.slides : [];
  const slides: CarrouselSlide[] = [];
  const brutes = Array.isArray(n.slides) ? n.slides.slice(0, 10) : [];
  brutes.forEach((sl, i) => {
    if (!sl || typeof sl !== 'object') return;
    const o = sl as Record<string, unknown>;
    const prev = anciennes[i] ?? ({} as Partial<CarrouselSlide>);
    let pillsBrutes: unknown[] = [];
    if (typeof o.pills === 'string') pillsBrutes = o.pills.split(',');
    else if (Array.isArray(o.pills)) pillsBrutes = o.pills;
    const pills = pillsBrutes.map((p) => s(p, 40)).filter(Boolean).slice(0, 4);
    let icon = (typeof o.icon === 'string' ? o.icon : '').trim().toLowerCase();
    if (!(icon in ICON_HINTS)) icon = prev.icon || '';
    const slide = {
      titre: s(o.titre, 90),
      texte: s(o.texte, 400),
      pills,
      pro_tip: s(o.pro_tip, 200),
      icon,
      chiffre: s(o.chiffre, 20),
    } as CarrouselSlide & { chiffre: string };
    if (slide.titre || slide.texte) slides.push(slide);
  });
  if (!slides.length) return ancien;
  const cta = (n.cta && typeof n.cta === 'object' ? n.cta : {}) as Record<string, unknown>;
  const ancienCta = ancien.cta ?? { titre: '', texte: '' };
  const data: CarrouselContent = {
    hook: s(n.hook, 140) || s(ancien.hook, 140),
    legende: s(n.legende, 2000) || s(ancien.legende, 2000),
    slides,
    cta: {
      titre: s(cta.titre, 80) || s(ancienCta.titre, 80) || 'On en parle ?',
      texte: s(cta.texte, 200),
    },
  };
  return nettoyerProfond(data);
}
