/**
 * ui-admin.js — 後台匯入／教師 CRUD／課表格編輯／歷史編輯（方案甲殼瘦身 B）
 * 對外：window.UiAdmin.create(deps)
 */
window.UiAdmin = (function () {
  function create(deps) {
    var ref = deps.ref;
    var callGasApi = deps.callGasApi;
    var callGasApiWithProgress = deps.callGasApiWithProgress || deps.callGasApi;
    var showToast = deps.showToast;
    var showConfirm = deps.showConfirm;
    var loading = deps.loading;
    var loadingMessage = deps.loadingMessage;
    var softRefreshInBackground = deps.softRefreshInBackground || function () {};
    var clearScheduleCache = deps.clearScheduleCache || function () {};
    var loadWeeklyData = deps.loadWeeklyData;
    var getTeacherNameByEmail = deps.getTeacherNameByEmail;
    var currentSemester = deps.currentSemester;
    var teachersList = deps.teachersList;
    var allSchedules = deps.allSchedules;
    var leaveReasonOptions = deps.leaveReasonOptions;
    var historyEditForm = deps.historyEditForm;
    var showHistoryEditModal = deps.showHistoryEditModal;
    var requestsList = deps.requestsList;

    var showImportTeachersModal = ref(false);
    var teacherExcelData = ref([]);
    var teacherExcelHeaders = ref([]);
    var teacherMappingFields = ref({ name: '', email: '', subject: '', baseHours: '', role: '' });
    var teacherImportPreview = ref(null);

    var showScheduleEditModal = ref(false);
    var scheduleForm = ref({
      id: null, teacherEmail: '', teacherName: '', dayOfWeek: 1, period: 1,
      className: '', subject: '', attr: '基本', restriction: ''
    });

    var showTeacherModal = ref(false);
    var teacherModalMode = ref('add');
    var teacherForm = ref({ email: '', name: '', subject: '', role: 'teacher', baseHours: 16, mutualQuota: 0 });

    var excelData = ref([]);
    var excelHeaders = ref([]);
    var mappingFields = ref({
      teacherName: '', teacherEmail: '', subject: '', dayOfWeek: '',
      period: '', className: '', attr: '', restriction: ''
    });
    /** 乾跑預覽結果 */
    var importPreview = ref(null);

    var weekMapImport = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
      '週一': 1, '週二': 2, '週三': 3, '週四': 4, '週五': 5,
      '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5
    };

    function normalizeClassNameImport(raw) {
      var s = String(raw || '').trim();
      if (!s) return '';
      // 七01／七1班 → 701
      s = s.replace(/[年班]/g, '');
      s = s.replace(/^七/, '7').replace(/^八/, '8').replace(/^九/, '9');
      // 純數字且像 701
      if (/^[789]\d{2}$/.test(s)) return s;
      return String(raw || '').trim();
    }

    function normalizeRestrictionImport(raw) {
      var s = String(raw || '').trim();
      if (!s) return '';
      if (s === 'restricted' || s.indexOf('綁') >= 0 || s.indexOf('限制') >= 0 || s === 'Y' || s === '是') {
        return 'restricted';
      }
      return '';
    }

    function normalizeAttrImport(raw, period, subject) {
      var attr = String(raw || '').trim() || '一般';
      if (attr === '基本') attr = '一般';
      if (!raw && period === 8) attr = '輔導';
      if (!raw && period === 8 && /^[單雙]/.test(String(subject || ''))) {
        var m = String(subject).match(/^([單雙])/);
        if (m) attr = m[1] + '週';
      }
      if (period !== 8 && (attr === '單週' || attr === '雙週' || attr === '輔導')) {
        attr = '一般';
      }
      if (String(subject || '').indexOf('巡堂') >= 0 || attr === '巡堂') attr = '巡堂';
      return attr;
    }

    /** 巡堂：科目／屬性／班級任一含「巡堂」即視為巡堂列 */
    function isPatrolImportRow(subject, className, attrRaw) {
      return String(subject || '').indexOf('巡堂') >= 0
        || String(className || '').indexOf('巡堂') >= 0
        || String(attrRaw || '').indexOf('巡堂') >= 0;
    }

    /** 依姓名查既有教師 Email（唯一才算成功） */
    function resolveTeacherEmailByName(name) {
      var n = String(name || '').trim();
      if (!n) return { email: '', status: 'empty' };
      var hits = (teachersList.value || []).filter(function (t) {
        return t && String(t.name || '').trim() === n;
      });
      if (hits.length === 1 && hits[0].email) {
        return { email: String(hits[0].email).toLowerCase().trim(), status: 'ok', name: hits[0].name };
      }
      if (hits.length > 1) return { email: '', status: 'ambiguous', count: hits.length };
      return { email: '', status: 'missing' };
    }

    /** 略過列摘要（對應後的主要欄位） */
    function formatSkipSnippet(name, email, dayRaw, periodRaw, className, subject) {
      var parts = [];
      if (name) parts.push(name);
      if (email) parts.push(email);
      var slot = '';
      if (dayRaw) slot += '週' + dayRaw;
      if (periodRaw) slot += '第' + periodRaw + '節';
      if (slot) parts.push(slot);
      var course = ((className || '') + (subject || '')).trim();
      if (course) parts.push(course);
      if (!parts.length) return '（該列主要欄位皆空）';
      var s = parts.join('｜');
      return s.length > 100 ? s.slice(0, 100) + '…' : s;
    }

    /** 明確列出缺什麼／問題點 */
    function buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, kind, extra) {
      var missing = [];
      if (kind === 'incomplete') {
        if (!name) missing.push('姓名');
        if (!subject) missing.push('科目');
        if (!dayRaw) missing.push('星期');
        if (!periodRaw) missing.push('節次');
        if (!className) missing.push('班級');
        return missing.length ? ('缺：' + missing.join('、')) : '缺必填欄位';
      }
      if (kind === 'email_format') return 'Email 格式不正確（需含 @）';
      if (kind === 'ambiguous') return '缺：可辨識的唯一 Email（姓名重複）';
      if (kind === 'not_found') return '缺：教師名單中的對應，或本列 Email';
      if (kind === 'day') return '缺：合法星期（1–5 或 一～五）' + (extra ? '，目前「' + extra + '」' : '');
      if (kind === 'period') return '缺：合法節次（1–8）' + (extra ? '，目前「' + extra + '」' : '');
      return extra || '';
    }

    function pushSkip(skippedRows, line, reason, snippet, missing) {
      skippedRows.push({
        line: line,
        reason: reason,
        snippet: snippet || '',
        missing: missing || ''
      });
    }

    /**
     * 解析 Excel → list / teachers / skipped（不寫庫）
     * 課表匯入：姓名必填、Email 選填（無 Email 時用教師名單姓名對應）
     * 同節多班：同一 email+星期+節次 可多列
     */
    function parseScheduleImportRows() {
      var list = [];
      var teachersListToImport = [];
      var teachersSet = new Set();
      var skippedRows = [];
      var multiSlotKeys = {};
      var resolvedByName = 0;
      if (!mappingFields.value.teacherName ||
          !mappingFields.value.subject || !mappingFields.value.dayOfWeek ||
          !mappingFields.value.period || !mappingFields.value.className) {
        return {
          list: [], teachers: [],
          skipped: [{
            line: 0,
            reason: '請完成必填欄位對應',
            snippet: '',
            missing: '缺：欄位對應（姓名／科目／星期／節次／班級）'
          }],
          multiSlots: 0, teacherCount: 0, resolvedByName: 0
        };
      }
      for (var i = 0; i < excelData.value.length; i++) {
        var row = excelData.value[i];
        var name = String(row[mappingFields.value.teacherName] || '').trim();
        var emailRaw = mappingFields.value.teacherEmail
          ? String(row[mappingFields.value.teacherEmail] || '').trim().toLowerCase()
          : '';
        var subject = String(row[mappingFields.value.subject] || '').trim();
        var dayRaw = String(row[mappingFields.value.dayOfWeek] || '').trim();
        var periodRaw = String(row[mappingFields.value.period] || '').replace(/[^\d]/g, '').trim();
        // 巡堂常無班碼：勿用 normalize 洗掉「巡堂」字樣
        var classNameRaw = mappingFields.value.className
          ? String(row[mappingFields.value.className] || '').trim()
          : '';
        var className = classNameRaw.indexOf('巡堂') >= 0
          ? classNameRaw
          : normalizeClassNameImport(classNameRaw);
        var attrRaw = '';
        if (mappingFields.value.attr && row[mappingFields.value.attr] != null) {
          attrRaw = String(row[mappingFields.value.attr]).trim();
        }
        var isPatrol = isPatrolImportRow(subject, classNameRaw || className, attrRaw);
        var snippet = formatSkipSnippet(name, emailRaw, dayRaw, periodRaw, className || classNameRaw, subject);
        var lineNo = i + 2;

        if (!name && !emailRaw && !subject && !dayRaw && !periodRaw && !className && !attrRaw) continue;

        // 巡堂：姓名＋星期＋節次即可；班級／科目可空，自動填「巡堂」
        if (isPatrol) {
          if (!name || !dayRaw || !periodRaw) {
            var missP = [];
            if (!name) missP.push('姓名');
            if (!dayRaw) missP.push('星期');
            if (!periodRaw) missP.push('節次');
            pushSkip(skippedRows, lineNo, '巡堂列欄位不完整', snippet,
              '缺：' + missP.join('、') + '（巡堂可省略班級／科目）');
            continue;
          }
          subject = subject || '巡堂';
          className = className || '巡堂';
        } else if (!name || !subject || !dayRaw || !periodRaw || !className) {
          pushSkip(skippedRows, lineNo, '欄位不完整', snippet,
            buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'incomplete'));
          continue;
        }

        var email = emailRaw;
        if (email) {
          if (email.indexOf('@') < 0) {
            pushSkip(skippedRows, lineNo, 'Email 格式錯誤', snippet,
              buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'email_format'));
            continue;
          }
        } else {
          var resolved = resolveTeacherEmailByName(name);
          if (resolved.status === 'ok') {
            email = resolved.email;
            resolvedByName++;
          } else if (resolved.status === 'ambiguous') {
            pushSkip(skippedRows, lineNo, '姓名「' + name + '」對應多位教師', snippet,
              buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'ambiguous'));
            continue;
          } else {
            pushSkip(skippedRows, lineNo, '找不到教師「' + name + '」', snippet,
              buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'not_found'));
            continue;
          }
        }

        var dayOfWeek = weekMapImport[dayRaw];
        if (dayOfWeek === undefined) {
          var dNum = parseInt(dayRaw, 10);
          if (dNum >= 1 && dNum <= 5) dayOfWeek = dNum;
        }
        if (dayOfWeek === undefined || dayOfWeek < 1 || dayOfWeek > 5) {
          pushSkip(skippedRows, lineNo, '星期格式錯誤', snippet,
            buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'day', dayRaw));
          continue;
        }
        var period = parseInt(periodRaw, 10);
        if (isNaN(period) || period < 1 || period > 8) {
          pushSkip(skippedRows, lineNo, '節次格式錯誤', snippet,
            buildSkipMissing(name, emailRaw, dayRaw, periodRaw, className, subject, 'period', periodRaw));
          continue;
        }
        var slotKey = email + '|' + dayOfWeek + '|' + period;
        multiSlotKeys[slotKey] = (multiSlotKeys[slotKey] || 0) + 1;

        // 僅當列有填 Email 且名單沒有時，才一併新建教師
        if (!teachersSet.has(email)) {
          teachersSet.add(email);
          var exists = teachersList.value.some(function (t) {
            return t.email && t.email.toLowerCase() === email;
          });
          if (!exists && emailRaw) {
            teachersListToImport.push({
              '學期代號': currentSemester.value,
              '教師Email': email,
              '教師姓名': name,
              '授課科目': isPatrol ? '巡堂' : subject,
              '系統角色': 'teacher',
              '基本鐘點': 16
            });
          }
        }
        var attr = isPatrol ? '巡堂' : normalizeAttrImport(attrRaw, period, subject);
        var restriction = '';
        if (mappingFields.value.restriction && row[mappingFields.value.restriction] != null) {
          restriction = normalizeRestrictionImport(row[mappingFields.value.restriction]);
        }
        // 巡堂不綁課
        if (isPatrol) restriction = '';
        var id = 'sched_' + email.split('@')[0] + '_' + dayOfWeek + '_' + period + '_' +
          (isPatrol ? 'patrol' : className) + '_' + Math.random().toString(36).substr(2, 6);
        list.push({
          '學期代號': currentSemester.value,
          '課表ID': id,
          '教師Email': email,
          '教師姓名': name,
          '星期': dayOfWeek,
          '節次': period,
          '班級': className,
          '科目': subject,
          '課堂屬性': attr,
          '調課限制': restriction
        });
      }
      var multiSlots = 0;
      Object.keys(multiSlotKeys).forEach(function (k) {
        if (multiSlotKeys[k] > 1) multiSlots += multiSlotKeys[k];
      });
      return {
        list: list,
        teachers: teachersListToImport,
        skipped: skippedRows,
        multiSlots: multiSlots,
        teacherCount: teachersSet.size,
        resolvedByName: resolvedByName
      };
    }

    function runImportPreview() {
      if (!excelData.value.length) {
        showToast('請先上傳 Excel', 'warning');
        return;
      }
      var parsed = parseScheduleImportRows();
      importPreview.value = {
        ok: parsed.list.length,
        skipped: parsed.skipped.length,
        teachersNew: parsed.teachers.length,
        teachersTotal: parsed.teacherCount,
        multiSlots: parsed.multiSlots,
        resolvedByName: parsed.resolvedByName || 0,
        skipList: parsed.skipped.slice(),
        sampleRows: parsed.list.slice(0, 5).map(function (r) {
          return r['教師姓名'] + ' 週' + r['星期'] + '第' + r['節次'] + ' ' + r['班級'] + r['科目'];
        })
      };
      if (!parsed.list.length) {
        showToast('沒有可匯入的有效列，請檢查欄位對應與資料', 'warning');
      } else {
        showToast('預覽完成：有效 ' + parsed.list.length + ' 節', 'success');
      }
    }

    function downloadScheduleTemplate() {
      var doDownload = function () {
        if (typeof XLSX === 'undefined') {
          showToast('Excel 模組未載入', 'error');
          return;
        }
        var rows = [
          {
            '教師姓名': '王小明',
            'Email': '',
            '星期': 1,
            '節次': 2,
            '班級': '701',
            '科目': '國文',
            '課堂屬性': '一般',
            '調課限制': ''
          },
          {
            '教師姓名': '王小明',
            'Email': '',
            '星期': 1,
            '節次': 2,
            '班級': '702',
            '科目': '國文',
            '課堂屬性': '一般',
            '調課限制': ''
          },
          {
            '教師姓名': '李美華',
            'Email': 'lee@example.edu.tw',
            '星期': 3,
            '節次': 5,
            '班級': '801',
            '科目': '數學',
            '課堂屬性': '一般',
            '調課限制': '綁課'
          },
          {
            '教師姓名': '陳志強',
            'Email': '',
            '星期': 2,
            '節次': 8,
            '班級': '901',
            '科目': '輔導',
            '課堂屬性': '輔導',
            '調課限制': ''
          },
          {
            '教師姓名': '林巡堂',
            'Email': '',
            '星期': 4,
            '節次': 3,
            '班級': '',
            '科目': '巡堂',
            '課堂屬性': '巡堂',
            '調課限制': ''
          }
        ];
        var ws = XLSX.utils.json_to_sheet(rows);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '課表長表');
        XLSX.writeFile(wb, '課表匯入範本_長表.xlsx');
        showToast('已下載課表長表範本（含巡堂列；Email 可空白）', 'success');
      };
      if (typeof window.ensureXlsx === 'function') {
        window.ensureXlsx().then(doDownload).catch(function () {
          showToast('Excel 模組載入失敗', 'error');
        });
      } else {
        doDownload();
      }
    }

    /** 匯出目前本學期課表（長表，可改完再匯回） */
    function downloadCurrentSchedules() {
      var doDownload = function () {
        if (typeof XLSX === 'undefined') {
          showToast('Excel 模組未載入', 'error');
          return;
        }
        var rows = (allSchedules.value || []).map(function (s) {
          var restrict = s.restriction === 'restricted' || s.restriction === '限制' ? '綁課' : (s.restriction || '');
          var attr = s.attr || s.attribute || '一般';
          if (attr === '基本') attr = '一般';
          return {
            '教師姓名': s.teacherName || getTeacherNameByEmail(s.teacherEmail) || '',
            'Email': s.teacherEmail || '',
            '星期': s.dayOfWeek != null ? s.dayOfWeek : '',
            '節次': s.period != null ? s.period : '',
            '班級': s.className || '',
            '科目': s.subject || '',
            '課堂屬性': attr,
            '調課限制': restrict
          };
        });
        if (!rows.length) {
          showToast('目前沒有課表資料可匯出', 'warning');
          return;
        }
        rows.sort(function (a, b) {
          var na = String(a['教師姓名'] || '');
          var nb = String(b['教師姓名'] || '');
          if (na !== nb) return na.localeCompare(nb, 'zh-Hant');
          if (a['星期'] !== b['星期']) return (parseInt(a['星期'], 10) || 0) - (parseInt(b['星期'], 10) || 0);
          return (parseInt(a['節次'], 10) || 0) - (parseInt(b['節次'], 10) || 0);
        });
        var ws = XLSX.utils.json_to_sheet(rows);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '目前課表');
        var sid = currentSemester.value || 'semester';
        XLSX.writeFile(wb, '目前課表_' + sid + '.xlsx');
        showToast('已匯出目前課表共 ' + rows.length + ' 節', 'success');
      };
      if (typeof window.ensureXlsx === 'function') {
        window.ensureXlsx().then(doDownload).catch(function () {
          showToast('Excel 模組載入失敗', 'error');
        });
      } else {
        doDownload();
      }
    }

    async function importSchedules() {
      if (!excelData.value.length) return;
      var parsed = parseScheduleImportRows();
      if (!parsed.list.length) {
        showToast('沒有可匯入的有效列', 'warning');
        importPreview.value = {
          ok: 0,
          skipped: parsed.skipped.length,
          teachersNew: 0,
          teachersTotal: 0,
          multiSlots: 0,
          skipSamples: parsed.skipped.slice(0, 8),
          sampleRows: []
        };
        return;
      }
      var ok = await showConfirm(
        '【S1 本學期覆寫】\n\n' +
        '只清除學期「' + currentSemester.value + '」的課表（其他學期不動），再一次寫入：\n' +
        '• 有效 ' + parsed.list.length + ' 節\n' +
        '• 教師 ' + parsed.teacherCount + ' 人（有 Email 且名單沒有者新增 ' + parsed.teachers.length + '）\n' +
        '• 略過 ' + parsed.skipped.length + ' 列\n' +
        (parsed.resolvedByName ? '• 靠姓名對應 Email：' + parsed.resolvedByName + ' 列\n' : '') +
        (parsed.multiSlots ? '• 同節多班列：' + parsed.multiSlots + ' 筆\n' : '') +
        '\n確定匯入？',
        '確認匯入課表'
      );
      if (!ok) return;
      loading.value = true;
      loadingMessage.value = 'S1：重建本學期課表（' + parsed.list.length + ' 節，請稍候）…';
      try {
        var res = await callGasApiWithProgress(
          'importSchedulesBatch',
          {
            list: parsed.list,
            teachers: parsed.teachers,
            replaceAll: true
          },
          '課表匯入 ' + parsed.list.length + ' 節'
        );
        var n = (res && res.count) || parsed.list.length;
        var msg = '課表匯入成功（S1 全學期覆寫）！共 ' + n + ' 節。';
        if (parsed.skipped.length > 0) {
          msg += ' 略過 ' + parsed.skipped.length + ' 列。';
        }
        showToast(msg, 'success');
        excelData.value = [];
        excelHeaders.value = [];
        importPreview.value = null;
        await loadWeeklyData();
      } catch (e) {
        console.error('排課匯入失敗：', e);
        showToast('匯入失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    function normSchedAttr(a) {
      var s = String(a || '').trim();
      if (!s || s === '基本') return '一般';
      return s;
    }

    function applyEntryToForm(entry, entries) {
      scheduleForm.value.id = entry ? entry.id : null;
      scheduleForm.value.className = entry ? (entry.className || '') : '';
      scheduleForm.value.subject = entry ? (entry.subject || '') : '';
      scheduleForm.value.attr = entry ? normSchedAttr(entry.attr) : '一般';
      scheduleForm.value.restriction = entry ? (entry.restriction || '') : '';
      scheduleForm.value._entries = entries || [];
    }

    function openScheduleEditModal(email, day, period) {
      var tname = getTeacherNameByEmail(email);
      scheduleForm.value = {
        id: null,
        teacherEmail: email,
        teacherName: tname,
        dayOfWeek: day,
        period: period,
        className: '',
        subject: '',
        attr: '一般',
        restriction: '',
        _entries: []
      };
      var entries = allSchedules.value.filter(function (s) {
        return s.teacherEmail === email &&
          parseInt(s.dayOfWeek, 10) === parseInt(day, 10) &&
          parseInt(s.period, 10) === parseInt(period, 10);
      });
      // 有資料就預選第一筆（含只剩一節基礎課），確保可按「清空」
      if (entries.length >= 1) {
        applyEntryToForm(entries[0], entries);
      }
      showScheduleEditModal.value = true;
    }

    function pickScheduleAttr(attr) {
      var entries = scheduleForm.value._entries || [];
      if (attr === '__new__') {
        applyEntryToForm(null, entries);
        scheduleForm.value.attr = '一般';
        return;
      }
      var target = normSchedAttr(attr);
      var entry = entries.find(function (e) {
        return e.id && scheduleForm.value.id && e.id === scheduleForm.value.id && normSchedAttr(e.attr) === target;
      }) || entries.find(function (e) {
        return normSchedAttr(e.attr) === target;
      });
      // 也允許用 id 點選（同 attr 多筆時）
      if (!entry && attr) {
        entry = entries.find(function (e) { return e.id === attr; });
      }
      if (entry) {
        applyEntryToForm(entry, entries);
      } else {
        applyEntryToForm(null, entries);
        scheduleForm.value.attr = target || '一般';
      }
    }

    function getSchedule(email, day, period) {
      return allSchedules.value.find(function (s) {
        return s.teacherEmail === email &&
          parseInt(s.dayOfWeek, 10) === parseInt(day, 10) &&
          parseInt(s.period, 10) === parseInt(period, 10);
      });
    }

    async function saveScheduleCell() {
      loading.value = true;
      try {
        var currentPeriod = parseInt(scheduleForm.value.period, 10);
        var attr = scheduleForm.value.attr || '一般';
        // 本校 1～7 節無單雙週；誤選時改回一般
        if (currentPeriod !== 8 && (attr === '單週' || attr === '雙週' || attr === '輔導')) {
          attr = '一般';
          scheduleForm.value.attr = '一般';
          showToast('1～7 節不使用單雙週／輔導屬性，已改為一般', 'info');
        }
        var docId = scheduleForm.value.id;
        if (!docId) {
          var dup = allSchedules.value.find(function (s) {
            return s.teacherEmail === scheduleForm.value.teacherEmail &&
              parseInt(s.dayOfWeek, 10) === parseInt(scheduleForm.value.dayOfWeek, 10) &&
              parseInt(s.period, 10) === currentPeriod &&
              (s.attr || '基本') === attr;
          });
          if (dup) docId = dup.id;
        }
        var reqPayload = {
          '課表ID': docId || ('sched_' + scheduleForm.value.teacherEmail.split('@')[0] + '_' +
            scheduleForm.value.dayOfWeek + '_' + currentPeriod + '_' +
            (scheduleForm.value.className.trim() || 'any') + '_' +
            Math.random().toString(36).substr(2, 5)),
          '教師Email': scheduleForm.value.teacherEmail,
          '教師姓名': scheduleForm.value.teacherName,
          '星期': parseInt(scheduleForm.value.dayOfWeek, 10),
          '節次': currentPeriod,
          '班級': scheduleForm.value.className.trim(),
          '科目': scheduleForm.value.subject.trim(),
          '課堂屬性': attr,
          '調課限制': scheduleForm.value.restriction === 'restricted' ? 'restricted' : ''
        };
        await callGasApi('saveScheduleCell', reqPayload);
        showScheduleEditModal.value = false;
        var mapped = window.FieldMap.mapSchedule(reqPayload);
        var list = allSchedules.value.slice();
        var idx = list.findIndex(function (s) { return s.id === mapped.id; });
        if (idx >= 0) list[idx] = mapped;
        else list.push(mapped);
        allSchedules.value = list;
        clearScheduleCache();
        softRefreshInBackground({ force: true, delay: 600 });
      } catch (e) {
        console.error(e);
        showToast('儲存課堂失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function clearScheduleCell() {
      var clearedId = scheduleForm.value.id;
      // 只剩一筆或未點選時：依 email／星期／節次／屬性回填 id
      if (!clearedId) {
        var email = scheduleForm.value.teacherEmail;
        var day = parseInt(scheduleForm.value.dayOfWeek, 10);
        var period = parseInt(scheduleForm.value.period, 10);
        var attrN = normSchedAttr(scheduleForm.value.attr);
        var hit = (allSchedules.value || []).find(function (s) {
          return s.teacherEmail === email &&
            parseInt(s.dayOfWeek, 10) === day &&
            parseInt(s.period, 10) === period &&
            normSchedAttr(s.attr) === attrN;
        }) || (allSchedules.value || []).find(function (s) {
          return s.teacherEmail === email &&
            parseInt(s.dayOfWeek, 10) === day &&
            parseInt(s.period, 10) === period;
        });
        if (hit) clearedId = hit.id;
      }
      if (!clearedId) {
        showToast('找不到可清空的課堂資料，請先點選上方其中一筆', 'warning');
        return;
      }
      if (!await showConfirm('確定要刪除這節課堂設定嗎？')) return;
      loading.value = true;
      try {
        await callGasApi('clearScheduleCell', { id: clearedId });
        allSchedules.value = allSchedules.value.filter(function (s) {
          return s.id !== clearedId;
        });
        clearScheduleCache();
        // 同格若還有其他筆（單／雙週），繼續編輯剩餘；否則關窗
        var rest = allSchedules.value.filter(function (s) {
          return s.teacherEmail === scheduleForm.value.teacherEmail &&
            parseInt(s.dayOfWeek, 10) === parseInt(scheduleForm.value.dayOfWeek, 10) &&
            parseInt(s.period, 10) === parseInt(scheduleForm.value.period, 10);
        });
        if (rest.length) {
          applyEntryToForm(rest[0], rest);
          showToast('已刪除一筆，此節尚有 ' + rest.length + ' 筆', 'info');
        } else {
          showScheduleEditModal.value = false;
          showToast('已清空為空堂', 'success');
        }
        softRefreshInBackground({ force: true, delay: 600 });
      } catch (e) {
        console.error(e);
        showToast('刪除失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function updateTeacherBaseHours(email, hours) {
      loading.value = true;
      try {
        var teacher = teachersList.value.find(function (t) { return t.email === email; });
        if (!teacher) throw new Error('找不到該教師');
        var reqPayload = {
          '教師Email': email,
          '教師姓名': teacher.name,
          '授課科目': teacher.subject,
          '基本鐘點': (hours === 0 || hours === '0') ? 0 : (parseInt(hours, 10) || 16),
          '系統角色': teacher.role || 'teacher',
          '互代額度': parseInt(teacher.mutualQuota, 10) || 0
        };
        await callGasApi('saveTeacher', reqPayload);
        var i = teachersList.value.findIndex(function (t) { return t.email === email; });
        if (i >= 0) {
          var copy = teachersList.value.slice();
          var bh = (hours === 0 || hours === '0') ? 0 : (parseInt(hours, 10) || 16);
          copy[i] = Object.assign({}, copy[i], { baseHours: bh });
          teachersList.value = copy;
        }
        softRefreshInBackground({ force: true, delay: 800 });
      } catch (e) {
        console.error(e);
        showToast('更新失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    function openAddTeacherModal() {
      teacherModalMode.value = 'add';
      teacherForm.value = { email: '', name: '', subject: '', role: 'teacher', baseHours: 16, mutualQuota: 0 };
      showTeacherModal.value = true;
    }

    function openEditTeacherModal(t) {
      teacherModalMode.value = 'edit';
      teacherForm.value = {
        email: t.email,
        name: t.name,
        subject: t.subject,
        role: t.role,
        baseHours: t.baseHours,
        mutualQuota: parseInt(t.mutualQuota, 10) || 0
      };
      showTeacherModal.value = true;
    }

    async function saveTeacher() {
      loading.value = true;
      var email = teacherForm.value.email.trim();
      var reqPayload = {
        '教師Email': email,
        '教師姓名': teacherForm.value.name.trim(),
        '授課科目': teacherForm.value.subject.trim(),
        '系統角色': teacherForm.value.role,
        '基本鐘點': (teacherForm.value.baseHours === 0 || teacherForm.value.baseHours === '0')
          ? 0
          : (parseInt(teacherForm.value.baseHours, 10) || 16),
        '互代額度': parseInt(teacherForm.value.mutualQuota, 10) || 0
      };
      try {
        await callGasApi('saveTeacher', reqPayload);
        showTeacherModal.value = false;
        var mapped = window.FieldMap.mapTeacher(reqPayload);
        var list = teachersList.value.slice();
        var i = list.findIndex(function (x) { return x.email === mapped.email; });
        if (i >= 0) list[i] = Object.assign({}, list[i], mapped);
        else list.push(mapped);
        teachersList.value = list;
        softRefreshInBackground({ force: true, delay: 800 });
      } catch (e) {
        console.error(e);
        showToast('儲存失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function deleteTeacher(email, name) {
      if (!await showConfirm('確定要刪除 ' + name + ' 老師的帳號與所有關聯資料嗎？')) return;
      loading.value = true;
      try {
        await callGasApi('deleteTeacher', { email: email });
        await loadWeeklyData();
      } catch (e) {
        console.error(e);
        showToast('刪除失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    function handleTeacherExcelChange(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = async function (evt) {
        try {
          if (typeof window.ensureXlsx === 'function') await window.ensureXlsx();
        } catch (err) {
          showToast('Excel 模組載入失敗', 'error');
          return;
        }
        if (typeof XLSX === 'undefined') {
          showToast('Excel 模組未載入', 'error');
          return;
        }
        var data = evt.target.result;
        var workbook = XLSX.read(data, { type: 'binary' });
        var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        var sheetData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (sheetData.length > 0) {
          teacherExcelHeaders.value = Object.keys(sheetData[0]);
          teacherExcelData.value = sheetData;
          teacherImportPreview.value = null;
          teacherMappingFields.value = { name: '', email: '', subject: '', baseHours: '', role: '' };
          teacherExcelHeaders.value.forEach(function (h) {
            var low = h.toLowerCase();
            if (!teacherMappingFields.value.name &&
                (h.indexOf('姓名') >= 0 || h.indexOf('教師') >= 0 || h.indexOf('名字') >= 0 || low.indexOf('name') >= 0)) {
              teacherMappingFields.value.name = h;
            }
            if (!teacherMappingFields.value.email &&
                (h.indexOf('Email') >= 0 || h.indexOf('帳號') >= 0 || h.indexOf('信箱') >= 0 ||
                low.indexOf('email') >= 0 || low.indexOf('mail') >= 0)) {
              teacherMappingFields.value.email = h;
            }
            if (!teacherMappingFields.value.subject &&
                (h.indexOf('科目') >= 0 || h.indexOf('領域') >= 0 || h.indexOf('專長') >= 0 || low.indexOf('subject') >= 0)) {
              teacherMappingFields.value.subject = h;
            }
            if (!teacherMappingFields.value.baseHours &&
                (h.indexOf('基本') >= 0 || h.indexOf('基鐘') >= 0 || h.indexOf('鐘點') >= 0 ||
                h.indexOf('節數') >= 0 || low.indexOf('hour') >= 0 || low.indexOf('base') >= 0)) {
              teacherMappingFields.value.baseHours = h;
            }
            if (!teacherMappingFields.value.role &&
                (h.indexOf('角色') >= 0 || h.indexOf('身分') >= 0 || h.indexOf('權限') >= 0 || low.indexOf('role') >= 0)) {
              teacherMappingFields.value.role = h;
            }
          });
          showToast('已載入 ' + sheetData.length + ' 列，請確認欄位後按「預覽」', 'info');
        }
      };
      reader.readAsBinaryString(file);
    }

    function parseTeacherImportRows() {
      var list = [];
      var skipped = [];
      var emailSeen = {};
      if (!teacherMappingFields.value.name || !teacherMappingFields.value.email || !teacherMappingFields.value.subject) {
        return {
          list: [],
          skipped: [{ line: 0, reason: '請完成必填欄位對應', snippet: '', missing: '缺：姓名／Email／科目欄位對應' }]
        };
      }
      for (var i = 0; i < teacherExcelData.value.length; i++) {
        var row = teacherExcelData.value[i];
        var name = String(row[teacherMappingFields.value.name] || '').trim();
        var email = String(row[teacherMappingFields.value.email] || '').trim().toLowerCase();
        var subject = String(row[teacherMappingFields.value.subject] || '').trim();
        var lineNo = i + 2;
        var snippet = [name, email, subject].filter(Boolean).join('｜') || '（空列）';
        if (!name && !email && !subject) continue;
        var miss = [];
        if (!name) miss.push('姓名');
        if (!email) miss.push('Email');
        if (!subject) miss.push('科目');
        if (miss.length) {
          skipped.push({ line: lineNo, reason: '欄位不完整', snippet: snippet, missing: '缺：' + miss.join('、') });
          continue;
        }
        if (email.indexOf('@') < 0) {
          skipped.push({ line: lineNo, reason: 'Email 格式錯誤', snippet: snippet, missing: '缺：合法 Email（需含 @）' });
          continue;
        }
        if (emailSeen[email]) {
          skipped.push({
            line: lineNo,
            reason: 'Email 與第 ' + emailSeen[email] + ' 行重複',
            snippet: snippet,
            missing: '缺：唯一 Email（本檔重複）'
          });
          continue;
        }
        emailSeen[email] = lineNo;
        var baseHours = 16;
        if (teacherMappingFields.value.baseHours &&
            row[teacherMappingFields.value.baseHours] !== undefined &&
            String(row[teacherMappingFields.value.baseHours]).trim() !== '') {
          var rawVal = parseInt(String(row[teacherMappingFields.value.baseHours]).replace(/[^\d-]/g, ''), 10);
          if (isNaN(rawVal) || rawVal < 0 || rawVal > 40) {
            skipped.push({
              line: lineNo,
              reason: '基本鐘點不合理',
              snippet: snippet,
              missing: '缺：合法基本鐘點（0–40）'
            });
            continue;
          }
          baseHours = rawVal;
        }
        var role = 'teacher';
        if (teacherMappingFields.value.role &&
            row[teacherMappingFields.value.role] !== undefined) {
          var rawRole = String(row[teacherMappingFields.value.role]).trim();
          if (rawRole.indexOf('管理') >= 0 || rawRole.indexOf('主管') >= 0 ||
              rawRole.toLowerCase() === 'admin') {
            role = 'admin';
          }
        }
        var exists = (teachersList.value || []).some(function (t) {
          return t.email && t.email.toLowerCase() === email;
        });
        list.push({
          '學期代號': currentSemester.value,
          '教師Email': email,
          '教師姓名': name,
          '授課科目': subject,
          '基本鐘點': baseHours,
          '系統角色': role,
          _isUpdate: exists
        });
      }
      return { list: list, skipped: skipped };
    }

    function runTeacherImportPreview() {
      if (!teacherExcelData.value.length) {
        showToast('請先上傳 Excel', 'warning');
        return;
      }
      var parsed = parseTeacherImportRows();
      var updateN = 0;
      var newN = 0;
      parsed.list.forEach(function (r) {
        if (r._isUpdate) updateN++;
        else newN++;
      });
      teacherImportPreview.value = {
        ok: parsed.list.length,
        skipped: parsed.skipped.length,
        updateN: updateN,
        newN: newN,
        skipList: parsed.skipped.slice(),
        sampleRows: parsed.list.slice(0, 5).map(function (r) {
          return r['教師姓名'] + '｜' + r['教師Email'] + '｜' + r['授課科目'] +
            (r._isUpdate ? '（更新）' : '（新增）');
        })
      };
      if (!parsed.list.length) {
        showToast('沒有可匯入的有效列', 'warning');
      } else {
        showToast('預覽完成：有效 ' + parsed.list.length + ' 人', 'success');
      }
    }

    async function importTeachersBatch() {
      if (!teacherExcelData.value.length) return;
      var parsed = parseTeacherImportRows();
      if (!parsed.list.length) {
        teacherImportPreview.value = {
          ok: 0,
          skipped: parsed.skipped.length,
          updateN: 0,
          newN: 0,
          skipList: parsed.skipped.slice(),
          sampleRows: []
        };
        showToast('沒有可匯入的有效列', 'warning');
        return;
      }
      var updateN = 0;
      var newN = 0;
      parsed.list.forEach(function (r) {
        if (r._isUpdate) updateN++;
        else newN++;
      });
      var ok = await showConfirm(
        '將匯入／更新教師：\n' +
        '• 有效 ' + parsed.list.length + ' 人（新增 ' + newN + '／更新 ' + updateN + '）\n' +
        '• 略過 ' + parsed.skipped.length + ' 列\n\n確定寫入？',
        '確認匯入教師'
      );
      if (!ok) return;
      loading.value = true;
      loadingMessage.value = '正在上傳教師名單（' + parsed.list.length + ' 人）…';
      try {
        var list = parsed.list.map(function (r) {
          return {
            '學期代號': r['學期代號'],
            '教師Email': r['教師Email'],
            '教師姓名': r['教師姓名'],
            '授課科目': r['授課科目'],
            '基本鐘點': r['基本鐘點'],
            '系統角色': r['系統角色']
          };
        });
        // 人數多時分批，避免 GAS 逾時
        var TCHUNK = 80;
        for (var ti = 0; ti < list.length; ti += TCHUNK) {
          var chunk = list.slice(ti, ti + TCHUNK);
          var doneN = Math.min(ti + chunk.length, list.length);
          loadingMessage.value = '上傳教師 ' + doneN + '／' + list.length + '…';
          await callGasApiWithProgress(
            'importTeachersBatch',
            { list: chunk },
            '教師匯入 ' + doneN + '／' + list.length
          );
        }
        var msg = '成功匯入／更新 ' + list.length + ' 位教師';
        if (parsed.skipped.length) msg += '（略過 ' + parsed.skipped.length + ' 列）';
        showToast(msg, 'success');
        showImportTeachersModal.value = false;
        teacherExcelData.value = [];
        teacherExcelHeaders.value = [];
        teacherImportPreview.value = null;
        await loadWeeklyData({ force: true });
      } catch (err) {
        console.error('批次匯入教師失敗：', err);
        showToast('匯入失敗：' + err.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    function handleFileChange(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = async function (evt) {
        try {
          if (typeof window.ensureXlsx === 'function') await window.ensureXlsx();
        } catch (err) {
          showToast('Excel 模組載入失敗', 'error');
          return;
        }
        if (typeof XLSX === 'undefined') {
          showToast('Excel 模組未載入', 'error');
          return;
        }
        var data = evt.target.result;
        var workbook = XLSX.read(data, { type: 'binary' });
        var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        var sheetData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (sheetData.length > 0) {
          excelHeaders.value = Object.keys(sheetData[0]);
          excelData.value = sheetData;
          mappingFields.value = {
            teacherName: '', teacherEmail: '', subject: '', dayOfWeek: '',
            period: '', className: '', attr: '', restriction: ''
          };
          importPreview.value = null;
          excelHeaders.value.forEach(function (h) {
            var hl = String(h);
            if (!mappingFields.value.teacherName && (hl.indexOf('姓名') >= 0 || hl === '教師')) {
              mappingFields.value.teacherName = h;
            }
            if (!mappingFields.value.teacherEmail &&
                (hl.indexOf('Email') >= 0 || hl.indexOf('email') >= 0 || hl.indexOf('帳號') >= 0 || hl.indexOf('信箱') >= 0 || hl === 'Email')) {
              mappingFields.value.teacherEmail = h;
            }
            if (!mappingFields.value.subject && (hl.indexOf('科目') >= 0 || hl.indexOf('領域') >= 0 || hl.indexOf('課程') >= 0)) {
              mappingFields.value.subject = h;
            }
            if (!mappingFields.value.dayOfWeek && (hl.indexOf('星期') >= 0 || hl === '週' || hl.indexOf('week') >= 0)) {
              mappingFields.value.dayOfWeek = h;
            }
            if (!mappingFields.value.period && (hl.indexOf('節次') >= 0 || hl === '節' || hl.indexOf('課節') >= 0 || hl.indexOf('period') >= 0)) {
              mappingFields.value.period = h;
            }
            if (!mappingFields.value.className && (hl.indexOf('班級') >= 0 || hl === '班' || hl.indexOf('class') >= 0)) {
              mappingFields.value.className = h;
            }
            if (!mappingFields.value.attr && (hl === '屬性' || hl.indexOf('課堂屬性') >= 0 || hl.indexOf('attr') >= 0)) {
              mappingFields.value.attr = h;
            }
            if (!mappingFields.value.restriction &&
                (hl === '限制' || hl.indexOf('調課限制') >= 0 || hl.indexOf('綁課') >= 0 || hl.indexOf('restriction') >= 0)) {
              mappingFields.value.restriction = h;
            }
          });
          showToast('已載入 ' + sheetData.length + ' 列，請確認欄位對應後按「預覽」', 'info');
        }
      };
      reader.readAsBinaryString(file);
    }

    function getMappingLabel(key) {
      var labels = {
        teacherName: '教師姓名（必填）',
        teacherEmail: 'Email（選填，可空白靠姓名對應）',
        subject: '科目（必填）',
        dayOfWeek: '星期 1-5（必填）',
        period: '節次 1-8（必填）',
        className: '班級（必填）',
        attr: '課堂屬性（選填）',
        restriction: '調課限制／綁課（選填）'
      };
      return labels[key] || key;
    }

    function dayOfWeekFromDateStr(dateStr) {
      if (!dateStr) return 1;
      var d = new Date(String(dateStr).replace(/-/g, '/'));
      if (Number.isNaN(d.getTime())) return 1;
      var dow = d.getDay();
      return dow === 0 ? 7 : dow;
    }

    function openHistoryEditModal(rec) {
      var rid = rec.requestId || String(rec.id || '').replace(/_[12]$/, '') || '';
      var matched = null;
      try {
        var list = (requestsList && requestsList.value) ? requestsList.value : [];
        matched = list.find(function (x) { return x.id === rid; }) || null;
      } catch (e) { matched = null; }
      var src = matched || rec;

      var reason = src.reason || rec.reason || '';
      var opts = leaveReasonOptions || [];
      if (reason && opts.indexOf(reason) < 0) {
        if (reason === '公差') reason = '公假';
        else if (reason === '分娩假' || reason.indexOf('分娩') >= 0) reason = '產前假/分娩假';
        else reason = '其他';
      }
      var isEx = (src.type || rec.type) === 'exchange' || (src.type || rec.type) === '對調';
      var reqDate = src.requestDate || rec.requestDate || rec.date || '';
      var tgtRaw = src.targetDate || rec.targetDate || '';
      var tgtDate = (tgtRaw && tgtRaw !== '---' && tgtRaw !== '—') ? tgtRaw : '';

      var leaveEmail = src.requesterEmail || rec.originalTeacherEmail || rec.requesterEmail || '';
      var subEmail = src.targetTeacherEmail || rec.actualTeacherEmail || rec.targetTeacherEmail || '';

      historyEditForm.value = {
        id: rid,
        requestId: rid,
        serial: src.serial || rec.serial || '',
        type: isEx ? 'exchange' : 'substitution',
        requesterEmail: leaveEmail,
        targetTeacherEmail: subEmail,
        className: src.className || rec.className || '',
        subject: src.subject || rec.subject || '',
        requestDate: reqDate,
        requestPeriodDay: src.requestPeriodDay || dayOfWeekFromDateStr(reqDate),
        requestPeriod: parseInt(src.requestPeriod || rec.requestPeriod || rec.period || 1, 10) || 1,
        targetDate: tgtDate,
        targetDayOfWeek: src.targetDayOfWeek || dayOfWeekFromDateStr(tgtDate),
        targetPeriod: parseInt(src.targetPeriod || rec.targetPeriod || 1, 10) || 1,
        reason: reason,
        subFee: isEx ? '無' : (src.subFee || rec.subFee || '自費代課'),
        note: src.note || rec.note || '',
        printed: !!(src.printed != null ? src.printed : rec.printed)
      };
      showHistoryEditModal.value = true;
    }

    function onHistoryEditDateChange(which) {
      var form = historyEditForm.value;
      if (which === 'request') {
        form.requestPeriodDay = dayOfWeekFromDateStr(form.requestDate);
      } else if (which === 'target') {
        form.targetDayOfWeek = dayOfWeekFromDateStr(form.targetDate);
      }
    }

    async function saveHistoryEdit() {
      var form = historyEditForm.value;
      var rid = form.requestId || form.id || '';
      if (!rid) {
        showToast('無法識別此紀錄', 'warning');
        return;
      }
      if (!form.requesterEmail || !form.targetTeacherEmail) {
        showToast('請選擇請假教師與代課／對調教師', 'warning');
        return;
      }
      if (!form.requestDate || !form.requestPeriod) {
        showToast('請填寫請假日期與節次', 'warning');
        return;
      }
      var isEx = form.type === 'exchange' || form.type === '對調';
      if (isEx && (!form.targetDate || !form.targetPeriod)) {
        showToast('調課請填寫對調日期與節次', 'warning');
        return;
      }
      var leaveName = getTeacherNameByEmail(form.requesterEmail) || '';
      var subName = getTeacherNameByEmail(form.targetTeacherEmail) || '';
      loading.value = true;
      loadingMessage.value = '儲存歷史紀錄中...';
      try {
        var reqPayload = {
          id: rid,
          type: isEx ? 'exchange' : 'substitution',
          requesterEmail: form.requesterEmail,
          requesterName: leaveName,
          targetTeacherEmail: form.targetTeacherEmail,
          targetTeacherName: subName,
          className: form.className || '',
          subject: form.subject || '',
          requestDate: form.requestDate,
          requestPeriodDay: form.requestPeriodDay || dayOfWeekFromDateStr(form.requestDate),
          requestPeriod: parseInt(form.requestPeriod, 10) || 1,
          targetDate: isEx ? (form.targetDate || '') : '',
          targetDayOfWeek: isEx ? (form.targetDayOfWeek || dayOfWeekFromDateStr(form.targetDate)) : '',
          targetPeriod: isEx ? (parseInt(form.targetPeriod, 10) || 1) : '',
          reason: form.reason || '',
          subFee: isEx ? '無' : (form.subFee || '自費代課'),
          note: form.note || '',
          printed: !!form.printed
        };
        await callGasApi('saveHistoryEdit', reqPayload);
        showToast('✅ 修改已儲存！', 'success');
        showHistoryEditModal.value = false;
        await loadWeeklyData({ force: true });
      } catch (e) {
        console.error('儲存編輯失敗：', e);
        showToast('❌ 儲存失敗：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    return {
      showImportTeachersModal: showImportTeachersModal,
      teacherExcelData: teacherExcelData,
      teacherExcelHeaders: teacherExcelHeaders,
      teacherMappingFields: teacherMappingFields,
      teacherImportPreview: teacherImportPreview,
      runTeacherImportPreview: runTeacherImportPreview,
      showScheduleEditModal: showScheduleEditModal,
      scheduleForm: scheduleForm,
      showTeacherModal: showTeacherModal,
      teacherModalMode: teacherModalMode,
      teacherForm: teacherForm,
      excelData: excelData,
      excelHeaders: excelHeaders,
      mappingFields: mappingFields,
      importSchedules: importSchedules,
      importPreview: importPreview,
      runImportPreview: runImportPreview,
      downloadScheduleTemplate: downloadScheduleTemplate,
      downloadCurrentSchedules: downloadCurrentSchedules,
      openScheduleEditModal: openScheduleEditModal,
      pickScheduleAttr: pickScheduleAttr,
      getSchedule: getSchedule,
      saveScheduleCell: saveScheduleCell,
      clearScheduleCell: clearScheduleCell,
      updateTeacherBaseHours: updateTeacherBaseHours,
      openAddTeacherModal: openAddTeacherModal,
      openEditTeacherModal: openEditTeacherModal,
      saveTeacher: saveTeacher,
      deleteTeacher: deleteTeacher,
      handleTeacherExcelChange: handleTeacherExcelChange,
      importTeachersBatch: importTeachersBatch,
      handleFileChange: handleFileChange,
      getMappingLabel: getMappingLabel,
      openHistoryEditModal: openHistoryEditModal,
      saveHistoryEdit: saveHistoryEdit,
      onHistoryEditDateChange: onHistoryEditDateChange
    };
  }

  return { create: create };
})();
