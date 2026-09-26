/**
 * GitHub_SMS-3_Stores_module — Apps Script Backend
 * Phase 1, Feature 1: Login + "Add New UCS Code" + Edit UCS Text
 * Phase 1, Feature 2: STO_MasterList — Raise STO + Receive Material
 * Phase 1, Feature 3: S_Z04 — Create Z04 Entry
 * Phase 1, Feature 4: Options_List — generic column-per-category reader/admin-appender
 * Phase 1, Feature 5: S_201 — Create 201 Entry (cumulative release against a Z04'd STO)
 * Phase 1, Feature 6: UCS Code Search — read-only, any-logged-in-user, client-side keyword search
 * Phase 2, Feature 1: Requisition Module — Raise / Area Approval / Sanction / Issue workflow
 * Phase 2, Feature 2: Planning Stock — computed in Apps Script (not live formulas), refreshed
 *                     on write, on a 30-min timer, and via a manual menu/dashboard button
 * Phase 2, Feature 3: Local Issue — write-only module recording consumption from an area's
 *                     local stock (the "-" side of the future AREA_STOCK balance); every line
 *                     re-validated against a freshly computed balance inside a script lock
 * Phase 2, Feature 4: Options_List admin management (Area_201 / Unit) + UCS_MasterList's Unit
 *                     field now sourced live from Options_List instead of a hardcoded array;
 *                     Area_Planning_issue column retired (see PROJECT_STATUS.md) -- an out-of-
 *                     shop issue is now recorded as a Planning debit with an approval reference
 *                     in Remarks, not a transfer to a fake external "area"
 * Phase 2, Feature 5: Demand_Alerts — Area Incharge heads-up module: flags an anticipated qty
 *                     increase on an existing UCS Code, or a brand-new material not yet in
 *                     UCS_MasterList, for Planning to triage. Purely advisory -- never touches
 *                     stock balances or triggers a Requisition on its own.
 * Phase 3, Feature 1: Edit STO (Qty + UCS Code) -- pre-lock correction of an already-raised STO,
 *                     locked automatically once Received info is filled OR a Z04 already exists.
 * Phase 3, Feature 2: Vendor Finder -- read-only list of past vendors for up to 25 UCS Codes, for
 *                     calling budgetary offers. Reads the "Material List" and "Vendor" tabs of the
 *                     external SMS3E PRs sheet. Planning staff (excluding Store Incharge) only.
 *
 * IMPORTANT ONE-TIME SETUP FOR THIS VERSION: the LOCAL_ISSUE_SHEET tab's headers must read
 * EXACTLY (retype each cell from scratch, Bug Pattern 3):
 *   A: Issue_Date | B: Area | C: UCS_Code | D: Material_Description | E: Unit |
 *   F: Consumed_Qty | G: Issued_To | H: Remarks | I: Issued_By_Name | J: Issued_By_Email | K: Timestamp
 *
 * DEPLOYMENT:
 * 1. Open the Google Sheet -> Extensions -> Apps Script
 * 2. Select ALL existing content in Code.gs and DELETE it.
 * 3. Paste this file's entire contents into Code.gs.
 * 4. Save (Ctrl+S).
 * 5. Deploy -> Manage deployments -> pencil/edit icon on your existing
 *    deployment -> Version dropdown -> New version -> Deploy.
 */

// ====== CONFIG ======
const USERS_SHEET = 'Users';
const UCS_SHEET = 'UCS_MasterList';
const STO_SHEET = 'STO_MasterList';
const AUDIT_SHEET = 'AuditLog';
const Z04_SHEET = 'S_Z04';
const S201_SHEET = 'S_201';
const OPTIONS_SHEET = 'Options_List';
const REQ_HEADER_SHEET = 'Requisition_Header';
const REQ_DETAILS_SHEET = 'Requisition_Details';
const ISSUE_LEDGER_SHEET = 'PLNG_ISSUE_SHEET';
const PLNG_STOCK_SHEET = 'PLNG_STOCK';
const LOCAL_ISSUE_SHEET = 'LOCAL_ISSUE_SHEET';
const AREA_STOCK_SHEET = 'AREA_STOCK';
const DEMAND_SHEET = 'Demand_Alerts';
const RETURN_HEADER_SHEET = 'Return_Header';
const RETURN_DETAILS_SHEET = 'Return_Details';
const DEVICETOKENS_SHEET = 'DeviceTokens';

// External spreadsheet (NOT this project's own Sheet) -- shared with this
// script's owner account for read-only access. Holds PR/PO/vendor detail
// keyed by Mat Code (== our UCS_Code). Never shared with end users directly;
// only this script (running "as Me") reads from it.
const PO_PR_SHEET_ID = '138vT2HDiLc-GcUHMelYuni8RoYAFZ2HfvVcVB6Qq9xI';
const PO_PR_TAB_NAME = 'Material List';

// ---- PR/PO Dashboard additions (same external spreadsheet, second tab) ----
// Tab name is spelled exactly "PR LIst" (capital I) in the actual sheet --
// getSheetByName() is exact-match, so this typo must be preserved here.
const PR_LIST_TAB_NAME = 'PR LIst';
// PR List's real header row is row 2 (index 1) -- row 1 is a banner row
// holding just a date, not headers. Data starts row 3 (index 2).
const PR_LIST_HEADER_ROW_INDEX = 1;
// PR List column AC (index 28) carries the literal text "Deleted" for a
// voided PR, with no header of its own above it.
const PR_LIST_DELETED_COL_INDEX = 28;
// Material List has three column-name collisions ("Qty" appears at index
// 7 and 19; "PO Qty" appears at index 29 and 42) -- header-name lookup
// would silently grab the FIRST match every time, which is wrong for two
// of these. Read by fixed index instead, confirmed against the real sheet.
const ML_COL = {
  PR_NO: 1,
  MAT_CODE: 4,
  DESCRIPTION: 5,
  LINE_QTY: 7,        // PR-side ordered qty (first "Qty" column)
  PO_NO: 16,
  PO_DT: 17,
  PO_LINE_QTY: 19,    // PO-side line qty (second "Qty" column) -- confirmed by project owner
  V_CODE: 26,
  V_NAME: 27,
  PO_QTY: 29,         // used for the fully-received comparison -- confirmed by project owner
  QTY_105: 34,
  DT_105: 41,
  PO_DP: 24,          // PO-level delivery period -- same value across every item on one PO
  ALT_DP: 25,         // per-item alternate delivery period
  PO_RATE: 20,        // per-unit PO rate -- used with outstanding qty (PO Qty - 105 Qty) to compute PO Value Outstanding
  PO_VALUE: 21,       // per-item full PO value
  PR_LINE_RATE: 10,   // per-UNIT PR-side rate ("Rate Value") -- the correct basis for capital-goods classification
  PR_DEL_DT: 14,      // item's requested delivery date at PR-raise time -- the budget-reservation date BEFORE any PO exists
  PR_LINE_VALUE: 11   // per-item PR-side TOTAL value ("Tot Value" = Rate x Qty) -- used for display/summation, not classification
};

// ====== ENTRY POINTS ======

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Apps Script backend is running.' });
}

/**
 * Entry point. Runs the requested action, THEN (after any script lock the
 * action held has already been released): invalidates caches if it was a
 * write, and sends any queued push notifications in one parallel batch.
 */
function doPost(e) {
  // "Refresh Now" sends forceFresh: discard every cache first, so the button
  // always shows the true current state -- including after a row was
  // deleted by hand in the Sheet (the one edit onEdit can't detect).
  try {
    if (JSON.parse(e.postData.contents).forceFresh === true) bumpDataVersion_();
  } catch (err) { /* malformed body -- doPostInner_ reports it */ }
  const response = doPostInner_(e);
  try {
    const action = String(JSON.parse(e.postData.contents).action || '');
    if (!isCacheNeutralAction_(action)) bumpDataVersion_();
  } catch (err) { /* malformed body -- doPostInner_ already returned an error */ }
  flushPushNotifications_();
  return response;
}

function doPostInner_(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'login') { return jsonResponse(checkLogin(data.email, data.password)); }
    if (action === 'requestAccountCode') { return requestAccountCode(data); }
    if (action === 'verifyCodeAndSetPassword') { return verifyCodeAndSetPassword(data); }
    if (action === 'addUCSCode') { return addUCSCode(data); }
    if (action === 'getUCSByCode') { return getUCSByCode(data); }
    if (action === 'checkUCSCodeExists') { return checkUCSCodeExists(data); }
    if (action === 'getUCSSearchData') { return getUCSSearchData(data); }
    if (action === 'checkSTONoExists') { return checkSTONoExists(data); }
    if (action === 'editUCSText') { return editUCSText(data); }
    if (action === 'addSTOEntry') { return addSTOEntry(data); }
    if (action === 'getSTOList') { return getSTOList(data); }
    if (action === 'receiveSTOMaterial') { return receiveSTOMaterial(data); }
    if (action === 'editSTOReceivedInfo') { return editSTOReceivedInfo(data); }
    if (action === 'editSTOEntry') { return editSTOEntry(data); }
    if (action === 'deleteSTOEntry') { return deleteSTOEntry(data); }
    if (action === 'restoreSTOEntry') { return restoreSTOEntry(data); }
    if (action === 'getEligibleSTOsForZ04') { return getEligibleSTOsForZ04(data); }
    if (action === 'checkMatDocNoExists') { return checkMatDocNoExists(data); }
    if (action === 'addZ04Entry') { return addZ04Entry(data); }
    if (action === 'getZ04DetailsForSTO') { return getZ04DetailsForSTO(data); }
    if (action === 'getOptionsList') { return getOptionsList(data); }
    if (action === 'addOptionValue') { return addOptionValue(data); }
    if (action === 'getEligibleZ04sFor201') { return getEligibleZ04sFor201(data); }
    if (action === 'addS201Entry') { return addS201Entry(data); }
    if (action === 'getS201EntriesForSTO') { return getS201EntriesForSTO(data); }
    if (action === 'raiseRequisition') { return raiseRequisition(data); }
    if (action === 'getPendingAreaApprovals') { return getPendingAreaApprovals(data); }
    if (action === 'approveAreaRequisition') { return approveAreaRequisition(data); }
    if (action === 'getPendingSanctions') { return getPendingSanctions(data); }
    if (action === 'sanctionRequisition') { return sanctionRequisition(data); }
    if (action === 'getPendingIssues') { return getPendingIssues(data); }
    if (action === 'issueRequisition') { return issueRequisition(data); }
    if (action === 'getAreaRequisitions') { return getAreaRequisitions(data); }
    if (action === 'getPlanningStockList') { return getPlanningStockList(data); }
    if (action === 'refreshPlanningStock') { return refreshPlanningStockEndpoint(data); }
    if (action === 'getUCSCodeHistory') { return getUCSCodeHistory(data); }
    if (action === 'getPRItems') { return getPRItems(data); }
    if (action === 'getPOItems') { return getPOItems(data); }
    if (action === 'getPRPODashboardData') { return getPRPODashboardData(data); }
    if (action === 'getProcurementDashboardSettings') { return getProcurementDashboardSettings(data); }
    if (action === 'updateProcurementDashboardSettings') { return updateProcurementDashboardSettings(data); }
    if (action === 'recordLocalIssue') { return recordLocalIssue(data); }
    if (action === 'getMyLocalIssues') { return getMyLocalIssues(data); }
    if (action === 'getAreaStockList') { return getAreaStockList(data); }
    if (action === 'refreshAreaStock') { return refreshAreaStockEndpoint(data); }
    if (action === 'submitDemandAlert') { return submitDemandAlert(data); }
    if (action === 'getDemandAlerts') { return getDemandAlerts(data); }
    if (action === 'updateDemandAlertStatus') { return updateDemandAlertStatus(data); }
    if (action === 'getMyDemandAlerts') { return getMyDemandAlerts(data); }

    if (action === 'raiseReturn') { return raiseReturn(data); }
    if (action === 'getPendingReturnApprovals') { return getPendingReturnApprovals(data); }
    if (action === 'approveReturn') { return approveReturn(data); }
    if (action === 'getAreaReturns') { return getAreaReturns(data); }

    if (action === 'getPastVendors') { return getPastVendors(data); }
    if (action === 'getVendorSupplyHistory') { return getVendorSupplyHistory(data); }
    if (action === 'getVendorFinderWarmup') { return getVendorFinderWarmup(data); }

    if (action === 'registerPushToken') { return registerPushToken(data); }

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Server error: ' + err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// ====== PERFORMANCE: SERVER-SIDE CACHE ======
// =====================================================================
// Every read used to recompute from raw sheets (Planning Stock alone reads
// 4 sheets; Area Stock reads 6) -- and with ~20 users polling every few
// seconds, that load is what pushed the script past Google's limit of ~30
// simultaneous executions, causing 20s queues and outright load failures.
//
// SAFETY MODEL -- a cached value can never outlive the data it came from:
// every cached value is stored under the current DATA VERSION. The version
// changes the moment anything is written -- by the app (bumped in doPost
// after every write action) or by hand in the Sheet (bumped in onEdit) --
// so the very next read after any change recomputes fresh. The TTL is only
// a backstop for the one change onEdit can't see: deleting whole rows by
// hand, which reflects within the TTL (5-10 min).
//
// Write paths that VALIDATE against stock (raise/issue requisition, local
// issue, raise/approve return) deliberately never use these caches -- they
// always recompute fresh inside their script lock, so a stock check can
// never be made against a stale number.
const CACHE_CHUNK_CHARS = 24000; // CacheService caps each value at 100KB; 24k chars stays under it even for multi-byte text

function putCachedString_(key, str, ttlSeconds) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Math.ceil(str.length / CACHE_CHUNK_CHARS) || 1;
    const entries = {};
    for (let i = 0; i < n; i++) entries[key + '_c' + i] = str.substring(i * CACHE_CHUNK_CHARS, (i + 1) * CACHE_CHUNK_CHARS);
    const keys = Object.keys(entries);
    for (let b = 0; b < keys.length; b += 20) {
      const batch = {};
      keys.slice(b, b + 20).forEach(function (k) { batch[k] = entries[k]; });
      cache.putAll(batch, ttlSeconds);
    }
    cache.put(key + '_n', String(n), ttlSeconds); // written LAST -- a reader never sees a count whose chunks aren't all there yet
  } catch (e) {
    console.error('putCachedString_ failed for ' + key + ': ' + e.message); // too big / cache full -- just skip caching, never fail the request
  }
}

function getCachedString_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const nStr = cache.get(key + '_n');
    if (!nStr) return null;
    const n = Number(nStr);
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + '_c' + i);
    const got = cache.getAll(keys);
    let out = '';
    for (let i = 0; i < n; i++) {
      const part = got[keys[i]];
      if (part === undefined || part === null) return null; // a chunk was evicted -- treat the whole entry as a miss
      out += part;
    }
    return out;
  } catch (e) {
    return null;
  }
}

function getDataVersion_() {
  const cache = CacheService.getScriptCache();
  let v = cache.get('dataVersion');
  if (!v) {
    v = String(Date.now()) + Math.floor(Math.random() * 1000);
    cache.put('dataVersion', v, 21600);
  }
  return v;
}

function bumpDataVersion_() {
  try {
    CacheService.getScriptCache().put('dataVersion', String(Date.now()) + Math.floor(Math.random() * 1000), 21600);
  } catch (e) { /* worst case: caches expire on their own TTL */ }
}

/** Cached JSON value under the current data version -- recomputed after any write. */
function cachedJson_(name, ttlSeconds, computeFn) {
  const key = name + '_v' + getDataVersion_(); // captured BEFORE computing, so a write mid-compute can never be cached as current
  const hit = getCachedString_(key);
  if (hit !== null) return JSON.parse(hit);
  const value = computeFn();
  putCachedString_(key, JSON.stringify(value), ttlSeconds);
  return value;
}

/**
 * Same idea for a whole API response. Only a successful response is ever
 * cached -- an error is always recomputed next time. versioned=false is
 * only for data this spreadsheet's writes can't affect (the external
 * PR/PO sheet), which relies on its TTL alone.
 */
function cachedResponse_(name, versioned, ttlSeconds, computeFn) {
  const key = versioned ? name + '_v' + getDataVersion_() : name;
  const hit = getCachedString_(key);
  if (hit !== null) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const out = computeFn();
  const text = out.getContent();
  if (text.indexOf('{"success":true') === 0) putCachedString_(key, text, ttlSeconds);
  return out;
}

/** Users sheet, cached -- checkLogin runs on EVERY API call, so this alone removes a full sheet read from every request. */
function getUsersValues_() {
  return cachedJson_('users', 300, function () {
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET).getDataRange().getValues();
  });
}

/** Display-only stock numbers (dashboards, search). Write-path validation must call the uncached compute functions directly. */
function getPlanningStockMapCached_() {
  return cachedJson_('plngMap', 600, computePlanningStockMap_);
}
function getAreaStockMapCached_() {
  return cachedJson_('areaMap', 600, computeAreaStockMap_);
}

/**
 * Simple trigger: runs automatically whenever someone edits the Sheet by
 * hand (a new user row, a corrected quantity, etc.), so a manual edit is
 * picked up by the very next read, exactly like an in-app write is.
 */
function onEdit(e) {
  bumpDataVersion_();
}

// Actions that never change anything a cache depends on. Every OTHER
// action bumps the data version after it runs (see doPost). Unknown or
// newly added actions therefore invalidate by default -- the safe side.
function isCacheNeutralAction_(action) {
  if (/^(get|check)/.test(action)) return true;
  return ['login', 'requestAccountCode', 'registerPushToken', 'refreshPlanningStock', 'refreshAreaStock'].indexOf(action) !== -1;
}

function hasCommaValue(str, target) {
  if (!str) return false;
  const targetLower = String(target).toLowerCase();
  return String(str).split(',').map(s => s.trim().toLowerCase()).indexOf(targetLower) !== -1;
}

function parseDateOnly(str) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function toMidnight(val) {
  if (!val) return null;
  const d = (Object.prototype.toString.call(val) === '[object Date]') ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDateOut(val) {
  if (val === '' || val === null || val === undefined) return '';
  if (Object.prototype.toString.call(val) === '[object Date]') {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return String(val);
}

function isBlankCell(val) {
  return val === '' || val === null || val === undefined;
}

function checkLogin(email, password) {
  if (!email || !password) {
    return { success: false, message: 'Email and password are required.' };
  }
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const passCol = headers.indexOf('Password');
  const nameCol = headers.indexOf('Name');
  const roleCol = headers.indexOf('Role');
  const areaCol = headers.indexOf('Authorized_Area');
  const normalizedInput = String(email).trim().toLowerCase();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[emailCol]).trim().toLowerCase() === normalizedInput) {
      const stored = row[passCol];
      if (isBlankCell(stored)) {
        return { success: false, needsSetup: true, message: 'This account has not been set up yet. Click "Forgot password? / First time here?" below to create your password.' };
      }
      if (verifyPassword_(String(password), stored)) {
        return {
          success: true, name: row[nameCol], role: row[roleCol],
          authorizedArea: areaCol !== -1 ? row[areaCol] : '', isAdmin: isApprover(row[roleCol])
        };
      }
      return { success: false, message: 'Incorrect password.' };
    }
  }
  return { success: false, message: 'User not found.' };
}

function isApprover(roleString) { return hasCommaValue(roleString, 'Approver'); }

// Saves (or updates) the FCM device token for the logged-in user, keyed by
// email. Called once from shared.js right after a successful login. This is
// the ONLY place that writes to DeviceTokens -- sendPushNotification_() only
// ever reads from it.
function registerPushToken(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return jsonResponse(login);

  const token = String(data.token || '').trim();
  if (!token) return jsonResponse({ success: false, message: 'No token provided.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEVICETOKENS_SHEET);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const emailCol = headers.indexOf('Email');
    const tokenCol = headers.indexOf('Token');
    const normalizedEmail = String(data.email).trim().toLowerCase();

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][emailCol]).trim().toLowerCase() === normalizedEmail) {
        sheet.getRange(i + 1, tokenCol + 1).setValue(token); // overwrite -- one token per email, latest device wins
        return jsonResponse({ success: true });
      }
    }
    const newRow = new Array(headers.length).fill('');
    newRow[emailCol] = data.email;
    newRow[tokenCol] = token;
    sheet.appendRow(newRow);
    return jsonResponse({ success: true });
  } finally {
    lock.releaseLock();
  }
}

// ---- Sending push notifications via Firebase Cloud Messaging (FCM) ----
// FIREBASE_SERVICE_ACCOUNT_JSON is a Script Property (Project Settings ->
// Script Properties), never a file or Sheet cell -- the private key inside
// it must never appear in GitHub or anywhere else public.

/**
 * Exchanges the service account's private key for a short-lived FCM access
 * token via a signed JWT, per Google's OAuth2 service-account flow. Cached
 * for just under its real 1-hour lifetime so a burst of notifications
 * (e.g. several requisition approvals in a row) doesn't re-sign a fresh
 * JWT and round-trip to Google on every single call.
 */
function getFcmAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('fcm_access_token');
  if (cached) return cached;

  const svcJson = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!svcJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON script property is not set.');
  const svc = JSON.parse(svcJson);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  function base64url_(obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  }
  const toSign = base64url_(header) + '.' + base64url_(claimSet);
  const signatureBytes = Utilities.computeRsaSha256Signature(toSign, svc.private_key);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  const jwt = toSign + '.' + signature;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error('Could not get an FCM access token: ' + res.getContentText());

  cache.put('fcm_access_token', data.access_token, 3500); // just under the real 1-hour expiry
  return data.access_token;
}

function getDeviceTokenForEmail_(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEVICETOKENS_SHEET);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0];
  const emailCol = headers.indexOf('Email');
  const tokenCol = headers.indexOf('Token');
  const target = String(email).trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][emailCol]).trim().toLowerCase() === target) {
      return values[i][tokenCol] || null;
    }
  }
  return null;
}

function removeDeviceTokenForEmail_(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEVICETOKENS_SHEET);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const emailCol = headers.indexOf('Email');
  const target = String(email).trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][emailCol]).trim().toLowerCase() === target) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

/**
 * The one reusable notification sender -- every one of the 9 workflow
 * events will just call this with the right person's email and a message.
 * Deliberately fails silent: a notification is a nice-to-have layered on
 * top of the real business action (approving a slip, raising an STO,
 * etc.), and must never be the reason that real action itself fails, so
 * every error here is caught and logged, never thrown back to the caller.
 * Also silently does nothing for a user with no device token on file yet
 * (e.g. hasn't opened the Android app since this feature shipped).
 */
// Notifications are QUEUED during an action, not sent inline. The old
// inline send cost ~0.3-0.7s per recipient, one after another, while the
// action still held the script lock -- so every other user's save waited
// behind it, and any wait over 10s failed outright. doPost now sends the
// whole queue in ONE parallel batch after the action has finished and
// released its lock. Globals reset per execution, so a queue can never
// leak between two different requests.
var PUSH_QUEUE_ = [];

/**
 * The one reusable notification call -- every workflow event calls this.
 * Never throws and never slows the action it's called from; the real
 * sending happens later in flushPushNotifications_().
 */
function sendPushNotification(toEmail, title, body, page) {
  if (!toEmail) return;
  PUSH_QUEUE_.push({ email: String(toEmail), title: title, body: body, page: page });
}

function flushPushNotifications_() {
  if (!PUSH_QUEUE_.length) return;
  const queue = PUSH_QUEUE_.splice(0);
  try {
    // One read of DeviceTokens for the whole batch (was one read per recipient).
    const tokenSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEVICETOKENS_SHEET);
    if (!tokenSheet) return;
    const tv = tokenSheet.getDataRange().getValues();
    if (tv.length < 2) return;
    const eCol = tv[0].indexOf('Email');
    const tCol = tv[0].indexOf('Token');
    const tokenByEmail = {};
    for (let i = 1; i < tv.length; i++) {
      const em = String(tv[i][eCol]).trim().toLowerCase();
      if (em && tv[i][tCol]) tokenByEmail[em] = String(tv[i][tCol]);
    }

    const svc = JSON.parse(PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT_JSON'));
    const accessToken = getFcmAccessToken_();
    const url = 'https://fcm.googleapis.com/v1/projects/' + svc.project_id + '/messages:send';

    const requests = [];
    const requestEmails = [];
    const seen = {};
    queue.forEach(function (n) {
      const em = n.email.trim().toLowerCase();
      const token = tokenByEmail[em];
      if (!token) return; // no device on file (never opened the Android app) -- silently skip
      const dedupeKey = em + '|' + n.title + '|' + n.body;
      if (seen[dedupeKey]) return;
      seen[dedupeKey] = true;
      const message = { token: token, notification: { title: n.title, body: n.body } };
      // 'page' matches a key in shared.js's PAGES array -- read by the
      // pushNotificationActionPerformed listener to deep-link a tap
      // straight to the relevant screen.
      if (n.page) message.data = { page: String(n.page) };
      requests.push({
        url: url,
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: JSON.stringify({ message: message }),
        muteHttpExceptions: true
      });
      requestEmails.push(n.email);
    });
    if (!requests.length) return;

    const responses = UrlFetchApp.fetchAll(requests); // all sent in parallel
    const removed = {};
    responses.forEach(function (res, i) {
      // A stale token (app reinstalled/uninstalled since it was saved) comes
      // back as UNREGISTERED -- clean it up so future sends don't keep
      // silently failing against a dead token.
      if (res.getResponseCode() === 404 || res.getContentText().indexOf('UNREGISTERED') !== -1) {
        const em = requestEmails[i].trim().toLowerCase();
        if (!removed[em]) { removed[em] = true; removeDeviceTokenForEmail_(requestEmails[i]); }
      }
    });
  } catch (e) {
    console.error('flushPushNotifications_ failed: ' + e.message); // never let a notification problem affect the user's action
  }
}

/**
 * RUN FROM THE EDITOR to test the pipeline standalone (e.g. after adding a
 * new user). Edit the email below, select this function next to the Run
 * button, click Run, then check that phone.
 */
function testSendPushNotification() {
  sendPushNotification('YOUR-EMAIL-HERE@example.com', 'Test Notification', 'If you see this, push notifications are working end-to-end!');
  flushPushNotifications_(); // editor runs don't go through doPost, so flush explicitly
}
function canManageSTO(authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, 'Planning') && !hasCommaValue(roleString, 'Store Incharge');
}

function requireAdmin(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return { ok: false, response: jsonResponse(login) };
  if (!login.isAdmin) return { ok: false, response: jsonResponse({ success: false, message: 'Only Approvers (Admins) can perform this action.' }) };
  return { ok: true, login: login };
}

function requireSTOAccess(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return { ok: false, response: jsonResponse(login) };
  if (!canManageSTO(login.authorizedArea, login.role)) return { ok: false, response: jsonResponse({ success: false, message: 'Only Planning staff (excluding Store Incharge) can perform this action.' }) };
  return { ok: true, login: login };
}

function requireAnyUser(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return { ok: false, response: jsonResponse(login) };
  return { ok: true, login: login };
}

function isPlanningAreaStaff(authorizedAreaString) { return hasCommaValue(authorizedAreaString, 'Planning'); }

function requirePlanningAreaStaff(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return { ok: false, response: jsonResponse(login) };
  if (!isPlanningAreaStaff(login.authorizedArea)) return { ok: false, response: jsonResponse({ success: false, message: 'Only staff whose Authorized Area includes Planning can view this detail.' }) };
  return { ok: true, login: login };
}

// =====================================================================
// ====== PERFORMANCE: BATCHED SHEET WRITES ======
// =====================================================================
// Every Sheets call is a separate round trip (~0.1-0.2s). Saves used to
// write cell by cell -- approving a 10-item slip made ~40 calls, all while
// holding the script lock, so everyone else's save waited too. These
// helpers write the SAME values to the SAME cells in as few calls as
// possible. They only ever touch the exact cells listed -- never a whole
// row -- so any formula or manual entry in other columns is left alone.

/** Header row only -- instead of reading the WHOLE sheet just to get row 1. */
function readHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

/**
 * Writes cells = [{ row: 1-based sheet row, col: 0-based column, value }].
 * Groups them into rectangles (consecutive rows that share consecutive
 * columns) and writes each rectangle with one setValues() call. Same
 * result as one setValue() per cell.
 */
function writeCells_(sheet, cells) {
  if (!cells.length) return;
  const byRow = {};
  cells.forEach(function (c) { (byRow[c.row] = byRow[c.row] || {})[c.col] = c.value; });
  const rows = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
  const colKey = function (r) { return Object.keys(byRow[r]).map(Number).sort(function (a, b) { return a - b; }).join(','); };
  let i = 0;
  while (i < rows.length) {
    // run of consecutive rows writing the identical set of columns
    let j = i;
    const key = colKey(rows[i]);
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1 && colKey(rows[j + 1]) === key) j++;
    const cols = key.split(',').map(Number);
    // split the column set into consecutive column runs
    let k = 0;
    while (k < cols.length) {
      let m = k;
      while (m + 1 < cols.length && cols[m + 1] === cols[m] + 1) m++;
      const block = [];
      for (let r = i; r <= j; r++) {
        const line = [];
        for (let c = k; c <= m; c++) line.push(byRow[rows[r]][cols[c]]);
        block.push(line);
      }
      sheet.getRange(rows[i], cols[k] + 1, j - i + 1, m - k + 1).setValues(block);
      k = m + 1;
    }
    i = j + 1;
  }
}

/**
 * Appends rows (arrays, one per sheet row) in ONE call instead of one
 * appendRow() each, then applies plain-text format to the listed 0-based
 * columns over just the new rows -- same end state as appendRow() +
 * setNumberFormat('@STRING@') per row. Always called inside the caller's
 * script lock, so nobody else can append between the two steps.
 */
function appendRows_(sheet, rows, textCols) {
  if (!rows.length) return;
  const width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  const block = rows.map(function (r) { const out = r.slice(); while (out.length < width) out.push(''); return out; });
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, block.length, width).setValues(block);
  (textCols || []).forEach(function (c) {
    sheet.getRange(start, c + 1, block.length, 1).setNumberFormat('@STRING@');
  });
}

function getColIndexOrThrow_(headers, name, sheetLabel) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error('Column "' + name + '" not found in ' + sheetLabel + '. Check the header row for exact spelling/case/underscores.');
  return idx;
}

function addUCSCode(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const ucsCode = String(data.ucsCode || '').trim();
  const shortText = String(data.shortText || '').trim();
  const longText = String(data.longText || '').trim();
  const unit = String(data.unit || '').trim();

  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  if (!shortText) return jsonResponse({ success: false, message: 'Short Text is required.' });
  if (!longText) return jsonResponse({ success: false, message: 'Long Text is required.' });
  const allowedUnits = readOptionsColumn('Unit');
  if (allowedUnits.indexOf(unit) === -1) return jsonResponse({ success: false, message: 'Invalid unit. Allowed: ' + allowedUnits.join(', ') });
  if (shortText.length > 200) return jsonResponse({ success: false, message: 'Short Text is too long (max 200 characters).' });
  if (longText.length > 2000) return jsonResponse({ success: false, message: 'Long Text is too long (max 2000 characters).' });

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = ucsSheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      return jsonResponse({ success: false, message: 'UCS Code ' + ucsCode + ' already exists. Existing codes cannot be re-used or overwritten.' });
    }
  }
  ucsSheet.appendRow([ucsCode, shortText, longText, unit]);
  const newRow = ucsSheet.getLastRow();
  ucsSheet.getRange(newRow, codeCol + 1).setNumberFormat('@STRING@');
  logAudit(login.name, data.email, 'ADD_UCS_CODE', 'Added new UCS Code: ' + ucsCode);
  return jsonResponse({ success: true, message: 'UCS Code ' + ucsCode + ' added successfully.' });
}

function getUCSByCode(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  const unitCol = headers.indexOf('Unit');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      return jsonResponse({ success: true, ucsCode: values[i][codeCol], shortText: values[i][shortCol], longText: values[i][longCol], unit: values[i][unitCol] });
    }
  }
  return jsonResponse({ success: false, message: 'UCS Code not found.' });
}

function checkUCSCodeExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const unitCol = headers.indexOf('Unit');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      return jsonResponse({ success: true, exists: true, itemDescription: values[i][shortCol], unit: values[i][unitCol] });
    }
  }
  return jsonResponse({ success: true, exists: false });
}

function getUCSSearchData(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  return cachedResponse_('ucsSearch', true, 600, function () { return getUCSSearchDataUncached_(data); });
}

function getUCSSearchDataUncached_(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  const unitCol = headers.indexOf('Unit');
  const stockMap = getPlanningStockMapCached_();
  const items = [];
  for (let i = 1; i < values.length; i++) {
    const ucsCode = String(values[i][codeCol] || '').trim();
    if (!ucsCode) continue;
    items.push({
      ucsCode: ucsCode, shortText: String(values[i][shortCol] || ''), longText: String(values[i][longCol] || ''),
      unit: String(values[i][unitCol] || ''), availableAtPlanning: stockMap[ucsCode] ? stockMap[ucsCode].balance : 0
    });
  }
  return jsonResponse({ success: true, items: items });
}

function checkSTONoExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = {};
  headers.forEach((h, idx) => { col[h] = idx; });
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['STO_No']]).trim() === stoNo) {
      const row = values[i];
      if (isSTODeleted_(row, col)) {
        return jsonResponse({ success: true, exists: true, deleted: true, deletedDate: formatDateOut(row[col['Deleted_Timestamp']]), deletedReason: row[col['Deleted_Reason']] || '' });
      }
      return jsonResponse({ success: true, exists: true });
    }
  }
  return jsonResponse({ success: true, exists: false });
}

function editUCSText(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const ucsCode = String(data.ucsCode || '').trim();
  const newShortText = String(data.shortText || '').trim();
  const newLongText = String(data.longText || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  if (!newShortText) return jsonResponse({ success: false, message: 'Short Text is required.' });
  if (!newLongText) return jsonResponse({ success: false, message: 'Long Text is required.' });
  if (newShortText.length > 200) return jsonResponse({ success: false, message: 'Short Text too long (max 200 characters).' });
  if (newLongText.length > 2000) return jsonResponse({ success: false, message: 'Long Text too long (max 2000 characters).' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      const oldShort = values[i][shortCol];
      const oldLong = values[i][longCol];
      if (String(oldShort) === newShortText && String(oldLong) === newLongText) {
        return jsonResponse({ success: false, message: 'No changes detected — nothing was updated.' });
      }
      const rowNum = i + 1;
      sheet.getRange(rowNum, shortCol + 1).setValue(newShortText);
      sheet.getRange(rowNum, longCol + 1).setValue(newLongText);
      logAudit(login.name, data.email, 'EDIT_UCS_TEXT', 'Code ' + ucsCode + ' | Short: "' + oldShort + '" -> "' + newShortText + '"' + ' | Long: "' + oldLong + '" -> "' + newLongText + '"');
      return jsonResponse({ success: true, message: 'UCS Code ' + ucsCode + ' updated successfully.' });
    }
  }
  return jsonResponse({ success: false, message: 'UCS Code not found.' });
}

function addSTOEntry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoDateStr = String(data.stoDate || '').trim();
  const stoNo = String(data.stoNo || '').trim();
  const ucsCode = String(data.ucsCode || '').trim();
  const qtyRaw = data.qty;
  const recQtyRaw = data.receivedQty;
  const recDateStr = String(data.receivedDate || '').trim();
  const refPO = String(data.referencePO || '').trim();

  if (!stoDateStr) return jsonResponse({ success: false, message: 'STO Date is required.' });
  const stoDateObj = parseDateOnly(stoDateStr);
  if (!stoDateObj) return jsonResponse({ success: false, message: 'STO Date is invalid.' });
  const today = startOfToday();
  if (stoDateObj > today) return jsonResponse({ success: false, message: 'STO Date cannot be in the future.' });
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  if (qtyRaw === undefined || qtyRaw === null || qtyRaw === '') return jsonResponse({ success: false, message: 'Qty is required.' });
  const qty = Number(qtyRaw);
  if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0) return jsonResponse({ success: false, message: 'Qty must be a positive whole number (no zero, negative, or decimals).' });

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = ucsHeaders.indexOf('UCS_Code');
  const ucsShortCol = ucsHeaders.indexOf('Short_Text');
  const ucsUnitCol = ucsHeaders.indexOf('Unit');
  let ucsRow = null;
  for (let i = 1; i < ucsValues.length; i++) {
    if (String(ucsValues[i][ucsCodeCol]).trim() === ucsCode) { ucsRow = ucsValues[i]; break; }
  }
  if (!ucsRow) return jsonResponse({ success: false, ucsNotFound: true, message: 'UCS Code ' + ucsCode + ' was not found in UCS_MasterList.' });
  const itemDescription = ucsRow[ucsShortCol];
  const unit = ucsRow[ucsUnitCol];

  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  const stoHeaders = stoValues[0];
  const col = {};
  stoHeaders.forEach((h, idx) => { col[h] = idx; });
  for (let i = 1; i < stoValues.length; i++) {
    if (String(stoValues[i][col['STO_No']]).trim() === stoNo) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' already exists. STO numbers must be unique.' });
  }

  const hasRecQty = !(recQtyRaw === undefined || recQtyRaw === null || recQtyRaw === '');
  const hasRecDate = !!recDateStr;
  const hasRefPO = !!refPO;
  const anyReceivingFilled = hasRecQty || hasRecDate || hasRefPO;
  const allReceivingFilled = hasRecQty && hasRecDate && hasRefPO;
  if (anyReceivingFilled && !allReceivingFilled) {
    return jsonResponse({ success: false, message: 'Received Qty, Received Date, and Reference PO must all be filled together, or all left blank.' });
  }

  let receivedQtyOut = '', receivedDateOut = '', referencePOOut = '', isLocked = false;
  if (allReceivingFilled) {
    const recQty = Number(recQtyRaw);
    if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
    if (recQty > qty) return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + qty + ').' });
    const recDateObj = parseDateOnly(recDateStr);
    if (!recDateObj) return jsonResponse({ success: false, message: 'Received Date is invalid.' });
    if (recDateObj > today) return jsonResponse({ success: false, message: 'Received Date cannot be in the future.' });
    if (recDateObj < stoDateObj) return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });
    receivedQtyOut = recQty; receivedDateOut = recDateObj; referencePOOut = refPO; isLocked = true;
  }

  stoSheet.appendRow([stoDateObj, stoNo, ucsCode, itemDescription, qty, unit, receivedQtyOut, receivedDateOut, referencePOOut]);
  const newRow = stoSheet.getLastRow();
  stoSheet.getRange(newRow, col['STO_No'] + 1).setNumberFormat('@STRING@');
  stoSheet.getRange(newRow, col['UCS_Code'] + 1).setNumberFormat('@STRING@');
  logAudit(login.name, data.email, 'ADD_STO_ENTRY', 'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty ' + qty + (isLocked ? ' | Received at creation: Qty ' + receivedQtyOut + ', Date ' + recDateStr + ', Ref ' + referencePOOut + ' (auto-locked)' : ' | Pending receipt'));
  return jsonResponse({ success: true, message: 'STO ' + stoNo + ' added successfully.' + (isLocked ? ' Received details were complete, so it has been locked.' : ''), itemDescription: itemDescription, unit: unit, locked: isLocked });
}

/**
 * PERFORMANCE: every STO row (deleted ones included, flagged) with its Z04 /
 * 201 status, computed from STO_MasterList + S_Z04 + S_201 and cached under
 * the data version -- so any save, or any hand edit in the Sheet, makes the
 * very next call recompute. getSTOList() then only filters and pages this
 * list, instead of re-reading three sheets on every search keystroke,
 * filter change and page flip of the STO Dashboard. Returns null for an
 * empty STO sheet.
 */
function getSTOAllRowsCached_() {
  return cachedJson_('stoAllRows', 600, function () {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return null; // empty sheet -- caller returns the same empty page as before
    const headers = values[0];
    const col = {};
    headers.forEach((h, idx) => { col[h] = idx; });

    const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
    const z04Values = z04Sheet.getDataRange().getValues();
    const z04Done = {};
    const z04QtyByStoNo = {};
    if (z04Values.length >= 2) {
      const z04Headers = z04Values[0];
      const z04StoCol = z04Headers.indexOf('STO_No');
      const z04QtyCol = z04Headers.indexOf('Qty_Recieved_Z04');
      for (let i = 1; i < z04Values.length; i++) {
        const stoNoKey = String(z04Values[i][z04StoCol]).trim();
        z04Done[stoNoKey] = true;
        z04QtyByStoNo[stoNoKey] = Number(z04Values[i][z04QtyCol]) || 0;
      }
    }

    const releasedByStoNo201 = sumReleasedByStoNo();
    function compute201Status(stoNo) {
      if (!z04Done[stoNo]) return 'na';
      const qtyZ04 = z04QtyByStoNo[stoNo] || 0;
      const released = releasedByStoNo201[stoNo] || 0;
      const remaining = qtyZ04 - released;
      if (remaining <= 0) return 'done';
      if (released > 0) return 'partial';
      return 'pending';
    }

    const allRows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const isDeleted = isSTODeleted_(r, col);
      const receivedQty = r[col['Received_Qty']];
      const receivedDate = r[col['Received_Date']];
      const referencePO = r[col['Reference_PO']];
      const pending = isBlankCell(receivedQty) && isBlankCell(receivedDate) && !referencePO;
      const stoNo = String(r[col['STO_No']]).trim();
      allRows.push({
        stoDateMs: (function (d) { return d ? d.getTime() : null; })(toMidnight(r[col['STO_Date']])), stoDate: formatDateOut(r[col['STO_Date']]), stoNo: stoNo,
        ucsCode: String(r[col['UCS_Code']]).trim(), itemDescription: r[col['Item_Description']], qty: r[col['Qty']], unit: r[col['Unit']],
        receivedQty: isBlankCell(receivedQty) ? '' : receivedQty, receivedDate: formatDateOut(receivedDate), referencePO: referencePO || '',
        pending: pending, z04Done: !!z04Done[stoNo], status201: compute201Status(stoNo),
        isDeleted: isDeleted, deletedBy: isDeleted ? r[col['Deleted_By']] : '', deletedDate: isDeleted ? formatDateOut(r[col['Deleted_Timestamp']]) : '', deletedReason: isDeleted ? (r[col['Deleted_Reason']] || '') : ''
      });
    }
    return allRows;
  });
}

function getSTOList(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  // Approver-only "Show deleted" view -- a non-admin passing this flag is
  // silently ignored rather than errored, same spirit as any other
  // client-supplied flag this app doesn't trust blindly.
  const includeDeleted = !!data.includeDeleted && !!login.isAdmin;
  const pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : 20;
  const cachedRows = getSTOAllRowsCached_();
  if (cachedRows === null) return jsonResponse({ success: true, rows: [], totalCount: 0, currentPage: 1, totalPages: 1, pageSize: pageSize });
  let allRows = cachedRows
    .filter(function (row) { return !(row.isDeleted && !includeDeleted); })
    .map(function (row) { const out = Object.assign({}, row, { stoDateObj: row.stoDateMs === null ? null : new Date(row.stoDateMs) }); delete out.stoDateMs; return out; });

  const startDateObj = data.startDate ? parseDateOnly(String(data.startDate).trim()) : null;
  const endDateObj = data.endDate ? parseDateOnly(String(data.endDate).trim()) : null;
  if (startDateObj || endDateObj) {
    allRows = allRows.filter(function (row) {
      if (!row.stoDateObj) return false;
      if (startDateObj && row.stoDateObj < startDateObj) return false;
      if (endDateObj && row.stoDateObj > endDateObj) return false;
      return true;
    });
  }
  // Bug fix: this previously only checked STO No and UCS Code, case-
  // sensitively -- despite the search box's own label promising "STO No,
  // UCS Code, or description". Item_Description was never included at all
  // (typing "vvvf" against a row whose description contains "VVVF" found
  // nothing, on two independent counts: the field wasn't searched, and even
  // .indexOf() itself is case-sensitive). Every other list/search screen in
  // this project already lowercases both sides before comparing
  // (search-ucs.html, planning-stock.html, area-stock-dashboard.html) --
  // this is the one server-side search that had drifted from that
  // convention. Not something this session's changes touched or caused;
  // getSTOList() was untouched until now.
  const searchTerm = String(data.search || '').trim().toLowerCase();
  if (searchTerm) {
    allRows = allRows.filter(function (row) {
      return row.stoNo.toLowerCase().indexOf(searchTerm) !== -1 ||
        row.ucsCode.toLowerCase().indexOf(searchTerm) !== -1 ||
        String(row.itemDescription || '').toLowerCase().indexOf(searchTerm) !== -1;
    });
  }
  const statusFilter = String(data.status || 'all').trim().toLowerCase();
  if (statusFilter === 'pending') allRows = allRows.filter(function (row) { return row.pending; });
  else if (statusFilter === 'received') allRows = allRows.filter(function (row) { return !row.pending; });
  const z04Filter = String(data.z04Status || 'all').trim().toLowerCase();
  if (z04Filter === 'z04pending') allRows = allRows.filter(function (row) { return !row.z04Done; });
  else if (z04Filter === 'z04done') allRows = allRows.filter(function (row) { return row.z04Done; });
  const status201Filter = String(data.status201 || 'all').trim().toLowerCase();
  if (status201Filter === '201pending') allRows = allRows.filter(function (row) { return row.status201 === 'pending'; });
  else if (status201Filter === '201partial') allRows = allRows.filter(function (row) { return row.status201 === 'partial'; });
  else if (status201Filter === '201done') allRows = allRows.filter(function (row) { return row.status201 === 'done'; });

  allRows.reverse();
  const totalCount = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  let page = Number(data.page) > 0 ? Number(data.page) : 1;
  if (page > totalPages) page = totalPages;
  const startIdx = (page - 1) * pageSize;
  const pageRows = allRows.slice(startIdx, startIdx + pageSize).map(function (row) {
    return { stoDate: row.stoDate, stoNo: row.stoNo, ucsCode: row.ucsCode, itemDescription: row.itemDescription, qty: row.qty, unit: row.unit, receivedQty: row.receivedQty, receivedDate: row.receivedDate, referencePO: row.referencePO, pending: row.pending, z04Done: row.z04Done, status201: row.status201, isDeleted: row.isDeleted, deletedBy: row.deletedBy, deletedDate: row.deletedDate, deletedReason: row.deletedReason };
  });
  return jsonResponse({ success: true, rows: pageRows, totalCount: totalCount, currentPage: page, totalPages: totalPages, pageSize: pageSize });
}

function receiveSTOMaterial(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  const recQtyRaw = data.receivedQty;
  const recDateStr = String(data.receivedDate || '').trim();
  const refPO = String(data.referencePO || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const col = {};
    headers.forEach((h, idx) => { col[h] = idx; });
    let targetIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col['STO_No']]).trim() === stoNo) { targetIndex = i; break; }
    }
    if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });
    const row = values[targetIndex];
    if (isSTODeleted_(row, col)) return jsonResponse({ success: false, message: 'STO ' + stoNo + ' has been deleted and can no longer be received.' });
    const existingQty = row[col['Received_Qty']];
    const existingDate = row[col['Received_Date']];
    const existingPO = row[col['Reference_PO']];
    const alreadyReceived = !isBlankCell(existingQty) || !isBlankCell(existingDate) || !!existingPO;
    if (alreadyReceived) return jsonResponse({ success: false, message: 'This STO has already been received and locked (possibly by another user). Please refresh the dashboard.' });
    const hasRecQty = !(recQtyRaw === undefined || recQtyRaw === null || recQtyRaw === '');
    if (!hasRecQty || !recDateStr || !refPO) return jsonResponse({ success: false, message: 'Received Qty, Received Date, and Reference PO are all required to complete receiving.' });
    const recQty = Number(recQtyRaw);
    if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
    const requestedQty = Number(row[col['Qty']]);
    if (recQty > requestedQty) return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + requestedQty + ').' });
    const recDateObj = parseDateOnly(recDateStr);
    if (!recDateObj) return jsonResponse({ success: false, message: 'Received Date is invalid.' });
    const today = startOfToday();
    if (recDateObj > today) return jsonResponse({ success: false, message: 'Received Date cannot be in the future.' });
    const stoDateMidnight = toMidnight(row[col['STO_Date']]);
    if (stoDateMidnight && recDateObj < stoDateMidnight) return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });
    const rowNum = targetIndex + 1;
    writeCells_(sheet, [ // one batched write instead of 3 separate calls
      { row: rowNum, col: col['Received_Qty'], value: recQty },
      { row: rowNum, col: col['Received_Date'], value: recDateObj },
      { row: rowNum, col: col['Reference_PO'], value: refPO }
    ]);
    logAudit(login.name, data.email, 'RECEIVE_STO_MATERIAL', 'STO ' + stoNo + ' | Received Qty ' + recQty + ' | Received Date ' + recDateStr + ' | Ref PO ' + refPO);
    return jsonResponse({ success: true, message: 'STO ' + stoNo + ' marked as received and locked.' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * True once an STO has been soft-deleted (Deleted_Status = 'Deleted').
 * col must be the header map for STO_MasterList; blank/missing column
 * (sheet not yet updated with the 4 new headers) reads as "not deleted"
 * rather than throwing, so this stays safe to call everywhere immediately,
 * even before the one-time sheet setup step is done.
 */
function isSTODeleted_(stoRow, col) {
  if (col['Deleted_Status'] === undefined) return false;
  return String(stoRow[col['Deleted_Status']] || '').trim() === 'Deleted';
}

/**
 * Soft-deletes an STO: tags it Deleted_Status/By/Timestamp/Reason rather
 * than removing the row, so the STO_No can never be reused (checkSTONoExists
 * / addSTOEntry's dup-check scans every row regardless of status) and the
 * full trail stays recoverable. Approver-only, same tier as correcting
 * received info or editing UCS text. Precondition mirrors isSTOLocked_ --
 * blocked once EITHER receiving is filled OR a Z04 exists, not just Z04:
 * a received-but-not-yet-Z04'd STO still represents material physically
 * sitting somewhere, and deleting the paper trail under it would orphan
 * that receipt.
 */
function deleteSTOEntry(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  const reason = String(data.reason || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!reason) return jsonResponse({ success: false, message: 'A reason is required to delete an STO.' });
  if (reason.length > 500) return jsonResponse({ success: false, message: 'Reason is too long (max 500 characters).' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const col = {};
    headers.forEach(function (h, idx) { col[h] = idx; });
    ['Deleted_Status', 'Deleted_By', 'Deleted_Timestamp', 'Deleted_Reason'].forEach(function (h) {
      if (col[h] === undefined) throw new Error('STO_MasterList is missing column "' + h + '" -- add it as a new header before using Delete/Restore.');
    });

    let targetIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col['STO_No']]).trim() === stoNo) { targetIndex = i; break; }
    }
    if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });
    const row = values[targetIndex];

    if (isSTODeleted_(row, col)) return jsonResponse({ success: false, message: 'STO ' + stoNo + ' is already deleted.' });
    // Fresh re-check, inside the lock -- someone may have just received or
    // Z04'd this exact STO a moment ago.
    if (isSTOLocked_(row, col, stoNo)) {
      return jsonResponse({ success: false, message: 'STO ' + stoNo + ' can no longer be deleted -- it has already been received and/or Z04\'d. Refresh the dashboard.' });
    }

    const now = new Date();
    const rowNum = targetIndex + 1;
    writeCells_(sheet, [ // one batched write instead of 4 separate calls
      { row: rowNum, col: col['Deleted_Status'], value: 'Deleted' },
      { row: rowNum, col: col['Deleted_By'], value: login.name },
      { row: rowNum, col: col['Deleted_Timestamp'], value: now },
      { row: rowNum, col: col['Deleted_Reason'], value: reason }
    ]);
    logAudit(login.name, data.email, 'DELETE_STO_ENTRY', 'STO ' + stoNo + ' | UCS ' + row[col['UCS_Code']] + ' | Qty ' + row[col['Qty']] + ' | Reason: ' + reason);
    return jsonResponse({ success: true, message: 'STO ' + stoNo + ' deleted. It will no longer appear on any dashboard, and its number can never be reused.' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Undoes a deleteSTOEntry() tag. Approver-only, symmetric with delete --
 * a wrong tag shouldn't need a manual sheet edit to fix.
 */
function restoreSTOEntry(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const col = {};
    headers.forEach(function (h, idx) { col[h] = idx; });
    ['Deleted_Status', 'Deleted_By', 'Deleted_Timestamp', 'Deleted_Reason'].forEach(function (h) {
      if (col[h] === undefined) throw new Error('STO_MasterList is missing column "' + h + '" -- add it as a new header before using Delete/Restore.');
    });

    let targetIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col['STO_No']]).trim() === stoNo) { targetIndex = i; break; }
    }
    if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });
    const row = values[targetIndex];
    if (!isSTODeleted_(row, col)) return jsonResponse({ success: false, message: 'STO ' + stoNo + ' is not currently deleted.' });

    const oldReason = row[col['Deleted_Reason']];
    const rowNum = targetIndex + 1;
    writeCells_(sheet, [ // one batched write instead of 4 separate calls
      { row: rowNum, col: col['Deleted_Status'], value: '' },
      { row: rowNum, col: col['Deleted_By'], value: '' },
      { row: rowNum, col: col['Deleted_Timestamp'], value: '' },
      { row: rowNum, col: col['Deleted_Reason'], value: '' }
    ]);
    logAudit(login.name, data.email, 'RESTORE_STO_ENTRY', 'STO ' + stoNo + ' | Previously deleted -- reason was: ' + oldReason);
    return jsonResponse({ success: true, message: 'STO ' + stoNo + ' restored.' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * True once an STO can no longer be safely edited (Qty / UCS Code):
 * either its receiving info has been filled in, OR a Z04 entry already
 * exists against it. The Z04 check matters even though the normal flow
 * is always receive-then-Z04, because addZ04Entry() does not itself
 * require the STO to be marked "received" first -- so without this
 * second check, a still-"Pending" STO that has already been Z04'd
 * could otherwise be edited out from under its own Z04 record.
 */
function isSTOLocked_(stoRow, col, stoNo) {
  const receivedQty = stoRow[col['Received_Qty']];
  const receivedDate = stoRow[col['Received_Date']];
  const referencePO = stoRow[col['Reference_PO']];
  const receivingFilled = !isBlankCell(receivedQty) || !isBlankCell(receivedDate) || !!referencePO;
  if (receivingFilled) return true;

  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length >= 2) {
    const z04Headers = z04Values[0];
    const z04StoCol = z04Headers.indexOf('STO_No');
    for (let i = 1; i < z04Values.length; i++) {
      if (String(z04Values[i][z04StoCol]).trim() === stoNo) return true;
    }
  }
  return false;
}

/**
 * Edits Qty and/or UCS_Code on an STO that is still fully open (see
 * isSTOLocked_ above). Planning-staff access (same as raising an STO),
 * not admin-only -- this is a pre-lock correction of the team's own
 * data entry, mirroring the real-world case: the physical cable drum
 * turns out to hold a different length, or the store hands over a
 * different gauge/spec than originally noted.
 *
 * data: { email, password, stoNo, qty, ucsCode }
 */
function editSTOEntry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const stoNo = String(data.stoNo || '').trim();
  const newQtyRaw = data.qty;
  const newUcsCode = String(data.ucsCode || '').trim();

  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (newQtyRaw === undefined || newQtyRaw === null || newQtyRaw === '') return jsonResponse({ success: false, message: 'Qty is required.' });
  const newQty = Number(newQtyRaw);
  if (isNaN(newQty) || !Number.isInteger(newQty) || newQty <= 0) return jsonResponse({ success: false, message: 'Qty must be a positive whole number (no zero, negative, or decimals).' });
  if (!newUcsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(newUcsCode)) return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const col = {};
    headers.forEach(function (h, idx) { col[h] = idx; });

    let targetIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][col['STO_No']]).trim() === stoNo) { targetIndex = i; break; }
    }
    if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });

    const row = values[targetIndex];

    if (isSTODeleted_(row, col)) return jsonResponse({ success: false, message: 'STO ' + stoNo + ' has been deleted and can no longer be edited.' });

    // Fresh re-check, inside the lock -- someone may have just received or
    // Z04'd this exact STO a moment ago.
    if (isSTOLocked_(row, col, stoNo)) {
      return jsonResponse({ success: false, message: 'This STO can no longer be edited -- it has already been received and/or Z04\'d. Refresh the dashboard.' });
    }

    // Resolve the new UCS Code -- must exist in UCS_MasterList, same rule
    // as raising a brand-new STO.
    const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
    const ucsValues = ucsSheet.getDataRange().getValues();
    const ucsHeaders = ucsValues[0];
    const ucsCodeCol = ucsHeaders.indexOf('UCS_Code');
    const ucsShortCol = ucsHeaders.indexOf('Short_Text');
    const ucsUnitCol = ucsHeaders.indexOf('Unit');
    let ucsRow = null;
    for (let i = 1; i < ucsValues.length; i++) {
      if (String(ucsValues[i][ucsCodeCol]).trim() === newUcsCode) { ucsRow = ucsValues[i]; break; }
    }
    if (!ucsRow) return jsonResponse({ success: false, ucsNotFound: true, message: 'UCS Code ' + newUcsCode + ' was not found in UCS_MasterList.' });
    const newItemDescription = ucsRow[ucsShortCol];
    const newUnit = ucsRow[ucsUnitCol];

    const oldQty = row[col['Qty']];
    const oldUcsCode = String(row[col['UCS_Code']]).trim();
    const oldItemDescription = row[col['Item_Description']];

    if (Number(oldQty) === newQty && oldUcsCode === newUcsCode) {
      return jsonResponse({ success: false, message: 'No changes detected -- nothing was updated.' });
    }

    const rowNum = targetIndex + 1;
    writeCells_(sheet, [ // one batched write instead of 4 separate calls
      { row: rowNum, col: col['Qty'], value: newQty },
      { row: rowNum, col: col['UCS_Code'], value: newUcsCode },
      { row: rowNum, col: col['Item_Description'], value: newItemDescription },
      { row: rowNum, col: col['Unit'], value: newUnit }
    ]);
    sheet.getRange(rowNum, col['UCS_Code'] + 1).setNumberFormat('@STRING@');

    logAudit(login.name, data.email, 'EDIT_STO_ENTRY',
      'STO ' + stoNo + ' | Qty: ' + oldQty + ' -> ' + newQty +
      ' | UCS: ' + oldUcsCode + ' (' + oldItemDescription + ') -> ' + newUcsCode + ' (' + newItemDescription + ')');

    return jsonResponse({ success: true, message: 'STO ' + stoNo + ' updated.', itemDescription: newItemDescription, unit: newUnit });
  } finally {
    lock.releaseLock();
  }
}

function editSTOReceivedInfo(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  const recQtyRaw = data.receivedQty;
  const recDateStr = String(data.receivedDate || '').trim();
  const refPO = String(data.referencePO || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  const hasRecQty = !(recQtyRaw === undefined || recQtyRaw === null || recQtyRaw === '');
  if (!hasRecQty || !recDateStr || !refPO) return jsonResponse({ success: false, message: 'Received Qty, Received Date, and Reference PO are all required.' });
  const recQty = Number(recQtyRaw);
  if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
  const recDateObj = parseDateOnly(recDateStr);
  if (!recDateObj) return jsonResponse({ success: false, message: 'Received Date is invalid.' });
  const today = startOfToday();
  if (recDateObj > today) return jsonResponse({ success: false, message: 'Received Date cannot be in the future.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = {};
  headers.forEach((h, idx) => { col[h] = idx; });
  let targetIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['STO_No']]).trim() === stoNo) { targetIndex = i; break; }
  }
  if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });
  const row = values[targetIndex];
  if (isSTODeleted_(row, col)) return jsonResponse({ success: false, message: 'STO ' + stoNo + ' has been deleted and can no longer be corrected.' });
  const requestedQty = Number(row[col['Qty']]);
  if (recQty > requestedQty) return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + requestedQty + ').' });
  const stoDateMidnight = toMidnight(row[col['STO_Date']]);
  if (stoDateMidnight && recDateObj < stoDateMidnight) return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });
  const oldQty = row[col['Received_Qty']];
  const oldDate = formatDateOut(row[col['Received_Date']]);
  const oldPO = row[col['Reference_PO']];
  const rowNum = targetIndex + 1;
  writeCells_(sheet, [ // one batched write instead of 3 separate calls
    { row: rowNum, col: col['Received_Qty'], value: recQty },
    { row: rowNum, col: col['Received_Date'], value: recDateObj },
    { row: rowNum, col: col['Reference_PO'], value: refPO }
  ]);
  logAudit(login.name, data.email, 'EDIT_STO_RECEIVED_INFO', 'STO ' + stoNo + ' | Qty: ' + oldQty + ' -> ' + recQty + ' | Date: ' + oldDate + ' -> ' + recDateStr + ' | Ref: "' + oldPO + '" -> "' + refPO + '"');
  return jsonResponse({ success: true, message: 'STO ' + stoNo + ' received details corrected by Approver.' });
}

function getEligibleSTOsForZ04(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  if (stoValues.length < 2) return jsonResponse({ success: true, stos: [] });
  const stoHeaders = stoValues[0];
  const stoCol = {};
  stoHeaders.forEach(function (h, idx) { stoCol[h] = idx; });
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const alreadyZ04d = {};
  if (z04Values.length >= 2) {
    const z04Headers = z04Values[0];
    const z04StoCol = z04Headers.indexOf('STO_No');
    for (let i = 1; i < z04Values.length; i++) alreadyZ04d[String(z04Values[i][z04StoCol]).trim()] = true;
  }
  let eligible = [];
  for (let i = 1; i < stoValues.length; i++) {
    const row = stoValues[i];
    const stoNo = String(row[stoCol['STO_No']]).trim();
    if (alreadyZ04d[stoNo]) continue;
    if (isSTODeleted_(row, stoCol)) continue;
    eligible.push({ stoNo: stoNo, stoDate: formatDateOut(row[stoCol['STO_Date']]), ucsCode: String(row[stoCol['UCS_Code']]).trim(), itemDescription: row[stoCol['Item_Description']], unit: row[stoCol['Unit']], orderedQty: row[stoCol['Qty']] });
  }
  eligible.reverse();
  return jsonResponse({ success: true, stos: eligible });
}

function getZ04DetailsForSTO(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length < 2) return jsonResponse({ success: false, message: 'No Z04 entry found for STO ' + stoNo + '.' });
  const z04Headers = z04Values[0];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
  for (let i = 1; i < z04Values.length; i++) {
    const row = z04Values[i];
    if (String(row[z04Col['STO_No']]).trim() === stoNo) {
      return jsonResponse({ success: true, z04: { dateOfReceipt: formatDateOut(row[z04Col['Date_of_Receipt_Z04']]), qtyReceived: row[z04Col['Qty_Recieved_Z04']], matDocNo: String(row[z04Col['Mat_Doc_No_Z04']]).trim(), matReceivedBy: row[z04Col['Mat_Recieved_By']] || '' } });
    }
  }
  return jsonResponse({ success: false, message: 'No Z04 entry found for STO ' + stoNo + '.' });
}

function checkMatDocNoExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const matDocNo = String(data.matDocNo || '').trim();
  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  if (matDocNoExistsAnywhere(matDocNo)) return jsonResponse({ success: true, exists: true });
  return jsonResponse({ success: true, exists: false });
}

function matDocNoExistsAnywhere(matDocNo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const z04Sheet = ss.getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length >= 2) {
    const z04Headers = z04Values[0];
    const z04Col = z04Headers.indexOf('Mat_Doc_No_Z04');
    for (let i = 1; i < z04Values.length; i++) { if (String(z04Values[i][z04Col]).trim() === matDocNo) return true; }
  }
  const s201Sheet = ss.getSheetByName(S201_SHEET);
  if (s201Sheet) {
    const s201Values = s201Sheet.getDataRange().getValues();
    if (s201Values.length >= 2) {
      const s201Headers = s201Values[0];
      const s201Col = s201Headers.indexOf('Mat_Doc_No_201');
      for (let i = 1; i < s201Values.length; i++) { if (String(s201Values[i][s201Col]).trim() === matDocNo) return true; }
    }
  }
  return false;
}

function addZ04Entry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  const dateOfReceiptStr = String(data.dateOfReceipt || '').trim();
  const qtyRecRaw = data.qtyReceived;
  const matDocNo = String(data.matDocNo || '').trim();
  const matReceivedBy = String(data.matReceivedBy || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  if (!dateOfReceiptStr) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) is required.' });
  const dateOfReceiptObj = parseDateOnly(dateOfReceiptStr);
  if (!dateOfReceiptObj) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) is invalid.' });
  const today = startOfToday();
  if (dateOfReceiptObj > today) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) cannot be in the future.' });
  if (qtyRecRaw === undefined || qtyRecRaw === null || qtyRecRaw === '') return jsonResponse({ success: false, message: 'Qty Received (Z04) is required.' });
  const qtyReceived = Number(qtyRecRaw);
  if (isNaN(qtyReceived) || !Number.isInteger(qtyReceived) || qtyReceived < 0) return jsonResponse({ success: false, message: 'Qty Received (Z04) must be a whole number, zero or greater (no negatives or decimals).' });
  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });

  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  const stoHeaders = stoValues[0];
  const stoCol = {};
  stoHeaders.forEach(function (h, idx) { stoCol[h] = idx; });
  let stoRow = null;
  for (let i = 1; i < stoValues.length; i++) { if (String(stoValues[i][stoCol['STO_No']]).trim() === stoNo) { stoRow = stoValues[i]; break; } }
  if (!stoRow) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' was not found in STO_MasterList.' });
  if (isSTODeleted_(stoRow, stoCol)) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has been deleted and can no longer be Z04\'d.' });
  const stoDateMidnight = toMidnight(stoRow[stoCol['STO_Date']]);
  if (stoDateMidnight && dateOfReceiptObj < stoDateMidnight) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) cannot be earlier than the STO Date.' });
  const orderedQty = Number(stoRow[stoCol['Qty']]);
  if (qtyReceived > orderedQty) return jsonResponse({ success: false, message: 'Qty Received (Z04) cannot exceed the STO Ordered Qty (' + orderedQty + ').' });
  const ucsCode = String(stoRow[stoCol['UCS_Code']]).trim();
  const itemDescription = stoRow[stoCol['Item_Description']];
  const unit = stoRow[stoCol['Unit']];

  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const z04Headers = z04Values.length > 0 ? z04Values[0] : ['STO_No', 'STO_Date', 'UCS_Code', 'Item_Description', 'Unit', 'Ordered_Qty', 'Date_of_Receipt_Z04', 'Qty_Recieved_Z04', 'Mat_Doc_No_Z04', 'Mat_Recieved_By'];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
  for (let i = 1; i < z04Values.length; i++) { if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has already been Z04\'d. Only one Z04 entry is allowed per STO.' }); }
  if (matDocNoExistsAnywhere(matDocNo)) return jsonResponse({ success: false, message: 'Mat Doc No ' + matDocNo + ' already exists. Mat Doc Nos must be unique.' });

  const rowOut = new Array(z04Headers.length).fill('');
  rowOut[z04Col['STO_No']] = stoNo;
  rowOut[z04Col['STO_Date']] = stoRow[stoCol['STO_Date']];
  rowOut[z04Col['UCS_Code']] = ucsCode;
  rowOut[z04Col['Item_Description']] = itemDescription;
  rowOut[z04Col['Unit']] = unit;
  rowOut[z04Col['Ordered_Qty']] = orderedQty;
  rowOut[z04Col['Date_of_Receipt_Z04']] = dateOfReceiptObj;
  rowOut[z04Col['Qty_Recieved_Z04']] = qtyReceived;
  rowOut[z04Col['Mat_Doc_No_Z04']] = matDocNo;
  rowOut[z04Col['Mat_Recieved_By']] = matReceivedBy;
  z04Sheet.appendRow(rowOut);
  const newRow = z04Sheet.getLastRow();
  z04Sheet.getRange(newRow, z04Col['STO_No'] + 1).setNumberFormat('@STRING@');
  z04Sheet.getRange(newRow, z04Col['UCS_Code'] + 1).setNumberFormat('@STRING@');
  z04Sheet.getRange(newRow, z04Col['Mat_Doc_No_Z04'] + 1).setNumberFormat('@STRING@');
  logAudit(login.name, data.email, 'ADD_Z04_ENTRY', 'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty Received (Z04): ' + qtyReceived + ' of ' + orderedQty + ' | Mat Doc No ' + matDocNo + (matReceivedBy ? ' | Received by ' + matReceivedBy : ' | Received by: (not recorded)') + (qtyReceived === 0 ? ' | ZERO QTY -- operator confirmed this deliberately' : ''));
  return jsonResponse({ success: true, message: 'Z04 entry for STO ' + stoNo + ' saved successfully.' });
}

function readOptionsColumn(category) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPTIONS_SHEET);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 1) return [];
  const headers = values[0];
  const colIdx = headers.indexOf(category);
  if (colIdx === -1) return [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i][colIdx];
    if (v === '' || v === null || v === undefined) continue;
    out.push(String(v).trim());
  }
  return out;
}

function getOptionsList(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const category = String(data.category || '').trim();
  if (!category) return jsonResponse({ success: false, message: 'Category is required.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPTIONS_SHEET);
  if (!sheet) return jsonResponse({ success: false, message: 'Options_List sheet not found.' });
  const headers = readHeaderRow_(sheet);
  if (headers.indexOf(category) === -1) return jsonResponse({ success: false, message: 'Unknown Options_List category: ' + category });
  return jsonResponse({ success: true, category: category, values: readOptionsColumn(category) });
}

function addOptionValue(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const category = String(data.category || '').trim();
  const value = String(data.value || '').trim();
  if (!category) return jsonResponse({ success: false, message: 'Category is required.' });
  if (!value) return jsonResponse({ success: false, message: 'Value is required.' });
  if (value.length > 100) return jsonResponse({ success: false, message: 'Value is too long (max 100 characters).' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPTIONS_SHEET);
  if (!sheet) return jsonResponse({ success: false, message: 'Options_List sheet not found.' });
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const colIdx = headers.indexOf(category);
  if (colIdx === -1) return jsonResponse({ success: false, message: 'Unknown Options_List category: ' + category + '. Categories are column headers and must already exist -- this function only appends values, it never creates a new category column.' });
  let firstBlankRow = -1;
  for (let i = 1; i < values.length; i++) {
    const cell = values[i][colIdx];
    if (cell === '' || cell === null || cell === undefined) { if (firstBlankRow === -1) firstBlankRow = i; continue; }
    if (String(cell).trim() === value) return jsonResponse({ success: false, message: '"' + value + '" already exists under ' + category + '.' });
  }
  const targetRow = (firstBlankRow !== -1) ? firstBlankRow + 1 : values.length + 1;
  sheet.getRange(targetRow, colIdx + 1).setValue(value);
  logAudit(login.name, data.email, 'ADD_OPTION_VALUE', 'Category ' + category + ' | Added value: ' + value);
  return jsonResponse({ success: true, message: '"' + value + '" added to ' + category + '.' });
}

function getEligibleZ04sFor201(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length < 2) return jsonResponse({ success: true, stos: [] });
  const z04Headers = z04Values[0];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
  const releasedByStoNo = sumReleasedByStoNo();
  let eligible = [];
  for (let i = 1; i < z04Values.length; i++) {
    const row = z04Values[i];
    const stoNo = String(row[z04Col['STO_No']]).trim();
    const qtyRecievedZ04 = Number(row[z04Col['Qty_Recieved_Z04']]);
    const alreadyReleased = releasedByStoNo[stoNo] || 0;
    const remaining = qtyRecievedZ04 - alreadyReleased;
    if (remaining <= 0) continue;
    eligible.push({ stoNo: stoNo, stoDate: formatDateOut(row[z04Col['STO_Date']]), ucsCode: String(row[z04Col['UCS_Code']]).trim(), itemDescription: row[z04Col['Item_Description']], unit: row[z04Col['Unit']], dateOfReceiptZ04: formatDateOut(row[z04Col['Date_of_Receipt_Z04']]), qtyRecievedZ04: qtyRecievedZ04, alreadyReleased: alreadyReleased, remaining: remaining });
  }
  eligible.reverse();
  return jsonResponse({ success: true, stos: eligible });
}

function sumReleasedByStoNo() {
  const sums = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(S201_SHEET);
  if (!sheet) return sums;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return sums;
  const headers = values[0];
  const col = {};
  headers.forEach(function (h, idx) { col[h] = idx; });
  for (let i = 1; i < values.length; i++) {
    const stoNo = String(values[i][col['STO_No']]).trim();
    const qty = Number(values[i][col['Qty_Released_201']]) || 0;
    sums[stoNo] = (sums[stoNo] || 0) + qty;
  }
  return sums;
}

function getS201EntriesForSTO(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(S201_SHEET);
  const values = sheet ? sheet.getDataRange().getValues() : [];
  let entries = [];
  let qtyRecievedZ04 = null;
  if (values.length >= 2) {
    const headers = values[0];
    const col = {};
    headers.forEach(function (h, idx) { col[h] = idx; });
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (String(row[col['STO_No']]).trim() !== stoNo) continue;
      if (qtyRecievedZ04 === null) qtyRecievedZ04 = Number(row[col['Qty_Recieved_Z04']]) || 0;
      entries.push({ dateOfRelease: formatDateOut(row[col['Date_of_Release']]), qtyReleased: row[col['Qty_Released_201']], matDocNo: String(row[col['Mat_Doc_No_201']]).trim(), releasedToArea: row[col['Released_to_Area']] || '' });
    }
  }
  const totalReleased = entries.reduce(function (sum, e) { return sum + (Number(e.qtyReleased) || 0); }, 0);
  if (qtyRecievedZ04 === null) {
    const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
    const z04Values = z04Sheet.getDataRange().getValues();
    if (z04Values.length >= 2) {
      const z04Headers = z04Values[0];
      const z04Col = {};
      z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
      for (let i = 1; i < z04Values.length; i++) {
        if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) { qtyRecievedZ04 = Number(z04Values[i][z04Col['Qty_Recieved_Z04']]) || 0; break; }
      }
    }
  }
  qtyRecievedZ04 = qtyRecievedZ04 === null ? 0 : qtyRecievedZ04;
  return jsonResponse({ success: true, entries: entries, qtyRecievedZ04: qtyRecievedZ04, totalReleased: totalReleased, remaining: qtyRecievedZ04 - totalReleased });
}

function addS201Entry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const stoNo = String(data.stoNo || '').trim();
  const qtyReleasedRaw = data.qtyReleased;
  const matDocNo = String(data.matDocNo || '').trim();
  const dateOfReleaseStr = String(data.dateOfRelease || '').trim();
  const releasedToArea = String(data.releasedToArea || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  if (qtyReleasedRaw === undefined || qtyReleasedRaw === null || qtyReleasedRaw === '') return jsonResponse({ success: false, message: 'Qty Released is required.' });
  const qtyReleased = Number(qtyReleasedRaw);
  if (isNaN(qtyReleased) || !Number.isInteger(qtyReleased) || qtyReleased <= 0) return jsonResponse({ success: false, message: 'Qty Released must be a whole number greater than zero.' });
  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  if (!dateOfReleaseStr) return jsonResponse({ success: false, message: 'Date of Release is required.' });
  const dateOfReleaseObj = parseDateOnly(dateOfReleaseStr);
  if (!dateOfReleaseObj) return jsonResponse({ success: false, message: 'Date of Release is invalid.' });
  const today = startOfToday();
  if (dateOfReleaseObj > today) return jsonResponse({ success: false, message: 'Date of Release cannot be in the future.' });
  if (!releasedToArea) return jsonResponse({ success: false, message: 'Released to Area is required.' });
  const validAreas = readOptionsColumn('Area_201');
  if (validAreas.indexOf(releasedToArea) === -1) return jsonResponse({ success: false, message: 'Released to Area "' + releasedToArea + '" is not a recognized area. Refresh the list and try again.' });

  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const z04Headers = z04Values[0];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
  let z04Row = null;
  for (let i = 1; i < z04Values.length; i++) { if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) { z04Row = z04Values[i]; break; } }
  if (!z04Row) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has no Z04 entry yet -- it must be Z04\'d before material can be released against it.' });
  const dateOfReceiptZ04Midnight = toMidnight(z04Row[z04Col['Date_of_Receipt_Z04']]);
  if (dateOfReceiptZ04Midnight && dateOfReleaseObj < dateOfReceiptZ04Midnight) return jsonResponse({ success: false, message: 'Date of Release cannot be earlier than the Z04 Date of Receipt.' });
  const qtyRecievedZ04 = Number(z04Row[z04Col['Qty_Recieved_Z04']]);
  const ucsCode = String(z04Row[z04Col['UCS_Code']]).trim();
  const itemDescription = z04Row[z04Col['Item_Description']];
  const unit = z04Row[z04Col['Unit']];
  const releasedByStoNo = sumReleasedByStoNo();
  const alreadyReleased = releasedByStoNo[stoNo] || 0;
  const remaining = qtyRecievedZ04 - alreadyReleased;
  if (remaining <= 0) return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has already been fully released (nothing remaining against its Z04 Qty of ' + qtyRecievedZ04 + ').' });
  if (qtyReleased > remaining) return jsonResponse({ success: false, message: 'Qty Released cannot exceed the remaining balance (' + remaining + ' of ' + qtyRecievedZ04 + ' left).' });
  if (matDocNoExistsAnywhere(matDocNo)) return jsonResponse({ success: false, message: 'Mat Doc No ' + matDocNo + ' already exists. Mat Doc Nos must be unique.' });

  const s201Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(S201_SHEET);
  const s201Values = s201Sheet.getDataRange().getValues();
  const s201Headers = s201Values.length > 0 ? s201Values[0] : ['STO_No', 'STO_Date', 'UCS_Code', 'Item_Description', 'Unit', 'Qty_Recieved_Z04', 'Date_of_Receipt_Z04', 'Qty_Released_201', 'Mat_Doc_No_201', 'Date_of_Release', 'Released_to_Area'];
  const s201Col = {};
  s201Headers.forEach(function (h, idx) { s201Col[h] = idx; });
  const rowOut = new Array(s201Headers.length).fill('');
  rowOut[s201Col['STO_No']] = stoNo;
  rowOut[s201Col['STO_Date']] = z04Row[z04Col['STO_Date']];
  rowOut[s201Col['UCS_Code']] = ucsCode;
  rowOut[s201Col['Item_Description']] = itemDescription;
  rowOut[s201Col['Unit']] = unit;
  rowOut[s201Col['Qty_Recieved_Z04']] = qtyRecievedZ04;
  rowOut[s201Col['Date_of_Receipt_Z04']] = z04Row[z04Col['Date_of_Receipt_Z04']];
  rowOut[s201Col['Qty_Released_201']] = qtyReleased;
  rowOut[s201Col['Mat_Doc_No_201']] = matDocNo;
  rowOut[s201Col['Date_of_Release']] = dateOfReleaseObj;
  rowOut[s201Col['Released_to_Area']] = releasedToArea;
  s201Sheet.appendRow(rowOut);
  const newRow = s201Sheet.getLastRow();
  s201Sheet.getRange(newRow, s201Col['STO_No'] + 1).setNumberFormat('@STRING@');
  s201Sheet.getRange(newRow, s201Col['UCS_Code'] + 1).setNumberFormat('@STRING@');
  s201Sheet.getRange(newRow, s201Col['Mat_Doc_No_201'] + 1).setNumberFormat('@STRING@');
  const newRemaining = remaining - qtyReleased;
  logAudit(login.name, data.email, 'ADD_201_ENTRY', 'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty Released: ' + qtyReleased + ' | Mat Doc No ' + matDocNo + ' | Released to: ' + releasedToArea + ' | Remaining after this entry: ' + newRemaining + ' of ' + qtyRecievedZ04 + (newRemaining === 0 ? ' (FULLY EXHAUSTED)' : ''));
  return jsonResponse({ success: true, message: '201 entry for STO ' + stoNo + ' saved successfully. Remaining: ' + newRemaining + ' of ' + qtyRecievedZ04 + '.', remaining: newRemaining });
}

function logAudit(name, email, action, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(AUDIT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIT_SHEET);
    sheet.appendRow(['Timestamp', 'User_Name', 'User_Email', 'Action', 'Details']);
    sheet.hideSheet();
  }
  sheet.appendRow([new Date(), name, email, action, details]);
}

function canRaiseRequisition(area, authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, area) && (hasCommaValue(roleString, 'Area Store Supervisor') || hasCommaValue(roleString, 'Area Incharge'));
}
function isAreaInchargeForArea(area, authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, area) && hasCommaValue(roleString, 'Area Incharge');
}
function canSanctionRequisition(roleString) { return hasCommaValue(roleString, 'Approver'); }
function canIssueRequisition(roleString) { return hasCommaValue(roleString, 'Store Incharge'); }

/**
 * Every Area Incharge's email for a given area (there can be more than
 * one, e.g. BOF has two in the Users sheet) -- used to route notifications
 * to the right person(s) without hardcoding anyone's email anywhere.
 */
function getAreaInchargeEmails_(area) {
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const areaCol = headers.indexOf('Authorized_Area');
  const roleCol = headers.indexOf('Role');
  const emails = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (isAreaInchargeForArea(area, row[areaCol], row[roleCol])) emails.push(row[emailCol]);
  }
  return emails;
}

/**
 * Mirror image of getAreaInchargeEmails_ -- every Area Store Supervisor's
 * email for a given area. Used when the Area Incharge themselves raises a
 * requisition (fast-track): the Supervisor(s) for that area still need to
 * know a request has gone in, since they may be the one physically sent to
 * collect the material once it's issued.
 */
function getAreaStoreSupervisorEmails_(area) {
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const areaCol = headers.indexOf('Authorized_Area');
  const roleCol = headers.indexOf('Role');
  const emails = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (hasCommaValue(row[areaCol], area) && hasCommaValue(row[roleCol], 'Area Store Supervisor')) emails.push(row[emailCol]);
  }
  return emails;
}

/**
 * Every user who can sanction a requisition -- Approver is a global role,
 * not area-scoped (canSanctionRequisition() itself checks no area), same
 * as how getPendingSanctions() already shows every Approver every pending
 * slip regardless of area. So every Approver gets notified here too.
 */
function getApproverEmails_() {
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const roleCol = headers.indexOf('Role');
  const emails = [];
  for (let i = 1; i < values.length; i++) {
    if (canSanctionRequisition(values[i][roleCol])) emails.push(values[i][emailCol]);
  }
  return emails;
}

/**
 * Every user who can issue a requisition -- Store Incharge is also a
 * global role, not area-scoped (canIssueRequisition() itself checks no
 * area, and getPendingIssues() already shows every Store Incharge every
 * pending slip regardless of area) -- one central store issuing for every
 * area, per this project's design.
 */
function getStoreInchargeEmails_() {
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const roleCol = headers.indexOf('Role');
  const emails = [];
  for (let i = 1; i < values.length; i++) {
    if (canIssueRequisition(values[i][roleCol])) emails.push(values[i][emailCol]);
  }
  return emails;
}

/**
 * Every Planning staff member (excluding Store Incharge) -- the exact same
 * group canManageSTO() already gates requireSTOAccess() on, which is what
 * getDemandAlerts()/updateDemandAlertStatus() use. So this is "everyone who
 * can already see and triage demand alerts on their dashboard."
 */
function getPlanningStaffEmails_() {
  const values = getUsersValues_();
  const headers = values[0];
  const emailCol = headers.indexOf('User_email');
  const areaCol = headers.indexOf('Authorized_Area');
  const roleCol = headers.indexOf('Role');
  const emails = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (canManageSTO(row[areaCol], row[roleCol])) emails.push(row[emailCol]);
  }
  return emails;
}

function formatDateYYYYMMDD_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return '' + y + m + d;
}

function getNextSlipSerial_(area, dateYYYYMMDD) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const idCol = getColIndexOrThrow_(headers, 'Slip_ID', REQ_HEADER_SHEET);
  const prefix = area + dateYYYYMMDD + '-';
  let maxSerial = 0;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][idCol] || '');
    if (id.indexOf(prefix) === 0) {
      const serial = parseInt(id.substring(prefix.length), 10);
      if (!isNaN(serial) && serial > maxSerial) maxSerial = serial;
    }
  }
  const next = maxSerial + 1;
  if (next > 99) throw new Error('Maximum 99 requisition slips per area per day reached for ' + area + ' on ' + dateYYYYMMDD + '.');
  return prefix + String(next).padStart(2, '0');
}

function getDetailRowIndexesForSlip_(detailsValues, dCol, slipId) {
  const map = {};
  for (let i = 1; i < detailsValues.length; i++) {
    if (String(detailsValues[i][dCol['Slip_ID']]) === slipId) map[String(detailsValues[i][dCol['Detail_ID']])] = i;
  }
  return map;
}

function getRequisitionRowsByStatus_(status) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headerSheet = ss.getSheetByName(REQ_HEADER_SHEET);
  const headerValues = headerSheet.getDataRange().getValues();
  const hHeaders = headerValues[0];
  const hCol = {};
  hHeaders.forEach(function (h, idx) { hCol[h] = idx; });
  const slipInfo = {};
  for (let i = 1; i < headerValues.length; i++) {
    const row = headerValues[i];
    slipInfo[String(row[hCol['Slip_ID']])] = { area: row[hCol['Area']], raisedByName: row[hCol['Raised_By_Name']], slipDate: formatDateOut(row[hCol['Slip_Date']]) };
  }
  const detailsSheet = ss.getSheetByName(REQ_DETAILS_SHEET);
  const detailsValues = detailsSheet.getDataRange().getValues();
  const dHeaders = detailsValues[0];
  const dCol = {};
  dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
  const stockMap = getPlanningStockMapCached_();
  const out = [];
  for (let i = 1; i < detailsValues.length; i++) {
    const row = detailsValues[i];
    if (String(row[dCol['Slip_Status']]) !== status) continue;
    const slipId = String(row[dCol['Slip_ID']]);
    const info = slipInfo[slipId] || {};
    const ucsCode = String(row[dCol['UCS_Code']]).trim();
    out.push({ detailId: row[dCol['Detail_ID']], slipId: slipId, area: info.area || '', raisedByName: info.raisedByName || '', slipDate: info.slipDate || '', ucsCode: row[dCol['UCS_Code']], itemDescription: row[dCol['Item_Description']], unit: row[dCol['Unit']], qtyRequested: row[dCol['Qty_Requested']], qtyApproved: row[dCol['Qty_Approved']], qtySanctioned: row[dCol['Qty_Sanctioned']], qtyIssued: row[dCol['Qty_Issued']], availableAtPlanning: stockMap[ucsCode] ? stockMap[ucsCode].balance : 0 });
  }
  return out;
}

function raiseRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!canRaiseRequisition(area, login.authorizedArea, login.role)) return jsonResponse({ success: false, message: 'You are not authorized to raise requisitions for ' + area + '.' });
  const isFastTrack = isAreaInchargeForArea(area, login.authorizedArea, login.role);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'At least one material line is required.' });
  if (items.length > 10) return jsonResponse({ success: false, message: 'A requisition slip cannot have more than 10 materials.' });

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);
  const resolvedItems = [];
  for (let i = 0; i < items.length; i++) {
    const ucsCode = String(items[i].ucsCode || '').trim();
    const qty = Number(items[i].qty);
    if (!ucsCode) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': UCS Code is required.' });
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': Quantity must be a positive whole number.' });
    let found = null;
    for (let r = 1; r < ucsValues.length; r++) { if (String(ucsValues[r][ucsCodeCol]).trim() === ucsCode) { found = ucsValues[r]; break; } }
    if (!found) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': UCS Code ' + ucsCode + ' not found.' });
    resolvedItems.push({ ucsCode: ucsCode, itemDescription: found[ucsShortCol], unit: found[ucsUnitCol], qty: qty });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const stockMap = computePlanningStockMap_();
    for (let i = 0; i < resolvedItems.length; i++) {
      const it = resolvedItems[i];
      const available = stockMap[it.ucsCode] ? stockMap[it.ucsCode].balance : 0;
      if (it.qty > available) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ' (' + it.ucsCode + '): requested qty ' + it.qty + ' exceeds available Planning stock of ' + available + '. Reduce the quantity or remove this line.' });
    }
    const now = new Date();
    const dateStr = formatDateYYYYMMDD_(now);
    const slipId = getNextSlipSerial_(area, dateStr);
    const initialStatus = isFastTrack ? 'Pending Planning Approval' : 'Pending Area Approval';
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerHeaders = readHeaderRow_(headerSheet);
    const headerRow = new Array(headerHeaders.length).fill('');
    headerRow[getColIndexOrThrow_(headerHeaders, 'Slip_ID', REQ_HEADER_SHEET)] = slipId;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Slip_Date', REQ_HEADER_SHEET)] = now;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Area', REQ_HEADER_SHEET)] = area;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_By_Name', REQ_HEADER_SHEET)] = login.name;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_By_Email', REQ_HEADER_SHEET)] = data.email;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_Timestamp', REQ_HEADER_SHEET)] = now;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Slip_Status', REQ_HEADER_SHEET)] = initialStatus;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Material_Count', REQ_HEADER_SHEET)] = resolvedItems.length;
    headerSheet.appendRow(headerRow);
    headerSheet.getRange(headerSheet.getLastRow(), getColIndexOrThrow_(headerHeaders, 'Slip_ID', REQ_HEADER_SHEET) + 1).setNumberFormat('@STRING@');
    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsHeaders = readHeaderRow_(detailsSheet);
    const newDetailRows = [];
    resolvedItems.forEach(function (item, idx) {
      const row = new Array(detailsHeaders.length).fill('');
      row[getColIndexOrThrow_(detailsHeaders, 'Detail_ID', REQ_DETAILS_SHEET)] = Utilities.getUuid().substring(0, 8);
      row[getColIndexOrThrow_(detailsHeaders, 'Slip_ID', REQ_DETAILS_SHEET)] = slipId;
      row[getColIndexOrThrow_(detailsHeaders, 'Line_No', REQ_DETAILS_SHEET)] = idx + 1;
      row[getColIndexOrThrow_(detailsHeaders, 'UCS_Code', REQ_DETAILS_SHEET)] = item.ucsCode;
      row[getColIndexOrThrow_(detailsHeaders, 'Item_Description', REQ_DETAILS_SHEET)] = item.itemDescription;
      row[getColIndexOrThrow_(detailsHeaders, 'Unit', REQ_DETAILS_SHEET)] = item.unit;
      row[getColIndexOrThrow_(detailsHeaders, 'Qty_Requested', REQ_DETAILS_SHEET)] = item.qty;
      row[getColIndexOrThrow_(detailsHeaders, 'Slip_Status', REQ_DETAILS_SHEET)] = initialStatus;
      if (isFastTrack) {
        row[getColIndexOrThrow_(detailsHeaders, 'Qty_Approved', REQ_DETAILS_SHEET)] = item.qty;
        row[getColIndexOrThrow_(detailsHeaders, 'Approved_By', REQ_DETAILS_SHEET)] = login.name;
        row[getColIndexOrThrow_(detailsHeaders, 'Approved_Timestamp', REQ_DETAILS_SHEET)] = now;
      }
      newDetailRows.push(row);
    });
    appendRows_(detailsSheet, newDetailRows, [getColIndexOrThrow_(detailsHeaders, 'Slip_ID', REQ_DETAILS_SHEET), getColIndexOrThrow_(detailsHeaders, 'UCS_Code', REQ_DETAILS_SHEET)]);
    logAudit(login.name, data.email, 'RAISE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | ' + resolvedItems.length + ' item(s): ' + resolvedItems.map(function (it) { return it.ucsCode + ' x' + it.qty; }).join(', '));
    const raiserEmailLower = String(data.email).trim().toLowerCase();
    if (isFastTrack) {
      logAudit(login.name, data.email, 'AREA_APPROVE_REQUISITION', 'Slip ' + slipId + ' | Fast-tracked by Area Incharge (Supervisor absent) -- approved at requested quantities in the same action.');
      // The Incharge raised it themselves, so the Supervisor(s) for this
      // area are the ones who still need to know -- they may be the one
      // physically sent to collect the material once it's issued.
      getAreaStoreSupervisorEmails_(area).forEach(function (email) {
        if (String(email).trim().toLowerCase() === raiserEmailLower) return;
        sendPushNotification(email, 'Requisition raised', 'Slip ' + slipId + ' — ' + area, 'raise-requisition');
      });
      // Fast-track lands directly on "Pending Planning Approval", same as a
      // normal area-approval does -- so Approvers need the same notification
      // here too, not just from approveAreaRequisition.
      getApproverEmails_().forEach(function (email) {
        if (String(email).trim().toLowerCase() === raiserEmailLower) return;
        sendPushNotification(email, 'Requisition pending sanction', 'Slip ' + slipId + ' — ' + area, 'sanction-dashboard');
      });
    } else {
      getAreaInchargeEmails_(area).forEach(function (email) {
        if (String(email).trim().toLowerCase() === raiserEmailLower) return;
        sendPushNotification(email, 'Requisition pending approval', 'Slip ' + slipId + ' — ' + area, 'area-approval-dashboard');
      });
    }
    return jsonResponse({ success: true, message: 'Requisition slip ' + slipId + ' raised successfully.' + (isFastTrack ? ' Auto-approved and forwarded to Sanction.' : ''), slipId: slipId });
  } finally {
    lock.releaseLock();
  }
}

function getPendingAreaApprovals(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!hasCommaValue(login.role, 'Area Incharge')) return jsonResponse({ success: false, message: 'Only Area Incharges can view pending area approvals.' });
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const rows = getRequisitionRowsByStatus_('Pending Area Approval').filter(function (r) { return myAreas.indexOf(r.area) !== -1; });
  return jsonResponse({ success: true, items: rows });
}

function approveAreaRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const slipId = String(data.slipId || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to approve.' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });
    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) { if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; } }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const area = headerValues[headerRowIdx][hCol['Area']];
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];
    if (!isAreaInchargeForArea(area, login.authorizedArea, login.role)) return jsonResponse({ success: false, message: 'You are not authorized to approve requisitions for ' + area + '.' });
    if (currentStatus !== 'Pending Area Approval') return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending area approval (current status: ' + currentStatus + '). It may have already been actioned by someone else.' });
    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once (whole-slip approval).' });
    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtyApproved = Number(items[k].qtyApproved);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const requested = Number(detailsValues[rowIdx][dCol['Qty_Requested']]);
      if (!Number.isFinite(qtyApproved) || qtyApproved < 0 || !Number.isInteger(qtyApproved)) return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' must be zero or a positive whole number.' });
      if (qtyApproved > requested) return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' (' + qtyApproved + ') cannot exceed requested qty (' + requested + ').' });
      writes.push({ rowIdx: rowIdx, qtyApproved: qtyApproved });
    }
    const cells = [];
    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      cells.push({ row: sheetRow, col: dCol['Qty_Approved'], value: w.qtyApproved });
      cells.push({ row: sheetRow, col: dCol['Approved_By'], value: login.name });
      cells.push({ row: sheetRow, col: dCol['Approved_Timestamp'], value: now });
      cells.push({ row: sheetRow, col: dCol['Slip_Status'], value: 'Pending Planning Approval' });
    });
    writeCells_(detailsSheet, cells);
    headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Pending Planning Approval');
    logAudit(login.name, data.email, 'AREA_APPROVE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | Approved qty set for ' + writes.length + ' item(s).');

    const raisedByEmail = headerValues[headerRowIdx][hCol['Raised_By_Email']];
    const actingUserEmailLower = String(data.email).trim().toLowerCase();
    if (raisedByEmail && String(raisedByEmail).trim().toLowerCase() !== actingUserEmailLower) {
      sendPushNotification(raisedByEmail, 'Requisition approved', 'Slip ' + slipId + ' — ' + area, 'raise-requisition');
    }
    getApproverEmails_().forEach(function (email) {
      if (String(email).trim().toLowerCase() === actingUserEmailLower) return;
      sendPushNotification(email, 'Requisition pending sanction', 'Slip ' + slipId + ' — ' + area, 'sanction-dashboard');
    });

    return jsonResponse({ success: true, message: 'Slip ' + slipId + ' approved and forwarded to Sanction.' });
  } finally {
    lock.releaseLock();
  }
}

function getPendingSanctions(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  if (!canSanctionRequisition(check.login.role)) return jsonResponse({ success: false, message: 'Only Approvers can view pending sanctions.' });
  return jsonResponse({ success: true, items: getRequisitionRowsByStatus_('Pending Planning Approval') });
}

function sanctionRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!canSanctionRequisition(login.role)) return jsonResponse({ success: false, message: 'Only Approvers can sanction requisitions.' });
  const slipId = String(data.slipId || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to sanction.' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });
    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) { if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; } }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];
    if (currentStatus !== 'Pending Planning Approval') return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending sanction (current status: ' + currentStatus + ').' });
    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once.' });
    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtySanctioned = Number(items[k].qtySanctioned);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const approved = Number(detailsValues[rowIdx][dCol['Qty_Approved']]);
      if (!Number.isFinite(qtySanctioned) || qtySanctioned < 0 || !Number.isInteger(qtySanctioned)) return jsonResponse({ success: false, message: 'Sanctioned qty for ' + detailId + ' must be zero or a positive whole number.' });
      if (qtySanctioned > approved) return jsonResponse({ success: false, message: 'Sanctioned qty for ' + detailId + ' (' + qtySanctioned + ') cannot exceed approved qty (' + approved + ').' });
      writes.push({ rowIdx: rowIdx, qtySanctioned: qtySanctioned });
    }
    const cells = [];
    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      cells.push({ row: sheetRow, col: dCol['Qty_Sanctioned'], value: w.qtySanctioned });
      cells.push({ row: sheetRow, col: dCol['Sanctioned_By'], value: login.name });
      cells.push({ row: sheetRow, col: dCol['Sanctioned_Timestamp'], value: now });
      cells.push({ row: sheetRow, col: dCol['Slip_Status'], value: 'Pending Issue' });
    });
    writeCells_(detailsSheet, cells);
    headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Pending Issue');
    logAudit(login.name, data.email, 'SANCTION_REQUISITION', 'Slip ' + slipId + ' | Sanctioned qty set for ' + writes.length + ' item(s).');

    const sanctionedArea = headerValues[headerRowIdx][hCol['Area']];
    const sanctionedRaisedByEmail = headerValues[headerRowIdx][hCol['Raised_By_Email']];
    const sanctionerEmailLower = String(data.email).trim().toLowerCase();
    if (sanctionedRaisedByEmail && String(sanctionedRaisedByEmail).trim().toLowerCase() !== sanctionerEmailLower) {
      sendPushNotification(sanctionedRaisedByEmail, 'Requisition sanctioned', 'Slip ' + slipId + ' — ' + sanctionedArea, 'raise-requisition');
    }
    getStoreInchargeEmails_().forEach(function (email) {
      if (String(email).trim().toLowerCase() === sanctionerEmailLower) return;
      sendPushNotification(email, 'Requisition pending issue', 'Slip ' + slipId + ' — ' + sanctionedArea, 'issue-dashboard');
    });

    return jsonResponse({ success: true, message: 'Slip ' + slipId + ' sanctioned and forwarded for Issue.' });
  } finally {
    lock.releaseLock();
  }
}

function getPendingIssues(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  if (!canIssueRequisition(check.login.role)) return jsonResponse({ success: false, message: 'Only Store Incharge can view pending issues.' });
  return jsonResponse({ success: true, items: getRequisitionRowsByStatus_('Pending Issue') });
}

function issueRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!canIssueRequisition(login.role)) return jsonResponse({ success: false, message: 'Only Store Incharge can issue requisitions.' });
  const slipId = String(data.slipId || '').trim();
  const issuedTo = String(data.issuedTo || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  if (!issuedTo) return jsonResponse({ success: false, message: 'Issued To (name of person collecting) is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to issue.' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });
    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) { if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; } }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const area = headerValues[headerRowIdx][hCol['Area']];
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];
    if (currentStatus !== 'Pending Issue') return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending issue (current status: ' + currentStatus + ').' });
    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once.' });
    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtyIssued = Number(items[k].qtyIssued);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const sanctioned = Number(detailsValues[rowIdx][dCol['Qty_Sanctioned']]);
      if (!Number.isFinite(qtyIssued) || qtyIssued < 0 || !Number.isInteger(qtyIssued)) return jsonResponse({ success: false, message: 'Issued qty for ' + detailId + ' must be zero or a positive whole number.' });
      if (qtyIssued > sanctioned) return jsonResponse({ success: false, message: 'Issued qty for ' + detailId + ' (' + qtyIssued + ') cannot exceed sanctioned qty (' + sanctioned + ').' });
      writes.push({ rowIdx: rowIdx, qtyIssued: qtyIssued, ucsCode: detailsValues[rowIdx][dCol['UCS_Code']], itemDescription: detailsValues[rowIdx][dCol['Item_Description']], unit: detailsValues[rowIdx][dCol['Unit']] });
    }
    const stockMap = computePlanningStockMap_();
    const neededByCode = {};
    writes.forEach(function (w) { const code = String(w.ucsCode).trim(); neededByCode[code] = (neededByCode[code] || 0) + w.qtyIssued; });
    for (const code in neededByCode) {
      const available = stockMap[code] ? stockMap[code].balance : 0;
      if (neededByCode[code] > available) return jsonResponse({ success: false, message: code + ': only ' + available + ' available at Planning right now -- cannot issue ' + neededByCode[code] + '. Stock may have moved since this page loaded; refresh and try again.' });
    }
    return finishIssueRequisition_(data, login, slipId, area, issuedTo, headerSheet, headerRowIdx, hCol, detailsSheet, dCol, writes, now);
  } finally {
    lock.releaseLock();
  }
}

function finishIssueRequisition_(data, login, slipId, area, issuedTo, headerSheet, headerRowIdx, hCol, detailsSheet, dCol, writes, now) {
  const cells = [];
  writes.forEach(function (w) {
    const sheetRow = w.rowIdx + 1;
    cells.push({ row: sheetRow, col: dCol['Qty_Issued'], value: w.qtyIssued });
    cells.push({ row: sheetRow, col: dCol['Issued_To'], value: issuedTo });
    cells.push({ row: sheetRow, col: dCol['Issued_By'], value: login.name });
    cells.push({ row: sheetRow, col: dCol['Issued_Timestamp'], value: now });
    cells.push({ row: sheetRow, col: dCol['Slip_Status'], value: 'Completed' });
  });
  writeCells_(detailsSheet, cells);
  headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Completed');
  const ledgerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ISSUE_LEDGER_SHEET);
  const ledgerHeaders = readHeaderRow_(ledgerSheet);
  const ledgerRows = [];
  writes.forEach(function (w) {
    const row = new Array(ledgerHeaders.length).fill('');
    row[getColIndexOrThrow_(ledgerHeaders, 'ID', ISSUE_LEDGER_SHEET)] = Utilities.getUuid().substring(0, 8);
    row[getColIndexOrThrow_(ledgerHeaders, 'UCS_Code', ISSUE_LEDGER_SHEET)] = w.ucsCode;
    row[getColIndexOrThrow_(ledgerHeaders, 'Item_Description', ISSUE_LEDGER_SHEET)] = w.itemDescription;
    row[getColIndexOrThrow_(ledgerHeaders, 'Unit', ISSUE_LEDGER_SHEET)] = w.unit;
    row[getColIndexOrThrow_(ledgerHeaders, 'Issue_Date', ISSUE_LEDGER_SHEET)] = now;
    row[getColIndexOrThrow_(ledgerHeaders, 'Issue_Qty', ISSUE_LEDGER_SHEET)] = w.qtyIssued;
    row[getColIndexOrThrow_(ledgerHeaders, 'Issued_to', ISSUE_LEDGER_SHEET)] = issuedTo;
    row[getColIndexOrThrow_(ledgerHeaders, 'Area', ISSUE_LEDGER_SHEET)] = area;
    row[getColIndexOrThrow_(ledgerHeaders, 'Req_Slip_number', ISSUE_LEDGER_SHEET)] = slipId;
    ledgerRows.push(row);
  });
  appendRows_(ledgerSheet, ledgerRows, [getColIndexOrThrow_(ledgerHeaders, 'UCS_Code', ISSUE_LEDGER_SHEET)]);
  logAudit(login.name, data.email, 'ISSUE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | Issued to: ' + issuedTo + ' | ' + writes.length + ' item(s): ' + writes.map(function (w) { return w.ucsCode + ' x' + w.qtyIssued; }).join(', '));

  // Closes the information loop: the Requester finally hears their material
  // is in hand, and every Approver (the same group notified at the pending-
  // sanction stage) sees the slip they sanctioned has now actually completed.
  const issuedRaisedByEmail = headerSheet.getRange(headerRowIdx + 1, hCol['Raised_By_Email'] + 1).getValue();
  const issuerEmailLower = String(data.email).trim().toLowerCase();
  if (issuedRaisedByEmail && String(issuedRaisedByEmail).trim().toLowerCase() !== issuerEmailLower) {
    sendPushNotification(issuedRaisedByEmail, 'Requisition issued', 'Slip ' + slipId + ' — ' + area, 'raise-requisition');
  }
  getApproverEmails_().forEach(function (email) {
    if (String(email).trim().toLowerCase() === issuerEmailLower) return;
    sendPushNotification(email, 'Requisition issued', 'Slip ' + slipId + ' — ' + area, 'sanction-dashboard');
  });

  return jsonResponse({ success: true, message: 'Slip ' + slipId + ' issued to ' + issuedTo + '. Requisition completed.' });
}

function getAreaRequisitions(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (myAreas.length === 0) return jsonResponse({ success: true, items: [] });
  const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
  const headerValues = headerSheet.getDataRange().getValues();
  const hHeaders = headerValues[0];
  const hCol = {};
  hHeaders.forEach(function (h, idx) { hCol[h] = idx; });
  const slipInfo = {};
  for (let i = 1; i < headerValues.length; i++) {
    const area = headerValues[i][hCol['Area']];
    if (myAreas.indexOf(area) === -1) continue;
    const slipId = String(headerValues[i][hCol['Slip_ID']]);
    slipInfo[slipId] = { area: area, slipDate: formatDateOut(headerValues[i][hCol['Slip_Date']]), raisedByName: headerValues[i][hCol['Raised_By_Name']] };
  }
  const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
  const detailsValues = detailsSheet.getDataRange().getValues();
  const dHeaders = detailsValues[0];
  const dCol = {};
  dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
  const items = [];
  for (let i = 1; i < detailsValues.length; i++) {
    const row = detailsValues[i];
    const slipId = String(row[dCol['Slip_ID']]);
    const info = slipInfo[slipId];
    if (!info) continue;
    items.push({ slipId: slipId, area: info.area, slipDate: info.slipDate, raisedByName: info.raisedByName, ucsCode: row[dCol['UCS_Code']], itemDescription: row[dCol['Item_Description']], unit: row[dCol['Unit']], qtyRequested: row[dCol['Qty_Requested']], qtyApproved: row[dCol['Qty_Approved']], qtySanctioned: row[dCol['Qty_Sanctioned']], qtyIssued: row[dCol['Qty_Issued']], issuedTo: row[dCol['Issued_To']], status: row[dCol['Slip_Status']] });
  }
  return jsonResponse({ success: true, items: items });
}

function computePlanningStockMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const z04Sheet = ss.getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const z04Headers = z04Values[0];
  const z04UcsCol = getColIndexOrThrow_(z04Headers, 'UCS_Code', Z04_SHEET);
  const z04QtyCol = getColIndexOrThrow_(z04Headers, 'Qty_Recieved_Z04', Z04_SHEET);

  const received = {};
  for (let i = 1; i < z04Values.length; i++) {
    const code = String(z04Values[i][z04UcsCol]).trim();
    if (!code) continue;
    received[code] = (received[code] || 0) + (Number(z04Values[i][z04QtyCol]) || 0);
  }

  const s201Sheet = ss.getSheetByName(S201_SHEET);
  const s201Values = s201Sheet.getDataRange().getValues();
  const s201Headers = s201Values[0];
  const s201UcsCol = getColIndexOrThrow_(s201Headers, 'UCS_Code', S201_SHEET);
  const s201QtyCol = getColIndexOrThrow_(s201Headers, 'Qty_Released_201', S201_SHEET);
  const s201AreaCol = getColIndexOrThrow_(s201Headers, 'Released_to_Area', S201_SHEET);

  const released = {};
  for (let i = 1; i < s201Values.length; i++) {
    const code = String(s201Values[i][s201UcsCol]).trim();
    if (!code) continue;
    if (String(s201Values[i][s201AreaCol]).trim().toUpperCase() === 'PLANNING') continue;
    released[code] = (released[code] || 0) + (Number(s201Values[i][s201QtyCol]) || 0);
  }

  const ledgerSheet = ss.getSheetByName(ISSUE_LEDGER_SHEET);
  const ledgerValues = ledgerSheet.getDataRange().getValues();
  const ledgerHeaders = ledgerValues[0];
  const ledgerUcsCol = getColIndexOrThrow_(ledgerHeaders, 'UCS_Code', ISSUE_LEDGER_SHEET);
  const ledgerQtyCol = getColIndexOrThrow_(ledgerHeaders, 'Issue_Qty', ISSUE_LEDGER_SHEET);

  for (let i = 1; i < ledgerValues.length; i++) {
    const code = String(ledgerValues[i][ledgerUcsCol]).trim();
    if (!code) continue;
    released[code] = (released[code] || 0) + (Number(ledgerValues[i][ledgerQtyCol]) || 0);
  }

  // -- RETURN MODULE ADDITION: every completed return restores usable
  // Planning balance -- subtract Qty_Approved from `released`, the mirror
  // image of how PLNG_ISSUE_SHEET adds to it.
  const retDetailsSheet = ss.getSheetByName(RETURN_DETAILS_SHEET);
  const retDetailsValues = retDetailsSheet.getDataRange().getValues();
  if (retDetailsValues.length >= 2) {
    const rd = retDetailsValues[0];
    const rdCodeCol = getColIndexOrThrow_(rd, 'UCS_Code', RETURN_DETAILS_SHEET);
    const rdQtyCol = getColIndexOrThrow_(rd, 'Qty_Approved', RETURN_DETAILS_SHEET);
    const rdStatusCol = getColIndexOrThrow_(rd, 'Slip_Status', RETURN_DETAILS_SHEET);
    for (let i = 1; i < retDetailsValues.length; i++) {
      if (String(retDetailsValues[i][rdStatusCol]) !== 'Completed') continue;
      const code = String(retDetailsValues[i][rdCodeCol]).trim();
      if (!code) continue;
      released[code] = (released[code] || 0) - (Number(retDetailsValues[i][rdQtyCol]) || 0);
    }
  }

  const map = {};
  const allCodes = {};
  Object.keys(received).forEach(function (c) { allCodes[c] = true; });
  Object.keys(released).forEach(function (c) { allCodes[c] = true; });
  Object.keys(allCodes).forEach(function (code) {
    const rec = received[code] || 0;
    const rel = released[code] || 0;
    map[code] = { received: rec, released: rel, balance: rec - rel };
  });
  return map;
}

function refreshPlanningStock() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PLNG_STOCK_SHEET);
  if (!sheet) throw new Error('PLNG_STOCK sheet not found.');
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0];
  const ucsCol = getColIndexOrThrow_(headers, 'UCS_Code', PLNG_STOCK_SHEET);
  const recCol = getColIndexOrThrow_(headers, 'Qty_Recieved_at_Planning', PLNG_STOCK_SHEET);
  const relCol = getColIndexOrThrow_(headers, 'Qty_Released_to_shop', PLNG_STOCK_SHEET);
  const balCol = getColIndexOrThrow_(headers, 'Qty_Balance', PLNG_STOCK_SHEET);
  const map = computePlanningStockMap_();
  const numRows = values.length - 1;
  const recOut = [], relOut = [], balOut = [];
  for (let i = 1; i < values.length; i++) {
    const code = String(values[i][ucsCol]).trim();
    const entry = map[code] || { received: 0, released: 0, balance: 0 };
    recOut.push([entry.received]);
    relOut.push([entry.released]);
    balOut.push([entry.balance]);
  }
  sheet.getRange(2, recCol + 1, numRows, 1).setValues(recOut);
  sheet.getRange(2, relCol + 1, numRows, 1).setValues(relOut);
  sheet.getRange(2, balCol + 1, numRows, 1).setValues(balOut);
}

function refreshPlanningStockEndpoint(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  try {
    refreshPlanningStock();
    return jsonResponse({ success: true, message: 'Planning Stock refreshed.' });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Refresh failed: ' + e.message });
  }
}

function getPlanningStockList(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  return cachedResponse_('plngList', true, 600, function () { return getPlanningStockListUncached_(); });
}

function getPlanningStockListUncached_() {
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsLongCol = getColIndexOrThrow_(ucsHeaders, 'Long_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);
  const map = getPlanningStockMapCached_();
  const items = [];
  for (let i = 1; i < ucsValues.length; i++) {
    const code = String(ucsValues[i][ucsCodeCol]).trim();
    if (!code) continue;
    const entry = map[code] || { received: 0, released: 0, balance: 0 };
    items.push({ ucsCode: code, itemDescription: ucsValues[i][ucsShortCol], longText: ucsValues[i][ucsLongCol], unit: ucsValues[i][ucsUnitCol], received: entry.received, released: entry.released, balance: entry.balance });
  }
  return jsonResponse({ success: true, items: items });
}

function parseOptionalDateBound_(str) {
  if (!str) return null;
  return parseDateOnly(str);
}

function withinDateRange_(cellVal, from, to) {
  if (!from && !to) return true;
  const d = toMidnight(cellVal);
  if (!d) return true;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function canViewAreaUCSHistory(area, authorizedAreaString, roleString) {
  return canRaiseRequisition(area, authorizedAreaString, roleString);
}

/**
 * Reads PR/PO/receipt/vendor detail for one UCS Code from the separate,
 * externally-shared "Material List" sheet -- a different spreadsheet from
 * this project's own, opened by ID rather than getActiveSpreadsheet().
 * Read-only; matches on the sheet's own "Mat Code" column against our
 * UCS_Code. Fails soft (returns []) if the tab is missing so a problem with
 * this one sheet never breaks the rest of the history modal; throws only if
 * the tab exists but its expected columns don't, which the caller reports
 * back as poPrError rather than failing the whole request.
 */
function getPoPrRowsForUcsCode_(ucsCode, fromDate, toDate) {
  // PERFORMANCE: served from the cached compact copy of Material List (see
  // getMaterialListLite_) instead of opening the external spreadsheet on
  // every click. Same rows, same fields, same order as before; data is at
  // most 10 minutes old, like the Procurement Dashboard.
  const lite = getMaterialListLite_(false);
  if (lite.tabMissing) return [];
  if (lite.error) throw new Error(lite.error);
  const rows = [];
  lite.rows.forEach(function (r) {
    if (r[MLL.CODE] !== ucsCode) return;
    if (!withinDateRange_(r[MLL.RCPT_MS] ? new Date(r[MLL.RCPT_MS]) : '', fromDate, toDate)) return; // filtered by receipt date, matching Z04's convention
    rows.push({
      prNo: r[MLL.PR_NO], poNo: r[MLL.PO_NO], poDate: r[MLL.PO_DATE],
      poDateSort_: r[MLL.PO_MS] === null ? -Infinity : r[MLL.PO_MS],
      qty: r[MLL.QTY], receiptDate: r[MLL.RCPT_DATE], vendorCode: r[MLL.V_CODE], vendorName: r[MLL.V_NAME]
    });
  });
  // Latest PO first -- undated rows (shouldn't normally happen) sort last, not first.
  rows.sort(function (a, b) { return b.poDateSort_ - a.poDateSort_; });
  rows.forEach(function (r) { delete r.poDateSort_; });
  return rows;
}

/**
 * UCS_Code -> Short_Text lookup (this project's own UCS_MasterList, not the
 * external PO/PR sheet). Used only to label PR/PO drill-down rows with a
 * human-readable description -- the actual short/long text detail popup on
 * the client is served from data it already has in memory (Planning Stock
 * loads every UCS Code's full text up front), not from this endpoint.
 */
function getUCSShortTextMap_() {
  // PERFORMANCE: was a full read of UCS_MasterList (including every Long
  // Text) on EVERY PR/PO drill-down and Vendor Finder call. Now reads just
  // the two columns it needs, and is cached under the data version -- so an
  // added or edited UCS Code still shows on the very next call.
  return cachedJson_('ucsShortMap', 600, function () {
    const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
    const lastRow = ucsSheet.getLastRow();
    const map = {};
    if (lastRow < 1) return map;
    const h = ucsSheet.getRange(1, 1, 1, ucsSheet.getLastColumn()).getValues()[0];
    const codeCol = getColIndexOrThrow_(h, 'UCS_Code', UCS_SHEET);
    const shortCol = getColIndexOrThrow_(h, 'Short_Text', UCS_SHEET);
    if (lastRow < 2) return map;
    const codes = ucsSheet.getRange(2, codeCol + 1, lastRow - 1, 1).getValues();
    const shorts = ucsSheet.getRange(2, shortCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < codes.length; i++) {
      const code = String(codes[i][0]).trim();
      if (code) map[code] = shorts[i][0];
    }
    return map;
  });
}

/**
 * Generic reader for the external PO/PR "Material List" sheet (see
 * getPoPrRowsForUcsCode_ above -- same sheet, same required columns, same
 * fail-soft-on-missing-tab / throw-on-missing-columns contract), but
 * filtered by an arbitrary column instead of Mat Code. Powers the PR/PO
 * drill-down panels: "click a PR No., see every item and PO under it" and
 * vice versa. No date-range filtering here -- these panels show a PR/PO's
 * full paper trail, not a time-windowed view.
 */
function getPoPrRowsByField_(filterColumnName, filterValue) {
  // PERFORMANCE: served from the cached compact copy of Material List (see
  // getMaterialListLite_). Same rows, same fields, same order as before.
  const lite = getMaterialListLite_(false);
  if (lite.tabMissing) return [];
  if (lite.error) throw new Error(lite.error);
  const idx = filterColumnName === 'PR No.' ? MLL.PR_NO : (filterColumnName === 'PO No.' ? MLL.PO_NO : (filterColumnName === 'Mat Code' ? MLL.CODE : -1));
  if (idx === -1) throw new Error('Unsupported PO/PR filter column: ' + filterColumnName);
  const target = String(filterValue).trim();
  const rows = [];
  lite.rows.forEach(function (r) {
    if (String(r[idx]).trim() !== target) return;
    rows.push({
      ucsCode: r[MLL.CODE], prNo: r[MLL.PR_NO], poNo: r[MLL.PO_NO], poDate: r[MLL.PO_DATE],
      poDateSort_: r[MLL.PO_MS] === null ? -Infinity : r[MLL.PO_MS],
      qty: r[MLL.QTY], receiptDate: r[MLL.RCPT_DATE], vendorCode: r[MLL.V_CODE], vendorName: r[MLL.V_NAME]
    });
  });
  rows.sort(function (a, b) { return b.poDateSort_ - a.poDateSort_; }); // latest PO first
  rows.forEach(function (r) { delete r.poDateSort_; });
  return rows;
}

/**
 * Planning-staff-only (same tier as the PO&PR tab itself). All items and
 * their POs under a single PR No. -- one PR can carry several materials,
 * and each material line can be split across more than one PO, so this is
 * intentionally raw rows, not aggregated per material.
 */
function getPRItems(data) {
  const check = requirePlanningAreaStaff(data);
  if (!check.ok) return check.response;
  const prNo = String(data.prNo || '').trim();
  if (!prNo) return jsonResponse({ success: false, message: 'PR No. is required.' });
  try {
    const rows = getPoPrRowsByField_('PR No.', prNo);
    const shortTextMap = getUCSShortTextMap_();
    rows.forEach(function (r) { r.itemDescription = shortTextMap[r.ucsCode] || ''; });
    return jsonResponse({ success: true, prNo: prNo, rows: rows });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Could not load PR details: ' + e.message });
  }
}

/**
 * Planning-staff-only. All items under a single PO No., with the PR each
 * line was raised against.
 */
function getPOItems(data) {
  const check = requirePlanningAreaStaff(data);
  if (!check.ok) return check.response;
  const poNo = String(data.poNo || '').trim();
  if (!poNo) return jsonResponse({ success: false, message: 'PO No. is required.' });
  try {
    const rows = getPoPrRowsByField_('PO No.', poNo);
    const shortTextMap = getUCSShortTextMap_();
    rows.forEach(function (r) { r.itemDescription = shortTextMap[r.ucsCode] || ''; });
    return jsonResponse({ success: true, poNo: poNo, rows: rows });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Could not load PO details: ' + e.message });
  }
}

// Ordering used for the PR/PO Dashboard's worst-case rollup and funnel bar.
// "Fully Received" never actually appears in that endpoint's output (those
// items are archived before this array is ever consulted) -- kept here only
// so stageRank_() has a defined, consistent position for it.
// How long a fully-received PO stays visible after its last item's 105
// date, before archiving out for good. Exists because STO stock is pooled
// by UCS Code (not tied to a specific PO -- see design discussion), so a
// PO with no STO raised against it yet would otherwise become completely
// untraceable the instant it archives: gone from this dashboard, and not
// yet findable in the STO Dashboard either. Worst for single/few-item POs.
//
// Stored in PropertiesService (shared across everyone, survives redeploys)
// rather than hardcoded, so Planning staff can tune it themselves from the
// dashboard's own UI instead of asking for a code change every time.
const PROCUREMENT_DASHBOARD_GRACE_DAYS_DEFAULT = 15;
const PROCUREMENT_DASHBOARD_GRACE_DAYS_PROP_KEY = 'PROCUREMENT_DASHBOARD_DELIVERED_GRACE_DAYS';

function getDeliveredGraceDays_() {
  const stored = PropertiesService.getScriptProperties().getProperty(PROCUREMENT_DASHBOARD_GRACE_DAYS_PROP_KEY);
  const n = Number(stored);
  return (Number.isInteger(n) && n > 0) ? n : PROCUREMENT_DASHBOARD_GRACE_DAYS_DEFAULT;
}

function getProcurementDashboardSettings(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  return jsonResponse({ success: true, graceDays: getDeliveredGraceDays_() });
}

function updateProcurementDashboardSettings(data) {
  const check = requireSTOAccess(data); // same access tier as viewing the dashboard itself
  if (!check.ok) return check.response;
  const login = check.login;
  const graceDays = Number(data.graceDays);
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > 180) {
    return jsonResponse({ success: false, message: 'Look-back period must be a whole number of days, between 1 and 180.' });
  }
  PropertiesService.getScriptProperties().setProperty(PROCUREMENT_DASHBOARD_GRACE_DAYS_PROP_KEY, String(graceDays));
  logAudit(login.name, data.email, 'UPDATE_PROCUREMENT_DASHBOARD_SETTINGS', 'Delivered-PO look-back period set to ' + graceDays + ' day(s).');
  return jsonResponse({ success: true, message: 'Look-back period updated to ' + graceDays + ' day(s).', graceDays: graceDays });
}

// A material whose own PR-line value exceeds this is classified as a
// capital good. ₹10,00,000 (10 lakh), confirmed by the project owner.
const CAPITAL_GOOD_PR_VALUE_THRESHOLD = 1000000;

const STAGE_ORDER_ = ['Pending Release', 'Released - Pending Enquiry', 'Under Enquiry', 'Pending PO Award', 'Pending Delivery', 'Partial', 'Recently Delivered', 'Fully Received'];
function stageRank_(s) { const idx = STAGE_ORDER_.indexOf(s); return idx === -1 ? STAGE_ORDER_.length : idx; }

/**
 * PR/PO Dashboard -- read-only, Planning-staff-only (excluding Store
 * Incharge, per project brief), bird's-eye view of every open PR/PO from
 * raising through receipt. Returns one entry per PR still "open" (see
 * archive rule below) plus a funnel count by stage.
 *
 * STAGE MODEL (confirmed across this project's design conversation):
 * - Stages 1-4 (Pending Release -> Released -> Under Enquiry -> Pending PO
 *   Award) are uniform across every item in a PR -- driven entirely
 *   by PR List's own PR-level dates, never by Material List.
 * - Once an item gets a PO No. in Material List, tracking moves to the
 *   PO level: each PO is judged independently by whether every one of
 *   its line items has 105 Qty >= PO Qty (ML_COL.QTY_105 / ML_COL.PO_QTY).
 * - A PO where every line item is fully received is ARCHIVED: dropped
 *   from the response entirely, permanently, with no toggle to reveal it
 *   here (confirmed decision -- downstream STO/Z04 tracking belongs to
 *   the existing STO Dashboard, not this one).
 * - A PR whose every item is either archived-fully-received leaves
 *   nothing open, so the whole PR is dropped from the response too.
 * - A PR marked "Deleted" in PR List column AC is excluded outright
 *   (confirmed: a PO can never survive under a deleted PR).
 *
 * Fails soft on a missing tab (returns success:false with a clear
 * message) rather than partial/garbage data, since this dashboard has
 * no other source to fall back on the way getUCSCodeHistory() does.
 */
function getPRPODashboardData(data) {
  const check = requireSTOAccess(data); // Planning, excluding Store Incharge -- matches the stated audience exactly
  if (!check.ok) return check.response;
  // The slowest call in the app: opens a SEPARATE spreadsheet and reads two
  // large tabs plus every row's font colour. That sheet is updated outside
  // this app, so no write here can signal a change -- this cache relies on
  // a short TTL alone: data is at most 5 minutes old. The key includes
  // every input that changes the result, so the look-back setting, the
  // analysis date and Budget Matrix's full-history mode each get their own entry.
  const key = 'prpo_' + String(data.analysisSinceDate || '').trim() + '_' + (data.fullHistory ? 1 : 0) + '_' + getDeliveredGraceDays_();
  return cachedResponse_(key, false, 300, function () { return getPRPODashboardDataUncached_(data); });
}

function getPRPODashboardDataUncached_(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  try {
    const extSpreadsheet = SpreadsheetApp.openById(PO_PR_SHEET_ID);

    // ---- PR List ----
    const prSheet = extSpreadsheet.getSheetByName(PR_LIST_TAB_NAME);
    if (!prSheet) return jsonResponse({ success: false, message: 'Tab "' + PR_LIST_TAB_NAME + '" not found in the PO/PR sheet.' });
    const prValues = prSheet.getDataRange().getValues();
    if (prValues.length <= PR_LIST_HEADER_ROW_INDEX + 1) return jsonResponse({ success: true, prs: [], funnel: {}, stageOrder: STAGE_ORDER_ });

    const prHeaders = prValues[PR_LIST_HEADER_ROW_INDEX];
    const prCol = {};
    prHeaders.forEach(function (h, idx) { prCol[String(h).trim()] = idx; });
    const prRequired = ['PR No.', 'PR Text', 'PR Cr Dt', 'Fund Centre', 'Section', 'Cr name', 'PR Tot Value', 'Pur Officer', 'Final rel.', 'Enq No./CFN', 'QSDt', 'QO Dt', 'TechSuit Dt'];
    for (let k = 0; k < prRequired.length; k++) {
      if (!(prRequired[k] in prCol)) {
        return jsonResponse({ success: false, message: 'PR LIst sheet is missing expected column: "' + prRequired[k] + '". Check row ' + (PR_LIST_HEADER_ROW_INDEX + 1) + ' for exact spelling.' });
      }
    }

    // A dummy PR (raised only to mask a section's real budget allocation) is
    // marked by a non-black font on its "PR No." cell -- confirmed only
    // black is used for real PRs, so anything else means "skip this row."
    // getFontColors() reads the WHOLE column in one batch call rather than
    // one getFontColor() per row, which would be one extra Apps Script API
    // call per PR (1,200+ of them) instead of a single call total.
    const prNoSheetCol = prCol['PR No.'] + 1; // getRange() is 1-indexed; prCol is 0-indexed against the same getDataRange() array as prValues
    const prNoFontColors = prSheet.getRange(PR_LIST_HEADER_ROW_INDEX + 2, prNoSheetCol, prValues.length - PR_LIST_HEADER_ROW_INDEX - 1, 1).getFontColors();
    function isBlackFont_(color) {
      // Missing/blank reads as black (Sheets' own default), not excluded --
      // this only excludes a color that was deliberately, explicitly set.
      if (!color) return true;
      return String(color).toLowerCase() === '#000000';
    }

    // ---- Material List ----
    const mlSheet = extSpreadsheet.getSheetByName(PO_PR_TAB_NAME);
    if (!mlSheet) return jsonResponse({ success: false, message: 'Tab "' + PO_PR_TAB_NAME + '" not found in the PO/PR sheet.' });
    const mlValues = mlSheet.getDataRange().getValues();

    // Same "only black font is a real row" rule as PR List (see prNoFontColors
    // above), applied here too -- Material List can carry the same dummy/
    // masked rows. WORKING ASSUMPTION: checked against Material List's own
    // "PR No." column (ML_COL.PR_NO, sheet column B) since that's the closest
    // analog to what PR List uses; change this column if it turns out the
    // actual gray marking lives elsewhere in Material List.
    const mlPrNoSheetCol = ML_COL.PR_NO + 1;
    const mlFontColors = mlValues.length > 1
      ? mlSheet.getRange(2, mlPrNoSheetCol, mlValues.length - 1, 1).getFontColors()
      : [];

    const itemsByPR = {};
    for (let i = 1; i < mlValues.length; i++) {
      const r = mlValues[i];
      const prNo = String(r[ML_COL.PR_NO]).trim();
      if (!prNo) continue;
      if (!isBlackFont_(mlFontColors[i - 1][0])) continue; // dummy/masked Material List row -- not real
      if (!itemsByPR[prNo]) itemsByPR[prNo] = [];
      itemsByPR[prNo].push(r);
    }

    // UCS Long/Short Text, keyed by our own UCS_MasterList (== Mat Code
    // space) -- used to enrich the drill-down with full text on click,
    // same source getPOItems()/getPRItems() already use for short text.
    const longTextMap = getUCSLongTextMap_();

    const today = startOfToday();
    const deliveredGraceDays = getDeliveredGraceDays_();
    // One-off analysis override -- NOT persisted, NOT the shared daily
    // setting. When provided, a fully-received PO stays visible as long as
    // its last item's 105 date is on/after this fixed calendar date,
    // instead of the rolling N-day window. Exists so a single user can pull
    // "every PO delivered since 01 April" for a financial-year reconciliation
    // without changing what anyone else sees day to day.
    const analysisOverride = data.analysisSinceDate ? parseDateOnly(String(data.analysisSinceDate).trim()) : null;
    // Complete-history mode -- used by the Budget Matrix page, which needs
    // every fully-received PO visible unconditionally (its whole purpose is
    // retrospective completeness, unlike Procurement Dashboard's deliberate
    // "old delivered stuff disappears" operational rule). No manual date to
    // remember: when this is set, archiving simply never happens.
    const fullHistoryMode = !!data.fullHistory;

    // A PR is only "released" once Final rel. holds an actual DATE -- your
    // team sometimes writes the name of whoever it's currently pending with
    // into that same cell while awaiting release, and that text must not be
    // mistaken for a release date. getValues() returns a real Date object
    // only for genuinely date-formatted cells; any string (a name, a dash,
    // anything else) fails this check and correctly stays Pending Release.
    function isRealDate_(val) {
      return Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime());
    }

    function prLevelStage_(row) {
      const finalRel = row[prCol['Final rel.']];
      if (!isRealDate_(finalRel)) return 'Pending Release';
      const enqNo = String(row[prCol['Enq No./CFN']] || '').trim();
      if (!enqNo || enqNo === '-') return 'Released - Pending Enquiry';
      const qsDt = toMidnight(row[prCol['QSDt']]);
      if (!qsDt || today <= qsDt) return 'Under Enquiry';
      // Past bid-closing with no PO awarded yet is the SAME waiting state
      // whether it's the whole PR (nobody has a PO) or just this one item
      // (siblings already got theirs) -- both are "Pending PO Award" now,
      // per confirmed decision to fold the separate "Tech/Comm Evaluation"
      // label into this one.
      return 'Pending PO Award';
    }

    const funnelCounts = {};
    STAGE_ORDER_.forEach(function (s) { funnelCounts[s] = 0; });

    const outPRs = [];

    for (let i = PR_LIST_HEADER_ROW_INDEX + 1; i < prValues.length; i++) {
      const row = prValues[i];
      const prNo = String(row[prCol['PR No.']]).trim();
      if (!prNo) continue;
      if (String(row[PR_LIST_DELETED_COL_INDEX] || '').trim() === 'Deleted') continue; // excluded per confirmed rule
      const fontColor = prNoFontColors[i - PR_LIST_HEADER_ROW_INDEX - 1][0];
      if (!isBlackFont_(fontColor)) continue; // dummy PR (non-black font), used only to mask budget -- not real procurement

      const lineItems = itemsByPR[prNo] || [];
      const preMLStage = prLevelStage_(row); // used whenever an item has no PO yet

      // Captured here (not just inside prLevelStage_) so both the raw
      // Final Release date and the release-to-first-PO gap can be exposed
      // to the client -- computed from lineItems (every raw Material List
      // row ever seen for this PR, including already-archived ones), not
      // from poGroupsOut, so this figure survives even once a PO has fully
      // delivered and dropped out of the active drill-down.
      const finalRelRaw = row[prCol['Final rel.']];
      const finalRelMidnight = isRealDate_(finalRelRaw) ? toMidnight(finalRelRaw) : null;
      let earliestPODtMidnight = null;
      lineItems.forEach(function (r) {
        if (String(r[ML_COL.PO_NO]).trim() === '') return;
        const d = toMidnight(r[ML_COL.PO_DT]);
        if (d && (!earliestPODtMidnight || d < earliestPODtMidnight)) earliestPODtMidnight = d;
      });
      const releaseToPODays = (finalRelMidnight && earliestPODtMidnight)
        ? Math.floor((earliestPODtMidnight - finalRelMidnight) / 86400000)
        : null;

      // Capital-goods budget, computed from ALL of this PR's raw Material
      // List rows -- including ones whose PO has since fully delivered and
      // dropped out of poGroupsOut/pendingPOAwardOut. Budget commitment for
      // a capital item happens at PR-raise time (per project owner), so this
      // stays a true cumulative figure regardless of later archiving.
      // Classification uses the PER-UNIT rate, not the line's total value --
      // a 2-qty line worth 16 lakh total is 8 lakh per piece, below the
      // threshold, even though its total value alone would clear it.
      // VALUE SUMMED: PO Value once a PO exists, PR Value only for items
      // still pending one -- the same basis poValueTotal itself uses.
      // Originally this always summed PR Value, which made "Capital Budget
      // Utilized" incomparable to "Total PO Value" (different bases can't
      // be validly subtracted from one another) -- fixed after the project
      // owner's own cross-check surfaced the mismatch.
      let capitalValueTotal = 0;
      lineItems.forEach(function (r) {
        const rate = Number(r[ML_COL.PR_LINE_RATE]) || 0;
        if (rate <= CAPITAL_GOOD_PR_VALUE_THRESHOLD) return;
        const hasPO = String(r[ML_COL.PO_NO]).trim() !== '';
        const value = hasPO ? (Number(r[ML_COL.PO_VALUE]) || 0) : (Number(r[ML_COL.PR_LINE_VALUE]) || 0);
        capitalValueTotal += value;
      });

      const itemStates = [];      // one stage-name entry per PO-group/pending-item, for the worst-case STAGE rollup only
      const poGroupsOut = [];     // non-archived POs, for the drill-down panel
      let pendingPOAwardOut = []; // items still with no PO No. at all
      let receivedItemCount = 0;  // TRUE item-level count for Progress -- counts each item whose own 105 Qty >= PO Qty, independent of its PO siblings or archiving

      if (lineItems.length === 0) {
        itemStates.push(preMLStage);
      } else {
        const withPO = lineItems.filter(function (r) { return String(r[ML_COL.PO_NO]).trim() !== ''; });
        const withoutPO = lineItems.filter(function (r) { return String(r[ML_COL.PO_NO]).trim() === ''; });

        withoutPO.forEach(function () { itemStates.push(withPO.length > 0 ? 'Pending PO Award' : preMLStage); });
        pendingPOAwardOut = withoutPO.map(function (r) {
          const code = String(r[ML_COL.MAT_CODE]).trim();
          const prValue = Number(r[ML_COL.PR_LINE_VALUE]) || 0;
          const prRate = Number(r[ML_COL.PR_LINE_RATE]) || 0;
          const prDelDtMidnight = toMidnight(r[ML_COL.PR_DEL_DT]);
          const isOverdue = !!(prDelDtMidnight && prDelDtMidnight < today);
          return {
            ucsCode: code, description: r[ML_COL.DESCRIPTION], longText: longTextMap[code] || '', qty: r[ML_COL.LINE_QTY],
            prValue: prValue, isCapital: prRate > CAPITAL_GOOD_PR_VALUE_THRESHOLD,
            prDelDt: formatDateOut(r[ML_COL.PR_DEL_DT]),
            effectiveDate: prDelDtMidnight ? formatDateOut(prDelDtMidnight) : '',
            isOverdue: isOverdue
          };
        });

        const byPO = {};
        withPO.forEach(function (r) {
          const poNo = String(r[ML_COL.PO_NO]).trim();
          if (!byPO[poNo]) byPO[poNo] = [];
          byPO[poNo].push(r);
        });

        Object.keys(byPO).forEach(function (poNo) {
          const items = byPO[poNo];
          const itemIsReceived = items.map(function (r) {
            const qty105 = Number(r[ML_COL.QTY_105]) || 0;
            const poQty = Number(r[ML_COL.PO_QTY]) || 0;
            return poQty > 0 && qty105 >= poQty;
          });
          const fullyReceivedCount = itemIsReceived.filter(Boolean).length;
          receivedItemCount += fullyReceivedCount; // counted whether this PO ends up archived or still open below

          let status;
          if (fullyReceivedCount === items.length) status = 'Fully Received';
          else if (fullyReceivedCount > 0) status = 'Partial';
          else status = 'Pending Delivery';

          let deliveredDate = null;      // set only when this PO is in its post-delivery grace window
          let daysUntilFallOff = null;
          let keptByAnalysisOverride = false;

          if (status === 'Fully Received') {
            let lastReceiptMidnight = null;
            items.forEach(function (r) {
              const d = toMidnight(r[ML_COL.DT_105]);
              if (d && (!lastReceiptMidnight || d > lastReceiptMidnight)) lastReceiptMidnight = d;
            });

            if (fullHistoryMode) {
              status = 'Recently Delivered'; // never archived in this mode -- see fullHistoryMode comment above
              deliveredDate = lastReceiptMidnight ? formatDateOut(lastReceiptMidnight) : '';
              keptByAnalysisOverride = true; // reuses the "no countdown" display path -- there's nothing to count down to
            } else if (analysisOverride) {
              if (lastReceiptMidnight && lastReceiptMidnight >= analysisOverride) {
                status = 'Recently Delivered';
                deliveredDate = formatDateOut(lastReceiptMidnight);
                keptByAnalysisOverride = true; // fixed cutoff, not a rolling countdown -- daysUntilFallOff stays null
              } else {
                return; // before the analysis cutoff -- archived, same as the normal rule
              }
            } else {
              const ageDays = lastReceiptMidnight ? Math.floor((today - lastReceiptMidnight) / 86400000) : Infinity;
              if (ageDays <= deliveredGraceDays) {
                status = 'Recently Delivered'; // still shown -- see grace-period comment on the constant above
                deliveredDate = formatDateOut(lastReceiptMidnight);
                daysUntilFallOff = deliveredGraceDays - ageDays;
              } else {
                return; // grace period elapsed -- archived for good, same as the original rule
              }
            }
          }

          // PO Value Outstanding = the actual money still tied up in this PO:
          // for each item, (PO Qty - 105 Qty) x PO Rate -- NOT the item's
          // full original value. A partially-received item (e.g. 20 of 30
          // delivered) should only count the remaining 10 units' worth, not
          // its whole line value, since 20 units' worth has already arrived.
          // Naturally comes out to 0 for a Recently Delivered PO.
          let poValueOutstanding = 0;
          items.forEach(function (r) {
            const poQty = Number(r[ML_COL.PO_QTY]) || 0;
            const qty105 = Number(r[ML_COL.QTY_105]) || 0;
            const outstandingQty = Math.max(poQty - qty105, 0);
            const rate = Number(r[ML_COL.PO_RATE]) || 0;
            poValueOutstanding += outstandingQty * rate;
          });

          // Total PO Value = the full committed value of this PO, straight
          // from Material List's own "PO Value" column -- used alongside
          // poValueOutstanding to derive "% PO Value Balance" (how much of
          // what was committed is still un-delivered).
          let poValueTotal = 0;
          items.forEach(function (r) {
            poValueTotal += Number(r[ML_COL.PO_VALUE]) || 0;
          });

          itemStates.push(status);
          poGroupsOut.push({
            poNo: poNo,
            poDate: formatDateOut(items[0][ML_COL.PO_DT]),
            vendorCode: items[0][ML_COL.V_CODE],
            vendorName: items[0][ML_COL.V_NAME],
            poValueOutstanding: poValueOutstanding,
            poValueTotal: poValueTotal,
            status: status,
            deliveredDate: deliveredDate,
            keptByAnalysisOverride: keptByAnalysisOverride,
            daysUntilFallOff: daysUntilFallOff,
            items: items.map(function (r) {
              const code = String(r[ML_COL.MAT_CODE]).trim();
              const prValue = Number(r[ML_COL.PR_LINE_VALUE]) || 0;
              const prRate = Number(r[ML_COL.PR_LINE_RATE]) || 0;
              const poQtyItem = Number(r[ML_COL.PO_QTY]) || 0;
              const qty105Item = Number(r[ML_COL.QTY_105]) || 0;
              const rateItem = Number(r[ML_COL.PO_RATE]) || 0;
              const itemFullyReceived = poQtyItem > 0 && qty105Item >= poQtyItem;
              const outstandingValueItem = Math.max(poQtyItem - qty105Item, 0) * rateItem;

              // Effective date -- the operative date driving THIS item's
              // budget FY, per the confirmed priority: Alt DP (if the vendor
              // renegotiated) -> PO DP (the item's own, not the PO's) ->
              // never PR Del Dt here, since a PO already exists. ONE
              // EXCEPTION, fixed after a real discrepancy was found: once an
              // item is fully received, its effective date becomes its
              // ACTUAL 105 receipt date, not blank. Setting it blank made the
              // item invisible to every window-scoped total (getRelevantEffectiveDateItems
              // filters out anything with no effective date at all) -- so a
              // delivered item's value vanished from BOTH Committed and
              // Outstanding instead of moving from Outstanding to Received,
              // silently undercounting Committed Value and Received So Far
              // by exactly the value of everything already delivered.
              const altDPMidnight = toMidnight(r[ML_COL.ALT_DP]);
              const poDPMidnight = toMidnight(r[ML_COL.PO_DP]);
              const item105Midnight = toMidnight(r[ML_COL.DT_105]);
              const effectiveMidnight = itemFullyReceived ? item105Midnight : (altDPMidnight || poDPMidnight);
              // Overdue = the operative date has already passed and the item
              // is STILL not received -- whether because no Alt DP was ever
              // requested (a stale PO DP silently carried forward) or
              // because even the Alt DP itself has now also lapsed. This is
              // exactly the "phantom budget block" the project owner
              // described: SAP keeps this date on record and continues to
              // reserve funds against it, however old it gets. Explicitly
              // excludes fully-received items -- their effective date is now
              // their (necessarily past) receipt date, which must never be
              // mistaken for an overdue commitment.
              const isOverdue = !!(!itemFullyReceived && effectiveMidnight && effectiveMidnight < today);

              return {
                ucsCode: code,
                description: r[ML_COL.DESCRIPTION],
                longText: longTextMap[code] || '',
                qty: r[ML_COL.PO_LINE_QTY],
                poQty: r[ML_COL.PO_QTY],
                poDP: formatDateOut(r[ML_COL.PO_DP]),
                altDP: formatDateOut(r[ML_COL.ALT_DP]),
                qty105: r[ML_COL.QTY_105],
                date105: formatDateOut(r[ML_COL.DT_105]),
                prValue: prValue,
                poValue: Number(r[ML_COL.PO_VALUE]) || 0,
                outstandingValue: outstandingValueItem,
                isCapital: prRate > CAPITAL_GOOD_PR_VALUE_THRESHOLD,
                effectiveDate: effectiveMidnight ? formatDateOut(effectiveMidnight) : '',
                isOverdue: isOverdue
              };
            })
          });
        });
      }

      if (itemStates.length === 0) continue; // every item done & archived -- whole PR drops off too

      let overallStage = itemStates[0];
      itemStates.forEach(function (s) { if (stageRank_(s) < stageRank_(overallStage)) overallStage = s; });

      const totalCount = lineItems.length || 1;
      const doneCount = lineItems.length === 0 ? 0 : receivedItemCount; // real items received, not PO-groups closed

      // PR-level rollup, for showing alongside PR Value -- null (not 0) when
      // this PR has no live PO yet at all, so the client can render "-"
      // rather than a misleading ₹0.00 for a PR that simply hasn't reached
      // PO stage.
      const poValueOutstandingTotal = poGroupsOut.length > 0
        ? poGroupsOut.reduce(function (sum, g) { return sum + g.poValueOutstanding; }, 0)
        : null;
      const poValueTotalRollup = poGroupsOut.length > 0
        ? poGroupsOut.reduce(function (sum, g) { return sum + g.poValueTotal; }, 0)
        : null;

      const hasOverdueItem = poGroupsOut.some(function (g) { return g.items.some(function (it) { return it.isOverdue; }); })
        || pendingPOAwardOut.some(function (it) { return it.isOverdue; });

      funnelCounts[overallStage] = (funnelCounts[overallStage] || 0) + 1;

      outPRs.push({
        prNo: prNo,
        prText: row[prCol['PR Text']],
        prCrDt: formatDateOut(row[prCol['PR Cr Dt']]),
        fundCentre: row[prCol['Fund Centre']],
        section: row[prCol['Section']],
        crName: row[prCol['Cr name']],
        prTotValue: row[prCol['PR Tot Value']],
        poValueOutstanding: poValueOutstandingTotal,
        poValueTotal: poValueTotalRollup,
        hasOverdueItem: hasOverdueItem,
        finalRelDt: finalRelMidnight ? formatDateOut(finalRelMidnight) : '',
        releaseToPODays: releaseToPODays,
        capitalValueTotal: capitalValueTotal,
        purOfficer: row[prCol['Pur Officer']],
        qoDt: formatDateOut(row[prCol['QO Dt']]),
        techSuitDt: formatDateOut(row[prCol['TechSuit Dt']]),
        overallStage: overallStage,
        progress: doneCount + '/' + totalCount,
        poGroups: poGroupsOut,
        itemsPendingPOAward: pendingPOAwardOut
      });
    }

    outPRs.sort(function (a, b) { return (b.prCrDt || '').localeCompare(a.prCrDt || ''); }); // newest first, oldest last

    return jsonResponse({ success: true, prs: outPRs, funnel: funnelCounts, stageOrder: STAGE_ORDER_, graceDays: deliveredGraceDays, analysisSinceDate: analysisOverride ? formatDateOut(analysisOverride) : null });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Could not load PR/PO dashboard: ' + e.message });
  }
}

function getUCSCodeHistory(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return jsonResponse(login);
  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  const requestedArea = String(data.area || '').trim();
  const isPlanning = isPlanningAreaStaff(login.authorizedArea);
  let scope, areaFilter, includeStoZ04;
  if (isPlanning) {
    scope = 'full'; areaFilter = requestedArea; includeStoZ04 = true;
  } else {
    if (!requestedArea) return jsonResponse({ success: false, message: 'Area is required.' });
    if (!canViewAreaUCSHistory(requestedArea, login.authorizedArea, login.role)) return jsonResponse({ success: false, message: 'You are not authorized to view history for ' + requestedArea + '.' });
    scope = 'area'; areaFilter = requestedArea; includeStoZ04 = false;
  }
  const fromDate = parseOptionalDateBound_(data.fromDate);
  const toDate = parseOptionalDateBound_(data.toDate);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const monthlyReceived = {};
  const monthlyReleased = {};
  function addToMonth_(bucket, cellDateVal, qty) {
    const d = toMidnight(cellDateVal);
    if (!d) return;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    bucket[key] = (bucket[key] || 0) + qty;
  }
  const stoRows = [];
  const z04Rows = [];
  let poPrRows = [];
  let poPrError = null;
  if (includeStoZ04) {
    try {
      poPrRows = getPoPrRowsForUcsCode_(ucsCode, fromDate, toDate);
    } catch (e) {
      poPrError = e.message; // fail soft -- STO/Z04/201/Issues still work even if this external sheet has an issue
    }
  }
  if (includeStoZ04) {
    const stoSheet = ss.getSheetByName(STO_SHEET);
    const stoValues = stoSheet.getDataRange().getValues();
    if (stoValues.length >= 2) {
      const h = stoValues[0];
      const col = {};
      h.forEach(function (hd, idx) { col[hd] = idx; });
      for (let i = 1; i < stoValues.length; i++) {
        const r = stoValues[i];
        if (String(r[col['UCS_Code']]).trim() !== ucsCode) continue;
        if (isSTODeleted_(r, col)) continue;
        if (!withinDateRange_(r[col['STO_Date']], fromDate, toDate)) continue;
        stoRows.push({ stoNo: r[col['STO_No']], stoDate: formatDateOut(r[col['STO_Date']]), qty: r[col['Qty']], unit: r[col['Unit']], receivedQty: isBlankCell(r[col['Received_Qty']]) ? null : r[col['Received_Qty']], receivedDate: formatDateOut(r[col['Received_Date']]), referencePO: r[col['Reference_PO']] });
      }
    }
    const z04Sheet = ss.getSheetByName(Z04_SHEET);
    const z04Values = z04Sheet.getDataRange().getValues();
    if (z04Values.length >= 2) {
      const h = z04Values[0];
      const col = {};
      h.forEach(function (hd, idx) { col[hd] = idx; });
      for (let i = 1; i < z04Values.length; i++) {
        const r = z04Values[i];
        if (String(r[col['UCS_Code']]).trim() !== ucsCode) continue;
        const qty = Number(r[col['Qty_Recieved_Z04']]) || 0;
        addToMonth_(monthlyReceived, r[col['Date_of_Receipt_Z04']], qty);
        if (!withinDateRange_(r[col['Date_of_Receipt_Z04']], fromDate, toDate)) continue;
        z04Rows.push({ stoNo: r[col['STO_No']], dateOfReceipt: formatDateOut(r[col['Date_of_Receipt_Z04']]), qtyReceived: qty, matDocNo: r[col['Mat_Doc_No_Z04']], receivedBy: r[col['Mat_Recieved_By']] });
      }
    }
  }
  const s201Sheet = ss.getSheetByName(S201_SHEET);
  const s201Values = s201Sheet.getDataRange().getValues();
  const s201Rows = [];
  if (s201Values.length >= 2) {
    const h = s201Values[0];
    const col = {};
    h.forEach(function (hd, idx) { col[hd] = idx; });
    for (let i = 1; i < s201Values.length; i++) {
      const r = s201Values[i];
      if (String(r[col['UCS_Code']]).trim() !== ucsCode) continue;
      const releasedToArea = r[col['Released_to_Area']];
      if (String(releasedToArea).trim().toUpperCase() === 'PLANNING') continue;
      if (areaFilter && String(releasedToArea).trim() !== areaFilter) continue;
      const qty = Number(r[col['Qty_Released_201']]) || 0;
      addToMonth_(monthlyReleased, r[col['Date_of_Release']], qty);
      if (!withinDateRange_(r[col['Date_of_Release']], fromDate, toDate)) continue;
      s201Rows.push({ stoNo: r[col['STO_No']], qtyReleased: qty, matDocNo: r[col['Mat_Doc_No_201']], dateOfRelease: formatDateOut(r[col['Date_of_Release']]), releasedToArea: releasedToArea });
    }
  }
  const ledgerSheet = ss.getSheetByName(ISSUE_LEDGER_SHEET);
  const ledgerValues = ledgerSheet.getDataRange().getValues();
  const issueRows = [];
  if (ledgerValues.length >= 2) {
    const h = ledgerValues[0];
    const col = {};
    h.forEach(function (hd, idx) { col[hd] = idx; });
    for (let i = 1; i < ledgerValues.length; i++) {
      const r = ledgerValues[i];
      if (String(r[col['UCS_Code']]).trim() !== ucsCode) continue;
      const area = r[col['Area']];
      if (areaFilter && String(area).trim() !== areaFilter) continue;
      const qty = Number(r[col['Issue_Qty']]) || 0;
      addToMonth_(monthlyReleased, r[col['Issue_Date']], qty);
      if (!withinDateRange_(r[col['Issue_Date']], fromDate, toDate)) continue;
      issueRows.push({
        issueDate: formatDateOut(r[col['Issue_Date']]),
        issueDateSort_: (toMidnight(r[col['Issue_Date']]) || new Date(0)).getTime(),
        issueQty: qty, issuedTo: r[col['Issued_to']], area: area, reqSlipNumber: r[col['Req_Slip_number']],
        type: 'issue'
      });
    }
  }

  // -- RETURN MODULE ADDITION: merge completed returns into this same feed
  // as negative rows. These are the exact mirror-image credits
  // computePlanningStockMap_() already nets into the balance shown on the
  // dashboard, but until now had no visible trail anywhere in the UI --
  // Return_Header/Return_Details are a separate pair of sheets from
  // PLNG_ISSUE_SHEET, never joined into this history feed before. Filtered
  // by areaFilter the same way issueRows above are, since Return_Header's
  // Area is the same "which area held this material" concept as
  // PLNG_ISSUE_SHEET's Area column (including the literal value
  // 'PLANNING', for material that was issued and returned without ever
  // leaving Planning's own custody).
  const retHeaderSheet2 = ss.getSheetByName(RETURN_HEADER_SHEET);
  const retHeaderValues2 = retHeaderSheet2.getDataRange().getValues();
  const returnHeaderById_ = {};
  if (retHeaderValues2.length >= 2) {
    const rh = retHeaderValues2[0];
    const rCol = {};
    rh.forEach(function (hd, idx) { rCol[hd] = idx; });
    for (let i = 1; i < retHeaderValues2.length; i++) {
      const row = retHeaderValues2[i];
      returnHeaderById_[String(row[rCol['Return_ID']])] = { area: String(row[rCol['Area']]).trim(), raisedByName: row[rCol['Raised_By_Name']] };
    }
  }
  const retDetailsSheet2 = ss.getSheetByName(RETURN_DETAILS_SHEET);
  const retDetailsValues2 = retDetailsSheet2.getDataRange().getValues();
  if (retDetailsValues2.length >= 2) {
    const rd = retDetailsValues2[0];
    const dCol2 = {};
    rd.forEach(function (hd, idx) { dCol2[hd] = idx; });
    for (let i = 1; i < retDetailsValues2.length; i++) {
      const r = retDetailsValues2[i];
      if (String(r[dCol2['Slip_Status']]) !== 'Completed') continue;
      if (String(r[dCol2['UCS_Code']]).trim() !== ucsCode) continue;
      const header = returnHeaderById_[String(r[dCol2['Return_ID']])] || { area: '', raisedByName: '' };
      if (areaFilter && header.area !== areaFilter) continue;
      const qtyApproved = Number(r[dCol2['Qty_Approved']]) || 0;
      if (qtyApproved === 0) continue; // fully-rejected return (0 approved) -- nothing was actually credited back, nothing to show
      const approvedTs = r[dCol2['Approved_Timestamp']];
      addToMonth_(monthlyReleased, approvedTs, -qtyApproved);
      if (!withinDateRange_(approvedTs, fromDate, toDate)) continue;
      issueRows.push({
        issueDate: formatDateOut(approvedTs),
        issueDateSort_: (toMidnight(approvedTs) || new Date(0)).getTime(),
        issueQty: -qtyApproved,
        issuedTo: '(Return) ' + (header.raisedByName || ''),
        area: header.area,
        reqSlipNumber: r[dCol2['Return_ID']],
        type: 'return'
      });
    }
  }
  // Chronological order across the merged issue+return rows, oldest first.
  // Every other tab in this modal relies on sheet-append-order already
  // being chronological order and never sorts explicitly; merging two
  // different sheets into one feed breaks that assumption, so this tab
  // needs its own explicit sort (same pattern as getPoPrRowsForUcsCode_'s
  // poDateSort_, including stripping the sort key before returning).
  issueRows.sort(function (a, b) { return a.issueDateSort_ - b.issueDateSort_; });
  issueRows.forEach(function (r) { delete r.issueDateSort_; });

  const localSheet = ss.getSheetByName(LOCAL_ISSUE_SHEET);
  const localValues = localSheet.getDataRange().getValues();
  const localIssueRows = [];
  if (localValues.length >= 2) {
    const h = localValues[0];
    const col = {};
    h.forEach(function (hd, idx) { col[hd] = idx; });
    for (let i = 1; i < localValues.length; i++) {
      const r = localValues[i];
      if (String(r[col['UCS_Code']]).trim() !== ucsCode) continue;
      const area = r[col['Area']];
      if (areaFilter && String(area).trim() !== areaFilter) continue;
      const qty = Number(r[col['Consumed_Qty']]) || 0;
      if (scope === 'area') addToMonth_(monthlyReceived, r[col['Issue_Date']], qty);
      if (!withinDateRange_(r[col['Issue_Date']], fromDate, toDate)) continue;
      localIssueRows.push({ issueDate: formatDateOut(r[col['Issue_Date']]), area: area, consumedQty: qty, issuedTo: r[col['Issued_To']], remarks: r[col['Remarks']], issuedByName: r[col['Issued_By_Name']] });
    }
  }
  const localIssue = { available: true, rows: localIssueRows };
  const ucsSheet = ss.getSheetByName(UCS_SHEET);
  const ucsValues2 = ucsSheet.getDataRange().getValues();
  let itemDescription = '', unit = '';
  if (ucsValues2.length >= 2) {
    const uh = ucsValues2[0];
    const ucsCodeCol = getColIndexOrThrow_(uh, 'UCS_Code', UCS_SHEET);
    const shortCol = getColIndexOrThrow_(uh, 'Short_Text', UCS_SHEET);
    const unitCol = getColIndexOrThrow_(uh, 'Unit', UCS_SHEET);
    for (let i = 1; i < ucsValues2.length; i++) {
      if (String(ucsValues2[i][ucsCodeCol]).trim() === ucsCode) { itemDescription = ucsValues2[i][shortCol]; unit = ucsValues2[i][unitCol]; break; }
    }
  }
  const allMonths = {};
  Object.keys(monthlyReceived).forEach(function (k) { allMonths[k] = true; });
  Object.keys(monthlyReleased).forEach(function (k) { allMonths[k] = true; });
  let months = Object.keys(allMonths).sort();
  if (fromDate || toDate) {
    months = months.filter(function (m) {
      const d = new Date(Number(m.split('-')[0]), Number(m.split('-')[1]) - 1, 1);
      if (fromDate && d < new Date(fromDate.getFullYear(), fromDate.getMonth(), 1)) return false;
      if (toDate && d > toDate) return false;
      return true;
    });
  }
  const chart = (scope === 'area')
    ? { labels: months, received: months.map(function (m) { return monthlyReleased[m] || 0; }), released: months.map(function (m) { return monthlyReceived[m] || 0; }) }
    : { labels: months, received: months.map(function (m) { return monthlyReceived[m] || 0; }), released: months.map(function (m) { return monthlyReleased[m] || 0; }) };
  const chartLabels = (scope === 'area') ? { received: 'Received into ' + areaFilter, released: 'Consumed locally' } : { received: 'Received (Z04)', released: 'Released (201 + Issues)' };
  const poPrSummary = { count: poPrRows.length, totalQty: poPrRows.reduce(function (s, r) { return s + (Number(r.qty) || 0); }, 0) };
  return jsonResponse({ success: true, scope: scope, area: areaFilter, ucsCode: ucsCode, itemDescription: itemDescription, unit: unit, sto: stoRows, z04: z04Rows, stoZ04Available: includeStoZ04, s201: s201Rows, issues: issueRows, localIssue: localIssue, poPr: poPrRows, poPrAvailable: includeStoZ04, poPrError: poPrError, poPrSummary: poPrSummary, chart: chart, chartLabels: chartLabels });
}

function canRecordLocalIssue(area, authorizedAreaString, roleString) { return canRaiseRequisition(area, authorizedAreaString, roleString); }

function computeAreaAvailableBalance_(area, ucsCode) {
  const map = computeAreaStockMap_();
  const entry = map.find(function (r) { return r.area === area && r.ucsCode === ucsCode; });
  return entry ? entry.qtyBalance : 0;
}

function recordLocalIssue(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return jsonResponse(login);
  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!canRecordLocalIssue(area, login.authorizedArea, login.role)) return jsonResponse({ success: false, message: 'You are not authorized to record local issues for ' + area + '.' });
  const validAreas = readOptionsColumn('Area_201');
  if (validAreas.indexOf(area) === -1) return jsonResponse({ success: false, message: 'Unknown area: ' + area });
  // PLANNING material is issued only via the Requisition -> Issue path
  // (recorded in PLNG_ISSUE_SHEET), never as a "local issue." Rejected
  // server-side, not just hidden from the area dropdown: computeAreaStockMap_()
  // has no PLANNING exclusion on its LOCAL_ISSUE_SHEET pass (unlike its S_201/
  // PLNG_ISSUE_SHEET/Return passes, which all skip it), so an Area=PLANNING
  // row here would silently create a phantom PLANNING pseudo-area in
  // AREA_STOCK with consumption but no matching inflow -- a permanent
  // negative balance with no legitimate transaction behind it.
  if (area.toUpperCase() === 'PLANNING') return jsonResponse({ success: false, message: 'Local issues cannot be recorded for PLANNING. Planning material is issued through the Requisition module (Raise Requisition -> Issue), not local consumption.' });
  const issuedTo = String(data.issuedTo || '').trim();
  if (!issuedTo) return jsonResponse({ success: false, message: 'Issued To is required.' });
  if (issuedTo.length > 200) return jsonResponse({ success: false, message: 'Issued To is too long (max 200 characters).' });
  const remarks = String(data.remarks || '').trim();
  if (remarks.length > 500) return jsonResponse({ success: false, message: 'Remarks is too long (max 500 characters).' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'Add at least one item.' });
  if (items.length > 10) return jsonResponse({ success: false, message: 'Maximum 10 items per submission.' });
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);
  const ucsMap = {};
  for (let i = 1; i < ucsValues.length; i++) {
    const code = String(ucsValues[i][ucsCodeCol]).trim();
    if (code) ucsMap[code] = { desc: ucsValues[i][ucsShortCol], unit: ucsValues[i][ucsUnitCol] };
  }
  const clean = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const ucsCode = String(it.ucsCode || '').trim();
    const qty = Number(it.qty);
    if (!ucsCode || !ucsMap[ucsCode]) return jsonResponse({ success: false, message: 'Line ' + (idx + 1) + ': unknown UCS Code.' });
    if (!Number.isInteger(qty) || qty <= 0) return jsonResponse({ success: false, message: 'Line ' + (idx + 1) + ' (' + ucsCode + '): quantity must be a positive whole number.' });
    clean.push({ ucsCode: ucsCode, qty: qty, itemDescription: ucsMap[ucsCode].desc, unit: ucsMap[ucsCode].unit });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const neededByCode = {};
    clean.forEach(function (c) { neededByCode[c.ucsCode] = (neededByCode[c.ucsCode] || 0) + c.qty; });
    const areaMapNow = computeAreaStockMap_(); // fresh (never cached) -- this is a write-path check; computed ONCE, not once per item (was up to 10x, 6 sheet reads each)
    for (const code in neededByCode) {
      const entryNow = areaMapNow.find(function (r) { return r.area === area && r.ucsCode === code; });
      const available = entryNow ? entryNow.qtyBalance : 0;
      if (neededByCode[code] > available) return jsonResponse({ success: false, message: code + ': only ' + available + ' available in ' + area + "'s local stock -- cannot issue " + neededByCode[code] + '.' });
    }
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOCAL_ISSUE_SHEET);
    const headers = readHeaderRow_(sheet);
    const dateCol = getColIndexOrThrow_(headers, 'Issue_Date', LOCAL_ISSUE_SHEET);
    const areaCol = getColIndexOrThrow_(headers, 'Area', LOCAL_ISSUE_SHEET);
    const codeCol = getColIndexOrThrow_(headers, 'UCS_Code', LOCAL_ISSUE_SHEET);
    const descCol = getColIndexOrThrow_(headers, 'Material_Description', LOCAL_ISSUE_SHEET);
    const unitCol = getColIndexOrThrow_(headers, 'Unit', LOCAL_ISSUE_SHEET);
    const qtyCol = getColIndexOrThrow_(headers, 'Consumed_Qty', LOCAL_ISSUE_SHEET);
    const issuedToCol = getColIndexOrThrow_(headers, 'Issued_To', LOCAL_ISSUE_SHEET);
    const remarksCol = getColIndexOrThrow_(headers, 'Remarks', LOCAL_ISSUE_SHEET);
    const byNameCol = getColIndexOrThrow_(headers, 'Issued_By_Name', LOCAL_ISSUE_SHEET);
    const byEmailCol = getColIndexOrThrow_(headers, 'Issued_By_Email', LOCAL_ISSUE_SHEET);
    const tsCol = getColIndexOrThrow_(headers, 'Timestamp', LOCAL_ISSUE_SHEET);
    const now = new Date();
    const newRows = clean.map(function (c) {
      const row = new Array(headers.length).fill('');
      row[dateCol] = now; row[areaCol] = area; row[codeCol] = c.ucsCode; row[descCol] = c.itemDescription; row[unitCol] = c.unit; row[qtyCol] = c.qty;
      row[issuedToCol] = issuedTo; row[remarksCol] = remarks; row[byNameCol] = login.name; row[byEmailCol] = data.email; row[tsCol] = now;
      return row;
    });
    appendRows_(sheet, newRows, [codeCol]);
    logAudit(login.name, data.email, 'RECORD_LOCAL_ISSUE', area + ': ' + clean.map(function (c) { return c.ucsCode + ' x' + c.qty; }).join(', ') + ' -> ' + issuedTo);

    // No approval chain here -- a local issue is a same-area, self-contained
    // transaction. So the natural notification is simply the mirror-image
    // role for this area: if a Supervisor recorded it, tell the Incharge(s);
    // if the Incharge recorded it, tell the Supervisor(s). Either way, the
    // person who didn't act stays aware of movement in their own area's stock.
    const localIssuerEmailLower = String(data.email).trim().toLowerCase();
    const localIssueRecipients = getAreaInchargeEmails_(area).concat(getAreaStoreSupervisorEmails_(area));
    const seenLocalIssueEmails = {};
    localIssueRecipients.forEach(function (email) {
      const key = String(email).trim().toLowerCase();
      if (key === localIssuerEmailLower || seenLocalIssueEmails[key]) return;
      seenLocalIssueEmails[key] = true;
      sendPushNotification(email, 'Local issue recorded', area + ' — ' + clean.length + ' item(s)', 'area-stock-dashboard');
    });

    return jsonResponse({ success: true, message: clean.length + ' item(s) issued from ' + area + "'s local stock." });
  } finally {
    lock.releaseLock();
  }
}

function getMyLocalIssues(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (myAreas.length === 0) return jsonResponse({ success: true, items: [] });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOCAL_ISSUE_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonResponse({ success: true, items: [] });
  const headers = values[0];
  const col = {};
  headers.forEach(function (h, idx) { col[h] = idx; });
  const items = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const area = row[col['Area']];
    if (myAreas.indexOf(String(area).trim()) === -1) continue;
    items.push({ issueDate: formatDateOut(row[col['Issue_Date']]), area: area, ucsCode: row[col['UCS_Code']], itemDescription: row[col['Material_Description']], unit: row[col['Unit']], consumedQty: row[col['Consumed_Qty']], issuedTo: row[col['Issued_To']], remarks: row[col['Remarks']], issuedByName: row[col['Issued_By_Name']] });
  }
  items.sort(function (a, b) { return b.issueDate.localeCompare(a.issueDate); });
  return jsonResponse({ success: true, items: items });
}

function computeAreaStockMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const map = {}; // 'area|code' -> { area, ucsCode, itemDescription, unit, inflow, consumed }

  function ensureEntry_(area, code, desc, unit) {
    const key = area + '|' + code;
    if (!map[key]) {
      map[key] = { area: area, ucsCode: code, itemDescription: desc || '', unit: unit || '', inflow: 0, consumed: 0 };
    } else if (!map[key].itemDescription && desc) {
      map[key].itemDescription = desc;
      map[key].unit = unit || map[key].unit;
    }
    return map[key];
  }

  // ---- S_201: direct SAP 201 releases straight to an area ----
  const s201Sheet = ss.getSheetByName(S201_SHEET);
  const s201Values = s201Sheet.getDataRange().getValues();
  if (s201Values.length >= 2) {
    const h = s201Values[0];
    const areaCol = getColIndexOrThrow_(h, 'Released_to_Area', S201_SHEET);
    const codeCol = getColIndexOrThrow_(h, 'UCS_Code', S201_SHEET);
    const descCol = getColIndexOrThrow_(h, 'Item_Description', S201_SHEET);
    const unitCol = getColIndexOrThrow_(h, 'Unit', S201_SHEET);
    const qtyCol = getColIndexOrThrow_(h, 'Qty_Released_201', S201_SHEET);
    for (let i = 1; i < s201Values.length; i++) {
      const area = String(s201Values[i][areaCol]).trim();
      const code = String(s201Values[i][codeCol]).trim();
      if (!area || !code || area.toUpperCase() === 'PLANNING') continue;
      const entry = ensureEntry_(area, code, s201Values[i][descCol], s201Values[i][unitCol]);
      entry.inflow += Number(s201Values[i][qtyCol]) || 0;
    }
  }

  // ---- PLNG_ISSUE_SHEET: Requisition-workflow hand-offs from Planning to an area ----
  const ledgerSheet = ss.getSheetByName(ISSUE_LEDGER_SHEET);
  const ledgerValues = ledgerSheet.getDataRange().getValues();
  if (ledgerValues.length >= 2) {
    const h = ledgerValues[0];
    const areaCol = getColIndexOrThrow_(h, 'Area', ISSUE_LEDGER_SHEET);
    const codeCol = getColIndexOrThrow_(h, 'UCS_Code', ISSUE_LEDGER_SHEET);
    const descCol = getColIndexOrThrow_(h, 'Item_Description', ISSUE_LEDGER_SHEET);
    const unitCol = getColIndexOrThrow_(h, 'Unit', ISSUE_LEDGER_SHEET);
    const qtyCol = getColIndexOrThrow_(h, 'Issue_Qty', ISSUE_LEDGER_SHEET);
    for (let i = 1; i < ledgerValues.length; i++) {
      const area = String(ledgerValues[i][areaCol]).trim();
      const code = String(ledgerValues[i][codeCol]).trim();
      if (!area || !code || area.toUpperCase() === 'PLANNING') continue;
      const entry = ensureEntry_(area, code, ledgerValues[i][descCol], ledgerValues[i][unitCol]);
      entry.inflow += Number(ledgerValues[i][qtyCol]) || 0;
    }
  }

  // ---- LOCAL_ISSUE_SHEET: what each area then handed out locally ----
  const localSheet = ss.getSheetByName(LOCAL_ISSUE_SHEET);
  const localValues = localSheet.getDataRange().getValues();
  if (localValues.length >= 2) {
    const h = localValues[0];
    const areaCol = getColIndexOrThrow_(h, 'Area', LOCAL_ISSUE_SHEET);
    const codeCol = getColIndexOrThrow_(h, 'UCS_Code', LOCAL_ISSUE_SHEET);
    const descCol = getColIndexOrThrow_(h, 'Material_Description', LOCAL_ISSUE_SHEET);
    const unitCol = getColIndexOrThrow_(h, 'Unit', LOCAL_ISSUE_SHEET);
    const qtyCol = getColIndexOrThrow_(h, 'Consumed_Qty', LOCAL_ISSUE_SHEET);
    for (let i = 1; i < localValues.length; i++) {
      const area = String(localValues[i][areaCol]).trim();
      const code = String(localValues[i][codeCol]).trim();
      if (!area || !code) continue;
      const entry = ensureEntry_(area, code, localValues[i][descCol], localValues[i][unitCol]);
      entry.consumed += Number(localValues[i][qtyCol]) || 0;
    }
  }

  // -- RETURN MODULE ADDITION: a completed return removes material from the
  // area's custody -- treated as negative inflow, symmetric with how
  // PLNG_ISSUE_SHEET/S_201 add to it. Always a single, correct subtraction:
  // since Local-Issued material can never be the subject of a return in
  // this module, the returned qty is guaranteed to still be sitting inside
  // `inflow`, untouched by `consumed`. Skipped for PLANNING, consistent
  // with every other exclusion above.
  const retHeaderSheet = ss.getSheetByName(RETURN_HEADER_SHEET);
  const retHeaderValues = retHeaderSheet.getDataRange().getValues();
  const areaByReturnId = {};
  if (retHeaderValues.length >= 2) {
    const rh = retHeaderValues[0];
    const rIdCol = getColIndexOrThrow_(rh, 'Return_ID', RETURN_HEADER_SHEET);
    const rAreaCol = getColIndexOrThrow_(rh, 'Area', RETURN_HEADER_SHEET);
    for (let i = 1; i < retHeaderValues.length; i++) {
      areaByReturnId[String(retHeaderValues[i][rIdCol])] = String(retHeaderValues[i][rAreaCol]).trim();
    }
  }
  const retDetailsSheet = ss.getSheetByName(RETURN_DETAILS_SHEET);
  const retDetailsValues = retDetailsSheet.getDataRange().getValues();
  if (retDetailsValues.length >= 2) {
    const rd = retDetailsValues[0];
    const rdReturnIdCol = getColIndexOrThrow_(rd, 'Return_ID', RETURN_DETAILS_SHEET);
    const rdCodeCol = getColIndexOrThrow_(rd, 'UCS_Code', RETURN_DETAILS_SHEET);
    const rdDescCol = getColIndexOrThrow_(rd, 'Item_Description', RETURN_DETAILS_SHEET);
    const rdUnitCol = getColIndexOrThrow_(rd, 'Unit', RETURN_DETAILS_SHEET);
    const rdQtyCol = getColIndexOrThrow_(rd, 'Qty_Approved', RETURN_DETAILS_SHEET);
    const rdStatusCol = getColIndexOrThrow_(rd, 'Slip_Status', RETURN_DETAILS_SHEET);
    for (let i = 1; i < retDetailsValues.length; i++) {
      if (String(retDetailsValues[i][rdStatusCol]) !== 'Completed') continue;
      const returnId = String(retDetailsValues[i][rdReturnIdCol]);
      const area = areaByReturnId[returnId];
      const code = String(retDetailsValues[i][rdCodeCol]).trim();
      if (!area || !code || area.toUpperCase() === 'PLANNING') continue;
      const entry = ensureEntry_(area, code, retDetailsValues[i][rdDescCol], retDetailsValues[i][rdUnitCol]);
      entry.inflow -= Number(retDetailsValues[i][rdQtyCol]) || 0;
    }
  }

  return Object.keys(map).map(function (key) {
    const e = map[key];
    return {
      area: e.area,
      ucsCode: e.ucsCode,
      itemDescription: e.itemDescription,
      unit: e.unit,
      totalInflow: e.inflow,
      totalConsumed: e.consumed,
      qtyBalance: e.inflow - e.consumed
    };
  }).sort(function (a, b) {
    if (a.area !== b.area) return a.area.localeCompare(b.area);
    return a.ucsCode.localeCompare(b.ucsCode);
  });
}

function refreshAreaStock() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AREA_STOCK_SHEET);
  if (!sheet) throw new Error('AREA_STOCK sheet not found.');
  const rows = computeAreaStockMap_();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 6).clearContent();
  if (rows.length === 0) return;
  const out = rows.map(function (r) { return [r.area, r.ucsCode, r.itemDescription, r.totalInflow, r.totalConsumed, r.qtyBalance]; });
  sheet.getRange(2, 1, out.length, 6).setValues(out);
  sheet.getRange(2, 2, out.length, 1).setNumberFormat('@STRING@');
}

function refreshAreaStockEndpoint(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  try {
    refreshAreaStock();
    return jsonResponse({ success: true, message: 'Area Stock refreshed.' });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Refresh failed: ' + e.message });
  }
}

/**
 * UCS_Code -> Long_Text lookup, used to enrich list endpoints (Area Stock,
 * Planning Stock) whose own source sheets (S_201 / PLNG_ISSUE_SHEET /
 * LOCAL_ISSUE_SHEET / UCS_MasterList itself) don't all carry Long_Text, so
 * the client can search it the same way search-ucs.html already does.
 */
function getUCSLongTextMap_() {
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const map = {};
  if (ucsValues.length < 1) return map;
  const ucsHeaders = ucsValues[0];
  const codeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const longCol = getColIndexOrThrow_(ucsHeaders, 'Long_Text', UCS_SHEET);
  for (let i = 1; i < ucsValues.length; i++) {
    const code = String(ucsValues[i][codeCol]).trim();
    if (!code) continue;
    map[code] = ucsValues[i][longCol];
  }
  return map;
}

function getAreaStockList(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const allAreaOptions = readOptionsColumn('Area_201');
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const isPlanning = isPlanningAreaStaff(login.authorizedArea);
  // PLANNING is a valid Area_201 value (S_201's "Released to Area" dropdown
  // needs it, for a release that stays in Planning's own custody rather
  // than going out to a physical area) but it is not a real area with its
  // own local stock -- computeAreaStockMap_() always excludes it, so it
  // would only ever render here as a permanent, empty "0 of 0" option.
  // Excluded here rather than from Options_List itself, since the 201
  // form's own dropdown reads that same column and still needs the value.
  const availableAreas = (isPlanning ? allAreaOptions : allAreaOptions.filter(function (a) { return myAreas.indexOf(a) !== -1; }))
    .filter(function (a) { return String(a).trim().toUpperCase() !== 'PLANNING'; });
  const requestedArea = String(data.area || '').trim();
  if (!requestedArea) return jsonResponse({ success: true, availableAreas: availableAreas, area: '', items: [] });
  if (availableAreas.indexOf(requestedArea) === -1) return jsonResponse({ success: false, message: 'You are not authorized to view ' + requestedArea + "'s stock." });
  // Only the per-area item list is cached -- availableAreas above is
  // per-user and is always computed fresh from the caller's own login.
  const items = cachedJson_('areaItems_' + encodeURIComponent(requestedArea), 600, function () {
    const longTextMap = getUCSLongTextMap_();
    return getAreaStockMapCached_().filter(function (r) { return r.area === requestedArea; })
      .map(function (r) { return Object.assign({}, r, { longText: longTextMap[r.ucsCode] || '' }); });
  });
  return jsonResponse({ success: true, availableAreas: availableAreas, area: requestedArea, items: items });
}

function getNextDemandAlertSerial_(dateYYYYMMDD) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const idCol = getColIndexOrThrow_(headers, 'Alert_ID', DEMAND_SHEET);
  const prefix = 'DA' + dateYYYYMMDD + '-';
  let maxSerial = 0;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][idCol] || '');
    if (id.indexOf(prefix) === 0) { const serial = parseInt(id.substring(prefix.length), 10); if (!isNaN(serial) && serial > maxSerial) maxSerial = serial; }
  }
  const next = maxSerial + 1;
  if (next > 99) throw new Error('Maximum 99 demand alerts per day reached. Contact the project owner.');
  return prefix + String(next).padStart(2, '0');
}

function submitDemandAlert(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!isAreaInchargeForArea(area, login.authorizedArea, login.role)) return jsonResponse({ success: false, message: 'Only the Area Incharge for ' + area + ' can raise a demand alert for it.' });
  const requestType = String(data.requestType || '').trim();
  if (requestType !== 'Existing UCS Code' && requestType !== 'New Material') return jsonResponse({ success: false, message: 'Request type must be "Existing UCS Code" or "New Material".' });
  const qty = Number(data.estimatedQty);
  if (!Number.isFinite(qty) || qty <= 0) return jsonResponse({ success: false, message: 'Estimated quantity must be a positive number.' });
  const remarks = String(data.remarks || '').trim();
  if (remarks.length > 500) return jsonResponse({ success: false, message: 'Remarks too long (max 500 characters).' });
  let ucsCode = '', itemDescription = '', unit = '';
  if (requestType === 'Existing UCS Code') {
    ucsCode = String(data.ucsCode || '').trim();
    if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required for an existing material.' });
    const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
    const ucsValues = ucsSheet.getDataRange().getValues();
    const ucsHeaders = ucsValues[0];
    const codeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
    const shortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
    const unitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);
    let found = null;
    for (let i = 1; i < ucsValues.length; i++) { if (String(ucsValues[i][codeCol]).trim() === ucsCode) { found = ucsValues[i]; break; } }
    if (!found) return jsonResponse({ success: false, message: 'UCS Code ' + ucsCode + ' not found. Use "New Material" instead if it genuinely does not exist yet.' });
    itemDescription = found[shortCol]; unit = found[unitCol];
  } else {
    itemDescription = String(data.itemDescription || '').trim();
    if (!itemDescription) return jsonResponse({ success: false, message: 'A description is required for a new material.' });
    if (itemDescription.length > 200) return jsonResponse({ success: false, message: 'Description too long (max 200 characters).' });
    unit = '';
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    const alertId = getNextDemandAlertSerial_(formatDateYYYYMMDD_(now));
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
    const headers = readHeaderRow_(sheet);
    const row = new Array(headers.length).fill('');
    row[getColIndexOrThrow_(headers, 'Alert_ID', DEMAND_SHEET)] = alertId;
    row[getColIndexOrThrow_(headers, 'Date_Raised', DEMAND_SHEET)] = now;
    row[getColIndexOrThrow_(headers, 'Area', DEMAND_SHEET)] = area;
    row[getColIndexOrThrow_(headers, 'Raised_By_Name', DEMAND_SHEET)] = login.name;
    row[getColIndexOrThrow_(headers, 'Raised_By_Email', DEMAND_SHEET)] = data.email;
    row[getColIndexOrThrow_(headers, 'Request_Type', DEMAND_SHEET)] = requestType;
    row[getColIndexOrThrow_(headers, 'UCS_Code', DEMAND_SHEET)] = ucsCode;
    row[getColIndexOrThrow_(headers, 'Item_Description', DEMAND_SHEET)] = itemDescription;
    row[getColIndexOrThrow_(headers, 'Unit', DEMAND_SHEET)] = unit;
    row[getColIndexOrThrow_(headers, 'Estimated_Qty', DEMAND_SHEET)] = qty;
    row[getColIndexOrThrow_(headers, 'Remarks', DEMAND_SHEET)] = remarks;
    row[getColIndexOrThrow_(headers, 'Status', DEMAND_SHEET)] = 'Open';
    sheet.appendRow(row);
    const newRow = sheet.getLastRow();
    sheet.getRange(newRow, getColIndexOrThrow_(headers, 'Alert_ID', DEMAND_SHEET) + 1).setNumberFormat('@STRING@');
    if (ucsCode) sheet.getRange(newRow, getColIndexOrThrow_(headers, 'UCS_Code', DEMAND_SHEET) + 1).setNumberFormat('@STRING@');
    logAudit(login.name, data.email, 'SUBMIT_DEMAND_ALERT', 'Alert ' + alertId + ' | Area ' + area + ' | ' + requestType + (ucsCode ? ' | UCS ' + ucsCode : ' | New: ' + itemDescription) + ' | Est. Qty ' + qty + ' ' + unit);

    const demandRaiserEmailLower = String(data.email).trim().toLowerCase();
    getPlanningStaffEmails_().forEach(function (email) {
      if (String(email).trim().toLowerCase() === demandRaiserEmailLower) return;
      sendPushNotification(email, 'Demand alert raised', 'Alert ' + alertId + ' — ' + area, 'demand-dashboard');
    });

    return jsonResponse({ success: true, message: 'Demand alert ' + alertId + ' submitted to Planning.', alertId: alertId });
  } finally {
    lock.releaseLock();
  }
}

function getDemandAlerts(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const col = {};
  headers.forEach(function (h, idx) { col[h] = idx; });
  const statusFilter = String(data.status || 'all').trim();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const alertId = String(row[col['Alert_ID']] || '');
    if (!alertId) continue;
    const status = row[col['Status']] || 'Open';
    if (statusFilter !== 'all' && statusFilter !== status) continue;
    out.push({ alertId: alertId, dateRaised: formatDateOut(row[col['Date_Raised']]), area: row[col['Area']], raisedByName: row[col['Raised_By_Name']], requestType: row[col['Request_Type']], ucsCode: row[col['UCS_Code']], itemDescription: row[col['Item_Description']], unit: row[col['Unit']], estimatedQty: row[col['Estimated_Qty']], remarks: row[col['Remarks']], status: status, planningRemarks: row[col['Planning_Remarks']], lastUpdatedBy: row[col['Last_Updated_By']], lastUpdatedAt: formatDateOut(row[col['Last_Updated_At']]) });
  }
  out.reverse();
  return jsonResponse({ success: true, alerts: out });
}

function updateDemandAlertStatus(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const alertId = String(data.alertId || '').trim();
  const newStatus = String(data.status || '').trim();
  const planningRemarks = String(data.planningRemarks || '').trim();
  const validStatuses = ['Open', 'Acknowledged', 'Actioned', 'Dismissed'];
  if (!alertId) return jsonResponse({ success: false, message: 'Alert ID is required.' });
  if (validStatuses.indexOf(newStatus) === -1) return jsonResponse({ success: false, message: 'Status must be one of: ' + validStatuses.join(', ') });
  if (planningRemarks.length > 500) return jsonResponse({ success: false, message: 'Remarks too long (max 500 characters).' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const idCol = getColIndexOrThrow_(headers, 'Alert_ID', DEMAND_SHEET);
  const statusCol = getColIndexOrThrow_(headers, 'Status', DEMAND_SHEET);
  const planningRemarksCol = getColIndexOrThrow_(headers, 'Planning_Remarks', DEMAND_SHEET);
  const updByCol = getColIndexOrThrow_(headers, 'Last_Updated_By', DEMAND_SHEET);
  const updAtCol = getColIndexOrThrow_(headers, 'Last_Updated_At', DEMAND_SHEET);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === alertId) {
      const rowNum = i + 1;
      writeCells_(sheet, [ // one batched write instead of 4 separate calls
        { row: rowNum, col: statusCol, value: newStatus },
        { row: rowNum, col: planningRemarksCol, value: planningRemarks },
        { row: rowNum, col: updByCol, value: login.name },
        { row: rowNum, col: updAtCol, value: new Date() }
      ]);
      logAudit(login.name, data.email, 'UPDATE_DEMAND_ALERT', 'Alert ' + alertId + ' | Status -> ' + newStatus + (planningRemarks ? ' | Remarks: ' + planningRemarks : ''));

      const demandRaisedByEmail = values[i][headers.indexOf('Raised_By_Email')];
      const demandArea = values[i][headers.indexOf('Area')];
      if (demandRaisedByEmail && String(demandRaisedByEmail).trim().toLowerCase() !== String(data.email).trim().toLowerCase()) {
        sendPushNotification(demandRaisedByEmail, 'Demand alert updated', 'Alert ' + alertId + ' (' + demandArea + ') — ' + newStatus, 'raise-demand-alert');
      }

      return jsonResponse({ success: true, message: 'Alert ' + alertId + ' updated to ' + newStatus + '.' });
    }
  }
  return jsonResponse({ success: false, message: 'Alert ' + alertId + ' not found.' });
}

function getMyDemandAlerts(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const col = {};
  headers.forEach(function (h, idx) { col[h] = idx; });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const alertId = String(row[col['Alert_ID']] || '');
    if (!alertId) continue;
    const area = String(row[col['Area']] || '');
    if (myAreas.indexOf(area) === -1) continue;
    out.push({ alertId: alertId, dateRaised: formatDateOut(row[col['Date_Raised']]), area: area, raisedByName: row[col['Raised_By_Name']], requestType: row[col['Request_Type']], ucsCode: row[col['UCS_Code']], itemDescription: row[col['Item_Description']], unit: row[col['Unit']], estimatedQty: row[col['Estimated_Qty']], remarks: row[col['Remarks']], status: row[col['Status']] || 'Open', planningRemarks: row[col['Planning_Remarks']] });
  }
  out.reverse();
  return jsonResponse({ success: true, alerts: out });
}

// ====== RETURN MODULE (Wrong Material) ======
// See RETURN_MODULE_SPEC.md for the full design writeup. Deliberately
// small: one scenario (material never Locally Issued, drawn in error), a
// 2-stage workflow (Raise by Area Incharge -> Approve by Approver), 4
// doPost actions total. Zero new access-control functions -- reuses
// isAreaInchargeForArea() for Raise and canSanctionRequisition() for
// Approve, both already defined above in the Requisition Module section.

/** 'YYYYMMDD' + 2-digit serial per (Area, Date), same shape as getNextSlipSerial_. */
function getNextReturnSerial_(area, dateYYYYMMDD) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_HEADER_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const idCol = getColIndexOrThrow_(headers, 'Return_ID', RETURN_HEADER_SHEET);
  const prefix = area + 'RET' + dateYYYYMMDD + '-';

  let maxSerial = 0;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][idCol] || '');
    if (id.indexOf(prefix) === 0) {
      const serial = parseInt(id.substring(prefix.length), 10);
      if (!isNaN(serial) && serial > maxSerial) maxSerial = serial;
    }
  }
  const next = maxSerial + 1;
  if (next > 99) {
    throw new Error('Maximum 99 returns per area per day reached for ' + area + ' on ' + dateYYYYMMDD + '.');
  }
  return prefix + String(next).padStart(2, '0');
}

/** All Return_Details rows for a given Return_ID, as { Detail_ID: rowIndex }. */
function getReturnDetailRowIndexesForSlip_(detailsValues, dCol, returnId) {
  const map = {};
  for (let i = 1; i < detailsValues.length; i++) {
    if (String(detailsValues[i][dCol['Return_ID']]) === returnId) {
      map[String(detailsValues[i][dCol['Detail_ID']])] = i;
    }
  }
  return map;
}

/**
 * Header+Details joined, filtered to one Return_Status. Also surfaces the
 * Area's CURRENT stock balance for context (blank for PLANNING -- see
 * RETURN_MODULE_SPEC.md Section 2).
 */
function getReturnRowsByStatus_(status) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const headerSheet = ss.getSheetByName(RETURN_HEADER_SHEET);
  const headerValues = headerSheet.getDataRange().getValues();
  const hHeaders = headerValues[0];
  const hCol = {};
  hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

  const slipInfo = {};
  for (let i = 1; i < headerValues.length; i++) {
    const row = headerValues[i];
    slipInfo[String(row[hCol['Return_ID']])] = {
      area: row[hCol['Area']],
      raisedByName: row[hCol['Raised_By_Name']],
      returnDate: formatDateOut(row[hCol['Return_Date']])
    };
  }

  const detailsSheet = ss.getSheetByName(RETURN_DETAILS_SHEET);
  const detailsValues = detailsSheet.getDataRange().getValues();
  const dHeaders = detailsValues[0];
  const dCol = {};
  dHeaders.forEach(function (h, idx) { dCol[h] = idx; });

  const areaStockList = getAreaStockMapCached_();
  const areaBalanceLookup = {};
  areaStockList.forEach(function (r) { areaBalanceLookup[r.area + '||' + r.ucsCode] = r.qtyBalance; });

  const out = [];
  for (let i = 1; i < detailsValues.length; i++) {
    const row = detailsValues[i];
    if (String(row[dCol['Slip_Status']]) !== status) continue;
    const returnId = String(row[dCol['Return_ID']]);
    const info = slipInfo[returnId] || {};
    const ucsCode = String(row[dCol['UCS_Code']]).trim();
    const isPlanningArea = String(info.area || '').toUpperCase() === 'PLANNING';
    out.push({
      detailId: row[dCol['Detail_ID']],
      returnId: returnId,
      area: info.area || '',
      raisedByName: info.raisedByName || '',
      returnDate: info.returnDate || '',
      ucsCode: row[dCol['UCS_Code']],
      itemDescription: row[dCol['Item_Description']],
      unit: row[dCol['Unit']],
      qtyReturnRequested: row[dCol['Qty_Return_Requested']],
      qtyApproved: row[dCol['Qty_Approved']],
      reason: row[dCol['Reason']],
      currentAreaBalance: isPlanningArea ? '' : (areaBalanceLookup[info.area + '||' + ucsCode] || 0)
    });
  }
  return out;
}

/** data: { email, password, area, items: [{ ucsCode, qty, reason }] } */
function raiseReturn(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!isAreaInchargeForArea(area, login.authorizedArea, login.role)) {
    return jsonResponse({ success: false, message: 'Only the Area Incharge for ' + area + ' can raise a return.' });
  }
  const validAreas = readOptionsColumn('Area_201');
  if (validAreas.indexOf(area) === -1) {
    return jsonResponse({ success: false, message: 'Unknown area: ' + area });
  }

  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'At least one material line is required.' });
  if (items.length > 10) return jsonResponse({ success: false, message: 'A return cannot have more than 10 materials.' });

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);

  const resolvedItems = [];
  for (let i = 0; i < items.length; i++) {
    const ucsCode = String(items[i].ucsCode || '').trim();
    const qty = Number(items[i].qty);
    const reason = String(items[i].reason || '').trim();

    if (!ucsCode) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': UCS Code is required.' });
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': Quantity must be a positive whole number.' });
    }
    if (!reason) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': Reason is required.' });
    if (reason.length > 500) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': Reason is too long (max 500 characters).' });

    let found = null;
    for (let r = 1; r < ucsValues.length; r++) {
      if (String(ucsValues[r][ucsCodeCol]).trim() === ucsCode) { found = ucsValues[r]; break; }
    }
    if (!found) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': UCS Code ' + ucsCode + ' not found.' });

    resolvedItems.push({ ucsCode: ucsCode, itemDescription: found[ucsShortCol], unit: found[ucsUnitCol], qty: qty, reason: reason });
  }

  // Stock-cap enforcement + creation together under one lock -- same
  // race-closing reasoning as raiseRequisition. Skipped for Area = PLANNING
  // (RETURN_MODULE_SPEC.md Section 2 -- no trackable "currently held" number
  // exists there). This is early feedback only -- approveReturn() re-checks
  // fresh before it actually commits the balance change.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (area.toUpperCase() !== 'PLANNING') {
      const areaStockList = computeAreaStockMap_();
      const balanceLookup = {};
      areaStockList.forEach(function (r) { balanceLookup[r.area + '||' + r.ucsCode] = r.qtyBalance; });

      const neededByCode = {};
      resolvedItems.forEach(function (it) { neededByCode[it.ucsCode] = (neededByCode[it.ucsCode] || 0) + it.qty; });
      for (const code in neededByCode) {
        const available = balanceLookup[area + '||' + code] || 0;
        if (neededByCode[code] > available) {
          return jsonResponse({
            success: false,
            message: code + ': only ' + available + ' currently shown in ' + area + "'s stock -- cannot return " + neededByCode[code] + '.'
          });
        }
      }
    }

    const now = new Date();
    const dateStr = formatDateYYYYMMDD_(now);
    const returnId = getNextReturnSerial_(area, dateStr);

    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_HEADER_SHEET);
    const headerHeaders = readHeaderRow_(headerSheet);
    const headerRow = new Array(headerHeaders.length).fill('');
    headerRow[getColIndexOrThrow_(headerHeaders, 'Return_ID', RETURN_HEADER_SHEET)] = returnId;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Return_Date', RETURN_HEADER_SHEET)] = now;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Area', RETURN_HEADER_SHEET)] = area;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_By_Name', RETURN_HEADER_SHEET)] = login.name;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_By_Email', RETURN_HEADER_SHEET)] = data.email;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Raised_Timestamp', RETURN_HEADER_SHEET)] = now;
    headerRow[getColIndexOrThrow_(headerHeaders, 'Return_Status', RETURN_HEADER_SHEET)] = 'Pending Approval';
    headerRow[getColIndexOrThrow_(headerHeaders, 'Material_Count', RETURN_HEADER_SHEET)] = resolvedItems.length;
    headerSheet.appendRow(headerRow);
    headerSheet.getRange(headerSheet.getLastRow(), getColIndexOrThrow_(headerHeaders, 'Return_ID', RETURN_HEADER_SHEET) + 1).setNumberFormat('@STRING@');

    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_DETAILS_SHEET);
    const detailsHeaders = readHeaderRow_(detailsSheet);

    const newDetailRows = [];
    resolvedItems.forEach(function (item, idx) {
      const row = new Array(detailsHeaders.length).fill('');
      row[getColIndexOrThrow_(detailsHeaders, 'Detail_ID', RETURN_DETAILS_SHEET)] = Utilities.getUuid().substring(0, 8);
      row[getColIndexOrThrow_(detailsHeaders, 'Return_ID', RETURN_DETAILS_SHEET)] = returnId;
      row[getColIndexOrThrow_(detailsHeaders, 'Line_No', RETURN_DETAILS_SHEET)] = idx + 1;
      row[getColIndexOrThrow_(detailsHeaders, 'UCS_Code', RETURN_DETAILS_SHEET)] = item.ucsCode;
      row[getColIndexOrThrow_(detailsHeaders, 'Item_Description', RETURN_DETAILS_SHEET)] = item.itemDescription;
      row[getColIndexOrThrow_(detailsHeaders, 'Unit', RETURN_DETAILS_SHEET)] = item.unit;
      row[getColIndexOrThrow_(detailsHeaders, 'Qty_Return_Requested', RETURN_DETAILS_SHEET)] = item.qty;
      row[getColIndexOrThrow_(detailsHeaders, 'Reason', RETURN_DETAILS_SHEET)] = item.reason;
      row[getColIndexOrThrow_(detailsHeaders, 'Slip_Status', RETURN_DETAILS_SHEET)] = 'Pending Approval';
      newDetailRows.push(row);
    });
    appendRows_(detailsSheet, newDetailRows, [getColIndexOrThrow_(detailsHeaders, 'Return_ID', RETURN_DETAILS_SHEET), getColIndexOrThrow_(detailsHeaders, 'UCS_Code', RETURN_DETAILS_SHEET)]);

    logAudit(login.name, data.email, 'RAISE_RETURN',
      'Return ' + returnId + ' | Area ' + area + ' | ' + resolvedItems.length + ' item(s): ' +
      resolvedItems.map(function (it) { return it.ucsCode + ' x' + it.qty; }).join(', '));

    const returnRaiserEmailLower = String(data.email).trim().toLowerCase();
    getApproverEmails_().forEach(function (email) {
      if (String(email).trim().toLowerCase() === returnRaiserEmailLower) return;
      sendPushNotification(email, 'Return pending approval', 'Return ' + returnId + ' — ' + area, 'return-approval-dashboard');
    });

    return jsonResponse({ success: true, message: 'Return ' + returnId + ' raised, pending Approver action.', returnId: returnId });
  } finally {
    lock.releaseLock();
  }
}

function getPendingReturnApprovals(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  if (!canSanctionRequisition(check.login.role)) {
    return jsonResponse({ success: false, message: 'Only Approvers can view pending returns.' });
  }
  return jsonResponse({ success: true, items: getReturnRowsByStatus_('Pending Approval') });
}

/**
 * data: { email, password, returnId, items: [{ detailId, qtyApproved }] }
 * Global role, NOT area-scoped. MUST include every item on the return.
 * This single action both approves AND completes -- material is considered
 * back in Planning custody the moment this succeeds; physical handover is
 * the Area Incharge/Approver's own responsibility, not tracked as a
 * separate system step (RETURN_MODULE_SPEC.md Section 0).
 */
function approveReturn(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!canSanctionRequisition(login.role)) {
    return jsonResponse({ success: false, message: 'Only Approvers can approve returns.' });
  }

  const returnId = String(data.returnId || '').trim();
  if (!returnId) return jsonResponse({ success: false, message: 'Return_ID is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to approve.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) {
      if (String(headerValues[i][hCol['Return_ID']]) === returnId) { headerRowIdx = i; break; }
    }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Return ' + returnId + ' not found.' });
    const area = headerValues[headerRowIdx][hCol['Area']];
    const currentStatus = headerValues[headerRowIdx][hCol['Return_Status']];
    if (currentStatus !== 'Pending Approval') {
      return jsonResponse({ success: false, message: 'Return ' + returnId + ' is no longer pending approval (current status: ' + currentStatus + ').' });
    }

    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getReturnDetailRowIndexesForSlip_(detailsValues, dCol, returnId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) {
      return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on return ' + returnId + ' at once.' });
    }

    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtyApproved = Number(items[k].qtyApproved);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on return ' + returnId + '.' });
      const requested = Number(detailsValues[rowIdx][dCol['Qty_Return_Requested']]);
      if (!Number.isFinite(qtyApproved) || qtyApproved < 0 || !Number.isInteger(qtyApproved)) {
        return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' must be zero or a positive whole number.' });
      }
      if (qtyApproved > requested) {
        return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' (' + qtyApproved + ') cannot exceed requested qty (' + requested + ').' });
      }
      writes.push({ rowIdx: rowIdx, qtyApproved: qtyApproved, ucsCode: detailsValues[rowIdx][dCol['UCS_Code']] });
    }

    // Fresh re-check, fresh data, inside this same lock -- stock may have
    // moved since Raise (e.g. a Local Issue could have consumed it in the
    // meantime). Skipped for PLANNING, same as at Raise.
    if (String(area).toUpperCase() !== 'PLANNING') {
      const areaStockList = computeAreaStockMap_();
      const balanceLookup = {};
      areaStockList.forEach(function (r) { balanceLookup[r.area + '||' + r.ucsCode] = r.qtyBalance; });
      const neededByCode = {};
      writes.forEach(function (w) { neededByCode[w.ucsCode] = (neededByCode[w.ucsCode] || 0) + w.qtyApproved; });
      for (const code in neededByCode) {
        const available = balanceLookup[area + '||' + code] || 0;
        if (neededByCode[code] > available) {
          return jsonResponse({
            success: false,
            message: code + ': only ' + available + ' currently shown in ' + area + "'s stock -- cannot approve a return of " + neededByCode[code] +
              '. Stock may have moved since this was raised; refresh and try again.'
          });
        }
      }
    }

    const cells = [];
    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      cells.push({ row: sheetRow, col: dCol['Qty_Approved'], value: w.qtyApproved });
      cells.push({ row: sheetRow, col: dCol['Approved_By'], value: login.name });
      cells.push({ row: sheetRow, col: dCol['Approved_Timestamp'], value: now });
      cells.push({ row: sheetRow, col: dCol['Slip_Status'], value: 'Completed' });
    });
    writeCells_(detailsSheet, cells);
    headerSheet.getRange(headerRowIdx + 1, hCol['Return_Status'] + 1).setValue('Completed');

    logAudit(login.name, data.email, 'APPROVE_RETURN',
      'Return ' + returnId + ' | Area ' + area + ' | ' + writes.length + ' item(s): ' +
      writes.map(function (w) { return w.ucsCode + ' x' + w.qtyApproved; }).join(', '));

    const returnRaisedByEmail = headerValues[headerRowIdx][hCol['Raised_By_Email']];
    const returnApproverEmailLower = String(data.email).trim().toLowerCase();
    if (returnRaisedByEmail && String(returnRaisedByEmail).trim().toLowerCase() !== returnApproverEmailLower) {
      sendPushNotification(returnRaisedByEmail, 'Return approved', 'Return ' + returnId + ' — ' + area, 'raise-return');
    }
    // The material now physically needs to go back onto the shelf/rack --
    // that's a Store Incharge action, same role that physically hands
    // material out on a normal Issue.
    getStoreInchargeEmails_().forEach(function (email) {
      if (String(email).trim().toLowerCase() === returnApproverEmailLower) return;
      sendPushNotification(email, 'Return to shelve', 'Return ' + returnId + ' — ' + area);
    });

    // Snapshot refresh (PLNG_STOCK / AREA_STOCK) intentionally NOT triggered
    // here -- matches the rest of this app: nothing in the web app reads
    // those sheets live (every dashboard recomputes fresh via
    // computePlanningStockMap_/computeAreaStockMap_), so this was pure
    // latency for zero benefit. The 30-minute timer trigger and each
    // dashboard's manual Refresh button still keep the snapshots current.

    return jsonResponse({ success: true, message: 'Return ' + returnId + ' approved. Material is back in Planning inventory -- confirm physical handover with ' + area + '.' });
  } finally {
    lock.releaseLock();
  }
}

/** Same area-membership filter shape as getAreaRequisitions. */
function getAreaReturns(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (myAreas.length === 0) return jsonResponse({ success: true, items: [] });

  const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_HEADER_SHEET);
  const headerValues = headerSheet.getDataRange().getValues();
  const hHeaders = headerValues[0];
  const hCol = {};
  hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

  const slipInfo = {};
  for (let i = 1; i < headerValues.length; i++) {
    const area = headerValues[i][hCol['Area']];
    if (myAreas.indexOf(area) === -1) continue;
    const returnId = String(headerValues[i][hCol['Return_ID']]);
    slipInfo[returnId] = {
      area: area,
      returnDate: formatDateOut(headerValues[i][hCol['Return_Date']]),
      raisedByName: headerValues[i][hCol['Raised_By_Name']]
    };
  }

  const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RETURN_DETAILS_SHEET);
  const detailsValues = detailsSheet.getDataRange().getValues();
  const dHeaders = detailsValues[0];
  const dCol = {};
  dHeaders.forEach(function (h, idx) { dCol[h] = idx; });

  const items = [];
  for (let i = 1; i < detailsValues.length; i++) {
    const row = detailsValues[i];
    const returnId = String(row[dCol['Return_ID']]);
    const info = slipInfo[returnId];
    if (!info) continue;
    items.push({
      returnId: returnId,
      area: info.area,
      returnDate: info.returnDate,
      raisedByName: info.raisedByName,
      ucsCode: row[dCol['UCS_Code']],
      itemDescription: row[dCol['Item_Description']],
      unit: row[dCol['Unit']],
      qtyReturnRequested: row[dCol['Qty_Return_Requested']],
      qtyApproved: row[dCol['Qty_Approved']],
      reason: row[dCol['Reason']],
      status: row[dCol['Slip_Status']]
    });
  }
  return jsonResponse({ success: true, items: items });
}


// =====================================================================
// ====== VENDOR FINDER (Phase 3, Feature 2) ======
// =====================================================================
// READ-ONLY. "Which vendors have supplied these items before?" -- for
// calling budgetary offers. Two actions, both Planning staff excluding
// Store Incharge (requireSTOAccess), both named get* so doPost treats them
// as cache-neutral:
//   getPastVendors          -- vendors who supplied any of up to 25 UCS Codes
//   getVendorSupplyHistory  -- everything one vendor has ever supplied
//
// DATA SOURCES -- both tabs live in the SAME external "SMS3E PRs"
// spreadsheet (PO_PR_SHEET_ID) that the Procurement Dashboard already reads:
//   - "Material List": only rows with a PO No. and a numeric V Code count,
//     and only black-font rows (same dummy-row rule as getPRPODashboardData,
//     checked on the PR No. column).
//   - "Vendor": contact details, currency, status. Read by HEADER NAME, so
//     columns can be reordered or added freely; a missing column just reads
//     blank (Notes / Other_Names_Seen are optional). Status is matched
//     case-insensitively: Active (or blank) / Blocked / Blacklisted / Check.
//     Email and Mobile cells may hold several values separated by commas,
//     semicolons or spaces -- the page splits them. If the tab is missing,
//     results still work, just without contact details.
//
// PERFORMANCE: both tabs are read in ONE openById() call and cached together
// for 10 minutes (external sheet -- no write in this app can signal a change,
// same TTL-only approach as the PR/PO dashboard). The page's "Refresh data"
// link passes refresh:true to rebuild immediately, e.g. right after someone
// adds emails in the Vendor tab. Nothing here runs unless someone opens
// Vendor Finder, so it adds no load to any other page.
const VENDOR_TAB_NAME = 'Vendor';
const VENDOR_FINDER_MAX_CODES = 25;
const VENDOR_FINDER_ALLOWED_YEARS = [0, 1, 2, 3, 5, 10]; // 0 = all history
const VENDOR_BUNDLE_CACHE_KEY = 'vfBundle_v3'; // bump whenever the bundle's shape/cleaning changes, so an old cached copy is never served
const ML_LITE_CACHE_KEY = 'mlLite_v1';
const VENDOR_BUNDLE_TTL_SECONDS = 600; // both caches share this TTL -- they are always built together
const VENDOR_HISTORY_MAX_ROWS = 500;

// Compact copy of Material List used by every PR/PO drill-down in the app
// (Planning Stock's PO & PR tab and PR/PO panels, Vendor Finder's PO/PR
// panels). Built in the SAME external-sheet read as the vendor bundle, so
// one openById() every 10 minutes serves all of them. Rows keep the exact
// raw values the old per-click readers returned (all rows, same header
// columns: "Qty" = the LAST "Qty" column i.e. PO-line qty, "PO Dt", "105_Dt", "V Code", "V Name").
const MLL = { CODE: 0, PR_NO: 1, PO_NO: 2, PO_DATE: 3, PO_MS: 4, QTY: 5, RCPT_DATE: 6, RCPT_MS: 7, V_CODE: 8, V_NAME: 9 };

// Compact row layout inside the cached bundle (arrays, not objects, to keep
// the cached JSON small).
const VFI = { CODE: 0, VCODE: 1, VNAME: 2, PO_NO: 3, PO_DT: 4, PO_QTY: 5, RATE: 6, QTY105: 7, DT105: 8, DUE: 9 };

// Vendor tab header -> field name sent to the page.
const VENDOR_TAB_FIELDS_ = {
  vendorName: 'V_Name', otherNames: 'Other_Names_Seen', vendorType: 'Vendor_Type', country: 'Country',
  currency: 'Currency', address: 'Address', city: 'City', state: 'State', pin: 'PIN',
  contactPerson: 'Contact_Person', designation: 'Designation', email: 'Email', altEmail: 'Alt_Email',
  mobile: 'Mobile', landline: 'Landline', gstin: 'GSTIN', status: 'Status', notes: 'Notes'
};

/** Number from a cell that may be a number or a "5,248.98"-style string. */
function vfNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, '').trim());
  return isFinite(n) ? n : 0;
}

/** Midnight Date from a real Date cell, or from a dd-mm-yy / dd-mm-yyyy string. Null otherwise. */
function vfDate_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  const m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/.exec(String(v).trim());
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return (d.getMonth() === Number(m[2]) - 1) ? d : null;
}

function vfIsBlackFont_(color) {
  if (!color) return true; // blank = Sheets default = black
  return String(color).toLowerCase() === '#000000';
}

function vfDateOut_(ms) {
  return ms > 0 ? formatDateOut(new Date(ms)) : '';
}

/**
 * Vendor-tab cell -> clean text. The tab was built from an SAP HTML export,
 * which fills Address/City with non-breaking spaces (&nbsp;); left as-is they
 * leak into copied emails, CSV exports and mailto links. Collapses every run
 * of whitespace (incl. U+00A0) to one normal space.
 */
function vfClean_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * Status is typed by hand, so match it case-insensitively: "active",
 * "ACTIVE " etc. all mean Active. Blank = Active. Anything unrecognised is
 * kept as typed and treated as "not Active" (greyed out, unticked).
 */
function vfStatus_(v) {
  const s = vfClean_(v).toLowerCase();
  if (!s || s === 'active') return 'Active';
  if (s === 'blocked') return 'Blocked';
  if (s === 'blacklisted') return 'Blacklisted';
  if (s === 'check') return 'Check';
  return vfClean_(v);
}

/**
 * ONE read of the external SMS3E PRs sheet builds and caches BOTH:
 *   - the vendor bundle (Vendor Finder), and
 *   - the compact Material List copy (every PR/PO drill-down in the app).
 * Called only on a cache miss (at most once per 10 minutes per cache), or
 * when someone clicks "refresh now" in Vendor Finder.
 */
function buildMaterialListCaches_() {
  const ext = SpreadsheetApp.openById(PO_PR_SHEET_ID);
  const builtAt = Date.now();
  const mlSheet = ext.getSheetByName(PO_PR_TAB_NAME);
  const values = mlSheet ? mlSheet.getDataRange().getValues() : [];

  // ---- compact copy for PR/PO drill-downs (all rows, no font filter -- same as the old readers) ----
  const lite = { rows: [], tabMissing: !mlSheet, error: null, builtAt: builtAt };
  if (mlSheet && values.length >= 2) {
    const col = {};
    values[0].forEach(function (hd, idx) { col[String(hd).trim()] = idx; }); // LAST match wins on a repeated header (so "Qty" = the PO-line Qty) -- exactly what the old per-click readers did
    const required = ['Mat Code', 'PR No.', 'PO No.', 'PO Dt', 'Qty', '105_Dt', 'V Code', 'V Name'];
    const missing = required.filter(function (c) { return !(c in col); });
    if (missing.length) {
      lite.error = 'PO&PR sheet is missing expected column: "' + missing[0] + '"';
    } else {
      for (let i = 1; i < values.length; i++) {
        const r = values[i];
        const poMid = toMidnight(r[col['PO Dt']]);
        const rcMid = toMidnight(r[col['105_Dt']]);
        lite.rows.push([
          String(r[col['Mat Code']]).trim(), r[col['PR No.']], r[col['PO No.']],
          formatDateOut(r[col['PO Dt']]), poMid ? poMid.getTime() : null,
          Number(r[col['Qty']]) || 0,
          formatDateOut(r[col['105_Dt']]), rcMid ? rcMid.getTime() : null,
          r[col['V Code']], r[col['V Name']]
        ]);
      }
    }
  }

  // ---- vendor bundle ----
  const rows = [];
  const descByCode = {};
  if (mlSheet && values.length >= 2) {
    const fonts = mlSheet.getRange(2, ML_COL.PR_NO + 1, values.length - 1, 1).getFontColors(); // one batch call
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (!vfIsBlackFont_(fonts[i - 1][0])) continue; // dummy/masked row
      const code = String(r[ML_COL.MAT_CODE]).trim();
      const vCode = String(r[ML_COL.V_CODE]).trim().replace(/\.0+$/, '');
      const poNo = String(r[ML_COL.PO_NO]).trim();
      if (!code || !poNo || !/^\d+$/.test(vCode)) continue; // no PO / no vendor yet
      if (!descByCode[code]) descByCode[code] = String(r[ML_COL.DESCRIPTION] || '').trim();
      const poDt = vfDate_(r[ML_COL.PO_DT]);
      const dt105 = vfDate_(r[ML_COL.DT_105]);
      const due = vfDate_(r[ML_COL.ALT_DP]) || vfDate_(r[ML_COL.PO_DP]); // renegotiated date wins, same priority as the dashboard
      let poQty = vfNum_(r[ML_COL.PO_QTY]);
      if (!poQty) poQty = vfNum_(r[ML_COL.PO_LINE_QTY]);
      rows.push([
        code, vCode, String(r[ML_COL.V_NAME] || '').trim(), poNo,
        poDt ? poDt.getTime() : 0, poQty, vfNum_(r[ML_COL.PO_RATE]), vfNum_(r[ML_COL.QTY_105]),
        dt105 ? dt105.getTime() : 0, due ? due.getTime() : 0
      ]);
    }
  }

  const vendors = {};
  let vendorTabMissing = false;
  const vSheet = ext.getSheetByName(VENDOR_TAB_NAME);
  if (!vSheet) {
    vendorTabMissing = true;
  } else {
    const vValues = vSheet.getDataRange().getValues();
    if (vValues.length >= 1) {
      const headers = vValues[0].map(function (h) { return String(h).trim(); });
      const vcCol = headers.indexOf('V_Code');
      if (vcCol === -1) throw new Error('The "' + VENDOR_TAB_NAME + '" tab is missing its "V_Code" column. Check the header row spelling.');
      const colOf = {};
      Object.keys(VENDOR_TAB_FIELDS_).forEach(function (k) { colOf[k] = headers.indexOf(VENDOR_TAB_FIELDS_[k]); });
      for (let i = 1; i < vValues.length; i++) {
        const code = vfClean_(vValues[i][vcCol]).replace(/\.0+$/, '');
        if (!code) continue;
        const o = {};
        Object.keys(colOf).forEach(function (k) {
          const c = colOf[k];
          const v = c === -1 ? '' : vfClean_(vValues[i][c]);
          if (v) o[k] = v; // PERFORMANCE: empty fields not stored -- keeps the cached copy small; vfContact_ fills them back in
        });
        o.status = vfStatus_(o.status);
        vendors[code] = o;
      }
    }
  }
  const bundle = { rows: rows, descByCode: descByCode, vendors: vendors, vendorTabMissing: vendorTabMissing, mlTabMissing: !mlSheet, builtAt: builtAt };

  putCachedString_(ML_LITE_CACHE_KEY, JSON.stringify(lite), VENDOR_BUNDLE_TTL_SECONDS);
  putCachedString_(VENDOR_BUNDLE_CACHE_KEY, JSON.stringify(bundle), VENDOR_BUNDLE_TTL_SECONDS);
  return { bundle: bundle, lite: lite };
}

function getVendorBundle_(forceFresh) {
  let bundle = null;
  if (!forceFresh) {
    const hit = getCachedString_(VENDOR_BUNDLE_CACHE_KEY);
    if (hit !== null) { try { bundle = JSON.parse(hit); } catch (e) { bundle = null; } }
  }
  if (!bundle) bundle = buildMaterialListCaches_().bundle;
  if (bundle.mlTabMissing) throw new Error('Tab "' + PO_PR_TAB_NAME + '" not found in the PO/PR sheet.');
  return bundle;
}

function getMaterialListLite_(forceFresh) {
  if (!forceFresh) {
    const hit = getCachedString_(ML_LITE_CACHE_KEY);
    if (hit !== null) { try { return JSON.parse(hit); } catch (e) { /* rebuild below */ } }
  }
  return buildMaterialListCaches_().lite;
}

/**
 * Called by Vendor Finder the moment the page opens, in the background.
 * Two jobs in one round trip:
 *   1. Builds the caches while the user is still picking items, so the
 *      first "Find vendors" (and every PR/PO click) is served from cache.
 *   2. Returns the compact vendor list that powers "Search by vendor"
 *      (name, part of a name, or vendor code) -- searched on the phone, so
 *      typing never waits on the server.
 * The list = every vendor with at least one PO line in Material List, plus
 * any extra vendors listed only in the Vendor tab.
 */
function getVendorFinderWarmup(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  try {
    const cache = CacheService.getScriptCache();
    if (!cache.get(ML_LITE_CACHE_KEY + '_n')) buildMaterialListCaches_(); // both caches are built together
    const bundle = getVendorBundle_(false);
    getUCSShortTextMap_(); // warm this one too

    const agg = {};
    bundle.rows.forEach(function (r) {
      const vc = r[VFI.VCODE];
      let a = agg[vc];
      if (!a) a = agg[vc] = { name: r[VFI.VNAME], pos: {}, items: {}, lastPoMs: 0 };
      a.pos[r[VFI.PO_NO]] = true;
      a.items[r[VFI.CODE]] = true;
      if (r[VFI.PO_DT] > a.lastPoMs) { a.lastPoMs = r[VFI.PO_DT]; if (r[VFI.VNAME]) a.name = r[VFI.VNAME]; }
    });
    const codes = {};
    Object.keys(agg).forEach(function (vc) { codes[vc] = true; });
    Object.keys(bundle.vendors).forEach(function (vc) { codes[vc] = true; });
    const vendors = Object.keys(codes).map(function (vc) {
      const m = bundle.vendors[vc] || null;
      const a = agg[vc] || null;
      return {
        vendorCode: vc,
        vendorName: (m && m.vendorName) || (a && a.name) || vc,
        city: (m && m.city) || '',
        vendorType: (m && m.vendorType) || '',
        currency: (m && m.currency) || '',
        status: m ? m.status : 'Unknown',
        poCount: a ? Object.keys(a.pos).length : 0,
        itemCount: a ? Object.keys(a.items).length : 0,
        lastPoDate: a ? vfDateOut_(a.lastPoMs) : ''
      };
    });
    vendors.sort(function (x, y) { return String(x.vendorName).localeCompare(String(y.vendorName)); });
    return jsonResponse({ success: true, vendors: vendors, dataAsOfMs: bundle.builtAt });
  } catch (e) {
    return jsonResponse({ success: false, message: e.message });
  }
}

function vfContact_(m) {
  if (!m) return null;
  const out = {};
  Object.keys(VENDOR_TAB_FIELDS_).forEach(function (k) { if (k !== 'vendorName') out[k] = m[k] || ''; });
  return out;
}

/**
 * data: { email, password, ucsCodes: [up to 25 x 14-digit strings], sinceYears: 0|1|2|3|5|10, refresh?: true }
 * One entry per vendor who has a PO line for ANY of the codes, with
 * per-item detail so the page can draw the coverage matrix.
 */
function getPastVendors(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const raw = Array.isArray(data.ucsCodes) ? data.ucsCodes : null;
  if (!raw || raw.length === 0) return jsonResponse({ success: false, message: 'Add at least one item to your list first.' });
  if (raw.length > VENDOR_FINDER_MAX_CODES) return jsonResponse({ success: false, message: 'You can search at most ' + VENDOR_FINDER_MAX_CODES + ' items at a time.' });

  const codes = [];
  const seen = {};
  for (let i = 0; i < raw.length; i++) {
    const c = String(raw[i] === null || raw[i] === undefined ? '' : raw[i]).trim();
    if (!/^[1-9]\d{13}$/.test(c)) return jsonResponse({ success: false, message: '"' + c.substring(0, 20) + '" is not a valid 14-digit UCS Code.' });
    if (!seen[c]) { seen[c] = true; codes.push(c); }
  }

  const sinceYears = (data.sinceYears === undefined || data.sinceYears === null || data.sinceYears === '') ? 0 : Number(data.sinceYears);
  if (VENDOR_FINDER_ALLOWED_YEARS.indexOf(sinceYears) === -1) return jsonResponse({ success: false, message: 'Invalid time period.' });
  let cutoffMs = 0;
  if (sinceYears > 0) {
    const t = startOfToday();
    cutoffMs = new Date(t.getFullYear() - sinceYears, t.getMonth(), t.getDate()).getTime();
  }

  try {
    const bundle = getVendorBundle_(data.refresh === true);
    const shortMap = getUCSShortTextMap_();
    const vendors = {};
    const itemsWithHistory = {};

    bundle.rows.forEach(function (r) {
      const code = r[VFI.CODE];
      if (!seen[code]) return;
      const poMs = r[VFI.PO_DT];
      if (cutoffMs && (!poMs || poMs < cutoffMs)) return;

      const vc = r[VFI.VCODE];
      let v = vendors[vc];
      if (!v) v = vendors[vc] = { mlName: r[VFI.VNAME], pos: {}, items: {}, lastPoMs: 0, onTime: 0, judged: 0, openLines: 0 };
      v.pos[r[VFI.PO_NO]] = true;
      if (poMs > v.lastPoMs) { v.lastPoMs = poMs; if (r[VFI.VNAME]) v.mlName = r[VFI.VNAME]; }

      let it = v.items[code];
      if (!it) it = v.items[code] = { pos: {}, totalQty: 0, lastPoMs: -1, lastRate: 0, lastPoNo: '' };
      it.pos[r[VFI.PO_NO]] = true;
      it.totalQty += r[VFI.PO_QTY];
      if (poMs >= it.lastPoMs) { it.lastPoMs = poMs; it.lastRate = r[VFI.RATE]; it.lastPoNo = r[VFI.PO_NO]; }

      const received = r[VFI.PO_QTY] > 0 && r[VFI.QTY105] >= r[VFI.PO_QTY];
      if (received) {
        if (r[VFI.DT105] && r[VFI.DUE]) { v.judged++; if (r[VFI.DT105] <= r[VFI.DUE]) v.onTime++; }
      } else {
        v.openLines++;
      }
      itemsWithHistory[code] = true;
    });

    const out = Object.keys(vendors).map(function (vc) {
      const v = vendors[vc];
      const m = bundle.vendors[vc] || null;
      const perItem = {};
      Object.keys(v.items).forEach(function (c) {
        const it = v.items[c];
        perItem[c] = { poCount: Object.keys(it.pos).length, totalQty: it.totalQty, lastPoDate: vfDateOut_(it.lastPoMs), lastRate: it.lastRate, lastPoNo: it.lastPoNo };
      });
      return {
        vendorCode: vc,
        vendorName: (m && m.vendorName) || v.mlName || vc,
        inMaster: !!m,
        status: m ? m.status : 'Unknown',
        contact: vfContact_(m),
        itemCount: Object.keys(v.items).length,
        poCount: Object.keys(v.pos).length,
        lastPoDate: vfDateOut_(v.lastPoMs),
        lastPoMs_: v.lastPoMs,
        onTimePct: v.judged ? Math.round(100 * v.onTime / v.judged) : null,
        onTimeJudged: v.judged,
        openLines: v.openLines,
        perItem: perItem
      };
    });

    // Most items covered first; within that, contactable (Active/Unknown)
    // before Blocked/Check; then most recent supplier first.
    function statusRank(s) { return (s === 'Active' || s === 'Unknown') ? 0 : 1; }
    out.sort(function (a, b) {
      if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount;
      if (statusRank(a.status) !== statusRank(b.status)) return statusRank(a.status) - statusRank(b.status);
      return b.lastPoMs_ - a.lastPoMs_;
    });
    out.forEach(function (v) { delete v.lastPoMs_; });

    const items = codes.map(function (c) {
      return { ucsCode: c, shortText: shortMap[c] || bundle.descByCode[c] || '', hasHistory: !!itemsWithHistory[c] };
    });

    return jsonResponse({
      success: true, items: items, vendors: out, sinceYears: sinceYears,
      vendorTabMissing: !!bundle.vendorTabMissing, dataAsOfMs: bundle.builtAt
    });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Could not load vendor history: ' + e.message });
  }
}

/** data: { email, password, vendorCode } -- every PO line for one vendor, newest first. */
function getVendorSupplyHistory(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const vc = String(data.vendorCode || '').trim();
  if (!/^\d{6,12}$/.test(vc)) return jsonResponse({ success: false, message: 'Invalid vendor code.' });

  try {
    const bundle = getVendorBundle_(false);
    const shortMap = getUCSShortTextMap_();
    const m = bundle.vendors[vc] || null;

    const matched = bundle.rows.filter(function (r) { return r[VFI.VCODE] === vc; });
    matched.sort(function (a, b) { return b[VFI.PO_DT] - a[VFI.PO_DT]; });

    let mlName = '';
    const pos = {}, codes = {};
    let onTime = 0, judged = 0;
    matched.forEach(function (r) {
      if (!mlName && r[VFI.VNAME]) mlName = r[VFI.VNAME];
      pos[r[VFI.PO_NO]] = true;
      codes[r[VFI.CODE]] = true;
      const received = r[VFI.PO_QTY] > 0 && r[VFI.QTY105] >= r[VFI.PO_QTY];
      if (received && r[VFI.DT105] && r[VFI.DUE]) { judged++; if (r[VFI.DT105] <= r[VFI.DUE]) onTime++; }
    });

    const rows = matched.slice(0, VENDOR_HISTORY_MAX_ROWS).map(function (r) {
      const received = r[VFI.PO_QTY] > 0 && r[VFI.QTY105] >= r[VFI.PO_QTY];
      let delivery = 'Open';
      if (received) {
        if (r[VFI.DT105] && r[VFI.DUE]) delivery = r[VFI.DT105] <= r[VFI.DUE] ? 'On time' : 'Late';
        else delivery = 'Received';
      } else if (r[VFI.QTY105] > 0) {
        delivery = 'Partial';
      }
      return {
        ucsCode: r[VFI.CODE],
        shortText: shortMap[r[VFI.CODE]] || bundle.descByCode[r[VFI.CODE]] || '',
        poNo: r[VFI.PO_NO],
        poDate: vfDateOut_(r[VFI.PO_DT]),
        poQty: r[VFI.PO_QTY],
        rate: r[VFI.RATE],
        qty105: r[VFI.QTY105],
        receiptDate: vfDateOut_(r[VFI.DT105]),
        dueDate: vfDateOut_(r[VFI.DUE]),
        delivery: delivery
      };
    });

    return jsonResponse({
      success: true,
      vendorCode: vc,
      vendorName: (m && m.vendorName) || mlName || vc,
      inMaster: !!m,
      status: m ? m.status : 'Unknown',
      contact: vfContact_(m),
      vendorTabMissing: !!bundle.vendorTabMissing,
      summary: {
        poCount: Object.keys(pos).length,
        itemCount: Object.keys(codes).length,
        lineCount: matched.length,
        lastPoDate: matched.length ? vfDateOut_(matched[0][VFI.PO_DT]) : '',
        onTimePct: judged ? Math.round(100 * onTime / judged) : null,
        onTimeJudged: judged
      },
      rows: rows,
      truncated: matched.length > VENDOR_HISTORY_MAX_ROWS
    });
  } catch (e) {
    return jsonResponse({ success: false, message: 'Could not load vendor history: ' + e.message });
  }
}


function onOpen() {
  SpreadsheetApp.getUi().createMenu('Planning Stock').addItem('🔄 Refresh Planning Stock', 'refreshPlanningStock').addItem('🔄 Refresh Area Stock', 'refreshAreaStock').addToUi();
}

function setupPlanningStockTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refreshPlanningStock') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshPlanningStock').timeBased().everyMinutes(30).create();
}

function setupAreaStockTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refreshAreaStock') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshAreaStock').timeBased().everyMinutes(30).create();
}


// =====================================================================
// ====== AUTH: hashed passwords + self-service setup / reset (OTP) ======
// =====================================================================
//
// Users!Password cell states:
//   blank                  -> account not set up yet; user must use
//                             "Forgot password? / First time here?"
//   "<16hex>$<64hex>"      -> salted SHA-256 hash (written by this code)
//   anything else          -> LEGACY plaintext (e.g. "rajat@123"). Accepted
//                             only while ALLOW_LEGACY_PLAINTEXT_PASSWORDS is
//                             true, so the team keeps working during testing.
//
// CUTOVER DAY: blank every Password cell, set the constant below to false,
// save, redeploy (New version). From then on only hashes are ever accepted.
//
// Admin escape hatch for a locked-out user: clear their Password cell.
// They then use the same self-service flow to set a new one.
// Users can NEVER change their own email/role/area through this flow --
// only their Password cell is ever written.

const ALLOW_LEGACY_PLAINTEXT_PASSWORDS = true;

const OTP_CACHE_PREFIX = 'pwdotp_';
const OTP_COOLDOWN_PREFIX = 'pwdcooldown_';
const OTP_EXPIRY_SECONDS = 600;    // 10 minutes
const OTP_COOLDOWN_SECONDS = 45;   // min gap between code requests per email
const OTP_MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function generateSalt_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

function isHashedPassword_(stored) {
  return /^[0-9a-f]{16}\$[0-9a-f]{64}$/.test(String(stored));
}

function makeStoredPassword_(password) {
  const salt = generateSalt_();
  return salt + '$' + sha256Hex_(salt + ':' + password);
}

function verifyPassword_(password, stored) {
  const s = String(stored);
  if (isHashedPassword_(s)) {
    const parts = s.split('$');
    return sha256Hex_(parts[0] + ':' + password) === parts[1];
  }
  // Legacy plaintext -- exact same comparison the old checkLogin() did.
  return ALLOW_LEGACY_PLAINTEXT_PASSWORDS && s === String(password);
}

/** 6-digit code from Utilities.getUuid() (secure random), not Math.random(). */
function generateOtp_() {
  const n = parseInt(Utilities.getUuid().replace(/-/g, '').substring(0, 12), 16);
  return String(100000 + (n % 900000));
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeHtml_(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findUserRow_(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const emailCol = getColIndexOrThrow_(headers, 'User_email', USERS_SHEET);
  const target = normalizeEmail_(email);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][emailCol]).trim().toLowerCase() === target) {
      return { rowIndex: i, row: values[i], headers: headers, sheet: sheet };
    }
  }
  return null;
}

/**
 * data: { email }
 * Always returns the SAME generic message whether or not the email is
 * registered, so this endpoint can't be used to discover valid emails.
 */
function requestAccountCode(data) {
  const email = normalizeEmail_(data.email);
  if (!email) return jsonResponse({ success: false, message: 'Email is required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ success: false, message: 'Enter a valid email address.' });

  const cache = CacheService.getScriptCache();
  const cooldownKey = OTP_COOLDOWN_PREFIX + email;
  if (cache.get(cooldownKey)) {
    return jsonResponse({ success: false, message: 'Please wait a minute before requesting another code.' });
  }
  cache.put(cooldownKey, '1', OTP_COOLDOWN_SECONDS);

  const generic = { success: true, message: 'If that email is registered, a verification code has been sent to it.' };
  const found = findUserRow_(email);
  if (!found) return jsonResponse(generic);

  const code = generateOtp_();
  cache.put(OTP_CACHE_PREFIX + email, JSON.stringify({ code: code, attempts: 0 }), OTP_EXPIRY_SECONDS);
  const nameCol = found.headers.indexOf('Name');
  const name = nameCol !== -1 ? found.row[nameCol] : '';
  try {
    sendAccountCodeEmail_(email, name, code);
  } catch (e) {
    cache.remove(OTP_CACHE_PREFIX + email);
    cache.remove(cooldownKey);
    return jsonResponse({ success: false, message: 'Could not send the email right now. Please try again later or contact the project owner.' });
  }
  return jsonResponse(generic);
}

function sendAccountCodeEmail_(email, name, code) {
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;">' +
      '<div style="background:#17233b;background:linear-gradient(135deg,#17233b,#1a73e8);padding:20px 24px;border-radius:8px 8px 0 0;">' +
        '<span style="color:#fff;font-size:18px;font-weight:600;">Stores Dashboard</span>' +
      '</div>' +
      '<div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">' +
        '<p style="margin:0 0 12px;color:#1f2430;">Hi' + (name ? ' ' + escapeHtml_(name) : '') + ',</p>' +
        '<p style="margin:0 0 20px;color:#1f2430;">Use this code to set your Stores Dashboard password:</p>' +
        '<div style="font-size:30px;font-weight:700;letter-spacing:6px;color:#1557b0;text-align:center;padding:14px 0;background:#f1f3f4;border-radius:8px;">' + code + '</div>' +
        '<p style="margin:20px 0 0;color:#666;font-size:13px;">This code expires in 10 minutes. If you did not request it, ignore this email &mdash; your password will not change.</p>' +
      '</div>' +
    '</div>';
  MailApp.sendEmail({
    to: email,
    subject: 'Your Stores Dashboard verification code',
    body: 'Your Stores Dashboard verification code is ' + code + '. It expires in 10 minutes. If you did not request it, ignore this email.',
    htmlBody: html,
    name: 'Stores Dashboard'
  });
}

/**
 * data: { email, code, newPassword }
 * Same mechanics for first-time setup (blank cell) and forgot-password.
 */
function verifyCodeAndSetPassword(data) {
  const email = normalizeEmail_(data.email);
  const code = String(data.code || '').trim();
  const newPassword = String(data.newPassword || '');
  if (!email) return jsonResponse({ success: false, message: 'Email is required.' });
  if (!/^\d{6}$/.test(code)) return jsonResponse({ success: false, message: 'Enter the 6-digit code from your email.' });
  if (newPassword.length < MIN_PASSWORD_LENGTH) return jsonResponse({ success: false, message: 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.' });
  if (newPassword.length > 100) return jsonResponse({ success: false, message: 'Password is too long (max 100 characters).' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = OTP_CACHE_PREFIX + email;
    const raw = cache.get(cacheKey);
    if (!raw) return jsonResponse({ success: false, message: 'Code expired or not requested. Please request a new one.' });

    const entry = JSON.parse(raw);
    if (entry.attempts >= OTP_MAX_ATTEMPTS) {
      cache.remove(cacheKey);
      return jsonResponse({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }
    if (String(entry.code) !== code) {
      entry.attempts += 1;
      if (entry.attempts >= OTP_MAX_ATTEMPTS) {
        cache.remove(cacheKey);
        return jsonResponse({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
      }
      cache.put(cacheKey, JSON.stringify(entry), OTP_EXPIRY_SECONDS);
      return jsonResponse({ success: false, message: 'Incorrect code. ' + (OTP_MAX_ATTEMPTS - entry.attempts) + ' attempt(s) left.' });
    }

    const found = findUserRow_(email);
    if (!found) { cache.remove(cacheKey); return jsonResponse({ success: false, message: 'Account not found.' }); }

    const passCol = getColIndexOrThrow_(found.headers, 'Password', USERS_SHEET);
    const wasBlank = isBlankCell(found.row[passCol]);
    const cell = found.sheet.getRange(found.rowIndex + 1, passCol + 1);
    cell.setNumberFormat('@STRING@');
    cell.setValue(makeStoredPassword_(newPassword));
    cache.remove(cacheKey); // one-time use

    const nameCol = found.headers.indexOf('Name');
    const name = nameCol !== -1 ? found.row[nameCol] : '';
    // Never log the password or its hash -- only the event itself.
    logAudit(name, email, wasBlank ? 'ACCOUNT_PASSWORD_SET' : 'ACCOUNT_PASSWORD_RESET',
      'Password ' + (wasBlank ? 'set for the first time' : 'reset') + ' via emailed verification code.');

    return jsonResponse({
      success: true,
      message: wasBlank ? 'Password set successfully. You can now log in.' : 'Password reset successfully. Log in with your new password.'
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * RUN ONCE FROM THE EDITOR (select it in the function dropdown -> Run)
 * after pasting this version. MailApp is a new permission for this
 * script; running this triggers Google's "Authorize access" prompt so the
 * live Web App is allowed to send email. Safe to re-run; sends nothing.
 */
function authorizeMailOnce() {
  Logger.log('Mail authorized. Remaining daily email quota: ' + MailApp.getRemainingDailyQuota());
}
