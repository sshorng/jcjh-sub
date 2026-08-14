// 學校調代課線上系統 - Shell 層全域工具（Toast／Modal／確認框／頭像 fallback）
// 需先於 app.js 載入；不依賴 Vue，可被任何 ui-*.js 全域使用

// 學校調代課線上系統 - 核心應用程式邏輯 (莫蘭迪現代大鐘點版)


// ── Toast 通知系統 ──────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) { window.alert(String(msg)); return; }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icons[type] || 'ℹ️';
  const msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = String(msg == null ? '' : msg);
  toast.appendChild(iconEl);
  toast.appendChild(msgEl);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ── Modal 無障礙：Esc 關閉 + 焦點陷阱 ───────────────────────
function installModalA11y(overlay, opts) {
  opts = opts || {};
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : function () {};
  const box = opts.box || overlay.querySelector('.modal-card, .match-drawer, #confirm-box, [role="dialog"]') || overlay;
  const prevFocus = document.activeElement;
  const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  overlay.setAttribute('role', 'presentation');
  if (box) {
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (opts.label && !box.getAttribute('aria-label') && !box.getAttribute('aria-labelledby')) {
      box.setAttribute('aria-label', opts.label);
    }
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !box) return;
    const nodes = Array.prototype.slice.call(box.querySelectorAll(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !box.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last || !box.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    const prefer = box && (box.querySelector('[data-autofocus], .btn-close, #confirm-ok, button') || box);
    try { if (prefer && prefer.focus) prefer.focus(); } catch (eF) { /* ignore */ }
  });
  return () => {
    document.removeEventListener('keydown', onKey, true);
    try {
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    } catch (eR) { /* ignore */ }
  };
}

// ── 自訂確認 Modal ──────────────────────────────────────────
// opts.withNote=true 時回傳 { ok, note }；否則回傳 boolean
function showConfirm(msg, title = '請確認', opts = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const msgEl   = document.getElementById('confirm-msg');
    const noteWrap = document.getElementById('confirm-note-wrap');
    const noteEl  = document.getElementById('confirm-note');
    const periodWrap = document.getElementById('confirm-accounting-period-wrap');
    const periodStartEl = document.getElementById('confirm-accounting-period-start');
    const periodEndEl = document.getElementById('confirm-accounting-period-end');
    const periodResetEl = document.getElementById('confirm-accounting-period-reset');
    const accountingWeeksField = document.getElementById('confirm-accounting-weeks-field');
    const accountingWeeksEl = document.getElementById('confirm-accounting-weeks');
    const btnOk   = document.getElementById('confirm-ok');
    const btnCan  = document.getElementById('confirm-cancel');
    const initialPeriod = {
      start: opts.periodStart != null ? String(opts.periodStart) : '',
      end: opts.periodEnd != null ? String(opts.periodEnd) : ''
    };
    const readPeriod = () => ({
      start: periodStartEl ? String(periodStartEl.value || '').trim() : initialPeriod.start,
      end: periodEndEl ? String(periodEndEl.value || '').trim() : initialPeriod.end
    });
    const setPeriod = (period) => {
      const value = period || initialPeriod;
      if (periodStartEl) periodStartEl.value = value.start || '';
      if (periodEndEl) periodEndEl.value = value.end || '';
    };
    const initialWeeks = opts.reportWeeksCount != null ? String(opts.reportWeeksCount) : '';
    const readWeeks = () => accountingWeeksEl
      ? String(accountingWeeksEl.value || '').trim()
      : initialWeeks;
    const setWeeks = (weeks) => {
      if (accountingWeeksEl) accountingWeeksEl.value = weeks == null ? '' : String(weeks);
    };
    if (!overlay) {
      const ok = window.confirm(msg);
      if (opts.withAccountingPeriod) {
        const period = initialPeriod;
        const result = { ok, period, start: period.start, end: period.end };
        if (opts.withAccountingWeeks) result.reportWeeksCount = initialWeeks;
        resolve(result);
      } else {
        resolve(opts.withNote ? { ok, note: '' } : ok);
      }
      return;
    }
    titleEl.textContent = title;
    msgEl.textContent = msg;
    if (periodWrap && periodStartEl && periodEndEl) {
      if (opts.withAccountingPeriod) {
        periodWrap.classList.add('is-open');
        setPeriod(initialPeriod);
      } else {
        periodWrap.classList.remove('is-open');
        setPeriod({ start: '', end: '' });
      }
    }
    if (accountingWeeksField && accountingWeeksEl) {
      if (opts.withAccountingWeeks) {
        accountingWeeksField.classList.add('is-open');
        setWeeks(initialWeeks);
      } else {
        accountingWeeksField.classList.remove('is-open');
        setWeeks('');
      }
    }
    if (noteWrap && noteEl) {
      if (opts.withNote) {
        noteWrap.classList.add('is-open');
        noteEl.value = opts.noteDefault != null ? String(opts.noteDefault) : '';
        noteEl.placeholder = opts.notePlaceholder || '備註（選填）';
        const noteLab = noteWrap.querySelector('label');
        if (noteLab) noteLab.textContent = opts.noteLabel || '備註（選填）';
      } else {
        noteWrap.classList.remove('is-open');
        noteEl.value = '';
      }
    }
    overlay.classList.add('confirm-show');
    let disposeA11y = null;
    let onPeriodChange = null;
    let onWeeksChange = null;
    let onPeriodReset = null;
    const cleanup = (ok) => {
      overlay.classList.remove('confirm-show');
      btnOk.removeEventListener('click', onOk);
      btnCan.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      if (onPeriodChange && periodStartEl) periodStartEl.removeEventListener('input', onPeriodChange);
      if (onPeriodChange && periodEndEl) periodEndEl.removeEventListener('input', onPeriodChange);
      if (onPeriodReset && periodResetEl) periodResetEl.removeEventListener('click', onPeriodReset);
      if (onWeeksChange && accountingWeeksEl) accountingWeeksEl.removeEventListener('input', onWeeksChange);
      if (disposeA11y) disposeA11y();
      const note = (noteEl && noteEl.value || '').trim();
      const period = readPeriod();
      if (noteWrap) noteWrap.classList.remove('is-open');
      if (periodWrap) periodWrap.classList.remove('is-open');
      if (accountingWeeksField) accountingWeeksField.classList.remove('is-open');
      if (opts.withAccountingPeriod) {
        const result = { ok, period, start: period.start, end: period.end };
        if (opts.withAccountingWeeks) result.reportWeeksCount = readWeeks();
        if (opts.withNote) result.note = note;
        resolve(result);
      } else {
        resolve(opts.withNote ? { ok, note } : ok);
      }
    };
    const applyPeriodChange = () => {
      if (typeof opts.onAccountingPeriodChange !== 'function') return;
      const result = opts.onAccountingPeriodChange(readPeriod(), readWeeks());
      if (result != null && msgEl) {
        msgEl.textContent = typeof result === 'string' ? result : (result.message || '');
      }
    };
    onPeriodChange = applyPeriodChange;
    onWeeksChange = applyPeriodChange;
    onPeriodReset = () => {
      setPeriod(opts.periodDefault || initialPeriod);
      applyPeriodChange();
    };
    const onOk = () => {
      if (opts.withAccountingPeriod && typeof opts.validateAccountingPeriod === 'function' &&
          !opts.validateAccountingPeriod(readPeriod(), readWeeks())) return;
      cleanup(true);
    };
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    btnOk.addEventListener('click', onOk);
    btnCan.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    if (opts.withAccountingPeriod) {
      if (periodStartEl) periodStartEl.addEventListener('input', onPeriodChange);
      if (periodEndEl) periodEndEl.addEventListener('input', onPeriodChange);
      if (accountingWeeksEl && opts.withAccountingWeeks) accountingWeeksEl.addEventListener('input', onWeeksChange);
      if (periodResetEl && opts.periodDefault) periodResetEl.addEventListener('click', onPeriodReset);
    }
    disposeA11y = installModalA11y(overlay, {
      box: document.getElementById('confirm-box'),
      label: title,
      onClose: () => cleanup(false)
    });
  });
}

const fallbackAvatarDataUri = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="32" fill="#e2e8f0"/>
    <circle cx="32" cy="25" r="12" fill="#94a3b8"/>
    <path d="M12 58c4-12 14-18 20-18s16 6 20 18" fill="#94a3b8"/>
  </svg>
`);
