(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NameKeyContract = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var EMAIL_RE = /email|電子郵件|e-mail/i;
  var SPECIAL_FLOW_COMBINED_RETURN = 'combined_return';
  var SPECIAL_FLOW_COMBINED_RETURN_LABEL = '合班回原班';
  var SPECS = {
    '教師課表': {
      nameFields: ['教師姓名'],
      legacyFields: ['教師Email', 'teacherEmail'],
      headers: ['學期代號', '課表ID', '教師姓名', '星期', '節次', '班級', '科目', '課堂屬性', '調課限制', '特殊標記']
    },
    '申請單': {
      nameFields: ['申請人姓名', '受邀人姓名', '代申請人姓名'],
      legacyFields: ['申請人Email', '受邀人Email', '代申請人Email', 'requesterEmail', 'targetTeacherEmail', 'proxyByEmail'],
      headers: ['學期代號', '申請單ID', '單號', '批次ID', '狀態', '申請人姓名', '受邀人姓名', '代申請人姓名', '班級', '科目', '異動日期', '異動星期', '異動節次', '異動類型', '特殊流程', '對調目標日期', '對調目標星期', '對調目標節次', '經費來源', '請假事由', '請假時間類型', '請假時間', '是否已印', '備註', '建立時間', '更新時間']
    },
    '代導紀錄': {
      nameFields: ['原導師姓名', '代導教師姓名', '操作者'],
      legacyFields: ['原導師Email', '代導教師Email', 'originalTeacherEmail', 'actualTeacherEmail', 'operatorEmail'],
      headers: ['學期代號', '代導紀錄ID', '來源申請單ID', '原導師姓名', '班級', '代導日期', '請假時間類型', '請假時間', '代導教師姓名', '代導節數', '鐘點費', '狀態', '啟用', '建立時間', '更新時間', '操作者', '備註']
    },
    '額度帳本': {
      nameFields: ['教師姓名', '操作者'],
      legacyFields: ['教師Email', 'email', 'operatorEmail'],
      headers: ['學期代號', '流水ID', '時間', '教師姓名', '異動', '餘額後', '類型', '包ID', '事件ID', '事件名稱', '起日', '迄日', '申請單ID', '操作者', '備註', '索引鍵']
    }
  };

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function key(value) {
    return text(value).toLowerCase();
  }

  function field(row, names) {
    var source = row || {};
    for (var i = 0; i < names.length; i++) {
      var value = source[names[i]];
      if (value !== undefined && value !== null && text(value) !== '') return value;
    }
    return '';
  }

  function fieldOrEmpty(row, names) {
    return field(row, names);
  }

  function normalizeSpecialFlow(raw) {
    var value = text(raw);
    if (!value) return '';
    if (value.toLowerCase() === SPECIAL_FLOW_COMBINED_RETURN
        || value === SPECIAL_FLOW_COMBINED_RETURN_LABEL) {
      return SPECIAL_FLOW_COMBINED_RETURN;
    }
    return value;
  }

  function isCombinedReturn(rowOrValue) {
    var raw = rowOrValue && typeof rowOrValue === 'object'
      ? field(rowOrValue, ['特殊流程', 'specialFlow'])
      : rowOrValue;
    return normalizeSpecialFlow(raw) === SPECIAL_FLOW_COMBINED_RETURN;
  }

  function error(code, message, details) {
    var err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
  }

  function teacherName(row) {
    return text(field(row, ['教師姓名', 'teacherName', 'name']));
  }

  function teacherEmail(row) {
    return key(field(row, ['教師Email', 'teacherEmail', 'email', 'loginEmail']));
  }

  function semesterId(row, fallback) {
    return text(field(row, ['學期代號', 'semesterId']) || fallback);
  }

  function directoryKey(sid, value) {
    return text(sid) + '|' + key(value);
  }

  function buildDirectory(teacherRows) {
  var byName = Object.create(null);
  var byEmail = Object.create(null);
   var globalName = Object.create(null);
    var rows = Array.isArray(teacherRows) ? teacherRows : [];
    rows.forEach(function (row, index) {
      var sid = semesterId(row);
      var name = teacherName(row);
      var email = teacherEmail(row);
      if (!sid || !name) {
        throw error('INVALID_TEACHER', '教師名單第' + (index + 1) + '列缺少學期代號或教師姓名');
      }
      var nameKey = directoryKey(sid, name);
      if (byName[nameKey]) {
        throw error('DUPLICATE_TEACHER_NAME', '同學期教師姓名重複：' + sid + '／' + name, {
          semesterId: sid,
          name: name,
          indexes: [byName[nameKey].index, index]
        });
      }
      var entry = { semesterId: sid, name: name, email: email, row: row, index: index };
      var globalNameKey = key(name);
      if (globalName[globalNameKey] && globalName[globalNameKey].email !== email) {
        throw error('DUPLICATE_GLOBAL_TEACHER_NAME', '教師姓名必須全歷史唯一：' + name, {
          name: name,
          email: email
        });
      }
      globalName[globalNameKey] = entry;
      byName[nameKey] = entry;
      if (email) {
        var emailKey = directoryKey(sid, email);
        if (byEmail[emailKey] && byEmail[emailKey].name !== name) {
          throw error('DUPLICATE_TEACHER_EMAIL', '同學期教師 Email 對應多位教師：' + sid + '／' + email, {
            semesterId: sid,
            email: email
          });
        }
        byEmail[emailKey] = entry;
      }
    });
    return { byName: byName, byEmail: byEmail };
  }

  function resolveName(value, directory, sid, label) {
    var raw = text(value);
    if (!raw) return '';
    var nameHit = directory.byName[directoryKey(sid, raw)];
    if (nameHit) return nameHit.name;
    var emailHit = directory.byEmail[directoryKey(sid, raw)];
    if (emailHit) return emailHit.name;
    throw error('UNMAPPED_TEACHER', (label || '教師') + '無法對應教師名單：' + raw, {
      semesterId: sid,
      value: raw,
      label: label || '教師'
    });
  }

  function resolvePair(nameValue, emailValue, directory, sid, label) {
    var name = text(nameValue);
    var email = text(emailValue);
    var resolvedName = name ? resolveName(name, directory, sid, label) : '';
    var resolvedEmailName = email ? resolveName(email, directory, sid, label) : '';
    if (resolvedName && resolvedEmailName && key(resolvedName) !== key(resolvedEmailName)) {
      throw error('TEACHER_REFERENCE_MISMATCH', (label || '教師') + '姓名與 Email 對應不一致：' + name + '／' + email, {
        semesterId: sid,
        name: name,
        email: email
      });
    }
    return resolvedName || resolvedEmailName;
  }

  function hasValue(row, names) {
    return names.some(function (name) {
      return row && row[name] !== undefined && row[name] !== null && text(row[name]) !== '';
    });
  }

  function copyNonEmailFields(row, output) {
    Object.keys(row || {}).forEach(function (name) {
      if (EMAIL_RE.test(name)) return;
      if (name === 'teacherEmail' || name === 'requesterEmail' || name === 'targetTeacherEmail' || name === 'proxyByEmail' || name === 'originalTeacherEmail' || name === 'actualTeacherEmail' || name === 'operatorEmail') return;
      if (output[name] === undefined) output[name] = row[name];
    });
    return output;
  }

  function migrateRow(sheetName, row, directory, fallbackSemesterId) {
    var spec = SPECS[sheetName];
    if (!spec) throw error('UNSUPPORTED_SHEET', '不支援姓名鍵 migration：' + sheetName);
    var sid = semesterId(row, fallbackSemesterId);
    if (!sid) throw error('MISSING_SEMESTER', sheetName + '資料缺少學期代號');
    var output = copyNonEmailFields(row, {});
    output['學期代號'] = sid;

    if (sheetName === '教師課表') {
      output['教師姓名'] = resolvePair(fieldOrEmpty(row, ['教師姓名', 'teacherName']), fieldOrEmpty(row, spec.legacyFields), directory, sid, '課表教師');
    } else if (sheetName === '申請單') {
      output['申請人姓名'] = resolvePair(fieldOrEmpty(row, ['申請人姓名', 'requesterName']), fieldOrEmpty(row, ['申請人Email', 'requesterEmail']), directory, sid, '申請人');
      var combinedReturn = isCombinedReturn(row);
      if (combinedReturn && !hasValue(row, ['受邀人姓名', 'targetTeacherName', '受邀人Email', 'targetTeacherEmail'])) {
        throw error('INVALID_COMBINED_RETURN', '合班回原班請指定同節併班代課教師');
      }
      output['受邀人姓名'] = resolvePair(fieldOrEmpty(row, ['受邀人姓名', 'targetTeacherName']), fieldOrEmpty(row, ['受邀人Email', 'targetTeacherEmail']), directory, sid, '受邀人');
      output['特殊流程'] = combinedReturn ? SPECIAL_FLOW_COMBINED_RETURN_LABEL : field(row, ['特殊流程', 'specialFlow']);
      if (hasValue(row, ['代申請人姓名', 'proxyByName', '代申請人Email', 'proxyByEmail'])) {
        output['代申請人姓名'] = resolvePair(fieldOrEmpty(row, ['代申請人姓名', 'proxyByName']), fieldOrEmpty(row, ['代申請人Email', 'proxyByEmail']), directory, sid, '代申請人');
      } else {
        output['代申請人姓名'] = '';
      }
    } else if (sheetName === '代導紀錄') {
      output['原導師姓名'] = resolvePair(fieldOrEmpty(row, ['原導師姓名', 'originalTeacherName']), fieldOrEmpty(row, ['原導師Email', 'originalTeacherEmail']), directory, sid, '原導師');
      output['代導教師姓名'] = resolvePair(fieldOrEmpty(row, ['代導教師姓名', 'actualTeacherName']), fieldOrEmpty(row, ['代導教師Email', 'actualTeacherEmail']), directory, sid, '代導教師');
      output['操作者'] = resolvePair(fieldOrEmpty(row, ['操作者', 'operatorName']), fieldOrEmpty(row, ['operatorEmail']), directory, sid, '操作者');
    } else if (sheetName === '額度帳本') {
      output['教師姓名'] = resolvePair(fieldOrEmpty(row, ['教師姓名', 'name']), fieldOrEmpty(row, ['教師Email', 'email']), directory, sid, '額度教師');
      output['操作者'] = resolvePair(fieldOrEmpty(row, ['操作者', 'operatorName']), fieldOrEmpty(row, ['operatorEmail']), directory, sid, '操作者');
      output['索引鍵'] = sid + '|' + key(output['教師姓名']);
    }
    spec.nameFields.forEach(function (nameField) {
      if (output[nameField] === undefined) output[nameField] = '';
    });
    return output;
  }

  function migrateRows(sheetName, rows, teacherRows, fallbackSemesterId) {
    var directory = buildDirectory(teacherRows);
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return migrateRow(sheetName, row || {}, directory, fallbackSemesterId);
    });
  }

  function migrateHeaders(sheetName, headers) {
    var spec = SPECS[sheetName];
    if (!spec) throw error('UNSUPPORTED_SHEET', '不支援姓名鍵欄位 migration：' + sheetName);
    var seen = Object.create(null);
    var extras = (Array.isArray(headers) ? headers : []).filter(function (header) {
      var h = text(header);
      if (!h || EMAIL_RE.test(h) || spec.legacyFields.indexOf(h) >= 0 || seen[h]) return false;
      seen[h] = true;
      return spec.headers.indexOf(h) < 0;
    });
    return spec.headers.concat(extras);
  }

  function renameRows(rows, semesterIdValue, fromName, toName) {
    var sid = text(semesterIdValue);
    var fromKey = key(fromName);
    var to = text(toName);
    if (!sid || !fromKey || !to) throw error('INVALID_RENAME', '改名需要學期、原姓名與新姓名');
    if (fromKey === key(to)) return (rows || []).map(function (row) { return Object.assign({}, row); });
    return (Array.isArray(rows) ? rows : []).map(function (source) {
      var row = Object.assign({}, source);
      if (text(row['學期代號'] || row.semesterId) !== sid) return row;
      ['教師姓名', '申請人姓名', '受邀人姓名', '代申請人姓名', '原導師姓名', '代導教師姓名', '操作者'].forEach(function (fieldName) {
        if (key(row[fieldName]) === fromKey) row[fieldName] = to;
      });
      if (row['索引鍵'] && key(row['教師姓名']) === key(to)) row['索引鍵'] = sid + '|' + key(to);
      return row;
    });
  }

  function canonicalHeaders(sheetName) {
    var spec = SPECS[sheetName];
    if (!spec) throw error('UNSUPPORTED_SHEET', '不支援姓名鍵欄位：' + sheetName);
    return spec.headers.slice();
  }

  return {
    SPECIAL_FLOW_COMBINED_RETURN: SPECIAL_FLOW_COMBINED_RETURN,
    SPECIAL_FLOW_COMBINED_RETURN_LABEL: SPECIAL_FLOW_COMBINED_RETURN_LABEL,
    SPECS: SPECS,
    canonicalHeaders: canonicalHeaders,
    migrateHeaders: migrateHeaders,
    buildDirectory: buildDirectory,
    resolveName: resolveName,
    migrateRow: migrateRow,
    migrateRows: migrateRows,
    renameRows: renameRows,
    normalizeText: text,
    normalizeKey: key,
    normalizeSpecialFlow: normalizeSpecialFlow,
    isCombinedReturn: isCombinedReturn
  };
});
