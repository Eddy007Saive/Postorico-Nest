/**
 * Gabarits de post (feed cohérent) — port direct des 13 fonctions `_g_*` +
 * leurs aides (backend/services/gabarit_service.py). HTML brandé FIXE ; seuls le
 * TEXTE et la PHOTO/fond changent (slots).
 */

export interface TitleLine {
  t: string;
  c?: 'a' | 'v';
}

export interface Brand {
  accent: string;
  accent2: string;
  bg: string;
  logo?: string | null;
  nom: string;
}

// Un gabarit reçoit un sac de champs libres (dépend du gabarit) — mêmes clés que côté
// Python (slots: dict). Pas d'interface stricte unique : chaque builder ne lit que ce qui le concerne.
export type Slots = Record<string, unknown>;

export const GAB_W = 600;
export const GAB_H = 600;
export const DSF = 1.8; // 600×600 logique * 1.8 = 1080×1080 (Instagram carré)

export const GAB_LABELS: Record<string, string> = {
  statement: 'Accroche',
  split: 'Texte + photo',
  acquisition: 'Acquisition',
  citation: 'Citation',
  dashboard: 'Tableau de bord',
  features: 'Fonctionnalités',
  phone: 'Conversation',
  services: 'Services',
  mission: 'Mission',
  integrations: 'Intégrations',
  testimonial: 'Avis client',
  people: 'Humain',
  closing: 'Signature',
};
export const GABARITS = Object.keys(GAB_LABELS);

// Gabarits qui possèdent une ZONE PHOTO (rendent slots.bg_image). Les autres ignorent la photo.
export const PHOTO_GABARITS = ['statement', 'split', 'citation', 'mission', 'testimonial', 'people'];

const ICONS: Record<string, string> = {
  star: '<path d="M12 3l1.9 5.8L20 10l-5.1 3.7L16 20l-4-3.6L8 20l1.1-6.3L4 10l6.1-1.2z"/>',
  pulse: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  bars: '<path d="M4 19V5m6 14V9m6 10V3"/>',
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
};
const FEAT_ICONS = ['star', 'pulse', 'bars'];

function esc(t: unknown): string {
  return String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function titleHtml(lines: unknown): string {
  const arr = Array.isArray(lines) ? lines : [];
  return arr
    .map((lnRaw) => {
      const ln: TitleLine = typeof lnRaw === 'string' ? { t: lnRaw } : (lnRaw as TitleLine);
      const cls = ln?.c;
      return cls === 'a' || cls === 'v' ? `<span class="${cls}">${esc(ln.t)}</span>` : esc(ln?.t);
    })
    .join('<br>');
}

function icon(key?: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke-width="2">${ICONS[key || ''] ?? ICONS.star}</svg>`;
}

function css(b: Brand): string {
  const a = b.accent;
  const a2 = b.accent2;
  return `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;font-family:Inter,sans-serif}
.frame{position:relative;width:${GAB_W}px;height:${GAB_H}px;color:#fff;padding:48px;display:flex;flex-direction:column;overflow:hidden;
  background:radial-gradient(120% 90% at 80% 0%, ${a}33, transparent 55%),radial-gradient(90% 70% at 0% 100%, ${a}1a, transparent 60%), ${b.bg};}
.top{display:flex;align-items:center;justify-content:space-between;position:relative;z-index:2}
.eyebrow{font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:#9aa0b5;font-weight:600;text-shadow:0 2px 10px rgba(0,0,0,.4)}
.label{display:inline-block;background:${a}26;border:1px solid ${a}4d;color:#fff;font-size:11px;font-weight:700;padding:5px 11px;border-radius:999px;backdrop-filter:blur(4px)}
.logo{display:flex;align-items:center;gap:9px}
.logo .g{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-family:Sora;font-weight:800;font-size:17px;color:#fff;background:radial-gradient(circle at 35% 30%, #ffffff66, ${a} 60%);box-shadow:0 0 22px ${a}b3;overflow:hidden}
.logo .g img{width:100%;height:100%;object-fit:cover}
.logo b{font-family:Sora;font-weight:800;font-size:15px;letter-spacing:-.01em;text-shadow:0 2px 10px rgba(0,0,0,.4)}
.spacer{flex:1}
.h{font-family:Sora;font-weight:800;letter-spacing:-.02em;line-height:1.05;position:relative;z-index:2;text-shadow:0 4px 22px rgba(0,0,0,.4)}
.h .a{color:${a2}} .h .v{color:${a}}
.sub{color:#9aa0b5;font-size:16px;line-height:1.55;position:relative;z-index:2;max-width:92%;text-shadow:0 2px 12px rgba(0,0,0,.5)}
.photo{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center}
.photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,7,14,.25),rgba(7,7,14,.92))}
.orb{position:absolute;width:230px;height:230px;border-radius:50%;right:-30px;top:90px;background:radial-gradient(circle at 38% 32%, #ffffffcc, ${a} 55%, #1c1340 82%);box-shadow:0 0 90px ${a}99;display:grid;place-items:center;z-index:1}
.orb b{font-family:Sora;font-weight:800;font-size:96px;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.4)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;position:relative;z-index:2}
.stat{background:#101020cc;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px 14px}
.stat .k{font-size:11px;color:#5a5f74;text-transform:uppercase;letter-spacing:.08em}
.stat .n{font-family:Sora;font-weight:800;font-size:26px;margin-top:8px}
.stat .n.v{color:${a}}
.big{display:grid;grid-template-columns:1fr 1fr;gap:14px;position:relative;z-index:2}
.bigc{background:#101020cc;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:22px}
.bigc .k{font-size:13px;color:#9aa0b5}
.bigc .n{font-family:Sora;font-weight:800;font-size:36px;margin-top:6px}
.bigc .n.v{color:${a}}
.bars{display:flex;align-items:flex-end;gap:7px;height:56px;margin-top:14px}
.bars i{flex:1;border-radius:4px 4px 0 0;background:linear-gradient(180deg,${a},${a}40)}
.feat{display:flex;flex-direction:column;gap:14px;position:relative;z-index:2}
.fi{display:flex;align-items:center;gap:14px}
.fi .ic{width:42px;height:42px;border-radius:11px;background:${a}24;border:1px solid ${a}4d;display:grid;place-items:center;flex-shrink:0}
.fi .ic svg{width:20px;height:20px;stroke:${a}}
.fi .t{font-size:16.5px;font-weight:600}
.fi .d{font-size:13px;color:#9aa0b5}
.quote{font-family:Sora;font-weight:700;font-size:30px;line-height:1.25;position:relative;z-index:2;text-shadow:0 3px 18px rgba(0,0,0,.5)}
.who{display:flex;align-items:center;gap:12px;position:relative;z-index:2;margin-top:22px}
.who .av{width:46px;height:46px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.2);background:#222}
.who .nm{font-weight:700;font-size:15px}
.who .rl{color:#9aa0b5;font-size:12.5px}
.row{display:flex;gap:22px;align-items:center;position:relative;z-index:2}
.phone{width:186px;height:372px;border-radius:30px;border:7px solid #1c1c2c;background:#0c0c18;flex-shrink:0;padding:16px 12px 12px;box-shadow:0 20px 60px ${a}4d;overflow:hidden}
.phone .notch{width:58px;height:6px;background:#1c1c2c;border-radius:3px;margin:0 auto 16px}
.bubble{max-width:82%;padding:9px 12px;border-radius:13px;font-size:11.5px;margin-bottom:9px;line-height:1.3}
.bubble.in{background:#1a1a2c;color:#cfd3e6;border-bottom-left-radius:4px}
.bubble.out{background:${a};color:#fff;margin-left:auto;border-bottom-right-radius:4px}
.logos{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;position:relative;z-index:2}
.logos .lg{background:#101020cc;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 10px;text-align:center;font-weight:700;font-size:13.5px;color:#cfd3e6}
.svc{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;position:relative;z-index:2}
.svc .s{display:flex;align-items:center;gap:10px;background:#101020cc;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:13px 14px;font-size:14px;font-weight:600}
.svc .s .d{width:9px;height:9px;border-radius:50%;background:${a};flex-shrink:0}
.flow{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#101020cc;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px 14px;position:relative;z-index:2;margin-top:14px}
.flow .step{font-size:12px;color:#9aa0b5;text-align:center;flex:1}
.flow .gmini{width:38px;height:38px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffffff66,${a} 60%);display:grid;place-items:center;font-family:Sora;font-weight:800;color:#fff;box-shadow:0 0 18px ${a}99;flex-shrink:0}
.flow .arr{color:#5a5f74;font-size:18px}
.stars{color:#ffb020;font-size:22px;letter-spacing:4px;position:relative;z-index:2}
.statrow{display:flex;gap:10px;position:relative;z-index:2}
.statrow .si{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 8px;text-align:center}
.statrow .si .n{font-family:Sora;font-weight:800;font-size:22px;color:${a}}
.statrow .si .k{font-size:10px;color:#9aa0b5;margin-top:3px}
.thumb{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,#2a2440,#14121f);border:1px solid rgba(255,255,255,.08);display:grid;place-items:center;flex-shrink:0}
.thumb svg{width:20px;height:20px;stroke:${a}}
`;
}

function logoMark(b: Brand): string {
  if (b.logo) return `<span class="g"><img src="${esc(b.logo)}" alt=""></span>`;
  return `<span class="g">${esc((b.nom || 'G')[0].toUpperCase())}</span>`;
}

function brandbar(b: Brand, options: { eyebrow?: string; label?: string } = {}): string {
  const left = options.label
    ? `<span class="label">${esc(options.label)}</span>`
    : options.eyebrow
      ? `<span class="eyebrow">${esc(options.eyebrow)}</span>`
      : '<span></span>';
  return `<div class="top">${left}<span class="logo">${logoMark(b)}<b>${esc(b.nom || '')}</b></span></div>`;
}

function photo(s: Slots): string {
  const img = s.bg_image as string | undefined;
  return img ? `<div class="photo" style="background-image:url('${esc(img)}')"></div>` : '';
}

function G(b: Brand): string {
  return esc((b.nom || 'G')[0].toUpperCase());
}

const GRAD = '<div class="photo" style="background-image:linear-gradient(160deg,#241a44,#0a0a16)"></div>';

function sub(text: unknown, style = ''): string {
  if (!text) return '';
  const st = style ? ` style="${style}"` : '';
  return `<p class="sub"${st}>${esc(text)}</p>`;
}

// --------------------------------------------------------------------------- builders
function gStatement(s: Slots, b: Brand): string {
  const eb = (s.eyebrow as string) || 'Vision';
  const orb = s.bg_image ? '' : `<div class="orb"><b>${G(b)}</b></div>`;
  return (
    `${photo(s)}${brandbar(b, { eyebrow: eb })}${orb}` +
    '<div class="spacer"></div>' +
    `<div class="h" style="font-size:52px">${titleHtml(s.title_lines)}</div>` +
    sub(s.subtitle, 'margin-top:18px')
  );
}

function gSplit(s: Slots, b: Brand): string {
  const img = s.bg_image as string | undefined;
  const bgimg = img ? `url('${esc(img)}')` : 'linear-gradient(160deg,#241a44,#0a0a16)';
  const photoBlock =
    `<div style="position:absolute;top:0;right:0;bottom:0;width:54%;z-index:0;` +
    `background-image:${bgimg};background-size:cover;background-position:center"></div>` +
    `<div style="position:absolute;inset:0;z-index:1;` +
    `background:linear-gradient(90deg,${b.bg} 0%,${b.bg} 40%,${b.bg}00 74%)"></div>`;
  return (
    `${photoBlock}${brandbar(b, { eyebrow: (s.eyebrow as string) || '' })}` +
    '<div class="spacer"></div>' +
    `<div class="h" style="font-size:44px;max-width:60%">${titleHtml(s.title_lines)}</div>` +
    sub(s.subtitle, 'max-width:54%;margin-top:14px')
  );
}

function gAcquisition(s: Slots, b: Brand): string {
  const stats = ((s.stats as Array<Record<string, unknown>>) || []).slice(0, 4);
  const cells = stats
    .map((x) => `<div class="stat"><div class="k">${esc(x.k)}</div><div class="n${x.v ? ' v' : ''}">${esc(x.n)}</div></div>`)
    .join('');
  return (
    `${brandbar(b, { eyebrow: (s.eyebrow as string) || 'Acquisition' })}` +
    `<div class="h" style="margin-top:26px;font-size:40px">${titleHtml(s.title_lines)}</div>` +
    `<div class="spacer"></div><div class="stats">${cells}</div>`
  );
}

function gCitation(s: Slots, b: Brand): string {
  const au = (s.author as Record<string, unknown>) || {};
  const av = au.photo ? `<img class="av" src="${esc(au.photo)}">` : '<span class="av"></span>';
  return (
    `${photo(s)}${brandbar(b, { label: (s.label as string) || 'Témoignage' })}` +
    '<div class="spacer"></div>' +
    `<div class="quote">« ${titleHtml(s.quote_lines)} »</div>` +
    `<div class="who">${av}<div><div class="nm">${esc(au.name)}</div><div class="rl">${esc(au.role)}</div></div></div>`
  );
}

function gDashboard(s: Slots, b: Brand): string {
  const card = (c: Record<string, unknown>): string => {
    const bars = ((c.bars as number[]) || [40, 60, 50, 80, 65, 100])
      .map((h) => `<i style="height:${Math.trunc(h)}%"></i>`)
      .join('');
    return (
      `<div class="bigc"><div class="k">${esc(c.k)}</div>` +
      `<div class="n${c.v ? ' v' : ''}">${esc(c.n)}</div><div class="bars">${bars}</div></div>`
    );
  };
  const cards = ((s.big as Array<Record<string, unknown>>) || []).slice(0, 2).map(card).join('');
  return (
    `${brandbar(b, { eyebrow: (s.eyebrow as string) || 'Vos données' })}` +
    `<div class="h" style="margin-top:22px;font-size:36px">${titleHtml(s.title_lines)}</div>` +
    `<div class="spacer"></div><div class="big">${cards}</div>`
  );
}

function gFeatures(s: Slots, b: Brand): string {
  const eb = (s.eyebrow as string) || "Boosté par l'IA";
  const feats = ((s.features as Array<Record<string, unknown>>) || []).slice(0, 3);
  const rows = feats
    .map(
      (f, i) =>
        `<div class="fi"><span class="ic">${icon(FEAT_ICONS[i % FEAT_ICONS.length])}</span>` +
        `<div><div class="t">${esc(f.t)}</div><div class="d">${esc(f.d)}</div></div></div>`,
    )
    .join('');
  return (
    `${brandbar(b, { eyebrow: eb })}` +
    `<div class="h" style="margin-top:22px;font-size:34px">${titleHtml(s.title_lines)}</div>` +
    `<div class="spacer"></div><div class="feat">${rows}</div>`
  );
}

function gPhone(s: Slots, b: Brand): string {
  const eb = (s.eyebrow as string) || 'Réponse client';
  const bub = ((s.bubbles as Array<Record<string, unknown>>) || [])
    .map((x) => `<div class="bubble ${x.side === 'out' ? 'out' : 'in'}">${esc(x.t)}</div>`)
    .join('');
  return (
    `${brandbar(b, { eyebrow: eb })}` +
    '<div class="row" style="margin-top:24px">' +
    `<div><div class="h" style="font-size:46px">${titleHtml(s.title_lines)}</div>` +
    sub(s.subtitle, 'margin-top:14px;max-width:100%') +
    `</div><div class="phone"><div class="notch"></div>${bub}</div></div>`
  );
}

function gServices(s: Slots, b: Brand): string {
  const cells = ((s.services as string[]) || []).slice(0, 4).map((x) => `<div class="s"><span class="d"></span>${esc(x)}</div>`).join('');
  const fl = (s.flow as string[]) || ['Réservation', 'Action déclenchée'];
  return (
    `${brandbar(b, { eyebrow: (s.eyebrow as string) || 'Délégation' })}` +
    `<div class="h" style="margin-top:22px;font-size:38px">${titleHtml(s.title_lines)}</div>` +
    `<div class="spacer"></div><div class="svc">${cells}</div>` +
    `<div class="flow"><div class="step">${esc(fl[0])}</div><span class="arr">→</span>` +
    `<div class="gmini">${G(b)}</div><span class="arr">→</span>` +
    `<div class="step">${esc(fl[fl.length - 1])}</div></div>`
  );
}

function gMission(s: Slots, b: Brand): string {
  const cells = ((s.statrow as Array<Record<string, unknown>>) || [])
    .slice(0, 4)
    .map((x) => `<div class="si"><div class="n">${esc(x.n)}</div><div class="k">${esc(x.k)}</div></div>`)
    .join('');
  const photoBlock = photo(s) || GRAD;
  const subBlock = sub(s.subtitle, 'margin:14px 0 18px') || '<div style="height:18px"></div>';
  return (
    `${photoBlock}${brandbar(b, { label: (s.label as string) || 'Notre mission' })}` +
    '<div class="spacer"></div>' +
    `<div class="h" style="font-size:38px">${titleHtml(s.title_lines)}</div>` +
    `${subBlock}<div class="statrow">${cells}</div>`
  );
}

function gIntegrations(s: Slots, b: Brand): string {
  const eb = (s.eyebrow as string) || 'Intégrations natives';
  const lg = ((s.logos as string[]) || []).slice(0, 6).map((x) => `<div class="lg">${esc(x)}</div>`).join('');
  return (
    `${brandbar(b, { eyebrow: eb })}` +
    `<div class="h" style="margin-top:22px;font-size:36px">${titleHtml(s.title_lines)}</div>` +
    `<div class="spacer"></div><div class="logos">${lg}</div>` +
    sub(s.subtitle, 'margin-top:16px')
  );
}

function gTestimonial(s: Slots, b: Brand): string {
  const au = (s.author as Record<string, unknown>) || {};
  const n = Number(s.stars) || 5;
  const stars = '★'.repeat(Math.max(1, Math.min(5, n)));
  return (
    `${photo(s)}${brandbar(b, { label: (s.label as string) || 'Nos clients' })}` +
    `<div class="spacer"></div><div class="stars">${stars}</div>` +
    `<div class="quote" style="font-size:26px;margin-top:16px">« ${titleHtml(s.quote_lines)} »</div>` +
    `<div class="who"><span class="thumb">${icon('home')}</span>` +
    `<div><div class="nm">${esc(au.name)}</div><div class="rl">${esc(au.role)}</div></div></div>`
  );
}

function gPeople(s: Slots, b: Brand): string {
  const eb = (s.eyebrow as string) || "L'équipe";
  const photoBlock = photo(s) || GRAD;
  return (
    `${photoBlock}${brandbar(b, { eyebrow: eb })}` +
    '<div class="spacer"></div>' +
    `<div class="h" style="font-size:40px">${titleHtml(s.title_lines)}</div>` +
    sub(s.subtitle, 'margin-top:14px')
  );
}

function gClosing(s: Slots, b: Brand): string {
  return (
    `<div class="orb" style="position:relative;right:auto;top:auto;margin:0 auto 30px"><b>${G(b)}</b></div>` +
    `<div class="h" style="font-size:42px">${titleHtml(s.title_lines)}</div>` +
    sub(s.subtitle, 'margin-top:16px;text-align:center;max-width:82%')
  );
}

export const BUILDERS: Record<string, (s: Slots, b: Brand) => string> = {
  statement: gStatement,
  split: gSplit,
  acquisition: gAcquisition,
  citation: gCitation,
  dashboard: gDashboard,
  features: gFeatures,
  phone: gPhone,
  services: gServices,
  mission: gMission,
  integrations: gIntegrations,
  testimonial: gTestimonial,
  people: gPeople,
  closing: gClosing,
};

// Contenu d'exemple pour les vignettes d'aperçu (placeholder par gabarit) — sert aussi de
// BASE aux slots composés par l'IA (composer_gabarit reste dessus, structure toujours rendable).
export const SAMPLES: Record<string, Slots> = {
  statement: {
    eyebrow: 'Vision',
    title_lines: [{ t: 'MOINS' }, { t: 'DE STRESS.' }, { t: 'PLUS DE', c: 'a' }, { t: 'RÉSULTATS.', c: 'a' }],
    subtitle: "On automatise ce qui te prend du temps.",
  },
  split: {
    eyebrow: 'Plus de clients',
    title_lines: [{ t: "C'EST PAS" }, { t: 'PLUS GRAND,' }, { t: 'C\'EST PLUS LOURD.', c: 'a' }],
    subtitle: 'La traction, pas la taille.',
  },
  acquisition: {
    eyebrow: 'Acquisition',
    title_lines: [{ t: 'TON MOTEUR' }, { t: "D'ACQUISITION." }, { t: 'CONNECTÉ. PILOTÉ.', c: 'v' }],
    stats: [
      { k: 'Leads', n: '2 782', v: true },
      { k: 'CA', n: '18,4k€' },
      { k: 'Conv.', n: '7,6%', v: true },
      { k: 'RDV', n: '212' },
    ],
  },
  citation: {
    label: 'Témoignage',
    quote_lines: [{ t: 'Libère-toi de' }, { t: "l'opérationnel." }, { t: "Construis l'essentiel.", c: 'v' }],
    author: { name: 'Martin K.', role: 'Fondateur' },
  },
  dashboard: {
    eyebrow: 'Vos données',
    title_lines: [{ t: 'VOTRE ACTIVITÉ.' }, { t: 'VOS DONNÉES.' }, { t: 'VOTRE CONTRÔLE.', c: 'v' }],
    big: [
      { k: 'CA du mois', n: '128 580 €', bars: [40, 60, 50, 80, 65, 100] },
      { k: 'Occupation', n: '72%', v: true, bars: [55, 70, 62, 85, 74, 90] },
    ],
  },
  features: {
    eyebrow: "Boosté par l'IA",
    title_lines: [{ t: "L'INTELLIGENCE" }, { t: 'AU SERVICE DE' }, { t: 'VOTRE PERFORMANCE.', c: 'a' }],
    features: [
      { t: 'Tarification dynamique', d: 'Optimise tes prix en temps réel.' },
      { t: "Détection d'anomalies", d: 'Alertes avant que ça dérape.' },
      { t: 'Suivi de performance', d: 'Tes vrais chiffres, en clair.' },
    ],
  },
  phone: {
    eyebrow: 'Réponse client',
    title_lines: [{ t: '24/7.' }, { t: 'AUTOMATISÉE.', c: 'v' }],
    subtitle: 'Réponses instantanées, jour et nuit.',
    bubbles: [
      { side: 'in', t: 'Bonjour, à quelle heure le check-in ?' },
      { side: 'out', t: 'Bonjour 👋 Check-in dès 16h.' },
      { side: 'in', t: 'Parfait, merci !' },
      { side: 'out', t: 'Avec plaisir ✨' },
    ],
  },
  services: {
    eyebrow: 'Délégation',
    title_lines: [{ t: 'LA BONNE PERSONNE.' }, { t: 'AU BON MOMENT.', c: 'a' }],
    services: ['Ménage', 'Maintenance', 'Check-in', 'Linge'],
    flow: ['Réservation', 'Action déclenchée'],
  },
  mission: {
    label: 'Notre mission',
    title_lines: [{ t: 'AIDER LES PROS' }, { t: 'À PASSER UN CAP.', c: 'v' }],
    subtitle: "Moins d'outils. Plus de croissance.",
    statrow: [
      { n: '+300', k: 'clients' },
      { n: '+2k', k: 'biens' },
      { n: '98%', k: 'satisfaction' },
      { n: '24/7', k: 'support' },
    ],
  },
  integrations: {
    eyebrow: 'Intégrations natives',
    title_lines: [{ t: 'TOUT EST CONNECTÉ.' }, { t: 'TOUT EST SYNCHRONISÉ.', c: 'v' }],
    logos: ['Airbnb', 'Booking.com', 'Stripe', 'WhatsApp', 'Smoobu', 'Google'],
    subtitle: 'Plus d\'intégrations, moins de friction.',
  },
  testimonial: {
    label: 'Nos clients',
    stars: 5,
    quote_lines: [{ t: 'Un temps fou gagné, et notre CA a augmenté de 20%.' }],
    author: { name: 'Julien M.', role: 'Conciergerie Bleue · Annecy' },
  },
  people: {
    eyebrow: "L'équipe",
    title_lines: [{ t: 'DES HUMAINS.' }, { t: 'VRAI SERVICE.' }, { t: 'VRAIE DIFFÉRENCE.', c: 'a' }],
    subtitle: "Une équipe qui gère comme si c'était à elle.",
  },
  closing: {
    title_lines: [{ t: 'CHAQUE JOUR,' }, { t: 'ON BOSSE POUR VOUS.', c: 'v' }],
    subtitle: 'Ton outil avance pendant que tu te concentres sur ton métier.',
  },
};

export function buildHtml(gabarit: string, slots: Slots, brand: Brand): string {
  const fn = BUILDERS[gabarit] ?? gStatement;
  const inner = fn(slots, brand);
  return (
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    `<style>${css(brand)}</style></head><body><div class="frame">${inner}</div></body></html>`
  );
}
