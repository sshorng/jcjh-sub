/**
 * Spotlight 新手導覽（懶載入）
 * window.OnboardingTour.start({ callbacks })
 */
window.OnboardingTour = (function () {
  var STORAGE_KEY = 'jcjh_onboarding_v2';
  var PAPER_STORAGE_KEY = 'jcjh_onboarding_paper_v1';
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
  var _storageKey = STORAGE_KEY;

  // 精簡 ≤15 步：課表 → 媒合 → 模擬 → 送出／LINE → 待辦 → 歷史 → 完成
  var DEFAULT_STEPS = [
    {
      id: 'welcome',
      title: '歡迎使用線上課表系統',
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
      body: '已開啟真實媒合名單（依當節空堂）。\n\n• 找人代課／節次調課：上方模式切換\n• 可搜尋姓名、點列預覽\n• 名單可能為空（該節大家都有課）\n\n下一步先介紹「節次調課」，再示範代課模擬。',
      selector: '[data-tour="match-drawer"]',
      placement: 'left',
      before: 'openMatchDemo',
      requireMatch: true
    },
    {
      id: 'match-mode',
      title: '代課或節次調課',
      body: '上方兩個按鈕可切換申請方式：\n• 「找人代課」：找空堂教師代替您上課\n• 「節次調課」：找另一位教師的課互換，支援同週或跨週調課\n\n點「節次調課」後，系統會只列出可互換的課堂。導覽不會送出申請。',
      selector: '[data-tour="exchange-mode-btn"]',
      placement: 'bottom',
      before: 'openExchangeModeDemo',
      requireMatch: true
    },
    {
      id: 'exchange-controls',
      title: '設定調課週次與星期',
      body: '調課模式開啟後：\n① 選擇要對調的週次，可選本週、上週、下週或下下週\n② 用星期篩選縮小可調課節次\n③ 從下方名單選擇可互換的課堂，再查看雙方課表\n\n確認無誤後才進入模擬，導覽不會替您送出。',
      selector: '[data-tour="exchange-controls"]',
      placement: 'left',
      before: 'openExchangeModeDemo',
      requireMatch: true
    },
    {
      id: 'open-compare',
      title: '模擬對照',
       body: '送出前的核對頁：\n• 黃格＝本次模擬的課堂\n• 左＝您、右＝代課人，請看是否合理\n• 下方填：假別、原因、備註\n\n導覽不會幫您送出。',
      selector: '[data-tour="compare-modal"]',
      placement: 'left',
      before: 'openCompareDemo',
      requireCompare: true
    },
    {
      id: 'compare-submit',
      title: '確認送出與何時生效',
       body: '按「確認送出」才會真的送出申請並通知相關人員。\n\n之後：\n① 對方在「待辦 → 收到的邀請」同意或拒絕\n② 行政核准出單後，課表才正式變更\n\n拒絕／退回／撤回則不生效。\n下一步示範送出後的 LINE 範本。',
       selector: '[data-tour="compare-submit-online"]',
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
      body: '已核准生效的調代課在此查詢。\n可篩日期、勾選後依學校原版格式列印代（調、補）課單；列表顯示請假／對調班科與節次。',
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
      body: '可以開始了！\n• 代課：點自己的課 → 智慧媒合 → 找人代課 → 模擬\n• 調課：點自己的課 → 智慧媒合 → 節次調課 → 選擇互換節次\n\n送出前請再核對一次對象與節次。'
    }
  ];

  var PAPER_STEP_OVERRIDES = {
    welcome: {
      title: '歡迎使用紙本調代課流程',
      body: '這趟會帶您：\n① 看課表、切週次\n② 點格 → 智慧媒合 → 模擬\n③ 送出申請並列印調代課單\n④ 完成簽名後送教學組\n\n紙本模式不寄系統信，請務必完成紙本簽核。'
    },
    nav: {
      title: '紙本流程導覽',
      body: '紙本模式主要使用「課表總覽」發起申請，再到「申請進度」查看送出狀態。\n\n紙本模式不需要代課教師在系統內按同意／拒絕；送出後請列印、簽名，再把紙本交至教學組。'
    },
    'match-mode': {
      body: '紙本模式同樣可以使用「找人代課」或「節次調課」。\n\n• 找人代課：選擇空堂教師\n• 節次調課：選擇同週或跨週可互換的課堂\n\n紙本模式送出後，兩種流程都要列印調代課單、完成簽名，再送至教學組。'
    },
    'exchange-controls': {
      body: '調課模式的操作：\n① 選擇本週、上週、下週或下下週\n② 用星期篩選可互換節次\n③ 選一筆課堂查看雙方課表，確認後再進入模擬\n\n紙本模式也會依相同方式確認內容，送出後再列印紙本單。'
    },
    'open-compare': {
      body: '送出前的核對頁：\n• 黃格＝本次模擬的課堂\n• 左＝申請人、右＝被申請人，請核對課表與節次\n• 下方填寫假別、原因與備註\n• 預覽調代課單只能查看，送出前不能列印\n\n導覽不會幫您送出。'
    },
    'compare-submit': {
      title: '送出申請並列印紙本單',
      selector: '[data-tour="compare-submit-paper"]',
      body: '紙本作業請按「送出申請並列印調代課單」。\n申請送出成功後才會開啟可列印預覽。\n\n接下來請依序完成：\n① 送出申請\n② 列印調代課單\n③ 請相關教師簽名\n④ 將簽名後紙本送至教學組\n\n請勿只完成線上送出，務必把簽名後調代課單交到教學組。'
    },
    'paper-print-preview': {
      title: '開啟列印預覽',
      body: '送出申請成功後，系統會自動開啟「調代課單列印預覽」。\n請先在預覽中核對姓名、日期、節次與課程內容，再進行下一步。\n\n這是教學示範，不會真的送出或列印。'
    },
    'paper-print-button': {
      title: '點選確認列印',
      body: '確認預覽內容無誤後，點選右下角「確認列印」。\n實際列印後，請完成相關教師簽名，並將簽名後調代課單提交至教學組。'
    },
    batch: {
      body: '一次選同一位老師多節課，再找人代課。\n紙本模式批次送出成功後，也要列印調代課單，完成簽名後送至教學組。'
    },
    history: {
      body: '送出後可在「待辦／歷史紀錄」查看申請進度。\n需要補印時，請從已送出的申請使用列印功能。\n\n紙本單據完成相關教師簽名後，務必送教學組留存。'
    },
    done: {
      title: '紙本導覽完成',
      body: '紙本流程重點：\n點自己的課 → 智慧媒合 → 模擬 →「送出申請並列印調代課單」\n\n最重要：列印後請完成簽名，並將簽名後調代課單提交至教學組。'
    }
  };

  function getSteps(mode) {
    var paper = mode === 'paper';
    var steps = DEFAULT_STEPS
      .filter(function (step) {
        return !paper || (step.id !== 'line-success' && step.id !== 'pending-invite');
      })
      .map(function (step) { return Object.assign({}, step); });
    if (!paper) return steps;
    var paperSteps = [];
    steps.forEach(function (step) {
      paperSteps.push(step);
      if (step.id === 'compare-submit') {
        paperSteps.push({
          id: 'paper-print-preview',
          selector: '[data-tour="print-preview-modal"]',
          placement: 'top',
          before: 'openPaperPrintDemo',
          requirePrintPreview: true
        });
        paperSteps.push({
          id: 'paper-print-button',
          selector: '[data-tour="print-confirm"]',
          placement: 'top',
          requirePrintPreview: true
        });
      }
    });
    steps = paperSteps;
    return steps.map(function (step) {
      return Object.assign({}, step, PAPER_STEP_OVERRIDES[step.id] || {});
    });
  }

  function markDone() {
    try {
      localStorage.setItem(_storageKey, '1');
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
    var heavy = name === 'openMatchDemo' || name === 'openExchangeModeDemo' || name === 'openCompareDemo'
      || name === 'openLineDemo' || name === 'closeLineAndShowDemoInvite'
      || name === 'showDemoInvite' || name === 'openPaperPrintDemo';
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
  function needsPrintPreview(step) {
    return !!(step && (step.requirePrintPreview || step.before === 'openPaperPrintDemo'));
  }

  /** 依目標步驟關閉不需要的視窗，再開 before 需要的 */
  function prepareEnv(step) {
    try {
      if (!needsLine(step) && typeof _cb.closeLineDemo === 'function') _cb.closeLineDemo();
      if (!needsPrintPreview(step) && typeof _cb.closePaperPrintDemo === 'function') _cb.closePaperPrintDemo();
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
        || step.requirePrintPreview
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
        if (!ok && step && (step.requireMatch || step.requireCompare || step.requireLine || step.requirePrintPreview)) {
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
    if (step.requirePrintPreview && !resolveEl('[data-tour="print-preview-modal"]')) {
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
        if (step.requireMatch || step.requireCompare || step.requireLine || step.requirePrintPreview) {
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
    if (typeof _cb.closePaperPrintDemo === 'function') {
      try { _cb.closePaperPrintDemo(); } catch (ePaper) {}
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
      _storageKey = opts.mode === 'paper' ? PAPER_STORAGE_KEY : STORAGE_KEY;
      _steps = (opts.steps && opts.steps.length) ? opts.steps : getSteps(opts.mode);
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

  function isDone(mode) {
    try {
      var key = mode === 'paper' ? PAPER_STORAGE_KEY : STORAGE_KEY;
      return localStorage.getItem(key) === '1';
    } catch (e) {
      return false;
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    PAPER_STORAGE_KEY: PAPER_STORAGE_KEY,
    start: start,
    stop: stop,
    isActive: isActive,
    isDone: isDone,
    ensureCss: ensureCss
  };
})();
