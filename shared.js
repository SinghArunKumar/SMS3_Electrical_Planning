// =====================================================================
// SHELL — single shared session for the whole app.
// This is the ONLY place APPS_SCRIPT_URL and the logged-in user live.
// Every converted page fragment reads Shell.APPS_SCRIPT_URL and
// Shell.getUser() instead of carrying its own copy.
// =====================================================================

const Shell = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxMXqckZThqa3Vh06rh8fPWJ8RM0fn3x9yT_YzhqQt0Ph4BKArpoVNRviDwfaEYYyVH/exec',
  currentUser: null,   // { email, password, name, role, authorizedArea, isAdmin }
  _intervals: [],

  getUser() {
    return this.currentUser;
  },

  // Called by a converted page right after it starts a setInterval poll,
  // so the shell can stop it when the user navigates to a different page
  // (these pages were originally written assuming they were the only page
  // ever loaded, so they never clean up after themselves on their own).
  registerInterval(id) {
    this._intervals.push(id);
  },

  clearAllIntervals() {
    this._intervals.forEach(id => clearInterval(id));
    this._intervals = [];
  },

  // Several pages attach document/window-level click or keydown listeners
  // (e.g. "click outside to close this dropdown", arrow-key navigation in a
  // search combo box). document/window persist across page navigations even
  // though the fragment's own DOM gets replaced -- so without this, every
  // repeat visit to one of those pages stacks another copy of the same
  // listener, each one closing over the PREVIOUS visit's now-removed DOM
  // elements. Track every listener added while a fragment's script runs, so
  // the shell can tear them all down before the next page loads.
  _trackedListeners: [],
  _wrapAddEventListenerOnce() {
    if (this._listenerWrapInstalled) return;
    this._listenerWrapInstalled = true;
    const self = this;
    [document, window].forEach(target => {
      const original = target.addEventListener.bind(target);
      target.addEventListener = function (type, listener, options) {
        self._trackedListeners.push({ target, type, listener, options });
        return original(type, listener, options);
      };
    });
  },
  clearTrackedListeners() {
    this._trackedListeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this._trackedListeners = [];
  },

  // Every page's own login() re-verifies email/password against the Users
  // sheet -- a full Apps Script round-trip -- which was correct as a
  // one-time check in the original standalone-page world, but now runs
  // AGAIN on every single navigation since the shell reuses that same
  // tested code for safety. That's the main cause of the app feeling slow:
  // 2x the necessary network calls per page, plus real Apps Script latency.
  // Fix: once the shell has verified these exact credentials, short-circuit
  // any repeat login network call and answer from memory instead -- no
  // fragment code changes needed, and this matches the ORIGINAL app's own
  // behavior (a standalone page never re-checked its own login mid-session
  // either).
  _wrapFetchOnce() {
    if (this._fetchWrapped) return;
    this._fetchWrapped = true;
    const originalFetch = window.fetch.bind(window);
    const self = this;
    window.fetch = function (url, options) {
      if (
        url === self.APPS_SCRIPT_URL &&
        options && options.method === 'POST' && typeof options.body === 'string'
      ) {
        try {
          const parsed = JSON.parse(options.body);
          if (
            parsed.action === 'login' && self.currentUser &&
            parsed.email === self.currentUser.email &&
            parsed.password === self.currentUser.password
          ) {
            const cached = {
              success: true,
              name: self.currentUser.name,
              role: self.currentUser.role,
              authorizedArea: self.currentUser.authorizedArea,
              isAdmin: self.currentUser.isAdmin
            };
            return Promise.resolve(new Response(JSON.stringify(cached), {
              status: 200, headers: { 'Content-Type': 'application/json' }
            }));
          }
        } catch (e) { /* not JSON, or not a login call -- fall through */ }
      }
      return originalFetch(url, options);
    };
  },

  logout() {
    this.currentUser = null;
    this.clearAllIntervals();
    this.clearAllPageCaches();
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('loginEmailShell').value = '';
    document.getElementById('loginPasswordShell').value = '';
    document.getElementById('loginErrorShell').style.display = 'none';
    window.location.hash = '';
  },

  // Converted pages store their own device-local instant-paint cache
  // (Planning Stock, Area Stock, Search UCS, etc.) under a 'smsCache:'
  // prefixed sessionStorage key -- see each page's own CACHE_KEY. Cleared
  // here, centrally, rather than by each page's own (now-unused) logout()
  // function, since Shell.logout() is what the topbar's Log out button
  // actually calls and it never does a full page reload -- without this,
  // a stale cache would otherwise still be sitting in sessionStorage for
  // whoever logs in next on the same device.
  clearAllPageCaches() {
    try {
      Object.keys(sessionStorage)
        .filter(k => k.indexOf('smsCache:') === 0)
        .forEach(k => sessionStorage.removeItem(k));
    } catch (e) { /* storage disabled -- nothing to clear */ }
  }
};

// ====== ROLE RULES ======
// Mirrors Code.gs's hasCommaValue()/isApprover()/canManageSTO() etc.
// exactly, so the menu shows the same pages a user can actually open.
// This is a CONVENIENCE filter only -- Code.gs still enforces every rule
// server-side, and each page's own login() re-checks its own rule too.

function hasCommaValue(str, target) {
  if (!str) return false;
  return String(str).split(',').map(s => s.trim().toLowerCase())
    .indexOf(String(target).toLowerCase()) !== -1;
}

const Access = {
  anyLoggedIn: () => true,
  isApprover: (u) => hasCommaValue(u.role, 'Approver'),
  canManageSTO: (u) => hasCommaValue(u.authorizedArea, 'Planning') && !hasCommaValue(u.role, 'Store Incharge'),
  isAreaSupervisorOrIncharge: (u) => hasCommaValue(u.role, 'Area Store Supervisor') || hasCommaValue(u.role, 'Area Incharge'),
  isAreaIncharge: (u) => hasCommaValue(u.role, 'Area Incharge'),
  isStoreIncharge: (u) => hasCommaValue(u.role, 'Store Incharge'),
};

// ====== PAGE REGISTRY ======
// One entry per fragment. `group` controls menu sectioning.

const PAGES = [
  // --- UCS Codes ---
  { key: 'search-ucs', file: 'search-ucs.html', label: 'Search UCS Codes', icon: 'search', group: 'UCS Codes', access: Access.anyLoggedIn },
  { key: 'add-ucs-code', file: 'add-ucs-code.html', label: 'Add UCS Code', icon: 'filePlus', group: 'UCS Codes', access: Access.canManageSTO },
  { key: 'edit-ucs-code', file: 'edit-ucs-code.html', label: 'Edit UCS Code', icon: 'filePen', group: 'UCS Codes', access: Access.isApprover },

  // --- Planning / STO flow ---
  { key: 'add-sto', file: 'add-sto.html', label: 'Raise STO', icon: 'truck', group: 'Planning', access: Access.canManageSTO },
  { key: 'sto-dashboard', file: 'sto-dashboard.html', label: 'STO Dashboard', icon: 'clipboardList', group: 'Planning', access: Access.canManageSTO },
  { key: 'add-z04', file: 'add-z04.html', label: 'Create Z04 Entry', icon: 'packageIn', group: 'Planning', access: Access.canManageSTO },
  { key: 'add-201', file: 'add-201.html', label: 'Create 201 Entry', icon: 'packageOut', group: 'Planning', access: Access.canManageSTO },
  { key: 'planning-stock', file: 'planning-stock.html', label: 'Planning Stock', icon: 'boxes', group: 'Planning', access: Access.anyLoggedIn },
  { key: 'demand-dashboard', file: 'demand-dashboard.html', label: 'Demand Dashboard', icon: 'trend', group: 'Planning', access: Access.canManageSTO },
  { key: 'pr-po-dashboard', file: 'pr-po-dashboard.html', label: 'PR/PO Dashboard', icon: 'clipboardList', group: 'Planning', access: Access.canManageSTO },

  // --- Requisition flow ---
  { key: 'raise-requisition', file: 'raise-requisition.html', label: 'Raise Requisition', icon: 'clipboardPlus', group: 'Requisitions', access: Access.isAreaSupervisorOrIncharge },
  { key: 'area-approval-dashboard', file: 'area-approval-dashboard.html', label: 'Area Approval', icon: 'checkCircle', group: 'Requisitions', access: Access.isAreaIncharge },
  { key: 'sanction-dashboard', file: 'sanction-dashboard.html', label: 'Sanction Dashboard', icon: 'stamp', group: 'Requisitions', access: Access.isApprover },
  { key: 'issue-dashboard', file: 'issue-dashboard.html', label: 'Issue Dashboard', icon: 'checkCircle', group: 'Requisitions', access: Access.isStoreIncharge },

  // --- Area / local stock ---
  { key: 'add-local-issue', file: 'add-local-issue.html', label: 'Record Local Issue', icon: 'handReceive', group: 'Area Stock', access: Access.isAreaSupervisorOrIncharge },
  { key: 'area-stock-dashboard', file: 'area-stock-dashboard.html', label: 'Area Stock Dashboard', icon: 'warehouse', group: 'Area Stock', access: Access.anyLoggedIn },
  { key: 'raise-demand-alert', file: 'raise-demand-alert.html', label: 'Raise Demand Alert', icon: 'alert', group: 'Area Stock', access: Access.isAreaIncharge },

  // --- Admin ---
  { key: 'admin-options', file: 'admin-options.html', label: 'Manage Options', icon: 'settings', group: 'Admin', access: Access.isApprover },

  // --- Returns ---
  // Access mirrors the pages' own gates exactly: raiseReturn() requires
  // isAreaInchargeForArea (Area Incharge, area-scoped -- no Supervisor
  // fast-track, unlike Requisitions), approveReturn() requires
  // canSanctionRequisition (Approver, global, same as Sanction Dashboard).
  { key: 'raise-return', file: 'raise-return.html', label: 'Raise Return', icon: 'undo', group: 'Returns', access: Access.isAreaIncharge },
  { key: 'return-approval-dashboard', file: 'return-approval-dashboard.html', label: 'Return Approval', icon: 'inbox', group: 'Returns', access: Access.isApprover },
];

// ====== ICONS ======
// Ported directly from the design mockup's own SVG icons (24x24, 1.5px
// stroke, rounded caps) -- kept as inline SVG rather than an icon font, so
// there's no external dependency and it works offline for Phase 2 (PWA).

const ICONS = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6"/><path d="M14 3l5 5h-5V3z"/><circle cx="16.5" cy="16.5" r="3.5"/><path d="M19.2 19.2 22 22"/></svg>',
  filePlus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3l5 5h-5V3z"/><path d="M12 12v6M9 15h6"/></svg>',
  filePen: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h5"/><path d="M14 3l5 5h-5V3z"/><path d="M14 21h3l4.5-4.5-3-3L14 18v3z"/></svg>',
  truck: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h10v11H2z"/><path d="M12 9h4l3 3.5V17h-7z"/><circle cx="7" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/></svg>',
  clipboardList: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v3H9z"/><path d="M15 4.5h3v16H6v-16h3"/><path d="M9 11h6M9 15h6"/></svg>',
  clipboardPlus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v3H9z"/><path d="M15 4.5h3v16H6v-16h3"/><path d="M12 10v7M8.5 13.5h7"/></svg>',
  packageIn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="M9 7.5l3 3 3-3"/><path d="M3 12h18v9H3z"/><path d="M3 12l2-3h4M21 12l-2-3h-4"/></svg>',
  packageOut: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="M9 4.5l3-3 3 3"/><path d="M3 12h18v9H3z"/><path d="M3 12l2-3h4M21 12l-2-3h-4"/></svg>',
  boxes: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3h7v6h-7z"/><path d="M3 14h7v7H3z"/><path d="M14 14h7v7h-7z"/></svg>',
  trend: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v17h17"/><path d="M7 15l4-5 3 2.5 5-6.5"/><path d="M19 6h-3.5M19 6v3.5"/></svg>',
  checkCircle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.8 2.8L16.5 9.3"/></svg>',
  stamp: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5h6a2 2 0 0 1 2 2c0 2-1.6 2.6-1.6 4.2V12H7.6V9.7C7.6 8.1 6 7.5 6 5.5"/><path d="M4.5 15h15v3.5h-15z"/><path d="M4 21h16"/></svg>',
  handReceive: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10v5H7z"/><path d="M3 21v-5l3-2 3 1.5h3.5a1.5 1.5 0 0 1 0 3H11"/><path d="M12.5 18.5h5.5a2 2 0 0 0 0-4h-2.5"/></svg>',
  warehouse: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V9l9-5 9 5v12"/><path d="M8 21v-7h8v7"/><path d="M8 17.5h8"/></svg>',
  alert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/></svg>',
  settings: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-1.7-1L15 3.6h-4l-.4 2.4a7.6 7.6 0 0 0-1.7 1l-2.3-.9-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.75 1.7 1l.4 2.4h4l.4-2.4c.6-.25 1.2-.6 1.7-1l2.3.9 2-3.4Z"/></svg>',
  undo: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-6a4 4 0 0 0-4-4H4"/></svg>',
  inbox: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-5l-1.8 3h-4.4L8 12H3"/><path d="M5.4 5.1 3 12v6a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18v-6l-2.4-6.9A1.6 1.6 0 0 0 17.1 4H6.9a1.6 1.6 0 0 0-1.5 1.1z"/></svg>',
};

// ====== FRAGMENT LOADER ======

async function loadPage(key) {
  const page = PAGES.find(p => p.key === key);
  if (!page) return;

  Shell.clearAllIntervals(); // stop any polling from the page we're leaving
  Shell.clearTrackedListeners(); // remove any document/window listeners the previous page added

  document.querySelectorAll('.navItem').forEach(el => el.classList.toggle('active', el.dataset.key === key));
  document.getElementById('pageTitleName').textContent = page.label;
  const container = document.getElementById('pageContainer');
  container.innerHTML = '<div class="pageLoading">Loading…</div>';
  window.location.hash = key;
  closeSidebarOnMobile();

  try {
    const res = await fetch('fragments/' + page.file, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    const withoutScript = html.replace(/<script>[\s\S]*?<\/script>/, '');

    container.innerHTML = withoutScript;

    if (scriptMatch) {
      const scriptEl = document.createElement('script');

      // Every fragment was originally authored as a standalone page whose
      // <script> ran exactly once per real browser page load. Here, the
      // SAME script text gets re-injected and re-executed every time the
      // user revisits this page within one session -- and top-level
      // const/let in a classic <script> live in ONE shared global lexical
      // scope for the whole document, not per-<script>-tag. So the second
      // visit to any page re-declares e.g. `const APPS_SCRIPT_URL` and
      // throws "Identifier has already been declared" -- a parse-time
      // error that kills the ENTIRE script silently, not just that one
      // line. The page LOOKS loaded (its HTML is there) but is completely
      // inert: no login, no data, no button does anything. Wrapping each
      // run in its own function scope gives every visit a fresh, private
      // set of bindings, so this can never happen.
      //
      // The one thing that wrapping would otherwise break: fragments call
      // their own functions via inline event handler attributes --
      // onclick="doThing()", but just as often onchange="onAreaChange()" or
      // oninput="onSearchInput()" -- all of which only resolve against the
      // GLOBAL scope. A wrapped function's own top-level declarations are
      // no longer visible there. Fix: scan for every on*="name(...)" this
      // fragment actually uses (any inline handler attribute, not just
      // onclick), and republish just those specific names onto window
      // after each run. Re-running this on every visit is correct, not
      // just tolerated -- it's what makes sure a stale closure from 3
      // visits ago is never what a click (or change, or keystroke)
      // resolves to.
      //
      // Scanned from BOTH the static HTML and the raw script text, not
      // just the HTML: several fragments build their handler attributes
      // dynamically (e.g. a table row's innerHTML assembled with
      // "...onclick=\"openDetail(' + idx + ')\"..."), so the function name
      // never appears anywhere in the page's static markup -- only as a
      // literal substring inside the script's own source, which an
      // HTML-only scan would silently miss and leave broken on click.
      const onclickSource = withoutScript + '\n' + scriptMatch[1];
      const jsReservedWords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void', 'delete', 'new', 'in', 'of', 'instanceof', 'else', 'do', 'with']);
      const onclickNames = [...onclickSource.matchAll(/\son[a-zA-Z]+=\\?["']([a-zA-Z_$][\w$]*)\(/g)]
        .map(m => m[1])
        .filter(name => !jsReservedWords.has(name));
      const exposeGlobals = [...new Set(onclickNames)]
        .map(name => `if (typeof ${name} === 'function') { window.${name} = ${name}; }`)
        .join('\n');

      scriptEl.textContent = '(function () {\n' + scriptMatch[1] + '\n' + exposeGlobals + '\n})();';
      container.appendChild(scriptEl); // browsers execute dynamically-appended scripts
    }
  } catch (err) {
    container.innerHTML = '<div class="pageLoading">Could not load this page (' + err.message + '). Check your connection and try again.</div>';
  }
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 860) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

// ====== MENU RENDERING ======

function renderMenu() {
  const user = Shell.getUser();
  const nav = document.getElementById('navMenu');
  nav.innerHTML = '';

  const groups = [];
  PAGES.forEach(p => {
    if (!p.access(user)) return;
    let g = groups.find(g => g.name === p.group);
    if (!g) { g = { name: p.group, pages: [] }; groups.push(g); }
    g.pages.push(p);
  });

  if (groups.length === 0) {
    nav.innerHTML = '<div class="navEmpty">No pages are enabled for your account yet. Contact the project owner.</div>';
    return;
  }

  groups.forEach(g => {
    const h = document.createElement('div');
    h.className = 'navGroupLabel';
    h.textContent = g.name;
    nav.appendChild(h);
    g.pages.forEach(p => {
      const a = document.createElement('a');
      a.href = '#' + p.key;
      a.className = 'navItem';
      a.dataset.key = p.key;
      a.title = p.label; // native tooltip -- shows the page name on hover when the sidebar is collapsed to icons
      a.innerHTML = '<span class="navIcon">' + (ICONS[p.icon] || '') + '</span><span class="navLabel">' + p.label + '</span>';
      a.onclick = (e) => { e.preventDefault(); loadPage(p.key); };
      nav.appendChild(a);
    });
  });
}

// ====== LOGIN ======

async function shellLogin() {
  const email = document.getElementById('loginEmailShell').value.trim();
  const password = document.getElementById('loginPasswordShell').value;
  const errEl = document.getElementById('loginErrorShell');
  const btn = document.getElementById('loginBtnShell');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'Please enter email and password.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Logging in…';

  try {
    const res = await fetch(Shell.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', email, password })
    });
    const data = await res.json();

    if (!data.success) {
      errEl.textContent = data.message || 'Login failed.';
      errEl.style.display = 'block';
      return;
    }

    Shell.currentUser = {
      email, password,
      name: data.name, role: data.role,
      authorizedArea: data.authorizedArea, isAdmin: data.isAdmin
    };

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appShell').style.display = 'flex';
    document.getElementById('userBadge').textContent = data.name + ' (' + data.role + ')';
    renderMenu();

    // Deep-link support: reload straight into a page from the URL hash if valid & authorized.
    const requested = window.location.hash.slice(1);
    const firstAllowed = PAGES.find(p => p.access(Shell.currentUser));
    const target = PAGES.find(p => p.key === requested && p.access(Shell.currentUser));
    if (target) loadPage(target.key);
    else if (firstAllowed) loadPage(firstAllowed.key);

  } catch (err) {
    errEl.textContent = 'Could not reach the server. Check your connection.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log In';
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 860) {
    sidebar.classList.toggle('open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

// Install the addEventListener tracking wrapper and the login-caching
// fetch wrapper immediately, before any fragment ever gets a chance to run.
Shell._wrapAddEventListenerOnce();
Shell._wrapFetchOnce();
