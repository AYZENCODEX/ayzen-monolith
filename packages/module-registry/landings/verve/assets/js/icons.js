/* Icon set. Simple stroke glyphs drawn for this project (generic shapes, not brand logos). */
(function () {
  var V = (window.Verve = window.Verve || {});

  var PATHS = {
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.8"/><path d="m4.5 8 7.5 5.5L19.5 8"/>',
    facebook: '<path d="M13.8 20v-7.2h2.5l.4-3h-2.9V8.1c0-.9.3-1.5 1.5-1.5h1.5V4a19 19 0 0 0-2.2-.1c-2.2 0-3.7 1.3-3.7 3.8v2.1H8.3v3h2.6V20"/>',
    x: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
    send: '<path d="M20.5 4 3.8 10.6l5.4 2.2 2.1 5.6 3.2-3.8 4.3 3.2Z"/><path d="m9.2 12.8 7-5.3"/>',
    camera: '<rect x="4" y="4" width="16" height="16" rx="4.8"/><circle cx="12" cy="12" r="3.7"/><circle cx="16.9" cy="7.1" r=".7" fill="currentColor" stroke="none"/>',
    play: '<rect x="3" y="6" width="18" height="12" rx="3.6"/><path d="m10.4 9.6 4.2 2.4-4.2 2.4Z" fill="currentColor"/>',
    linkedin: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.2"/><path d="M8 10.5V16M8 7.8v.01M11.5 16v-5.5m0 2.5a2.6 2.6 0 0 1 5.2 0V16"/>',
    note: '<path d="M14.2 4v10.6a3.6 3.6 0 1 1-3.6-3.6"/><path d="M14.2 4c.4 2.5 2.1 4.1 4.6 4.3"/>',
    music: '<path d="M9 17.5V6.5l10-2v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
    chat: '<path d="M5 5.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-6.2L8.5 20v-3H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z"/><path d="M8.5 10.2h7M8.5 13h4.5"/>',
    brush: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.5 0 2.2-.9 2.2-1.9 0-1.3-1.1-1.5-1.1-2.6 0-1 .8-1.7 1.9-1.7h1.9a3.6 3.6 0 0 0 3.6-3.6C20.5 6.8 16.7 3.5 12 3.5Z"/><circle cx="7.8" cy="11" r=".9" fill="currentColor" stroke="none"/><circle cx="10.6" cy="7.6" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
    shield: '<path d="M12 3.5 5 6v5.6c0 4.2 2.8 7.4 7 8.9 4.2-1.5 7-4.7 7-8.9V6Z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
    star: '<path d="m12 3.8 2.5 5.1 5.6.8-4.1 3.9 1 5.6L12 16.6 7 19.2l1-5.6-4.1-3.9 5.6-.8Z"/>',
    flame: '<path d="M12 3c1 3.2 5 5.2 5 10a5 5 0 0 1-10 0c0-2.2 1-3.4 2-4.6.3 1.4 1 2 1.8 2.3C11 8 11.2 5.4 12 3Z"/>',
    crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
    gamepad: '<path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 3.6l.9 4.3a2.6 2.6 0 0 1-4.5 2.2L15 15H9l-2.3 2.1a2.6 2.6 0 0 1-4.5-2.2l.9-4.3A4.5 4.5 0 0 1 7.5 7Z"/><path d="M8 10.2v3M6.5 11.7h3"/><circle cx="15.5" cy="10.8" r=".8" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12.8" r=".8" fill="currentColor" stroke="none"/>',
    cube: '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z"/><path d="m4 8 8 4.5L20 8M12 12.5v8"/>',
    crown: '<path d="M4 8.5 8 12l4-6.5 4 6.5 4-3.5-1.5 9h-13Z"/><path d="M6 20.5h12"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z"/>',
    block: '<rect x="5" y="5" width="14" height="14" rx="2.5" transform="rotate(-12 12 12)"/><rect x="10" y="10" width="4" height="4" rx=".8" transform="rotate(-12 12 12)"/>',
    cloud: '<path d="M7.5 18.5a4.2 4.2 0 0 1-.5-8.4A5.5 5.5 0 0 1 17.6 9a4.8 4.8 0 0 1-.1 9.5Z"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    swap: '<path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="m14.5 6-6 6 6 6"/>',
    right: '<path d="m9.5 6 6 6-6 6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.8M4 4v4h4M4 13a8 8 0 0 0 14.5 3.8M20 20v-4h-4"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    ghost: '<path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.8L14.3 20 12 18.2 9.7 20l-2.4-1.8Z"/><circle cx="9.5" cy="11" r=".9" fill="currentColor" stroke="none"/><circle cx="14.5" cy="11" r=".9" fill="currentColor" stroke="none"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.4a11 11 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z"/>',
    pin: '<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
    tv: '<rect x="3" y="5" width="18" height="12.5" rx="2.5"/><path d="M8 20.5h8M12 17.5v3"/>',
    gem: '<path d="M6.5 4h11l3.5 5-9 11L3 9Z"/><path d="M3 9h18M9.5 4 8 9l4 11M14.5 4 16 9l-4 11"/>',
    sword: '<path d="M14.5 5.5 20 4l-1.5 5.5L9 19l-4-4Z"/><path d="m4 20 3-3M8 16l-2.5 2.5"/>'
  };

  V.icon = function (name, size) {
    var body = PATHS[name] || PATHS.star;
    var dim = size ? ' width="' + size + '" height="' + size + '"' : '';
    return '<svg class="icon" viewBox="0 0 24 24"' + dim + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  };
})();
