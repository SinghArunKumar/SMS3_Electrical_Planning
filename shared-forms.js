// =====================================================================
// SHARED FORMS -- inline Z04 / 201 creation widgets.
//
// Mounted by sto-dashboard.html directly beneath a selected STO row,
// using data the host page already has in memory (no re-login, no new
// tab). Each mount function owns a self-contained bit of DOM plus its
// own validation; the host page supplies callApi (bound to ITS OWN
// currentUser/session) and an onSuccess callback so the host controls
// what happens after a save (e.g. reloading its table).
//
// Validation logic (Mat Doc No format + live dup-check, date bounds,
// qty bounds, zero-qty confirm) is ported from add-z04.html and
// add-201.html's own scripts. Those two pages are left untouched for
// now -- this module has exactly one caller (sto-dashboard.html). If
// they're later migrated to call into this file too, delete their
// duplicated copies of this same logic at that point, not before.
//
// Load this file in index.html right after shared.js:
//   <script src="shared.js"></script>
//   <script src="shared-forms.js"></script>
// =====================================================================

const SharedForms = (function () {

  function todayLocalISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function el(tag, attrs, html) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function showErr(node, text) { node.textContent = text; node.style.display = 'block'; }
  function hideErr(node) { node.style.display = 'none'; }

  // ---------------------------------------------------------------
  // Z04 inline form
  //
  // container: DOM node to render into (will be cleared first)
  // sto: { stoNo, stoDate, qty }   -- qty is the STO's Ordered Qty
  // opts: { callApi, onSuccess(data) }
  // ---------------------------------------------------------------
  function mountZ04Form(container, sto, opts) {
    const callApi = opts.callApi;
    const onSuccess = opts.onSuccess || function () {};

    let matDocNoConfirmedUnique = false;
    let matDocNoCheckInFlight = null;

    container.innerHTML = '';
    const wrap = el('div', { style: 'margin-top:10px; border-top:1px dashed #ccc; padding-top:10px;' });

    const dateLabel = el('label', {}, 'Date of Receipt (Z04)');
    const dateInput = el('input', { type: 'date', style: 'width:100%;' });
    dateInput.max = todayLocalISO();
    if (sto.stoDate) dateInput.min = sto.stoDate;
    dateInput.value = todayLocalISO();
    const dateErr = el('div', { class: 'fieldError' });

    const qtyLabel = el('label', {}, 'Qty Received (Z04)');
    const qtyInput = el('input', { type: 'number', min: '0', step: '1', style: 'width:100%;' });
    const qtyErr = el('div', { class: 'fieldError' });
    const zeroBox = el('div', { style: 'display:none; background:#fff8e1; border:1px solid #f2c94c; border-radius:6px; padding:10px; margin-top:8px; font-size:13px;' });
    const zeroCheckbox = el('input', { type: 'checkbox' });
    const zeroLabel = el('label', { style: 'display:flex; gap:8px; align-items:flex-start; font-weight:normal; margin-top:0;' });
    zeroLabel.appendChild(zeroCheckbox);
    const zeroSpan = document.createElement('span');
    zeroSpan.innerHTML = 'I confirm the received quantity for this Z04 is genuinely <b>zero</b>.';
    zeroLabel.appendChild(zeroSpan);
    zeroBox.appendChild(zeroLabel);

    const matLabel = el('label', {}, 'Mat Doc No (10 digits)');
    const matInput = el('input', { type: 'text', maxlength: '10', inputmode: 'numeric', style: 'width:100%;' });
    const matErr = el('div', { class: 'fieldError' });
    const matDupErr = el('div', { class: 'fieldError' });

    const byLabel = el('label', {}, 'Material Received By (optional)');
    const byInput = el('input', { type: 'text', style: 'width:100%;' });

    const saveBtn = el('button', { type: 'button' }, 'Save Z04 Entry');
    saveBtn.disabled = true;
    const msgBox = el('div', { style: 'margin-top:8px; font-size:13px; display:none; padding:8px; border-radius:4px;' });

    [dateLabel, dateInput, dateErr, qtyLabel, qtyInput, qtyErr, zeroBox,
      matLabel, matInput, matErr, matDupErr, byLabel, byInput, saveBtn, msgBox]
      .forEach(function (n) { wrap.appendChild(n); });
    container.appendChild(wrap);

    function validateDate() {
      const v = dateInput.value;
      if (!v) { hideErr(dateErr); return false; }
      if (v > todayLocalISO()) { showErr(dateErr, 'Cannot be in the future.'); return false; }
      if (sto.stoDate && v < sto.stoDate) { showErr(dateErr, 'Cannot be earlier than the STO Date (' + sto.stoDate + ').'); return false; }
      hideErr(dateErr);
      return true;
    }

    function validateQty() {
      const raw = qtyInput.value;
      if (raw === '') { hideErr(qtyErr); zeroBox.style.display = 'none'; return false; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) { showErr(qtyErr, 'Must be a whole number, zero or greater.'); zeroBox.style.display = 'none'; return false; }
      if (sto.qty !== undefined && n > Number(sto.qty)) { showErr(qtyErr, 'Cannot exceed the STO Ordered Qty (' + sto.qty + ').'); zeroBox.style.display = 'none'; return false; }
      hideErr(qtyErr);
      zeroBox.style.display = (n === 0) ? 'block' : 'none';
      if (n !== 0) zeroCheckbox.checked = false;
      return true;
    }

    function validateMatFormat() {
      const v = matInput.value.trim();
      if (v === '') { hideErr(matErr); return false; }
      if (v.length !== 10) { showErr(matErr, 'Must be exactly 10 digits. Currently ' + v.length + '.'); return false; }
      if (v.charAt(0) === '0') { showErr(matErr, 'Cannot start with 0.'); return false; }
      hideErr(matErr);
      return true;
    }

    function validateAll() {
      const dateOk = validateDate() && !!dateInput.value;
      let qtyOk = validateQty() && qtyInput.value !== '';
      if (qtyOk && Number(qtyInput.value) === 0) qtyOk = zeroCheckbox.checked;
      const matOk = validateMatFormat() && matInput.value.length === 10 && matDocNoConfirmedUnique;
      saveBtn.disabled = !(dateOk && qtyOk && matOk);
    }

    dateInput.oninput = function () { validateDate(); validateAll(); };
    qtyInput.oninput = function () { validateQty(); validateAll(); };
    zeroCheckbox.onchange = validateAll;

    matInput.oninput = async function () {
      const cleaned = matInput.value.replace(/[^\d]/g, '');
      if (cleaned !== matInput.value) matInput.value = cleaned;
      matDocNoConfirmedUnique = false;
      const formatOk = validateMatFormat();
      hideErr(matDupErr);
      validateAll();
      if (!formatOk || matInput.value.length !== 10) return;

      const matDocNo = matInput.value;
      const thisCheck = Symbol();
      matDocNoCheckInFlight = thisCheck;
      try {
        const data = await callApi({ action: 'checkMatDocNoExists', matDocNo: matDocNo });
        if (matDocNoCheckInFlight !== thisCheck) return; // superseded by a newer keystroke
        if (!data.success) { showErr(matDupErr, data.message || 'Could not check this Mat Doc No.'); return; }
        if (data.exists) {
          showErr(matDupErr, 'Mat Doc No ' + matDocNo + ' already exists.');
          matDocNoConfirmedUnique = false;
        } else {
          hideErr(matDupErr);
          matDocNoConfirmedUnique = true;
        }
      } catch (e) {
        showErr(matDupErr, 'Could not reach the server to check this Mat Doc No.');
      } finally {
        validateAll();
      }
    };

    saveBtn.onclick = async function () {
      validateAll();
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      msgBox.style.display = 'none';
      try {
        const data = await callApi({
          action: 'addZ04Entry',
          stoNo: sto.stoNo,
          dateOfReceipt: dateInput.value,
          qtyReceived: Number(qtyInput.value),
          matDocNo: matInput.value.trim(),
          matReceivedBy: byInput.value.trim()
        });
        if (data.success) {
          onSuccess(data);
        } else {
          msgBox.className = 'error';
          msgBox.textContent = data.message || 'Could not save this Z04 entry.';
          msgBox.style.display = 'block';
        }
      } catch (e) {
        msgBox.className = 'error';
        msgBox.textContent = 'Could not reach the server.';
        msgBox.style.display = 'block';
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Z04 Entry';
        validateAll();
      }
    };
  }

  // ---------------------------------------------------------------
  // 201 inline form
  //
  // container: DOM node to render into (will be cleared first)
  // sto: { stoNo, dateOfReceiptZ04 }
  // remaining: number -- remaining balance available to release
  // opts: { callApi, areaOptions: string[], onSuccess(data) }
  // ---------------------------------------------------------------
  function mountS201Form(container, sto, remaining, opts) {
    const callApi = opts.callApi;
    const areaOptions = opts.areaOptions || [];
    const onSuccess = opts.onSuccess || function () {};

    let matDocNoConfirmedUnique = false;
    let matDocNoCheckInFlight = null;

    container.innerHTML = '';
    const wrap = el('div', { style: 'margin-top:10px; border-top:1px dashed #ccc; padding-top:10px;' });

    const qtyLabel = el('label', {}, 'Qty Released (remaining: ' + remaining + ')');
    const qtyInput = el('input', { type: 'number', min: '1', step: '1', style: 'width:100%;' });
    const qtyErr = el('div', { class: 'fieldError' });

    const matLabel = el('label', {}, 'Mat Doc No (10 digits)');
    const matInput = el('input', { type: 'text', maxlength: '10', inputmode: 'numeric', style: 'width:100%;' });
    const matErr = el('div', { class: 'fieldError' });
    const matDupErr = el('div', { class: 'fieldError' });

    const dateLabel = el('label', {}, 'Date of Release');
    const dateInput = el('input', { type: 'date', style: 'width:100%;' });
    dateInput.max = todayLocalISO();
    if (sto.dateOfReceiptZ04) dateInput.min = sto.dateOfReceiptZ04;
    dateInput.value = todayLocalISO();
    const dateErr = el('div', { class: 'fieldError' });

    const areaLabel = el('label', {}, 'Released to Area');
    const areaSelect = el('select', { style: 'width:100%;' });
    areaSelect.appendChild(el('option', { value: '' }, 'Select an area...'));
    areaOptions.forEach(function (a) { areaSelect.appendChild(el('option', { value: a }, a)); });

    const saveBtn = el('button', { type: 'button' }, 'Save 201 Entry');
    saveBtn.disabled = true;
    const msgBox = el('div', { style: 'margin-top:8px; font-size:13px; display:none; padding:8px; border-radius:4px;' });

    [qtyLabel, qtyInput, qtyErr, matLabel, matInput, matErr, matDupErr,
      dateLabel, dateInput, dateErr, areaLabel, areaSelect, saveBtn, msgBox]
      .forEach(function (n) { wrap.appendChild(n); });
    container.appendChild(wrap);

    function validateQty() {
      const raw = qtyInput.value;
      if (raw === '') { hideErr(qtyErr); return false; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) { showErr(qtyErr, 'Must be a whole number greater than zero.'); return false; }
      if (n > remaining) { showErr(qtyErr, 'Cannot exceed the remaining balance (' + remaining + ').'); return false; }
      hideErr(qtyErr);
      return true;
    }

    function validateMatFormat() {
      const v = matInput.value.trim();
      if (v === '') { hideErr(matErr); return false; }
      if (v.length !== 10) { showErr(matErr, 'Must be exactly 10 digits. Currently ' + v.length + '.'); return false; }
      if (v.charAt(0) === '0') { showErr(matErr, 'Cannot start with 0.'); return false; }
      hideErr(matErr);
      return true;
    }

    function validateDate() {
      const v = dateInput.value;
      if (!v) { hideErr(dateErr); return false; }
      if (v > todayLocalISO()) { showErr(dateErr, 'Cannot be in the future.'); return false; }
      if (sto.dateOfReceiptZ04 && v < sto.dateOfReceiptZ04) { showErr(dateErr, 'Cannot be earlier than the Z04 Date of Receipt (' + sto.dateOfReceiptZ04 + ').'); return false; }
      hideErr(dateErr);
      return true;
    }

    function validateAll() {
      const qtyOk = validateQty() && qtyInput.value !== '';
      const matOk = validateMatFormat() && matInput.value.length === 10 && matDocNoConfirmedUnique;
      const dateOk = validateDate() && !!dateInput.value;
      const areaOk = !!areaSelect.value;
      saveBtn.disabled = !(qtyOk && matOk && dateOk && areaOk);
    }

    qtyInput.oninput = function () { validateQty(); validateAll(); };
    dateInput.oninput = function () { validateDate(); validateAll(); };
    areaSelect.onchange = validateAll;

    matInput.oninput = async function () {
      const cleaned = matInput.value.replace(/[^\d]/g, '');
      if (cleaned !== matInput.value) matInput.value = cleaned;
      matDocNoConfirmedUnique = false;
      const formatOk = validateMatFormat();
      hideErr(matDupErr);
      validateAll();
      if (!formatOk || matInput.value.length !== 10) return;

      const matDocNo = matInput.value;
      const thisCheck = Symbol();
      matDocNoCheckInFlight = thisCheck;
      try {
        const data = await callApi({ action: 'checkMatDocNoExists', matDocNo: matDocNo });
        if (matDocNoCheckInFlight !== thisCheck) return;
        if (!data.success) { showErr(matDupErr, data.message || 'Could not check this Mat Doc No.'); return; }
        if (data.exists) {
          showErr(matDupErr, 'Mat Doc No ' + matDocNo + ' already exists.');
          matDocNoConfirmedUnique = false;
        } else {
          hideErr(matDupErr);
          matDocNoConfirmedUnique = true;
        }
      } catch (e) {
        showErr(matDupErr, 'Could not reach the server to check this Mat Doc No.');
      } finally {
        validateAll();
      }
    };

    saveBtn.onclick = async function () {
      validateAll();
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      msgBox.style.display = 'none';
      try {
        const data = await callApi({
          action: 'addS201Entry',
          stoNo: sto.stoNo,
          qtyReleased: Number(qtyInput.value),
          matDocNo: matInput.value.trim(),
          dateOfRelease: dateInput.value,
          releasedToArea: areaSelect.value
        });
        if (data.success) {
          onSuccess(data);
        } else {
          msgBox.className = 'error';
          msgBox.textContent = data.message || 'Could not save this 201 entry.';
          msgBox.style.display = 'block';
        }
      } catch (e) {
        msgBox.className = 'error';
        msgBox.textContent = 'Could not reach the server.';
        msgBox.style.display = 'block';
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save 201 Entry';
        validateAll();
      }
    };
  }

  return { mountZ04Form: mountZ04Form, mountS201Form: mountS201Form };
})();
