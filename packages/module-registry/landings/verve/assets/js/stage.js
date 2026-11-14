/*
 * 3D stage: a glass card with real thickness floating at the centre of an
 * orbit of tiles. Pure CSS 3D transforms driven by one requestAnimationFrame
 * loop, so there is no library dependency and nothing to download.
 *
 *   Verve.stage.mount(hostElement, {
 *     core:  { icon | text, label, sub, c1, c2, scale },
 *     tiles: [{ icon | text, c1, c2 }, ...]
 *   })
 */
(function () {
  var V = window.Verve;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var TILT = -15; /* orbit plane tilt in degrees; negative shows the ring from slightly above */

  function glyphHTML(o) { return o.icon ? V.icon(o.icon) : V.esc(o.text || ''); }

  function mount(host, cfg) {
    var core = cfg.core, tiles = cfg.tiles || [];
    var scale = core.scale || 1;

    host.classList.add('stage');
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML =
      '<div class="stage__glow"></div>' +
      '<div class="stage__world">' +
        '<div class="stage__orbit">' +
          '<span class="stage__ring"></span><span class="stage__ring stage__ring--inner"></span>' +
          tiles.map(function (t) {
            return '<span class="stage__tile" style="--c1:' + t.c1 + ';--c2:' + t.c2 + '">' + glyphHTML(t) + '</span>';
          }).join('') +
        '</div>' +
        '<div class="stage__core" style="--c1:' + core.c1 + ';--c2:' + core.c2 + ';--s:' + scale + '">' +
          '<span class="stage__layer stage__layer--2"></span><span class="stage__layer stage__layer--1"></span>' +
          '<div class="stage__face">' +
            '<span class="glyph stage__core-glyph">' + glyphHTML(core) + '</span>' +
            '<strong>' + V.esc(core.label || '') + '</strong>' +
            (core.sub ? '<small>' + V.esc(core.sub) + '</small>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    var world = host.querySelector('.stage__world');
    var orbit = host.querySelector('.stage__orbit');
    var rings = host.querySelectorAll('.stage__ring');
    var els = Array.prototype.slice.call(host.querySelectorAll('.stage__tile'));
    var zone = host.closest('[data-stage-zone]') || host;

    var R = 200, phi = 0.5, rx = -6, ry = 0, tx = -6, ty = 0, running = false, visible = true, last = 0, raf = 0, pointerActive = false;
    var step = tiles.length ? (Math.PI * 2) / tiles.length : 0;
    orbit.style.transform = 'rotateX(' + TILT + 'deg)';

    function size() {
      var w = host.clientWidth, h = host.clientHeight;
      R = Math.max(86, Math.min(w * 0.4, h * 0.78, cfg.big ? 270 : 250));
      var ts = Math.max(0.72, Math.min(cfg.big ? 1.3 : 1.1, R / 210));
      els.forEach(function (el) { el.style.setProperty('--ts', ts.toFixed(3)); });
      rings[0].style.cssText = 'width:' + (R * 2) + 'px;height:' + (R * 2) + 'px;left:' + (-R) + 'px;top:' + (-R) + 'px';
      var r2 = R * 0.62;
      rings[1].style.cssText = 'width:' + (r2 * 2) + 'px;height:' + (r2 * 2) + 'px;left:' + (-r2) + 'px;top:' + (-r2) + 'px';
      if (!core.scale) host.querySelector('.stage__core').style.setProperty('--s', Math.max(0.7, Math.min(cfg.big ? 1.3 : 1.05, R / 215)).toFixed(3));
      draw();
    }

    function draw() {
      world.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
      for (var i = 0; i < els.length; i++) {
        var a = phi + i * step;
        var x = R * Math.sin(a), z = R * Math.cos(a);
        var depth = (z / R + 1) / 2; /* 0 at the back, 1 at the front */
        els[i].style.transform = 'translate3d(' + x.toFixed(1) + 'px,0,' + z.toFixed(1) + 'px) rotateX(' + (-TILT) + 'deg)';
        els[i].style.opacity = (0.42 + 0.58 * depth).toFixed(3);
      }
    }

    function frame(t) {
      if (!running) return;
      var dt = Math.min(0.05, (t - last) / 1000 || 0.016);
      last = t;
      phi += 0.14 * dt;
      if (!pointerActive) { tx = -6 + Math.sin(t / 2600) * 2.5; ty = Math.sin(t / 3400) * 7; }
      rx += (tx - rx) * 0.07;
      ry += (ty - ry) * 0.07;
      draw();
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running || reduce.matches || !visible || document.hidden) return;
      running = true; last = performance.now(); raf = requestAnimationFrame(frame);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }

    if (!reduce.matches) {
      zone.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        var b = zone.getBoundingClientRect();
        var nx = ((e.clientX - b.left) / b.width) * 2 - 1;
        var ny = ((e.clientY - b.top) / b.height) * 2 - 1;
        pointerActive = true;
        ty = Math.max(-1, Math.min(1, nx)) * 18;
        tx = -6 - Math.max(-1, Math.min(1, ny)) * 9;
      });
      zone.addEventListener('pointerleave', function () { pointerActive = false; });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        visible ? start() : stop();
      }).observe(host);
    }
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
    if (window.ResizeObserver) new ResizeObserver(size).observe(host); else window.addEventListener('resize', size);

    size();
    start();
    return { stop: stop, start: start };
  }

  V.stage = { mount: mount };
})();
