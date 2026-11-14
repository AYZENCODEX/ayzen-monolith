/*
 * Verve API adapter.
 *
 * Pages call these async functions and never touch data.js directly.
 * To connect a backend, replace the bodies below with fetch() calls that
 * return the same shapes (documented in README.md). Nothing else changes.
 */
(function () {
  var V = window.Verve;

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Small deterministic PRNG so sample offers stay stable between visits */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function nice(n) {
    var mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
    return Math.round(n / mag) * mag;
  }

  var HANDLES = ['GreenLeaf_07', 'QuietRiver_22', 'NorthStar_BD', 'AmberTrade', 'SilkRoad_24', 'PineDesk', 'LumenExchange',
    'SteadyHand', 'BlueHarbor', 'OakAndOre', 'TidalDesk', 'MapleLedger', 'CedarFlow', 'IronLantern'];
  var HUES = [['#2c5f46', '#b9d78f'], ['#2a649a', '#74b5dc'], ['#7a45b5', '#c9a4ef'], ['#bd8226', '#f2d37c'], ['#b84876', '#f4a560'], ['#1f5d66', '#6fc4c8']];

  function buildOffers(q) {
    var asset = V.p2p.assets.filter(function (a) { return a.id === q.asset; })[0] || V.p2p.assets[0];
    var fiat = V.p2p.fiats.filter(function (f) { return f.id === q.fiat; })[0] || V.p2p.fiats[0];
    var mid = asset.usd * fiat.perUsd;
    var r = rng(hash(asset.id + '|' + fiat.id + '|' + q.side));
    var pool = V.p2p.payments[fiat.id];
    var offers = [];

    for (var i = 0; i < 12; i++) {
      var spread = 0.0008 + r() * 0.0075;
      var price = q.side === 'buy' ? mid * (1 + spread) : mid * (1 - spread);
      var count = 1 + Math.floor(r() * 3);
      var methods = [];
      var start = Math.floor(r() * pool.length);
      for (var m = 0; m < Math.min(count, pool.length); m++) methods.push(pool[(start + m) % pool.length]);

      var minFiat = nice(20 * fiat.perUsd * (1 + r() * 4));
      var availableAsset = (400 + r() * 7000) / asset.usd;
      var maxFiat = Math.min(nice(minFiat * (8 + r() * 40)), nice(availableAsset * price * 0.98));
      if (maxFiat <= minFiat) maxFiat = minFiat * 2;

      var hue = HUES[Math.floor(r() * HUES.length)];
      offers.push({
        id: asset.id + '-' + fiat.id + '-' + q.side + '-' + i,
        advertiser: {
          name: HANDLES[(i + Math.floor(r() * 5)) % HANDLES.length] + (i > 11 ? '' : ''),
          orders: 40 + Math.floor(r() * 2400),
          completion: Math.round((94 + r() * 5.9) * 10) / 10,
          c1: hue[0], c2: hue[1]
        },
        price: price,
        available: availableAsset,
        minFiat: minFiat,
        maxFiat: maxFiat,
        payments: methods,
        payWindow: [15, 15, 30][Math.floor(r() * 3)] + ' min'
      });
    }
    /* Unique advertiser names */
    var seen = {};
    offers.forEach(function (o, idx) {
      var n = o.advertiser.name;
      if (seen[n]) o.advertiser.name = n + '_' + (idx + 10);
      seen[o.advertiser.name] = true;
    });

    offers.sort(function (a, b) { return q.side === 'buy' ? a.price - b.price : b.price - a.price; });

    var amount = parseFloat(q.amount);
    var list = offers.filter(function (o) {
      if (q.payment && q.payment !== 'all' && o.payments.indexOf(q.payment) < 0) return false;
      if (amount > 0 && (amount < o.minFiat || amount > o.maxFiat)) return false;
      return true;
    });
    return { offers: list, total: offers.length, mid: mid, asset: asset, fiat: fiat };
  }

  V.api = {
    /* GET /platforms?category=accounts */
    getPlatforms: function (cat) { return Promise.resolve(V.catalog[cat] || []); },

    /* GET /platforms/:category/:id  (includes items: listings, plans or packs) */
    getPlatform: function (cat, id) { return Promise.resolve(V.find(cat, id)); },

    /* GET /p2p/offers?side=buy&asset=USDT&fiat=BDT&payment=all&amount=10000 */
    getOffers: function (query) {
      return delay(260).then(function () { return buildOffers(query); });
    },

    /* GET /p2p/assets */
    getAssets: function () { return Promise.resolve(V.p2p); },

    /* POST /orders. No backend yet, so nothing is placed. */
    createOrder: function (payload) {
      return delay(450).then(function () {
        return {
          ok: false,
          status: 'not_connected',
          message: 'Checkout will open once the marketplace backend is connected.',
          payload: payload
        };
      });
    }
  };
})();
