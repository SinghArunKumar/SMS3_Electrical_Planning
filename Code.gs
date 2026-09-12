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
 *
 * IMPORTANT ONE-TIME SETUP FOR THIS VERSION: the LOCAL_ISSUE_SHEET tab's headers must read
 * EXACTLY (retype each cell from scratch, Bug Pattern 3):
 *   A: Issue_Date | B: Area | C: UCS_Code | D: Material_Description | E: Unit |
 *   F: Consumed_Qty | G: Issued_To | H: Remarks | I: Issued_By_Name | J: Issued_By_Email | K: Timestamp
 * (Unit, Issued_To, Issued_By_Name, Issued_By_Email, Timestamp are new columns —
 * Issued_To is split out of what used to be a single free-text Remarks column.)
 *
 * DEPLOYMENT:
 * 1. Open the Google Sheet -> Extensions -> Apps Script
 * 2. Select ALL existing content in Code.gs and DELETE it.
 * 3. Paste this file's entire contents into Code.gs.
 * 4. Save (Ctrl+S).
 * 5. Deploy -> Manage deployments -> pencil/edit icon on your existing
 *    deployment -> Version dropdown -> New version -> Deploy.
 *    (Saving alone does NOT update the live Web App URL — see
 *    BUG_PATTERNS_AND_DEBUGGING_GUIDE.md, Bug Pattern 1.)
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
// Legacy sheet from an earlier attempt -- not yet part of the current design (see
// PROJECT_STATUS.md Section 3). getUCSCodeHistory() below returns an
// available:false placeholder for this section until its schema is finalized.
const LOCAL_ISSUE_SHEET = 'LOCAL_ISSUE_SHEET';
const AREA_STOCK_SHEET = 'AREA_STOCK';
const DEMAND_SHEET = 'Demand_Alerts';

// Unit is no longer a hardcoded array -- addUCSCode() now validates against the
// live 'Unit' column of Options_List (readOptionsColumn('Unit')), the same
// source add-ucs-code.html's dropdown reads from. Admins manage the actual
// allowed values via admin-options.html / addOptionValue(), not by editing code.

// ====== ENTRY POINTS ======

function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Apps Script backend is running.' });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'login') {
      return jsonResponse(checkLogin(data.email, data.password));
    }
    if (action === 'addUCSCode') {
      return addUCSCode(data);
    }
    if (action === 'getUCSByCode') {
      return getUCSByCode(data);
    }
    if (action === 'checkUCSCodeExists') {
      return checkUCSCodeExists(data);
    }
    if (action === 'getUCSSearchData') {
      return getUCSSearchData(data);
    }
    if (action === 'checkSTONoExists') {
      return checkSTONoExists(data);
    }
    if (action === 'editUCSText') {
      return editUCSText(data);
    }
    if (action === 'addSTOEntry') {
      return addSTOEntry(data);
    }
    if (action === 'getSTOList') {
      return getSTOList(data);
    }
    if (action === 'receiveSTOMaterial') {
      return receiveSTOMaterial(data);
    }
    if (action === 'editSTOReceivedInfo') {
      return editSTOReceivedInfo(data);
    }
    if (action === 'getEligibleSTOsForZ04') {
      return getEligibleSTOsForZ04(data);
    }
    if (action === 'checkMatDocNoExists') {
      return checkMatDocNoExists(data);
    }
    if (action === 'addZ04Entry') {
      return addZ04Entry(data);
    }
    if (action === 'getZ04DetailsForSTO') {
      return getZ04DetailsForSTO(data);
    }
    if (action === 'getOptionsList') {
      return getOptionsList(data);
    }
    if (action === 'addOptionValue') {
      return addOptionValue(data);
    }
    if (action === 'getEligibleZ04sFor201') {
      return getEligibleZ04sFor201(data);
    }
    if (action === 'addS201Entry') {
      return addS201Entry(data);
    }
    if (action === 'getS201EntriesForSTO') {
      return getS201EntriesForSTO(data);
    }
    if (action === 'raiseRequisition') {
      return raiseRequisition(data);
    }
    if (action === 'getPendingAreaApprovals') {
      return getPendingAreaApprovals(data);
    }
    if (action === 'approveAreaRequisition') {
      return approveAreaRequisition(data);
    }
    if (action === 'getPendingSanctions') {
      return getPendingSanctions(data);
    }
    if (action === 'sanctionRequisition') {
      return sanctionRequisition(data);
    }
    if (action === 'getPendingIssues') {
      return getPendingIssues(data);
    }
    if (action === 'issueRequisition') {
      return issueRequisition(data);
    }
    if (action === 'getAreaRequisitions') {
      return getAreaRequisitions(data);
    }
    if (action === 'getPlanningStockList') {
      return getPlanningStockList(data);
    }
    if (action === 'refreshPlanningStock') {
      return refreshPlanningStockEndpoint(data);
    }
    if (action === 'getUCSCodeHistory') {
      return getUCSCodeHistory(data);
    }
    if (action === 'recordLocalIssue') {
      return recordLocalIssue(data);
    }
    if (action === 'getMyLocalIssues') {
      return getMyLocalIssues(data);
    }
    if (action === 'getAreaStockList') {
      return getAreaStockList(data);
    }
    if (action === 'refreshAreaStock') {
      return refreshAreaStockEndpoint(data);
    }
    if (action === 'submitDemandAlert') {
      return submitDemandAlert(data);
    }
    if (action === 'getDemandAlerts') {
      return getDemandAlerts(data);
    }
    if (action === 'updateDemandAlertStatus') {
      return updateDemandAlertStatus(data);
    }
    if (action === 'getMyDemandAlerts') {
      return getMyDemandAlerts(data);
    }

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Server error: ' + err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== SMALL SHARED HELPERS ======

/** Splits a comma-separated field (Role, Authorized_Area, etc.) and checks membership. */
function hasCommaValue(str, target) {
  if (!str) return false;
  // Case-insensitive on purpose: this exact "Planning" vs "PLANNING" mismatch
  // (title case typed into Users.Authorized_Area vs the all-caps convention
  // used by the Options_List / Released_to_Area / Area fields everywhere else)
  // is what caused the PLNG_STOCK balance bug for 51310406000298. Comparing
  // case-insensitively here means a stray casing difference in any comma-
  // separated Authorized_Area or Role value can never silently break access
  // control again the same way.
  const targetLower = String(target).toLowerCase();
  return String(str).split(',').map(s => s.trim().toLowerCase()).indexOf(targetLower) !== -1;
}

/** Parses a 'YYYY-MM-DD' string into a local Date (midnight), or null if invalid/malformed. */
function parseDateOnly(str) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  const dt = new Date(y, m - 1, d);
  // Guard against JS rolling over invalid dates like Feb 30 -> Mar 2
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Today at local midnight, for future-date comparisons. */
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Normalizes a Date (or date-like value) from a sheet cell down to local midnight for comparisons. */
function toMidnight(val) {
  if (!val) return null;
  const d = (Object.prototype.toString.call(val) === '[object Date]') ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Formats a Date cell value back to 'YYYY-MM-DD' for the frontend. Passes through non-dates as-is. */
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

/** True if a Received_* cell is genuinely empty (handles '', null, undefined). */
function isBlankCell(val) {
  return val === '' || val === null || val === undefined;
}

// ====== AUTH ======

/**
 * Validates email + password against the Users sheet.
 * Returns { success, name, role, authorizedArea, isAdmin } or { success:false, message }
 */
function checkLogin(email, password) {
  if (!email || !password) {
    return { success: false, message: 'Email and password are required.' };
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET);
  const values = sheet.getDataRange().getValues();
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
      if (String(row[passCol]) === String(password)) {
        return {
          success: true,
          name: row[nameCol],
          role: row[roleCol],
          authorizedArea: areaCol !== -1 ? row[areaCol] : '',
          isAdmin: isApprover(row[roleCol])
        };
      }
      return { success: false, message: 'Incorrect password.' };
    }
  }
  return { success: false, message: 'User not found.' };
}

/**
 * Role field can be multi-value, e.g. "Approver, Area Incharge".
 * Admin = role list contains "Approver".
 */
function isApprover(roleString) {
  return hasCommaValue(roleString, 'Approver');
}

/**
 * STO access = Authorized_Area contains "Planning" AND Role does NOT contain "Store Incharge".
 * Both fields are comma-separated multi-value, same parsing as isApprover().
 */
function canManageSTO(authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, 'Planning') && !hasCommaValue(roleString, 'Store Incharge');
}

/**
 * Verifies login AND that the user is an Approver.
 * Returns { ok: true, login } or { ok: false, response: <TextOutput to return immediately> }
 */
function requireAdmin(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) {
    return { ok: false, response: jsonResponse(login) };
  }
  if (!login.isAdmin) {
    return { ok: false, response: jsonResponse({ success: false, message: 'Only Approvers (Admins) can perform this action.' }) };
  }
  return { ok: true, login: login };
}

/**
 * Verifies login AND that the user is allowed to raise/receive STOs
 * (Planning, excluding Store Incharge).
 * Returns { ok: true, login } or { ok: false, response: <TextOutput to return immediately> }
 */
function requireSTOAccess(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) {
    return { ok: false, response: jsonResponse(login) };
  }
  if (!canManageSTO(login.authorizedArea, login.role)) {
    return { ok: false, response: jsonResponse({ success: false, message: 'Only Planning staff (excluding Store Incharge) can perform this action.' }) };
  }
  return { ok: true, login: login };
}

/**
 * Verifies login only -- no role/area restriction. Used for endpoints every
 * logged-in user should be able to reach (e.g. the read-only UCS Code Search
 * page), as opposed to requireAdmin/requireSTOAccess which gate specific
 * write actions to specific roles.
 * Returns { ok: true, login } or { ok: false, response: <TextOutput to return immediately> }
 */
function requireAnyUser(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) {
    return { ok: false, response: jsonResponse(login) };
  }
  return { ok: true, login: login };
}

/**
 * "Planning staff" for the Planning Stock dashboard's advanced/drill-down
 * features -- deliberately WIDER than canManageSTO(): Authorized_Area
 * contains "Planning" is enough on its own, Store Incharge is NOT excluded
 * here (per the project owner's explicit call, since Store Incharge legitimately
 * needs the full receive/issue history too). Keep this separate from
 * canManageSTO() -- they encode two different, independently-decided rules
 * that happen to look similar; do not merge them.
 */
function isPlanningAreaStaff(authorizedAreaString) {
  return hasCommaValue(authorizedAreaString, 'Planning');
}

/**
 * Verifies login AND that the user's Authorized_Area includes "Planning".
 * Gates the Planning Stock dashboard's advanced features (per-UCS-Code
 * history drill-down, chart data) -- the base live balance list
 * (getPlanningStockList) deliberately stays open to requireAnyUser.
 * Returns { ok: true, login } or { ok: false, response: <TextOutput to return immediately> }
 */
function requirePlanningAreaStaff(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) {
    return { ok: false, response: jsonResponse(login) };
  }
  if (!isPlanningAreaStaff(login.authorizedArea)) {
    return { ok: false, response: jsonResponse({ success: false, message: 'Only staff whose Authorized Area includes Planning can view this detail.' }) };
  }
  return { ok: true, login: login };
}

/**
 * Looks up a column by exact header text; throws a LOUD, readable error if
 * missing instead of returning -1 and silently writing to an undefined
 * column (see BUG_PATTERNS_AND_DEBUGGING_GUIDE.md, Bug Pattern 3 -- header
 * mismatches there failed with zero error output; this makes that failure
 * mode impossible for every function added below).
 */
function getColIndexOrThrow_(headers, name, sheetLabel) {
  const idx = headers.indexOf(name);
  if (idx === -1) {
    throw new Error('Column "' + name + '" not found in ' + sheetLabel + '. Check the header row for exact spelling/case/underscores.');
  }
  return idx;
}

// ====== ADD NEW UCS CODE ======
// Restricted to Planning staff (excluding Store Incharge) -- same gate as
// STO/Z04/201, per the project owner's explicit decision. Previously this
// only called checkLogin() (any logged-in user), which is why an Area Store
// Supervisor could reach and submit this form -- fixed here.

function addUCSCode(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const ucsCode = String(data.ucsCode || '').trim();
  const shortText = String(data.shortText || '').trim();
  const longText = String(data.longText || '').trim();
  const unit = String(data.unit || '').trim();

  // ---- Server-side validation (never trust the frontend) ----
  if (!ucsCode) {
    return jsonResponse({ success: false, message: 'UCS Code is required.' });
  }
  if (!/^[1-9]\d{13}$/.test(ucsCode)) {
    return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  }
  if (!shortText) {
    return jsonResponse({ success: false, message: 'Short Text is required.' });
  }
  if (!longText) {
    return jsonResponse({ success: false, message: 'Long Text is required.' });
  }
  const allowedUnits = readOptionsColumn('Unit');
  if (allowedUnits.indexOf(unit) === -1) {
    return jsonResponse({ success: false, message: 'Invalid unit. Allowed: ' + allowedUnits.join(', ') });
  }
  if (shortText.length > 200) {
    return jsonResponse({ success: false, message: 'Short Text is too long (max 200 characters).' });
  }
  if (longText.length > 2000) {
    return jsonResponse({ success: false, message: 'Long Text is too long (max 2000 characters).' });
  }

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = ucsSheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');

  // ---- Duplicate check: codes are permanent, never overwritten ----
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      return jsonResponse({
        success: false,
        message: 'UCS Code ' + ucsCode + ' already exists. Existing codes cannot be re-used or overwritten.'
      });
    }
  }

  // ---- Append new row (this function has no update/overwrite path) ----
  ucsSheet.appendRow([ucsCode, shortText, longText, unit]);
  const newRow = ucsSheet.getLastRow();
  ucsSheet.getRange(newRow, codeCol + 1).setNumberFormat('@STRING@'); // force plain text, protects leading zeros

  logAudit(login.name, data.email, 'ADD_UCS_CODE', 'Added new UCS Code: ' + ucsCode);

  return jsonResponse({ success: true, message: 'UCS Code ' + ucsCode + ' added successfully.' });
}

// ====== ADMIN: EDIT EXISTING UCS TEXT (Short_Text / Long_Text only) ======
// Codes can never be revoked or overwritten. Only an Approver (Admin) may
// correct Short_Text / Long_Text on an existing entry. UCS_Code and Unit
// are never touched by this code path.

/** Admin-only lookup: fetch current values for a given UCS Code. */
function getUCSByCode(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;

  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) {
    return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  const unitCol = headers.indexOf('Unit');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][codeCol]).trim() === ucsCode) {
      return jsonResponse({
        success: true,
        ucsCode: values[i][codeCol],
        shortText: values[i][shortCol],
        longText: values[i][longCol],
        unit: values[i][unitCol]
      });
    }
  }
  return jsonResponse({ success: false, message: 'UCS Code not found.' });
}

/**
 * Non-admin, read-only UCS lookup used by the Raise STO page: as soon as the
 * operator finishes typing a valid 14-digit UCS Code, the frontend calls this
 * to check existence and grab Item_Description/Unit for auto-fill, WITHOUT
 * requiring Approver rights (gated by requireSTOAccess instead of requireAdmin).
 * This is purely informational for the UI -- addSTOEntry() still re-checks
 * everything server-side on actual submit, so nothing here is trusted blindly.
 */
function checkUCSCodeExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) {
    return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  }

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

/**
 * Read-only, any-logged-in-user endpoint for the "UCS Code Search" dashboard.
 * Returns the ENTIRE UCS_MasterList (code, short text, long text, unit) in one
 * shot so the frontend can do fast, fully client-side multi-keyword search as
 * the user types, instead of round-tripping to Apps Script on every keystroke.
 * Gated by requireAnyUser -- every team member can read this, nobody can use
 * it to edit or delete anything (no write path exists on this action at all).
 */
function getUCSSearchData(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  const unitCol = headers.indexOf('Unit');

  // Live balance, fetched fresh on every call (page load) -- so the raiser sees
  // what's actually on the shelf at Planning before typing a qty, not a stale
  // number. See REQUISITION_MODULE_SPEC.md Section 6.
  const stockMap = computePlanningStockMap_();

  const items = [];
  for (let i = 1; i < values.length; i++) {
    const ucsCode = String(values[i][codeCol] || '').trim();
    if (!ucsCode) continue; // skip any blank trailing rows
    items.push({
      ucsCode: ucsCode,
      shortText: String(values[i][shortCol] || ''),
      longText: String(values[i][longCol] || ''),
      unit: String(values[i][unitCol] || ''),
      availableAtPlanning: stockMap[ucsCode] ? stockMap[ucsCode].balance : 0
    });
  }
  return jsonResponse({ success: true, items: items });
}

/**
 * Non-admin, read-only STO_No uniqueness check, mirroring checkUCSCodeExists.
 * Lets the Raise STO page warn the operator immediately once they finish typing
 * a candidate STO_No, instead of only discovering a duplicate after Save.
 * addSTOEntry() still re-checks uniqueness itself on actual submit -- this is
 * purely for early feedback in the UI.
 */
function checkSTONoExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) {
    return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = {};
  headers.forEach((h, idx) => { col[h] = idx; });

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['STO_No']]).trim() === stoNo) {
      return jsonResponse({ success: true, exists: true });
    }
  }
  return jsonResponse({ success: true, exists: false });
}

/** Admin-only edit: updates ONLY Short_Text and Long_Text for an existing code. */
function editUCSText(data) {
  const check = requireAdmin(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const ucsCode = String(data.ucsCode || '').trim();
  const newShortText = String(data.shortText || '').trim();
  const newLongText = String(data.longText || '').trim();

  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) {
    return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  }
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

      const rowNum = i + 1; // sheet rows are 1-indexed
      sheet.getRange(rowNum, shortCol + 1).setValue(newShortText);
      sheet.getRange(rowNum, longCol + 1).setValue(newLongText);

      logAudit(
        login.name,
        data.email,
        'EDIT_UCS_TEXT',
        'Code ' + ucsCode +
          ' | Short: "' + oldShort + '" -> "' + newShortText + '"' +
          ' | Long: "' + oldLong + '" -> "' + newLongText + '"'
      );

      return jsonResponse({ success: true, message: 'UCS Code ' + ucsCode + ' updated successfully.' });
    }
  }
  return jsonResponse({ success: false, message: 'UCS Code not found.' });
}

// ====== STO_MASTERLIST: RAISE STO ======
// Columns (finalized schema): STO_Date, STO_No, UCS_Code, Item_Description,
// Qty, Unit, Received_Qty, Received_Date, Reference_PO
//
// Mandatory at raise time: STO_Date, STO_No, UCS_Code, Qty.
// Item_Description / Unit are auto-populated from UCS_MasterList, never manual.
// Received_Qty / Received_Date / Reference_PO are an ALL-OR-NOTHING group:
//   - none filled  -> STO saved as pending
//   - all filled   -> validated and STO saved already-received (locked)
//   - partial fill -> rejected

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

  // ---- Mandatory field validation ----
  if (!stoDateStr) return jsonResponse({ success: false, message: 'STO Date is required.' });
  const stoDateObj = parseDateOnly(stoDateStr);
  if (!stoDateObj) return jsonResponse({ success: false, message: 'STO Date is invalid.' });
  const today = startOfToday();
  if (stoDateObj > today) return jsonResponse({ success: false, message: 'STO Date cannot be in the future.' });

  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) {
    return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });
  if (!/^[1-9]\d{13}$/.test(ucsCode)) {
    return jsonResponse({ success: false, message: 'UCS Code must be exactly 14 digits, numbers only, and cannot start with 0.' });
  }

  if (qtyRaw === undefined || qtyRaw === null || qtyRaw === '') {
    return jsonResponse({ success: false, message: 'Qty is required.' });
  }
  const qty = Number(qtyRaw);
  if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0) {
    return jsonResponse({ success: false, message: 'Qty must be a positive whole number (no zero, negative, or decimals).' });
  }

  // ---- UCS lookup (auto-populate Item_Description / Unit) ----
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = ucsHeaders.indexOf('UCS_Code');
  const ucsShortCol = ucsHeaders.indexOf('Short_Text');
  const ucsUnitCol = ucsHeaders.indexOf('Unit');

  let ucsRow = null;
  for (let i = 1; i < ucsValues.length; i++) {
    if (String(ucsValues[i][ucsCodeCol]).trim() === ucsCode) {
      ucsRow = ucsValues[i];
      break;
    }
  }
  if (!ucsRow) {
    // Signals the frontend to offer: Abort, or inline "Add New UCS Code" then retry.
    return jsonResponse({ success: false, ucsNotFound: true, message: 'UCS Code ' + ucsCode + ' was not found in UCS_MasterList.' });
  }
  const itemDescription = ucsRow[ucsShortCol];
  const unit = ucsRow[ucsUnitCol];

  // ---- STO_No uniqueness check ----
  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  const stoHeaders = stoValues[0];
  const col = {};
  stoHeaders.forEach((h, idx) => { col[h] = idx; });

  for (let i = 1; i < stoValues.length; i++) {
    if (String(stoValues[i][col['STO_No']]).trim() === stoNo) {
      return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' already exists. STO numbers must be unique.' });
    }
  }

  // ---- Receiving group (Received_Qty / Received_Date / Reference_PO): all-or-nothing ----
  const hasRecQty = !(recQtyRaw === undefined || recQtyRaw === null || recQtyRaw === '');
  const hasRecDate = !!recDateStr;
  const hasRefPO = !!refPO;
  const anyReceivingFilled = hasRecQty || hasRecDate || hasRefPO;
  const allReceivingFilled = hasRecQty && hasRecDate && hasRefPO;

  if (anyReceivingFilled && !allReceivingFilled) {
    return jsonResponse({
      success: false,
      message: 'Received Qty, Received Date, and Reference PO must all be filled together, or all left blank.'
    });
  }

  let receivedQtyOut = '';
  let receivedDateOut = '';
  let referencePOOut = '';
  let isLocked = false;

  if (allReceivingFilled) {
    const recQty = Number(recQtyRaw);
    if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) {
      return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
    }
    if (recQty > qty) {
      return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + qty + ').' });
    }
    const recDateObj = parseDateOnly(recDateStr);
    if (!recDateObj) return jsonResponse({ success: false, message: 'Received Date is invalid.' });
    if (recDateObj > today) return jsonResponse({ success: false, message: 'Received Date cannot be in the future.' });
    if (recDateObj < stoDateObj) return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });

    receivedQtyOut = recQty;
    receivedDateOut = recDateObj;
    referencePOOut = refPO;
    isLocked = true;
  }

  // ---- Append row ----
  stoSheet.appendRow([stoDateObj, stoNo, ucsCode, itemDescription, qty, unit, receivedQtyOut, receivedDateOut, referencePOOut]);
  const newRow = stoSheet.getLastRow();
  stoSheet.getRange(newRow, col['STO_No'] + 1).setNumberFormat('@STRING@');
  stoSheet.getRange(newRow, col['UCS_Code'] + 1).setNumberFormat('@STRING@');

  logAudit(
    login.name,
    data.email,
    'ADD_STO_ENTRY',
    'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty ' + qty +
      (isLocked ? ' | Received at creation: Qty ' + receivedQtyOut + ', Date ' + recDateStr + ', Ref ' + referencePOOut + ' (auto-locked)' : ' | Pending receipt')
  );

  return jsonResponse({
    success: true,
    message: 'STO ' + stoNo + ' added successfully.' + (isLocked ? ' Received details were complete, so it has been locked.' : ''),
    itemDescription: itemDescription,
    unit: unit,
    locked: isLocked
  });
}

// ====== STO_MASTERLIST: DASHBOARD LIST ======

/**
 * Returns a paginated, filterable, newest-first list of STO rows for the dashboard.
 *
 * Optional filters on `data` (all combine with AND):
 *   - startDate / endDate ('YYYY-MM-DD'): filters on STO_Date, BOTH ends inclusive.
 *   - search (string): a single search box value, matched as a "contains" check
 *     against BOTH STO_No and UCS_Code — so the same box works for either field
 *     without the user needing to say which one they're typing.
 *   - status ('all' | 'pending' | 'received', default 'all'): restricts to only
 *     pending or only received rows, applied across the full dataset (not just
 *     the current page) so a user can browse every Pending row serially even
 *     when it's not a "sort the visible page" situation.
 *
 * Sorting: newest-first by SHEET ROW ORDER (last row appended appears first),
 * not strictly by STO_Date — a late-logged older STO should surface as
 * "recently added," not jump back in time in the list.
 *
 * Pagination: 1-indexed `page` (default 1), `pageSize` (default 20).
 * Response includes totalCount/currentPage/totalPages so the frontend can
 * render "Showing X of Y" and page controls.
 */
function getSTOList(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : 20;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return jsonResponse({ success: true, rows: [], totalCount: 0, currentPage: 1, totalPages: 1, pageSize: pageSize });
  }

  const headers = values[0];
  const col = {};
  headers.forEach((h, idx) => { col[h] = idx; });

  // ---- Build the set of STO_Nos that already have a Z04 entry ----
  // Same pattern as getEligibleSTOsForZ04()'s alreadyZ04d map -- kept here as its
  // own lightweight lookup rather than a shared helper, since the two callers
  // read the S_Z04 sheet at different points in a request lifecycle and a shared
  // helper would just be an extra indirection for one map-building loop.
  // Also captures Qty_Recieved_Z04 per STO_No in the same pass, needed below to
  // derive the 201 status (Done/Partial/Pending) -- no extra sheet read.
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

  // ---- 201 status per STO_No: 'na' (Z04 not done yet) | 'pending' (Z04 done,
  // nothing released yet) | 'partial' (some but not all released) | 'done'
  // (fully drawn down). Only the qualitative status is exposed to the
  // dashboard -- no Qty/remaining figures -- per the project owner's decision
  // that the operator raising the 201 already knows the real numbers.
  const releasedByStoNo201 = sumReleasedByStoNo();
  function compute201Status(stoNo) {
    if (!z04Done[stoNo]) return 'na';
    const qtyZ04 = z04QtyByStoNo[stoNo] || 0;
    const released = releasedByStoNo201[stoNo] || 0;
    const remaining = qtyZ04 - released;
    if (remaining <= 0) return 'done';       // fully drawn down (or a zero-qty Z04 edge case)
    if (released > 0) return 'partial';
    return 'pending';
  }

  // ---- Build full row list, in sheet order (oldest -> newest) ----
  let allRows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const receivedQty = r[col['Received_Qty']];
    const receivedDate = r[col['Received_Date']];
    const referencePO = r[col['Reference_PO']];
    const pending = isBlankCell(receivedQty) && isBlankCell(receivedDate) && !referencePO;
    const stoNo = String(r[col['STO_No']]).trim();

    allRows.push({
      stoDateObj: toMidnight(r[col['STO_Date']]),
      stoDate: formatDateOut(r[col['STO_Date']]),
      stoNo: stoNo,
      ucsCode: String(r[col['UCS_Code']]).trim(),
      itemDescription: r[col['Item_Description']],
      qty: r[col['Qty']],
      unit: r[col['Unit']],
      receivedQty: isBlankCell(receivedQty) ? '' : receivedQty,
      receivedDate: formatDateOut(receivedDate),
      referencePO: referencePO || '',
      pending: pending,
      z04Done: !!z04Done[stoNo],
      status201: compute201Status(stoNo)
    });
  }

  // ---- Filter: STO_Date range, both ends inclusive ----
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

  // ---- Filter: search, "contains" match against EITHER STO_No or UCS_Code ----
  const searchTerm = String(data.search || '').trim();
  if (searchTerm) {
    allRows = allRows.filter(function (row) {
      return row.stoNo.indexOf(searchTerm) !== -1 || row.ucsCode.indexOf(searchTerm) !== -1;
    });
  }

  // ---- Filter: status ('all' | 'pending' | 'received'), applied across the WHOLE
  // dataset before pagination -- this is what lets a user see every Pending row
  // "serially" regardless of which page it would otherwise land on. A page-local
  // sort arrow on the Status column could not do this, since sorting only reorders
  // whatever 20 rows are already on the current page.
  // Generic on purpose: Z04 and 201 dashboards (same STO Dashboard page, later) can
  // reuse this exact status/pagination pattern without redesigning it.
  const statusFilter = String(data.status || 'all').trim().toLowerCase();
  if (statusFilter === 'pending') {
    allRows = allRows.filter(function (row) { return row.pending; });
  } else if (statusFilter === 'received') {
    allRows = allRows.filter(function (row) { return !row.pending; });
  }

  // ---- Filter: Z04 status ('all' | 'z04pending' | 'z04done'), same whole-dataset-
  // before-pagination treatment as the Received status filter above. ----
  const z04Filter = String(data.z04Status || 'all').trim().toLowerCase();
  if (z04Filter === 'z04pending') {
    allRows = allRows.filter(function (row) { return !row.z04Done; });
  } else if (z04Filter === 'z04done') {
    allRows = allRows.filter(function (row) { return row.z04Done; });
  }

  // ---- Filter: 201 status ('all' | '201pending' | '201partial' | '201done'),
  // same whole-dataset-before-pagination treatment as the other two filters. ----
  const status201Filter = String(data.status201 || 'all').trim().toLowerCase();
  if (status201Filter === '201pending') {
    allRows = allRows.filter(function (row) { return row.status201 === 'pending'; });
  } else if (status201Filter === '201partial') {
    allRows = allRows.filter(function (row) { return row.status201 === 'partial'; });
  } else if (status201Filter === '201done') {
    allRows = allRows.filter(function (row) { return row.status201 === 'done'; });
  }

  // ---- Sort: newest-first (reverse of append order) ----
  allRows.reverse();

  // ---- Paginate ----
  const totalCount = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  let page = Number(data.page) > 0 ? Number(data.page) : 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * pageSize;
  const pageRows = allRows.slice(startIdx, startIdx + pageSize).map(function (row) {
    return {
      stoDate: row.stoDate,
      stoNo: row.stoNo,
      ucsCode: row.ucsCode,
      itemDescription: row.itemDescription,
      qty: row.qty,
      unit: row.unit,
      receivedQty: row.receivedQty,
      receivedDate: row.receivedDate,
      referencePO: row.referencePO,
      pending: row.pending,
      z04Done: row.z04Done,
      status201: row.status201
    };
  });

  return jsonResponse({
    success: true,
    rows: pageRows,
    totalCount: totalCount,
    currentPage: page,
    totalPages: totalPages,
    pageSize: pageSize
  });
}

// ====== STO_MASTERLIST: RECEIVE MATERIAL ======
// Only Received_Qty, Received_Date, Reference_PO may be written by this function.
// STO_Date, STO_No, UCS_Code, Item_Description, Qty, Unit are never touched here.

function receiveSTOMaterial(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const stoNo = String(data.stoNo || '').trim();
  const recQtyRaw = data.receivedQty;
  const recDateStr = String(data.receivedDate || '').trim();
  const refPO = String(data.referencePO || '').trim();

  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const col = {};
  headers.forEach((h, idx) => { col[h] = idx; });

  let targetIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['STO_No']]).trim() === stoNo) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });

  const row = values[targetIndex];

  // ---- Race-condition guard: re-verify still pending right before writing ----
  const existingQty = row[col['Received_Qty']];
  const existingDate = row[col['Received_Date']];
  const existingPO = row[col['Reference_PO']];
  const alreadyReceived = !isBlankCell(existingQty) || !isBlankCell(existingDate) || !!existingPO;
  if (alreadyReceived) {
    return jsonResponse({ success: false, message: 'This STO has already been received and locked (possibly by another user). Please refresh the dashboard.' });
  }

  // ---- All three fields required to complete receiving ----
  const hasRecQty = !(recQtyRaw === undefined || recQtyRaw === null || recQtyRaw === '');
  if (!hasRecQty || !recDateStr || !refPO) {
    return jsonResponse({ success: false, message: 'Received Qty, Received Date, and Reference PO are all required to complete receiving.' });
  }

  const recQty = Number(recQtyRaw);
  if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) {
    return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
  }
  const requestedQty = Number(row[col['Qty']]);
  if (recQty > requestedQty) {
    return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + requestedQty + ').' });
  }

  const recDateObj = parseDateOnly(recDateStr);
  if (!recDateObj) return jsonResponse({ success: false, message: 'Received Date is invalid.' });
  const today = startOfToday();
  if (recDateObj > today) return jsonResponse({ success: false, message: 'Received Date cannot be in the future.' });

  const stoDateMidnight = toMidnight(row[col['STO_Date']]);
  if (stoDateMidnight && recDateObj < stoDateMidnight) {
    return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });
  }

  const rowNum = targetIndex + 1; // sheet rows are 1-indexed
  sheet.getRange(rowNum, col['Received_Qty'] + 1).setValue(recQty);
  sheet.getRange(rowNum, col['Received_Date'] + 1).setValue(recDateObj);
  sheet.getRange(rowNum, col['Reference_PO'] + 1).setValue(refPO);

  logAudit(
    login.name,
    data.email,
    'RECEIVE_STO_MATERIAL',
    'STO ' + stoNo + ' | Received Qty ' + recQty + ' | Received Date ' + recDateStr + ' | Ref PO ' + refPO
  );

  return jsonResponse({ success: true, message: 'STO ' + stoNo + ' marked as received and locked.' });
}

// ====== STO_MASTERLIST: ADMIN-ONLY POST-LOCK CORRECTION ======
// Once an STO is locked (via addSTOEntry with a complete receiving group, or via
// receiveSTOMaterial), only an Approver may correct Received_Qty / Received_Date /
// Reference_PO. STO_Date, STO_No, UCS_Code, Item_Description, Qty, Unit are never
// touched by this function — mirrors the UCS_MasterList editUCSText scoping rule.

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
  if (!hasRecQty || !recDateStr || !refPO) {
    return jsonResponse({ success: false, message: 'Received Qty, Received Date, and Reference PO are all required.' });
  }

  const recQty = Number(recQtyRaw);
  if (isNaN(recQty) || !Number.isInteger(recQty) || recQty <= 0) {
    return jsonResponse({ success: false, message: 'Received Qty must be a positive whole number (no zero, negative, or decimals).' });
  }
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
    if (String(values[i][col['STO_No']]).trim() === stoNo) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return jsonResponse({ success: false, message: 'STO No not found.' });

  const row = values[targetIndex];
  const requestedQty = Number(row[col['Qty']]);
  if (recQty > requestedQty) {
    return jsonResponse({ success: false, message: 'Received Qty cannot exceed the requested Qty (' + requestedQty + ').' });
  }
  const stoDateMidnight = toMidnight(row[col['STO_Date']]);
  if (stoDateMidnight && recDateObj < stoDateMidnight) {
    return jsonResponse({ success: false, message: 'Received Date cannot be earlier than STO Date.' });
  }

  const oldQty = row[col['Received_Qty']];
  const oldDate = formatDateOut(row[col['Received_Date']]);
  const oldPO = row[col['Reference_PO']];

  const rowNum = targetIndex + 1;
  sheet.getRange(rowNum, col['Received_Qty'] + 1).setValue(recQty);
  sheet.getRange(rowNum, col['Received_Date'] + 1).setValue(recDateObj);
  sheet.getRange(rowNum, col['Reference_PO'] + 1).setValue(refPO);

  logAudit(
    login.name,
    data.email,
    'EDIT_STO_RECEIVED_INFO',
    'STO ' + stoNo +
      ' | Qty: ' + oldQty + ' -> ' + recQty +
      ' | Date: ' + oldDate + ' -> ' + recDateStr +
      ' | Ref: "' + oldPO + '" -> "' + refPO + '"'
  );

  return jsonResponse({ success: true, message: 'STO ' + stoNo + ' received details corrected by Approver.' });
}

// ====== S_Z04: ELIGIBLE STO LOOKUP (powers the type-ahead field) ======

/**
 * Returns every STO from STO_MasterList that does NOT yet have a matching
 * row in S_Z04 — i.e. every STO still eligible to be Z04'd. Sorted
 * newest-raised-first (same convention as getSTOList()).
 *
 * The frontend caches this ENTIRE list client-side on login (and on a
 * manual "Refresh" click) and filters it locally as the operator types —
 * no server round-trip per keystroke. At this scale (hundreds, not
 * millions, of STOs) that keeps the combo-box instant.
 *
 * This is purely a UI convenience. addZ04Entry() below re-validates
 * existence-in-STO_MasterList and non-existence-in-S_Z04 independently,
 * so a stale cached list can never cause a bad write — only, at worst,
 * a confusing rejection message telling the operator to hit Refresh.
 */
function getEligibleSTOsForZ04(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  if (stoValues.length < 2) {
    return jsonResponse({ success: true, stos: [] });
  }
  const stoHeaders = stoValues[0];
  const stoCol = {};
  stoHeaders.forEach(function (h, idx) { stoCol[h] = idx; });

  // ---- Build the set of STO_Nos already Z04'd ----
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const alreadyZ04d = {};
  if (z04Values.length >= 2) {
    const z04Headers = z04Values[0];
    const z04StoCol = z04Headers.indexOf('STO_No');
    for (let i = 1; i < z04Values.length; i++) {
      alreadyZ04d[String(z04Values[i][z04StoCol]).trim()] = true;
    }
  }

  // ---- Filter STO_MasterList down to eligible rows only ----
  let eligible = [];
  for (let i = 1; i < stoValues.length; i++) {
    const row = stoValues[i];
    const stoNo = String(row[stoCol['STO_No']]).trim();
    if (alreadyZ04d[stoNo]) continue;
    eligible.push({
      stoNo: stoNo,
      stoDate: formatDateOut(row[stoCol['STO_Date']]),
      ucsCode: String(row[stoCol['UCS_Code']]).trim(),
      itemDescription: row[stoCol['Item_Description']],
      unit: row[stoCol['Unit']],
      orderedQty: row[stoCol['Qty']]
    });
  }

  // ---- Newest-raised first (reverse of sheet append order) ----
  eligible.reverse();

  return jsonResponse({ success: true, stos: eligible });
}

// ====== S_Z04: ON-DEMAND DETAIL LOOKUP (dashboard "Z04 Done" drill-down) ======

/**
 * Returns the single S_Z04 row for a given STO_No, for display in the STO
 * Dashboard's row-detail panel when the operator clicks a "Done" Z04 badge.
 * Deliberately narrow and on-demand (one row, fetched only when actually
 * opened) rather than bundled into every getSTOList() row -- mirrors the
 * project's "only expose specific, narrow actions" rule.
 */
function getZ04DetailsForSTO(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const stoNo = String(data.stoNo || '').trim();
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });

  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length < 2) {
    return jsonResponse({ success: false, message: 'No Z04 entry found for STO ' + stoNo + '.' });
  }
  const z04Headers = z04Values[0];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });

  for (let i = 1; i < z04Values.length; i++) {
    const row = z04Values[i];
    if (String(row[z04Col['STO_No']]).trim() === stoNo) {
      return jsonResponse({
        success: true,
        z04: {
          dateOfReceipt: formatDateOut(row[z04Col['Date_of_Receipt_Z04']]),
          qtyReceived: row[z04Col['Qty_Recieved_Z04']],
          matDocNo: String(row[z04Col['Mat_Doc_No_Z04']]).trim(),
          matReceivedBy: row[z04Col['Mat_Recieved_By']] || ''
        }
      });
    }
  }
  return jsonResponse({ success: false, message: 'No Z04 entry found for STO ' + stoNo + '.' });
}

// ====== S_Z04: LIVE MAT_DOC_NO UNIQUENESS CHECK ======

/**
 * Non-admin, read-only uniqueness check for Mat_Doc_No, mirroring
 * checkSTONoExists(). Mat_Doc_No is a SAP-generated document-traceability
 * number — a duplicate here is a genuine audit red flag, same severity
 * class as a duplicate STO_No, so it gets the same live-check treatment.
 *
 * Mat_Doc_No_Z04 (S_Z04) and Mat_Doc_No_201 (S_201) are real SAP document
 * numbers sharing ONE namespace, so this checks BOTH sheets — used by
 * both add-z04.html and add-201.html under the same action name.
 * addZ04Entry() / addS201Entry() still independently re-check uniqueness
 * (across both sheets) on actual submit.
 */
function checkMatDocNoExists(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const matDocNo = String(data.matDocNo || '').trim();
  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) {
    return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  if (matDocNoExistsAnywhere(matDocNo)) {
    return jsonResponse({ success: true, exists: true });
  }
  return jsonResponse({ success: true, exists: false });
}

/**
 * Shared helper: true if matDocNo already appears in EITHER Mat_Doc_No_Z04
 * (S_Z04) or Mat_Doc_No_201 (S_201). Used by both the live-check above and
 * the server-side re-check inside addZ04Entry()/addS201Entry().
 */
function matDocNoExistsAnywhere(matDocNo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const z04Sheet = ss.getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  if (z04Values.length >= 2) {
    const z04Headers = z04Values[0];
    const z04Col = z04Headers.indexOf('Mat_Doc_No_Z04');
    for (let i = 1; i < z04Values.length; i++) {
      if (String(z04Values[i][z04Col]).trim() === matDocNo) return true;
    }
  }

  const s201Sheet = ss.getSheetByName(S201_SHEET);
  if (s201Sheet) {
    const s201Values = s201Sheet.getDataRange().getValues();
    if (s201Values.length >= 2) {
      const s201Headers = s201Values[0];
      const s201Col = s201Headers.indexOf('Mat_Doc_No_201');
      for (let i = 1; i < s201Values.length; i++) {
        if (String(s201Values[i][s201Col]).trim() === matDocNo) return true;
      }
    }
  }

  return false;
}

// ====== S_Z04: ADD ENTRY ======
// STO_Date, UCS_Code, Item_Description, Unit, Ordered_Qty are ALWAYS
// pulled fresh from STO_MasterList at write time here -- never trusted
// from the client, even though the frontend also displays them (for
// operator context only). One Z04 entry per STO_No, ever -- enforced
// here regardless of what the type-ahead UI already filtered out.

function addZ04Entry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const stoNo = String(data.stoNo || '').trim();
  const dateOfReceiptStr = String(data.dateOfReceipt || '').trim();
  const qtyRecRaw = data.qtyReceived;
  const matDocNo = String(data.matDocNo || '').trim();
  const matReceivedBy = String(data.matReceivedBy || '').trim();

  // ---- Mandatory field validation ----
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) {
    return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  if (!dateOfReceiptStr) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) is required.' });
  const dateOfReceiptObj = parseDateOnly(dateOfReceiptStr);
  if (!dateOfReceiptObj) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) is invalid.' });
  const today = startOfToday();
  if (dateOfReceiptObj > today) return jsonResponse({ success: false, message: 'Date of Receipt (Z04) cannot be in the future.' });

  if (qtyRecRaw === undefined || qtyRecRaw === null || qtyRecRaw === '') {
    return jsonResponse({ success: false, message: 'Qty Received (Z04) is required.' });
  }
  const qtyReceived = Number(qtyRecRaw);
  if (isNaN(qtyReceived) || !Number.isInteger(qtyReceived) || qtyReceived < 0) {
    return jsonResponse({ success: false, message: 'Qty Received (Z04) must be a whole number, zero or greater (no negatives or decimals).' });
  }

  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) {
    return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  // ---- Pull & validate the STO from STO_MasterList (source of truth) ----
  const stoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const stoValues = stoSheet.getDataRange().getValues();
  const stoHeaders = stoValues[0];
  const stoCol = {};
  stoHeaders.forEach(function (h, idx) { stoCol[h] = idx; });

  let stoRow = null;
  for (let i = 1; i < stoValues.length; i++) {
    if (String(stoValues[i][stoCol['STO_No']]).trim() === stoNo) {
      stoRow = stoValues[i];
      break;
    }
  }
  if (!stoRow) {
    return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' was not found in STO_MasterList.' });
  }

  const stoDateMidnight = toMidnight(stoRow[stoCol['STO_Date']]);
  if (stoDateMidnight && dateOfReceiptObj < stoDateMidnight) {
    return jsonResponse({ success: false, message: 'Date of Receipt (Z04) cannot be earlier than the STO Date.' });
  }

  const orderedQty = Number(stoRow[stoCol['Qty']]);
  if (qtyReceived > orderedQty) {
    return jsonResponse({ success: false, message: 'Qty Received (Z04) cannot exceed the STO Ordered Qty (' + orderedQty + ').' });
  }

  const ucsCode = String(stoRow[stoCol['UCS_Code']]).trim();
  const itemDescription = stoRow[stoCol['Item_Description']];
  const unit = stoRow[stoCol['Unit']];

  // ---- S_Z04 sheet: uniqueness checks (STO_No AND Mat_Doc_No) ----
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const z04Headers = z04Values.length > 0 ? z04Values[0] : [
    'STO_No', 'STO_Date', 'UCS_Code', 'Item_Description', 'Unit', 'Ordered_Qty',
    'Date_of_Receipt_Z04', 'Qty_Recieved_Z04', 'Mat_Doc_No_Z04', 'Mat_Recieved_By'
  ];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });

  for (let i = 1; i < z04Values.length; i++) {
    if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) {
      return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has already been Z04\'d. Only one Z04 entry is allowed per STO.' });
    }
  }
  if (matDocNoExistsAnywhere(matDocNo)) {
    return jsonResponse({ success: false, message: 'Mat Doc No ' + matDocNo + ' already exists. Mat Doc Nos must be unique.' });
  }

  // ---- Append row, built by header position so column reordering never breaks this ----
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

  logAudit(
    login.name,
    data.email,
    'ADD_Z04_ENTRY',
    'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty Received (Z04): ' + qtyReceived + ' of ' + orderedQty +
      ' | Mat Doc No ' + matDocNo +
      (matReceivedBy ? ' | Received by ' + matReceivedBy : ' | Received by: (not recorded)') +
      (qtyReceived === 0 ? ' | ZERO QTY -- operator confirmed this deliberately' : '')
  );

  return jsonResponse({
    success: true,
    message: 'Z04 entry for STO ' + stoNo + ' saved successfully.'
  });
}

// ====== OPTIONS_LIST: GENERIC COLUMN-PER-CATEGORY READER/APPENDER ======
// Options_List is laid out as ONE CATEGORY PER COLUMN: the header row names
// the category (e.g. 'Area_201', 'Area_Planning_issue', 'Unit') and the
// values live below it, each column a different (ragged) length. This is
// NOT the generic Category+Value two-column design floated in early
// planning -- that plan predates this sheet actually being built; this is
// what's real, so the backend reads it as-is.
//
// Read = any STO-access user (dropdowns need it). Append = Admin only,
// and ONLY ever appends to the bottom of one specific column -- existing
// values in that column, and every other column, are never touched.

/** Returns the populated values (trimmed, header-matched, in sheet order) for one category/column. */
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
    if (v === '' || v === null || v === undefined) continue; // ragged columns: stop-worthy gaps just get skipped
    out.push(String(v).trim());
  }
  return out;
}

/** Frontend-facing: fetch one category's dropdown values. Gated by requireSTOAccess (same class of user as every STO/Z04/201 form). */
function getOptionsList(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;

  const category = String(data.category || '').trim();
  if (!category) return jsonResponse({ success: false, message: 'Category is required.' });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPTIONS_SHEET);
  if (!sheet) return jsonResponse({ success: false, message: 'Options_List sheet not found.' });
  const headers = sheet.getDataRange().getValues()[0] || [];
  if (headers.indexOf(category) === -1) {
    return jsonResponse({ success: false, message: 'Unknown Options_List category: ' + category });
  }

  return jsonResponse({ success: true, category: category, values: readOptionsColumn(category) });
}

/**
 * Admin-only: appends ONE new value to the bottom of an existing category
 * column. Never edits or deletes an existing value (there is no update
 * path here, deliberately, same as UCS_Code being permanent). Rejects an
 * exact duplicate (trimmed) so the same area can't accidentally end up
 * twice in one column.
 */
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
  if (colIdx === -1) {
    return jsonResponse({ success: false, message: 'Unknown Options_List category: ' + category + '. Categories are column headers and must already exist -- this function only appends values, it never creates a new category column.' });
  }

  // ---- Duplicate check (case-sensitive exact match, trimmed) ----
  let firstBlankRow = -1; // 0-indexed into `values`
  for (let i = 1; i < values.length; i++) {
    const cell = values[i][colIdx];
    if (cell === '' || cell === null || cell === undefined) {
      if (firstBlankRow === -1) firstBlankRow = i;
      continue;
    }
    if (String(cell).trim() === value) {
      return jsonResponse({ success: false, message: '"' + value + '" already exists under ' + category + '.' });
    }
  }

  // ---- Write to the first blank cell in THIS column, or one row past the end ----
  const targetRow = (firstBlankRow !== -1) ? firstBlankRow + 1 : values.length + 1; // 1-indexed for getRange
  sheet.getRange(targetRow, colIdx + 1).setValue(value);

  logAudit(login.name, data.email, 'ADD_OPTION_VALUE', 'Category ' + category + ' | Added value: ' + value);

  return jsonResponse({ success: true, message: '"' + value + '" added to ' + category + '.' });
}

// ====== S_201: ELIGIBLE Z04 LOOKUP (powers the type-ahead field) ======

/**
 * Returns every S_Z04 row that still has REMAINING balance to release,
 * i.e. Qty_Recieved_Z04 minus the sum of every Qty_Released_201 already
 * recorded against that STO_No in S_201. Once that remainder hits 0, the
 * STO drops out of this list entirely -- same "disappear on exhaustion"
 * behaviour as getEligibleSTOsForZ04() dropping STOs once they're Z04'd.
 *
 * Purely a UI convenience for the type-ahead cache; addS201Entry() below
 * independently recomputes the remaining balance from scratch server-side
 * on actual submit, so a stale cached list can never cause an over-release.
 */
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
    if (remaining <= 0) continue; // fully exhausted (or Z04 qty was 0) -- not eligible

    eligible.push({
      stoNo: stoNo,
      stoDate: formatDateOut(row[z04Col['STO_Date']]),
      ucsCode: String(row[z04Col['UCS_Code']]).trim(),
      itemDescription: row[z04Col['Item_Description']],
      unit: row[z04Col['Unit']],
      dateOfReceiptZ04: formatDateOut(row[z04Col['Date_of_Receipt_Z04']]),
      qtyRecievedZ04: qtyRecievedZ04,
      alreadyReleased: alreadyReleased,
      remaining: remaining
    });
  }

  eligible.reverse(); // newest-Z04'd-first, same convention as the other lists
  return jsonResponse({ success: true, stos: eligible });
}

/** Returns a map of STO_No -> total Qty_Released_201 already recorded in S_201. */
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

// ====== S_201: ON-DEMAND ENTRY LIST (dashboard "201 Done/Partial" drill-down) ======

/**
 * Returns every S_201 row for a given STO_No, oldest-first (the order the
 * releases actually happened in, so a running "cumulative so far" reads
 * naturally), plus the Z04 ceiling and live remaining balance for context.
 * Mirrors getZ04DetailsForSTO()'s "on-demand, only when the badge is
 * clicked" pattern -- narrow, read-only, no write path here.
 *
 * Unlike Z04 (1:1, so a single object is returned), 201 is 1:many, so this
 * returns an array. Only reachable from the dashboard when status201 is
 * 'done' or 'partial' (the badge isn't clickable otherwise, since there's
 * nothing to show yet) -- but this function itself doesn't assume that and
 * simply returns an empty array if no entries exist.
 */
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
      entries.push({
        dateOfRelease: formatDateOut(row[col['Date_of_Release']]),
        qtyReleased: row[col['Qty_Released_201']],
        matDocNo: String(row[col['Mat_Doc_No_201']]).trim(),
        releasedToArea: row[col['Released_to_Area']] || ''
      });
    }
  }
  // Oldest-first: S_201 rows are appended in release order, so this is
  // already chronological -- no reverse() needed (unlike the newest-first
  // lists elsewhere, which reverse append order on purpose).

  const totalReleased = entries.reduce(function (sum, e) { return sum + (Number(e.qtyReleased) || 0); }, 0);
  if (qtyRecievedZ04 === null) {
    // No S_201 rows yet for this STO -- pull the ceiling straight from S_Z04
    // instead, so the panel can still show "0 of N released" correctly.
    const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
    const z04Values = z04Sheet.getDataRange().getValues();
    if (z04Values.length >= 2) {
      const z04Headers = z04Values[0];
      const z04Col = {};
      z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });
      for (let i = 1; i < z04Values.length; i++) {
        if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) {
          qtyRecievedZ04 = Number(z04Values[i][z04Col['Qty_Recieved_Z04']]) || 0;
          break;
        }
      }
    }
  }
  qtyRecievedZ04 = qtyRecievedZ04 === null ? 0 : qtyRecievedZ04;

  return jsonResponse({
    success: true,
    entries: entries,
    qtyRecievedZ04: qtyRecievedZ04,
    totalReleased: totalReleased,
    remaining: qtyRecievedZ04 - totalReleased
  });
}

// ====== S_201: ADD ENTRY ======
// STO_Date, UCS_Code, Item_Description, Unit, Qty_Recieved_Z04,
// Date_of_Receipt_Z04 are ALWAYS pulled fresh from S_Z04 at write time --
// never trusted from the client. The remaining balance is likewise always
// recomputed fresh from S_201 itself, never trusted from the client's
// cached eligible-list snapshot -- this is what makes it safe for two
// people to be releasing against the same Z04'd STO at the same time.

function addS201Entry(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const stoNo = String(data.stoNo || '').trim();
  const qtyReleasedRaw = data.qtyReleased;
  const matDocNo = String(data.matDocNo || '').trim();
  const dateOfReleaseStr = String(data.dateOfRelease || '').trim();
  const releasedToArea = String(data.releasedToArea || '').trim();

  // ---- Mandatory field validation ----
  if (!stoNo) return jsonResponse({ success: false, message: 'STO No is required.' });
  if (!/^[1-9]\d{9}$/.test(stoNo)) {
    return jsonResponse({ success: false, message: 'STO No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  if (qtyReleasedRaw === undefined || qtyReleasedRaw === null || qtyReleasedRaw === '') {
    return jsonResponse({ success: false, message: 'Qty Released is required.' });
  }
  const qtyReleased = Number(qtyReleasedRaw);
  if (isNaN(qtyReleased) || !Number.isInteger(qtyReleased) || qtyReleased <= 0) {
    return jsonResponse({ success: false, message: 'Qty Released must be a whole number greater than zero.' });
  }

  if (!matDocNo) return jsonResponse({ success: false, message: 'Mat Doc No is required.' });
  if (!/^[1-9]\d{9}$/.test(matDocNo)) {
    return jsonResponse({ success: false, message: 'Mat Doc No must be exactly 10 digits, numbers only, and cannot start with 0.' });
  }

  if (!dateOfReleaseStr) return jsonResponse({ success: false, message: 'Date of Release is required.' });
  const dateOfReleaseObj = parseDateOnly(dateOfReleaseStr);
  if (!dateOfReleaseObj) return jsonResponse({ success: false, message: 'Date of Release is invalid.' });
  const today = startOfToday();
  if (dateOfReleaseObj > today) return jsonResponse({ success: false, message: 'Date of Release cannot be in the future.' });

  if (!releasedToArea) return jsonResponse({ success: false, message: 'Released to Area is required.' });

  // ---- Released_to_Area must be one of the current Options_List values (server-side, never trust the client's dropdown) ----
  const validAreas = readOptionsColumn('Area_201');
  if (validAreas.indexOf(releasedToArea) === -1) {
    return jsonResponse({ success: false, message: 'Released to Area "' + releasedToArea + '" is not a recognized area. Refresh the list and try again.' });
  }

  // ---- Pull & validate the parent Z04 record from S_Z04 (source of truth) ----
  const z04Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Z04_SHEET);
  const z04Values = z04Sheet.getDataRange().getValues();
  const z04Headers = z04Values[0];
  const z04Col = {};
  z04Headers.forEach(function (h, idx) { z04Col[h] = idx; });

  let z04Row = null;
  for (let i = 1; i < z04Values.length; i++) {
    if (String(z04Values[i][z04Col['STO_No']]).trim() === stoNo) {
      z04Row = z04Values[i];
      break;
    }
  }
  if (!z04Row) {
    return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has no Z04 entry yet -- it must be Z04\'d before material can be released against it.' });
  }

  const dateOfReceiptZ04Midnight = toMidnight(z04Row[z04Col['Date_of_Receipt_Z04']]);
  if (dateOfReceiptZ04Midnight && dateOfReleaseObj < dateOfReceiptZ04Midnight) {
    return jsonResponse({ success: false, message: 'Date of Release cannot be earlier than the Z04 Date of Receipt.' });
  }

  const qtyRecievedZ04 = Number(z04Row[z04Col['Qty_Recieved_Z04']]);
  const ucsCode = String(z04Row[z04Col['UCS_Code']]).trim();
  const itemDescription = z04Row[z04Col['Item_Description']];
  const unit = z04Row[z04Col['Unit']];

  // ---- Recompute remaining balance fresh from S_201 (never trust client's cached snapshot) ----
  const releasedByStoNo = sumReleasedByStoNo();
  const alreadyReleased = releasedByStoNo[stoNo] || 0;
  const remaining = qtyRecievedZ04 - alreadyReleased;

  if (remaining <= 0) {
    return jsonResponse({ success: false, message: 'STO No ' + stoNo + ' has already been fully released (nothing remaining against its Z04 Qty of ' + qtyRecievedZ04 + ').' });
  }
  if (qtyReleased > remaining) {
    return jsonResponse({ success: false, message: 'Qty Released cannot exceed the remaining balance (' + remaining + ' of ' + qtyRecievedZ04 + ' left).' });
  }

  // ---- Mat Doc No uniqueness: shared namespace across S_Z04 and S_201 ----
  if (matDocNoExistsAnywhere(matDocNo)) {
    return jsonResponse({ success: false, message: 'Mat Doc No ' + matDocNo + ' already exists. Mat Doc Nos must be unique.' });
  }

  // ---- Append row, built by header position so column reordering never breaks this ----
  const s201Sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(S201_SHEET);
  const s201Values = s201Sheet.getDataRange().getValues();
  const s201Headers = s201Values.length > 0 ? s201Values[0] : [
    'STO_No', 'STO_Date', 'UCS_Code', 'Item_Description', 'Unit', 'Qty_Recieved_Z04',
    'Date_of_Receipt_Z04', 'Qty_Released_201', 'Mat_Doc_No_201', 'Date_of_Release', 'Released_to_Area'
  ];
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
  logAudit(
    login.name,
    data.email,
    'ADD_201_ENTRY',
    'STO ' + stoNo + ' | UCS ' + ucsCode + ' | Qty Released: ' + qtyReleased +
      ' | Mat Doc No ' + matDocNo + ' | Released to: ' + releasedToArea +
      ' | Remaining after this entry: ' + newRemaining + ' of ' + qtyRecievedZ04 +
      (newRemaining === 0 ? ' (FULLY EXHAUSTED)' : '')
  );

  return jsonResponse({
    success: true,
    message: '201 entry for STO ' + stoNo + ' saved successfully. Remaining: ' + newRemaining + ' of ' + qtyRecievedZ04 + '.',
    remaining: newRemaining
  });
}

// ====== AUDIT LOG ======

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

// ====== REQUISITION MODULE: ACCESS CONTROL ======
// See REQUISITION_MODULE_SPEC.md for the full design writeup.

/** Area-scoped: can this person raise a requisition for THIS specific area? */
function canRaiseRequisition(area, authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, area) &&
    (hasCommaValue(roleString, 'Area Store Supervisor') || hasCommaValue(roleString, 'Area Incharge'));
}

/**
 * Area-scoped: is this person an Area Incharge for THIS specific area?
 * Incharge privilege is ONE-DIRECTIONAL: it lets an Incharge fast-track a
 * raise (absorbing the Supervisor's step), but a Supervisor can never
 * absorb the Incharge's approve step. If someone holds both roles for the
 * same area, Incharge wins outright -- callers check this FIRST.
 */
function isAreaInchargeForArea(area, authorizedAreaString, roleString) {
  return hasCommaValue(authorizedAreaString, area) && hasCommaValue(roleString, 'Area Incharge');
}

/** Global, NOT area-scoped (confirmed) -- matches the existing isApprover() pattern. */
function canSanctionRequisition(roleString) {
  return hasCommaValue(roleString, 'Approver');
}

/** Global, NOT area-scoped (confirmed) -- Store Incharge works the one physical Planning Store. */
function canIssueRequisition(roleString) {
  return hasCommaValue(roleString, 'Store Incharge');
}

/** 'YYYYMMDD' for a Date, for building Slip_IDs. */
function formatDateYYYYMMDD_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return '' + y + m + d;
}

/**
 * Server-generated Slip_ID: {Area}{YYYYMMDD}-{XY}, XY = 2-digit serial,
 * per (Area, Date). NOT self-locking -- the caller (raiseRequisition) already
 * holds the script lock for the whole raise operation, so this just does the
 * read+compute against sheet data fetched under that same lock.
 */
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
  if (next > 99) {
    throw new Error('Maximum 99 requisition slips per area per day reached for ' + area + ' on ' + dateYYYYMMDD + '.');
  }
  return prefix + String(next).padStart(2, '0');
}

/** All Detail rows for a given Slip_ID, as { Detail_ID: rowIndex (0-indexed into `values`) }. */
function getDetailRowIndexesForSlip_(detailsValues, dCol, slipId) {
  const map = {};
  for (let i = 1; i < detailsValues.length; i++) {
    if (String(detailsValues[i][dCol['Slip_ID']]) === slipId) {
      map[String(detailsValues[i][dCol['Detail_ID']])] = i;
    }
  }
  return map;
}

/** Header+Details joined, filtered to one Slip_Status. Shared by the three "pending" list endpoints. */
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
    slipInfo[String(row[hCol['Slip_ID']])] = {
      area: row[hCol['Area']],
      raisedByName: row[hCol['Raised_By_Name']],
      slipDate: formatDateOut(row[hCol['Slip_Date']])
    };
  }

  const detailsSheet = ss.getSheetByName(REQ_DETAILS_SHEET);
  const detailsValues = detailsSheet.getDataRange().getValues();
  const dHeaders = detailsValues[0];
  const dCol = {};
  dHeaders.forEach(function (h, idx) { dCol[h] = idx; });

  // Live balance, fetched fresh on every call (page load / poll) -- never cached
  // or carried over from Raise time. Per REQUISITION_MODULE_SPEC.md Section 6,
  // "Available at Planning" must stay visible and current all the way through Issue.
  const stockMap = computePlanningStockMap_();

  const out = [];
  for (let i = 1; i < detailsValues.length; i++) {
    const row = detailsValues[i];
    if (String(row[dCol['Slip_Status']]) !== status) continue;
    const slipId = String(row[dCol['Slip_ID']]);
    const info = slipInfo[slipId] || {};
    const ucsCode = String(row[dCol['UCS_Code']]).trim();
    out.push({
      detailId: row[dCol['Detail_ID']],
      slipId: slipId,
      area: info.area || '',
      raisedByName: info.raisedByName || '',
      slipDate: info.slipDate || '',
      ucsCode: row[dCol['UCS_Code']],
      itemDescription: row[dCol['Item_Description']],
      unit: row[dCol['Unit']],
      qtyRequested: row[dCol['Qty_Requested']],
      qtyApproved: row[dCol['Qty_Approved']],
      qtySanctioned: row[dCol['Qty_Sanctioned']],
      qtyIssued: row[dCol['Qty_Issued']],
      availableAtPlanning: stockMap[ucsCode] ? stockMap[ucsCode].balance : 0
    });
  }
  return out;
}

// ====== REQUISITION MODULE: RAISE ======

/**
 * data: { email, password, area, items: [{ ucsCode, qty }] }  (1-10 items)
 *
 * Supervisor-for-this-area  -> Qty_Requested only, Slip_Status = Pending Area Approval.
 * Incharge-for-this-area    -> fast-track: Qty_Requested AND Qty_Approved both set,
 *                              Slip_Status jumps straight to Pending Planning Approval.
 * Incharge always wins if someone holds both roles for the area (one-directional rule).
 */
function raiseRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!canRaiseRequisition(area, login.authorizedArea, login.role)) {
    return jsonResponse({ success: false, message: 'You are not authorized to raise requisitions for ' + area + '.' });
  }
  const isFastTrack = isAreaInchargeForArea(area, login.authorizedArea, login.role);

  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'At least one material line is required.' });
  if (items.length > 10) return jsonResponse({ success: false, message: 'A requisition slip cannot have more than 10 materials.' });

  // ---- Validate + snapshot each UCS code (never trust client-supplied description/unit) ----
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
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': Quantity must be a positive whole number.' });
    }
    let found = null;
    for (let r = 1; r < ucsValues.length; r++) {
      if (String(ucsValues[r][ucsCodeCol]).trim() === ucsCode) { found = ucsValues[r]; break; }
    }
    if (!found) return jsonResponse({ success: false, message: 'Line ' + (i + 1) + ': UCS Code ' + ucsCode + ' not found.' });
    resolvedItems.push({
      ucsCode: ucsCode,
      itemDescription: found[ucsShortCol],
      unit: found[ucsUnitCol],
      qty: qty
    });
  }

  // Stock-cap enforcement + slip creation happen together under one lock, so two
  // people raising slips for the same UCS Code at the same instant can't both
  // pass the balance check before either one writes (the same class of race the
  // Issue-time lock closes, just at the other end of the workflow).
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const stockMap = computePlanningStockMap_();
    for (let i = 0; i < resolvedItems.length; i++) {
      const it = resolvedItems[i];
      const available = stockMap[it.ucsCode] ? stockMap[it.ucsCode].balance : 0;
      if (it.qty > available) {
        return jsonResponse({
          success: false,
          message: 'Line ' + (i + 1) + ' (' + it.ucsCode + '): requested qty ' + it.qty +
            ' exceeds available Planning stock of ' + available + '. Reduce the quantity or remove this line.'
        });
      }
    }

    const now = new Date();
    const dateStr = formatDateYYYYMMDD_(now);
    const slipId = getNextSlipSerial_(area, dateStr);
    const initialStatus = isFastTrack ? 'Pending Planning Approval' : 'Pending Area Approval';

    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerHeaders = headerSheet.getDataRange().getValues()[0];
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
    const detailsHeaders = detailsSheet.getDataRange().getValues()[0];

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
    detailsSheet.appendRow(row);
      const newRow = detailsSheet.getLastRow();
      detailsSheet.getRange(newRow, getColIndexOrThrow_(detailsHeaders, 'Slip_ID', REQ_DETAILS_SHEET) + 1).setNumberFormat('@STRING@');
      detailsSheet.getRange(newRow, getColIndexOrThrow_(detailsHeaders, 'UCS_Code', REQ_DETAILS_SHEET) + 1).setNumberFormat('@STRING@');
    });

    logAudit(login.name, data.email, 'RAISE_REQUISITION',
      'Slip ' + slipId + ' | Area ' + area + ' | ' + resolvedItems.length + ' item(s): ' +
      resolvedItems.map(function (it) { return it.ucsCode + ' x' + it.qty; }).join(', '));

    if (isFastTrack) {
      logAudit(login.name, data.email, 'AREA_APPROVE_REQUISITION',
        'Slip ' + slipId + ' | Fast-tracked by Area Incharge (Supervisor absent) -- approved at requested quantities in the same action.');
    }

    return jsonResponse({
      success: true,
      message: 'Requisition slip ' + slipId + ' raised successfully.' + (isFastTrack ? ' Auto-approved and forwarded to Sanction.' : ''),
      slipId: slipId
    });
  } finally {
    lock.releaseLock();
  }
}

// ====== REQUISITION MODULE: AREA APPROVAL ======

function getPendingAreaApprovals(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!hasCommaValue(login.role, 'Area Incharge')) {
    return jsonResponse({ success: false, message: 'Only Area Incharges can view pending area approvals.' });
  }
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const rows = getRequisitionRowsByStatus_('Pending Area Approval').filter(function (r) { return myAreas.indexOf(r.area) !== -1; });
  return jsonResponse({ success: true, items: rows });
}

/**
 * data: { email, password, slipId, items: [{ detailId, qtyApproved }] }
 * MUST include every item on the slip in one call -- the whole slip advances together.
 */
function approveAreaRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const slipId = String(data.slipId || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to approve.' });

  // Whole read-check-write cycle happens under one lock, re-reading the sheet
  // fresh once the lock is held -- otherwise two Area Incharges (or the same
  // one, double-tapping) could both read "Pending Area Approval" before either
  // writes, and both would advance the same slip.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) {
      if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; }
    }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const area = headerValues[headerRowIdx][hCol['Area']];
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];

    if (!isAreaInchargeForArea(area, login.authorizedArea, login.role)) {
      return jsonResponse({ success: false, message: 'You are not authorized to approve requisitions for ' + area + '.' });
    }
    if (currentStatus !== 'Pending Area Approval') {
      return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending area approval (current status: ' + currentStatus + '). It may have already been actioned by someone else.' });
    }

    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) {
      return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once (whole-slip approval).' });
    }

    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtyApproved = Number(items[k].qtyApproved);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const requested = Number(detailsValues[rowIdx][dCol['Qty_Requested']]);
      if (!Number.isFinite(qtyApproved) || qtyApproved < 0 || !Number.isInteger(qtyApproved)) {
        return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' must be zero or a positive whole number.' });
      }
      if (qtyApproved > requested) {
        return jsonResponse({ success: false, message: 'Approved qty for ' + detailId + ' (' + qtyApproved + ') cannot exceed requested qty (' + requested + ').' });
      }
      writes.push({ rowIdx: rowIdx, qtyApproved: qtyApproved });
    }

    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      detailsSheet.getRange(sheetRow, dCol['Qty_Approved'] + 1).setValue(w.qtyApproved);
      detailsSheet.getRange(sheetRow, dCol['Approved_By'] + 1).setValue(login.name);
      detailsSheet.getRange(sheetRow, dCol['Approved_Timestamp'] + 1).setValue(now);
      detailsSheet.getRange(sheetRow, dCol['Slip_Status'] + 1).setValue('Pending Planning Approval');
    });
    headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Pending Planning Approval');

    logAudit(login.name, data.email, 'AREA_APPROVE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | Approved qty set for ' + writes.length + ' item(s).');
    return jsonResponse({ success: true, message: 'Slip ' + slipId + ' approved and forwarded to Sanction.' });
  } finally {
    lock.releaseLock();
  }
}

// ====== REQUISITION MODULE: SANCTION ======

function getPendingSanctions(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  if (!canSanctionRequisition(check.login.role)) {
    return jsonResponse({ success: false, message: 'Only Approvers can view pending sanctions.' });
  }
  return jsonResponse({ success: true, items: getRequisitionRowsByStatus_('Pending Planning Approval') });
}

/**
 * data: { email, password, slipId, items: [{ detailId, qtySanctioned }] }
 * Global role, NOT area-scoped (confirmed). MUST include every item on the slip.
 */
function sanctionRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!canSanctionRequisition(login.role)) {
    return jsonResponse({ success: false, message: 'Only Approvers can sanction requisitions.' });
  }

  const slipId = String(data.slipId || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to sanction.' });

  // Same reasoning as approveAreaRequisition: read, check, and write all under
  // one lock so two Approvers can't both act on the same slip concurrently.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) {
      if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; }
    }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];
    if (currentStatus !== 'Pending Planning Approval') {
      return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending sanction (current status: ' + currentStatus + ').' });
    }

    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) {
      return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once.' });
    }

    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtySanctioned = Number(items[k].qtySanctioned);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const approved = Number(detailsValues[rowIdx][dCol['Qty_Approved']]);
      if (!Number.isFinite(qtySanctioned) || qtySanctioned < 0 || !Number.isInteger(qtySanctioned)) {
        return jsonResponse({ success: false, message: 'Sanctioned qty for ' + detailId + ' must be zero or a positive whole number.' });
      }
      if (qtySanctioned > approved) {
        return jsonResponse({ success: false, message: 'Sanctioned qty for ' + detailId + ' (' + qtySanctioned + ') cannot exceed approved qty (' + approved + ').' });
      }
      writes.push({ rowIdx: rowIdx, qtySanctioned: qtySanctioned });
    }

    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      detailsSheet.getRange(sheetRow, dCol['Qty_Sanctioned'] + 1).setValue(w.qtySanctioned);
      detailsSheet.getRange(sheetRow, dCol['Sanctioned_By'] + 1).setValue(login.name);
      detailsSheet.getRange(sheetRow, dCol['Sanctioned_Timestamp'] + 1).setValue(now);
      detailsSheet.getRange(sheetRow, dCol['Slip_Status'] + 1).setValue('Pending Issue');
    });
    headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Pending Issue');

    logAudit(login.name, data.email, 'SANCTION_REQUISITION', 'Slip ' + slipId + ' | Sanctioned qty set for ' + writes.length + ' item(s).');
    return jsonResponse({ success: true, message: 'Slip ' + slipId + ' sanctioned and forwarded for Issue.' });
  } finally {
    lock.releaseLock();
  }
}

// ====== REQUISITION MODULE: ISSUE ======

function getPendingIssues(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  if (!canIssueRequisition(check.login.role)) {
    return jsonResponse({ success: false, message: 'Only Store Incharge can view pending issues.' });
  }
  return jsonResponse({ success: true, items: getRequisitionRowsByStatus_('Pending Issue') });
}

/**
 * data: { email, password, slipId, issuedTo, items: [{ detailId, qtyIssued }] }
 * Global role, NOT area-scoped. Issued_To is ONE value for the whole slip
 * (the whole slip is physically handed to one person). MUST include every item.
 */
function issueRequisition(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;
  if (!canIssueRequisition(login.role)) {
    return jsonResponse({ success: false, message: 'Only Store Incharge can issue requisitions.' });
  }

  const slipId = String(data.slipId || '').trim();
  const issuedTo = String(data.issuedTo || '').trim();
  if (!slipId) return jsonResponse({ success: false, message: 'Slip_ID is required.' });
  if (!issuedTo) return jsonResponse({ success: false, message: 'Issued To (name of person collecting) is required.' });
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return jsonResponse({ success: false, message: 'No items to issue.' });

  // Whole read-check-write cycle (including the stock-cap re-check) happens
  // under one lock -- same reasoning as the other three requisition actions:
  // status must be re-read fresh under the lock, not just the stock balance,
  // or two Store Incharges could both pass the "Pending Issue" check before
  // either writes and double-issue the same slip.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const headerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_HEADER_SHEET);
    const headerValues = headerSheet.getDataRange().getValues();
    const hHeaders = headerValues[0];
    const hCol = {};
    hHeaders.forEach(function (h, idx) { hCol[h] = idx; });

    let headerRowIdx = -1;
    for (let i = 1; i < headerValues.length; i++) {
      if (String(headerValues[i][hCol['Slip_ID']]) === slipId) { headerRowIdx = i; break; }
    }
    if (headerRowIdx === -1) return jsonResponse({ success: false, message: 'Slip ' + slipId + ' not found.' });
    const area = headerValues[headerRowIdx][hCol['Area']];
    const currentStatus = headerValues[headerRowIdx][hCol['Slip_Status']];
    if (currentStatus !== 'Pending Issue') {
      return jsonResponse({ success: false, message: 'Slip ' + slipId + ' is no longer pending issue (current status: ' + currentStatus + ').' });
    }

    const detailsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQ_DETAILS_SHEET);
    const detailsValues = detailsSheet.getDataRange().getValues();
    const dHeaders = detailsValues[0];
    const dCol = {};
    dHeaders.forEach(function (h, idx) { dCol[h] = idx; });
    const rowIdxByDetailId = getDetailRowIndexesForSlip_(detailsValues, dCol, slipId);
    const detailIds = Object.keys(rowIdxByDetailId);
    if (items.length !== detailIds.length) {
      return jsonResponse({ success: false, message: 'This action must include all ' + detailIds.length + ' item(s) on slip ' + slipId + ' at once.' });
    }

    const now = new Date();
    const writes = [];
    for (let k = 0; k < items.length; k++) {
      const detailId = String(items[k].detailId || '').trim();
      const qtyIssued = Number(items[k].qtyIssued);
      const rowIdx = rowIdxByDetailId[detailId];
      if (rowIdx === undefined) return jsonResponse({ success: false, message: 'Detail row ' + detailId + ' not found on slip ' + slipId + '.' });
      const sanctioned = Number(detailsValues[rowIdx][dCol['Qty_Sanctioned']]);
      if (!Number.isFinite(qtyIssued) || qtyIssued < 0 || !Number.isInteger(qtyIssued)) {
        return jsonResponse({ success: false, message: 'Issued qty for ' + detailId + ' must be zero or a positive whole number.' });
      }
      if (qtyIssued > sanctioned) {
        return jsonResponse({ success: false, message: 'Issued qty for ' + detailId + ' (' + qtyIssued + ') cannot exceed sanctioned qty (' + sanctioned + ').' });
      }
      writes.push({
        rowIdx: rowIdx,
        qtyIssued: qtyIssued,
        ucsCode: detailsValues[rowIdx][dCol['UCS_Code']],
        itemDescription: detailsValues[rowIdx][dCol['Item_Description']],
        unit: detailsValues[rowIdx][dCol['Unit']]
      });
    }

    // Final stock-cap re-check, fresh, inside the same lock -- so two Store
    // Incharges issuing at the same moment can never together push a UCS
    // Code's Planning balance negative. The dashboard's displayed number is a
    // live call at page load, but that alone can't prevent a race between two
    // concurrent submissions -- this lock is the actual guarantee.
    const stockMap = computePlanningStockMap_();
    const neededByCode = {};
    writes.forEach(function (w) {
      const code = String(w.ucsCode).trim();
      neededByCode[code] = (neededByCode[code] || 0) + w.qtyIssued;
    });
    for (const code in neededByCode) {
      const available = stockMap[code] ? stockMap[code].balance : 0;
      if (neededByCode[code] > available) {
        return jsonResponse({
          success: false,
          message: code + ': only ' + available + ' available at Planning right now -- cannot issue ' + neededByCode[code] +
            '. Stock may have moved since this page loaded; refresh and try again.'
        });
      }
    }

    return finishIssueRequisition_(data, login, slipId, area, issuedTo, headerSheet, headerRowIdx, hCol, detailsSheet, dCol, writes, now);
  } finally {
    lock.releaseLock();
  }
}

function finishIssueRequisition_(data, login, slipId, area, issuedTo, headerSheet, headerRowIdx, hCol, detailsSheet, dCol, writes, now) {
  writes.forEach(function (w) {
    const sheetRow = w.rowIdx + 1;
    detailsSheet.getRange(sheetRow, dCol['Qty_Issued'] + 1).setValue(w.qtyIssued);
    detailsSheet.getRange(sheetRow, dCol['Issued_To'] + 1).setValue(issuedTo);
    detailsSheet.getRange(sheetRow, dCol['Issued_By'] + 1).setValue(login.name);
    detailsSheet.getRange(sheetRow, dCol['Issued_Timestamp'] + 1).setValue(now);
    detailsSheet.getRange(sheetRow, dCol['Slip_Status'] + 1).setValue('Completed');
  });
  headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Completed');

  // ---- Permanent issue ledger: one row per item, including zero-qty rows ----
  const ledgerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ISSUE_LEDGER_SHEET);
  const ledgerHeaders = ledgerSheet.getDataRange().getValues()[0];

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
    ledgerSheet.appendRow(row);
    ledgerSheet.getRange(ledgerSheet.getLastRow(), getColIndexOrThrow_(ledgerHeaders, 'UCS_Code', ISSUE_LEDGER_SHEET) + 1).setNumberFormat('@STRING@');
  });

  logAudit(login.name, data.email, 'ISSUE_REQUISITION',
    'Slip ' + slipId + ' | Area ' + area + ' | Issued to: ' + issuedTo + ' | ' + writes.length + ' item(s): ' +
    writes.map(function (w) { return w.ucsCode + ' x' + w.qtyIssued; }).join(', '));

  // Snapshot refresh (PLNG_STOCK / AREA_STOCK) intentionally NOT triggered
  // here anymore -- nothing in the web app reads those sheets (every live
  // dashboard recomputes fresh via computePlanningStockMap_/
  // computeAreaStockMap_ directly), so this was pure latency on the
  // critical path for zero user-visible benefit. The 30-minute timer
  // trigger (setupPlanningStockTrigger/setupAreaStockTrigger) still keeps
  // the snapshot sheets current for anyone browsing the raw spreadsheet,
  // and the "Refresh" button on each dashboard (refreshPlanningStockEndpoint/
  // refreshAreaStockEndpoint) still forces it instantly on demand.

  return jsonResponse({ success: true, message: 'Slip ' + slipId + ' issued to ' + issuedTo + '. Requisition completed.' });
}

// ====== REQUISITION MODULE: RAISER'S OWN VIEW (read-only, matches "he can View" lock rule) ======

/**
 * Filtered by AREA membership (login's own Authorized_Area list), NOT by
 * who raised each slip -- deliberate: two people can share a section (e.g.
 * Store and Ravindra both in Planning) and both should see everything
 * raised for that section, not just their own submissions.
 */
function getAreaRequisitions(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (myAreas.length === 0) {
    return jsonResponse({ success: true, items: [] });
  }

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
    slipInfo[slipId] = {
      area: area,
      slipDate: formatDateOut(headerValues[i][hCol['Slip_Date']]),
      raisedByName: headerValues[i][hCol['Raised_By_Name']]
    };
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
    items.push({
      slipId: slipId,
      area: info.area,
      slipDate: info.slipDate,
      raisedByName: info.raisedByName,
      ucsCode: row[dCol['UCS_Code']],
      itemDescription: row[dCol['Item_Description']],
      unit: row[dCol['Unit']],
      qtyRequested: row[dCol['Qty_Requested']],
      qtyApproved: row[dCol['Qty_Approved']],
      qtySanctioned: row[dCol['Qty_Sanctioned']],
      qtyIssued: row[dCol['Qty_Issued']],
      issuedTo: row[dCol['Issued_To']],
      status: row[dCol['Slip_Status']]
    });
  }
  return jsonResponse({ success: true, items: items });
}

// ====== PLANNING STOCK: COMPUTED IN APPS SCRIPT, NOT LIVE FORMULAS ======

/**
 * Single pass each over S_Z04, S_201, and PLNG_ISSUE_SHEET (never one pass
 * PER UCS code) -> { UCS_Code: { received, released, balance } }.
 * Replicates the PLNG_STOCK sheet's verified formulas exactly:
 *   received = SUM(S_Z04.Qty_Recieved_Z04) by UCS_Code
 *   released = SUM(S_201.Qty_Released_201 WHERE Released_to_Area != 'Planning')
 *            + SUM(PLNG_ISSUE_SHEET.Issue_Qty)   -- every row counts, incl. Area='Planning'
 *   balance  = received - released
 */
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

/**
 * Overwrites PLNG_STOCK columns Qty_Recieved_at_Planning / Qty_Released_to_shop /
 * Qty_Balance as PLAIN VALUES (batch-written, not cell-by-cell) -- no formulas,
 * so nothing breaks from an accidental keystroke. Not the source of truth for
 * anything safety-critical (see computePlanningStockMap_ above) -- this is a
 * browsable snapshot only.
 *
 * IMPORTANT: the three header-name literals below (Qty_Recieved_at_Planning,
 * Qty_Released_to_shop, Qty_Balance) are my best read of your screenshot --
 * please confirm they match the ACTUAL header cell text exactly (retype if
 * unsure) before relying on this, per Bug Pattern 3 in your own debugging guide.
 */
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

/** Web-facing manual refresh, e.g. a "Refresh" button on a dashboard page. */
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

/** Live stock dashboard feed -- always fresh, never reads the PLNG_STOCK cells. */
function getPlanningStockList(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;

  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);

  const map = computePlanningStockMap_();
  const items = [];
  for (let i = 1; i < ucsValues.length; i++) {
    const code = String(ucsValues[i][ucsCodeCol]).trim();
    if (!code) continue;
    const entry = map[code] || { received: 0, released: 0, balance: 0 };
    items.push({
      ucsCode: code,
      itemDescription: ucsValues[i][ucsShortCol],
      unit: ucsValues[i][ucsUnitCol],
      received: entry.received,
      released: entry.released,
      balance: entry.balance
    });
  }
  return jsonResponse({ success: true, items: items });
}

/**
 * Parses an optional 'YYYY-MM-DD' filter bound into a midnight Date, or null
 * if blank/missing. Reuses parseDateOnly()'s strict format check.
 */
function parseOptionalDateBound_(str) {
  if (!str) return null;
  return parseDateOnly(str);
}

/** True if `d` (a Date or date-like cell value) falls within [from, to] inclusive; null bounds are open-ended. */
function withinDateRange_(cellVal, from, to) {
  if (!from && !to) return true;
  const d = toMidnight(cellVal);
  if (!d) return true; // don't silently drop rows with unparseable/blank dates -- only date-range filtering is best-effort here
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Area-scoped: can this person view UCS Code movement history for THIS
 * specific area? Deliberately reuses canRaiseRequisition()'s exact rule --
 * same population as canRecordLocalIssue(): the people running an area day
 * to day are the ones who'd need to check its own movement history, without
 * needing to call Planning for it.
 */
function canViewAreaUCSHistory(area, authorizedAreaString, roleString) {
  return canRaiseRequisition(area, authorizedAreaString, roleString);
}

/**
 * Full cross-sheet history for one UCS Code. Two access levels, per the
 * project owner's explicit call:
 *
 *   - PLANNING STAFF (Authorized_Area contains 'Planning'): unrestricted --
 *     any area (or none, for the cross-area total), full STO/Z04/201/Issue/
 *     Local Issue detail, exactly as before.
 *   - AREA STORE SUPERVISOR / AREA INCHARGE (canViewAreaUCSHistory): may
 *     request ONLY one of their own areas -- required, not optional, no
 *     cross-area or "all areas" option. STO_MasterList and S_Z04 are NEVER
 *     returned to this scope (Planning's own procurement paperwork, before
 *     material even reaches any area) -- returned as an explicit
 *     stoZ04Available: false rather than silently empty arrays, so the
 *     frontend can say why rather than looking broken. The chart for this
 *     scope is relabeled inflow ("received into the area") vs consumed
 *     ("issued locally") -- Planning's own received-vs-released framing
 *     doesn't apply at area level.
 *
 * Neither login type may see any area/scope beyond what's spelled out
 * above -- enforced HERE, server-side, same as every other area gate in
 * this file.
 */
function getUCSCodeHistory(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return jsonResponse(login);

  const ucsCode = String(data.ucsCode || '').trim();
  if (!ucsCode) return jsonResponse({ success: false, message: 'UCS Code is required.' });

  const requestedArea = String(data.area || '').trim();
  const isPlanning = isPlanningAreaStaff(login.authorizedArea);

  let scope, areaFilter, includeStoZ04;
  if (isPlanning) {
    scope = 'full';
    areaFilter = requestedArea; // optional -- '' means all areas, exactly as before
    includeStoZ04 = true;
  } else {
    if (!requestedArea) {
      return jsonResponse({ success: false, message: 'Area is required.' });
    }
    if (!canViewAreaUCSHistory(requestedArea, login.authorizedArea, login.role)) {
      return jsonResponse({ success: false, message: 'You are not authorized to view history for ' + requestedArea + '.' });
    }
    scope = 'area';
    areaFilter = requestedArea; // forced -- cannot be widened or blanked by the client
    includeStoZ04 = false;
  }

  const fromDate = parseOptionalDateBound_(data.fromDate);
  const toDate = parseOptionalDateBound_(data.toDate);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // NOTE: bucket meaning flips with scope -- see chart assembly at the bottom.
  //   scope 'full': monthlyReceived = Z04 receipts into Planning; monthlyReleased = S_201 + PLNG_ISSUE_SHEET (out of Planning)
  //   scope 'area': monthlyReleased = S_201 + PLNG_ISSUE_SHEET (INTO this area); monthlyReceived = LOCAL_ISSUE_SHEET (consumed OUT of this area)
  // Kept as two generic buckets rather than four separate ones so the S_201/
  // Issue loops below don't need to duplicate per scope -- only the final
  // chart assembly needs to know which label means which bucket.
  const monthlyReceived = {}; // 'YYYY-MM' -> qty
  const monthlyReleased = {};
  function addToMonth_(bucket, cellDateVal, qty) {
    const d = toMidnight(cellDateVal);
    if (!d) return;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    bucket[key] = (bucket[key] || 0) + qty;
  }

  // ---- STO_MasterList / S_Z04: Planning-only, never returned to an area-scoped caller ----
  const stoRows = [];
  const z04Rows = [];
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
        if (!withinDateRange_(r[col['STO_Date']], fromDate, toDate)) continue;
        stoRows.push({
          stoNo: r[col['STO_No']],
          stoDate: formatDateOut(r[col['STO_Date']]),
          qty: r[col['Qty']],
          unit: r[col['Unit']],
          receivedQty: isBlankCell(r[col['Received_Qty']]) ? null : r[col['Received_Qty']],
          receivedDate: formatDateOut(r[col['Received_Date']]),
          referencePO: r[col['Reference_PO']]
        });
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
        addToMonth_(monthlyReceived, r[col['Date_of_Receipt_Z04']], qty); // chart always uses full history for "received" (see area-filter note above); date-range still narrows it below
        if (!withinDateRange_(r[col['Date_of_Receipt_Z04']], fromDate, toDate)) continue;
        z04Rows.push({
          stoNo: r[col['STO_No']],
          dateOfReceipt: formatDateOut(r[col['Date_of_Receipt_Z04']]),
          qtyReceived: qty,
          matDocNo: r[col['Mat_Doc_No_Z04']],
          receivedBy: r[col['Mat_Recieved_By']]
        });
      }
    }
  }

  // ---- S_201: every release for this UCS Code, area-filterable. Full scope:
  // feeds "released" (out of Planning). Area scope: areaFilter is forced to
  // their own area, and this feeds that area's "inflow" bucket instead. ----
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
      if (String(releasedToArea).trim().toUpperCase() === 'PLANNING') continue; // internal-to-Planning movement, never counted as "released"/"received" anywhere
      if (areaFilter && String(releasedToArea).trim() !== areaFilter) continue;
      const qty = Number(r[col['Qty_Released_201']]) || 0;
      addToMonth_(monthlyReleased, r[col['Date_of_Release']], qty); // area filter (if any) already applied above
      if (!withinDateRange_(r[col['Date_of_Release']], fromDate, toDate)) continue;
      s201Rows.push({
        stoNo: r[col['STO_No']],
        qtyReleased: qty,
        matDocNo: r[col['Mat_Doc_No_201']],
        dateOfRelease: formatDateOut(r[col['Date_of_Release']]),
        releasedToArea: releasedToArea
      });
    }
  }

  // ---- PLNG_ISSUE_SHEET: every Requisition-workflow issue for this UCS Code, area-filterable ----
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
        issueQty: qty,
        issuedTo: r[col['Issued_to']],
        area: area,
        reqSlipNumber: r[col['Req_Slip_number']]
      });
    }
  }

  // ---- LOCAL_ISSUE_SHEET: now a real, live sheet (see the Local Issue
  // module) -- real rows for both scopes, no longer the old
  // available:false placeholder. Full scope: informational only, NOT
  // summed into Planning's own "released" total (that would double-count
  // material already counted once when it left Planning via S_201/
  // PLNG_ISSUE_SHEET). Area scope: this IS the area's own "consumed" bucket.
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
      if (scope === 'area') addToMonth_(monthlyReceived, r[col['Issue_Date']], qty); // area-scope's reused "consumed" bucket -- see chart assembly
      if (!withinDateRange_(r[col['Issue_Date']], fromDate, toDate)) continue;
      localIssueRows.push({
        issueDate: formatDateOut(r[col['Issue_Date']]),
        area: area,
        consumedQty: qty,
        issuedTo: r[col['Issued_To']],
        remarks: r[col['Remarks']],
        issuedByName: r[col['Issued_By_Name']]
      });
    }
  }
  const localIssue = { available: true, rows: localIssueRows };

  // ---- Item description/unit, for the modal header ----
  const ucsSheet = ss.getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  let itemDescription = '', unit = '';
  if (ucsValues.length >= 2) {
    const uh = ucsValues[0];
    const ucsCodeCol = getColIndexOrThrow_(uh, 'UCS_Code', UCS_SHEET);
    const shortCol = getColIndexOrThrow_(uh, 'Short_Text', UCS_SHEET);
    const unitCol = getColIndexOrThrow_(uh, 'Unit', UCS_SHEET);
    for (let i = 1; i < ucsValues.length; i++) {
      if (String(ucsValues[i][ucsCodeCol]).trim() === ucsCode) {
        itemDescription = ucsValues[i][shortCol];
        unit = ucsValues[i][unitCol];
        break;
      }
    }
  }

  // ---- Assemble sorted monthly chart series over the union of months present ----
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

  // Bucket-to-series mapping flips with scope -- see the NOTE above monthlyReceived's declaration.
  const chart = (scope === 'area')
    ? { labels: months, received: months.map(function (m) { return monthlyReleased[m] || 0; }), released: months.map(function (m) { return monthlyReceived[m] || 0; }) }
    : { labels: months, received: months.map(function (m) { return monthlyReceived[m] || 0; }), released: months.map(function (m) { return monthlyReleased[m] || 0; }) };
  const chartLabels = (scope === 'area')
    ? { received: 'Received into ' + areaFilter, released: 'Consumed locally' }
    : { received: 'Received (Z04)', released: 'Released (201 + Issues)' };

  return jsonResponse({
    success: true,
    scope: scope,
    area: areaFilter,
    ucsCode: ucsCode,
    itemDescription: itemDescription,
    unit: unit,
    sto: stoRows,
    z04: z04Rows,
    stoZ04Available: includeStoZ04,
    s201: s201Rows,
    issues: issueRows,
    localIssue: localIssue,
    chart: chart,
    chartLabels: chartLabels
  });
}

// ====== LOCAL ISSUE (AREA STOCK CONSUMPTION) ======
// The "-" side of AREA_STOCK's future balance. The "+" side is already
// written by issueRequisition() into PLNG_ISSUE_SHEET whenever Planning
// hands material to an area; this module records what that area's own
// Supervisor/Incharge then hands out locally (e.g. a bearing fitted to a
// motor, an LED bulb sent from SRU's local stock over to CRANE). This is a
// WRITE-only module -- the read-only, all-areas AREA_STOCK dashboard
// (computeAreaStockMap_(), refreshAreaStock(), getAreaStockList()) is a
// separate, later piece, not built here.

/**
 * Area-scoped: can this person record a local issue FOR this specific area?
 * Deliberately reuses canRaiseRequisition()'s exact rule -- the same people
 * who raise requisitions for an area (Area Store Supervisor / Area Incharge)
 * are the ones who physically hand material out of that area's local stock.
 * If that assumption turns out wrong for someone, add a dedicated role
 * check here instead of changing canRaiseRequisition() itself.
 */
function canRecordLocalIssue(area, authorizedAreaString, roleString) {
  return canRaiseRequisition(area, authorizedAreaString, roleString);
}

/**
 * Single-(area, UCS_Code) available-balance check, used by recordLocalIssue()'s
 * cap enforcement.
 *
 * FIXED: this used to compute its own narrow formula -- SUM(PLNG_ISSUE_SHEET)
 * minus SUM(LOCAL_ISSUE_SHEET) -- which silently ignored material that reached
 * an area via a DIRECT S_201 release (as opposed to the Requisition workflow's
 * PLNG_ISSUE_SHEET). Since S_201 is the more common inflow path for most areas,
 * this made the cap check see far less stock than genuinely existed -- e.g. a
 * material fully stocked via 201 releases showed as having ZERO available,
 * rejecting a perfectly legitimate Local Issue.
 *
 * Now deliberately NOT a separate formula at all: it just looks up the one
 * true balance from computeAreaStockMap_() (the same function AREA_STOCK's
 * sheet/dashboard use), so there is exactly one place in this whole file that
 * defines what "an area's balance for a UCS Code" means. Slightly more work
 * per call (computes the full map rather than one pair), but at this data
 * scale that's negligible, and it makes this exact class of two-formulas-
 * silently-drifting-apart bug structurally impossible going forward.
 */
function computeAreaAvailableBalance_(area, ucsCode) {
  const map = computeAreaStockMap_();
  const entry = map.find(function (r) { return r.area === area && r.ucsCode === ucsCode; });
  return entry ? entry.qtyBalance : 0;
}

/**
 * WRITE: records one or more local-issue rows for ONE area in one call
 * (same "whole batch, one call" shape as raiseRequisition). Every line is
 * re-validated against a freshly-read balance, inside a script lock, so
 * concurrent submissions can never together push a balance negative.
 *
 * Expected payload: { area, issuedTo, remarks, items: [{ ucsCode, qty }] }
 * issuedTo/remarks apply to the whole submission (kept simple -- if two
 * lines in the same visit truly need different Issued_To values, submit
 * them as two separate calls).
 */
function recordLocalIssue(data) {
  const login = checkLogin(data.email, data.password);
  if (!login.success) return jsonResponse(login);

  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!canRecordLocalIssue(area, login.authorizedArea, login.role)) {
    return jsonResponse({ success: false, message: 'You are not authorized to record local issues for ' + area + '.' });
  }

  // Re-validate against the live Area_201 list -- never trust the client's
  // cached dropdown (same rule as addS201Entry's Released_to_Area check).
  const validAreas = readOptionsColumn('Area_201');
  if (validAreas.indexOf(area) === -1) {
    return jsonResponse({ success: false, message: 'Unknown area: ' + area });
  }

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

  // ---- Validate every line's shape before writing ANY of them ----
  const clean = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const ucsCode = String(it.ucsCode || '').trim();
    const qty = Number(it.qty);
    if (!ucsCode || !ucsMap[ucsCode]) {
      return jsonResponse({ success: false, message: 'Line ' + (idx + 1) + ': unknown UCS Code.' });
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      return jsonResponse({ success: false, message: 'Line ' + (idx + 1) + ' (' + ucsCode + '): quantity must be a positive whole number.' });
    }
    clean.push({ ucsCode: ucsCode, qty: qty, itemDescription: ucsMap[ucsCode].desc, unit: ucsMap[ucsCode].unit });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Re-check balances fresh, inside the lock. Duplicate UCS Codes within
    // this same submission are combined first, so someone can't bypass the
    // cap by splitting one over-large issue into two lines of the same code.
    const neededByCode = {};
    clean.forEach(function (c) { neededByCode[c.ucsCode] = (neededByCode[c.ucsCode] || 0) + c.qty; });
    for (const code in neededByCode) {
      const available = computeAreaAvailableBalance_(area, code);
      if (neededByCode[code] > available) {
        return jsonResponse({
          success: false,
          message: code + ': only ' + available + ' available in ' + area + "'s local stock -- cannot issue " + neededByCode[code] + '.'
        });
      }
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOCAL_ISSUE_SHEET);
    const headers = sheet.getDataRange().getValues()[0];
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
    clean.forEach(function (c) {
      const row = new Array(headers.length).fill('');
      row[dateCol] = now;
      row[areaCol] = area;
      row[codeCol] = c.ucsCode;
      row[descCol] = c.itemDescription;
      row[unitCol] = c.unit;
      row[qtyCol] = c.qty;
      row[issuedToCol] = issuedTo;
      row[remarksCol] = remarks;
      row[byNameCol] = login.name;
      row[byEmailCol] = data.email;
      row[tsCol] = now;
      sheet.appendRow(row);
      sheet.getRange(sheet.getLastRow(), codeCol + 1).setNumberFormat('@STRING@'); // protect UCS_Code text formatting, same as elsewhere
    });

    logAudit(login.name, data.email, 'RECORD_LOCAL_ISSUE',
      area + ': ' + clean.map(function (c) { return c.ucsCode + ' x' + c.qty; }).join(', ') + ' -> ' + issuedTo);

    // Snapshot refresh (AREA_STOCK) intentionally NOT triggered here anymore --
    // see the matching note in finishIssueRequisition_ above. The 30-minute
    // timer trigger and the dashboard's own "Refresh" button still cover this.

    return jsonResponse({ success: true, message: clean.length + ' item(s) issued from ' + area + "'s local stock." });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read-only: this user's own recent local issues, scoped by AREA
 * MEMBERSHIP (their own Authorized_Area) -- same filter shape as
 * getAreaRequisitions, so people sharing an area's issuing duties (e.g.
 * two people both covering BOF) see each other's entries too, not just
 * their own submissions.
 */
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
    items.push({
      issueDate: formatDateOut(row[col['Issue_Date']]),
      area: area,
      ucsCode: row[col['UCS_Code']],
      itemDescription: row[col['Material_Description']],
      unit: row[col['Unit']],
      consumedQty: row[col['Consumed_Qty']],
      issuedTo: row[col['Issued_To']],
      remarks: row[col['Remarks']],
      issuedByName: row[col['Issued_By_Name']]
    });
  }
  items.sort(function (a, b) { return b.issueDate.localeCompare(a.issueDate); }); // newest first
  return jsonResponse({ success: true, items: items });
}

// ====== AREA STOCK: COMPUTED IN APPS SCRIPT, NOT LIVE FORMULAS ======
// See PROJECT_STATUS.md / AREA_STOCK planning chat. This mirrors PLNG_STOCK's
// "compute fresh in code, snapshot to the sheet as plain values" pattern --
// but with one structural difference worth remembering: PLNG_STOCK has a
// FIXED row set (one row per UCS_Code, mirroring UCS_MasterList 1:1), so its
// refresh updates existing rows in place. AREA_STOCK has NO fixed row set --
// the same UCS Code can appear under many different areas -- so its refresh
// has to generate the row set itself, fresh, every time.

/**
 * Single pass each over S_201, PLNG_ISSUE_SHEET, and LOCAL_ISSUE_SHEET ->
 * an array of { area, ucsCode, itemDescription, unit, totalInflow,
 * totalConsumed, qtyBalance }, one row per (Area, UCS_Code) combination
 * that has EVER appeared in either inflow source.
 *
 *   totalInflow   = SUM(S_201.Qty_Released_201 WHERE Released_to_Area != 'Planning', keyed by that area)
 *                 + SUM(PLNG_ISSUE_SHEET.Issue_Qty, keyed by its Area)
 *   totalConsumed = SUM(LOCAL_ISSUE_SHEET.Consumed_Qty, keyed by its Area)
 *   qtyBalance    = totalInflow - totalConsumed
 *
 * Two independent inflow sources exist because material reaches an area's
 * local stock two different ways: a direct SAP 201 movement straight to an
 * area (S_201), or the newer Requisition -> Issue workflow (PLNG_ISSUE_SHEET).
 * Both count; 'Planning' itself is never treated as an area (it's the
 * source, not a local-stock destination).
 */
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

/**
 * Overwrites the ENTIRE AREA_STOCK data range (A2:F<n>) as PLAIN VALUES.
 * Unlike refreshPlanningStock() (which updates a fixed set of existing
 * rows in place), this clears whatever data rows currently exist first,
 * then writes a completely fresh row set -- because AREA_STOCK's row set
 * itself is generated by computeAreaStockMap_(), not fixed by any master
 * list. This also means a combination that stops appearing (e.g. all its
 * history got somehow zeroed out) won't leave a stale leftover row behind.
 *
 * REQUIRES: the sheet's old live formulas in A2, C2, D2, E2, F2 to already
 * be deleted first (B has no formula of its own -- it was only ever the
 * second column of A2's spilled UNIQUE() output). A script cannot write
 * over a cell that is still the origin of a live array formula.
 */
function refreshAreaStock() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AREA_STOCK_SHEET);
  if (!sheet) throw new Error('AREA_STOCK sheet not found.');

  const rows = computeAreaStockMap_();

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 6).clearContent();
  }
  if (rows.length === 0) return;

  const out = rows.map(function (r) {
    return [r.area, r.ucsCode, r.itemDescription, r.totalInflow, r.totalConsumed, r.qtyBalance];
  });
  sheet.getRange(2, 1, out.length, 6).setValues(out);
  sheet.getRange(2, 2, out.length, 1).setNumberFormat('@STRING@'); // UCS_Code is column B here
}

/** Web-facing manual refresh, e.g. a "Refresh" button on the Area Stock dashboard. */
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
 * Live, read-only AREA_STOCK dashboard feed -- always freshly computed via
 * computeAreaStockMap_(), never reads the AREA_STOCK sheet's cells (same
 * "sheet is a snapshot only" rule as getPlanningStockList). Area-gated:
 *   - Planning staff (Authorized_Area contains 'Planning'): may request ANY
 *     area from the live Options_List "Area_201" column.
 *   - Everyone else: may only request an area within their OWN
 *     Authorized_Area -- enforced HERE, server-side, not just hidden in the UI.
 * Always also returns `availableAreas` -- the exact set this login may pick
 * from -- so the frontend can build its area dropdown from this one call,
 * no separate getOptionsList round-trip needed.
 */
function getAreaStockList(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const allAreaOptions = readOptionsColumn('Area_201');
  const myAreas = String(login.authorizedArea || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const isPlanning = isPlanningAreaStaff(login.authorizedArea);

  const availableAreas = isPlanning
    ? allAreaOptions
    : allAreaOptions.filter(function (a) { return myAreas.indexOf(a) !== -1; });

  const requestedArea = String(data.area || '').trim();
  if (!requestedArea) {
    // No area picked yet -- just hand back the dropdown options, no items.
    return jsonResponse({ success: true, availableAreas: availableAreas, area: '', items: [] });
  }
  if (availableAreas.indexOf(requestedArea) === -1) {
    return jsonResponse({ success: false, message: 'You are not authorized to view ' + requestedArea + "'s stock." });
  }

  const items = computeAreaStockMap_().filter(function (r) { return r.area === requestedArea; });
  return jsonResponse({ success: true, availableAreas: availableAreas, area: requestedArea, items: items });
}

// ====== DEMAND ALERTS: AREA INCHARGE HEADS-UP MODULE ======
// Demand_Alerts columns (finalized schema):
//   A: Alert_ID | B: Date_Raised | C: Area | D: Raised_By_Name | E: Raised_By_Email |
//   F: Request_Type ('Existing UCS Code' | 'New Material') | G: UCS_Code (blank if New) |
//   H: Item_Description | I: Unit (blank for 'New Material' -- deliberately not collected,
//      see submitDemandAlert()) | J: Estimated_Qty | K: Remarks |
//   L: Status ('Open' | 'Acknowledged' | 'Actioned' | 'Dismissed') |
//   M: Planning_Remarks | N: Last_Updated_By | O: Last_Updated_At
//
// Purely advisory: submitting or triaging an alert NEVER touches PLNG_STOCK,
// AREA_STOCK, or any Requisition/STO/Z04/201 row. It's a heads-up signal so
// Planning isn't blindsided by a sudden requisition -- if Planning decides to
// act on it, they still raise a fresh STO through the normal STO module.

/** 'DA{YYYYMMDD}-{XY}' serial, 2-digit XY per day, same pattern as getNextSlipSerial_. */
function getNextDemandAlertSerial_(dateYYYYMMDD) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const idCol = getColIndexOrThrow_(headers, 'Alert_ID', DEMAND_SHEET);
  const prefix = 'DA' + dateYYYYMMDD + '-';

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
    throw new Error('Maximum 99 demand alerts per day reached. Contact the project owner.');
  }
  return prefix + String(next).padStart(2, '0');
}

/**
 * data: { email, password, area, requestType, ucsCode?, itemDescription?, unit?,
 *         estimatedQty, remarks? }
 *
 * Gated to the Area Incharge of the specific `area` -- deliberately reuses
 * isAreaInchargeForArea() (the same fast-track privilege check the
 * Requisition module uses), since an Area Store Supervisor flagging a demand
 * spike without the Incharge's awareness was judged not appropriate here.
 *
 * 'Existing UCS Code': Item_Description/Unit are ALWAYS looked up fresh from
 * UCS_MasterList server-side -- client-supplied values for these are ignored,
 * same rule as every other module in this file.
 * 'New Material': Item_Description is free text, Unit must be one of the
 * live Options_List 'Unit' values (same validation addUCSCode() now uses).
 */
function submitDemandAlert(data) {
  const check = requireAnyUser(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const area = String(data.area || '').trim();
  if (!area) return jsonResponse({ success: false, message: 'Area is required.' });
  if (!isAreaInchargeForArea(area, login.authorizedArea, login.role)) {
    return jsonResponse({ success: false, message: 'Only the Area Incharge for ' + area + ' can raise a demand alert for it.' });
  }

  const requestType = String(data.requestType || '').trim();
  if (requestType !== 'Existing UCS Code' && requestType !== 'New Material') {
    return jsonResponse({ success: false, message: 'Request type must be "Existing UCS Code" or "New Material".' });
  }

  const qty = Number(data.estimatedQty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return jsonResponse({ success: false, message: 'Estimated quantity must be a positive number.' });
  }

  const remarks = String(data.remarks || '').trim();
  if (remarks.length > 500) return jsonResponse({ success: false, message: 'Remarks too long (max 500 characters).' });

  let ucsCode = '';
  let itemDescription = '';
  let unit = '';

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
    for (let i = 1; i < ucsValues.length; i++) {
      if (String(ucsValues[i][codeCol]).trim() === ucsCode) { found = ucsValues[i]; break; }
    }
    if (!found) {
      return jsonResponse({ success: false, message: 'UCS Code ' + ucsCode + ' not found. Use "New Material" instead if it genuinely does not exist yet.' });
    }
    itemDescription = found[shortCol];
    unit = found[unitCol];
  } else {
    itemDescription = String(data.itemDescription || '').trim();
    if (!itemDescription) return jsonResponse({ success: false, message: 'A description is required for a new material.' });
    if (itemDescription.length > 200) return jsonResponse({ success: false, message: 'Description too long (max 200 characters).' });

    // Unit is deliberately NOT collected for a brand-new material -- whoever's
    // flagging it may not yet know if it'll come as each/pair/dozen/etc., and
    // forcing a guess here would just be bad data. Left blank; Planning (or
    // whoever eventually creates the real UCS Code for it) decides the Unit
    // properly at that point, same as any other addUCSCode() call.
    unit = '';
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    const alertId = getNextDemandAlertSerial_(formatDateYYYYMMDD_(now));

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEMAND_SHEET);
    const headers = sheet.getDataRange().getValues()[0];
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

    logAudit(login.name, data.email, 'SUBMIT_DEMAND_ALERT',
      'Alert ' + alertId + ' | Area ' + area + ' | ' + requestType +
      (ucsCode ? ' | UCS ' + ucsCode : ' | New: ' + itemDescription) +
      ' | Est. Qty ' + qty + ' ' + unit);

    return jsonResponse({ success: true, message: 'Demand alert ' + alertId + ' submitted to Planning.', alertId: alertId });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Planning-side triage list -- gated the same as STO/Z04/201 (Planning,
 * excluding Store Incharge), since deciding what to do about a demand spike
 * sits with Planning proper. Optional `status` filter ('all' by default).
 */
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
    out.push({
      alertId: alertId,
      dateRaised: formatDateOut(row[col['Date_Raised']]),
      area: row[col['Area']],
      raisedByName: row[col['Raised_By_Name']],
      requestType: row[col['Request_Type']],
      ucsCode: row[col['UCS_Code']],
      itemDescription: row[col['Item_Description']],
      unit: row[col['Unit']],
      estimatedQty: row[col['Estimated_Qty']],
      remarks: row[col['Remarks']],
      status: status,
      planningRemarks: row[col['Planning_Remarks']],
      lastUpdatedBy: row[col['Last_Updated_By']],
      lastUpdatedAt: formatDateOut(row[col['Last_Updated_At']])
    });
  }
  out.reverse(); // newest first
  return jsonResponse({ success: true, alerts: out });
}

/**
 * Planning-only triage action: moves one alert through its status lifecycle
 * (Open -> Acknowledged -> Actioned, or Dismissed at any point) and records
 * an optional Planning-side remark. Never touches stock or raises anything
 * downstream automatically -- if Planning decides to act, they raise a
 * normal STO separately.
 */
function updateDemandAlertStatus(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;

  const alertId = String(data.alertId || '').trim();
  const newStatus = String(data.status || '').trim();
  const planningRemarks = String(data.planningRemarks || '').trim();
  const validStatuses = ['Open', 'Acknowledged', 'Actioned', 'Dismissed'];

  if (!alertId) return jsonResponse({ success: false, message: 'Alert ID is required.' });
  if (validStatuses.indexOf(newStatus) === -1) {
    return jsonResponse({ success: false, message: 'Status must be one of: ' + validStatuses.join(', ') });
  }
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
      sheet.getRange(rowNum, statusCol + 1).setValue(newStatus);
      sheet.getRange(rowNum, planningRemarksCol + 1).setValue(planningRemarks);
      sheet.getRange(rowNum, updByCol + 1).setValue(login.name);
      sheet.getRange(rowNum, updAtCol + 1).setValue(new Date());

      logAudit(login.name, data.email, 'UPDATE_DEMAND_ALERT',
        'Alert ' + alertId + ' | Status -> ' + newStatus + (planningRemarks ? ' | Remarks: ' + planningRemarks : ''));

      return jsonResponse({ success: true, message: 'Alert ' + alertId + ' updated to ' + newStatus + '.' });
    }
  }
  return jsonResponse({ success: false, message: 'Alert ' + alertId + ' not found.' });
}

/**
 * Area-scoped view for the raising side: any logged-in user sees every alert
 * for an area within their OWN Authorized_Area (team transparency, same
 * "by area membership, not by raised-by" rule as getAreaRequisitions), not
 * just the ones they personally submitted.
 */
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
    out.push({
      alertId: alertId,
      dateRaised: formatDateOut(row[col['Date_Raised']]),
      area: area,
      raisedByName: row[col['Raised_By_Name']],
      requestType: row[col['Request_Type']],
      ucsCode: row[col['UCS_Code']],
      itemDescription: row[col['Item_Description']],
      unit: row[col['Unit']],
      estimatedQty: row[col['Estimated_Qty']],
      remarks: row[col['Remarks']],
      status: row[col['Status']] || 'Open',
      planningRemarks: row[col['Planning_Remarks']]
    });
  }
  out.reverse(); // newest first
  return jsonResponse({ success: true, alerts: out });
}

// ====== PLANNING & AREA STOCK: MENU BUTTONS + TIME-DRIVEN TRIGGERS ======

/** Runs automatically when the SHEET (not the web app) is opened directly in a browser. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Planning Stock')
    .addItem('🔄 Refresh Planning Stock', 'refreshPlanningStock')
    .addItem('🔄 Refresh Area Stock', 'refreshAreaStock')
    .addToUi();
}

/**
 * ONE-TIME SETUP: run this once manually from the Apps Script editor
 * (select this function in the dropdown, click Run) to register the
 * 30-minute safety-net trigger. Safe to re-run -- it clears any existing
 * trigger for refreshPlanningStock first, so it never creates duplicates.
 */
function setupPlanningStockTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshPlanningStock') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('refreshPlanningStock')
    .timeBased()
    .everyMinutes(30)
    .create();
}

/**
 * ONE-TIME SETUP: same pattern as setupPlanningStockTrigger(), for
 * AREA_STOCK's own 30-minute safety-net refresh. Run once manually; safe
 * to re-run.
 */
function setupAreaStockTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshAreaStock') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('refreshAreaStock')
    .timeBased()
    .everyMinutes(30)
    .create();
}
