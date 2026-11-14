/* Home: hero scene, tabbed sliders, catalogue summary */
(function () {
  var V = window.Verve, $ = V.$;
  V.layout.mount();

  /* Hero background */
  V.motion.mount($('#hero-motion'));

  /* Slider cards per category */
  function cardsFor(cat) {
    if (cat === 'p2p') {
      var fiat = V.p2p.fiats[0];
      return V.p2p.assets.map(function (a) {
        return V.pcard({
          href: 'p2p.html#' + a.id.toLowerCase() + '-buy', c1: a.c1, c2: a.c2, glyph: a.glyph,
          title: a.id, meta: 'Buy ' + fiat.symbol + V.fmt.short(a.usd * fiat.perUsd), chip: a.name
        });
      });
    }
    return V.catalog[cat].map(function (p) {
      var info = V.cardInfo(cat, p);
      return V.pcard({ href: V.platformHref(cat, p.id), c1: p.c1, c2: p.c2, icon: p.icon, title: p.name, meta: info.meta, chip: info.chip });
    });
  }

  /* Two rows, filled left to right: the first half on row 1, the rest on row 2 */
  function slotted(cards) {
    var half = Math.ceil(cards.length / 2);
    return cards.map(function (h, i) {
      return '<li class="slider__item" style="grid-row:' + (i < half ? 1 : 2) + ';grid-column:' + ((i % half) + 1) + '">' + h + '</li>';
    }).join('');
  }

  function panelHTML(c, index) {
    return '<section class="panel" role="tabpanel" id="panel-' + c.id + '" aria-labelledby="tab-' + c.id + '"' + (index ? ' hidden' : '') + '>' +
      '<div class="slider" data-slider>' +
        '<div class="slider__head">' +
          '<div><h2 class="slider__title">' + c.title + '</h2><p class="slider__sub">' + c.blurb + '</p></div>' +
          '<div class="slider__tools"><a class="link-more" href="' + c.href + '">View all</a>' +
            '<div class="slider__controls">' +
              '<button class="round-btn" type="button" data-prev aria-label="Previous">' + V.icon('left') + '</button>' +
              '<button class="round-btn" type="button" data-next aria-label="Next">' + V.icon('right') + '</button>' +
            '</div></div>' +
        '</div>' +
        '<ul class="slider__track" tabindex="0" aria-label="' + c.label + '">' +
          slotted(cardsFor(c.id)) +
        '</ul>' +
        '<div class="slider__progress" aria-hidden="true"><span></span></div>' +
      '</div></section>';
  }

  var panels = $('#panels');
  panels.innerHTML = V.categories.map(panelHTML).join('');
  var sliders = {};
  V.categories.forEach(function (c) { sliders[c.id] = V.slider($('#panel-' + c.id)); });

  var ids = V.categories.map(function (c) { return c.id; });
  var tabs = V.tabs($('#tabs'), function (id) {
    V.categories.forEach(function (c) { $('#panel-' + c.id).hidden = c.id !== id; });
    sliders[id].update();
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ }
  });
  var wanted = (location.hash || '').replace('#', '');
  if (ids.indexOf(wanted) > -1 && wanted !== ids[0]) tabs.select(wanted);

  /* Catalogue summary */
  function fromText(c) {
    if (c.id === 'p2p') return V.fmt.plural(V.p2p.fiats.length, 'currency', 'currencies');
    var min = Math.min.apply(null, V.catalog[c.id].map(function (p) { return p.from; }));
    return 'From ' + V.fmt.usd(min);
  }
  $('#summary').innerHTML = V.categories.map(function (c) {
    var count = c.id === 'p2p' ? V.p2p.assets.length : V.catalog[c.id].length;
    return '<a class="summary__row" href="' + c.href + '" data-press style="--c1:' + c.c1 + ';--c2:' + c.c2 + '">' +
      '<span class="glyph summary__icon" aria-hidden="true">' + V.icon(c.icon) + '</span>' +
      '<span class="summary__name"><strong>' + c.label + '</strong><small>' + c.blurb + '</small></span>' +
      '<span class="summary__count">' + count + ' ' + c.noun + '</span>' +
      '<span class="summary__from">' + fromText(c) + '</span>' +
      V.icon('arrow') + '</a>';
  }).join('');
})();
