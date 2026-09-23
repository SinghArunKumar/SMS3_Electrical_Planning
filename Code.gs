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
 * Phase 3, Feature 2: Self-service account setup / forgot password -- emailed 6-digit OTP
 *                     (CacheService, 10-min expiry, 5 attempts), salted SHA-256 password
 *                     hashes in Users!Password. See AUTH section at the bottom of this file,
 *                     incl. ALLOW_LEGACY_PLAINTEXT_PASSWORDS (turn OFF on cutover day).
 * Phase 3, Feature 1: Edit STO (Qty + UCS Code) -- pre-lock correction of an already-raised STO,
 *                     locked automatically once Received info is filled OR a Z04 already exists.
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

function doPost(e) {
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

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Server error: ' + err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const codeCol = headers.indexOf('UCS_Code');
  const shortCol = headers.indexOf('Short_Text');
  const longCol = headers.indexOf('Long_Text');
  const unitCol = headers.indexOf('Unit');
  const stockMap = computePlanningStockMap_();
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

function getSTOList(data) {
  const check = requireSTOAccess(data);
  if (!check.ok) return check.response;
  const login = check.login;
  // Approver-only "Show deleted" view -- a non-admin passing this flag is
  // silently ignored rather than errored, same spirit as any other
  // client-supplied flag this app doesn't trust blindly.
  const includeDeleted = !!data.includeDeleted && !!login.isAdmin;
  const pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : 20;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STO_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonResponse({ success: true, rows: [], totalCount: 0, currentPage: 1, totalPages: 1, pageSize: pageSize });
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

  let allRows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const isDeleted = isSTODeleted_(r, col);
    if (isDeleted && !includeDeleted) continue;
    const receivedQty = r[col['Received_Qty']];
    const receivedDate = r[col['Received_Date']];
    const referencePO = r[col['Reference_PO']];
    const pending = isBlankCell(receivedQty) && isBlankCell(receivedDate) && !referencePO;
    const stoNo = String(r[col['STO_No']]).trim();
    allRows.push({
      stoDateObj: toMidnight(r[col['STO_Date']]), stoDate: formatDateOut(r[col['STO_Date']]), stoNo: stoNo,
      ucsCode: String(r[col['UCS_Code']]).trim(), itemDescription: r[col['Item_Description']], qty: r[col['Qty']], unit: r[col['Unit']],
      receivedQty: isBlankCell(receivedQty) ? '' : receivedQty, receivedDate: formatDateOut(receivedDate), referencePO: referencePO || '',
      pending: pending, z04Done: !!z04Done[stoNo], status201: compute201Status(stoNo),
      isDeleted: isDeleted, deletedBy: isDeleted ? r[col['Deleted_By']] : '', deletedDate: isDeleted ? formatDateOut(r[col['Deleted_Timestamp']]) : '', deletedReason: isDeleted ? (r[col['Deleted_Reason']] || '') : ''
    });
  }

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
    sheet.getRange(rowNum, col['Received_Qty'] + 1).setValue(recQty);
    sheet.getRange(rowNum, col['Received_Date'] + 1).setValue(recDateObj);
    sheet.getRange(rowNum, col['Reference_PO'] + 1).setValue(refPO);
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
    sheet.getRange(rowNum, col['Deleted_Status'] + 1).setValue('Deleted');
    sheet.getRange(rowNum, col['Deleted_By'] + 1).setValue(login.name);
    sheet.getRange(rowNum, col['Deleted_Timestamp'] + 1).setValue(now);
    sheet.getRange(rowNum, col['Deleted_Reason'] + 1).setValue(reason);
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
    sheet.getRange(rowNum, col['Deleted_Status'] + 1).setValue('');
    sheet.getRange(rowNum, col['Deleted_By'] + 1).setValue('');
    sheet.getRange(rowNum, col['Deleted_Timestamp'] + 1).setValue('');
    sheet.getRange(rowNum, col['Deleted_Reason'] + 1).setValue('');
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
    sheet.getRange(rowNum, col['Qty'] + 1).setValue(newQty);
    sheet.getRange(rowNum, col['UCS_Code'] + 1).setValue(newUcsCode);
    sheet.getRange(rowNum, col['UCS_Code'] + 1).setNumberFormat('@STRING@');
    sheet.getRange(rowNum, col['Item_Description'] + 1).setValue(newItemDescription);
    sheet.getRange(rowNum, col['Unit'] + 1).setValue(newUnit);

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
  sheet.getRange(rowNum, col['Received_Qty'] + 1).setValue(recQty);
  sheet.getRange(rowNum, col['Received_Date'] + 1).setValue(recDateObj);
  sheet.getRange(rowNum, col['Reference_PO'] + 1).setValue(refPO);
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
  const headers = sheet.getDataRange().getValues()[0] || [];
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
  const stockMap = computePlanningStockMap_();
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
    logAudit(login.name, data.email, 'RAISE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | ' + resolvedItems.length + ' item(s): ' + resolvedItems.map(function (it) { return it.ucsCode + ' x' + it.qty; }).join(', '));
    if (isFastTrack) logAudit(login.name, data.email, 'AREA_APPROVE_REQUISITION', 'Slip ' + slipId + ' | Fast-tracked by Area Incharge (Supervisor absent) -- approved at requested quantities in the same action.');
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
  writes.forEach(function (w) {
    const sheetRow = w.rowIdx + 1;
    detailsSheet.getRange(sheetRow, dCol['Qty_Issued'] + 1).setValue(w.qtyIssued);
    detailsSheet.getRange(sheetRow, dCol['Issued_To'] + 1).setValue(issuedTo);
    detailsSheet.getRange(sheetRow, dCol['Issued_By'] + 1).setValue(login.name);
    detailsSheet.getRange(sheetRow, dCol['Issued_Timestamp'] + 1).setValue(now);
    detailsSheet.getRange(sheetRow, dCol['Slip_Status'] + 1).setValue('Completed');
  });
  headerSheet.getRange(headerRowIdx + 1, hCol['Slip_Status'] + 1).setValue('Completed');
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
  logAudit(login.name, data.email, 'ISSUE_REQUISITION', 'Slip ' + slipId + ' | Area ' + area + ' | Issued to: ' + issuedTo + ' | ' + writes.length + ' item(s): ' + writes.map(function (w) { return w.ucsCode + ' x' + w.qtyIssued; }).join(', '));
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
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const ucsHeaders = ucsValues[0];
  const ucsCodeCol = getColIndexOrThrow_(ucsHeaders, 'UCS_Code', UCS_SHEET);
  const ucsShortCol = getColIndexOrThrow_(ucsHeaders, 'Short_Text', UCS_SHEET);
  const ucsLongCol = getColIndexOrThrow_(ucsHeaders, 'Long_Text', UCS_SHEET);
  const ucsUnitCol = getColIndexOrThrow_(ucsHeaders, 'Unit', UCS_SHEET);
  const map = computePlanningStockMap_();
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
  const extSpreadsheet = SpreadsheetApp.openById(PO_PR_SHEET_ID);
  const extSheet = extSpreadsheet.getSheetByName(PO_PR_TAB_NAME);
  if (!extSheet) return [];
  const values = extSheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0];
  const col = {};
  h.forEach(function (hd, idx) { col[String(hd).trim()] = idx; });
  const required = ['Mat Code', 'PR No.', 'PO No.', 'PO Dt', 'Qty', '105_Dt', 'V Code', 'V Name'];
  required.forEach(function (c) {
    if (!(c in col)) throw new Error('PO&PR sheet is missing expected column: "' + c + '"');
  });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[col['Mat Code']]).trim() !== ucsCode) continue;
    if (!withinDateRange_(r[col['105_Dt']], fromDate, toDate)) continue; // filtered by receipt date, matching Z04's convention
    const poDateRaw = toMidnight(r[col['PO Dt']]);
    rows.push({
      prNo: r[col['PR No.']],
      poNo: r[col['PO No.']],
      poDate: formatDateOut(r[col['PO Dt']]),
      poDateSort_: poDateRaw ? poDateRaw.getTime() : -Infinity, // used only to sort, stripped before returning
      qty: Number(r[col['Qty']]) || 0,
      receiptDate: formatDateOut(r[col['105_Dt']]),
      vendorCode: r[col['V Code']],
      vendorName: r[col['V Name']]
    });
  }
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
  const ucsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UCS_SHEET);
  const ucsValues = ucsSheet.getDataRange().getValues();
  const map = {};
  if (ucsValues.length < 1) return map;
  const h = ucsValues[0];
  const codeCol = getColIndexOrThrow_(h, 'UCS_Code', UCS_SHEET);
  const shortCol = getColIndexOrThrow_(h, 'Short_Text', UCS_SHEET);
  for (let i = 1; i < ucsValues.length; i++) {
    const code = String(ucsValues[i][codeCol]).trim();
    if (code) map[code] = ucsValues[i][shortCol];
  }
  return map;
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
  const extSpreadsheet = SpreadsheetApp.openById(PO_PR_SHEET_ID);
  const extSheet = extSpreadsheet.getSheetByName(PO_PR_TAB_NAME);
  if (!extSheet) return [];
  const values = extSheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0];
  const col = {};
  h.forEach(function (hd, idx) { col[String(hd).trim()] = idx; });
  const required = ['Mat Code', 'PR No.', 'PO No.', 'PO Dt', 'Qty', '105_Dt', 'V Code', 'V Name'];
  required.forEach(function (c) {
    if (!(c in col)) throw new Error('PO&PR sheet is missing expected column: "' + c + '"');
  });
  const filterCol = col[filterColumnName];
  const target = String(filterValue).trim();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[filterCol]).trim() !== target) continue;
    const poDateRaw = toMidnight(r[col['PO Dt']]);
    rows.push({
      ucsCode: String(r[col['Mat Code']]).trim(),
      prNo: r[col['PR No.']],
      poNo: r[col['PO No.']],
      poDate: formatDateOut(r[col['PO Dt']]),
      poDateSort_: poDateRaw ? poDateRaw.getTime() : -Infinity, // sort key only, stripped before returning
      qty: Number(r[col['Qty']]) || 0,
      receiptDate: formatDateOut(r[col['105_Dt']]),
      vendorCode: r[col['V Code']],
      vendorName: r[col['V Name']]
    });
  }
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
    for (const code in neededByCode) {
      const available = computeAreaAvailableBalance_(area, code);
      if (neededByCode[code] > available) return jsonResponse({ success: false, message: code + ': only ' + available + ' available in ' + area + "'s local stock -- cannot issue " + neededByCode[code] + '.' });
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
      row[dateCol] = now; row[areaCol] = area; row[codeCol] = c.ucsCode; row[descCol] = c.itemDescription; row[unitCol] = c.unit; row[qtyCol] = c.qty;
      row[issuedToCol] = issuedTo; row[remarksCol] = remarks; row[byNameCol] = login.name; row[byEmailCol] = data.email; row[tsCol] = now;
      sheet.appendRow(row);
      sheet.getRange(sheet.getLastRow(), codeCol + 1).setNumberFormat('@STRING@');
    });
    logAudit(login.name, data.email, 'RECORD_LOCAL_ISSUE', area + ': ' + clean.map(function (c) { return c.ucsCode + ' x' + c.qty; }).join(', ') + ' -> ' + issuedTo);
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
  const longTextMap = getUCSLongTextMap_();
  const items = computeAreaStockMap_().filter(function (r) { return r.area === requestedArea; })
    .map(function (r) { return Object.assign({}, r, { longText: longTextMap[r.ucsCode] || '' }); });
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
    logAudit(login.name, data.email, 'SUBMIT_DEMAND_ALERT', 'Alert ' + alertId + ' | Area ' + area + ' | ' + requestType + (ucsCode ? ' | UCS ' + ucsCode : ' | New: ' + itemDescription) + ' | Est. Qty ' + qty + ' ' + unit);
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
      sheet.getRange(rowNum, statusCol + 1).setValue(newStatus);
      sheet.getRange(rowNum, planningRemarksCol + 1).setValue(planningRemarks);
      sheet.getRange(rowNum, updByCol + 1).setValue(login.name);
      sheet.getRange(rowNum, updAtCol + 1).setValue(new Date());
      logAudit(login.name, data.email, 'UPDATE_DEMAND_ALERT', 'Alert ' + alertId + ' | Status -> ' + newStatus + (planningRemarks ? ' | Remarks: ' + planningRemarks : ''));
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

  const areaStockList = computeAreaStockMap_();
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
    const headerHeaders = headerSheet.getDataRange().getValues()[0];
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
    const detailsHeaders = detailsSheet.getDataRange().getValues()[0];

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
      detailsSheet.appendRow(row);
      const newRow = detailsSheet.getLastRow();
      detailsSheet.getRange(newRow, getColIndexOrThrow_(detailsHeaders, 'Return_ID', RETURN_DETAILS_SHEET) + 1).setNumberFormat('@STRING@');
      detailsSheet.getRange(newRow, getColIndexOrThrow_(detailsHeaders, 'UCS_Code', RETURN_DETAILS_SHEET) + 1).setNumberFormat('@STRING@');
    });

    logAudit(login.name, data.email, 'RAISE_RETURN',
      'Return ' + returnId + ' | Area ' + area + ' | ' + resolvedItems.length + ' item(s): ' +
      resolvedItems.map(function (it) { return it.ucsCode + ' x' + it.qty; }).join(', '));

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

    writes.forEach(function (w) {
      const sheetRow = w.rowIdx + 1;
      detailsSheet.getRange(sheetRow, dCol['Qty_Approved'] + 1).setValue(w.qtyApproved);
      detailsSheet.getRange(sheetRow, dCol['Approved_By'] + 1).setValue(login.name);
      detailsSheet.getRange(sheetRow, dCol['Approved_Timestamp'] + 1).setValue(now);
      detailsSheet.getRange(sheetRow, dCol['Slip_Status'] + 1).setValue('Completed');
    });
    headerSheet.getRange(headerRowIdx + 1, hCol['Return_Status'] + 1).setValue('Completed');

    logAudit(login.name, data.email, 'APPROVE_RETURN',
      'Return ' + returnId + ' | Area ' + area + ' | ' + writes.length + ' item(s): ' +
      writes.map(function (w) { return w.ucsCode + ' x' + w.qtyApproved; }).join(', '));

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
