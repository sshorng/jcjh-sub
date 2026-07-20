/**
 * Spotlight 新手導覽（懶載入）
 * window.OnboardingTour.start({ callbacks })
 */
window.OnboardingTour = (function () {
  var STORAGE_KEY = 'jcjh_onboarding_v2';
  var CSS_HREF = 'onboarding-tour.css';
  var _active = false;
  var _idx = 0;
  var _steps = [];
  var _cb = {};
  var _root = null;
  var _hole = null;
  var _bubble = null;
  var _onResize = null;
  var _highlighted = null;
  var _navDir = 1; // 1=下一步, -1=上一步
  var _going = false;
  var _resizeTimer = null;

  // 精簡 ≤15 步：課表 → 媒合 → 模擬 → 送出／LINE → 待辦 → 歷史 → 完成
  var DEFAULT_STEPS = [
    {
      id: 'welcome',
      title: '歡迎使用調代課系統',
      body: '這趟會帶您：\n① 看課表、切週次\n② 點格 → 智慧媒合 → 模擬\n③ 送出後寄信／LINE、何時生效\n④ 待辦同意、歷史查詢\n\n約 3～4 分鐘，可隨時「跳過」。'
    },
    {
      id: 'nav',
      title: '上方導覽',
      body: '切換：課表總覽、待辦簽核、歷史紀錄等（依權限顯示）。',
      selector: '[data-tour="nav-menu"]',
      placement: 'bottom'
    },
    {
      id: 'week-grid',
      title: '週次與課表格',
      body: '上方：用 ◀ ▶ 或日期切換當週（調代依實際日期）。\n下方：每位老師一列、週一～五；格子顏色＝狀態（代課入、調出、申請中…）。\n點「有課」的格子可發起代課或調課。',
      selector: '[data-tour="week-and-grid"]',
      placement: 'bottom',
      scroll: 'start',
      before: 'goTimetable'
    },
    {
      id: 'open-match',
      title: '智慧媒合',
      body: '已開啟真實媒合名單（依當節空堂）。\n\n• 找人代課／節次調課：上方模式切換\n• 可搜尋姓名、點列預覽\n• 名單可能為空（該節大家都有課）\n\n下一步會選一位老師開啟「模擬」。',
      selector: '[data-tour="match-drawer"]',
      placement: 'left',
      before: 'openMatchDemo',
      requireMatch: true
    },
    {
      id: 'open-compare',
      title: '模擬對照',
      body: '送出前的核對頁：\n• 黃格＝本次模擬的課堂\n• 左＝您、右＝代課人，請看是否合理\n• 下方填：假別、鐘點費、備註\n\n導覽不會幫您送出。',
      selector: '[data-tour="compare-modal"]',
      placement: 'left',
      before: 'openCompareDemo',
      requireCompare: true
    },
    {
      id: 'compare-submit',
      title: '確認送出與何時生效',
      body: '「確認送出，通知相關人員」才會真的送出並寄信。\n\n之後：\n① 對方在「待辦 → 收到的邀請」同意或拒絕\n② 行政核准出單後，課表才正式變更\n\n拒絕／退回／撤回則不生效。\n下一步示範送出後的 LINE 範本。',
      selector: '[data-tour="compare-submit"]',
      placement: 'top',
      requireCompare: true
    },
    {
      id: 'line-success',
      title: 'LINE 範本與傳送',
      body: '送出成功後會有此視窗（示範，未真送出）。\n範本與正式相同：異動節次、同意／拒絕連結、系統網址。\n\n• 📋 複製　• 💬 LINE 傳送（需本機有 LINE）\n建議送出後順手傳 LINE。',
      selector: '[data-tour="line-template"]',
      placement: 'left',
      before: 'openLineDemo',
      requireLine: true
    },
    {
      id: 'pending-invite',
      title: '待辦：收到的邀請',
      body: '別人邀請您時在此回覆；導覽列紅點＝待處理筆數。\n\n黃底列是示範邀請（非真實）。\n請試按同意／拒絕—只會提示，不會真簽核。\n正式邀請時格式相同。',
      selector: '[data-tour="pending-invite-demo"]',
      placement: 'bottom',
      scroll: 'start',
      before: 'closeLineAndShowDemoInvite'
    },
    {
      id: 'history',
      title: '歷史紀錄',
      body: '已核准生效的調代課在此查詢。\n可篩日期、勾選後列印教師聯／班級聯；列表顯示請假／對調班科與節次。',
      selector: '[data-tour="history-panel"]',
      placement: 'top',
      scroll: 'start',
      before: 'goRecords'
    },
    {
      id: 'batch',
      title: '批次代課',
      body: '一次選同一位老師多節課，再找人代課（同一人全代或每節不同人）。',
      selector: '[data-tour="batch-btn"]',
      placement: 'bottom',
      scroll: 'start',
      before: 'goTimetable',
      optional: true
    },
    {
      id: 'help',
      title: '隨時重播',
      body: '點右上角 ❓ 可再看一次本教學。',
      selector: '[data-tour="help-btn"]',
      placement: 'bottom'
    },
    {
      id: 'done',
      title: '導覽完成',
      body: '可以開始了！建議：「點自己的課 → 智慧媒合 → 模擬 → 送出 → 傳 LINE」。\n送出前請再核對一次對象與節次。'
    }
  ];

  function markDone() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
      // 相容舊鍵，避免舊邏輯再彈
      localStorage.setItem('jcjh_onboarding_done', '1');
    } catch (e) {}
  }

  function ensureCss() {
    if (document.querySelector('link[data-ot-css]')) return Promise.resolve();
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_HREF;
      link.setAttribute('data-ot-css', '1');
      link.onload = function () { resolve(); };
      link.onerror = function () { resolve(); };
      document.head.appendChild(link);
    });
  }

  function clearHighlight() {
    if (_highlighted) {
      try { _highlighted.classList.remove('ot-target-pulse'); } catch (e) {}
      _highlighted = null;
    }
  }

  function setLoading(on, msg) {
    if (!_bubble) return;
    var body = _bubble.querySelector('.ot-body');
    var title = _bubble.querySelector('.ot-title');
    var btnPrev = _bubble.querySelector('[data-ot="prev"]');
    var btnNext = _bubble.querySelector('[data-ot="next"]');
    if (on) {
      if (title) title.textContent = '請稍候';
      if (body) body.textContent = msg || '載入畫面中…';
      if (btnPrev) btnPrev.disabled = true;
      if (btnNext) btnNext.disabled = true;
      _bubble.classList.add('ot-loading');
    } else {
      if (btnPrev) btnPrev.disabled = false;
      if (btnNext) btnNext.disabled = false;
      _bubble.classList.remove('ot-loading');
    }
  }

  function runBefore(step) {
    if (!step || !step.before || !_cb) return Promise.resolve(true);
    var name = step.before;
    var fn = _cb[name];
    if (typeof fn !== 'function') return Promise.resolve(true);
    var heavy = name === 'openMatchDemo' || name === 'openCompareDemo'
      || name === 'openLineDemo' || name === 'closeLineAndShowDemoInvite'
      || name === 'showDemoInvite';
    if (heavy) setLoading(true, '載入畫面中…');
    try {
      var r = fn();
      var done = function (ok) {
        if (heavy) setLoading(false);
        return ok !== false;
      };
      if (r && typeof r.then === 'function') {
        return r.then(done).catch(function () {
          if (heavy) setLoading(false);
          return false;
        });
      }
      return Promise.resolve(done(r));
    } catch (e) {
      if (heavy) setLoading(false);
      console.warn('tour before failed', name, e);
      return Promise.resolve(false);
    }
  }

  function resolveEl(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function placeBubble(el, placement) {
    if (!_bubble) return;
    _bubble.classList.remove('ot-center');
    if (!el) {
      _bubble.classList.add('ot-center');
      _bubble.style.left = '';
      _bubble.style.top = '';
      return;
    }
    var rect = el.getBoundingClientRect();
    var bw = Math.min(360, window.innerWidth - 24);
    var bh = _bubble.offsetHeight || 160;
    var pad = 12;
    var place = placement || 'bottom';
    var spaceBelow = window.innerHeight - rect.bottom - pad;
    var spaceAbove = rect.top - pad;
    var spaceLeft = rect.left - pad;
    var spaceRight = window.innerWidth - rect.right - pad;

    // 空間不夠時自動翻面，避免蓋住目標
    if (place === 'bottom' && spaceBelow < bh && spaceAbove > spaceBelow) place = 'top';
    if (place === 'top' && spaceAbove < bh && spaceBelow > spaceAbove) place = 'bottom';
    if (place === 'left' && spaceLeft < bw && spaceRight > spaceLeft) place = 'right';
    if (place === 'right' && spaceRight < bw && spaceLeft > spaceRight) place = 'left';

    var left = rect.left;
    var top = rect.bottom + pad;

    if (place === 'top') {
      top = rect.top - bh - pad;
      left = rect.left + rect.width / 2 - bw / 2;
    } else if (place === 'left') {
      left = rect.left - bw - pad;
      top = rect.top;
      // 垂直置中於目標，但勿蓋住目標列
      if (top + bh > rect.bottom) top = Math.max(8, rect.bottom - bh);
    } else if (place === 'right') {
      left = rect.right + pad;
      top = rect.top;
    } else {
      top = rect.bottom + pad;
      left = rect.left + rect.width / 2 - bw / 2;
    }

    if (left < 8) left = 8;
    if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
    if (top < 8) top = 8;
    if (top + bh > window.innerHeight - 8) {
      // 仍溢出：貼在視窗底部，但至少低於目標底部（優先露出目標）
      var minTop = Math.min(rect.bottom + pad, window.innerHeight - bh - 8);
      top = Math.max(8, Math.min(minTop, window.innerHeight - bh - 8));
    }

    _bubble.style.left = left + 'px';
    _bubble.style.top = top + 'px';
    _bubble.style.transform = 'none';
  }

  function placeHole(el) {
    if (!_hole) return;
    if (!el) {
      _hole.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    var m = 6;
    _hole.style.display = 'block';
    _hole.style.top = Math.max(0, r.top - m) + 'px';
    _hole.style.left = Math.max(0, r.left - m) + 'px';
    _hole.style.width = Math.min(window.innerWidth, r.width + m * 2) + 'px';
    _hole.style.height = Math.min(window.innerHeight, r.height + m * 2) + 'px';
  }

  function needsMatch(step) {
    return !!(step && (step.requireMatch || step.before === 'openMatchDemo'));
  }
  function needsCompare(step) {
    return !!(step && (step.requireCompare || step.before === 'openCompareDemo'));
  }
  function needsLine(step) {
    return !!(step && (step.requireLine || step.before === 'openLineDemo'));
  }

  /** 依目標步驟關閉不需要的視窗，再開 before 需要的 */
  function prepareEnv(step) {
    try {
      if (!needsLine(step) && typeof _cb.closeLineDemo === 'function') _cb.closeLineDemo();
      if (!needsCompare(step) && typeof _cb.closeCompareDemo === 'function') _cb.closeCompareDemo();
      // 模擬依賴媒合時不要關媒合
      if (!needsMatch(step) && !needsCompare(step) && typeof _cb.closeMatchDemo === 'function') {
        _cb.closeMatchDemo();
      }
      // 虛擬邀請：只在會顯示示範列的步驟保留
      if (typeof _cb.clearDemoInvite === 'function') {
        var keepDemo = step && (
          step.before === 'showDemoInvite'
          || step.before === 'closeLineAndShowDemoInvite'
          || step.id === 'pending-invite'
        );
        if (!keepDemo) _cb.clearDemoInvite();
      }
    } catch (e) {}
    return runBefore(step);
  }

  function waitUi(step) {
    var ms = 100;
    var b = step && step.before;
    if (step && (step.requireMatch || step.requireCompare || step.requireLine
        || b === 'showDemoInvite' || b === 'closeLineAndShowDemoInvite')) {
      ms = 520; // 關 modal + 切 tab + 置頂 + 掛示範列
    } else if (b && String(b).indexOf('go') === 0) {
      ms = 280; // 切 tab + 置頂
    }
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function skipInNavDir() {
    _idx += _navDir;
    if (_idx < 0) {
      _idx = 0;
      enterStep();
      return;
    }
    if (_idx >= _steps.length) {
      if (_navDir > 0) stop(true);
      else {
        _idx = _steps.length - 1;
        enterStep();
      }
      return;
    }
    enterStep();
  }

  function enterStep() {
    if (!_active) return;
    if (_going) return;
    _going = true;
    var step = _steps[_idx];
    if (!step) {
      _going = false;
      stop(true);
      return;
    }
    prepareEnv(step).then(function (ok) {
      return waitUi(step).then(function () {
        _going = false;
        if (!ok && step && (step.requireMatch || step.requireCompare || step.requireLine)) {
          skipInNavDir();
          return;
        }
        renderStep();
      });
    }).catch(function () {
      _going = false;
      renderStep();
    });
  }

  function renderStep() {
    if (!_active || !_bubble) return;
    var step = _steps[_idx];
    if (!step) {
      stop(true);
      return;
    }

    var total = _steps.length;
    var el = resolveEl(step.selector);
    clearHighlight();

    // 缺必要 UI：依導覽方向跳過（上一步不要誤往後跳）
    if (step.requireMatch && !resolveEl('[data-tour="match-drawer"]')) {
      skipInNavDir();
      return;
    }
    if (step.requireCompare && !resolveEl('[data-tour="compare-modal"]')) {
      skipInNavDir();
      return;
    }
    if (step.requireLine && !resolveEl('[data-tour="success-modal"]')) {
      skipInNavDir();
      return;
    }
    if (step.optional && step.selector && !el) {
      skipInNavDir();
      return;
    }
    // 有 selector 但還沒掛上（剛切 tab／示範列）：再試幾次
    if (step.selector && !el && !step.optional) {
      var tries = 0;
      var retry = function () {
        if (!_active || _steps[_idx] !== step) return;
        var elRetry = resolveEl(step.selector);
        // 示範邀請：退而求其次框整張「收到的邀請」卡片
        if (!elRetry && step.id === 'pending-invite') {
          elRetry = resolveEl('[data-tour="pending-invite"]');
        }
        if (elRetry) {
          finishRender(step, total, elRetry);
          return;
        }
        tries++;
        if (tries < 6) {
          setTimeout(retry, 120);
          return;
        }
        if (step.requireMatch || step.requireCompare || step.requireLine) {
          skipInNavDir();
          return;
        }
        finishRender(step, total, null);
      };
      setTimeout(retry, 120);
      return;
    }

    finishRender(step, total, el);
  }

  function finishRender(step, total, el) {
    if (!_active || !_bubble) return;
    clearHighlight();
    if (el) {
      try {
        // 強制置頂對齊（考慮 sticky navbar）
        var preferStart = step.scroll === 'start' || step.placement === 'bottom'
          || step.id === 'week-grid' || step.id === 'batch' || step.id === 'pending-invite' || step.id === 'history';
        if (preferStart && typeof _cb.scrollToTop === 'function') {
          _cb.scrollToTop(el);
        } else {
          var block = step.scroll === 'center' ? 'center' : (preferStart ? 'start' : 'nearest');
          el.scrollIntoView({ block: block, inline: 'nearest', behavior: 'auto' });
          if (preferStart) {
            var nav = document.querySelector('.navbar');
            var navH = nav ? nav.getBoundingClientRect().height : 0;
            var top = el.getBoundingClientRect().top;
            window.scrollBy(0, top - navH - 10);
          }
        }
      } catch (e) {}
      el.classList.add('ot-target-pulse');
      _highlighted = el;
    }

    var meta = _bubble.querySelector('.ot-step-meta');
    var title = _bubble.querySelector('.ot-title');
    var body = _bubble.querySelector('.ot-body');
    var btnPrev = _bubble.querySelector('[data-ot="prev"]');
    var btnNext = _bubble.querySelector('[data-ot="next"]');
    if (meta) meta.textContent = '步驟 ' + (_idx + 1) + '／' + total;
    if (title) title.textContent = step.title || '';
    if (body) body.textContent = step.body || '';
    if (btnPrev) btnPrev.style.visibility = _idx === 0 ? 'hidden' : 'visible';
    if (btnNext) btnNext.textContent = _idx >= total - 1 ? '完成' : '下一步';

    requestAnimationFrame(function () {
      if (!_active || _steps[_idx] !== step) return;
      var el2 = resolveEl(step.selector);
      if (el2 && el2 !== _highlighted) {
        clearHighlight();
        try { el2.classList.add('ot-target-pulse'); } catch (e2) {}
        _highlighted = el2;
      }
      placeHole(el2 || el);
      placeBubble(el2 || el, step.placement);
    });
  }

  function go(delta) {
    if (_going) return;
    _navDir = delta >= 0 ? 1 : -1;
    var next = _idx + delta;
    if (next < 0) return;
    if (next >= _steps.length) {
      stop(true);
      return;
    }
    _idx = next;
    enterStep();
  }

  function buildUi() {
    if (_root) return;
    _root = document.createElement('div');
    _root.className = 'ot-root ot-active';
    _root.setAttribute('data-ot-root', '1');
    _root.innerHTML =
      '<div class="ot-backdrop" data-ot="backdrop"></div>' +
      '<div class="ot-hole" style="display:none"></div>' +
      '<div class="ot-bubble ot-center">' +
      '  <div class="ot-step-meta"></div>' +
      '  <h3 class="ot-title"></h3>' +
      '  <p class="ot-body"></p>' +
      '  <div class="ot-actions">' +
      '    <button type="button" class="ot-btn ot-btn-ghost" data-ot="skip">跳過</button>' +
      '    <button type="button" class="ot-btn" data-ot="prev">上一步</button>' +
      '    <button type="button" class="ot-btn ot-btn-primary" data-ot="next">下一步</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(_root);
    _hole = _root.querySelector('.ot-hole');
    _bubble = _root.querySelector('.ot-bubble');

    _root.querySelector('[data-ot="skip"]').addEventListener('click', function () { stop(true); });
    _root.querySelector('[data-ot="prev"]').addEventListener('click', function () { go(-1); });
    _root.querySelector('[data-ot="next"]').addEventListener('click', function () { go(1); });
    _root.querySelector('[data-ot="backdrop"]').addEventListener('click', function () { stop(true); });

    _onResize = function () {
      if (!_active || _going) return;
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        _resizeTimer = null;
        if (!_active || _going) return;
        var step = _steps[_idx];
        if (!step) return;
        var el = resolveEl(step.selector);
        placeHole(el);
        placeBubble(el, step.placement);
      }, 100);
    };
    window.addEventListener('resize', _onResize);
    window.addEventListener('scroll', _onResize, true);
  }

  function destroyUi() {
    clearHighlight();
    if (_onResize) {
      window.removeEventListener('resize', _onResize);
      window.removeEventListener('scroll', _onResize, true);
      _onResize = null;
    }
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = null;
    _hole = null;
    _bubble = null;
  }

  function stop(mark) {
    if (!_active && !mark) {
      destroyUi();
      return;
    }
    _active = false;
    if (typeof _cb.clearDemoInvite === 'function') {
      try { _cb.clearDemoInvite(); } catch (e0) {}
    }
    if (typeof _cb.closeMatchDemo === 'function') {
      try { _cb.closeMatchDemo(); } catch (e) {}
    }
    // 關閉 LINE 示範／模擬（不切 tab）
    try {
      if (_cb.closeLineCompareMatchGoPending) {
        // 只關窗：直接呼叫各 close 較安全
      }
    } catch (e2) {}
    if (mark) markDone();
    destroyUi();
  }

  function start(opts) {
    opts = opts || {};
    _cb = opts.callbacks || {};
    return ensureCss().then(function () {
      _steps = (opts.steps && opts.steps.length) ? opts.steps : DEFAULT_STEPS.slice();
      _idx = 0;
      _navDir = 1;
      _going = false;
      _active = true;
      buildUi();
      enterStep();
    });
  }

  function isActive() {
    return _active;
  }

  function isDone() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    start: start,
    stop: stop,
    isActive: isActive,
    isDone: isDone,
    ensureCss: ensureCss
  };
})();
