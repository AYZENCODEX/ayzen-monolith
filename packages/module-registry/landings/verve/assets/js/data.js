/*
 * Static catalogue data.
 *
 * Everything here is sample content. Pages never read this file directly:
 * they go through Verve.api (api.js), so a real backend can replace the
 * source without touching any page code.
 */
(function () {
  var V = (window.Verve = window.Verve || {});

  /* ---------- Formatting ---------- */
  function group(n) { return Math.round(n).toLocaleString('en-US'); }
  V.fmt = {
    int: group,
    usd: function (n) {
      var r = Math.round(n * 100) / 100;
      return '$' + (r % 1 === 0 ? group(r) : r.toFixed(2));
    },
    compact: function (n) {
      if (n == null) return '';
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'K';
      return String(n);
    },
    years: function (y) { return y + (y === 1 ? ' yr' : ' yrs'); },
    plural: function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); },
    /* Price with sensible precision for any magnitude */
    price: function (n) {
      if (n >= 1000) return group(n);
      if (n >= 100) return n.toFixed(2);
      if (n >= 1) return n.toFixed(2);
      return n.toFixed(3);
    },
    /* Short form for tight spaces such as photo cards */
    short: function (n) {
      if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
      if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
      return V.fmt.price(n);
    }
  };

  /* ---------- Categories ---------- */
  V.categories = [
    { id: 'accounts', label: 'Accounts', href: 'accounts.html', title: 'Accounts worth a look',
      blurb: 'Pick a platform to see profiles with their age, audience and price.', icon: 'user', noun: 'platforms',
      c1: '#2c5f46', c2: '#b9d78f' },
    { id: 'subscriptions', label: 'Subscriptions', href: 'subscriptions.html', title: 'Subscriptions',
      blurb: 'Premium plans for the apps you already use, from 1 to 12 months.', icon: 'star', noun: 'services',
      c1: '#6d3fa8', c2: '#c9a4ef' },
    { id: 'games', label: 'Game credit', href: 'games.html', title: 'Game credit',
      blurb: 'Top up diamonds, UC, gems and gift credit.', icon: 'gamepad', noun: 'games',
      c1: '#d0581f', c2: '#f5c45e' },
    { id: 'p2p', label: 'P2P', href: 'p2p.html', title: 'P2P exchange',
      blurb: 'Buy and sell crypto directly with other people.', icon: 'swap', noun: 'assets',
      c1: '#1f7a5e', c2: '#7fd0b0' }
  ];

  V.platformHref = function (cat, id) { return cat + '-' + id + '.html'; };

  function plat(id, name, icon, c1, c2, tagline, extra) {
    var o = { id: id, name: name, icon: icon, c1: c1, c2: c2, tagline: tagline };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  /* ---------- Accounts ---------- */
  var TIERS = ['Starter', 'Established', 'Prime', 'Signature'];

  /* listings: [age in years, audience count (null when the platform has none), price in USD] */
  var accounts = [
    plat('gmail', 'Gmail', 'mail', '#c9533f', '#f2b27c', 'Aged personal mailboxes', {
      audience: null, listings: [[2, null, 18], [4, null, 29], [6, null, 44], [8, null, 62]] }),
    plat('facebook', 'Facebook', 'facebook', '#3358b8', '#86a9ee', 'Profiles and pages with history', {
      audience: 'Followers', listings: [[3, 2100, 24], [5, 8400, 38], [7, 15600, 59], [9, 34000, 96]] }),
    plat('x', 'X', 'x', '#1a2620', '#5b6d62', 'Established handles', {
      audience: 'Followers', listings: [[3, 3400, 26], [5, 12600, 56], [7, 26000, 88], [9, 58000, 140]] }),
    plat('telegram', 'Telegram', 'send', '#2a86b8', '#82d3ea', 'Channels with an audience', {
      audience: 'Subscribers', listings: [[1, 2400, 18], [2.5, 17100, 42], [3, 41000, 85], [4, 96000, 160]] }),
    plat('instagram', 'Instagram', 'camera', '#b84876', '#f4a560', 'Profiles with reach', {
      audience: 'Followers', listings: [[2.5, 6100, 32], [3, 14300, 44], [4.5, 48200, 68], [6, 112000, 120]] }),
    plat('youtube', 'YouTube', 'play', '#c93f35', '#f3917a', 'Channels with watch history', {
      audience: 'Subscribers', listings: [[2, 1200, 40], [4, 8900, 70], [6, 21800, 95], [7, 64000, 210]] }),
    plat('linkedin', 'LinkedIn', 'linkedin', '#2a649a', '#74b5dc', 'Professional profiles', {
      audience: 'Connections', listings: [[2, 900, 30], [3.5, 5300, 63], [6, 12000, 110], [8, 28000, 180]] }),
    plat('tiktok', 'TikTok', 'note', '#17282a', '#3dbcad', 'Creator accounts', {
      audience: 'Followers', listings: [[2, 8200, 30], [3, 42000, 72], [4, 126000, 150], [5, 310000, 320]] }),
    plat('snapchat', 'Snapchat', 'ghost', '#c28f10', '#f1dc6b', 'Profiles with a Snap score', {
      audience: 'Followers', listings: [[2, 1800, 22], [4, 6400, 41], [5, 18500, 74], [7, 52000, 130]] }),
    plat('whatsapp', 'WhatsApp', 'phone', '#1f8a4c', '#8fdca0', 'Established numbers and profiles', {
      audience: null, listings: [[1, null, 20], [3, null, 34], [5, null, 52], [7, null, 78]] }),
    plat('pinterest', 'Pinterest', 'pin', '#b8262f', '#f08c8f', 'Boards with monthly viewers', {
      audience: 'Followers', listings: [[2, 2200, 19], [4, 9800, 36], [6, 31000, 68], [8, 84000, 125]] }),
    plat('discord', 'Discord', 'chat', '#4a52b8', '#9aa4f2', 'Servers with active members', {
      audience: 'Members', listings: [[1, 800, 16], [2, 3600, 30], [3, 12400, 55], [4, 41000, 110]] })
  ];

  accounts.forEach(function (p) {
    var code = p.id.slice(0, 2).toUpperCase();
    p.items = p.listings.map(function (l, i) {
      return {
        id: p.id + '-' + (i + 1),
        ref: 'VRV-' + code + '-' + (100 + i * 7 + p.id.length),
        tier: TIERS[i],
        age: l[0],
        audience: l[1],
        price: l[2]
      };
    });
    p.from = Math.min.apply(null, p.items.map(function (x) { return x.price; }));
    delete p.listings;
  });

  /* ---------- Subscriptions ---------- */
  var DURATIONS = [1, 2, 3, 6, 9, 12];
  var FACTOR = { 1: 1, 2: 0.95, 3: 0.92, 6: 0.88, 9: 0.84, 12: 0.8 };

  function plans(base) {
    return DURATIONS.map(function (m) {
      var total = Math.round(base * m * FACTOR[m]);
      return {
        id: m + 'm',
        months: m,
        total: total,
        perMonth: Math.round((total / m) * 100) / 100,
        savePct: Math.round((1 - FACTOR[m]) * 100)
      };
    });
  }

  var subscriptions = [
    plat('x', 'X Premium', 'x', '#1a2620', '#5b6d62', 'Verified badge and longer posts', { base: 8 }),
    plat('telegram', 'Telegram Premium', 'send', '#2a86b8', '#82d3ea', 'Bigger uploads, faster downloads', { base: 5 }),
    plat('facebook', 'Facebook Verified', 'facebook', '#3358b8', '#86a9ee', 'Verification and account support', { base: 12 }),
    plat('youtube', 'YouTube Premium', 'play', '#c93f35', '#f3917a', 'Ad-free video and background play', { base: 14 }),
    plat('spotify', 'Spotify Premium', 'music', '#23805a', '#8dd69c', 'Music without interruptions', { base: 11 }),
    plat('discord', 'Discord Nitro', 'chat', '#4a52b8', '#9aa4f2', 'Upgraded chat and uploads', { base: 10 }),
    plat('canva', 'Canva Pro', 'brush', '#7a45b5', '#c9a4ef', 'Design tools and brand kits', { base: 13 }),
    plat('vpn', 'VPN Premium', 'lock', '#1f5d66', '#6fc4c8', 'Private browsing on every device', { base: 4 }),
    plat('netflix', 'Netflix', 'tv', '#b3202a', '#f0868b', 'Streaming plan for movies and series', { base: 15 }),
    plat('googleone', 'Google One', 'cloud', '#2f6fc4', '#8fbaf0', 'Extra cloud storage', { base: 3 }),
    plat('linkedin', 'LinkedIn Premium', 'linkedin', '#2a649a', '#74b5dc', 'Career insights and InMail', { base: 30 }),
    plat('snapchat', 'Snapchat+', 'ghost', '#c28f10', '#f1dc6b', 'Extra features and early access', { base: 4 })
  ];
  subscriptions.forEach(function (p) {
    p.items = plans(p.base);
    p.from = p.items[0].total;
  });

  /* ---------- Game credit ---------- */
  /* variants: [amount, price in USD] */
  var games = [
    plat('freefire', 'Free Fire', 'flame', '#d9622a', '#f5c45e', 'Diamond top-up', {
      unit: 'Diamonds', variants: [[100, 1.2], [310, 3.4], [520, 5.6], [1060, 11], [2180, 22]] }),
    plat('pubg', 'PUBG Mobile', 'crosshair', '#47543a', '#d0b562', 'UC top-up', {
      unit: 'UC', variants: [[60, 1.1], [325, 5.5], [660, 10.5], [1800, 26], [3850, 52]] }),
    plat('xbox', 'Xbox', 'gamepad', '#1d7640', '#80d092', 'Gift credit', {
      unit: 'USD credit', gift: true, variants: [[5, 5.2], [10, 10.3], [15, 15.4], [25, 25.5], [50, 50.8]] }),
    plat('mlbb', 'Mobile Legends', 'bolt', '#2d4ca6', '#8fa8f2', 'Diamond top-up', {
      unit: 'Diamonds', variants: [[86, 1.5], [172, 3], [257, 4.5], [429, 7.2], [878, 14.4]] }),
    plat('minecraft', 'Minecraft', 'cube', '#437f35', '#b0d070', 'Minecoins', {
      unit: 'Minecoins', variants: [[330, 2], [1000, 6], [1720, 10], [3500, 20], [8000, 45]] }),
    plat('clash', 'Clash of Clans', 'crown', '#bd8226', '#f2d37c', 'Gem top-up', {
      unit: 'Gems', variants: [[500, 4.99], [1200, 9.99], [2500, 19.99], [6500, 49.99], [14000, 99.99]] }),
    plat('roblox', 'Roblox', 'block', '#b8403b', '#f1907c', 'Robux top-up', {
      unit: 'Robux', variants: [[400, 5], [800, 10], [1700, 20], [4500, 50], [10000, 100]] }),
    plat('codm', 'Call of Duty Mobile', 'shield', '#2b343b', '#8497a3', 'CP top-up', {
      unit: 'CP', variants: [[80, 1], [420, 5], [880, 10], [2400, 25], [5000, 50]] }),
    plat('valorant', 'Valorant', 'sword', '#c63a4a', '#f09aa4', 'VP top-up', {
      unit: 'VP', variants: [[475, 4.99], [1000, 9.99], [2050, 19.99], [3650, 34.99], [5350, 49.99]] }),
    plat('genshin', 'Genshin Impact', 'gem', '#6a5bc4', '#b9b0f2', 'Genesis Crystal top-up', {
      unit: 'Genesis Crystals', variants: [[60, 0.99], [330, 4.99], [1090, 14.99], [3880, 49.99], [6480, 99.99]] }),
    plat('steam', 'Steam Wallet', 'gamepad', '#1d3a52', '#6fa0c4', 'Gift credit', {
      unit: 'USD credit', gift: true, variants: [[5, 5.2], [10, 10.3], [20, 20.5], [50, 50.8], [100, 101]] }),
    plat('playstation', 'PlayStation', 'gamepad', '#1f4fa8', '#7fa6ee', 'Gift credit', {
      unit: 'USD credit', gift: true, variants: [[10, 10.3], [25, 25.5], [50, 50.8], [75, 76], [100, 101]] })
  ];
  games.forEach(function (p) {
    p.items = p.variants.map(function (v, i) {
      return { id: p.id + '-' + (i + 1), amount: v[0], price: v[1] };
    });
    p.from = p.items[0].price;
    delete p.variants;
  });

  V.catalog = { accounts: accounts, subscriptions: subscriptions, games: games };

  /* Look up one platform by category and id */
  V.find = function (cat, id) {
    var list = V.catalog[cat] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  /* Text shown on a platform photo card */
  V.cardInfo = function (cat, p) {
    if (cat === 'accounts') return { meta: 'From ' + V.fmt.usd(p.from), chip: V.fmt.plural(p.items.length, 'listing') };
    if (cat === 'subscriptions') return { meta: 'From ' + V.fmt.usd(p.from) + '/mo', chip: '1 to 12 months' };
    return { meta: 'From ' + V.fmt.usd(p.from), chip: V.fmt.plural(p.items.length, 'pack') };
  };

  /*
   * Social channels shown in the "Let's talk" footer.
   * These point at each network's home page as placeholders.
   * Replace each href with the real AYZEN profile URL.
   */
  V.social = [
    { id: 'telegram', label: 'Telegram', href: 'https://t.me/', icon: 'send', c1: '#2a86b8', c2: '#82d3ea' },
    { id: 'whatsapp', label: 'WhatsApp', href: 'https://www.whatsapp.com/', icon: 'phone', c1: '#1f8a4c', c2: '#8fdca0' },
    { id: 'facebook', label: 'Facebook', href: 'https://www.facebook.com/', icon: 'facebook', c1: '#3358b8', c2: '#86a9ee' },
    { id: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/', icon: 'camera', c1: '#b84876', c2: '#f4a560' },
    { id: 'x', label: 'X', href: 'https://x.com/', icon: 'x', c1: '#1a2620', c2: '#5b6d62' },
    { id: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/', icon: 'play', c1: '#c93f35', c2: '#f3917a' },
    { id: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/', icon: 'linkedin', c1: '#2a649a', c2: '#74b5dc' },
    { id: 'tiktok', label: 'TikTok', href: 'https://www.tiktok.com/', icon: 'note', c1: '#17282a', c2: '#3dbcad' }
  ];

  /* ---------- P2P reference data ---------- */
  /* usd: sample reference price in US dollars. AZN is the AYZEN token. */
  V.p2p = {
    assets: [
      { id: 'USDT', name: 'Tether', glyph: '₮', c1: '#1f7a5e', c2: '#7fd0b0', usd: 1 },
      { id: 'AZN', name: 'AYZEN token', glyph: 'A', c1: '#2c5f46', c2: '#b9d78f', usd: 0.42 },
      { id: 'BTC', name: 'Bitcoin', glyph: '₿', c1: '#c9801f', c2: '#f4cf79', usd: 98000 },
      { id: 'ETH', name: 'Ethereum', glyph: 'Ξ', c1: '#4a5aa8', c2: '#a6b3ee', usd: 3400 },
      { id: 'BNB', name: 'BNB', glyph: 'B', c1: '#b8901f', c2: '#f2dc82', usd: 620 },
      { id: 'USDC', name: 'USD Coin', glyph: '$', c1: '#2a6fc0', c2: '#8dbaf0', usd: 1 },
      { id: 'SOL', name: 'Solana', glyph: 'S', c1: '#7a45c0', c2: '#6fe0b0', usd: 180 },
      { id: 'XRP', name: 'XRP', glyph: 'X', c1: '#2b3a47', c2: '#8da2b5', usd: 2.4 },
      { id: 'TRX', name: 'TRON', glyph: 'T', c1: '#c4302b', c2: '#f09a8e', usd: 0.28 },
      { id: 'TON', name: 'Toncoin', glyph: 'T', c1: '#2a86c4', c2: '#82d0f0', usd: 5.5 },
      { id: 'DOGE', name: 'Dogecoin', glyph: 'Ð', c1: '#c9a227', c2: '#f5e08a', usd: 0.25 },
      { id: 'LTC', name: 'Litecoin', glyph: 'Ł', c1: '#5b6f85', c2: '#b5c4d4', usd: 95 }
    ],
    fiats: [
      { id: 'BDT', symbol: '৳', perUsd: 121.4 },
      { id: 'USD', symbol: '$', perUsd: 1 },
      { id: 'INR', symbol: '₹', perUsd: 86 },
      { id: 'AED', symbol: 'AED ', perUsd: 3.67 }
    ],
    payments: {
      BDT: ['bKash', 'Nagad', 'Rocket', 'Bank transfer', 'Upay'],
      USD: ['Bank transfer', 'Wise', 'Revolut'],
      INR: ['UPI', 'IMPS', 'Bank transfer'],
      AED: ['Bank transfer', 'Wise']
    }
  };
})();
