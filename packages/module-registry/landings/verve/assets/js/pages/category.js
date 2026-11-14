/* Category pages: accounts, subscriptions, games */
(function () {
  var V = window.Verve, $ = V.$;
  V.layout.mount();

  var cat = document.body.getAttribute('data-cat');
  var meta = V.categories.filter(function (c) { return c.id === cat; })[0];

  V.api.getPlatforms(cat).then(function (list) {
    V.stage.mount($('#hero-stage'), {
      core: { icon: meta.icon, label: meta.label, sub: list.length + ' ' + meta.noun, c1: meta.c1, c2: meta.c2, scale: 0.82 },
      tiles: list.slice(0, 8).map(function (p) { return { icon: p.icon, c1: p.c1, c2: p.c2 }; })
    });

    var grid = $('#grid'), count = $('#count'), input = $('#q');

    function render(query) {
      var q = (query || '').trim().toLowerCase();
      var shown = list.filter(function (p) {
        return !q || (p.name + ' ' + p.tagline).toLowerCase().indexOf(q) > -1;
      });
      count.textContent = V.fmt.plural(shown.length, meta.noun.replace(/s$/, ''), meta.noun) + (q ? ' match' : '');
      if (!shown.length) {
        grid.className = '';
        grid.innerHTML = '<div class="empty"><h2>Nothing matches "' + V.esc(query) + '"</h2><p>Try another name, or clear the search.</p>' +
          '<button class="btn" type="button" data-clear>Clear search</button></div>';
        return;
      }
      grid.className = 'card-grid';
      grid.innerHTML = shown.map(function (p) {
        var info = V.cardInfo(cat, p);
        return V.pcard({ href: V.platformHref(cat, p.id), c1: p.c1, c2: p.c2, icon: p.icon, title: p.name, meta: info.meta, chip: info.chip });
      }).join('');
    }

    input.addEventListener('input', function () { render(input.value); });
    grid.addEventListener('click', function (e) {
      if (e.target.closest('[data-clear]')) { input.value = ''; render(''); input.focus(); }
    });
    render('');
  });
})();
