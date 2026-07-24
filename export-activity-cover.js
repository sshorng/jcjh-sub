/**
 * 活動教師代理遺留課務 輪值通知單（套版 .docx）
 * 模板：templates/activity-cover-template.docx（保留原檔字型／欄寬／列高）
 * 規則：第 1～7 節入表；第 8 節改附註；只匯已送出（非取消／退回／撤回）；特殊分組列不處理
 */
window.ExportActivityCover = (function () {
  var TEMPLATE_URL = 'templates/activity-cover-template.docx';
  var DAY_ZH = { 0: '日', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
  var GRADE_ZH = { '7': '七', '8': '八', '9': '九' };
  var _templateBuf = null;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function emailKey(em) {
    return String(em || '').trim().toLowerCase();
  }

  function parseDate(dateStr) {
    var s = String(dateStr || '').trim().slice(0, 10);
    if (!s) return null;
    var d = new Date(s.indexOf('T') >= 0 ? s : s + 'T00:00:00');
    if (Number.isNaN(d.getTime())) d = new Date(s.replace(/-/g, '/'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function toLocalDateStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatMd(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return String(dateStr || '').slice(5).replace(/-/g, '/');
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatRangeLabel(startStr, endStr) {
    var a = parseDate(startStr);
    var b = parseDate(endStr);
    if (!a && !b) return '';
    if (a && b) {
      if (toLocalDateStr(a) === toLocalDateStr(b)) {
        return (a.getMonth() + 1) + '月' + a.getDate() + '日';
      }
      return (a.getMonth() + 1) + '月' + a.getDate() + '日～'
        + (b.getMonth() + 1) + '月' + b.getDate() + '日';
    }
    var d = a || b;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function formatExportDate(d) {
    d = d || new Date();
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  function listDatesInRange(startStr, endStr) {
    var start = parseDate(startStr);
    var end = parseDate(endStr);
    if (!start && !end) return [];
    if (start && !end) end = start;
    if (!start && end) start = end;
    if (end < start) {
      var t = start; start = end; end = t;
    }
    var out = [];
    var cur = new Date(start.getTime());
    var guard = 0;
    while (cur <= end && guard < 60) {
      out.push(toLocalDateStr(cur));
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return out;
  }

  /** 從班級清單推年級中文（七／八／九；多個用／連接） */
  function gradesFromClasses(classes) {
    var set = {};
    (classes || []).forEach(function (c) {
      var s = String(c || '').trim();
      var m = s.match(/^([789])/);
      if (m) set[m[1]] = true;
    });
    var keys = Object.keys(set).sort();
    if (!keys.length) return '';
    return keys.map(function (k) { return GRADE_ZH[k] || k; }).join('／');
  }

  function isSubmittedStatus(st) {
    var s = String(st || '').toLowerCase();
    if (!s) return false;
    if (s === 'cancelled' || s === 'rejected' || s === 'admin_rejected' || s === 'withdrawn') return false;
    // 已送出：待對方／待行政／已核准 等
    return true;
  }

  function isQuotaDeductFee(fee) {
    var f = String(fee || '');
    return f === '扣額度' || f === '互代不結';
  }

  /**
   * 僅活動互代經費（嚴格，不含一般公費／自費代課）
   * - 1～7：扣額度／互代不結／活動公費
   * - 第8：第8節代課
   */
  function isActivityMutualFee(fee, period) {
    var f = String(fee || '').trim();
    var p = parseInt(period, 10) || 0;
    if (isQuotaDeductFee(f)) return true;
    if (f === '活動公費') return true;
    if (f === '第8節代課') return true;
    // 舊資料：第8節可能只寫節次、經費空白或「計畫經費」
    if (p === 8 && (f === '' || f === '計畫經費' || f.indexOf('第8') >= 0)) return true;
    return false;
  }

  /**
   * 從已送出申請組矩陣
   * 統計口徑（與發放額度／輪值文案）：
   * - demand(OO)＝釋出堂數（呼叫端傳入；與「合計釋出」同）
   * - arranged(XX)＝1～7 已排且「扣額度」節數
   * - remaining＝OO−XX
   * 表內仍列活動互代（扣額度／活動公費）；第 8 節僅附註、不入 OO／XX
   */
  function buildMatrix(opts) {
    opts = opts || {};
    var startDate = String(opts.startDate || '').slice(0, 10);
    var endDate = String(opts.endDate || '').slice(0, 10);
    var dates = listDatesInRange(startDate, endDate);
    // 只列平日（與範本一致）
    dates = dates.filter(function (ds) {
      var d = parseDate(ds);
      if (!d) return false;
      var wd = d.getDay();
      return wd >= 1 && wd <= 5;
    });
    var dateSet = {};
    dates.forEach(function (d) { dateSet[d] = true; });

    var nameOf = typeof opts.getTeacherName === 'function'
      ? opts.getTeacherName
      : function (em) { return em || ''; };

    // 可選：備註／事由需含活動關鍵字（事件名）才入表
    var activityHint = String(opts.activityName || opts.activity || '').trim();
    var requireActivityHint = !!opts.requireActivityHint && !!activityHint;

    // grid[date][period] = [{ className, leaveName, subName, subject, fee }]
    var grid = {};
    dates.forEach(function (ds) {
      grid[ds] = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
    });
    var period8Lines = [];
    var arrangedQuota = 0; // XX：1～7 扣額度
    var arrangedPublic = 0; // 活動公費（表內可有，不計 XX）

    (opts.requests || []).forEach(function (r) {
      if (!r || r.type === 'exchange') return;
      if (!isSubmittedStatus(r.status)) return;
      var period = parseInt(r.requestPeriod != null ? r.requestPeriod : r.period, 10) || 0;
      if (!period) return;
      var fee = r.subFee || r['經費來源'] || '';
      // 嚴格：只收活動互代經費（排除一般公費／自費代課）
      if (opts.onlyActivityFee !== false && !isActivityMutualFee(fee, period)) return;
      // 可選：備註含事件名（活動互代面板統一備註）
      if (requireActivityHint) {
        var blob = String(r.note || '') + ' ' + String(r.reason || '') + ' ' + String(r.batchId || '');
        if (blob.indexOf(activityHint) < 0) return;
      }
      var rd = String(r.requestDate || r.date || '').slice(0, 10);
      if (!rd || !dateSet[rd]) return;

      var leaveName = String(r.requesterName || '').trim()
        || nameOf(r.requesterEmail || r.originalTeacherEmail);
      var subName = String(r.targetTeacherName || '').trim()
        || nameOf(r.targetTeacherEmail || r.actualTeacherEmail);
      var className = String(r.className || '').trim();
      var subject = String(r.subject || '').trim();
      if (!leaveName && !subName && !className) return;

      var lineObj = {
        className: className,
        leaveName: leaveName,
        subName: subName,
        subject: subject,
        fee: fee
      };

      if (period === 8) {
        // 第8節：只進附註，不計 OO／XX
        period8Lines.push({
          date: rd,
          className: className,
          leaveName: leaveName,
          subName: subName,
          subject: subject
        });
        return;
      }
      if (period < 1 || period > 7) return;
      if (!grid[rd]) grid[rd] = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
      grid[rd][period].push(lineObj);
      if (isQuotaDeductFee(fee)) arrangedQuota++;
      else if (String(fee || '').trim() === '活動公費') arrangedPublic++;
    });

    // 同格排序：班級 → 原任
    dates.forEach(function (ds) {
      for (var p = 1; p <= 7; p++) {
        (grid[ds][p] || []).sort(function (a, b) {
          var ca = String(a.className || '').localeCompare(String(b.className || ''), 'zh-Hant', { numeric: true });
          if (ca) return ca;
          return String(a.leaveName || '').localeCompare(String(b.leaveName || ''), 'zh-Hant');
        });
      }
    });
    period8Lines.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return String(a.className || '').localeCompare(String(b.className || ''), 'zh-Hant', { numeric: true });
    });

    // OO＝釋出堂數（與發放額度合計同）；XX＝扣額度已排；尚有＝OO−XX
    var demand = parseInt(opts.demand, 10);
    if (Number.isNaN(demand) || demand < 0) demand = 0;
    var arranged = arrangedQuota;
    var remaining = Math.max(0, demand - arranged);

    return {
      dates: dates,
      grid: grid,
      period8Lines: period8Lines,
      demand: demand,
      arranged: arranged,
      arrangedPublic: arrangedPublic,
      remaining: remaining
    };
  }

  /** 格內：班級原任→代理（與範本一致；多筆換行） */
  function formatCellLines(items) {
    return (items || []).map(function (it) {
      var cn = String(it.className || '').trim();
      var leave = String(it.leaveName || '').trim();
      var sub = String(it.subName || '').trim();
      // 範本常見「707鄭惠文→黃慧菁」或「701 莊淨婷→陸天馨」；統一：班與名之間無空白（班碼短）
      var left = cn + leave;
      if (!left && !sub) return '';
      if (!sub) return left;
      if (!left) return '→' + sub;
      return left + '→' + sub;
    }).filter(Boolean).join('\n');
  }

  /**
   * 第8節附註：單行、靠左小字；含班級
   * 例：【第八節】10/16 803羽球 黃筱卉→陳禹廷；10/17 7書法 張珍禎→蔡金祝（計畫經費）
   */
  function formatPeriod8Note(lines) {
    if (!lines || !lines.length) return '';
    var items = (lines || []).map(function (it) {
      var md = formatMd(it.date);
      var subj = String(it.subject || '').trim();
      var cn = String(it.className || '').trim();
      var leave = String(it.leaveName || '').trim();
      var sub = String(it.subName || '').trim();
      // 班＋科（無空白）：803羽球；僅科時 8羽球；僅班時班級
      var head = '';
      if (cn && subj) head = cn + subj;
      else if (cn) head = cn;
      else if (subj) head = '8' + subj;
      else head = '8';
      var pair = leave + (sub ? '→' + sub : '');
      var body = pair ? (head + ' ' + pair) : head;
      return md + ' ' + body;
    }).filter(Boolean);
    if (!items.length) return '';
    return '【第八節】' + items.join('；') + '（計畫經費）';
  }

  function getJSZip() {
    if (window.JSZip) return window.JSZip;
    if (typeof JSZip !== 'undefined') return JSZip;
    return null;
  }

  async function loadTemplateBuffer() {
    if (_templateBuf) return _templateBuf.slice(0);
    var url = TEMPLATE_URL + (TEMPLATE_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('無法載入輪值通知單模板（' + res.status + '）');
    var buf = await res.arrayBuffer();
    _templateBuf = buf;
    return buf.slice(0);
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 在 document.xml 字串內做佔位符替換（佔位符為完整 {{KEY}}，不會拆 run）
   */
  function replacePlaceholders(xml, map) {
    var out = xml;
    Object.keys(map).forEach(function (k) {
      var token = '{{' + k + '}}';
      var raw = map[k] == null ? '' : String(map[k]);
      // 換行 → Word 軟換行（同一段，不另開頁）
      var val = raw.split(/\r?\n/).map(function (line) {
        return xmlEsc(line);
      }).join('<w:br/>');
      out = out.split(token).join(val);
    });
    return out;
  }

  /**
   * 多行文字 → 多個 <w:p>；沿用 sampleP 的 pPr／rPr
   */
  function paragraphsFromText(samplePXml, text) {
    var lines = String(text || '').split(/\r?\n/);
    if (!lines.length) lines = [''];
    // 從 sample 抽出 pPr、rPr
    var pPrMatch = samplePXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/);
    var rPrMatch = samplePXml.match(/<w:rPr[\s\S]*?<\/w:rPr>/);
    var pPr = pPrMatch ? pPrMatch[0] : '';
    var rPr = rPrMatch ? rPrMatch[0] : '<w:rPr><w:rFonts w:ascii="標楷體" w:eastAsia="標楷體" w:hAnsi="標楷體"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
    // 抓 sample 的 p 開頭屬性
    var pOpenMatch = samplePXml.match(/<w:p\b[^>]*>/);
    var pOpen = pOpenMatch ? pOpenMatch[0] : '<w:p>';
    return lines.map(function (line) {
      return pOpen
        + pPr
        + '<w:r>' + rPr + '<w:t xml:space="preserve">' + xmlEsc(line) + '</w:t></w:r>'
        + '</w:p>';
    }).join('');
  }

  /**
   * 複製模板資料列，填入日期／星期／各節
   */
  function buildDataRowsXml(templateRowXml, matrix) {
    var dates = matrix.dates || [];
    var grid = matrix.grid || {};
    if (!dates.length) {
      // 至少一列空
      return templateRowXml
        .replace(/\{\{DATE\}\}/g, '')
        .replace(/\{\{DOW\}\}/g, '');
    }

    // 取出各 cell 內第一個 <w:p>…</w:p> 當樣式樣本（依欄位順序）
    var tcBlocks = [];
    var reTc = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    var m;
    while ((m = reTc.exec(templateRowXml)) !== null) {
      tcBlocks.push(m[0]);
    }
    if (tcBlocks.length < 9) {
      // 容錯：直接字串替換 DATE/DOW，節次留空
      return dates.map(function (ds) {
        var d = parseDate(ds);
        var dow = d ? (DAY_ZH[d.getDay()] || '') : '';
        return templateRowXml
          .replace(/\{\{DATE\}\}/g, xmlEsc(formatMd(ds)))
          .replace(/\{\{DOW\}\}/g, xmlEsc(dow));
      }).join('');
    }

    function rebuildTc(tcXml, text) {
      // 保留 tcPr，重寫段落
      var tcPrMatch = tcXml.match(/<w:tcPr[\s\S]*?<\/w:tcPr>/);
      var tcPr = tcPrMatch ? tcPrMatch[0] : '';
      var pMatch = tcXml.match(/<w:p\b[\s\S]*?<\/w:p>/);
      var sampleP = pMatch ? pMatch[0] : '<w:p><w:r><w:t></w:t></w:r></w:p>';
      var paras = paragraphsFromText(sampleP, text);
      var openMatch = tcXml.match(/<w:tc\b[^>]*>/);
      var open = openMatch ? openMatch[0] : '<w:tc>';
      return open + tcPr + paras + '</w:tc>';
    }

    var trOpenMatch = templateRowXml.match(/<w:tr\b[^>]*>/);
    var trOpen = trOpenMatch ? trOpenMatch[0] : '<w:tr>';
    // 列高：天數多時壓低，避免表格＋附註擠到第二頁（橫向 A4）
    var dayN = dates.length || 1;
    var rowH = dayN <= 2 ? 900 : (dayN <= 3 ? 720 : (dayN <= 5 ? 560 : 420));
    var trPr = '<w:trPr><w:trHeight w:val="' + rowH + '" w:hRule="atLeast"/></w:trPr>';

    return dates.map(function (ds) {
      var d = parseDate(ds);
      var dow = d ? (DAY_ZH[d.getDay()] || '') : '';
      var dayGrid = grid[ds] || {};
      var cells = [];
      cells.push(rebuildTc(tcBlocks[0], formatMd(ds)));
      cells.push(rebuildTc(tcBlocks[1], dow));
      for (var p = 1; p <= 7; p++) {
        cells.push(rebuildTc(tcBlocks[1 + p], formatCellLines(dayGrid[p] || [])));
      }
      return trOpen + trPr + cells.join('') + '</w:tr>';
    }).join('');
  }

  function injectDataRows(documentXml, matrix) {
    // 只匹配「同一列」內含 {{DATE}} 的 tr（不可跨列，否則會吃掉表頭「日期／星期／第一節…」）
    var rowRe = /<w:tr\b(?:(?!<\/w:tr>)[\s\S])*\{\{DATE\}\}(?:(?!<\/w:tr>)[\s\S])*<\/w:tr>/;
    var m = documentXml.match(rowRe);
    if (!m) {
      return documentXml;
    }
    var templateRow = m[0];
    var rowsXml = buildDataRowsXml(templateRow, matrix);
    return documentXml.replace(rowRe, rowsXml);
  }

  async function exportWord(opts) {
    opts = opts || {};
    var JSZipLib = getJSZip();
    if (!JSZipLib) return { ok: false, error: 'JSZip 未載入，請重新整理頁面' };

    var startDate = String(opts.startDate || '').slice(0, 10);
    var endDate = String(opts.endDate || '').slice(0, 10);
    if (!startDate && !endDate) return { ok: false, error: '請選擇活動期間（或空堂事件）' };

    var activityRaw = String(opts.activityName || opts.activity || '').trim() || '活動';
    var grade = String(opts.grade || '').trim();
    // 事件名常寫「九年級畢旅」：標題用「九年級畢旅」即可，避免「九年級九年級畢旅」
    var activityForTitle = activityRaw;
    var gradeForTitle = grade;
    if (/[七八九]年級/.test(activityRaw)) {
      gradeForTitle = '';
      activityForTitle = activityRaw;
    } else if (grade && activityRaw.indexOf(grade + '年級') === 0) {
      gradeForTitle = '';
    }
    var activity = activityRaw;
    var matrix = buildMatrix(opts);
    if (!matrix.dates.length) return { ok: false, error: '期間內沒有平日可匯出' };
    if (!matrix.arranged) {
      // 允許空表，但提示
    }

    var demand = matrix.demand;
    var arranged = matrix.arranged;
    var remaining = matrix.remaining;
    if (opts.demand != null && opts.demand !== '') {
      demand = parseInt(opts.demand, 10) || 0;
      remaining = Math.max(0, demand - arranged);
    }

    // 標題：{{GRADE}}年級{{ACTIVITY}} → 有年級前綴時 GRADE 留空、ACTIVITY 用全名
    // 內文／統計仍用 activity 全名；年級欄在「未執行的X年級」：事件已含年級時抽中文年級
    var gradeInStats = grade;
    if (!gradeInStats) {
      var gm = activityRaw.match(/([七八九])年級/);
      if (gm) gradeInStats = gm[1];
    }
    var map = {
      GRADE: gradeForTitle || gradeInStats || '　',
      ACTIVITY: gradeForTitle ? activity : activityForTitle,
      RANGE: formatRangeLabel(startDate, endDate) || '',
      DEMAND: String(demand),
      ARRANGED: String(arranged),
      REMAINING: String(remaining),
      EXPORT_DATE: formatExportDate(opts.exportDate),
      NOTE_P8: formatPeriod8Note(matrix.period8Lines)
    };
    // 標題列特殊：若 GRADE 空，模板「{{GRADE}}年級{{ACTIVITY}}」會變「年級畢旅」→ 改成直接 ACTIVITY
    // 改用 TITLE 整段替換更穩：先處理 document 標題佔位
    map.TITLE_LINE = (gradeForTitle
      ? (gradeForTitle + '年級' + activity)
      : activityForTitle) + ' 教師代理遺留課務 輪值通知單';
    map.STATS_GRADE = gradeInStats || '　';

    var tplBuf = await loadTemplateBuffer();
    var zip = await JSZipLib.loadAsync(tplBuf);
    var docFile = zip.file('word/document.xml');
    if (!docFile) return { ok: false, error: '模板缺少 word/document.xml' };
    var xml = await docFile.async('string');
    xml = injectDataRows(xml, matrix);
    // 標題整行替換（避免年級重複）
    xml = xml.split('{{GRADE}}年級{{ACTIVITY}} 教師代理遺留課務 輪值通知單').join(xmlEsc(map.TITLE_LINE));
    // 統計列年級用 STATS_GRADE
    xml = xml.split('{{GRADE}}年級課務').join(xmlEsc(map.STATS_GRADE) + '年級課務');
    xml = replacePlaceholders(xml, map);
    // 清掉未替換的佔位
    xml = xml.replace(/\{\{[A-Z0-9_]+\}\}/g, '');

    zip.file('word/document.xml', xml);
    var outBuf = await zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    // 檔名：{活動名稱}教師代理遺留課務{活動期間日期}.docx
    var rangeLab = formatRangeLabel(startDate, endDate)
      || ((startDate || '').replace(/-/g, '') + (endDate && endDate !== startDate ? '-' + endDate.replace(/-/g, '') : ''))
      || '期間';
    var fileName = opts.fileName
      || (activityRaw + '教師代理遺留課務' + rangeLab + '.docx');
    // 檔名避免特殊字
    fileName = String(fileName).replace(/[\\/:*?"<>|]/g, '_');

    var blob = new Blob([outBuf], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e1) {}
      try { URL.revokeObjectURL(url); } catch (e2) {}
    }, 800);

    return {
      ok: true,
      fileName: fileName,
      dayCount: matrix.dates.length,
      arranged: arranged,
      demand: demand,
      remaining: remaining,
      period8Count: matrix.period8Lines.length,
      warning: matrix.arranged === 0 ? '期間內沒有已送出的代理課務，已匯出空白表' : ''
    };
  }

  /** 從空堂事件推 meta */
  function metaFromEvent(ev) {
    if (!ev) return { activityName: '', grade: '', startDate: '', endDate: '' };
    return {
      activityName: String(ev.name || '').trim(),
      grade: gradesFromClasses(ev.classes || []),
      startDate: String(ev.startDate || '').slice(0, 10),
      endDate: String(ev.endDate || ev.startDate || '').slice(0, 10)
    };
  }

  return {
    exportWord: exportWord,
    buildMatrix: buildMatrix,
    metaFromEvent: metaFromEvent,
    gradesFromClasses: gradesFromClasses,
    formatRangeLabel: formatRangeLabel,
    TEMPLATE_URL: TEMPLATE_URL
  };
})();
