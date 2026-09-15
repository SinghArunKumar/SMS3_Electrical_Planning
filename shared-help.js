// =====================================================================
// HELP -- contextual "?" help panel + on-page guided tours (spotlight
// walkthroughs). Self-contained, no external dependencies, styled to
// match the shell (see the HELP CSS block in index.html).
//
// Integration points (already wired in shared.js / index.html):
//   - index.html has a static #helpBtn + empty #helpPanel in the topbar,
//     and loads this file after shared.js / shared-forms.js.
//   - shared.js's loadPage() calls Help.mountForPage(page) once a
//     fragment has finished loading, so the panel always reflects the
//     CURRENT page.
//   - shared.js's shellLogin() calls Help.onLogin() once, right after a
//     successful login, to (one-time, ever) offer the app-wide tour.
//
// ---------------------------------------------------------------------
// HOW TO ADD OR EDIT A TOUR FOR A PAGE
// ---------------------------------------------------------------------
// Add/edit an entry in HELP_CONTENT below, keyed by the page's `key` in
// shared.js's PAGES array (e.g. 'sto-dashboard'). Two optional fields:
//
//   overview: 'One or two sentences shown in the (?) panel for this page.'
//
//   tour: [
//     { selector: '#someStaticId',   // CSS selector -- MUST match an
//                                     // element that exists in the
//                                     // fragment's static HTML (not a
//                                     // table row or result that only
//                                     // appears after an API call/typing)
//       title: 'Short heading',
//       body:  'One or two plain-language sentences.',
//       placement: 'bottom' }        // 'top' | 'bottom' | 'left' | 'right'
//   ]
//
// A page with no entry at all still gets a generic "no guidance written
// yet" panel -- nothing breaks. A page with `overview` but no `tour`
// just won't offer the "Take a tour" button. Steps whose selector isn't
// found on the page are skipped automatically (so it's safe to write a
// tour before every element exists, or reuse steps across similar pages).
// =====================================================================

const HELP_CONTENT = {
  // Shown once, automatically, right after this person's very first-ever
  // login on this browser (see Help.onLogin). Targets shell chrome that
  // is present on every page, not fragment content.
  _app: {
    tour: [
      { selector: '#hamburgerBtn', title: 'Show / hide the menu', body: 'Tap this any time to collapse the sidebar to icons-only and get more room, or bring it back.', placement: 'bottom' },
      { selector: '#navMenu', title: 'Everything you can do', body: 'Only the sections and pages your account is allowed to use are listed here -- it\u2019s different for every role.', placement: 'right' },
      { selector: '#helpBtn', title: 'Help is always here', body: 'Click the (?) on any page for a short explanation of what that page does, or to replay its guided tour.', placement: 'bottom' },
      { selector: '#logoutBtnShell', title: 'Logging out', body: 'Always log out on a shared computer \u2014 your session is only kept in this browser tab.', placement: 'bottom' }
    ]
  },

  'search-ucs': {
    overview: 'Find a material\u2019s UCS Code by typing any combination of words from its description. Word order and spacing don\u2019t matter \u2014 every word you type just has to match somewhere in the code, short text, or long text.',
    tour: [
      { selector: '#searchBox', title: 'Type any keywords', body: 'e.g. "cable 1100 v copper" finds a 1100V copper cable even if those exact words never appear together in the description.', placement: 'bottom' },
      { selector: '#resultCount', title: 'Match count', body: 'Shows how many materials match everything you\u2019ve typed so far, out of the full list.', placement: 'bottom' }
    ]
  },

  'sto-dashboard': {
    overview: 'Browse every STO, search by STO No, UCS Code, or description, and act directly on the Status, Z04, and 201 badges for each row.',
    tour: [
      { selector: '#searchBox', title: 'Search anything', body: 'Matches STO No, UCS Code, and the material\u2019s short & long description \u2014 every word you type must match somewhere, in any order.', placement: 'bottom' },
      { selector: '#statusFilter', title: 'Filter by status', body: 'Narrow the list to only Pending or only Received STOs.', placement: 'bottom' },
      { selector: '#z04Filter', title: 'Z04 receiving', body: 'Defaults to "Z04 Pending only", so you always see what still needs a Z04 entry first, without extra clicks.', placement: 'bottom' },
      { selector: 'table thead', title: 'Click a badge to act', body: 'Click the Status, Z04, or 201 badge on any row to open exactly that action for that row \u2014 no separate page needed.', placement: 'bottom' }
    ]
  },

  'planning-stock': {
    overview: 'Live Received / Released / Balance for every UCS Code at Planning. Search by code or description, and filter to zero/negative balances.',
    tour: [
      { selector: '#searchBox', title: 'Search anything', body: 'Matches UCS Code and description, same as everywhere else in this app.', placement: 'bottom' }
    ]
  },

  'raise-requisition': {
    overview: 'Raise a new requisition slip for your area: add one or more UCS Code line items and the quantity you need for each.'
  },

  'area-stock-dashboard': {
    overview: 'Live local stock balance per area: pick an area, then search by UCS Code or description to see Total Inflow, Total Consumed, and Qty Balance.',
    tour: [
      { selector: '#searchBox', title: 'Search anything', body: 'Matches UCS Code and description, same as everywhere else in this app.', placement: 'bottom' }
    ]
  }
};

const Help = (function () {
  let currentPageKey = null;
  let tourSteps = [];
  let tourIndex = 0;
  let tourActive = false;
  let clickAwayBound = false;

  function seenKey(key) { return 'help_seen_' + key; }
  function hasSeen(key) { try { return localStorage.getItem(seenKey(key)) === '1'; } catch (e) { return true; } }
  function markSeen(key) { try { localStorage.setItem(seenKey(key), '1'); } catch (e) { /* private browsing etc -- non-fatal */ } }

  function escapeHelpHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Topbar dropdown panel ----------

  function bindClickAwayOnce() {
    if (clickAwayBound) return;
    clickAwayBound = true;
    document.addEventListener('click', function (e) {
      const panel = document.getElementById('helpPanel');
      const btn = document.getElementById('helpBtn');
      if (panel && panel.style.display === 'block' && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        panel.style.display = 'none';
      }
    });
  }

  function togglePanel() {
    const panel = document.getElementById('helpPanel');
    if (!panel) return;
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    bindClickAwayOnce();
    renderPanel(panel);
    panel.style.display = 'block';
  }

  function renderPanel(panel) {
    const content = HELP_CONTENT[currentPageKey] || {};
    const overview = content.overview || 'No specific guidance has been written for this page yet.';
    const hasTour = content.tour && content.tour.length > 0;
    panel.innerHTML =
      '<div class="helpPanelTitle">This page</div>' +
      '<div class="helpPanelBody">' + escapeHelpHtml(overview) + '</div>' +
      (hasTour
        ? '<button class="helpPanelBtn" id="helpStartTourBtn">Take a quick tour of this page</button>'
        : '') +
      '<div class="helpPanelDivider"></div>' +
      '<button class="helpPanelBtn secondary" id="helpReplayAppTourBtn">Replay the app walkthrough</button>';
    const tourBtn = document.getElementById('helpStartTourBtn');
    if (tourBtn) tourBtn.onclick = function () { panel.style.display = 'none'; startTour(currentPageKey); };
    document.getElementById('helpReplayAppTourBtn').onclick = function () { panel.style.display = 'none'; startTour('_app'); };
  }

  // ---------- Spotlight tour engine ----------

  function startTour(key) {
    const content = HELP_CONTENT[key];
    if (!content || !content.tour || !content.tour.length) return;
    tourSteps = content.tour.filter(function (s) { return document.querySelector(s.selector); });
    if (!tourSteps.length) return;
    tourIndex = 0;
    tourActive = true;
    buildOverlay();
    showStep();
    // Whichever tour actually ran (page or app) counts as "seen" for
    // that key once it starts -- reopening later is "replay", not new.
    markSeen(key);
  }

  function buildOverlay() {
    teardownOverlay();
    const backdrop = document.createElement('div');
    backdrop.id = 'helpTourBackdrop';
    const spotlight = document.createElement('div');
    spotlight.id = 'helpTourSpotlight';
    const tooltip = document.createElement('div');
    tooltip.id = 'helpTourTooltip';
    document.body.appendChild(backdrop);
    document.body.appendChild(spotlight);
    document.body.appendChild(tooltip);
    window.addEventListener('resize', positionCurrentStep);
    document.addEventListener('keydown', onTourKeydown);
  }

  function teardownOverlay() {
    ['helpTourBackdrop', 'helpTourSpotlight', 'helpTourTooltip'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    window.removeEventListener('resize', positionCurrentStep);
    document.removeEventListener('keydown', onTourKeydown);
  }

  function onTourKeydown(e) {
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight') nextStep();
    else if (e.key === 'ArrowLeft') prevStep();
  }

  function showStep() {
    const step = tourSteps[tourIndex];
    const el = document.querySelector(step.selector);
    if (!el) { nextStep(); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Give the smooth scroll a beat to finish before measuring position.
    setTimeout(positionCurrentStep, 260);
  }

  function positionCurrentStep() {
    if (!tourActive) return;
    const step = tourSteps[tourIndex];
    const el = document.querySelector(step.selector);
    if (!el) { nextStep(); return; }
    const r = el.getBoundingClientRect();
    const pad = 6;
    const spot = document.getElementById('helpTourSpotlight');
    if (!spot) return;
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    const tip = document.getElementById('helpTourTooltip');
    tip.innerHTML =
      '<div class="helpTourStepCount">Step ' + (tourIndex + 1) + ' of ' + tourSteps.length + '</div>' +
      '<div class="helpTourTitle">' + escapeHelpHtml(step.title) + '</div>' +
      '<div class="helpTourText">' + escapeHelpHtml(step.body) + '</div>' +
      '<div class="helpTourActions">' +
        '<button class="helpTourSkip" id="helpTourSkipBtn">Skip</button>' +
        '<div class="helpTourNav">' +
          (tourIndex > 0 ? '<button class="helpTourBack" id="helpTourBackBtn">Back</button>' : '') +
          '<button class="helpTourNext" id="helpTourNextBtn">' + (tourIndex === tourSteps.length - 1 ? 'Done' : 'Next') + '</button>' +
        '</div>' +
      '</div>';
    document.getElementById('helpTourSkipBtn').onclick = endTour;
    document.getElementById('helpTourNextBtn').onclick = nextStep;
    const backBtn = document.getElementById('helpTourBackBtn');
    if (backBtn) backBtn.onclick = prevStep;

    // Position the tooltip near the spotlighted element, then clamp it
    // inside the viewport so it's never partly off-screen.
    tip.style.visibility = 'hidden';
    const tipRect = tip.getBoundingClientRect();
    const gap = 14;
    let top, left;
    const placement = step.placement || 'bottom';
    if (placement === 'top') { top = r.top - tipRect.height - gap; left = r.left; }
    else if (placement === 'right') { top = r.top; left = r.right + gap; }
    else if (placement === 'left') { top = r.top; left = r.left - tipRect.width - gap; }
    else { top = r.bottom + gap; left = r.left; }

    const margin = 12;
    if (left + tipRect.width > window.innerWidth - margin) left = window.innerWidth - tipRect.width - margin;
    if (left < margin) left = margin;
    if (top + tipRect.height > window.innerHeight - margin) top = window.innerHeight - tipRect.height - margin;
    if (top < margin) top = margin;

    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
    tip.style.visibility = 'visible';
  }

  function nextStep() {
    if (tourIndex >= tourSteps.length - 1) { endTour(); return; }
    tourIndex++;
    showStep();
  }
  function prevStep() {
    if (tourIndex <= 0) return;
    tourIndex--;
    showStep();
  }
  function endTour() {
    tourActive = false;
    teardownOverlay();
  }

  // ---------- Hooks called by shared.js ----------

  // Called by loadPage() every time a fragment finishes loading.
  function mountForPage(page) {
    currentPageKey = page.key;
    const panel = document.getElementById('helpPanel');
    if (panel) panel.style.display = 'none';

    // Non-blocking first-visit nudge -- never the full-screen tour
    // uninvited, just a small dismissible toast. Skipped while another
    // tour (e.g. the app walkthrough right after login) is already on
    // screen, so the two never visually collide.
    const content = HELP_CONTENT[page.key];
    if (!tourActive && content && content.tour && content.tour.length && !hasSeen(page.key)) {
      showFirstVisitToast(page);
    }
  }

  function showFirstVisitToast(page) {
    const existing = document.getElementById('helpFirstVisitToast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'helpFirstVisitToast';
    toast.innerHTML =
      '<span>New to ' + escapeHelpHtml(page.label) + '?</span>' +
      '<button id="helpToastStart">Take a 30-second tour</button>' +
      '<button id="helpToastDismiss" aria-label="Dismiss">&times;</button>';
    document.body.appendChild(toast);
    document.getElementById('helpToastStart').onclick = function () { toast.remove(); startTour(page.key); };
    document.getElementById('helpToastDismiss').onclick = function () { markSeen(page.key); toast.remove(); };
    setTimeout(function () { if (document.body.contains(toast)) toast.remove(); }, 12000);
  }

  // Called once by shellLogin() right after a successful login.
  function onLogin() {
    if (!hasSeen('_app')) {
      // Small delay lets the first page finish rendering so the tour
      // doesn't start over a still-loading screen.
      setTimeout(function () { startTour('_app'); }, 600);
    }
  }

  return { mountForPage: mountForPage, onLogin: onLogin, startTour: startTour, togglePanel: togglePanel };
})();
