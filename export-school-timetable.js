/**
 * 全校課表彙整匯出（真實 .docx）
 * 列＝教師（試算表順序）；欄＝日期×第 1～8 節；格內＝班級；空堂空白；異動灰底
 */
window.ExportSchoolTimetable = (function () {
  var DAY_ZH = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 0: '日' };
  // 異動灰底（Word 主題色接近）
  var GRAY_HEX = 'D1D5DB';
  var HEADER_HEX = 'E2E8F0';
  var NAME_HEX = 'F8FAFC';
  var MAX_WORKDAYS = 15;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toLocalDateStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDate(dateStr) {
    var s = String(dateStr || '').trim().slice(0, 10);
    if (!s) return null;
    var d = new Date(s.indexOf('T') >= 0 ? s : s + 'T00:00:00');
    if (Number.isNaN(d.getTime())) d = new Date(s.replace(/-/g, '/'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function buildDateRange(startStr, endStr, opts) {
    opts = opts || {};
    var start = parseDate(startStr);
    var end = parseDate(endStr);
    if (!start || !end) return { dates: [], error: '請選擇起迄日期' };
    if (end < start) return { dates: [], error: '迄日不可早於起日' };
    var includeWeekend = !!opts.includeWeekend;
    var dates = [];
    var cur = new Date(start.getTime());
    while (cur <= end) {
      var dow = cur.getDay();
      if (includeWeekend || (dow >= 1 && dow <= 5)) dates.push(toLocalDateStr(cur));
      cur.setDate(cur.getDate() + 1);
    }
    if (!dates.length) return { dates: [], error: '期間內沒有可匯出的日期' };
    var warning = '';
    if (dates.length > MAX_WORKDAYS) {
      warning = '期間共 ' + dates.length + ' 天，表格會很寬，建議縮到約 ' + MAX_WORKDAYS + ' 個工作日內';
    }
    return { dates: dates, warning: warning };
  }

  function formatDateHeader(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return dateStr;
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '（' + (DAY_ZH[d.getDay()] || '') + '）';
  }

  function isChangedCell(cell) {
    return !!(cell && (cell.isSubstituted || cell.isSubstitutionDuty));
  }

  /**
   * 匯出格內文字（真實呈現）：
   * - 無課 → 空白
   * - 調出／被代課（isSubstituted）→ 空白
   * - 空堂事件班（isClassAway 或 isClassAway 回呼）→ 空白（畢旅／畢業班不在）
   * - 調入／代課值班 → 顯示實際上課班級
   * - 一般課 → 班級
   */
  function cellDisplayText(cell, opts) {
    opts = opts || {};
    if (!cell) return '';
    if (cell.isSubstituted) return '';
    var cn = String(cell.className || '').trim();
    if (!cn) return '';
    // 空堂事件：學生班不在 → 匯出留白
    if (cell.isClassAway) return '';
    if (typeof opts.isClassAway === 'function' && opts.isClassAway(cn, opts.dateStr)) return '';
    return cn;
  }

  /**
   * 組矩陣（維持 teachers 傳入順序＝試算表順序）
   */
  function buildMatrix(opts) {
    var teachers = (opts.teachers || []).filter(function (t) { return t && t.email; });
    var dates = opts.dates || [];
    var getCell = opts.getCell;
    var isClassAway = opts.isClassAway;
    var rows = [];
    teachers.forEach(function (t) {
      var cells = [];
      var hasChange = false;
      dates.forEach(function (dateStr) {
        var d = parseDate(dateStr);
        var dayOfWeek = d ? d.getDay() : 0;
        for (var p = 1; p <= 8; p++) {
          var cell = getCell ? getCell(t.email, dateStr, p, dayOfWeek) : null;
          var changed = isChangedCell(cell);
          if (changed) hasChange = true;
          // 空堂事件班也標灰底，方便辨識「為何空白」
          var away = !!(cell && (cell.isClassAway || (typeof isClassAway === 'function' && cell.className && isClassAway(cell.className, dateStr))));
          if (away) hasChange = true;
          cells.push({
            text: cellDisplayText(cell, { isClassAway: isClassAway, dateStr: dateStr }),
            changed: changed || away
          });
        }
      });
      rows.push({
        email: t.email,
        name: t.name || t.email,
        cells: cells,
        hasChange: hasChange
      });
    });
    return { dates: dates, rows: rows };
  }

  /** 期間內是否有任一核准異動（給前端篩選用） */
  function teacherHasChangeInRange(email, dates, getCell) {
    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var d = parseDate(dateStr);
      var dayOfWeek = d ? d.getDay() : 0;
      for (var p = 1; p <= 8; p++) {
        if (isChangedCell(getCell(email, dateStr, p, dayOfWeek))) return true;
      }
    }
    return false;
  }

  // ── 最小 ZIP（store，無壓縮）────────────────────────────────
  function crc32(buf) {
    var table = crc32._t;
    if (!table) {
      table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      crc32._t = table;
    }
    var crc = 0xffffffff;
    for (var i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function strToU8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        i++;
        var c2 = str.charCodeAt(i);
        var u = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(0xf0 | (u >> 18), 0x80 | ((u >> 12) & 0x3f), 0x80 | ((u >> 6) & 0x3f), 0x80 | (u & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }

  function zipStore(files) {
    // files: [{ name, data: Uint8Array }]
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    files.forEach(function (f) {
      var nameBytes = strToU8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var local = []
        .concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0))
        .concat(u32(crc), u32(data.length), u32(data.length))
        .concat(u16(nameBytes.length), u16(0));
      var localArr = new Uint8Array(local.length + nameBytes.length + data.length);
      localArr.set(local, 0);
      localArr.set(nameBytes, local.length);
      localArr.set(data, local.length + nameBytes.length);
      localParts.push(localArr);

      var central = []
        .concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0))
        .concat(u32(crc), u32(data.length), u32(data.length))
        .concat(u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      var centralArr = new Uint8Array(central.length + nameBytes.length);
      centralArr.set(central, 0);
      centralArr.set(nameBytes, central.length);
      centralParts.push(centralArr);
      offset += localArr.length;
    });
    var centralSize = centralParts.reduce(function (s, p) { return s + p.length; }, 0);
    var end = []
      .concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length))
      .concat(u32(centralSize), u32(offset), u16(0));
    var endArr = new Uint8Array(end);
    var total = offset + centralSize + endArr.length;
    var out = new Uint8Array(total);
    var pos = 0;
    localParts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    centralParts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    out.set(endArr, pos);
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** twips: 1cm ≈ 567；邊界 0.6cm ≈ 340 */
  function buildDocumentXml(matrix, meta) {
    meta = meta || {};
    var title = meta.title || '全校課表彙整';
    var rangeLabel = meta.rangeLabel || '';
    var dates = matrix.dates || [];
    var rows = matrix.rows || [];

    // 橫向 A4：W=16838 H=11906 twips；邊界縮小 0.5cm≈284
    var pgW = 16838;
    var pgH = 11906;
    var margin = 284;
    var usableW = pgW - margin * 2;
    var nameW = 720; // 教師欄 ~1.27cm
    var periodW = Math.max(220, Math.floor((usableW - nameW) / Math.max(1, dates.length * 8)));

    function shd(hex) {
      return '<w:shd w:val="clear" w:color="auto" w:fill="' + hex + '"/>';
    }
    function tcBorders() {
      return '<w:tcBorders>'
        + '<w:top w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
        + '<w:left w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
        + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
        + '<w:right w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
        + '</w:tcBorders>';
    }
    function run(text, bold, sz) {
      return '<w:r><w:rPr>'
        + '<w:rFonts w:ascii="Microsoft JhengHei" w:hAnsi="Microsoft JhengHei" w:eastAsia="Microsoft JhengHei"/>'
        + (bold ? '<w:b/>' : '')
        + '<w:sz w:val="' + (sz || 14) + '"/><w:szCs w:val="' + (sz || 14) + '"/>'
        + '</w:rPr><w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>';
    }
    function para(text, center, bold, sz) {
      return '<w:p><w:pPr>'
        + (center ? '<w:jc w:val="center"/>' : '')
        + '<w:spacing w:before="0" w:after="0" w:line="200" w:lineRule="auto"/>'
        + '</w:pPr>' + run(text, bold, sz) + '</w:p>';
    }
    function tc(text, w, fill, center, bold, sz, vMerge, gridSpan) {
      var tcPr = '<w:tcPr>'
        + (gridSpan ? '<w:gridSpan w:val="' + gridSpan + '"/>' : '')
        + (vMerge ? '<w:vMerge w:val="' + vMerge + '"/>' : '')
        + '<w:tcW w:w="' + w + '" w:type="dxa"/>'
        + tcBorders()
        + (fill ? shd(fill) : '')
        + '<w:vAlign w:val="center"/>'
        + '<w:tcMar><w:top w:w="20" w:type="dxa"/><w:left w:w="20" w:type="dxa"/>'
        + '<w:bottom w:w="20" w:type="dxa"/><w:right w:w="20" w:type="dxa"/></w:tcMar>'
        + '</w:tcPr>';
      return '<w:tc>' + tcPr + para(text || '', !!center, !!bold, sz || 14) + '</w:tc>';
    }

    var gridCols = '<w:gridCol w:w="' + nameW + '"/>';
    for (var gi = 0; gi < dates.length * 8; gi++) gridCols += '<w:gridCol w:w="' + periodW + '"/>';

    // header row 1: 教師 + 各日
    var h1 = '<w:tr><w:trPr><w:trHeight w:val="280" w:hRule="atLeast"/></w:trPr>';
    h1 += tc('教師', nameW, HEADER_HEX, true, true, 16, 'restart');
    dates.forEach(function (ds) {
      h1 += tc(formatDateHeader(ds), periodW * 8, HEADER_HEX, true, true, 15, null, 8);
    });
    h1 += '</w:tr>';

    // header row 2: 節次 1-8
    var h2 = '<w:tr><w:trPr><w:trHeight w:val="220" w:hRule="atLeast"/></w:trPr>';
    h2 += tc('', nameW, HEADER_HEX, true, true, 14, 'continue');
    dates.forEach(function () {
      for (var p = 1; p <= 8; p++) {
        h2 += tc(String(p), periodW, 'F1F5F9', true, true, 12);
      }
    });
    h2 += '</w:tr>';

    var body = '';
    rows.forEach(function (r) {
      body += '<w:tr><w:trPr><w:trHeight w:val="240" w:hRule="atLeast"/></w:trPr>';
      body += tc(r.name, nameW, NAME_HEX, true, true, 14);
      (r.cells || []).forEach(function (c) {
        body += tc(c.text || '', periodW, c.changed ? GRAY_HEX : null, true, false, 13);
      });
      body += '</w:tr>';
    });

    var legend = '說明：格內為實際上課班級；調出／被代課與空堂事件班留白；灰底＝調代課異動或空堂事件班。'
      + (rangeLabel ? '　期間：' + rangeLabel : '')
      + '　共 ' + rows.length + ' 位教師。';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<w:body>'
      + para(title, false, true, 22)
      + para(legend, false, false, 14)
      + '<w:tbl>'
      + '<w:tblPr>'
      + '<w:tblW w:w="' + (nameW + periodW * dates.length * 8) + '" w:type="dxa"/>'
      + '<w:tblLayout w:type="fixed"/>'
      + '<w:tblBorders>'
      + '<w:top w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '<w:left w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '<w:right w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="64748B"/>'
      + '</w:tblBorders>'
      + '</w:tblPr>'
      + '<w:tblGrid>' + gridCols + '</w:tblGrid>'
      + h1 + h2 + body
      + '</w:tbl>'
      + '<w:sectPr>'
      + '<w:pgSz w:w="' + pgW + '" w:h="' + pgH + '" w:orient="landscape"/>'
      + '<w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin + '" w:left="' + margin + '" '
      + 'w:header="0" w:footer="0" w:gutter="0"/>'
      + '</w:sectPr>'
      + '</w:body></w:document>';
  }

  function buildDocxBlob(matrix, meta) {
    var documentXml = buildDocumentXml(matrix, meta);
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '</Relationships>';
    var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    var now = new Date().toISOString();
    var core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
      + 'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + '<dc:title>' + xmlEsc((meta && meta.title) || '全校課表彙整') + '</dc:title>'
      + '<dc:creator>建成國中調代課系統</dc:creator>'
      + '<cp:lastModifiedBy>建成國中調代課系統</cp:lastModifiedBy>'
      + '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>'
      + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>'
      + '</cp:coreProperties>';
    var app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
      + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + '<Application>JCJH Sub System</Application></Properties>';

    var zipBytes = zipStore([
      { name: '[Content_Types].xml', data: strToU8(contentTypes) },
      { name: '_rels/.rels', data: strToU8(rels) },
      { name: 'word/document.xml', data: strToU8(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: strToU8(docRels) },
      { name: 'docProps/core.xml', data: strToU8(core) },
      { name: 'docProps/app.xml', data: strToU8(app) }
    ]);
    return new Blob([zipBytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || '全校課表彙整.docx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /**
   * @param {object} opts
   * @param {string} opts.startDate
   * @param {string} opts.endDate
   * @param {boolean} [opts.includeWeekend]
   * @param {Array} opts.teachers 已篩選、且保持試算表順序
   * @param {function} opts.getCell
   * @param {boolean} [opts.onlyChanged] 若 true 再濾掉期間無異動者
   */
  function exportWord(opts) {
    opts = opts || {};
    var range = buildDateRange(opts.startDate, opts.endDate, {
      includeWeekend: !!opts.includeWeekend
    });
    if (range.error) return { ok: false, error: range.error };

    // 維持傳入順序（試算表順序），不依姓名排序
    var teachers = (opts.teachers || []).filter(function (t) { return t && t.email; });
    if (!teachers.length) return { ok: false, error: '請至少選擇一位教師' };

    var matrix = buildMatrix({
      teachers: teachers,
      dates: range.dates,
      getCell: opts.getCell,
      isClassAway: opts.isClassAway
    });

    if (opts.onlyChanged) {
      matrix.rows = matrix.rows.filter(function (r) { return r.hasChange; });
      if (!matrix.rows.length) {
        return { ok: false, error: '選定期間內沒有任何調代課／空堂異動的教師' };
      }
    }

    var startLab = formatDateHeader(range.dates[0]);
    var endLab = formatDateHeader(range.dates[range.dates.length - 1]);
    var rangeLabel = startLab + '～' + endLab + '（共 ' + range.dates.length + ' 天）';
    var title = opts.title || '建成國中全校課表彙整';
    var blob = buildDocxBlob(matrix, { title: title, rangeLabel: rangeLabel });
    var fileName = opts.fileName
      || ('全校課表彙整_' + String(opts.startDate || '').replace(/-/g, '') + '-' + String(opts.endDate || '').replace(/-/g, '') + '.docx');
    downloadBlob(blob, fileName);
    return {
      ok: true,
      warning: range.warning || '',
      fileName: fileName,
      dayCount: range.dates.length,
      teacherCount: matrix.rows.length
    };
  }

  function thisWeekRange() {
    var dates = (window.DateUtils && window.DateUtils.getWeekDatesFromDate)
      ? window.DateUtils.getWeekDatesFromDate(new Date())
      : [];
    if (dates.length >= 5) return { startDate: dates[0], endDate: dates[4] };
    var now = new Date();
    var day = now.getDay();
    var monDiff = day === 0 ? -6 : 1 - day;
    var mon = new Date(now);
    mon.setDate(now.getDate() + monDiff);
    var fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    return { startDate: toLocalDateStr(mon), endDate: toLocalDateStr(fri) };
  }

  return {
    MAX_WORKDAYS: MAX_WORKDAYS,
    GRAY_HEX: GRAY_HEX,
    buildDateRange: buildDateRange,
    buildMatrix: buildMatrix,
    teacherHasChangeInRange: teacherHasChangeInRange,
    exportWord: exportWord,
    thisWeekRange: thisWeekRange,
    formatDateHeader: formatDateHeader
  };
})();
