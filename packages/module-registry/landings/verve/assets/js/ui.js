/* Shared UI: layout, theme, toast, press effect, slider, tabs, photo card renderer */
(function () {
  var V = window.Verve;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  V.$ = function (sel, root) { return (root || document).querySelector(sel); };
  V.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  V.esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  V.reduceMotion = function () { return reduce.matches; };

  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
  }

  /* ---------- Theme ---------- */
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  V.theme = {
    effective: function () {
      var t = document.documentElement.getAttribute('data-theme');
      return t || (dark.matches ? 'dark' : 'light');
    },
    toggle: function () {
      var next = V.theme.effective() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store('verve-theme', next);
      V.theme.sync();
    },
    sync: function () {
      var btn = V.$('[data-theme-toggle]');
      if (!btn) return;
      var isDark = V.theme.effective() === 'dark';
      btn.innerHTML = V.icon(isDark ? 'sun' : 'moon');
      btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    }
  };
  if (dark.addEventListener) dark.addEventListener('change', function () { V.theme.sync(); });

  /* ---------- Toast ---------- */
  var toastEl, toastTimer;
  V.toast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 3200);
  };

  /* ---------- Layout ---------- */
  var NAV = [
    { id: 'accounts', label: 'Accounts', href: 'accounts.html' },
    { id: 'subscriptions', label: 'Subscriptions', href: 'subscriptions.html' },
    { id: 'games', label: 'Game credit', href: 'games.html' },
    { id: 'p2p', label: 'P2P', href: 'p2p.html' }
  ];

  /* "Let's talk" panel: each tile opens a social channel in a new tab */
  function talkHTML() {
    return '<section class="talk" aria-labelledby="talk-title">' +
      '<div class="talk__copy"><h2 id="talk-title">Let’s talk</h2>' +
      '<p>Questions about a listing, an order or a P2P offer? Message the team on the channel you already use.</p></div>' +
      '<ul class="talk__grid">' + V.social.map(function (s) {
        return '<li><a class="talk__tile" href="' + s.href + '" target="_blank" rel="noopener noreferrer" style="--c1:' + s.c1 + ';--c2:' + s.c2 + '" aria-label="' + s.label + ' (opens in a new tab)">' +
          '<span class="talk__icon" aria-hidden="true">' + V.icon(s.icon) + '</span><span class="talk__label">' + s.label + '</span></a></li>';
      }).join('') + '</ul></section>';
  }

  /* Back button: returns to the page the visitor came from, or to the parent page */
  V.back = function () {
    var el = V.$('[data-back]');
    if (!el) return;
    var label = V.$('span', el);
    var here = location.pathname.split('/').pop() || 'index.html';
    var from = '';
    try {
      if (document.referrer) {
        var u = new URL(document.referrer);
        if (u.origin === location.origin) from = u.pathname.split('/').pop() || 'index.html';
      }
    } catch (e) { from = ''; }
    var names = {
      'index.html': 'Back to home', 'accounts.html': 'Back to Accounts', 'subscriptions.html': 'Back to Subscriptions',
      'games.html': 'Back to Game credit', 'p2p.html': 'Back to P2P'
    };
    if (from && from !== here && names[from]) {
      label.textContent = names[from];
      el.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (window.history.length > 1) { e.preventDefault(); window.history.back(); }
      });
    }
  };

  V.layout = {
    mount: function () {
      var active = document.body.getAttribute('data-nav') || '';
      var header = V.$('#site-header');
      var footer = V.$('#site-footer');

      if (header) {
        header.className = 'site-header';
        header.innerHTML =
          '<div class="container nav">' +
            '<a class="brand" href="/" aria-label="Verve home"><span class="brand__mark" aria-hidden="true">v</span>verve</a>' +
            '<nav class="nav__links" id="nav-links" aria-label="Primary">' +
              NAV.map(function (n) {
                return '<a class="nav__link" href="' + n.href + '"' + (n.id === active ? ' aria-current="page"' : '') + '>' + n.label + '</a>';
              }).join('') +
            '</nav>' +
            '<div class="nav__actions">' +
              '<button class="icon-btn" type="button" data-theme-toggle></button>' +
              '<button class="btn btn--sm nav__signin" type="button" data-signin>Sign in</button>' +
              '<button class="icon-btn nav__menu" type="button" aria-expanded="false" aria-controls="nav-links" aria-label="Open menu" data-menu>' + V.icon('menu') + '</button>' +
            '</div>' +
          '</div>';
        V.theme.sync();
        var menu = V.$('[data-menu]', header);
        menu.addEventListener('click', function () {
          var open = header.getAttribute('data-menu') === 'open';
          header.setAttribute('data-menu', open ? 'closed' : 'open');
          menu.setAttribute('aria-expanded', String(!open));
          menu.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
          menu.innerHTML = V.icon(open ? 'menu' : 'close');
        });
      }

      if (footer) {
        footer.className = 'site-footer';
        footer.innerHTML =
          '<div class="container">' + talkHTML() +
            '<div class="footer__grid">' +
              '<div><a class="brand" href="/"><span class="brand__mark" aria-hidden="true">v</span>verve</a>' +
                '<p class="footer__blurb">The storefront for AYZEN Market. Accounts, subscriptions, game credit and peer-to-peer exchange in one catalogue.</p></div>' +
              '<div class="footer__col"><h2>Catalogue</h2>' +
                NAV.map(function (n) { return '<a href="' + n.href + '">' + n.label + '</a><br>'; }).join('') + '</div>' +
              '<div class="footer__col"><h2>About this build</h2>' +
                '<p>Listings, prices and offers are sample data until the backend is connected.</p>' +
                '<p style="margin-top:10px"><a href="https://ayzen.tech/marketplace/hub" target="_blank" rel="noopener noreferrer">AYZEN Market hub</a></p></div>' +
            '</div>' +
            '<div class="footer__base"><span>© 2026 AYZEN</span><span>Verve marketplace front end</span></div>' +
          '</div>';
      }

      V.back();

      document.addEventListener('click', function (e) {
        if (e.target.closest('[data-theme-toggle]')) V.theme.toggle();
        if (e.target.closest('[data-signin]')) window.location.href = '/login';
      });
    }
  };

  /* ---------- Press effect: show the card sinking, then lift it, then navigate ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-press]');
    if (!a) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === '_blank') return;
    e.preventDefault();
    a.classList.add('is-selected');
    var href = a.href;
    setTimeout(function () { window.location.href = href; }, reduce.matches ? 0 : 300);
  });
  window.addEventListener('pageshow', function () {
    V.$$('[data-press].is-selected').forEach(function (el) { el.classList.remove('is-selected'); });
  });

  /* ---------- Photo card ---------- */
  V.pcard = function (o) {
    var glyph = o.glyph ? V.esc(o.glyph) : V.icon(o.icon);
    return '<a class="pcard" href="' + o.href + '" data-press style="--c1:' + o.c1 + ';--c2:' + o.c2 + '">' +
      '<span class="art" aria-hidden="true">' +
        (o.image ? '<img class="art__img" src="' + V.esc(o.image) + '" alt="" loading="lazy">' : '') +
        '<span class="art__orb"></span><span class="art__plate"></span></span>' +
      '<span class="glyph pcard__glyph" aria-hidden="true">' + glyph + '</span>' +
      (o.chip ? '<span class="pcard__chip">' + V.esc(o.chip) + '</span>' : '') +
      '<span class="pcard__caption"><span class="pcard__text"><strong>' + V.esc(o.title) + '</strong><small>' + V.esc(o.meta) + '</small></span>' +
      '<span class="pcard__go" aria-hidden="true">' + V.icon('arrow') + '</span></span></a>';
  };

  /* ---------- Slider ---------- */
  V.slider = function (root) {
    var track = V.$('.slider__track', root);
    var prev = V.$('[data-prev]', root);
    var next = V.$('[data-next]', root);
    var bar = V.$('.slider__progress span', root);
    if (!track) return { update: function () {} };

    function step() { return Math.max(220, track.clientWidth * 0.8); }
    function update() {
      var max = track.scrollWidth - track.clientWidth;
      var overflow = max > 4;
      var controls = V.$('.slider__controls', root);
      if (controls) controls.hidden = !overflow;
      if (bar) bar.parentNode.hidden = !overflow;
      if (prev) prev.disabled = track.scrollLeft <= 2;
      if (next) next.disabled = track.scrollLeft >= max - 2;
      if (bar) {
        var visible = max > 0 ? track.clientWidth / track.scrollWidth : 1;
        var pos = max > 0 ? track.scrollLeft / max : 0;
        bar.style.transform = 'translateX(' + (pos * (1 - visible) * 100).toFixed(2) + '%) scaleX(' + visible.toFixed(3) + ')';
        bar.style.transformOrigin = 'left center';
      }
    }
    if (prev) prev.addEventListener('click', function () { track.scrollBy({ left: -step(), behavior: reduce.matches ? 'auto' : 'smooth' }); });
    if (next) next.addEventListener('click', function () { track.scrollBy({ left: step(), behavior: reduce.matches ? 'auto' : 'smooth' }); });
    track.addEventListener('scroll', update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(track);
    window.addEventListener('resize', update);

    track.addEventListener('keydown', function (e) {
      if (e.target !== track) return;
      if (e.key === 'ArrowRight') { track.scrollBy({ left: step() / 2, behavior: 'smooth' }); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { track.scrollBy({ left: -step() / 2, behavior: 'smooth' }); e.preventDefault(); }
    });

    /* Mouse drag to scroll; a drag never counts as a click */
    var down = null, dragging = false, suppress = false;
    track.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = { x: e.clientX, left: track.scrollLeft };
    });
    track.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - down.x;
      if (!dragging && Math.abs(dx) > 5) {
        dragging = true;
        track.classList.add('is-dragging');
        try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      if (dragging) track.scrollLeft = down.left - dx;
    });
    function end() {
      if (dragging) { suppress = true; setTimeout(function () { suppress = false; }, 0); }
      dragging = false; down = null;
      track.classList.remove('is-dragging');
    }
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('click', function (e) {
      if (suppress) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    track.addEventListener('dragstart', function (e) { e.preventDefault(); });

    update();
    return { update: update };
  };

  /* ---------- Tabs (sliding thumb, arrow-key navigation) ---------- */
  V.tabs = function (list, onChange) {
    var tabs = V.$$('[role="tab"]', list);
    var thumb = V.$('.segmented__thumb', list);

    function place() {
      var on = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0];
      if (!on || !thumb) return;
      thumb.style.width = on.offsetWidth + 'px';
      thumb.style.transform = 'translateX(' + on.offsetLeft + 'px)';
    }
    function select(id, focus) {
      tabs.forEach(function (t) {
        var isOn = t.getAttribute('data-tab') === id;
        t.setAttribute('aria-selected', String(isOn));
        t.tabIndex = isOn ? 0 : -1;
        if (isOn && focus) t.focus();
      });
      place();
      if (onChange) onChange(id);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function (e) {
        var to = null;
        if (e.key === 'ArrowRight') to = tabs[(i + 1) % tabs.length];
        if (e.key === 'ArrowLeft') to = tabs[(i - 1 + tabs.length) % tabs.length];
        if (e.key === 'Home') to = tabs[0];
        if (e.key === 'End') to = tabs[tabs.length - 1];
        if (to) { e.preventDefault(); select(to.getAttribute('data-tab'), true); }
      });
    });
    window.addEventListener('resize', place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    place();
    requestAnimationFrame(function () { list.classList.add('is-ready'); });
    return { select: select, place: place };
  };
})();
