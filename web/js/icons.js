'use strict';
/* Icone dell'interfaccia: disegno a linea, 24×24, colore del testo. */
const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  star: '<path d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  starFill: '<path fill="currentColor" d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.6l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M16 7l2.5 2.5M14 9l2 2"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
  id: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.5 16.2c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14 10h4.5M14 13.5h3"/>',
  note: '<path d="M14.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M14.5 3.5v5h5M8.5 13h7M8.5 16.5h5"/>',
  passkey: '<path d="M12 11v3.5c0 2.5-.7 4.4-2 6M8.6 7.2A5 5 0 0 1 17 11v1.5M7 11c0 1.8-.3 3.4-1 4.8M17 15.5c-.2 1.7-.6 3.2-1.3 4.5M4.5 8.3A8.5 8.5 0 0 1 19.8 7.5M20.4 11v1.5"/>',
  wifi: '<path d="M2.8 8.8a13 13 0 0 1 18.4 0M5.9 12a8.5 8.5 0 0 1 12.2 0M9 15.2a4 4 0 0 1 6 0"/><circle cx="12" cy="18.6" r=".9" fill="currentColor"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5M4.5 9.5h15M6 9.5v8M10 9.5v8M14 9.5v8M18 9.5v8M3.5 20h17"/>',
  doc: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><circle cx="12" cy="10" r="2.6"/><path d="M8.3 16.5c.8-1.6 2.1-2.4 3.7-2.4s2.9.8 3.7 2.4"/>',
  disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.2 6.2a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.3"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.9 12.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-12.2M10 10.5v6M14 10.5v6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18.5z"/>',
  cloudOk: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18.5z"/><path d="m9.5 13.8 1.8 1.8 3.4-3.4"/>',
  cloudErr: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18.5z"/><path d="M12 10.5v3M12 16h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.5l1.7-2M20 20v-4.5h-4.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  folder: '<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.5l2 2.5H18A2.5 2.5 0 0 1 20.5 9.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z"/>',
  vault: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5M6.5 20v1.5M17.5 20v1.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17.4 17.4 0 0 1-2.7 3.5M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  edit: '<path d="M4 20h4.5L19.3 9.2a2.1 2.1 0 0 0-3-3L5.5 17v3M14.5 7.5l2.9 2.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  clip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15"/>',
  open: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13M18 14v4a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V8.5A2.5 2.5 0 0 1 6 6h4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  wand: '<path d="m4 20 10.5-10.5M13 6l1-2.5L15 6l2.5 1-2.5 1-1 2.5L13 8l-2.5-1zM18.5 12.5l.6-1.5.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6z"/>',
  fingerprint: '<path d="M12 11v3.5c0 2.5-.7 4.4-2 6M8.6 7.2A5 5 0 0 1 17 11v1.5M7 11c0 1.8-.3 3.4-1 4.8M17 15.5c-.2 1.7-.6 3.2-1.3 4.5M4.5 8.3A8.5 8.5 0 0 1 19.8 7.5M20.4 11v1.5"/>',
  keyfile: '<path d="M14.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M14.5 3.5v5h5"/><circle cx="10" cy="14" r="2"/><path d="m11.4 12.6 3.1-3.1M13.5 10.5l1 1"/>',
  file: '<path d="M14.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M14.5 3.5v5h5"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
};
const TYPE_ICON = { login: 'key', card: 'card', identity: 'id', note: 'note', passkey: 'passkey', wifi: 'wifi', bank: 'bank', document: 'doc', license: 'disc', server: 'server', email: 'mail' };

function ic(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}
// Icona di una categoria: disegno per quelle predefinite, simbolo scelto dall'utente per i modelli personalizzati.
function typeIc(key, t) {
  if (TYPE_ICON[key]) return ic(TYPE_ICON[key]);
  if (t && t.custom && t.icon && t.icon !== '📁') return `<span class="ico emo">${esc(t.icon)}</span>`;
  return ic('folder');
}
