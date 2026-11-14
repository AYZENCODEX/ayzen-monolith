/* P2P exchange: side and asset selection, filters, offer list, order drawer */
(function () {
  var V = window.Verve, $ = V.$;
  V.layout.mount();

  var assets = V.p2p.assets, fiats = V.p2p.fiats;
  var state = { side: 'buy', asset: 'USDT', fiat: 'BDT', payment: 'all', amount: '' };

  /* Deep link: p2p.html#usdt-buy */
  (function () {
    var parts = (location.hash || '').replace('#', '').split('-');
    if (parts.length !== 2) return;
    var a = assets.filter(function (x) { return x.id.toLowerCase() === parts[0]; })[0];
    if (a) state.asset = a.id;
    if (parts[1] === 'buy' || parts[1] === 'sell') state.side = parts[1];
  })();

  function asset() { return assets.filter(function (a) { return a.id === state.asset; })[0]; }
  function fiat() { return fiats.filter(function (f) { return f.id === state.fiat; })[0]; }
  function assetDecimals(a) { return a.usd >= 10000 ? 6 : a.usd >= 1000 ? 5 : a.usd >= 100 ? 4 : 2; }
  function money(n) { return fiat().symbol + V.fmt.int(n); }
  function assetAmount(n, a) { return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: assetDecimals(a) }); }

  /* Scene */
  V.stage.mount($('#hero-stage'), {
    core: { text: '₮', label: 'P2P', sub: 'Peer to peer', c1: '#1f7a5e', c2: '#7fd0b0', scale: 0.82 },
    tiles: assets.slice(0, 8).map(function (a) { return { text: a.glyph, c1: a.c1, c2: a.c2 }; })
  });

  /* Controls */
  function renderSide() {
    V.$$('.side-toggle button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-side') === state.side)); });
  }
  function renderAssets() {
    $('#assets').innerHTML = assets.map(function (a) {
      return '<button class="asset-chip" type="button" data-asset="' + a.id + '" aria-pressed="' + (a.id === state.asset) + '">' +
        '<span class="coin" style="--c1:' + a.c1 + ';--c2:' + a.c2 + '">' + V.esc(a.glyph) + '</span>' + a.id + '</button>';
    }).join('');
  }
  function renderSelects() {
    $('#fiat').innerHTML = fiats.map(function (f) {
      return '<option value="' + f.id + '"' + (f.id === state.fiat ? ' selected' : '') + '>' + f.id + '</option>';
    }).join('');
    var methods = V.p2p.payments[state.fiat];
    $('#payment').innerHTML = '<option value="all">All payment methods</option>' + methods.map(function (m) {
      return '<option value="' + m + '"' + (m === state.payment ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
    $('#amount-suffix').textContent = state.fiat;
    $('#amount-label').textContent = state.side === 'buy' ? 'I want to pay' : 'I want to receive';
  }
  function syncHash() {
    try { history.replaceState(null, '', '#' + state.asset.toLowerCase() + '-' + state.side); } catch (e) { /* ignore */ }
  }

  /* Offers */
  var current = {}, token = 0;

  function skeleton() {
    var row = '<div class="offer" aria-hidden="true"><div class="offer__who"><span class="skeleton" style="width:38px;height:38px;border-radius:12px"></span><span class="skeleton" style="width:110px"></span></div>' +
      '<span class="skeleton" style="width:90px;height:22px"></span><span class="skeleton" style="width:130px"></span><span class="skeleton" style="width:120px"></span><span class="skeleton" style="width:84px;height:36px;border-radius:10px;justify-self:end"></span></div>';
    $('#offers').innerHTML = row + row + row + row;
  }

  function offerHTML(o) {
    var a = asset(), side = state.side;
    var verb = side === 'buy' ? 'Buy' : 'Sell';
    return '<div class="offer" role="row">' +
      '<div class="offer__who" role="cell"><span class="avatar" style="--c1:' + o.advertiser.c1 + ';--c2:' + o.advertiser.c2 + '" aria-hidden="true">' +
        V.esc(o.advertiser.name.charAt(0)) + '<i></i></span>' +
        '<span class="offer__name"><strong>' + V.esc(o.advertiser.name) + '</strong><small>' + V.fmt.int(o.advertiser.orders) + ' orders, ' + o.advertiser.completion + '% completed</small></span></div>' +
      '<div class="offer__price" role="cell">' + fiat().symbol + V.fmt.price(o.price) + ' <small>per ' + a.id + '</small></div>' +
      '<div class="offer__cell offer__cell--limits" role="cell">' +
        '<div><span>Available </span>' + assetAmount(o.available, a) + ' ' + a.id + '</div>' +
        '<div><span>Limit </span>' + money(o.minFiat) + ' to ' + money(o.maxFiat) + '</div></div>' +
      '<div class="offer__cell offer__cell--pay" role="cell"><div class="chips">' +
        o.payments.map(function (m) { return '<span class="chip">' + V.esc(m) + '</span>'; }).join('') + '</div></div>' +
      '<div class="offer__act" role="cell"><button class="btn btn--sm btn--' + side + '" type="button" data-offer="' + o.id + '">' + verb + ' ' + a.id + '</button></div>' +
      '</div>';
  }

  function load() {
    var mine = ++token;
    skeleton();
    $('#market-line').innerHTML = '&nbsp;';
    return V.api.getOffers(state).then(function (res) {
      if (mine !== token) return;
      current = {};
      res.offers.forEach(function (o) { current[o.id] = o; });
      var a = res.asset, f = res.fiat;
      $('#market-line').innerHTML = '<span>Reference price <strong>' + f.symbol + V.fmt.price(res.mid) + '</strong> per ' + a.id + '</span>' +
        '<span><strong>' + res.offers.length + '</strong> of ' + res.total + ' offers shown</span>';
      if (!res.offers.length) {
        $('#offers').innerHTML = '<div class="offers__state"><h2>No offers match</h2><p>Try a different amount or payment method.</p></div>';
        return;
      }
      $('#offers').innerHTML = res.offers.map(offerHTML).join('');
    });
  }

  /* Order drawer */
  var dlg = $('#drawer'), form = $('#order-form'), active = null, pay = null;

  function openDrawer(id) {
    var o = current[id];
    if (!o) return;
    active = o;
    var a = asset(), side = state.side, verb = side === 'buy' ? 'Buy' : 'Sell';
    pay = o.payments.indexOf(state.payment) > -1 ? state.payment : o.payments[0];

    var eyebrow = $('#drawer-eyebrow');
    eyebrow.textContent = verb + ' ' + a.id;
    eyebrow.className = 'is-' + side;
    $('#drawer-title').textContent = o.advertiser.name;
    $('#facts').innerHTML =
      '<div><dt>Price</dt><dd>' + fiat().symbol + V.fmt.price(o.price) + '</dd></div>' +
      '<div><dt>Available</dt><dd>' + assetAmount(o.available, a) + ' ' + a.id + '</dd></div>' +
      '<div><dt>Limit</dt><dd>' + money(o.minFiat) + ' to ' + money(o.maxFiat) + '</dd></div>' +
      '<div><dt>Payment window</dt><dd>' + o.payWindow + '</dd></div>';
    $('#pay-label').textContent = side === 'buy' ? 'I want to pay' : 'I want to sell';
    $('#pay-suffix').textContent = side === 'buy' ? state.fiat : a.id;
    $('#receive-label').textContent = 'I will receive';
    var input = $('#order-amount');
    input.value = side === 'buy' && state.amount ? state.amount : '';
    $('#pay-options').innerHTML = o.payments.map(function (m) {
      return '<button type="button" data-pay="' + m + '" aria-pressed="' + (m === pay) + '">' + V.esc(m) + '</button>';
    }).join('');
    var place = $('#place');
    place.textContent = verb + ' ' + a.id;
    place.className = 'btn btn--block btn--' + side;
    place.disabled = false;
    $('#form-error').textContent = '';
    updateReceive();

    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    document.documentElement.style.overflow = 'hidden';
    setTimeout(function () { input.focus(); }, 60);
  }

  function parsed() { return parseFloat(($('#order-amount').value || '').replace(/,/g, '')); }

  function updateReceive() {
    var a = asset(), v = parsed(), out = '—';
    if (v > 0 && active) {
      out = state.side === 'buy' ? assetAmount(v / active.price, a) + ' ' + a.id : fiat().symbol + V.fmt.price(v * active.price);
    }
    $('#receive-value').textContent = out;
  }

  function closeDrawer() {
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }
  dlg.addEventListener('close', function () { document.documentElement.style.overflow = ''; });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDrawer(); });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#order-amount').addEventListener('input', function () { $('#form-error').textContent = ''; updateReceive(); });
  $('#pay-options').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pay]');
    if (!b) return;
    pay = b.getAttribute('data-pay');
    V.$$('#pay-options button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!active) return;
    var v = parsed(), err = $('#form-error');
    if (!(v > 0)) { err.textContent = 'Enter an amount to continue.'; return; }
    var fiatValue = state.side === 'buy' ? v : v * active.price;
    if (fiatValue < active.minFiat || fiatValue > active.maxFiat) {
      err.textContent = 'The amount must be worth between ' + money(active.minFiat) + ' and ' + money(active.maxFiat) + '.';
      return;
    }
    var btn = $('#place');
    btn.disabled = true;
    V.api.createOrder({ side: state.side, asset: state.asset, fiat: state.fiat, offer: active.id, amount: v, payment: pay }).then(function (res) {
      closeDrawer();
      V.toast(res.message);
    });
  });

  /* Events */
  $('.side-toggle').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.getAttribute('data-side') === state.side) return;
    state.side = b.getAttribute('data-side');
    renderSide(); renderSelects(); syncHash(); load();
  });
  $('#assets').addEventListener('click', function (e) {
    var b = e.target.closest('[data-asset]');
    if (!b || b.getAttribute('data-asset') === state.asset) return;
    state.asset = b.getAttribute('data-asset');
    renderAssets(); syncHash(); load();
  });
  $('#fiat').addEventListener('change', function () {
    state.fiat = this.value; state.payment = 'all';
    renderSelects(); load();
  });
  $('#payment').addEventListener('change', function () { state.payment = this.value; load(); });
  var timer;
  $('#amount').addEventListener('input', function () {
    var el = this;
    clearTimeout(timer);
    timer = setTimeout(function () { state.amount = el.value.replace(/,/g, '').trim(); load(); }, 280);
  });
  $('#filters').addEventListener('submit', function (e) { e.preventDefault(); });
  $('#refresh').addEventListener('click', function () {
    var btn = this;
    btn.classList.add('is-spinning');
    load().then(function () { btn.classList.remove('is-spinning'); });
  });
  $('#offers').addEventListener('click', function (e) {
    var b = e.target.closest('[data-offer]');
    if (b) openDrawer(b.getAttribute('data-offer'));
  });

  renderSide(); renderAssets(); renderSelects(); load();
})();
