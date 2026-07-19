/**
 * ui-admin.js — 後台匯入／教師 CRUD／課表格編輯／歷史編輯（方案甲殼瘦身 B）
 * 對外：window.UiAdmin.create(deps)
 */
window.UiAdmin = (function () {
  function create(deps) {
    var ref = deps.ref;
    var callGasApi = deps.callGasApi;
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

    async function importSchedules() {
      if (!excelData.value.length) return;
      loading.value = true;
      loadingMessage.value = '正在整理排課資料...';
      var list = [];
      var teachersListToImport = [];
      var teachersSet = new Set();
      var skippedRows = [];
      var weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
      try {
        for (var i = 0; i < excelData.value.length; i++) {
          var row = excelData.value[i];
          var name = String(row[mappingFields.value.teacherName] || '').trim();
          var email = String(row[mappingFields.value.teacherEmail] || '').trim().toLowerCase();
          var subject = String(row[mappingFields.value.subject] || '').trim();
          var dayRaw = String(row[mappingFields.value.dayOfWeek] || '').trim();
          var periodRaw = String(row[mappingFields.value.period] || '').replace(/[^\d]/g, '').trim();
          var className = String(row[mappingFields.value.className] || '').trim();

          if (!name || !email || !subject || !dayRaw || !periodRaw || !className) {
            skippedRows.push({ line: i + 2, reason: '欄位不完整' });
            continue;
          }
          if (email.indexOf('@') < 0) {
            skippedRows.push({ line: i + 2, reason: 'Email 格式錯誤: ' + email });
            continue;
          }
          var dayOfWeek = weekMap[dayRaw];
          if (dayOfWeek === undefined || dayOfWeek < 1 || dayOfWeek > 5) {
            skippedRows.push({ line: i + 2, reason: '星期格式錯誤: ' + dayRaw });
            continue;
          }
          var period = parseInt(periodRaw, 10);
          if (isNaN(period) || period < 1 || period > 8) {
            skippedRows.push({ line: i + 2, reason: '節次格式錯誤: ' + periodRaw });
            continue;
          }
          if (!teachersSet.has(email)) {
            teachersSet.add(email);
            var exists = teachersList.value.some(function (t) {
              return t.email.toLowerCase() === email;
            });
            if (!exists) {
              teachersListToImport.push({
                '學期代號': currentSemester.value,
                '教師Email': email,
                '教師姓名': name,
                '授課科目': subject,
                '系統角色': 'teacher',
                '基本鐘點': 16
              });
            }
          }
          var attr = '基本';
          var restriction = '';
          if (period === 8) attr = '輔導';
          if (mappingFields.value.attr && row[mappingFields.value.attr]) {
            var csvAttr = String(row[mappingFields.value.attr]).trim();
            if (csvAttr) attr = csvAttr;
          } else if (period === 8 && /^[單雙]/.test(subject)) {
            var m = subject.match(/^([單雙])/);
            if (m) attr = m[1] + '週';
          }
          // 1～7 節不接受單雙週／輔導屬性
          if (period !== 8 && (attr === '單週' || attr === '雙週' || attr === '輔導')) {
            attr = '一般';
          }
          if (mappingFields.value.restriction && row[mappingFields.value.restriction]) {
            restriction = String(row[mappingFields.value.restriction]).trim();
          }
          var id = 'sched_' + email.split('@')[0] + '_' + dayOfWeek + '_' + period + '_' +
            (className || 'any') + '_' + Math.random().toString(36).substr(2, 5);
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
        loadingMessage.value = '正在上傳排課資料至主要資料庫...';
        await callGasApi('importSchedulesBatch', { list: list, teachers: teachersListToImport });
        var msg = '🎉 課表匯入成功！共匯入 ' + list.length + ' 節課堂資料。';
        if (skippedRows.length > 0) {
          msg += '\n⚠️ 注意：已自動跳過 ' + skippedRows.length + ' 筆無效格式資料。原因包括：' +
            skippedRows.slice(0, 5).map(function (r) {
              return '第' + r.line + '行(' + r.reason + ')';
            }).join(', ') + ' 等。';
        }
        showToast(msg, 'info');
        excelData.value = [];
        excelHeaders.value = [];
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
          teacherMappingFields.value = { name: '', email: '', subject: '', baseHours: '', role: '' };
          teacherExcelHeaders.value.forEach(function (h) {
            var low = h.toLowerCase();
            if (h.indexOf('姓名') >= 0 || h.indexOf('教師') >= 0 || h.indexOf('名字') >= 0 || low.indexOf('name') >= 0) {
              teacherMappingFields.value.name = h;
            }
            if (h.indexOf('Email') >= 0 || h.indexOf('帳號') >= 0 || h.indexOf('信箱') >= 0 ||
                low.indexOf('email') >= 0 || low.indexOf('mail') >= 0) {
              teacherMappingFields.value.email = h;
            }
            if (h.indexOf('科目') >= 0 || h.indexOf('領域') >= 0 || h.indexOf('專長') >= 0 || low.indexOf('subject') >= 0) {
              teacherMappingFields.value.subject = h;
            }
            if (h.indexOf('基本') >= 0 || h.indexOf('基鐘') >= 0 || h.indexOf('鐘點') >= 0 ||
                h.indexOf('節數') >= 0 || low.indexOf('hour') >= 0 || low.indexOf('base') >= 0) {
              teacherMappingFields.value.baseHours = h;
            }
            if (h.indexOf('角色') >= 0 || h.indexOf('身分') >= 0 || h.indexOf('權限') >= 0 || low.indexOf('role') >= 0) {
              teacherMappingFields.value.role = h;
            }
          });
        }
      };
      reader.readAsBinaryString(file);
    }

    async function importTeachersBatch() {
      if (!teacherExcelData.value.length) return;
      loading.value = true;
      loadingMessage.value = '正在整理教師名單...';
      var list = [];
      var skippedRows = [];
      try {
        for (var i = 0; i < teacherExcelData.value.length; i++) {
          var row = teacherExcelData.value[i];
          var name = String(row[teacherMappingFields.value.name] || '').trim();
          var email = String(row[teacherMappingFields.value.email] || '').trim().toLowerCase();
          var subject = String(row[teacherMappingFields.value.subject] || '').trim();
          if (!name || !email) {
            skippedRows.push({ line: i + 2, reason: '姓名或 Email 缺失' });
            continue;
          }
          if (email.indexOf('@') < 0) {
            skippedRows.push({ line: i + 2, reason: 'Email 格式錯誤: ' + email });
            continue;
          }
          var baseHours = 16;
          if (teacherMappingFields.value.baseHours &&
              row[teacherMappingFields.value.baseHours] !== undefined) {
            var rawVal = parseInt(String(row[teacherMappingFields.value.baseHours]).replace(/[^\d]/g, ''), 10);
            if (!isNaN(rawVal)) {
              if (rawVal < 0 || rawVal > 40) {
                skippedRows.push({ line: i + 2, reason: '基本鐘點超出合理範圍(0-40): ' + rawVal });
                continue;
              }
              baseHours = rawVal;
            }
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
          list.push({
            '學期代號': currentSemester.value,
            '教師Email': email,
            '教師姓名': name,
            '授課科目': subject,
            '基本鐘點': baseHours,
            '系統角色': role
          });
        }
        loadingMessage.value = '正在上傳名單至主要資料庫...';
        await callGasApi('importTeachersBatch', { list: list });
        var msg = '🎉 成功匯入/更新 ' + list.length + ' 位教師！';
        if (skippedRows.length > 0) {
          msg += '\n⚠️ 注意：已自動跳過 ' + skippedRows.length + ' 筆無效格式資料。原因包括：' +
            skippedRows.slice(0, 5).map(function (r) {
              return '第' + r.line + '行(' + r.reason + ')';
            }).join(', ') + ' 等。';
        }
        showToast(msg, 'info');
        showImportTeachersModal.value = false;
        await loadWeeklyData();
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
          excelHeaders.value.forEach(function (h) {
            if (h.indexOf('姓名') >= 0 || h.indexOf('教師') >= 0) mappingFields.value.teacherName = h;
            if (h.indexOf('Email') >= 0 || h.indexOf('帳號') >= 0 || h.indexOf('信箱') >= 0) {
              mappingFields.value.teacherEmail = h;
            }
            if (h.indexOf('科目') >= 0 || h.indexOf('領域') >= 0) mappingFields.value.subject = h;
            if (h.indexOf('星期') >= 0 || h.indexOf('週次') >= 0) mappingFields.value.dayOfWeek = h;
            if (h.indexOf('節') >= 0 || h.indexOf('課節') >= 0) mappingFields.value.period = h;
            if (h.indexOf('班') >= 0 || h.indexOf('班級') >= 0) mappingFields.value.className = h;
            if (h === '屬性' || h.indexOf('課堂屬性') >= 0 || h.indexOf('attr') >= 0) {
              mappingFields.value.attr = h;
            }
            if (h === '限制' || h.indexOf('調課限制') >= 0 || h.indexOf('restriction') >= 0) {
              mappingFields.value.restriction = h;
            }
          });
        }
      };
      reader.readAsBinaryString(file);
    }

    function getMappingLabel(key) {
      var labels = {
        teacherName: '教師姓名',
        teacherEmail: '帳號 Email',
        subject: '科目',
        dayOfWeek: '星期 (1-5)',
        period: '課節 (1-8)',
        className: '授課班級'
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
      showScheduleEditModal: showScheduleEditModal,
      scheduleForm: scheduleForm,
      showTeacherModal: showTeacherModal,
      teacherModalMode: teacherModalMode,
      teacherForm: teacherForm,
      excelData: excelData,
      excelHeaders: excelHeaders,
      mappingFields: mappingFields,
      importSchedules: importSchedules,
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
