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

  logout() {
    this.currentUser = null;
    this.clearAllIntervals();
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('loginEmailShell').value = '';
    document.getElementById('loginPasswordShell').value = '';
    document.getElementById('loginErrorShell').style.display = 'none';
    window.location.hash = '';
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
  { key: 'add-ucs-code', file: 'add-ucs-code.html', label: 'Add UCS Code', icon: 'plus', group: 'UCS Codes', access: Access.anyLoggedIn },
  { key: 'edit-ucs-code', file: 'edit-ucs-code.html', label: 'Edit UCS Code', icon: 'edit', group: 'UCS Codes', access: Access.isApprover },

  // --- Planning / STO flow ---
  { key: 'add-sto', file: 'add-sto.html', label: 'Raise STO', icon: 'plus', group: 'Planning', access: Access.canManageSTO },
  { key: 'sto-dashboard', file: 'sto-dashboard.html', label: 'STO Dashboard', icon: 'dashboard', group: 'Planning', access: Access.canManageSTO },
  { key: 'add-z04', file: 'add-z04.html', label: 'Create Z04 Entry', icon: 'plus', group: 'Planning', access: Access.canManageSTO },
  { key: 'add-201', file: 'add-201.html', label: 'Create 201 Entry', icon: 'plus', group: 'Planning', access: Access.canManageSTO },
  { key: 'planning-stock', file: 'planning-stock.html', label: 'Planning Stock', icon: 'dashboard', group: 'Planning', access: Access.anyLoggedIn },
  { key: 'demand-dashboard', file: 'demand-dashboard.html', label: 'Demand Dashboard', icon: 'dashboard', group: 'Planning', access: Access.canManageSTO },

  // --- Requisition flow ---
  { key: 'raise-requisition', file: 'raise-requisition.html', label: 'Raise Requisition', icon: 'plus', group: 'Requisitions', access: Access.isAreaSupervisorOrIncharge },
  { key: 'area-approval-dashboard', file: 'area-approval-dashboard.html', label: 'Area Approval', icon: 'check', group: 'Requisitions', access: Access.isAreaIncharge },
  { key: 'sanction-dashboard', file: 'sanction-dashboard.html', label: 'Sanction Dashboard', icon: 'check', group: 'Requisitions', access: Access.isApprover },
  { key: 'issue-dashboard', file: 'issue-dashboard.html', label: 'Issue Dashboard', icon: 'check', group: 'Requisitions', access: Access.isStoreIncharge },

  // --- Area / local stock ---
  { key: 'add-local-issue', file: 'add-local-issue.html', label: 'Record Local Issue', icon: 'plus', group: 'Area Stock', access: Access.isAreaSupervisorOrIncharge },
  { key: 'area-stock-dashboard', file: 'area-stock-dashboard.html', label: 'Area Stock Dashboard', icon: 'dashboard', group: 'Area Stock', access: Access.anyLoggedIn },
  { key: 'raise-demand-alert', file: 'raise-demand-alert.html', label: 'Raise Demand Alert', icon: 'alert', group: 'Area Stock', access: Access.isAreaIncharge },

  // --- Admin ---
  { key: 'admin-options', file: 'admin-options.html', label: 'Manage Options', icon: 'settings', group: 'Admin', access: Access.isApprover },
];

// ====== SIMPLE INLINE ICONS (no external CDN -- works offline for Phase 2) ======

const ICONS = {
  search: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><line x1="20" y1="20" x2="16.5" y2="16.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="3" width="7" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="12" width="7" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="16" width="7" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3 2 20h20L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-1.7-1L15 3.6h-4l-.4 2.4a7.6 7.6 0 0 0-1.7 1l-2.3-.9-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.75 1.7 1l.4 2.4h4l.4-2.4c.6-.25 1.2-.6 1.7-1l2.3.9 2-3.4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

// ====== FRAGMENT LOADER ======

async function loadPage(key) {
  const page = PAGES.find(p => p.key === key);
  if (!page) return;

  Shell.clearAllIntervals(); // stop any polling from the page we're leaving
  Shell.clearTrackedListeners(); // remove any document/window listeners the previous page added

  document.querySelectorAll('.navItem').forEach(el => el.classList.toggle('active', el.dataset.key === key));
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
      scriptEl.textContent = scriptMatch[1];
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
      a.innerHTML = '<span class="navIcon">' + (ICONS[p.icon] || '') + '</span><span>' + p.label + '</span>';
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
  document.getElementById('sidebar').classList.toggle('open');
}

// Install the addEventListener tracking wrapper immediately, before any
// fragment ever gets a chance to add a listener.
Shell._wrapAddEventListenerOnce();
