/* Platform detail page: variant cards with selection and an order bar */
(function () {
  var V = window.Verve, $ = V.$;
  V.layout.mount();

  var cat = document.body.getAttribute('data-cat');
  var pid = document.body.getAttribute('data-platform');
  var meta = V.categories.filter(function (c) { return c.id === cat; })[0];

  var HELP = {
    accounts: [
      ['What does each card show?', 'The age of the account, the audience size where the platform has one, and the price. Tiers run from Starter to Signature as age and audience grow.'],
      ['What happens after I select a listing?', 'You review the order summary and continue to checkout. Checkout connects once the backend is live, so nothing is charged from this page.'],
      ['Are these real listings?', 'No. The listings here are sample data used to design the experience.']
    ],
    subscriptions: [
      ['How are plans priced?', 'Longer plans cost less per month. Each card shows the total for the term, the monthly rate and how much you save against paying month to month.'],
      ['Which durations are available?', '1, 2, 3, 6, 9 and 12 months, for every service in the catalogue.'],
      ['Are these live prices?', 'No. Prices are sample data. Provider terms and current prices are not checked.']
    ],
    games: [
      ['What is on each card?', 'The amount you receive, the price, and the cost per 100 units so packs are easy to compare.'],
      ['Do I need to link my game account?', 'Not in this preview. Linking an account and delivery belong to the checkout that arrives with the backend.'],
      ['Are these live prices?', 'No. Prices are sample data and nothing here is redeemable.']
    ]
  };

  function card(p, o) {
    var badge = o.badge ? '<span class="vcard__badge">' + V.esc(o.badge) + '</span>' : '';
    return '<button class="vcard" type="button" aria-pressed="false" data-id="' + o.id + '" style="--c1:' + p.c1 + ';--c2:' + p.c2 + '">' +
      '<span class="art vcard__art" aria-hidden="true"><span class="art__orb"></span><span class="art__plate"></span>' +
        badge + (o.big || '') + '<span class="vcard__check">' + V.icon('check') + '</span></span>' +
      '<span class="glyph vcard__glyph" aria-hidden="true">' + V.icon(p.icon) + '</span>' +
      '<span class="vcard__body">' +
        '<span><span class="vcard__title">' + V.esc(o.title) + '</span><span class="vcard__ref">' + V.esc(o.ref) + '</span></span>' +
        '<span class="vcard__stats">' + o.stats.map(function (s) {
          return '<span class="stat"><span class="stat__k">' + V.esc(s[0]) + '</span><span class="stat__v">' + V.esc(s[1]) + '</span></span>';
        }).join('') + '</span>' +
        '<span class="vcard__foot"><span class="vcard__price">' + V.fmt.usd(o.price) + '</span>' +
          '<span class="vcard__cta"><span class="vcard__cta-off">Select</span><span class="vcard__cta-on">Selected</span></span></span>' +
      '</span></button>';
  }

  /* Normalise each category's items into card options and order summaries */
  function describe(p, it) {
    if (cat === 'accounts') {
      var stats = [['Age', V.fmt.years(it.age)]];
      if (it.audience != null) stats.push([p.audience, V.fmt.compact(it.audience)]);
      return { id: it.id, price: it.price, badge: it.tier, title: it.tier, ref: it.ref, stats: stats,
        summary: p.name + ' account, ' + it.tier };
    }
    if (cat === 'subscriptions') {
      var label = it.months === 1 ? '1 month' : it.months + ' months';
      return { id: it.id, price: it.total, badge: it.savePct ? 'Save ' + it.savePct + '%' : 'Monthly',
        big: '<span class="vcard__big">' + it.months + '<small>' + (it.months === 1 ? 'month' : 'months') + '</small></span>',
        title: label, ref: p.name,
        stats: [['Per month', V.fmt.usd(it.perMonth)], ['You save', it.savePct ? it.savePct + '%' : 'Nothing']],
        summary: p.name + ', ' + label };
    }
    var amount = V.fmt.int(it.amount);
    var gift = !!p.gift;
    return { id: it.id, price: it.price, badge: gift ? 'Gift credit' : 'Top-up',
      big: '<span class="vcard__big">' + (gift ? '$' : '') + amount + '<small>' + (gift ? 'credit' : p.unit) + '</small></span>',
      title: gift ? '$' + amount + ' credit' : amount + ' ' + p.unit, ref: p.name,
      stats: gift ? [['Type', 'Gift credit'], ['Face value', '$' + amount]]
        : [['Amount', amount], ['Per 100', V.fmt.usd(it.price / it.amount * 100)]],
      summary: p.name + ', ' + (gift ? '$' + amount + ' credit' : amount + ' ' + p.unit) };
  }

  function notFound() {
    $('#variants').className = '';
    $('#variants').innerHTML = '<div class="empty"><h2>We could not find that platform</h2><p>It may have been renamed or removed.</p>' +
      '<a class="btn" href="' + meta.href + '">Back to ' + meta.label + '</a></div>';
  }

  V.api.getPlatform(cat, pid).then(function (p) {
    if (!p) { notFound(); return; }

    var siblings = V.catalog[cat].filter(function (x) { return x.id !== p.id; }).slice(0, 7);
    V.stage.mount($('#hero-stage'), {
      core: { icon: p.icon, label: p.name, sub: meta.label, c1: p.c1, c2: p.c2, scale: 0.9 },
      tiles: siblings.map(function (s) { return { icon: s.icon, c1: s.c1, c2: s.c2 }; })
    });

    var cards = p.items.map(function (it) { return describe(p, it); });
    $('#variants').innerHTML = cards.map(function (o) { return card(p, o); }).join('');

    /* Selection and order bar */
    var bar = $('#orderbar'), selected = null;
    function setSelected(id) {
      selected = id;
      V.$$('.vcard').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-id') === id)); });
      var o = cards.filter(function (c) { return c.id === id; })[0];
      if (o) {
        $('#ob-title').textContent = o.summary;
        $('#ob-price').textContent = V.fmt.usd(o.price);
      }
      bar.classList.toggle('is-visible', !!o);
      document.body.classList.toggle('has-orderbar', !!o);
    }
    $('#variants').addEventListener('click', function (e) {
      var b = e.target.closest('.vcard');
      if (!b) return;
      setSelected(b.getAttribute('data-id') === selected ? null : b.getAttribute('data-id'));
    });
    $('#ob-clear').addEventListener('click', function () { setSelected(null); });
    $('#ob-continue').addEventListener('click', function () {
      var o = cards.filter(function (c) { return c.id === selected; })[0];
      if (!o) return;
      var btn = this;
      btn.disabled = true;
      V.api.createOrder({ category: cat, platform: p.id, item: o.id, price: o.price }).then(function (res) {
        V.toast(res.message);
        btn.disabled = false;
      });
    });
  });

  /* Good to know */
  $('#help').innerHTML = HELP[cat].map(function (h) {
    return '<details><summary>' + h[0] + '</summary><p>' + h[1] + '</p></details>';
  }).join('');
})();
