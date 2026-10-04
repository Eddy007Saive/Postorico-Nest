/* eslint-disable */
/**
 * Styles de carrousel « Kraft », « Surligné », « Grand chiffre » et les 5 styles photo
 * (Duo, Organique, Poudré, Maison, Café) — UNE seule source pour les trois usages :
 *  - aperçu dans le navigateur (frontend/src/lib/carrouselPreview.js, slides réduites) ;
 *  - rendu final Python (copie identique : backend/assets/styles_carrousel.js, exécutée par
 *    Playwright — test_styles_carrousel.py vérifie que les deux fichiers sont identiques) ;
 *  - rendu Nest (copie identique dans postorico/assets/).
 * Fichier « script classique » (pas de import/export) : il expose window.StylesCarrousel.
 *
 * Chaque slide fait 360×450 (capturée ×3 = 1080×1350) et porte ses propres styles. Les titres
 * sont des h2 (réduits par l'auto-ajustement du rendu s'ils débordent) ; data-police="titre" /
 * "corps" laisse la police choisie dans Carrousels remplacer celle du style.
 */
(function (racine) {
  // ------------------------------------------------------------------ couleurs
  function rgb(h) {
    var x = String(h || '#000000').replace('#', '');
    if (x.length === 3) x = x.split('').map(function (c) { return c + c; }).join('');
    return [0, 2, 4].map(function (i) { return parseInt(x.slice(i, i + 2), 16) || 0; });
  }
  function hex(c) {
    return '#' + c.map(function (v) { return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'); }).join('');
  }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex(x.map(function (v, i) { return v + (y[i] - v) * t; })); }
  function lum(h) { var c = rgb(h).map(function (v) { return v / 255; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function encreSur(h) { return lum(h) > 0.5 ? '#111111' : '#ffffff'; }
  /** Couleur assez sombre pour du texte blanc (une couleur claire est assombrie). */
  function sombre(h, t) { return lum(h) > 0.3 ? mix(h, '#000000', t == null ? 0.55 : t) : h; }

  // ------------------------------------------------------------------ texte
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function fitFs(t, base) {
    var l = String(t || '').length;
    return l <= 28 ? base : l <= 45 ? Math.round(base * 0.82) : l <= 65 ? Math.round(base * 0.68) : Math.round(base * 0.55);
  }
  /** Texte court (secteur souvent saisi comme une description) : coupé au mot, sans points de suite. */
  function court(t, max) {
    var mots = String(t || '').replace(/\s+/g, ' ').trim().split(' '), out = '';
    for (var i = 0; i < mots.length; i += 1) { var x = out ? out + ' ' + mots[i] : mots[i]; if (x.length > max) break; out = x; }
    return out.replace(/[,;:.]$/, '');
  }
  function decoupe(t, k) { var m = String(t || '').split(' '); return [m.slice(0, -k).join(' '), m.slice(-k).join(' ')]; }
  var T = 'data-police="titre"', P = 'data-police="corps"';

  /** Coquille d'une slide : taille fixe, styles propres au style (dupliqués, sans effet). */
  function slide(classe, css, style, contenu) {
    return '<div class="slide ' + classe + '" style="position:relative;width:360px;height:450px;overflow:hidden;' + (style || '') + '"><style>' + css + '</style>' + contenu + '</div>';
  }

  // Textures papier (bruit SVG, aucune image extérieure)
  var GRAIN = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='360' height='450'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .45  0 0 0 0 .38  0 0 0 0 .3  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23g)'/></svg>\")";
  var FROISSE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='360' height='450'><filter id='f'><feTurbulence type='fractalNoise' baseFrequency='.011 .016' numOctaves='4' seed='7'/><feDiffuseLighting lighting-color='%23ffffff' surfaceScale='3.2'><feDistantLight azimuth='120' elevation='55'/></feDiffuseLighting></filter><rect width='100%' height='100%' filter='url(%23f)'/></svg>\")";

  // ================================================================== Kraft
  var CSS_KRAFT = '.sc-kraft{background-color:#E9E1D3;color:#121212;font-family:Inter,sans-serif;padding:30px 28px 26px;display:flex;flex-direction:column;box-sizing:border-box}'
    + '.sc-kraft::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.55;mix-blend-mode:multiply;background-image:' + GRAIN + '}'
    + '.sc-kraft>*{position:relative}.sc-kraft *{margin:0;box-sizing:border-box}'
    + '.sc-kraft .haut,.sc-kraft .bas{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.3px}'
    + '.sc-kraft .haut .nom{text-transform:uppercase;font-weight:500}.sc-kraft .haut .tag,.sc-kraft .bas .an{font-weight:700}'
    + '.sc-kraft .bas{margin-top:auto;font-size:10.5px;font-weight:500}'
    + ".sc-kraft h2{font-family:'Archivo Black',sans-serif;font-weight:400;text-transform:uppercase;line-height:.93;letter-spacing:-.5px}"
    + '.sc-kraft .milieu{margin:auto 0}'
    + '.sc-kraft .encadre{margin:30px 0 0 46px;padding:9px 11px;font-size:11.5px;line-height:1.5;font-weight:500;width:200px}'
    + '.sc-kraft .deco{position:absolute;pointer-events:none}';

  function kraft(d, c) {
    var A = c.a, ink = encreSur(A), n = d.slides.length + 2;
    var pinceau = '<svg class="deco" style="left:24px;bottom:-14px" width="210" height="16" viewBox="0 0 210 16"><path d="M3 9 C 50 4, 120 3, 206 6 C 150 9, 80 11, 6 13 Z" fill="' + A + '"/></svg>';
    var boucle = '<svg class="deco" style="right:-6px;bottom:96px" width="110" height="96" viewBox="0 0 110 96" fill="none"><path d="M4 30 C 30 26, 52 34, 54 52 C 56 72, 30 78, 26 62 C 22 44, 60 36, 80 52 C 94 64, 98 80, 108 92" stroke="' + A + '" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="7 7"/></svg>';
    var fleche = '<svg class="deco" style="left:10px;top:-2px" width="44" height="42" viewBox="0 0 44 42" fill="none"><path d="M4 2 C 4 22, 14 34, 36 34" stroke="' + A + '" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="5 5"/><path d="M30 28 L37 34 L30 40" stroke="' + A + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var signet = '<svg width="34" height="40" viewBox="0 0 24 28" fill="none" stroke="' + A + '" stroke-width="2.2" stroke-linejoin="round"><path d="M4 2h16v24l-8-6-8 6z"/></svg>';
    var haut = '<div class="haut"><span class="nom">' + esc(d.nom) + '</span><span class="tag">' + (d.secteur ? '#' + esc(d.secteur.toLowerCase().split(' ')[0]) : '') + '</span></div>';
    function bas(i) { return '<div class="bas"><span>' + esc(d.nom) + '</span><span class="an">' + (i + 1) + '/' + n + '</span></div>'; }
    var out = [];
    out.push(slide('sc-kraft', CSS_KRAFT, '', haut + '<div class="milieu" style="position:relative"><h2 ' + T + ' style="font-size:' + fitFs(d.hook, 46) + 'px">' + esc(d.hook) + '</h2>' + pinceau + '</div>' + boucle + bas(0)));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-kraft', CSS_KRAFT, '', haut + '<div class="milieu"><h2 ' + T + ' style="font-size:' + fitFs(s.titre, 33) + 'px">' + esc(s.titre) + '</h2>'
        + (s.texte ? '<div style="position:relative">' + fleche + '<p ' + P + ' class="encadre" style="background:' + A + ';color:' + ink + '">' + esc(s.texte) + '</p></div>' : '')
        + '</div>' + bas(i + 1)));
    });
    out.push(slide('sc-kraft', CSS_KRAFT, '', haut + '<div class="milieu"><h2 ' + T + ' style="font-size:' + fitFs(d.cta.titre, 33) + 'px">' + esc(d.cta.titre) + '</h2>'
      + '<div style="display:flex;align-items:center;gap:12px;margin-top:18px">' + signet + (d.cta.texte ? '<p ' + P + ' style="font-size:12px;line-height:1.45;font-weight:500;max-width:220px">' + esc(d.cta.texte) + '</p>' : '') + '</div></div>' + bas(n - 1)));
    return out;
  }

  // ================================================================== Surligné
  var CSS_SURL = ".sc-surl{background-color:#EFEEEB;color:#111;font-family:'PT Sans',sans-serif;padding:26px 26px 24px;display:flex;flex-direction:column;box-sizing:border-box}"
    + '.sc-surl::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.9;mix-blend-mode:multiply;background-image:' + FROISSE + '}'
    + '.sc-surl>*{position:relative}.sc-surl *{margin:0;box-sizing:border-box}'
    + '.sc-surl .haut{display:flex;justify-content:space-between;font-size:10px;font-weight:700}'
    + ".sc-surl h2{font-family:'Barlow Condensed',sans-serif;font-weight:900;text-transform:uppercase;line-height:.9;letter-spacing:.2px}"
    + '.sc-surl .etiq{display:inline-block;padding:2px 10px 0;transform:rotate(-3deg);margin:4px 0 8px -6px;font-size:.62em}'
    + '.sc-surl .etiq.fin{font-size:1em;margin:2px 0 0 -6px;padding:0 10px}'
    + '.sc-surl .corps{margin:26px 0 0 62px;font-size:12.5px;line-height:1.45;max-width:230px}'
    + '.sc-surl .conseil{margin:14px 0 0 62px;font-size:11.5px;line-height:1.4;max-width:230px;color:#555}.sc-surl .conseil b{color:#111}'
    + '.sc-surl .bas{margin-top:auto;display:flex;align-items:center;gap:10px;font-size:9px;font-weight:700;margin-left:-26px;margin-right:-26px}'
    + '.sc-surl .filet{height:3px;flex:1}.sc-surl .filet.court{flex:0 0 22px}';

  function surligne(d, c) {
    var A = c.a, ink = encreSur(A), n = d.slides.length + 2;
    function etiq(t, fin) { return '<span class="etiq' + (fin ? ' fin' : '') + '" style="background:' + A + ';color:' + ink + '">' + esc(t) + '</span>'; }
    var haut = '<div class="haut"><span>' + esc(d.nom) + '</span><span>' + esc(d.secteur) + '</span></div>';
    function bas(i) { return '<div class="bas"><span class="filet court" style="background:' + A + '"></span><span>' + esc(d.nom) + '</span><span class="filet" style="background:' + A + '"></span><span style="padding-right:26px">' + (i + 1) + '/' + n + '</span></div>'; }
    function titre(t, base) {
      var mots = String(t || '').split(' ');
      var k = mots.length > 3 ? 2 : 1;
      if (mots.length < 2) return '<h2 ' + T + ' style="font-size:' + fitFs(t, base) + 'px;margin-top:34px">' + etiq(t, true) + '</h2>';
      var p = decoupe(t, k);
      return '<h2 ' + T + ' style="font-size:' + fitFs(t, base) + 'px;margin-top:34px">' + esc(p[0]) + '<br>' + etiq(p[1], true) + '</h2>';
    }
    var out = [];
    // étiquette de couverture : les premiers mots de l'accroche, au moins ~6 lettres
    var mots = String(d.hook || '').split(' '), k = 1;
    while (k < mots.length - 1 && mots.slice(0, k).join(' ').length < 6) k += 1;
    out.push(slide('sc-surl', CSS_SURL, '', haut + '<h2 ' + T + ' style="font-size:' + fitFs(d.hook, 64) + 'px;margin-top:24px">' + etiq(mots.slice(0, k).join(' ')) + '<br>' + esc(mots.slice(k).join(' ')) + '</h2>' + bas(0)));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-surl', CSS_SURL, '', haut + titre(s.titre, 50)
        + (s.texte ? '<p ' + P + ' class="corps">' + esc(s.texte) + '</p>' : '')
        + (s.tip ? '<p ' + P + ' class="conseil"><b>Le geste :</b> ' + esc(s.tip) + '</p>' : '') + bas(i + 1)));
    });
    out.push(slide('sc-surl', CSS_SURL, '', haut + titre(d.cta.titre, 50) + (d.cta.texte ? '<p ' + P + ' class="corps">' + esc(d.cta.texte) + '</p>' : '') + bas(n - 1)));
    return out;
  }

  // ================================================================== Grand chiffre
  var CSS_CHIFFRE = '.sc-chiffre{color:#fff;font-family:Inter,sans-serif;padding:26px 28px 24px;display:flex;flex-direction:column;box-sizing:border-box}'
    + '.sc-chiffre *{margin:0;box-sizing:border-box}'
    + '.sc-chiffre .haut{display:flex;justify-content:space-between;font-size:11px;font-weight:500;opacity:.92}'
    + '.sc-chiffre h2{font-family:Anton,sans-serif;font-weight:400;text-transform:uppercase;line-height:1.02;letter-spacing:.3px}'
    + '.sc-chiffre .geant{position:absolute;left:20px;top:74px;font-family:Anton,sans-serif;font-size:300px;line-height:1}'
    + '.sc-chiffre .corps{margin-top:18px;font-size:13px;line-height:1.6;opacity:.9;max-width:300px}'
    + '.sc-chiffre .conseil{margin-top:16px;padding-left:10px;font-size:12px;line-height:1.5;max-width:280px}'
    + '.sc-chiffre .bas{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font-size:11px;line-height:1.45}'
    + '.sc-chiffre .fin{margin:auto 0;display:flex;flex-direction:column;align-items:center;text-align:center}'
    + '.sc-chiffre .avatar{width:66px;height:66px;border-radius:50%;border:3px solid #fff;display:grid;place-items:center;font-family:Anton,sans-serif;font-size:28px;margin-bottom:16px;overflow:hidden}';

  function grandChiffre(d, c) {
    var A = c.a, fond = sombre(c.p || '#1652A6'), n = d.slides.length + 2;
    var fleche = '<svg style="position:absolute;left:108px;top:330px" width="150" height="56" viewBox="0 0 150 56" fill="none"><path d="M6 28 H140 M112 6 L140 28 L112 50" stroke="' + A + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var signet = '<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1h14v18l-7-5-7 5z" fill="#fff"/></svg>';
    function haut(i) { return '<div class="haut"><span>' + esc(d.nom) + '</span><span>' + (i + 1) + '/' + n + '</span></div>'; }
    var bas = '<div class="bas"><span>' + esc(d.nom) + (d.secteur ? '<br>' + esc(d.secteur) : '') + '</span>' + signet + '</div>';
    var fondCss = 'background:' + fond + ';';
    var out = [];
    out.push(slide('sc-chiffre', CSS_CHIFFRE, fondCss, haut(0)
      + '<div class="geant" style="color:' + A + ';opacity:' + (encreSur(A) === '#111111' ? 0.45 : 1) + '">' + d.slides.length + '</div>'
      + '<h2 ' + T + ' style="position:absolute;left:112px;right:22px;top:112px;font-size:' + fitFs(d.hook, 46) + 'px">' + esc(d.hook) + '</h2>' + fleche + bas));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-chiffre', CSS_CHIFFRE, fondCss, haut(i + 1) + '<h2 ' + T + ' style="font-size:' + fitFs(s.titre, 38) + 'px;margin-top:44px">' + esc(s.titre) + '</h2>'
        + (s.texte ? '<p ' + P + ' class="corps">' + esc(s.texte) + '</p>' : '')
        + (s.tip ? '<p ' + P + ' class="conseil" style="border-left:3px solid ' + A + '">' + esc(s.tip) + '</p>' : '') + bas));
    });
    var avatar = d.logo ? '<img src="' + esc(d.logo) + '" alt="" style="width:100%;height:100%;object-fit:cover">' : esc(String(d.nom || '?').charAt(0).toUpperCase());
    out.push(slide('sc-chiffre', CSS_CHIFFRE, fondCss, haut(n - 1) + '<div class="fin"><div class="avatar" style="background:' + A + ';color:' + encreSur(A) + '">' + avatar + '</div>'
      + '<h2 ' + T + ' style="font-size:' + fitFs(d.cta.titre, 38) + 'px">' + esc(d.cta.titre) + '</h2>' + (d.cta.texte ? '<p ' + P + ' class="corps" style="margin-top:10px">' + esc(d.cta.texte) + '</p>' : '') + '</div>' + bas));
    return out;
  }

  // ================================================================== styles photo
  /** Photo i (en boucle sur les photos fournies) ; sans photo, un aplat dégradé remplace l'image. */
  function photo(d, i, style, filtre, repli) {
    var ph = d.photos && d.photos.length ? d.photos[i % d.photos.length] : null;
    if (!ph) return '<div style="position:absolute;' + style + 'background:' + (repli || 'linear-gradient(135deg,#d8d2c8,#a99f92)') + '"></div>';
    return '<img alt="" src="' + esc(ph) + '" style="position:absolute;object-fit:cover;display:block;' + style + (filtre || '') + '">';
  }
  var BASE_CSS = function (cl) { return '.' + cl + ' *{margin:0;box-sizing:border-box}'; };

  // ---- Duo : photos noir et blanc teintées, formes arrondies, gros texte gras
  function duo(d, c) {
    var A = c.a, D = mix(sombre(c.p, 0.6), '#0b1020', 0.35), M = lum(A) > 0.55 ? mix(A, '#000000', 0.35) : A, L = mix(A, '#ffffff', 0.62);
    var txtD = lum(A) > 0.55 ? A : mix(A, '#ffffff', 0.35), encM = encreSur(M), titreL = mix(M, '#000000', 0.15);
    var css = BASE_CSS('sc-duo') + ".sc-duo h2{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;line-height:1.08;letter-spacing:-.3px}.sc-duo p{font-family:Inter,sans-serif;font-weight:500;font-size:11px;line-height:1.5}";
    function bloc(i, pos, rayon, teinte) {
      return '<div style="position:absolute;' + pos + ';overflow:hidden;border-radius:' + rayon + '">' + photo(d, i, 'inset:0;width:100%;height:100%;', 'filter:grayscale(1) contrast(1.08) brightness(1.05)')
        + '<div style="position:absolute;inset:0;background:' + teinte + ';mix-blend-mode:multiply;opacity:.38"></div></div>';
    }
    function logo(col, pos) {
      return '<div style="position:absolute;' + pos + ';display:flex;flex-direction:column;align-items:center;gap:2px;color:' + col + '">'
        + (d.logo ? '<img src="' + esc(d.logo) + '" alt="" style="width:22px;height:22px;border-radius:5px;object-fit:cover">' : '<div style="width:16px;height:16px;border-radius:4px;background:' + col + ';transform:rotate(45deg)"></div>')
        + "<span style=\"font:800 6.5px 'Bricolage Grotesque',sans-serif;letter-spacing:.5px;margin-top:3px\">" + esc(String(d.nom || '').toUpperCase()) + '</span></div>';
    }
    function h(t, col, fs, extra) { return '<h2 ' + T + ' style="font-size:' + fs + 'px;color:' + col + ';' + (extra || '') + '">' + esc(t) + '</h2>'; }
    var out = [], fonds = [M, L, D];
    out.push(slide('sc-duo', css, 'background:' + D, logo(txtD, 'left:26px;top:22px') + bloc(0, 'right:14px;top:16px;width:180px;height:270px', '70px 70px 18px 70px', M)
      + '<div style="position:absolute;left:26px;right:26px;bottom:40px">' + h(d.hook, txtD, fitFs(d.hook, 27)) + '</div>'));
    d.slides.forEach(function (s, i) {
      var f = fonds[i % 3], txt = s.texte ? '<p ' + P + ' style="margin-top:12px;color:' + (f === L ? D : encreSur(f)) + ';opacity:.88">' + esc(s.texte) + '</p>' : '';
      if (f === M) out.push(slide('sc-duo', css, 'background:' + M, bloc(i + 1, 'left:0;bottom:0;width:190px;height:240px', '0 46px 0 0', D)
        + '<div style="position:absolute;right:24px;top:30px;width:230px;text-align:right">' + h(s.titre, encM, fitFs(s.titre, 24)) + txt + '</div>' + logo(encM, 'right:26px;bottom:24px')));
      else if (f === L) out.push(slide('sc-duo', css, 'background:' + L, logo(D, 'left:50%;top:22px;transform:translateX(-50%)')
        + '<div style="position:absolute;left:28px;right:28px;top:84px;text-align:center">' + h(s.titre, titreL, fitFs(s.titre, 26)) + txt + '</div>' + bloc(i + 1, 'left:16px;right:16px;bottom:16px;height:120px', '16px', M)));
      else out.push(slide('sc-duo', css, 'background:' + D, bloc(i + 1, 'left:14px;top:16px;width:170px;height:240px', '70px 70px 70px 18px', M)
        + '<div style="position:absolute;left:26px;right:26px;bottom:36px">' + h(s.titre, txtD, fitFs(s.titre, 24)) + txt.replace(D, '#fff') + '</div>' + logo(txtD, 'right:26px;top:22px')));
    });
    out.push(slide('sc-duo', css, 'background:' + M + ';display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 34px',
      h(d.cta.titre, encM, fitFs(d.cta.titre, 28)) + (d.cta.texte ? '<p ' + P + ' style="margin-top:14px;font-weight:600;font-size:12px;color:' + encM + '">' + esc(d.cta.texte) + '</p>' : '') + logo(encM, 'left:50%;bottom:24px;transform:translateX(-50%)')));
    return out;
  }

  // ---- Organique : crème, serif, photo en arche, taches et branches
  function organique(d, c) {
    var A = c.a, CREME = '#FBF7EE', ENC = sombre(c.p, 0.5), c1 = mix(A, '#F3E2CF', 0.45), c2 = mix(A, '#F3E2CF', 0.78);
    var css = BASE_CSS('sc-org') + ".sc-org h2{font-family:'EB Garamond',serif;font-weight:500;line-height:1.12}.sc-org p{font-family:Inter,sans-serif}";
    function tache1(col) { return '<path d="M30 40 C 70 0, 150 10, 160 60 C 170 110, 110 140, 60 125 C 10 110, -10 80, 30 40 Z" fill="' + col + '"/>'; }
    function tache2(col) { return '<path d="M20 30 C 50 0, 110 20, 100 70 C 92 110, 30 100, 15 75 C 5 58, 5 42, 20 30 Z" fill="' + col + '"/>'; }
    function branche(col) {
      return '<g fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linecap="round"><path d="M10 10 C 60 40, 110 70, 170 95"/></g><g fill="' + col + '">'
        + [[38, 16, -35], [30, 33, 30], [68, 33, -40], [58, 52, 25], [100, 50, -40], [90, 69, 25]].map(function (f) { return '<ellipse cx="' + f[0] + '" cy="' + f[1] + '" rx="11" ry="4" transform="rotate(' + f[2] + ' ' + f[0] + ' ' + f[1] + ')"/>'; }).join('') + '</g>';
    }
    function deco(pos, w, contenu) { return '<svg style="position:absolute;' + pos + '" width="' + w + '" height="' + w + '" viewBox="0 0 180 180">' + contenu + '</svg>'; }
    var out = [];
    out.push(slide('sc-org', css, 'background:' + CREME, deco('left:-30px;bottom:30px', 190, tache2(c2) + '<g transform="translate(40 40)">' + tache1(c1) + '</g>') + deco('left:4px;bottom:118px', 160, branche(ENC))
      + '<div style="position:absolute;right:-50px;top:66px;width:250px;height:360px;border-radius:50%;overflow:hidden">' + photo(d, 0, 'inset:0;width:100%;height:100%;') + '</div>'
      + '<div style="position:absolute;left:28px;top:44px;width:200px"><h2 ' + T + ' style="font-size:' + fitFs(d.hook, 30) + 'px;color:' + ENC + '">' + esc(d.hook) + '</h2><p ' + P + ' style="margin-top:12px;font-size:12px;color:' + ENC + '">' + d.slides.length + ' conseils pour y arriver</p></div>'
      + '<p style="position:absolute;left:28px;bottom:24px;font-size:9px;font-weight:500;color:' + ENC + '">' + esc(d.nom) + '</p>' + deco('right:-30px;bottom:-40px', 150, tache2(c1))));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-org', css, 'background:' + CREME, deco('right:-50px;top:-40px', 170, tache1(c2) + '<g transform="translate(60 10) scale(.6)">' + branche(c1) + '</g>') + deco('left:-40px;bottom:-30px', 160, tache2(c1) + '<g transform="translate(40 60) scale(.6)">' + branche(ENC) + '</g>')
        + '<div style="position:absolute;left:44px;right:44px;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">'
        + "<div style=\"width:30px;height:30px;border-radius:50%;background:" + A + ';color:' + encreSur(A) + ";display:grid;place-items:center;font:600 13px 'EB Garamond',serif\">" + (i + 1) + '</div>'
        + '<h2 ' + T + ' style="margin-top:14px;font-size:' + fitFs(s.titre, 23) + 'px;color:' + ENC + '">' + esc(s.titre) + '</h2>'
        + (s.texte ? '<p ' + P + ' style="margin-top:12px;font-size:11px;line-height:1.6;color:' + ENC + ';opacity:.85">' + esc(s.texte) + '</p>' : '') + '</div>'
        + '<p style="position:absolute;left:0;right:0;bottom:20px;text-align:center;font-size:8px;color:' + ENC + ';opacity:.7">' + esc(d.nom) + '</p>'));
    });
    var fleur = '<g fill="none" stroke="' + CREME + '" stroke-width="1.8" stroke-linecap="round"><path d="M90 170 C 88 130, 92 100, 90 70"/><path d="M90 120 C 70 110, 58 95, 60 80 C 76 84, 88 100, 90 120"/><path d="M90 104 C 110 96, 122 80, 120 66 C 104 70, 92 86, 90 104"/><circle cx="90" cy="52" r="18"/></g>';
    var encA = encreSur(A);
    out.push(slide('sc-org', css, 'background:' + A + ';display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 40px',
      deco('right:-30px;top:-30px', 120, tache2(mix(A, '#ffffff', 0.25))) + '<svg width="120" height="120" viewBox="0 0 180 180">' + fleur.replace(new RegExp(CREME, 'g'), encA === '#111111' ? '#3b2a20' : CREME) + '</svg>'
      + '<h2 ' + T + ' style="margin-top:14px;font-size:' + fitFs(d.cta.titre, 22) + 'px;color:' + encA + '">' + esc(d.cta.titre) + '</h2>' + (d.cta.texte ? '<p ' + P + ' style="margin-top:10px;font-size:11px;font-weight:500;color:' + encA + '">' + esc(d.cta.texte) + '</p>' : '')));
    return out;
  }

  // ---- Poudré : photo plein cadre + bandeau translucide, étapes pastel avec photo ronde
  function poudre(d, c) {
    var A = c.a, L = mix(A, '#ffffff', 0.45), BANDE = mix(A, '#ffffff', 0.3), ENC = sombre(c.p, 0.55);
    var css = BASE_CSS('sc-pou') + '.sc-pou h2{font-family:Italiana,serif;font-weight:400;line-height:1.15;letter-spacing:1.2px;text-transform:uppercase}.sc-pou p{font-family:Montserrat,sans-serif}';
    var out = [];
    out.push(slide('sc-pou', css, '', photo(d, 0, 'inset:0;width:100%;height:100%;')
      + '<div style="position:absolute;left:0;right:0;top:150px;padding:20px 22px;background:' + BANDE + 'e0;text-align:center"><h2 ' + T + ' style="font-size:' + fitFs(d.hook, 26) + 'px;color:' + ENC + '">' + esc(d.hook) + '</h2>'
      + '<p ' + P + ' style="margin-top:10px;font-weight:700;font-size:10px;color:' + ENC + '">' + d.slides.length + ' conseils pour y arriver</p></div>'
      + '<p style="position:absolute;left:0;right:0;bottom:30px;text-align:center;font-weight:600;font-size:9px;color:#1d1d1d">' + esc(d.nom) + '</p>'));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-pou', css, 'background:' + L + ';padding:34px 28px;box-sizing:border-box',
        '<p style="font-family:Italiana,serif;font-size:13px;letter-spacing:1.5px;color:' + ENC + '">ÉTAPE ' + (i + 1) + ' :</p>'
        + '<h2 ' + T + ' style="margin-top:8px;font-family:Montserrat,sans-serif;font-weight:700;text-transform:none;letter-spacing:0;font-size:' + fitFs(s.titre, 14) + 'px;line-height:1.35;color:' + ENC + '">' + esc(s.titre) + '</h2>'
        + (s.texte ? '<p ' + P + ' style="margin-top:8px;font-size:10.5px;line-height:1.55;color:' + ENC + ';max-width:280px">' + esc(s.texte) + '</p>' : '')
        + (s.tip ? '<span style="display:inline-block;margin-top:16px;background:#fff;color:' + ENC + ';font:700 8px Montserrat,sans-serif;letter-spacing:1px;padding:5px 10px;border-radius:3px">LE GESTE</span><p ' + P + ' style="margin-top:10px;font-weight:600;font-size:10.5px;line-height:1.5;color:' + ENC + ';max-width:200px">' + esc(s.tip) + '</p>' : '')
        + '<div style="position:absolute;right:-30px;bottom:-30px;width:170px;height:170px;border-radius:50%;overflow:hidden;border:4px solid #fff">' + photo(d, i + 1, 'inset:0;width:100%;height:100%;') + '</div>'));
    });
    out.push(slide('sc-pou', css, '', photo(d, d.slides.length + 1, 'inset:0;width:100%;height:100%;') + '<div style="position:absolute;inset:0;background:linear-gradient(transparent 45%, ' + L + 'f2 78%)"></div>'
      + '<div style="position:absolute;left:24px;right:24px;bottom:34px;text-align:center"><h2 ' + T + ' style="font-size:' + fitFs(d.cta.titre, 20) + 'px;color:' + ENC + '">' + esc(d.cta.titre) + '</h2>'
      + (d.cta.texte ? '<p ' + P + ' style="margin-top:8px;font-weight:600;font-size:10px;color:' + ENC + '">' + esc(d.cta.texte) + '</p>' : '') + '</div>'));
    return out;
  }

  // ---- Maison : photo assombrie, serif dont la fin passe en italique ; collage de photos
  function maison(d, c) {
    var A = c.a, CREME = '#F3EEE7', ENC = '#2B2420', NUM = lum(A) > 0.55 ? mix(A, '#000000', 0.4) : A, n = d.slides.length + 2;
    var css = BASE_CSS('sc-mai') + ".sc-mai h2{font-family:'Cormorant Garamond',serif;font-weight:500;line-height:1.02}.sc-mai h2 i{font-weight:500;padding-left:32px}.sc-mai p{font-family:Montserrat,sans-serif}";
    function pastille(t, col) { return '<span style="border:1px solid ' + col + ';border-radius:50%;padding:4px 12px;font:400 8.5px Montserrat,sans-serif;color:' + col + '">' + t + '</span>'; }
    var etoiles = '<div style="position:absolute;right:22px;bottom:24px;display:flex;gap:4px">' + [0, 1, 2].map(function () { return '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 0 L6.2 3.8 L10 5 L6.2 6.2 L5 10 L3.8 6.2 L0 5 L3.8 3.8 Z" fill="' + A + '"/></svg>'; }).join('') + '</div>';
    function deuxTons(t, k, fs, col) { var p = decoupe(t, k); return '<h2 ' + T + ' style="font-size:' + fs + 'px;color:' + col + '">' + esc(p[0]) + '<br><i>' + esc(p[1]) + '</i></h2>'; }
    function tete(i, col) { return '<div style="position:absolute;left:22px;right:22px;top:22px;display:flex;justify-content:space-between;align-items:center">' + pastille('Page ' + String(i + 1).padStart(2, '0'), col) + '<span style="font:400 9px Montserrat,sans-serif;color:' + col + '">' + esc(d.nom) + '</span></div>'; }
    var out = [];
    out.push(slide('sc-mai', css, '', photo(d, 0, 'inset:0;width:100%;height:100%;') + '<div style="position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.55))"></div>' + tete(0, '#fff')
      + '<div style="position:absolute;left:24px;right:20px;top:150px">' + deuxTons(d.hook, Math.min(3, Math.max(1, Math.floor(String(d.hook).split(' ').length / 2))), fitFs(d.hook, 40), '#fff') + '</div>' + etoiles));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-mai', css, 'background:' + CREME, tete(i + 1, ENC)
        + '<div style="position:absolute;left:22px;top:92px;width:120px;height:120px;overflow:hidden">' + photo(d, i + 1, 'inset:0;width:100%;height:100%;') + '</div>'
        + '<div style="position:absolute;left:64px;top:200px;width:110px;height:150px;overflow:hidden;border:5px solid ' + CREME + '">' + photo(d, i + 2, 'inset:0;width:100%;height:100%;') + '</div>'
        + '<div style="position:absolute;left:190px;right:22px;top:96px"><div style="font-family:\'Cormorant Garamond\',serif;font-style:italic;font-size:46px;line-height:1;color:' + NUM + '">' + String(i + 1).padStart(2, '0') + '</div>'
        + '<div style="margin-top:8px">' + deuxTons(s.titre, 1, fitFs(s.titre, 22), ENC) + '</div>'
        + (s.texte ? '<p ' + P + ' style="margin-top:10px;font-size:9.5px;line-height:1.55;color:#5a524c">' + esc(s.texte) + '</p>' : '') + '</div>' + etoiles));
    });
    out.push(slide('sc-mai', css, 'background:' + CREME, tete(n - 1, ENC) + '<div style="position:absolute;left:30px;right:30px;top:96px;height:170px;overflow:hidden">' + photo(d, 0, 'inset:0;width:100%;height:100%;') + '</div>'
      + '<div style="position:absolute;left:30px;right:30px;top:288px;text-align:center">' + deuxTons(d.cta.titre, 2, fitFs(d.cta.titre, 24), ENC)
      + (d.cta.texte ? '<p ' + P + ' style="margin-top:10px;font-size:10px;color:#5a524c">' + esc(d.cta.texte) + '</p>' : '') + '</div>' + etoiles));
    return out;
  }

  // ---- Café : photo, gros titre blanc, étiquette manuscrite ; étapes sur photo voilée
  function cafe(d, c) {
    var BRUN = sombre(c.p, 0.6), n = d.slides.length + 2;
    var css = BASE_CSS('sc-caf') + '.sc-caf h2{font-family:Poppins,sans-serif}.sc-caf p{font-family:Poppins,sans-serif}';
    function points(i, col) { var t = ''; for (var k = 0; k < n; k += 1) t += '<i style="width:6px;height:6px;border-radius:50%;border:1px solid ' + col + ';background:' + (k === i ? col : 'transparent') + '"></i>'; return '<div style="position:absolute;left:0;right:0;bottom:16px;display:flex;justify-content:center;gap:4px">' + t + '</div>'; }
    var fleche = '<svg width="70" height="34" viewBox="0 0 70 34" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 24 C 12 8, 26 8, 30 18 C 34 28, 20 30, 22 20 C 24 10, 46 10, 64 16"/><path d="M56 10 L64 16 L56 22"/></svg>';
    var m = String(d.hook || '').split(' '), k = Math.min(3, Math.ceil(m.length / 2)), haut = m.slice(0, k).join(' '), bas = m.slice(k).join(' ');
    var out = [];
    out.push(slide('sc-caf', css, '', photo(d, 0, 'inset:0;width:100%;height:100%;') + '<div style="position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.42),rgba(0,0,0,.08) 62%)"></div>'
      + '<div style="position:absolute;left:20px;right:20px;top:46px;text-align:center;color:#fff"><h2 ' + T + ' style="font-weight:800;font-size:' + fitFs(haut, 34) + 'px;line-height:1;text-transform:uppercase">' + esc(haut)
      + (bas ? '<span style="display:block;font-weight:700;text-transform:none;font-size:' + fitFs(bas, 30) / fitFs(haut, 34) + 'em;line-height:1.05;margin-top:2px">' + esc(bas) + '</span>' : '') + '</h2>'
      + "<span style=\"display:inline-block;margin-top:12px;background:" + BRUN + ";color:#fff;font:700 15px Caveat,cursive;padding:3px 12px;transform:rotate(-2deg)\">Je te montre en " + d.slides.length + ' étapes</span>'
      + '<div style="margin-top:10px">' + fleche + '</div></div>' + points(0, '#fff')));
    d.slides.forEach(function (s, i) {
      out.push(slide('sc-caf', css, '', photo(d, 0, 'inset:-12px;width:calc(100% + 24px);height:calc(100% + 24px);', 'filter:blur(5px)') + '<div style="position:absolute;inset:0;background:rgba(255,255,255,.64)"></div>'
        + '<div style="position:absolute;left:30px;right:30px;top:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:' + BRUN + '">'
        + '<div style="font:700 26px Poppins,sans-serif">' + (i + 1) + '</div>'
        + '<h2 ' + T + ' style="font-weight:800;font-size:' + fitFs(s.titre, 16) + 'px;line-height:1.2;text-transform:uppercase;margin-top:6px">' + esc(s.titre) + '</h2>'
        + (s.texte ? '<p ' + P + ' style="margin-top:10px;font-size:10.5px;line-height:1.55">' + esc(s.texte) + '</p>' : '')
        + (s.tip ? '<div style="margin-top:16px;background:#fff;border-radius:10px;padding:10px 14px;box-shadow:0 6px 16px rgba(0,0,0,.08)"><p style="font-weight:700;font-size:10px">Mon conseil</p><p ' + P + ' style="margin-top:4px;font-size:10px;line-height:1.5">' + esc(s.tip) + '</p></div>' : '')
        + '</div>' + points(i + 1, BRUN)));
    });
    out.push(slide('sc-caf', css, 'background:' + BRUN + ';display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 40px;color:#fff',
      '<h2 ' + T + ' style="font-weight:800;font-size:' + fitFs(d.cta.titre, 17) + 'px;line-height:1.25;text-transform:uppercase">' + esc(d.cta.titre) + '</h2>'
      + (d.cta.texte ? '<p ' + P + ' style="margin-top:10px;font-weight:500;font-size:10px;opacity:.85">' + esc(d.cta.texte) + '</p>' : '')
      + '<p style="position:absolute;bottom:24px;font-weight:500;font-size:9px;opacity:.7">' + esc(d.nom) + '</p>'));
    return out;
  }

  // ------------------------------------------------------------------ catalogue
  var STYLES = {
    kraft: { label: 'Kraft', photos: false, polices: ['Archivo Black', 'Inter'], fn: kraft },
    surligne: { label: 'Surligné', photos: false, polices: ['Barlow Condensed:wght@700;800;900', 'PT Sans:ital,wght@0,400;0,700'], fn: surligne },
    'grand-chiffre': { label: 'Grand chiffre', photos: false, polices: ['Anton', 'Inter'], fn: grandChiffre },
    duo: { label: 'Duo', photos: true, polices: ['Bricolage Grotesque:opsz,wght@12..96,800', 'Inter'], fn: duo },
    organique: { label: 'Organique', photos: true, polices: ['EB Garamond:wght@500;600', 'Inter'], fn: organique },
    poudre: { label: 'Poudré', photos: true, polices: ['Italiana', 'Montserrat:wght@400;600;700'], fn: poudre },
    maison: { label: 'Maison', photos: true, polices: ['Cormorant Garamond:ital,wght@0,500;1,500', 'Montserrat:wght@400;600'], fn: maison },
    cafe: { label: 'Café', photos: true, polices: ['Poppins:wght@400;500;700;800', 'Caveat:wght@700'], fn: cafe },
  };

  /** Lien Google Fonts des polices d'un style. */
  function lienPolices(id) {
    var s = STYLES[id];
    if (!s) return '';
    return 'https://fonts.googleapis.com/css2?' + s.polices.map(function (f) {
      var p = f.split(':');
      return 'family=' + p[0].replace(/ /g, '+') + (p[1] ? ':' + p[1] : ':wght@400;500;600;700');
    }).join('&') + '&display=swap';
  }

  /** Normalise le contenu (formes carrousel_data acceptées) et rend les slides du style. */
  function rendre(id, contenu, couleurs) {
    var s = STYLES[id];
    if (!s) return [];
    var c = contenu || {};
    var cta = c.cta || {};
    if (typeof cta === 'string') cta = { titre: cta };
    var d = {
      hook: c.hook || '',
      slides: (c.slides || []).map(function (x) { return { titre: x.titre || x.t || '', texte: x.texte || x.x || '', tip: x.pro_tip || x.tip || '' }; }),
      cta: { titre: cta.titre || cta.t || 'On en parle ?', texte: cta.texte || cta.x || '' },
      nom: c.nom || 'Ta marque', secteur: court(c.secteur, 28), logo: c.logo || null, photos: c.photos || [],
    };
    var k = couleurs || {};
    return s.fn(d, { p: k.p || '#1652A6', s: k.s || '#8A6CFF', a: k.a || '#F26B3A' });
  }

  racine.StylesCarrousel = {
    ids: Object.keys(STYLES),
    infos: Object.keys(STYLES).map(function (id) { return { id: id, label: STYLES[id].label, photos: STYLES[id].photos }; }),
    avecPhotos: function (id) { return !!(STYLES[id] && STYLES[id].photos); },
    lienPolices: lienPolices,
    rendre: rendre,
  };
})(typeof window !== 'undefined' ? window : globalThis);
