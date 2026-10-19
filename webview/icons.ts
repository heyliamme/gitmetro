const svg = (body: string) =>
  `<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** The GitMetro mark (a line with a branch that leaves and rejoins it), same drawing as media/panel-icon.svg. */
const mark = `<svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2V22"/><path d="M8 6.6L13.4 12L8 17.4"/><circle cx="16" cy="12" r="2.6"/></svg>`;

export const icons = {
  mark,
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>'),
  chevronRight: svg('<path d="m6 4 4 4-4 4"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4"/>'),
  refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8M13.2 2.6v2.6h-2.6"/>'),
  fetch: svg('<path d="M4.5 10.5a3 3 0 0 1 .3-6 4 4 0 0 1 7.6 1.2 2.5 2.5 0 0 1-.4 4.8"/><path d="M8 7.5v6M6 11.5l2 2 2-2"/>'),
  pull: svg('<path d="M8 2.5v9M4.5 8 8 11.5 11.5 8M3 13.5h10"/>'),
  push: svg('<path d="M8 13.5v-9M4.5 8 8 4.5 11.5 8M3 2.5h10"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  trash: svg('<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9"/>'),
  expand: svg('<path d="m4.5 6 3.5-3.5L11.5 6M4.5 10l3.5 3.5 3.5-3.5"/>'),
  collapse: svg('<path d="m4.5 2.5 3.5 3.5 3.5-3.5M4.5 13.5 8 10l3.5 3.5"/>'),
  panelLeft: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/>'),
  panelRight: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M10 2.5v11"/>'),
  close: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>'),
  folder: svg('<path d="M1.8 4.2c0-.6.4-1 1-1h3l1.4 1.5h6c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"/>'),
  pin: svg('<path d="M9.8 2.2 13.8 6.2 11.6 7.1 9 9.7l-.3 3-5.4-5.4 3-.3 2.6-2.6z"/><path d="m5.8 10.2-3.3 3.3"/>'),
  tag: svg('<path d="M2.5 3.5v4.3l5.7 5.7 5.3-5.3-5.7-5.7H3.5a1 1 0 0 0-1 1z"/><circle cx="5.6" cy="5.6" r="1"/>'),
  cloud: svg('<path d="M4.5 12.5a3 3 0 0 1-.2-6 4 4 0 0 1 7.6 1.1 2.5 2.5 0 0 1-.4 4.9z"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  tree: svg('<path d="M3 3h4M5 3v9.5h3M5 8h3"/><rect x="9" y="6.5" width="4.5" height="3" rx=".8"/><rect x="9" y="11" width="4.5" height="3" rx=".8"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="12" r=".6"/>'),
  diff: svg('<rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/><path d="M3 6h2.5M10.5 6h2.5M11.8 4.8v2.4M3 10h2.5"/>'),
  hash: svg('<path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.8 6h11M2.2 10h11"/>'),
  branch: svg('<circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.1v5.8M11 7.1c0 2.6-6 1.9-6 3.8"/>'),
};
