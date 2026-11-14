/*
 * Motion background: layered silk waves drawn on a canvas.
 * Colours come from the theme tokens (--accent, --brand), so it follows light
 * and dark. The loop pauses off screen and in hidden tabs, and a single static
 * frame is drawn when the visitor prefers reduced motion.
 *
 *   Verve.motion.mount(hostElement)
 */
(function () {
  var V = window.Verve;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* base: vertical position, amp/amp2: wave heights as a share of the height,
     k/k2: waves across the width, sp/sp2: speed (rad/s), c: starting colour */
  var LAYERS = [
    { base: 0.40, amp: 0.10, k: 0.9, sp: 0.20, ph: 0.0, amp2: 0.040, k2: 2.1, sp2: -0.14, alpha: 0.10, c: 'a' },
    { base: 0.48, amp: 0.11, k: 1.2, sp: -0.17, ph: 1.3, amp2: 0.035, k2: 2.6, sp2: 0.20, alpha: 0.12, c: 'b' },
    { base: 0.56, amp: 0.10, k: 1.0, sp: 0.15, ph: 2.4, amp2: 0.045, k2: 1.9, sp2: -0.11, alpha: 0.13, c: 'a' },
    { base: 0.64, amp: 0.12, k: 1.4, sp: -0.22, ph: 3.1, amp2: 0.030, k2: 3.0, sp2: 0.16, alpha: 0.14, c: 'b' },
    { base: 0.72, amp: 0.10, k: 0.8, sp: 0.18, ph: 4.2, amp2: 0.040, k2: 2.4, sp2: -0.19, alpha: 0.16, c: 'a' },
    { base: 0.80, amp: 0.09, k: 1.3, sp: -0.14, ph: 5.0, amp2: 0.030, k2: 2.8, sp2: 0.13, alpha: 0.18, c: 'b' }
  ];

  function mount(host) {
    var canvas = document.createElement('canvas');
    host.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var w = 0, h = 0, running = false, visible = true, raf = 0;
    var start = performance.now(), shift = 0, shiftTarget = 0;
    var col = { a: '#b9d78f', b: '#2c5f46' };

    function readColors() {
      var cs = getComputedStyle(document.documentElement);
      col.a = cs.getPropertyValue('--accent').trim() || col.a;
      col.b = cs.getPropertyValue('--brand').trim() || col.b;
    }

    function draw(now) {
      var t = (now - start) / 1000;
      shift += (shiftTarget - shift) * 0.05;
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < LAYERS.length; i++) {
        var L = LAYERS[i];
        var grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, col[L.c]);
        grad.addColorStop(1, col[L.c === 'a' ? 'b' : 'a']);

        ctx.beginPath();
        for (var x = 0; x <= w + 12; x += 12) {
          var u = x / w;
          var y = h * L.base
            + Math.sin(u * Math.PI * 2 * L.k + t * L.sp + L.ph + shift) * h * L.amp
            + Math.sin(u * Math.PI * 2 * L.k2 + t * L.sp2 + shift * 0.5) * h * L.amp2;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = Math.min(1, L.alpha * 2.4);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = grad;
        ctx.stroke();

        ctx.lineTo(w + 12, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.globalAlpha = L.alpha;
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function loop(now) {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(loop);
    }
    function play() {
      if (running || reduce.matches || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(loop);
    }
    function pause() { running = false; cancelAnimationFrame(raf); }

    function size() {
      var r = host.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width; h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    }

    var zone = host.parentNode;
    if (!reduce.matches && zone) {
      zone.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        var b = zone.getBoundingClientRect();
        shiftTarget = (((e.clientX - b.left) / b.width) * 2 - 1) * 1.1;
      });
      zone.addEventListener('pointerleave', function () { shiftTarget = 0; });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) play(); else pause();
      }).observe(host);
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); else play(); });

    /* Follow theme changes */
    var refresh = function () { readColors(); draw(performance.now()); };
    if (window.MutationObserver) new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    var dark = window.matchMedia('(prefers-color-scheme: dark)');
    if (dark.addEventListener) dark.addEventListener('change', refresh);

    if (window.ResizeObserver) new ResizeObserver(size).observe(host); else window.addEventListener('resize', size);

    readColors();
    size();
    play();
  }

  V.motion = { mount: mount };
})();
