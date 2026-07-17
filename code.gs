// 學校調代課線上系統 - Google Apps Script 後端 API (純 Google Sheets + GSI 驗證版)

// 開啟/讀取試算表
function getSpreadsheet() {
  const prop = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (prop) return SpreadsheetApp.openById(prop);
  return SpreadsheetApp.getActiveSpreadsheet();
}


// ----------------- 安全與效能設定 -----------------
// 可在「專案設定 → 指令碼屬性」覆寫：EXPECTED_CLIENT_ID / ALLOWED_HD / ALLOW_MOCK_TOKEN
function getConfig_(key, fallback) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  } catch (e) {}
  return fallback;
}

var EXPECTED_CLIENT_ID_ = getConfig_(
  "EXPECTED_CLIENT_ID",
  "1081491085278-vefjcpkum13r2vm3nungvn6vb259o2at.apps.googleusercontent.com"
);
// 逗號分隔允許的 Workspace 網域（hd）；* 或空白 = 不限制（測試期）
var ALLOWED_HD_ = getConfig_("ALLOWED_HD", "*");
// 正式環境務必為 false；僅本機除錯時可在指令碼屬性設 ALLOW_MOCK_TOKEN=true
var ALLOW_MOCK_TOKEN_ = (getConfig_("ALLOW_MOCK_TOKEN", "false").toLowerCase() === "true");
// 全量／分層快取秒數（可於指令碼屬性覆寫）
var CACHE_TTL_FULL_ = parseInt(getConfig_("CACHE_TTL_FULL", "120"), 10) || 120; // admin 組裝後 payload
var CACHE_TTL_TEACHER_FULL_ = parseInt(getConfig_("CACHE_TTL_TEACHER_FULL", "60"), 10) || 60; // 教師共用底包（短 TTL）
var CACHE_TTL_SCHED_ = parseInt(getConfig_("CACHE_TTL_SCHED", "600"), 10) || 600; // 課表（少改）
var CACHE_TTL_TEACHERS_ = parseInt(getConfig_("CACHE_TTL_TEACHERS", "300"), 10) || 300;
var CACHE_TTL_META_ = parseInt(getConfig_("CACHE_TTL_META", "300"), 10) || 300;
var CACHE_TTL_REQ_ = parseInt(getConfig_("CACHE_TTL_REQ", "90"), 10) || 90; // 申請單時間窗
var CACHE_TTL_PENDING_ = parseInt(getConfig_("CACHE_TTL_PENDING", "45"), 10) || 45; // pendingOnly
var CACHE_TTL_MATCH_ = parseInt(getConfig_("CACHE_TTL_MATCH", "45"), 10) || 45; // 媒合候選短快取

function getAllowedHdList_() {
  // 系統設定可覆寫
  try {
    var raw = getTableData("系統設定");
    for (var i = 0; i < raw.length; i++) {
      var name = String(raw[i]["設定名稱"] || raw[i]["設定鍵"] || "");
      if (name === "allowedHd" && raw[i]["設定值"]) {
        return String(raw[i]["設定值"]).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      }
    }
  } catch (e) {}
  return String(ALLOWED_HD_).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function getSuperAdminEmails_() {
  var list = [];
  try {
    var raw = getTableData("系統設定");
    for (var i = 0; i < raw.length; i++) {
      var name = String(raw[i]["設定名稱"] || raw[i]["設定鍵"] || "");
      if (name === "superAdminEmails" && raw[i]["設定值"]) {
        list = String(raw[i]["設定值"]).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
        break;
      }
    }
  } catch (e) {}
  return list;
}

function resolveIsAdmin_(userEmail, teachers) {
  var email = String(userEmail || "").toLowerCase();
  var supers = getSuperAdminEmails_();
  if (supers.indexOf(email) !== -1) return true;
  if (!teachers || teachers.length === 0) {
    // 空白名單：僅 superAdminEmails 可 bootstrap；未設定超管時才允許首位登入者（防卡死）
    if (supers.length > 0) return false;
    return true;
  }
  var currentTeacher = teachers.find(function (t) {
    return String(t["教師Email"] || "").toLowerCase() === email;
  });
  if (!currentTeacher) return false;
  return String(currentTeacher["系統角色"] || "") === "admin";
}

function sheetsReady_() {
  var ss = getSpreadsheet();
  var need = ["學期設定", "教師名單", "教師課表", "申請單", "系統設定", "班級空堂事件"];
  for (var i = 0; i < need.length; i++) {
    if (!ss.getSheetByName(need[i])) return false;
  }
  return true;
}

function ensureInit_() {
  if (!sheetsReady_()) initSheets();
}

// 取得工作表的欄位標頭（動態定位防禦：讀取首行，若無則回傳預設）
function getHeadersForSheet(sheetName) {
  const defaults = {
    "學期設定": ["學期代號", "學期名稱", "開始日期", "結束日期", "結算日期", "是否預設"],
    // 表頭與前端 FieldMap / 寫入 Key 對齊；field-map.js 讀取時另支援舊別名（任課科目、原任課教師Email）
    "教師名單": ["學期代號", "教師Email", "教師姓名", "授課科目", "系統角色", "基本鐘點", "互代額度"],
    "教師課表": ["學期代號", "課表ID", "教師Email", "教師姓名", "星期", "節次", "班級", "科目", "課堂屬性", "調課限制"],
    "申請單": ["學期代號", "申請單ID", "單號", "批次ID", "狀態", "申請人Email", "申請人姓名", "受邀人Email", "受邀人姓名", "班級", "科目", "異動日期", "異動星期", "異動節次", "異動類型", "對調目標日期", "對調目標星期", "對調目標節次", "經費來源", "請假事由", "是否已印", "備註", "建立時間", "更新時間"],
    "班級空堂事件": ["學期代號", "事件ID", "事件名稱", "起日", "迄日", "班級清單", "鐘點規則", "可進互代", "啟用", "備註"],
    "系統設定": ["設定名稱", "設定值"]
  };
  
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (sheet && sheet.getLastRow() > 0) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var defaultHeaders = defaults[sheetName] || [];
    defaultHeaders.forEach(function (h) {
      if (headers.indexOf(h) === -1) {
        headers.push(h);
        sheet.getRange(1, headers.length).setValue(h).setFontWeight("bold").setBackground("#f1f5f9");
      }
    });
    return headers;
  }
  return defaults[sheetName] || [];
}

// 自動建置工作表結構
function initSheets() {
  const ss = getSpreadsheet();
  const allSheets = ss.getSheets();

  // 0. 自我診斷與修復：如果工作表「系統設定」的內容實為錯誤日誌，表示被誤改名了，強制正名回「系統日誌」
  var sysSettingSheet = ss.getSheetByName("系統設定");
  if (sysSettingSheet && sysSettingSheet.getLastRow() > 0) {
    try {
      var range = sysSettingSheet.getRange(1, 1, 1, Math.min(sysSettingSheet.getLastColumn(), 3));
      var headers = range.getValues()[0];
      var isErrorLog = false;
      for (var k = 0; k < headers.length; k++) {
        var hStr = String(headers[k]);
        if (hStr.indexOf("錯誤") !== -1 || hStr.indexOf("操作") !== -1 || hStr.indexOf("時間") !== -1) {
          isErrorLog = true;
          break;
        }
      }
      if (isErrorLog) {
        var actualLogSheet = ss.getSheetByName("系統日誌");
        if (actualLogSheet) {
          try { ss.deleteSheet(actualLogSheet); } catch(e) {}
        }
        sysSettingSheet.setName("系統日誌");
      }
    } catch(e) {}
  }

  // 1. 白名單：以下工作表名稱已是正確狀態，直接跳過
  allSheets.forEach(sheet => {
    var oldName = sheet.getName();
    var newName = null;
    if (oldName === "教師課表" || oldName === "教師名單" ||
        oldName === "學期設定" ||
        oldName === "申請單"      || oldName === "系統設定" ||
        oldName === "班級空堂事件" ||
        oldName === "系統日誌") {
      return;
    }
    if      (oldName.indexOf("課表") !== -1) { newName = "教師課表"; }
    else if (oldName.indexOf("師") !== -1 || oldName.indexOf("名單") !== -1) { newName = "教師名單"; }
    else if (oldName.indexOf("學") !== -1 && oldName.indexOf("設") !== -1) { newName = "學期設定"; }
    else if (oldName.indexOf("系統設") !== -1) { newName = "系統設定"; }
    else if (oldName.length === 3 && (oldName.indexOf("單") !== -1 || oldName.indexOf("申") !== -1)) { newName = "申請單"; }
    if (newName) {
      var targetSheet = ss.getSheetByName(newName);
      if (!targetSheet) { sheet.setName(newName); }
      else if (targetSheet.getLastRow() <= 1) { try { ss.deleteSheet(targetSheet); sheet.setName(newName); } catch(e) {} }
    }
  });

  // 2. 標準建置工作表
  const sheets = ["學期設定","教師名單","教師課表","申請單","班級空堂事件","系統設定","系統日誌"];
  sheets.forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) { sheet = ss.insertSheet(name); }
    if (sheet.getLastRow() === 0) {
      const headers = getHeadersForSheet(name);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
    }
  });
}

// 讀取工作表並轉換為物件陣列（二維陣列一次性讀取）
function getTableData(sheetName) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  const data = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    let hasValue = false;
    for (let j = 0; j < headers.length; j++) {
      let val = row[j];
      // 將 Date 物件轉為 YYYY-MM-DD 字串，避免 JSON 序列化時差問題
      if (val instanceof Date) {
        val = toLocalDateStr(val);
      }
      
      // 翻譯為英文狀態與類型給前端
      if (sheetName === "申請單") {
        if (headers[j] === "狀態") {
          val = translateStatusToEn(val);
        } else if (headers[j] === "異動類型") {
          val = translateTypeToEn(val);
        }
      }
      // 空堂事件：班級清單／ID 等強制字串；去掉強制文字用的前導 '
      if (sheetName === "班級空堂事件") {
        if (headers[j] === "班級清單" || headers[j] === "事件ID" || headers[j] === "事件名稱"
            || headers[j] === "鐘點規則" || headers[j] === "可進互代" || headers[j] === "啟用"
            || headers[j] === "備註" || headers[j] === "學期代號") {
          if (val !== "" && val !== null && val !== undefined) {
            val = String(val);
            if (headers[j] === "班級清單") {
              val = val.replace(/^'+/, "");
              // 數字 0 整欄無效
              if (val === "0" || /^0+$/.test(val)) val = "";
            }
          }
        }
      }
      
      obj[headers[j]] = val;
      if (val !== "" && val !== null && val !== undefined) {
        hasValue = true;
      }
    }
    if (hasValue) data.push(obj);
  }
  return data;
}

// 欄位別名讀取
function pickFieldValue_(obj, headerName) {
  const fieldAliases = {
    "授課科目": ["任課科目"],
    "任課科目": ["授課科目"],
    "原授課教師Email": ["原任課教師Email"],
    "原任課教師Email": ["原授課教師Email"]
  };
  if (obj[headerName] !== undefined && obj[headerName] !== null && obj[headerName] !== "") {
    return obj[headerName];
  }
  const alts = fieldAliases[headerName] || [];
  for (var i = 0; i < alts.length; i++) {
    if (obj[alts[i]] !== undefined && obj[alts[i]] !== null && obj[alts[i]] !== "") {
      return obj[alts[i]];
    }
  }
  if (obj[headerName] !== undefined && obj[headerName] !== null) return obj[headerName];
  return "";
}

function translateCellForSheet_(sheetName, headerName, val) {
  if (sheetName === "申請單") {
    if (headerName === "狀態") return translateStatusToZh(val);
    if (headerName === "異動類型") return translateTypeToZh(val);
  }
  return val;
}

function buildRowArray_(sheetName, headers, obj) {
  return headers.map(function (h) {
    return translateCellForSheet_(sheetName, h, pickFieldValue_(obj, h));
  });
}

// 批次儲存/更新（增量：只更新變更列或 append，避免整表 clearContents）
function saveRows(sheetName, rowsToSave, keyName) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headers = getHeadersForSheet(sheetName);
  if (!headers || headers.length === 0) return;

  // 確保有表頭
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
  }

  const keyCol = headers.indexOf(keyName) + 1;
  if (keyCol < 1) {
    // 找不到 key 欄時退回安全全量寫入
    return saveRowsFullRewrite_(sheetName, rowsToSave, keyName);
  }

  // 注意：getRange(row, column, numRows, numColumns) 第三／四參數是「列數／欄數」，不是結束列！
  const lastRow = sheet.getLastRow();
  const keyToRow = {};
  if (lastRow >= 2) {
    const numDataRows = lastRow - 1;
    const keyVals = sheet.getRange(2, keyCol, numDataRows, 1).getValues();
    for (var r = 0; r < keyVals.length; r++) {
      var k = keyVals[r][0];
      if (k !== "" && k !== null && k !== undefined) {
        keyToRow[String(k)] = r + 2; // 1-based sheet row
      }
    }
  }

  // 讀取既有資料以便 merge（避免更新時清空未傳欄位）
  const existingData = getTableData(sheetName);
  const existingMap = {};
  existingData.forEach(function (row) {
    if (row[keyName] !== undefined && row[keyName] !== null && row[keyName] !== "") {
      existingMap[String(row[keyName])] = row;
    }
  });

  const toAppend = [];
  // 更新列先收集，再依 row 排序後連續區段一次 setValues（少 API 往返）
  const toUpdate = []; // { rowNum, arr }
  rowsToSave.forEach(function (row) {
    if (sheetName === "申請單") {
      if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
      // 每次寫入刷新更新時間（增量 softRefresh 水位線）
      row["更新時間"] = toLocalTimeStr(new Date());
    }
    const key = String(row[keyName]);
    const merged = Object.assign({}, existingMap[key] || {}, row);
    const arr = buildRowArray_(sheetName, headers, merged);
    if (keyToRow[key]) {
      toUpdate.push({ rowNum: keyToRow[key], arr: arr });
      existingMap[key] = merged;
    } else {
      toAppend.push(arr);
      existingMap[key] = merged;
    }
  });

  if (toUpdate.length) {
    toUpdate.sort(function (a, b) { return a.rowNum - b.rowNum; });
    var uStart = 0;
    while (uStart < toUpdate.length) {
      var uEnd = uStart;
      while (uEnd + 1 < toUpdate.length
          && toUpdate[uEnd + 1].rowNum === toUpdate[uEnd].rowNum + 1) {
        uEnd++;
      }
      var block = [];
      for (var ui = uStart; ui <= uEnd; ui++) block.push(toUpdate[ui].arr);
      sheet.getRange(toUpdate[uStart].rowNum, 1, block.length, headers.length).setValues(block);
      uStart = uEnd + 1;
    }
  }

  if (toAppend.length > 0) {
    const start = sheet.getLastRow() + 1;
    // 新增多列：numRows = toAppend.length
    sheet.getRange(start, 1, toAppend.length, headers.length).setValues(toAppend);
  }
}

// 全量覆寫後備（僅在 key 欄異常時使用）
function saveRowsFullRewrite_(sheetName, rowsToSave, keyName) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const data = getTableData(sheetName);
  const headers = getHeadersForSheet(sheetName);
  const dataMap = {};
  data.forEach(function (row) { dataMap[row[keyName]] = row; });
  rowsToSave.forEach(function (row) {
    if (sheetName === "申請單") {
      if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
      row["更新時間"] = toLocalTimeStr(new Date());
    }
    dataMap[row[keyName]] = Object.assign({}, dataMap[row[keyName]] || {}, row);
  });
  const values = [headers];
  Object.values(dataMap).forEach(function (obj) {
    values.push(buildRowArray_(sheetName, headers, obj));
  });
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
}

// 刪除特定行（增量：只刪對應列，由下往上刪避免位移）
function deleteRows(sheetName, keyName, keyValue) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headers = getHeadersForSheet(sheetName);
  const keyCol = headers.indexOf(keyName) + 1;
  if (keyCol < 1) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  // getRange(row, column, numRows, numColumns)
  const keyVals = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  const target = String(keyValue);
  // 由下往上刪
  for (var i = keyVals.length - 1; i >= 0; i--) {
    if (String(keyVals[i][0]) === target) {
      sheet.deleteRow(i + 2);
    }
  }
}

// ----------------- 快取分片機制 (CacheService Chunking) -----------------
function putCacheChunked(key, value, expirationSeconds) {
  const cache = CacheService.getScriptCache();
  const chunkSize = 90 * 1024; // 90KB limit
  if (value.length <= chunkSize) {
    cache.put(key, value, expirationSeconds);
    cache.put(key + "_chunks", "1", expirationSeconds);
  } else {
    const numChunks = Math.ceil(value.length / chunkSize);
    cache.put(key + "_chunks", numChunks.toString(), expirationSeconds);
    for (let i = 0; i < numChunks; i++) {
      const chunk = value.substring(i * chunkSize, (i + 1) * chunkSize);
      cache.put(key + "_part_" + i, chunk, expirationSeconds);
    }
  }
}

function getCacheChunked(key) {
  const cache = CacheService.getScriptCache();
  const chunksVal = cache.get(key + "_chunks");
  if (!chunksVal) return null;
  const numChunks = parseInt(chunksVal);
  if (numChunks === 1) {
    return cache.get(key);
  }
  let fullValue = "";
  for (let i = 0; i < numChunks; i++) {
    const chunk = cache.get(key + "_part_" + i);
    if (!chunk) return null; // 快取已過期或不完整
    fullValue += chunk;
  }
  return fullValue;
}

function removeCacheChunked(key) {
  const cache = CacheService.getScriptCache();
  const chunksVal = cache.get(key + "_chunks");
  if (!chunksVal) return;
  const numChunks = parseInt(chunksVal);
  cache.remove(key + "_chunks");
  if (numChunks === 1) {
    cache.remove(key);
  } else {
    for (let i = 0; i < numChunks; i++) {
      cache.remove(key + "_part_" + i);
    }
  }
}

/** 清除公開班級課表快取（核准／寫入後立即失效） */
function clearPublicClassCache_(semesterId) {
  try {
    var cache = CacheService.getScriptCache();
    var sid = String(semesterId || "");
    // 記錄過的班級 key 清單
    var listKey = "jcjh_pub_keys_" + sid;
    var raw = cache.get(listKey);
    if (raw) {
      try {
        var keys = JSON.parse(raw);
        if (keys && keys.length) {
          keys.forEach(function (k) { removeCacheChunked(k); });
        }
      } catch (e) {}
      cache.remove(listKey);
    }
    // 相容：清無班級名的總 key
    removeCacheChunked("jcjh_pub_" + sid + "_");
  } catch (e) {}
}

function rememberPublicCacheKey_(semesterId, className, cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var listKey = "jcjh_pub_keys_" + String(semesterId || "");
    var keys = [];
    var raw = cache.get(listKey);
    if (raw) {
      try { keys = JSON.parse(raw) || []; } catch (e) { keys = []; }
    }
    if (keys.indexOf(cacheKey) === -1) keys.push(cacheKey);
    // 最多記 80 個班，避免超限
    if (keys.length > 80) keys = keys.slice(-80);
    cache.put(listKey, JSON.stringify(keys), 3600);
  } catch (e) {}
}

/** 只清申請／組裝 payload（簽核、送單用；課表層保留） */
function invalidateRequestCaches_(semesterId) {
  var sid = String(semesterId || "");
  try {
    [7, 14, 21, 30, 60, 90, 120].forEach(function (d) {
      removeCacheChunked("jcjh_data_" + sid + "_admin_w" + d);
      removeCacheChunked("jcjh_data_" + sid + "_teacher_w" + d);
      removeCacheChunked("jcjh_req_" + sid + "_w" + d);
      removeCacheChunked("jcjh_reqonly_" + sid + "_admin_w" + d);
      removeCacheChunked("jcjh_reqonly_" + sid + "_teacher_w" + d);
    });
  } catch (ign) {}
  removeCacheChunked("jcjh_data_" + sid);
  removeCacheChunked("jcjh_data_" + sid + "_admin");
  removeCacheChunked("jcjh_data_" + sid + "_teacher");
  removeCacheChunked("jcjh_req_" + sid + "_all");
  removeCacheChunked("jcjh_pending_" + sid + "_a");
  // 媒合快取：代次戳失效（不逐 key 刪）
  try {
    CacheService.getScriptCache().put("jcjh_match_gen_" + sid, String(Date.now()), 3600);
  } catch (ignM) {}
  // 清本學年可能的月份歷史快取（近 18 個月）
  try {
    var now = new Date();
    for (var mi = 0; mi < 18; mi++) {
      var dt = new Date(now.getFullYear(), now.getMonth() - mi, 1);
      var ym = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
      removeCacheChunked("jcjh_hist_" + sid + "_" + ym + "_a");
    }
  } catch (ignH) {}
  clearPublicClassCache_(sid);
}

/** 課表／教師結構變更 */
function invalidateScheduleCaches_(semesterId) {
  var sid = String(semesterId || "");
  removeCacheChunked("jcjh_sched_" + sid);
  removeCacheChunked("jcjh_teachers_" + sid);
  removeCacheChunked("jcjh_meta_" + sid);
  removeCacheChunked("jcjh_away_" + sid);
  invalidateRequestCaches_(semesterId);
}

/** 寫入後：預設清申請＋公開；大改課表請用 invalidateScheduleCaches_ */
function invalidateSemesterCaches_(semesterId) {
  invalidateRequestCaches_(semesterId);
}

/** 課表列瘦身：去掉學期代號等冗餘欄，縮 JSON 體積（前端 FieldMap 仍相容） */
function slimScheduleRows_(rows) {
  return (rows || []).map(function (s) {
    if (!s) return s;
    // 已瘦過（無學期代號且欄位少）直接回傳
    if (s["學期代號"] === undefined && s["教師Email"] !== undefined && Object.keys(s).length <= 10) {
      return s;
    }
    return {
      "課表ID": s["課表ID"] != null && s["課表ID"] !== "" ? s["課表ID"] : (s.id || ""),
      "教師Email": s["教師Email"] || s.teacherEmail || "",
      "教師姓名": s["教師姓名"] || s.teacherName || "",
      "星期": s["星期"] != null && s["星期"] !== "" ? s["星期"] : s.dayOfWeek,
      "節次": s["節次"] != null && s["節次"] !== "" ? s["節次"] : s.period,
      "班級": s["班級"] != null && s["班級"] !== "" ? s["班級"] : (s.className || ""),
      "科目": s["科目"] || s.subject || "",
      "課堂屬性": s["課堂屬性"] || s.attr || "",
      "調課限制": s["調課限制"] || s.restriction || ""
    };
  });
}

/** 教師列瘦身：只留前端 mapTeacher 需要的欄 */
function slimTeacherRows_(rows) {
  return (rows || []).map(function (t) {
    if (!t) return t;
    if (t["學期代號"] === undefined && t["教師Email"] !== undefined && Object.keys(t).length <= 8) {
      return t;
    }
    return {
      "教師Email": t["教師Email"] || t.email || "",
      "教師姓名": t["教師姓名"] || t.name || "",
      "授課科目": t["授課科目"] || t["任課科目"] || t.subject || "",
      "系統角色": t["系統角色"] || t.role || "teacher",
      "基本鐘點": t["基本鐘點"] != null && t["基本鐘點"] !== "" ? t["基本鐘點"] : (t.baseHours != null ? t.baseHours : 16),
      "互代額度": t["互代額度"] != null && t["互代額度"] !== "" ? t["互代額度"] : (t.mutualQuota != null ? t.mutualQuota : 0)
    };
  });
}

/** 分層讀取：課表（長 TTL）— 快取存瘦身列 */
function getSemesterSchedulesCached_(semesterId) {
  var key = "jcjh_sched_" + String(semesterId || "");
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var cached = JSON.parse(raw);
      if (Array.isArray(cached)) return slimScheduleRows_(cached);
    } catch (e) {}
  }
  var rows = getTableData("教師課表").filter(function (s) { return s["學期代號"] === semesterId; });
  var slim = slimScheduleRows_(rows);
  try { putCacheChunked(key, JSON.stringify(slim), CACHE_TTL_SCHED_); } catch (e2) {}
  return slim;
}

/** 分層讀取：教師（中 TTL）— 快取存瘦身列 */
function getSemesterTeachersCached_(semesterId) {
  var key = "jcjh_teachers_" + String(semesterId || "");
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var cachedT = JSON.parse(raw);
      if (Array.isArray(cachedT)) return slimTeacherRows_(cachedT);
    } catch (e) {}
  }
  var rows = getTableData("教師名單").filter(function (t) { return t["學期代號"] === semesterId; });
  var slim = slimTeacherRows_(rows);
  try { putCacheChunked(key, JSON.stringify(slim), CACHE_TTL_TEACHERS_); } catch (e2) {}
  return slim;
}

/** 分層讀取：申請單列（短 TTL；historyAll 另 key）— 快取一律 { allCount, rows } */
function getSemesterRequestsCached_(semesterId, historyAll, windowDays) {
  var sid = String(semesterId || "");
  var w = historyAll ? "all" : ("w" + (parseInt(windowDays, 10) || 14));
  var key = "jcjh_req_" + sid + "_" + w;
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      // 相容舊快取：純陣列
      if (Array.isArray(parsed)) return { allCount: parsed.length, rows: parsed };
      if (parsed && parsed.rows) return parsed;
    } catch (e) {}
  }
  var allRequests = getTableData("申請單").filter(function (req) { return req["學期代號"] === semesterId; });
  var list = allRequests;
  if (!historyAll) {
    var cutoffYmd = requestWindowCutoffYmd_(windowDays);
    list = allRequests.filter(function (req) { return requestInWindow_(req, cutoffYmd); });
  }
  var pack = { allCount: allRequests.length, rows: list };
  try {
    putCacheChunked(key, JSON.stringify(pack), historyAll ? Math.min(CACHE_TTL_REQ_, 60) : CACHE_TTL_REQ_);
  } catch (e2) {}
  return pack;
}

/** 分層讀取：班級空堂事件（中 TTL） */
function getSemesterClassAwayCached_(semesterId) {
  var key = "jcjh_away_" + String(semesterId || "");
  var raw = getCacheChunked(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  var rows = getTableData("班級空堂事件").filter(function (ev) {
    return String(ev["學期代號"] || "") === String(semesterId || "");
  });
  try { putCacheChunked(key, JSON.stringify(rows), CACHE_TTL_TEACHERS_); } catch (e2) {}
  return rows;
}

/** 經費是否為「扣額度」（含舊資料別名「互代不結」） */
function isQuotaDeductFee_(fee) {
  var f = String(fee || "").trim();
  return f === "扣額度" || f === "互代不結";
}

/** 已作廢狀態：不應再還額度（防重複操作） */
function isTerminalQuotaStatus_(status) {
  var s = String(status || "").toLowerCase().trim();
  return s === "cancelled" || s === "rejected" || s === "admin_rejected" || s === "withdrawn"
    || s === "已取消" || s === "受邀人已拒絕" || s === "行政駁回" || s === "已撤回";
}

/**
 * 申請單作廢（撤銷／撤回／拒絕／駁回）時，若經費為扣額度，代課師互代額度 +1
 * 請傳入「改狀態前」的申請單列；若原狀態已是作廢則略過
 * @param {Object|Object[]} reqs 申請單列（Sheets 中文欄）
 * @returns {number} 成功還原人數（去重後）
 */
function restoreMutualQuotaForRequests_(reqs) {
  var list = Array.isArray(reqs) ? reqs : (reqs ? [reqs] : []);
  if (!list.length) return 0;
  var addMap = {};
  list.forEach(function (r) {
    if (!r) return;
    // 若呼叫端已先改狀態，可帶 _prevStatus 供防重
    var st = r._prevStatus != null ? r._prevStatus : r["狀態"];
    if (isTerminalQuotaStatus_(st)) return;
    if (!isQuotaDeductFee_(r["經費來源"])) return;
    var em = String(r["受邀人Email"] || "").toLowerCase().trim();
    if (!em) return;
    addMap[em] = (addMap[em] || 0) + 1;
  });
  var emails = Object.keys(addMap);
  if (!emails.length) return 0;
  var teachersAll = getTableData("教師名單");
  var tMap = {};
  teachersAll.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (em) tMap[em] = t;
  });
  var toSave = [];
  emails.forEach(function (em) {
    if (!tMap[em]) return;
    var row = Object.assign({}, tMap[em]);
    var prev = parseInt(row["互代額度"], 10);
    if (isNaN(prev) || prev < 0) prev = 0;
    row["互代額度"] = prev + addMap[em];
    toSave.push(row);
  });
  if (!toSave.length) return 0;
  saveRows("教師名單", toSave, "教師Email");
  return toSave.length;
}

// ----------------- Google ID Token 驗證 -----------------
function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    throw new Error("身分認證 Token 缺失！");
  }
  // 正式環境預設關閉；僅當指令碼屬性 ALLOW_MOCK_TOKEN=true 才允許
  if (idToken === "mock-admin-token") {
    if (!ALLOW_MOCK_TOKEN_) {
      throw new Error("已停用模擬登入，請使用 Google 帳號登入！");
    }
    return { email: "admin@school.edu.tw", name: "模擬管理員", hd: "school.edu.tw" };
  }

  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error("Google 登入驗證失敗，請重新登入！");
  }
  const info = JSON.parse(response.getContentText());
  // aud 必須對應本系統 OAuth Client ID
  if (info.aud && EXPECTED_CLIENT_ID_ && String(info.aud) !== String(EXPECTED_CLIENT_ID_)) {
    throw new Error("登入用戶端驗證失敗（aud 不符）！");
  }
  // 網域限制：優先用 hd，否則用 email domain
  var email = String(info.email || "").toLowerCase();
  if (!email) throw new Error("無法取得登入帳號 Email！");
  var hd = String(info.hd || email.split("@")[1] || "").toLowerCase();
  var allowed = getAllowedHdList_();
  // * 或空清單 = 不限制網域（測試用；正式請設校內網域）
  var unrestricted = !allowed.length || allowed.indexOf("*") !== -1;
  if (!unrestricted && allowed.indexOf(hd) === -1) {
    var domain = email.split("@")[1] || "";
    if (allowed.indexOf(domain) === -1) {
      throw new Error("非本校網域帳號，無法登入本系統！");
    }
  }
  return info;
}

// ----------------- 輔助函數：日期時間格式化 -----------------
function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function toLocalTimeStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// ----------------- 主入口：doGet 讀取 -----------------
function buildSettingsMap_() {
  const rawSettings = getTableData("系統設定");
  const settings = {};
  rawSettings.forEach(function (s) {
    var key = s["設定名稱"] !== undefined ? s["設定名稱"] : s["設定鍵"];
    if (key) settings[key] = s["設定值"];
  });
  return settings;
}

/** 申請單時間窗：未結案一律保留；已結案只留近 N 天（異動日或建立時間） */
function requestInWindow_(req, cutoffYmd) {
  var st = String(req["狀態"] || req.status || "").toLowerCase();
  // 進行中：一律帶回（待簽核／待核准）
  if (st === "pending_teacher" || st === "pending_admin") return true;
  // historyAll：呼叫端可跳過此函式
  var dateStr = String(req["異動日期"] || req.requestDate || "").slice(0, 10);
  if (!dateStr) dateStr = String(req["建立時間"] || req.createdAt || "").slice(0, 10);
  if (!dateStr) return true; // 缺日期時保守保留
  return dateStr >= cutoffYmd;
}

function requestWindowCutoffYmd_(days) {
  var n = parseInt(days, 10);
  if (isNaN(n) || n < 7) n = 14;
  if (n > 120) n = 120;
  var d = new Date();
  d.setDate(d.getDate() - n);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/** 申請列時間字串（更新時間優先，其次建立時間）→ 可比較的毫秒；缺則 0 */
function requestRowTimeMs_(req) {
  if (!req) return 0;
  var raw = String(req["更新時間"] || req.updatedAt || req["建立時間"] || req.createdAt || "").trim();
  if (!raw) return 0;
  // 支援 "YYYY-MM-DD HH:mm:ss" / ISO / 僅日期
  var t = raw.replace("T", " ");
  var norm = t.indexOf("/") >= 0 ? t : t.replace(/-/g, "/");
  var ms = Date.parse(norm);
  return isFinite(ms) ? ms : 0;
}

/** 水位線字串 → 毫秒（前端 updatedSince） */
function parseUpdatedSinceMs_(raw) {
  var s = String(raw || "").trim();
  if (!s) return 0;
  var t = s.replace("T", " ");
  var norm = t.indexOf("/") >= 0 ? t : t.replace(/-/g, "/");
  var ms = Date.parse(norm);
  return isFinite(ms) ? ms : 0;
}

/**
 * 教師端課表瘦身：只留「自己」＋「自己有上的班級」之全校該班列。
 * （調課同班候選仍可用；代課空堂名單改走 getMatchCandidates）
 * 不寫回共用快取。
 */
function slimSchedulesForTeacher_(schedules, teacherEmail) {
  var em = String(teacherEmail || "").toLowerCase().trim();
  if (!em) return schedules || [];
  var rows = schedules || [];
  var selfClasses = {};
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    if (!s) continue;
    var te = String(s["教師Email"] || s.teacherEmail || "").toLowerCase().trim();
    if (te !== em) continue;
    var cn = String(s["班級"] || s.className || "").trim();
    if (cn) selfClasses[cn] = true;
  }
  var out = [];
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    if (!r) continue;
    var te2 = String(r["教師Email"] || r.teacherEmail || "").toLowerCase().trim();
    if (te2 === em) {
      out.push(r);
      continue;
    }
    var cn2 = String(r["班級"] || r.className || "").trim();
    if (cn2 && selfClasses[cn2]) out.push(r);
  }
  return out;
}

/**
 * 個人化 payload：淺拷貝外層 + filter requests；教師另瘦 schedules。
 * 共用底包物件（admin 課表等）直接引用，避免 deep clone。
 */
function personalizeSharedPayload_(shared, readerEmail, readerIsAdmin) {
  if (!shared) return shared;
  var out = {};
  for (var k in shared) {
    if (Object.prototype.hasOwnProperty.call(shared, k)) out[k] = shared[k];
  }
  var rows = shared.requests || [];
  if (!readerIsAdmin) {
    var em = String(readerEmail || "").toLowerCase();
    rows = rows.filter(function (req) {
      var a = String(req["申請人Email"] || "").toLowerCase();
      var b = String(req["受邀人Email"] || "").toLowerCase();
      return a === em || b === em;
    });
    out.scope = "teacher";
    // 課表瘦身：不修改 shared.schedules 原陣列
    if (out.schedules) {
      out.schedules = slimSchedulesForTeacher_(out.schedules, em);
      out.scheduleScope = "teacher_self_and_class";
    }
  } else {
    out.scope = shared.scope || "admin";
    out.scheduleScope = "full";
  }
  out.requests = rows;
  if (out.requestWindow) {
    // requestWindow 淺拷貝後改 returned，避免寫回共用快取物件
    out.requestWindow = {
      historyAll: !!out.requestWindow.historyAll,
      windowDays: out.requestWindow.windowDays,
      cutoffDate: out.requestWindow.cutoffDate || "",
      totalMatched: out.requestWindow.totalMatched,
      returned: rows.length
    };
  }
  return out;
}

/** 解析多科字串（後端媒合用，與 domain-match 對齊） */
function parseSubjectsServer_(raw) {
  return String(raw || "")
    .split(/[、,，/／|｜\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function extractGradeServer_(className) {
  var s = String(className || "");
  var m = s.match(/[789]/);
  if (m) return m[0];
  if (/七/.test(s)) return "7";
  if (/八/.test(s)) return "8";
  if (/九/.test(s)) return "9";
  return "";
}

/**
 * 代課媒合：該節空堂教師排序（輕量，不依賴前端全校課表）。
 * opts: leaveEmail, dayOfWeek, period, dateStr, myCourse, myDomain, myClass, awayClasses[], limit
 */
function buildMatchCandidates_(semesterId, opts) {
  opts = opts || {};
  var leaveEmail = String(opts.leaveEmail || "").toLowerCase().trim();
  var day = parseInt(opts.dayOfWeek != null ? opts.dayOfWeek : opts.targetDay, 10);
  var period = parseInt(opts.period != null ? opts.period : opts.targetPeriod, 10);
  var dateStr = String(opts.dateStr || opts.requestDate || "").slice(0, 10);
  var myCourse = String(opts.myCourse != null ? opts.myCourse : (opts.subject || "")).trim();
  var myDomainRaw = String(opts.myDomain || "").trim();
  var myClass = String(opts.myClass != null ? opts.myClass : (opts.className || "")).trim();
  var myGrade = extractGradeServer_(myClass);
  var limit = parseInt(opts.limit, 10) || 40;
  if (isNaN(limit) || limit < 5) limit = 40;
  if (limit > 80) limit = 80;
  var activityMode = opts.activityMode === true || opts.activityMode === "true";

  var awaySet = {};
  (opts.awayClasses || []).forEach(function (c) {
    var k = String(c || "").trim();
    if (k) awaySet[k] = true;
  });

  var teachers = getSemesterTeachersCached_(semesterId) || [];
  var schedules = getSemesterSchedulesCached_(semesterId) || [];
  var reqPack = getSemesterRequestsCached_(semesterId, false, 14);
  var allReqRows = reqPack.rows || [];
  var approved = allReqRows.filter(function (r) {
    return String(r["狀態"] || "").toLowerCase() === "approved";
  });
  var pendingRows = allReqRows.filter(function (r) {
    var st = String(r["狀態"] || "").toLowerCase();
    return st === "pending_teacher" || st === "pending_admin";
  });

  // 基礎課：email|day|period → { className, subject, attr }
  var baseMap = {};
  schedules.forEach(function (s) {
    if (!s) return;
    var em = String(s["教師Email"] || s.teacherEmail || "").toLowerCase().trim();
    var d = parseInt(s["星期"] != null ? s["星期"] : s.dayOfWeek, 10);
    var p = parseInt(s["節次"] != null ? s["節次"] : s.period, 10);
    if (!em || isNaN(d) || isNaN(p)) return;
    var key = em + "|" + d + "|" + p;
    // 多屬性格：保留第一筆一般／巡堂
    if (!baseMap[key]) {
      baseMap[key] = {
        className: String(s["班級"] || s.className || "").trim(),
        subject: String(s["科目"] || s.subject || "").trim(),
        attr: String(s["課堂屬性"] || s.attr || "").trim()
      };
    }
  });

  // 核准異動：date|period 上 original 調出、actual 調入
  var outOnDate = {}; // email|date|period → true
  var inOnDate = {};  // email|date|period → { className, subject }
  // 進行中申請佔位：該師該節不可再推為空堂（受邀／申請人皆佔）
  var pendingBusy = {}; // email|date|period → true
  function markEdge(date, per, orig, act, cls, subj) {
    var d0 = String(date || "").slice(0, 10);
    var p0 = parseInt(per, 10);
    var o = String(orig || "").toLowerCase().trim();
    var a = String(act || "").toLowerCase().trim();
    if (!d0 || isNaN(p0)) return;
    if (o) outOnDate[o + "|" + d0 + "|" + p0] = true;
    if (a) {
      inOnDate[a + "|" + d0 + "|" + p0] = {
        className: String(cls || "").trim(),
        subject: String(subj || "").trim()
      };
    }
  }
  function markPendingBusy(date, per, em) {
    var d0 = String(date || "").slice(0, 10);
    var p0 = parseInt(per, 10);
    var e = String(em || "").toLowerCase().trim();
    if (!d0 || isNaN(p0) || !e) return;
    pendingBusy[e + "|" + d0 + "|" + p0] = true;
  }
  approved.forEach(function (r) {
    if (!r) return;
    var type = String(r["異動類型"] || r.type || "");
    var reqDate = r["異動日期"] || r.requestDate;
    var reqPer = r["異動節次"] || r.requestPeriod;
    var reqEm = r["申請人Email"] || r.requesterEmail;
    var tgtEm = r["受邀人Email"] || r.targetTeacherEmail;
    var cls = r["班級"] || r.className;
    var subj = r["科目"] || r.subject;
    if (type === "exchange" || type === "對調") {
      markEdge(reqDate, reqPer, reqEm, tgtEm, cls, subj);
      markEdge(r["對調目標日期"] || r.targetDate, r["對調目標節次"] || r.targetPeriod,
        tgtEm, reqEm, cls, subj);
    } else {
      markEdge(reqDate, reqPer, reqEm, tgtEm, cls, subj);
    }
  });
  pendingRows.forEach(function (r) {
    if (!r) return;
    var type = String(r["異動類型"] || r.type || "");
    var reqDate = r["異動日期"] || r.requestDate;
    var reqPer = r["異動節次"] || r.requestPeriod;
    var reqEm = r["申請人Email"] || r.requesterEmail;
    var tgtEm = r["受邀人Email"] || r.targetTeacherEmail;
    // 請假節：申請人調出、受邀人佔入
    markPendingBusy(reqDate, reqPer, reqEm);
    markPendingBusy(reqDate, reqPer, tgtEm);
    if (type === "exchange" || type === "對調") {
      var tDate = r["對調目標日期"] || r.targetDate;
      var tPer = r["對調目標節次"] || r.targetPeriod;
      markPendingBusy(tDate, tPer, reqEm);
      markPendingBusy(tDate, tPer, tgtEm);
    }
  });

  function cellAt(email, d, p) {
    var em = String(email || "").toLowerCase().trim();
    var key = em + "|" + d + "|" + p;
    var base = baseMap[key] || null;
    var dateKey = em + "|" + dateStr + "|" + p;
    if (pendingBusy[dateKey]) {
      // 進行中佔位：視同有課（不可再媒合）
      return { className: "(pending)", subject: "", attr: "", isPending: true };
    }
    if (outOnDate[dateKey]) {
      // 調出：視同空
      return null;
    }
    if (inOnDate[dateKey]) {
      return {
        className: inOnDate[dateKey].className || (base && base.className) || "",
        subject: inOnDate[dateKey].subject || (base && base.subject) || "",
        attr: (base && base.attr) || "",
        isDuty: true
      };
    }
    return base;
  }

  function isPatrol(cell) {
    return !!(cell && (cell.attr === "巡堂" || cell.subject === "巡堂"));
  }

  function isAwayReleased(cell) {
    if (!cell) return false;
    if (cell.isPending) return false;
    var cn = String(cell.className || "").trim();
    return !!(cn && awaySet[cn]);
  }

  function isFreeAt(email, p) {
    var cell = cellAt(email, day, p);
    if (!cell) return { free: true, released: false };
    if (cell.isPending) return { free: false, released: false, isPending: true };
    if (isPatrol(cell)) return { free: true, released: false, isPatrol: true };
    if (isAwayReleased(cell)) return { free: true, released: true };
    return { free: false, released: false };
  }

  // 同班／同課掃表
  var sameClassTeachers = {};
  var sameCourseTeachers = {};
  schedules.forEach(function (s) {
    if (!s) return;
    var te = String(s["教師Email"] || s.teacherEmail || "").toLowerCase().trim();
    if (!te) return;
    var cn = String(s["班級"] || s.className || "").trim();
    var subj = String(s["科目"] || s.subject || "").trim();
    if (myClass && cn === myClass) sameClassTeachers[te] = true;
    if (myCourse && subj === myCourse) {
      if (myGrade) {
        if (extractGradeServer_(cn) === myGrade) sameCourseTeachers[te] = true;
      } else if (cn === myClass) {
        sameCourseTeachers[te] = true;
      }
    }
  });

  var knownDomains = {};
  teachers.forEach(function (t) {
    parseSubjectsServer_(t["授課科目"] || t.subject).forEach(function (s) {
      knownDomains[s] = true;
    });
  });
  var leaveDomains = parseSubjectsServer_(myDomainRaw);
  leaveDomains.forEach(function (s) { knownDomains[s] = true; });
  var demandDomain = "";
  if (myCourse && knownDomains[myCourse]) demandDomain = myCourse;
  else if (leaveDomains.length) demandDomain = leaveDomains[0];

  var freeList = [];
  teachers.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (!em || em === leaveEmail) return;
    var fi = isFreeAt(em, period);
    if (!fi.free) return;
    var candDomains = parseSubjectsServer_(t["授課科目"] || t.subject);
    var isSameCourse = !!sameCourseTeachers[em];
    var isSameSubject = !!(demandDomain && candDomains.indexOf(demandDomain) >= 0);
    var isSameClass = !!sameClassTeachers[em];
    var isReleasedByAway = !!fi.released;
    var score = (activityMode && isReleasedByAway ? 100 : 0)
      + (isSameCourse ? 4 : 0) + (isSameSubject ? 2 : 0) + (isSameClass ? 1 : 0);
    // 當日負荷 1～8
    var busy = 0;
    for (var p = 1; p <= 8; p++) {
      var c = cellAt(em, day, p);
      if (c && !isPatrol(c) && !isAwayReleased(c)) busy++;
    }
    freeList.push({
      email: em,
      name: String(t["教師姓名"] || t.name || "").trim(),
      subject: String(t["授課科目"] || t.subject || "").trim(),
      role: String(t["系統角色"] || t.role || "teacher"),
      baseHours: t["基本鐘點"] != null ? t["基本鐘點"] : (t.baseHours != null ? t.baseHours : 16),
      mutualQuota: t["互代額度"] != null ? t["互代額度"] : (t.mutualQuota != null ? t.mutualQuota : 0),
      todayPeriodCount: busy,
      isSameCourse: isSameCourse,
      isSameSubject: isSameSubject,
      isSameClass: isSameClass,
      isReleasedByAway: isReleasedByAway,
      suggestedFee: activityMode ? (isReleasedByAway ? "扣額度" : "活動公費") : "",
      demandDomain: demandDomain,
      score: score
    });
  });

  freeList.sort(function (a, b) {
    if (activityMode) {
      var ra = a.isReleasedByAway ? 1 : 0;
      var rb = b.isReleasedByAway ? 1 : 0;
      if (rb !== ra) return rb - ra;
    }
    return b.score - a.score || a.todayPeriodCount - b.todayPeriodCount;
  });

  var sliced = freeList.slice(0, limit);
  return {
    success: true,
    kind: "matchCandidates",
    candidates: sliced,
    count: sliced.length,
    totalFree: freeList.length,
    demandDomain: demandDomain,
    dateStr: dateStr,
    dayOfWeek: day,
    period: period
  };
}

/**
 * 申請增量：updatedSince 之後有變的列（更新時間／建立時間）。
 * 舊列無「更新時間」時以建立時間近似；水位線過舊（>2 天）由前端改走全窗。
 */
function buildRequestsDelta_(semesterId, readerEmail, readerIsAdmin, updatedSinceRaw) {
  var sinceMs = parseUpdatedSinceMs_(updatedSinceRaw);
  var pack = getSemesterRequestsCached_(semesterId, false, 14);
  var all = pack.rows || [];
  var changed = all.filter(function (req) {
    var ms = requestRowTimeMs_(req);
    // 無時間戳：保守帶出（極少數舊列）
    if (!ms) return true;
    return ms > sinceMs;
  });
  if (!readerIsAdmin) {
    var em = String(readerEmail || "").toLowerCase();
    changed = changed.filter(function (req) {
      var a = String(req["申請人Email"] || "").toLowerCase();
      var b = String(req["受邀人Email"] || "").toLowerCase();
      return a === em || b === em;
    });
  }
  var maxMs = sinceMs;
  for (var i = 0; i < changed.length; i++) {
    var m = requestRowTimeMs_(changed[i]);
    if (m > maxMs) maxMs = m;
  }
  // 水位線回傳字串：優先用列上原文；無則用 now
  var serverTime = toLocalTimeStr(new Date());
  if (maxMs > sinceMs) {
    try {
      serverTime = toLocalTimeStr(new Date(maxMs));
    } catch (eT) {}
  }
  return {
    success: true,
    kind: "requestsDelta",
    requests: changed,
    count: changed.length,
    updatedSince: String(updatedSinceRaw || ""),
    serverTime: serverTime,
    scope: readerIsAdmin ? "admin" : "teacher"
  };
}

/**
 * 組裝全量 payload。
 * opts.requestsOnly=true：只回申請窗＋空堂事件（不含課表／教師／學期），供 soft 對齊。
 * 教師端：申請再 filter 自己；課表仍全校（點格媒合需要）。
 */
function buildFullSemesterPayload_(semesterId, opts) {
  opts = opts || {};
  const userEmail = String(opts.userEmail || "").toLowerCase();
  const isAdmin = !!opts.isAdmin;
  // historyAll=true：不裁時間窗（歷史頁「載入完整學期」）
  const historyAll = opts.historyAll === true || opts.historyAll === "true" || opts.historyAll === 1;
  // 預設近 14 天已結案；未結案不受限
  const windowDays = opts.windowDays != null ? opts.windowDays : 14;
  const requestsOnly = opts.requestsOnly === true || opts.requestsOnly === "true" || opts.requestsOnly === 1;
  const cutoffYmd = historyAll ? "" : requestWindowCutoffYmd_(windowDays);

  var reqPack = getSemesterRequestsCached_(semesterId, historyAll, windowDays);
  var requests = reqPack.rows || [];
  var sheetTotal = reqPack.allCount != null ? reqPack.allCount : requests.length;

  // 角色分流：一般教師只拿與自己相關的申請（申請人／受邀人）
  // 注意：快取存的是「時間窗後」全校列；教師再 filter 不寫回快取
  if (userEmail && !isAdmin) {
    requests = requests.filter(function (req) {
      var a = String(req["申請人Email"] || "").toLowerCase();
      var b = String(req["受邀人Email"] || "").toLowerCase();
      return a === userEmail || b === userEmail;
    });
  }

  var classAwayEvents = getSemesterClassAwayCached_(semesterId);

  if (requestsOnly) {
    return {
      success: true,
      kind: "requestsOnly",
      requests: requests,
      classAwayEvents: classAwayEvents,
      scope: isAdmin ? "admin" : "teacher",
      serverTime: toLocalTimeStr(new Date()),
      requestWindow: {
        historyAll: !!historyAll,
        windowDays: historyAll ? 0 : (parseInt(windowDays, 10) || 14),
        cutoffDate: cutoffYmd || "",
        totalMatched: sheetTotal,
        returned: requests.length
      }
    };
  }

  // 學期設定筆數少，每次讀表即可；課表／教師走分層快取（已瘦身）
  const semesters = getTableData("學期設定");
  const allTeachers = getSemesterTeachersCached_(semesterId);
  const allSchedules = getSemesterSchedulesCached_(semesterId);

  return {
    success: true,
    semesters: semesters,
    teachers: allTeachers,
    schedules: allSchedules,
    substitutions: [],
    requests: requests,
    classAwayEvents: classAwayEvents,
    scope: isAdmin ? "admin" : "teacher",
    serverTime: toLocalTimeStr(new Date()),
    requestWindow: {
      historyAll: !!historyAll,
      windowDays: historyAll ? 0 : (parseInt(windowDays, 10) || 14),
      cutoffDate: cutoffYmd || "",
      totalMatched: sheetTotal,
      returned: requests.length
    },
    settings: buildSettingsMap_()
  };
}

/** 教師共用底包：全校課表／教師／時間窗申請，個人 filter 在 getInitialData 做 */
function buildTeacherSharedPayload_(semesterId, windowDays) {
  return buildFullSemesterPayload_(semesterId, {
    userEmail: "",
    isAdmin: true,
    historyAll: false,
    windowDays: windowDays
  });
}

// 公開班級課表（免登入）：最小化欄位，禁止全校名單／全表 fallback
function buildPublicClassPayload_(semesterId, className) {
  var sid = semesterId;
  var allSems = getTableData("學期設定");
  if (!sid) {
    var def = allSems.find(function (s) { return String(s["是否預設"] || s["預設"] || "") === "是" || s["isDefault"]; });
    sid = def ? (def["學期代號"] || def.id) : (allSems[0] && (allSems[0]["學期代號"] || allSems[0].id)) || "";
  }
  var cls = String(className || "").trim();
  var semesterSchedules = getTableData("教師課表").filter(function (s) { return s["學期代號"] === sid; });
  // 班級名清單（僅名稱，供拼錯提示；不附 Email）
  var classNames = [];
  var seenCls = {};
  semesterSchedules.forEach(function (s) {
    var c = String(s["班級"] || s["className"] || "").trim();
    if (c && !seenCls[c]) { seenCls[c] = 1; classNames.push(c); }
  });
  classNames.sort();

  var schedules = cls
    ? semesterSchedules.filter(function (s) { return String(s["班級"] || s["className"] || "") === cls; })
    : [];

  // 僅該班相關教師（姓名顯示用），不回全校
  var emailNeed = {};
  schedules.forEach(function (s) {
    var em = String(s["教師Email"] || s.teacherEmail || "").toLowerCase();
    if (em) emailNeed[em] = 1;
  });

  var approved = getTableData("申請單").filter(function (req) {
    if (req["學期代號"] !== sid) return false;
    if (String(req["狀態"] || req.status || "") !== "approved") return false;
    if (cls && String(req["班級"] || req.className || "") !== cls) return false;
    return true;
  }).map(function (req) {
    // 公開：保留顯示用姓名與課堂欄，不附備註全文
    var em1 = String(req["申請人Email"] || "").toLowerCase();
    var em2 = String(req["受邀人Email"] || "").toLowerCase();
    if (em1) emailNeed[em1] = 1;
    if (em2) emailNeed[em2] = 1;
    return {
      "學期代號": req["學期代號"],
      "申請單ID": req["申請單ID"],
      "單號": req["單號"],
      "狀態": req["狀態"],
      "申請人Email": req["申請人Email"],
      "申請人姓名": req["申請人姓名"],
      "受邀人Email": req["受邀人Email"],
      "受邀人姓名": req["受邀人姓名"],
      "班級": req["班級"],
      "科目": req["科目"],
      "異動日期": req["異動日期"],
      "異動星期": req["異動星期"],
      "異動節次": req["異動節次"],
      "異動類型": req["異動類型"],
      "對調目標日期": req["對調目標日期"],
      "對調目標星期": req["對調目標星期"],
      "對調目標節次": req["對調目標節次"],
      "經費來源": req["經費來源"] || "",
      "請假事由": "",
      "備註": "",
      "是否已印": req["是否已印"]
    };
  });

  var teachers = getTableData("教師名單").filter(function (t) {
    return t["學期代號"] === sid && emailNeed[String(t["教師Email"] || "").toLowerCase()];
  }).map(function (t) {
    return {
      "學期代號": t["學期代號"],
      "教師姓名": t["教師姓名"],
      "教師Email": t["教師Email"],
      "授課科目": t["授課科目"] || t["任課科目"] || t["科目"] || "",
      "系統角色": "teacher"
    };
  });

  var semRow = allSems.filter(function (s) {
    return String(s["學期代號"] || s.id || "") === String(sid);
  });

  var classAwayEvents = getSemesterClassAwayCached_(sid);

  return {
    success: true,
    public: true,
    semesterId: sid,
    className: cls,
    classNames: classNames,
    semesters: semRow.length ? semRow : allSems.slice(0, 1),
    teachers: teachers,
    schedules: schedules,
    substitutions: [],
    requests: approved,
    classAwayEvents: classAwayEvents,
    settings: { public: true }
  };
}

function assertPublicClassRateLimit_() {
  try {
    var cache = CacheService.getScriptCache();
    var key = "rl_public_class_global";
    var n = parseInt(cache.get(key) || "0", 10) || 0;
    if (n > 60) throw new Error("公開課表請求過於頻繁，請稍後再試");
    cache.put(key, String(n + 1), 60);
  } catch (e) {
    if (String(e.message || e).indexOf("過於頻繁") !== -1) throw e;
  }
}

// 讀取 API（僅經 doPost 呼叫；公開 action 免 Token）
function handleReadAction_(postData) {
  const action = postData.action;
  const semesterId = postData.semesterId;
  const idToken = postData.idToken;
  const reqData = postData.data || {};
  const scope = String(reqData.scope || postData.scope || "full").toLowerCase();

  // 公開班級課表：免登入（節流 + 短快取）
  if (action === "getPublicClassData") {
    assertPublicClassRateLimit_();
    var pubCls = reqData.className || reqData.class || postData.className || "";
    var pubSid = semesterId || reqData.semesterId || "";
    var pubCacheKey = "jcjh_pub_" + pubSid + "_" + String(pubCls).trim();
    var pubCached = getCacheChunked(pubCacheKey);
    if (pubCached) {
      return ContentService.createTextOutput(pubCached).setMimeType(ContentService.MimeType.JSON);
    }
    const payload = buildPublicClassPayload_(pubSid, pubCls);
    var pubJson = JSON.stringify(payload);
    putCacheChunked(pubCacheKey, pubJson, 60);
    rememberPublicCacheKey_(pubSid, pubCls, pubCacheKey);
    return ContentService.createTextOutput(pubJson)
      .setMimeType(ContentService.MimeType.JSON);
  }

  var tokenInfo = verifyGoogleIdToken(idToken);
  var readerEmail = String((tokenInfo && tokenInfo.email) || "").toLowerCase();

  // 代課媒合候選（讀取、不佔寫鎖；短快取 45s，申請寫入時代次戳失效）
  if (action === "getMatchCandidates") {
    var mLeave = String(reqData.leaveEmail || "").toLowerCase().trim();
    var mDate = String(reqData.dateStr || reqData.requestDate || "").slice(0, 10);
    var mDay = parseInt(reqData.dayOfWeek != null ? reqData.dayOfWeek : reqData.targetDay, 10);
    var mPer = parseInt(reqData.period != null ? reqData.period : reqData.targetPeriod, 10);
    var mAct = (reqData.activityMode === true || reqData.activityMode === "true") ? "1" : "0";
    var mCls = String(reqData.myClass || reqData.className || "").trim();
    var mCourse = String(reqData.myCourse != null ? reqData.myCourse : (reqData.subject || "")).trim();
    var mAway = "";
    try {
      var aw = reqData.awayClasses || [];
      mAway = (aw || []).map(function (c) { return String(c || "").trim(); }).filter(Boolean).sort().join(",");
    } catch (eAw) { mAway = ""; }
    var mGen = "0";
    try {
      mGen = CacheService.getScriptCache().get("jcjh_match_gen_" + String(semesterId || "")) || "0";
    } catch (eGen) {}
    // key 控長：away 取前 80 字
    if (mAway.length > 80) mAway = mAway.slice(0, 80);
    var matchCacheKey = "jcjh_match_" + String(semesterId || "") + "_" + mGen + "_"
      + mDate + "_" + mDay + "_" + mPer + "_" + mLeave + "_" + mAct + "_"
      + mCls + "_" + mCourse + "_" + mAway;
    if (scope !== "fresh") {
      try {
        var mCached = getCacheChunked(matchCacheKey);
        if (mCached) {
          return ContentService.createTextOutput(mCached).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (eMc) {}
    }
    var matchOut = buildMatchCandidates_(semesterId, reqData);
    try {
      putCacheChunked(matchCacheKey, JSON.stringify(matchOut), CACHE_TTL_MATCH_);
    } catch (eMp) {}
    return ContentService.createTextOutput(JSON.stringify(matchOut))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getMetaData") {
    var settings = buildSettingsMap_();
    // 若系統設定未填 allowedHd，回傳預設（與前端 DEFAULT 對齊）
    if (!settings.allowedHd) {
      settings.allowedHd = ALLOWED_HD_;
    }
    var metaKey = "jcjh_meta_" + String(semesterId || "");
    var metaCached = getCacheChunked(metaKey);
    if (metaCached && scope !== "fresh") {
      try {
        var metaObj = JSON.parse(metaCached);
        if (metaObj && metaObj.success) {
          metaObj.settings = settings; // 設定可能更新，覆寫
          return ContentService.createTextOutput(JSON.stringify(metaObj)).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (metaE) {}
    }
    var metaPayload = {
      success: true,
      semesters: getTableData("學期設定"),
      teachers: getSemesterTeachersCached_(semesterId),
      settings: settings
    };
    try { putCacheChunked(metaKey, JSON.stringify(metaPayload), CACHE_TTL_META_); } catch (metaPutE) {}
    return ContentService.createTextOutput(JSON.stringify(metaPayload)).setMimeType(ContentService.MimeType.JSON);
  }

  // 極輕量：只回進行中申請（待辦對齊用，不含課表）
  if (action === "getPendingOnly") {
    var teachersP = getSemesterTeachersCached_(semesterId);
    var isAdminP = resolveIsAdmin_(readerEmail, teachersP);
    var pendingKey = "jcjh_pending_" + semesterId + "_a";
    var pending = null;
    if (scope !== "fresh") {
      var pendingCached = getCacheChunked(pendingKey);
      if (pendingCached) {
        try { pending = JSON.parse(pendingCached); } catch (pE) { pending = null; }
      }
    }
    if (!pending) {
      var allReqP = getTableData("申請單").filter(function (req) {
        return req["學期代號"] === semesterId;
      });
      pending = allReqP.filter(function (req) {
        var st = String(req["狀態"] || "").toLowerCase();
        return st === "pending_teacher" || st === "pending_admin";
      });
      try { putCacheChunked(pendingKey, JSON.stringify(pending), CACHE_TTL_PENDING_); } catch (pPut) {}
    }
    if (!isAdminP) {
      pending = (pending || []).filter(function (req) {
        var a = String(req["申請人Email"] || "").toLowerCase();
        var b = String(req["受邀人Email"] || "").toLowerCase();
        return a === readerEmail || b === readerEmail;
      });
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      kind: "pendingOnly",
      requests: pending || [],
      count: (pending || []).length
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 歷史按月：只回該月申請（含已結案），不含課表／教師
  if (action === "getHistoryMonth") {
    var teachersH = getSemesterTeachersCached_(semesterId);
    var isAdminH = resolveIsAdmin_(readerEmail, teachersH);
    var monthStr = String(reqData.month || postData.month || "").trim().slice(0, 7); // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(monthStr)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "請提供月份 month=YYYY-MM"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var allReqH = getTableData("申請單").filter(function (req) {
      return req["學期代號"] === semesterId;
    });
    var monthRows = allReqH.filter(function (req) {
      var d1 = String(req["異動日期"] || "").slice(0, 7);
      var d2 = String(req["對調目標日期"] || "").slice(0, 7);
      var d3 = String(req["建立時間"] || "").slice(0, 7);
      return d1 === monthStr || d2 === monthStr || d3 === monthStr;
    });
    if (!isAdminH) {
      monthRows = monthRows.filter(function (req) {
        var a = String(req["申請人Email"] || "").toLowerCase();
        var b = String(req["受邀人Email"] || "").toLowerCase();
        return a === readerEmail || b === readerEmail;
      });
    }
    // 單月快取 60s（admin 全校）
    var histKey = "jcjh_hist_" + semesterId + "_" + monthStr + (isAdminH ? "_a" : "_u");
    // 個人快取 key 含 email 太碎；教師不走共用快取
    if (isAdminH) {
      var histCached = getCacheChunked(histKey);
      if (histCached) {
        return ContentService.createTextOutput(histCached).setMimeType(ContentService.MimeType.JSON);
      }
    }
    var histPayload = {
      success: true,
      kind: "historyMonth",
      month: monthStr,
      requests: monthRows,
      count: monthRows.length
    };
    var histJson = JSON.stringify(histPayload);
    if (isAdminH) {
      try { putCacheChunked(histKey, histJson, 60); } catch (hE) {}
    }
    return ContentService.createTextOutput(histJson).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getInitialData") {
    var teachersForRole = getSemesterTeachersCached_(semesterId);
    var readerIsAdmin = resolveIsAdmin_(readerEmail, teachersForRole);
    var historyAllFlag = reqData.historyAll === true || reqData.historyAll === "true" || reqData.historyAll === 1
      || postData.historyAll === true || postData.historyAll === "true";
    var requestsOnlyFlag = reqData.requestsOnly === true || reqData.requestsOnly === "true" || reqData.requestsOnly === 1
      || postData.requestsOnly === true || postData.requestsOnly === "true";
    var windowDaysOpt = 14;
    if (reqData.windowDays != null && reqData.windowDays !== "") windowDaysOpt = reqData.windowDays;
    else if (postData.windowDays != null && postData.windowDays !== "") windowDaysOpt = postData.windowDays;
    var wDays = parseInt(windowDaysOpt, 10) || 14;

    // ── 申請增量：updatedSince 之後變更列（softRefresh 用）──
    var updatedSinceRaw = reqData.updatedSince || postData.updatedSince || "";
    // 僅當明確 requestsDelta + 水位線時走增量（避免誤把一般 getInitialData 當 delta）
    if ((reqData.requestsDelta === true || reqData.requestsDelta === "true" || reqData.requestsDelta === 1
        || postData.requestsDelta === true || postData.requestsDelta === "true")
        && String(updatedSinceRaw || "").trim()) {
      var deltaOut = buildRequestsDelta_(semesterId, readerEmail, readerIsAdmin, updatedSinceRaw);
      return ContentService.createTextOutput(JSON.stringify(deltaOut))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── requestsOnly：申請＋空堂（共用底包後再個人化；淺拷貝）──
    if (requestsOnlyFlag) {
      var roSharedKey = "jcjh_reqonly_" + semesterId + "_admin_w" + wDays;
      var roShared = null;
      if (!historyAllFlag && scope !== "fresh") {
        var roCached = getCacheChunked(roSharedKey);
        if (roCached) {
          try { roShared = JSON.parse(roCached); } catch (eRo) { roShared = null; }
        }
      }
      if (!roShared) {
        roShared = buildFullSemesterPayload_(semesterId, {
          userEmail: "",
          isAdmin: true,
          historyAll: historyAllFlag,
          windowDays: wDays,
          requestsOnly: true
        });
        if (!historyAllFlag) {
          try { putCacheChunked(roSharedKey, JSON.stringify(roShared), CACHE_TTL_REQ_); } catch (eRoPut) {}
        }
      }
      var roOut = personalizeSharedPayload_(roShared, readerEmail, readerIsAdmin);
      return ContentService.createTextOutput(JSON.stringify(roOut))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── 全量：admin／教師共用底包（課表全校；申請全校列，回傳前淺拷 filter）──
    var fullSharedKey = readerIsAdmin
      ? ("jcjh_data_" + semesterId + "_admin_w" + wDays)
      : ("jcjh_data_" + semesterId + "_teacher_w" + wDays);
    var fullShared = null;
    if (!historyAllFlag && scope !== "fresh") {
      var fullCached = getCacheChunked(fullSharedKey);
      if (fullCached) {
        try { fullShared = JSON.parse(fullCached); } catch (eFull) { fullShared = null; }
      }
    }
    if (!fullShared) {
      fullShared = buildFullSemesterPayload_(semesterId, {
        userEmail: "",
        isAdmin: true,
        historyAll: historyAllFlag,
        windowDays: wDays
      });
      if (fullShared.settings && !fullShared.settings.allowedHd) {
        fullShared.settings.allowedHd = ALLOWED_HD_;
      }
      if (!historyAllFlag) {
        try {
          var ttl = readerIsAdmin ? CACHE_TTL_FULL_ : CACHE_TTL_TEACHER_FULL_;
          putCacheChunked(fullSharedKey, JSON.stringify(fullShared), ttl);
          // 教師／admin 底包內容相同時互寫，提高命中
          if (readerIsAdmin) {
            putCacheChunked(
              "jcjh_data_" + semesterId + "_teacher_w" + wDays,
              JSON.stringify(fullShared),
              CACHE_TTL_TEACHER_FULL_
            );
          }
        } catch (eFullPut) {}
      }
    }
    var fullOut = personalizeSharedPayload_(fullShared, readerEmail, readerIsAdmin);
    return ContentService.createTextOutput(JSON.stringify(fullOut))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: false, error: "未知的讀取 Action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// doGet：健康檢查 + 公開班級課表（?action=getPublicClassData&class=701）
function doGet(e) {
  try {
    e = e || {};
    var p = e.parameter || {};
    if (String(p.action || "") === "getPublicClassData") {
      assertPublicClassRateLimit_();
      var payload = buildPublicClassPayload_(p.semesterId, p.class || p.className || p.cls);
      return ContentService.createTextOutput(JSON.stringify(payload))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: "調代課 API 運作中。公開課表：GET ?action=getPublicClassData&class=701",
      version: "2026-07-14-public-class"
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


function assertNotTooFrequent_(userEmail, action) {
  try {
    var cache = CacheService.getScriptCache();
    var key = "rl_" + action + "_" + String(userEmail || "").toLowerCase();
    if (cache.get(key)) {
      throw new Error("操作過於頻繁，請稍候再試！");
    }
    cache.put(key, "1", 3); // 3 秒節流
  } catch (e) {
    if (String(e.message || e).indexOf("操作過於頻繁") !== -1) throw e;
  }
}

// ----------------- 主入口：doPost（讀寫） -----------------
function doPost(e) {
  try {
    ensureInit_();
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;

    // 讀取類：不佔寫入鎖；getPublicClassData 免 Token
    if (action === "getInitialData" || action === "getMetaData" || action === "getPublicClassData"
        || action === "getPendingOnly" || action === "getHistoryMonth"
        || action === "getMatchCandidates") {
      return handleReadAction_(postData);
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
    const idToken = postData.idToken;
    const semesterId = postData.semesterId;
    const reqData = postData.data;
    const currentUrl = postData.currentUrl || "";
    
    // 驗證 ID Token 並取得使用者 Email
    const user = verifyGoogleIdToken(idToken);
    const userEmail = user.email.toLowerCase();
    
    // 讀取目前的教師名單，驗證角色權限（superAdminEmails 系統設定 + 教師角色）
    const teachers = getTableData("教師名單").filter(t => t["學期代號"] === semesterId);
    const currentTeacher = teachers.find(t => String(t["教師Email"] || "").toLowerCase() === userEmail);
    const isAdmin = resolveIsAdmin_(userEmail, teachers);
    // 寫入 action 權限表（集中宣告，避免漏檢）
    var ADMIN_ONLY_ACTIONS = {
      saveSemester: 1, deleteSemester: 1, setDefaultSemester: 1,
      saveClassAwayEvent: 1, deleteClassAwayEvent: 1,
      saveTeacher: 1, deleteTeacher: 1, importTeachersBatch: 1, updateMutualQuotas: 1,
      saveScheduleCell: 1, clearScheduleCell: 1, importSchedulesBatch: 1,
      adminApprove: 1, adminReject: 1, adminApproveBatch: 1, adminRejectBatch: 1,
      deleteSubstitutionRecord: 1,
      saveHistoryEdit: 1, batchMarkPrinted: 1, saveMailSettings: 1, sendBatchNotices: 1
    };
    if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
      throw new Error("權限不足：此操作僅限教學組管理員！");
    }
    // 非管理員且不在名單：禁止寫入（空名單 bootstrap 時 isAdmin=true 除外）
    if (!isAdmin && teachers.length > 0 && !currentTeacher) {
      throw new Error("您的帳號不在本校教師名單中，無法操作！");
    }
    
    let cacheKey = "jcjh_data_" + semesterId;
    
    // ----------------- API Actions 路由 -----------------
    // 路由表（維護用；實際仍為 if/else 鏈，後續可改 dispatch）
    // READ (no write-lock): getMetaData | getInitialData
    // ADMIN: saveSemester, deleteSemester, setDefaultSemester, saveTeacher, deleteTeacher,
    //        importTeachersBatch, saveScheduleCell, clearScheduleCell, importSchedulesBatch,
    //        adminApprove, adminReject, deleteSubstitutionRecord, saveHistoryEdit,
    //        saveMailSettings, batchMarkPrinted
    // TEACHER: submitRequest, respondToRequest, cancelRequest, withdrawRequest

    
    // 1. 管理員專屬權限 Actions
    if (action === "saveSemester") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const teachersToCopy = reqData.teachersToCopy;
      delete reqData.teachersToCopy;
      saveRows("學期設定", [reqData], "學期代號");
      if (teachersToCopy && teachersToCopy.length > 0) {
      saveRows("教師名單", teachersToCopy, "教師Email");
      }
      // 廣播清除所有學期快取（含公開課表）
      const sems = getTableData("學期設定");
      sems.forEach(function (s) { invalidateSemesterCaches_(s["學期代號"]); });
      
    } else if (action === "deleteSemester") {
      if (!isAdmin) throw new Error("無管理員權限！");
      deleteRows("學期設定", "學期代號", reqData.semesterId);
      invalidateSemesterCaches_(reqData.semesterId);
      
    } else if (action === "setDefaultSemester") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const sems = getTableData("學期設定");
      sems.forEach(s => {
        s["是否預設"] = (s["學期代號"] === reqData.semesterId) ? "TRUE" : "FALSE";
      });
      saveRows("學期設定", sems, "學期代號");
      sems.forEach(function (s) { invalidateSemesterCaches_(s["學期代號"]); });

    } else if (action === "saveClassAwayEvent") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var cae = reqData || {};
      if (!cae["事件ID"]) cae["事件ID"] = "cae_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      cae["學期代號"] = semesterId;
      if (!cae["事件名稱"]) throw new Error("請填事件名稱！");
      if (!cae["起日"]) throw new Error("請填起日！");
      // 班級清單強制純文字：去掉前導 '、過濾 0/000/空
      var clsRaw = cae["班級清單"] != null ? cae["班級清單"] : (cae.classes || cae.classList || "");
      var clsParts = [];
      if (Array.isArray(clsRaw)) {
        clsParts = clsRaw.map(function (c) { return String(c == null ? "" : c).trim(); });
      } else {
        clsParts = String(clsRaw || "").replace(/^'+/, "").split(/[,，、;\s]+/);
      }
      clsParts = clsParts.map(function (c) {
        c = String(c || "").trim().replace(/^'+/, "");
        if (!c || /^0+$/.test(c)) return "";
        if (/^\d{4}-\d{2}-\d{2}/.test(c)) return "";
        return c;
      }).filter(Boolean);
      // 存成前導單引號＋逗號清單，Sheets 不會當數字／日期
      cae["班級清單"] = clsParts.length ? ("'" + clsParts.join(",")) : "";
      // 起迄日強制字串 YYYY-MM-DD
      cae["起日"] = String(cae["起日"] || "").slice(0, 10);
      cae["迄日"] = cae["迄日"] ? String(cae["迄日"]).slice(0, 10) : "";
      cae["事件ID"] = String(cae["事件ID"]);
      cae["鐘點規則"] = String(cae["鐘點規則"] || "keep");
      cae["可進互代"] = (cae["可進互代"] === true || cae["可進互代"] === "TRUE" || cae["可進互代"] === "true" || cae["可進互代"] === "是") ? "TRUE" : "FALSE";
      cae["啟用"] = (cae["啟用"] === false || cae["啟用"] === "FALSE" || cae["啟用"] === "false" || cae["啟用"] === "否") ? "FALSE" : "TRUE";
      saveRows("班級空堂事件", [cae], "事件ID");
      // 強制班級欄為文字格式，避免下次被讀成 number
      try {
        var shCae = getSpreadsheet().getSheetByName("班級空堂事件");
        if (shCae) {
          var hdrs = shCae.getRange(1, 1, 1, shCae.getLastColumn()).getValues()[0];
          var ci = hdrs.indexOf("班級清單");
          if (ci >= 0 && shCae.getLastRow() >= 2) {
            shCae.getRange(2, ci + 1, shCae.getLastRow() - 1, 1).setNumberFormat("@");
          }
        }
      } catch (fmtE) { /* ignore */ }
      // 空堂事件影響畫面／媒合，清結構層
      invalidateScheduleCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        id: cae["事件ID"],
        classes: cae["班級清單"]
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "deleteClassAwayEvent") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var delId = (reqData && (reqData.id || reqData["事件ID"])) || "";
      if (!delId) throw new Error("缺少事件ID！");
      deleteRows("班級空堂事件", "事件ID", delId);
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "saveTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      reqData["學期代號"] = semesterId;
      saveRows("教師名單", [reqData], "教師Email");
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "deleteTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      deleteRows("教師名單", "教師Email", reqData.email);
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "importTeachersBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const list = reqData.list.map(t => {
        t["學期代號"] = semesterId;
        return t;
      });
      // 一次性批次覆蓋/儲存
      saveRows("教師名單", list, "教師Email");
      invalidateScheduleCaches_(semesterId);

    } else if (action === "updateMutualQuotas") {
      // 批次更新教師互代額度（活動重算寫回／送出扣抵）
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "updateMutualQuotas");
      var qList = reqData.list || reqData.updates || [];
      if (!qList.length) throw new Error("更新清單為空！");
      if (qList.length > 300) throw new Error("單次最多 300 筆！");
      var teachersAll = getTableData("教師名單");
      var tMap = {};
      teachersAll.forEach(function (t) {
        var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
        if (em) tMap[em] = t;
      });
      var toSave = [];
      qList.forEach(function (item) {
        var em = String(item.email || item["教師Email"] || "").toLowerCase().trim();
        if (!em || !tMap[em]) return;
        var row = Object.assign({}, tMap[em]);
        var q = parseInt(item.mutualQuota != null ? item.mutualQuota : item["互代額度"], 10);
        if (isNaN(q) || q < 0) q = 0;
        row["互代額度"] = q;
        row["學期代號"] = semesterId;
        toSave.push(row);
      });
      if (!toSave.length) throw new Error("沒有可更新的教師！");
      saveRows("教師名單", toSave, "教師Email");
      invalidateScheduleCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: toSave.length
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "saveScheduleCell") {
      if (!isAdmin) throw new Error("無管理員權限！");
      reqData["學期代號"] = semesterId;
      saveRows("教師課表", [reqData], "課表ID");
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "clearScheduleCell") {
      if (!isAdmin) throw new Error("無管理員權限！");
      deleteRows("教師課表", "課表ID", reqData.id);
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "importSchedulesBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const list = reqData.list.map(s => {
        s["學期代號"] = semesterId;
        return s;
      });
      saveRows("教師課表", list, "課表ID");
      if (reqData.teachers && reqData.teachers.length > 0) {
        saveRows("教師名單", reqData.teachers, "教師Email");
      }
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "adminApprove") {
      if (!isAdmin) throw new Error("無管理員權限！");
      // 更新申請單狀態為 approved
      const requests = getTableData("申請單");
      const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      targetReq["狀態"] = "approved";
      if (reqData.note) targetReq["備註"] = reqData.note;
      saveRows("申請單", [targetReq], "申請單ID");
      // 待審核准一律寄通知信
      try { sendAdminApproveEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "adminApproveBatch") {
      // 批次核准：一次讀表、一次 saveRows（連續列合併寫）、再寄信
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "adminApproveBatch");
      var apIds = reqData.requestIds || reqData.ids || [];
      if (!apIds.length) throw new Error("請提供 requestIds");
      if (apIds.length > 40) throw new Error("單次批次核准最多 40 筆");
      var apAll = getTableData("申請單");
      var apById = {};
      apAll.forEach(function (r) {
        if (r && r["申請單ID"] != null) apById[String(r["申請單ID"])] = r;
      });
      var apNote = reqData.note || "";
      var apToSave = [];
      var apOkIds = [];
      var apMiss = 0;
      apIds.forEach(function (id) {
        var rid = String(id || "").replace(/_[12]$/, "");
        var row = apById[rid];
        if (!row) { apMiss++; return; }
        row["狀態"] = "approved";
        if (apNote) row["備註"] = apNote;
        apToSave.push(row);
        apOkIds.push(rid);
      });
      if (!apToSave.length) throw new Error("找不到可核准的申請單");
      saveRows("申請單", apToSave, "申請單ID");
      // 通知：同受邀人合併
      try {
        var apBySub = {};
        apToSave.forEach(function (r) {
          var em = String(r["受邀人Email"] || "").toLowerCase().trim();
          if (!em) return;
          if (!apBySub[em]) apBySub[em] = [];
          apBySub[em].push(r);
        });
        Object.keys(apBySub).forEach(function (em) {
          var g = apBySub[em];
          try {
            if (g.length === 1) sendAdminApproveEmail_(g[0], currentUrl);
            else sendAdminApproveBatchEmail_(g, currentUrl);
          } catch (apMailE) { logError_("adminApproveBatchMail", apMailE); }
        });
      } catch (apMailOuter) { logError_("adminApproveBatchMailOuter", apMailOuter); }
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: apToSave.length,
        ids: apOkIds,
        missing: apMiss
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "adminReject") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const requests = getTableData("申請單");
      const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_adminReject", qE); }
      targetReq["狀態"] = "admin_rejected";
      saveRows("申請單", [targetReq], "申請單ID");
      try { sendAdminRejectEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendAdminRejectEmail", ignE); }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "adminRejectBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "adminRejectBatch");
      var rjIds = reqData.requestIds || reqData.ids || [];
      if (!rjIds.length) throw new Error("請提供 requestIds");
      if (rjIds.length > 40) throw new Error("單次批次駁回最多 40 筆");
      var rjAll = getTableData("申請單");
      var rjById = {};
      rjAll.forEach(function (r) {
        if (r && r["申請單ID"] != null) rjById[String(r["申請單ID"])] = r;
      });
      var rjToSave = [];
      var rjOkIds = [];
      var rjMiss = 0;
      rjIds.forEach(function (id) {
        var rid = String(id || "").replace(/_[12]$/, "");
        var row = rjById[rid];
        if (!row) { rjMiss++; return; }
        try { restoreMutualQuotaForRequests_(row); } catch (qE) { logError_("restoreMutualQuota_adminRejectBatch", qE); }
        row["狀態"] = "admin_rejected";
        rjToSave.push(row);
        rjOkIds.push(rid);
      });
      if (!rjToSave.length) throw new Error("找不到可駁回的申請單");
      saveRows("申請單", rjToSave, "申請單ID");
      try {
        rjToSave.forEach(function (r) {
          try { sendAdminRejectEmail_(r, currentUrl); } catch (rjMailE) { logError_("adminRejectBatchMail", rjMailE); }
        });
      } catch (rjOuter) { logError_("adminRejectBatchMailOuter", rjOuter); }
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: rjToSave.length,
        ids: rjOkIds,
        missing: rjMiss
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "deleteSubstitutionRecord") {
      if (!isAdmin) throw new Error("無管理員權限！");
      // 若有 requestId，將申請單狀態改回 cancelled；扣額度單還原互代額度
      if (reqData.requestId && reqData.requestId !== "N/A") {
        const requests = getTableData("申請單");
        const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
        if (targetReq) {
          try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); }
          targetReq["狀態"] = "cancelled";
          saveRows("申請單", [targetReq], "申請單ID");
        }
      } else if (reqData.id) {
        const reqId = reqData.id.replace(/_[12]$/, "");
        const requests = getTableData("申請單");
        const targetReq = requests.find(r => r["申請單ID"] === reqId);
        if (targetReq) {
          try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); }
          targetReq["狀態"] = "cancelled";
          saveRows("申請單", [targetReq], "申請單ID");
        }
      }
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "saveHistoryEdit") {
      // 管理員可修正已生效之代／調課全部欄位（教師、日期節次、班級科目、假別經費等）
      if (!isAdmin) throw new Error("無管理員權限！");
      const requests = getTableData("申請單");
      const reqId = String(reqData.id || reqData.requestId || "").replace(/_[12]$/, "");
      if (!reqId) throw new Error("缺少申請單ID");
      const targetReq = requests.find(r => r["申請單ID"] === reqId);
      if (!targetReq) throw new Error("找不到該紀錄");

      var leaveEmail = String(reqData.requesterEmail || reqData["申請人Email"] || "").trim();
      var subEmail = String(reqData.targetTeacherEmail || reqData["受邀人Email"] || "").trim();
      if (!leaveEmail || !subEmail) throw new Error("請假教師與代課／對調教師皆必填");
      var leaveName = String(reqData.requesterName || reqData["申請人姓名"] || "").trim();
      var subName = String(reqData.targetTeacherName || reqData["受邀人姓名"] || "").trim();
      if (!leaveName || !subName) {
        var tAll = getTableData("教師名單");
        var findT = function (em) {
          em = String(em || "").toLowerCase();
          var hit = tAll.find(function (t) { return String(t["教師Email"] || "").toLowerCase() === em; });
          return hit ? String(hit["教師姓名"] || "") : em;
        };
        if (!leaveName) leaveName = findT(leaveEmail);
        if (!subName) subName = findT(subEmail);
      }

      var isEx = reqData.type === "exchange" || reqData.type === "對調"
        || targetReq["異動類型"] === "exchange" || targetReq["異動類型"] === "對調";
      if (reqData.type === "substitution" || reqData.type === "代課") isEx = false;
      if (reqData.type === "exchange" || reqData.type === "對調") isEx = true;

      var reqDate = String(reqData.requestDate || reqData["異動日期"] || "").trim();
      var reqPeriod = parseInt(reqData.requestPeriod || reqData["異動節次"] || 0, 10);
      if (!reqDate || !reqPeriod) throw new Error("請假日期與節次必填");
      var reqDow = parseInt(reqData.requestPeriodDay || reqData["異動星期"] || 0, 10);
      if (!reqDow) {
        var d0 = new Date(reqDate.replace(/-/g, "/"));
        reqDow = isNaN(d0.getTime()) ? 1 : (d0.getDay() === 0 ? 7 : d0.getDay());
      }

      targetReq["申請人Email"] = leaveEmail;
      targetReq["申請人姓名"] = leaveName;
      targetReq["受邀人Email"] = subEmail;
      targetReq["受邀人姓名"] = subName;
      targetReq["班級"] = String(reqData.className != null ? reqData.className : (reqData["班級"] || targetReq["班級"] || ""));
      targetReq["科目"] = String(reqData.subject != null ? reqData.subject : (reqData["科目"] || targetReq["科目"] || ""));
      targetReq["異動日期"] = reqDate;
      targetReq["異動星期"] = reqDow;
      targetReq["異動節次"] = reqPeriod;
      targetReq["異動類型"] = isEx ? "exchange" : "substitution";
      targetReq["請假事由"] = reqData.reason != null ? reqData.reason : (targetReq["請假事由"] || "");
      targetReq["備註"] = reqData.note != null ? reqData.note : (targetReq["備註"] || "");
      if (reqData.printed !== undefined) {
        targetReq["是否已印"] = (reqData.printed === true || reqData.printed === "TRUE" || reqData.printed === "true") ? "TRUE" : "FALSE";
      }

      if (isEx) {
        var tgtDate = String(reqData.targetDate || reqData["對調目標日期"] || "").trim();
        var tgtPeriod = parseInt(reqData.targetPeriod || reqData["對調目標節次"] || 0, 10);
        if (!tgtDate || !tgtPeriod) throw new Error("調課請填寫對調日期與節次");
        var tgtDow = parseInt(reqData.targetDayOfWeek || reqData["對調目標星期"] || 0, 10);
        if (!tgtDow) {
          var d1 = new Date(tgtDate.replace(/-/g, "/"));
          tgtDow = isNaN(d1.getTime()) ? 1 : (d1.getDay() === 0 ? 7 : d1.getDay());
        }
        targetReq["對調目標日期"] = tgtDate;
        targetReq["對調目標星期"] = tgtDow;
        targetReq["對調目標節次"] = tgtPeriod;
        targetReq["經費來源"] = "無";
      } else {
        targetReq["對調目標日期"] = "";
        targetReq["對調目標星期"] = "";
        targetReq["對調目標節次"] = "";
        if (reqData.subFee != null && reqData.subFee !== "") {
          targetReq["經費來源"] = String(reqData.subFee);
        }
      }

      saveRows("申請單", [targetReq], "申請單ID");
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "saveMailSettings") {
      if (!isAdmin) throw new Error("無管理員權限！");
      saveRows("系統設定", [{ "設定名稱": "gasMailApiUrl", "設定值": reqData.url }], "設定名稱");
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "batchMarkPrinted") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const requests = getTableData("申請單");
      const listToUpdate = [];
      reqData.ids.forEach(id => {
        const reqId = id.replace(/_[12]$/, "");
        const req = requests.find(r => r["申請單ID"] === reqId);
        if (req) {
          req["是否已印"] = "TRUE";
          listToUpdate.push(req);
        }
      });
      if (listToUpdate.length > 0) {
        saveRows("申請單", listToUpdate, "申請單ID");
      }
      invalidateSemesterCaches_(semesterId);
      
    // 2. 一般教師/受邀教師 Actions (包含基本身分檢驗)
    } else if (action === "submitRequest") {
      assertNotTooFrequent_(userEmail, "submitRequest");
      // 發起調代課申請（狀態一律由伺服器決定，忽略前端竄改）
      reqData.request["學期代號"] = semesterId;
      // 一般教師僅能替自己申請；管理員可代他人（活動互代／行政代送）
      if (String(reqData.request["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權代表他人發起申請單！");
      }
      // 扣額度／活動公費／第8節代課：僅管理員（活動互代）
      var feeOne = String(reqData.request["經費來源"] || "");
      if ((feeOne === "扣額度" || feeOne === "互代不結" || feeOne === "活動公費" || feeOne === "第8節代課") && !isAdmin) {
        throw new Error("扣額度／活動公費相關經費僅限管理員發起！");
      }
      // 僅管理員且明確 directApprove=true 才可直接核准；忽略前端「狀態」欄
      if (isAdmin && reqData.directApprove === true) {
        reqData.request["狀態"] = "approved";
      } else {
        reqData.request["狀態"] = "pending_teacher";
      }
      if (!reqData.request["批次ID"]) reqData.request["批次ID"] = "";
      
      saveRows("申請單", [reqData.request], "申請單ID");
      // skipNotify=true：只寫單不寄信（活動互代可先排完再手動通知）
      var skipNotifyOne = reqData.skipNotify === true || reqData.skipNotify === "true";
      if (!skipNotifyOne) {
        if (reqData.request["狀態"] === "approved") {
          try { sendAdminApproveEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }
        } else {
          try { sendSubInviteEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendSubInviteEmail", ignE); }
        }
      }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "submitRequestBatch") {
      // 方案 A：多筆申請單＋同一批次ID（每節仍獨立簽核）
      assertNotTooFrequent_(userEmail, "submitRequestBatch");
      var list = reqData.requests || [];
      if (!list.length) throw new Error("批次申請清單為空！");
      if (list.length > 20) throw new Error("單次批次最多 20 節！");
      var batchId = String(reqData.batchId || ("bat_" + Date.now())).trim();
      var directOk = isAdmin && reqData.directApprove === true;
      var finalStatus = directOk ? "approved" : "pending_teacher";
      var rows = [];
      for (var bi = 0; bi < list.length; bi++) {
        var row = list[bi] || {};
        if (String(row["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
          throw new Error("批次中含非本人申請，已拒絕！");
        }
        var feeRow = String(row["經費來源"] || "");
        if ((feeRow === "扣額度" || feeRow === "互代不結" || feeRow === "活動公費" || feeRow === "第8節代課") && !isAdmin) {
          throw new Error("扣額度／活動公費相關經費僅限管理員發起！");
        }
        row["學期代號"] = semesterId;
        row["批次ID"] = batchId;
        row["狀態"] = finalStatus;
        if (!row["申請單ID"]) row["申請單ID"] = "req_" + Date.now() + "_" + bi + "_" + Math.random().toString(36).substr(2, 6);
        if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
        rows.push(row);
      }
      saveRows("申請單", rows, "申請單ID");
      // skipNotify=true：只寫單不寄信
      var skipNotifyBatch = reqData.skipNotify === true || reqData.skipNotify === "true";
      if (!skipNotifyBatch) {
        try {
          var byInvitee = {};
          rows.forEach(function (r) {
            var em = String(r["受邀人Email"] || r.targetTeacherEmail || "").toLowerCase();
            if (!em) return;
            if (!byInvitee[em]) byInvitee[em] = [];
            byInvitee[em].push(r);
          });
          if (finalStatus === "approved") {
            Object.keys(byInvitee).forEach(function (em) {
              sendAdminApproveBatchEmail_(byInvitee[em], currentUrl);
            });
          } else {
            Object.keys(byInvitee).forEach(function (em) {
              var group = byInvitee[em];
              if (group.length === 1) {
                sendSubInviteEmail_(group[0], currentUrl);
              } else {
                sendSubInviteBatchEmail_(group, currentUrl);
              }
            });
          }
        } catch (ignBatchMail) {
          logError_("submitRequestBatchMail", ignBatchMail);
        }
      }
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        batchId: batchId,
        count: rows.length,
        skipNotify: !!skipNotifyBatch,
        ids: rows.map(function (r) { return r["申請單ID"]; })
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "sendBatchNotices") {
      // 歷史紀錄後發通知：依代課老師（受邀人）合併寄信
      if (!isAdmin) throw new Error("僅管理員可批次發通知！");
      assertNotTooFrequent_(userEmail, "sendBatchNotices");
      var noticeIds = reqData.requestIds || reqData.ids || [];
      if (!noticeIds.length) throw new Error("請先選擇要通知的申請單！");
      if (noticeIds.length > 50) throw new Error("單次最多 50 筆！");
      var allForNotice = getTableData("申請單");
      var bySub = {};
      var found = 0;
      noticeIds.forEach(function (id) {
        var rid = String(id || "").replace(/_[12]$/, "");
        var req = allForNotice.find(function (r) { return String(r["申請單ID"] || "") === rid; });
        if (!req) return;
        found++;
        var em = String(req["受邀人Email"] || "").toLowerCase().trim();
        if (!em || em.indexOf("@") === -1) return;
        if (!bySub[em]) bySub[em] = [];
        bySub[em].push(req);
      });
      if (!found) throw new Error("找不到對應申請單！");
      var sent = 0;
      var failed = 0;
      Object.keys(bySub).forEach(function (em) {
        try {
          var group = bySub[em];
          if (group.length === 1) {
            // 已核准用核准通知；否則用邀請信
            var st = String(group[0]["狀態"] || "");
            if (st === "approved") sendAdminApproveEmail_(group[0], currentUrl);
            else sendSubInviteEmail_(group[0], currentUrl);
          } else {
            var anyPending = group.some(function (r) { return String(r["狀態"] || "") === "pending_teacher"; });
            if (anyPending) sendSubInviteBatchEmail_(group, currentUrl);
            else sendAdminApproveBatchEmail_(group, currentUrl);
          }
          sent++;
        } catch (eMail) {
          failed++;
          logError_("sendBatchNotices", eMail);
        }
      });
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        groups: Object.keys(bySub).length,
        sent: sent,
        failed: failed,
        found: found
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "respondToRequest") {
      // 同意或拒絕調代課邀請
      const requests = getTableData("申請單");
      const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      // 確保操作者是受邀教師
      if (targetReq["受邀人Email"].toLowerCase() !== userEmail) {
        throw new Error("您無權對此邀請單進行操作！");
      }
      
      if (reqData.response !== "agree") {
        try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_respond", qE); }
      }
      if (reqData.response === "agree") {
        targetReq["狀態"] = "pending_admin";
      } else {
        targetReq["狀態"] = "rejected";
      }
      saveRows("申請單", [targetReq], "申請單ID");
      if (reqData.response === "agree") { try { sendRespondAgreeEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendRespondAgreeEmail", ignE); } } else { try { sendRespondRejectEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendRespondRejectEmail", ignE); } } invalidateSemesterCaches_(semesterId);

    } else if (action === "respondToBatch") {
      // 批次一次全部同意／全部拒絕（僅 pending_teacher 且本人為受邀人）
      assertNotTooFrequent_(userEmail, "respondToBatch");
      var batchId = String(reqData.batchId || "").trim();
      if (!batchId) throw new Error("缺少批次ID！");
      var resp = reqData.response === "agree" ? "agree" : "decline";
      var allReq = getTableData("申請單");
      var peers = allReq.filter(function (r) {
        return String(r["批次ID"] || "") === batchId
          && String(r["狀態"] || "") === "pending_teacher"
          && String(r["受邀人Email"] || "").toLowerCase() === userEmail;
      });
      if (!peers.length) throw new Error("找不到可處理的批次申請（可能已處理或不屬於您）！");
      if (resp !== "agree") {
        try { restoreMutualQuotaForRequests_(peers); } catch (qE) { logError_("restoreMutualQuota_respondBatch", qE); }
      }
      var newStatus = resp === "agree" ? "pending_admin" : "rejected";
      peers.forEach(function (r) { r["狀態"] = newStatus; });
      saveRows("申請單", peers, "申請單ID");
      try {
        if (resp === "agree") {
          sendRespondAgreeBatchEmail_(peers, currentUrl);
        } else {
          sendRespondRejectBatchEmail_(peers, currentUrl);
        }
      } catch (ignBatchResp) {
        logError_("respondToBatchMail", ignBatchResp);
      }
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        batchId: batchId,
        count: peers.length,
        response: resp
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "cancelRequest") {
      // 撤回申請
      const requests = getTableData("申請單");
      const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      // 僅限本人或管理員撤回
      if (targetReq["申請人Email"].toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權撤回他人的申請單！");
      }
      try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_cancel", qE); }
      targetReq["狀態"] = "cancelled";
      saveRows("申請單", [targetReq], "申請單ID");
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "withdrawRequest") {
      // 已送到行政端待簽核時，一般教師撤回
      const requests = getTableData("申請單");
      const targetReq = requests.find(r => r["申請單ID"] === reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      if (targetReq["申請人Email"].toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權撤回此申請單！");
      }
      try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_withdraw", qE); }
      targetReq["狀態"] = "withdrawn";
      saveRows("申請單", [targetReq], "申請單ID");
      invalidateSemesterCaches_(semesterId);
      
    } else {
      throw new Error("未定義的 POST Action");
    }
    
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
    } finally {
      try { lock.releaseLock(); } catch (ign) {}
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ----------------- 狀態與類型中英文對照翻譯 -----------------
function translateStatusToEn(zhStatus) {
  const map = {
    "待受邀人簽核": "pending_teacher",
    "待行政審核": "pending_admin",
    "已核准": "approved",
    "受邀人已拒絕": "rejected",
    "行政已退回": "admin_rejected",
    "已取消": "cancelled",
    "已撤回": "withdrawn"
  };
  return map[zhStatus] || zhStatus;
}

function translateStatusToZh(enStatus) {
  const map = {
    "pending_teacher": "待受邀人簽核",
    "pending_admin": "待行政審核",
    "approved": "已核准",
    "rejected": "受邀人已拒絕",
    "admin_rejected": "行政已退回",
    "cancelled": "已取消",
    "withdrawn": "已撤回"
  };
  return map[enStatus] || enStatus;
}

function translateTypeToEn(zhType) {
  const map = {
    "代課": "substitution",
    "對調": "exchange"
  };
  return map[zhType] || zhType;
}

function translateTypeToZh(enType) {
  const map = {
    "substitution": "代課",
    "exchange": "對調"
  };
  return map[enType] || enType;
}

// ============================================================
// ✉️ Email 通知輔助函數（GmailApp 內建寄送，無需額外設定）
// 觸發點：申請成立→受邀教師 / 受邀同意→申請人 / 核准→雙方
// 寄信失敗已 try/catch 包裹，不影響主流程
// ============================================================

function logError_(action, err) {
  try {
    const ss = getSpreadsheet();
    var logSheet = ss.getSheetByName("系統日誌");
    if (!logSheet) {
      logSheet = ss.insertSheet("系統日誌");
      logSheet.appendRow(["時間", "操作", "錯誤內容"]);
      logSheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#fee2e2");
    }
    logSheet.appendRow([toLocalTimeStr(new Date()), action, String(err)]);
  } catch(e) {}
}

// ============================================================
// Email 通知輔助函數
// ============================================================

function _dayText_(day) {
  var map = {"1":"星期一","2":"星期二","3":"星期三","4":"星期四","5":"星期五"};
  return map[String(day)] || "";
}

/**
 * RFC 2047 主旨編碼，避免中文標題被誤當 Latin-1 顯示成 Ã£Â€Â… 亂碼
 */
function _mimeEncodeSubject_(subject) {
  var s = String(subject || "");
  if (!s) return "";
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  try {
    var blob = Utilities.newBlob(s, "text/plain; charset=UTF-8");
    var bytes = blob.getBytes();
    var chunks = [];
    var i = 0;
    while (i < bytes.length) {
      var end = Math.min(i + 45, bytes.length);
      while (end > i + 1 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (end <= i) end = Math.min(i + 1, bytes.length);
      var slice = [];
      for (var j = i; j < end; j++) slice.push(bytes[j]);
      chunks.push("=?UTF-8?B?" + Utilities.base64Encode(slice) + "?=");
      i = end;
    }
    return chunks.join("\r\n ");
  } catch (e) {
    try {
      var b64 = Utilities.base64Encode(Utilities.newBlob(s, "text/plain; charset=UTF-8").getBytes());
      return "=?UTF-8?B?" + b64 + "?=";
    } catch (e2) {
      return s;
    }
  }
}

/** 統一寄信：主旨 RFC 2047 編碼 + HTML UTF-8 */
function sendSystemEmail_(to, subject, htmlBody) {
  if (!to || String(to).indexOf("@") === -1) return;
  var encSubject = _mimeEncodeSubject_(subject);
  var body = String(htmlBody || "");
  if (body.indexOf("charset") === -1) {
    body = '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' + body;
  }
  GmailApp.sendEmail(String(to), encSubject, "請使用可顯示 HTML 的郵件用戶端開啟此通知。", {
    htmlBody: body,
    name: "建成國中調代課系統"
  });
}

function _wrapHtmlTemplate_(title, headerColor, contentHtml) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>'
    + '<div style="font-family: system-ui, \'Microsoft JhengHei\', \'Noto Sans TC\', sans-serif; background-color: #f8fafc; padding: 30px 15px; color: #334155; font-size: 15px; line-height: 1.6;">'
    + '<div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04); border: 1px solid #e2e8f0; padding: 28px;">'
    + '<h2 style="color: ' + headerColor + '; margin-top: 0; font-size: 20px; font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 14px;">' + title + '</h2>'
    + '<div style="padding-top: 10px;">'
    + contentHtml
    + '</div>'
    + '</div>'
    + '</div>'
    + '</body></html>';
}

function _buildReqTable_(req) {
  var targetTeacher = req.targetTeacherName || req["受邀人姓名"];
  var isExchange = !!(req.targetDate || req["對調目標日期"]);
  
  var getShortDay = function(d) {
    return {"1":"一","2":"二","3":"三","4":"四","5":"五"}[String(d)] || "";
  };

  var leaveDay = getShortDay(req.requestPeriodDay || req["異動星期"]);
  var leavePeriod = req.requestPeriod || req["異動節次"];
  var leaveClass = req.className || req["班級"] || "";
  var leaveSubject = req.subject || req["科目"] || "";
  var leaveClassSubject = (leaveClass + " " + leaveSubject).trim();
  
  var leaveTimeText = "(" + leaveDay + ") 第" + leavePeriod + "節 - " + leaveClassSubject;
  var leaveDateText = req.requestDate || req["異動日期"];
  var rows = [
    ["請假教師", req.requesterName || req["申請人姓名"]],
    [isExchange ? "對調教師" : "代課教師", targetTeacher || ""],
    ["請假原因", req.reason || req["請假事由"] || "公假"],
    ["請假課堂", leaveDateText + " " + leaveTimeText]
  ];
  var targetDateVal = req.targetDate || req["對調目標日期"];
  if (targetDateVal) {
    var targetDay = req.targetDayOfWeek || req["對調目標星期"];
    var targetPeriod = req.targetPeriod || req["對調目標節次"];
    var targetTeacherEmail = req.targetTeacherEmail || req["受邀人Email"];
    var targetClassSubject = "";
    if (targetTeacherEmail && targetDay && targetPeriod) {
      try {
        var schedules = getTableData("教師課表");
        var tEmail = targetTeacherEmail.toLowerCase().trim();
        var sched = schedules.find(function(s) {
          var sEmail = (s.teacherEmail || s["教師Email"] || "").toLowerCase().trim();
          var sDay = s.dayOfWeek || s["星期"];
          var sPeriod = s.period || s["節次"];
          return sEmail === tEmail && parseInt(sDay) === parseInt(targetDay) && parseInt(sPeriod) === parseInt(targetPeriod);
        });
        if (sched) {
          var cls = sched.className || sched["班級"] || "";
          var subj = sched.subject || sched["科目"] || "";
          targetClassSubject = (cls + " " + subj).trim();
        }
      } catch(e) {}
    }
    var targetDayShort = getShortDay(targetDay);
    var valStr = targetDateVal + " (" + targetDayShort + ") 第" + targetPeriod + "節 - " + targetClassSubject;
    rows.push(["對調課堂", valStr]);
  } else {
    var feeText = req.subFee || req["經費來源"] || "自理";
    if (feeText === "代課費") { feeText = "公費代課"; }
    else if (feeText === "自理") { feeText = "基本鐘點/自理"; }
    rows.push(["經費鐘點", feeText]);
  }
  var noteVal = req.note || req["備註"];
  if (noteVal) { rows.push(["備註", noteVal]); }
  var trs = rows.map(function(r) {
    return '<tr><td style="padding:12px 16px;background-color:#f1f5f9;font-weight:bold;border:1px solid #e2e8f0;width:120px;color:#475569;font-size:14px;">' + r[0] + '</td><td style="padding:12px 16px;border:1px solid #e2e8f0;color:#1e293b;font-size:14px;background:#fff;">' + r[1] + '</td></tr>';
  }).join("");
  return '<table style="border-collapse:collapse;width:100%;margin:18px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">' + trs + '</table>';
}

function sendSubInviteEmail_(req, currentUrl) {
  var to = req.targetTeacherEmail || req["受邀人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var serial = req.serial || req["單號"] || "SUB";
  var requesterName = req.requesterName || req["申請人姓名"];
  var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
  var subject = "【調代課系統】您收到一份來自 " + requesterName + " 老師的線上簽核邀請 (" + serial + ")";
  var sysUrl = currentUrl || "http://localhost:8000";
  var reqId = req.id || req.requestId || req["申請單ID"];
  var agreeLink  = sysUrl + "?action=respond&id=" + reqId + "&status=agree";
  var declineLink = sysUrl + "?action=respond&id=" + reqId + "&status=decline";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + targetTeacherName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + requesterName + '</b> 老師向您發起了調代課邀請，明細如下：</p>'
    + _buildReqTable_(req)
    + '<p style="margin-top:24px;font-weight:bold;color:#1e293b;">您可以直接點擊下方按鈕線上回應（需登入學校 Google 帳號）：</p>'
    + '<div style="margin:20px 0;">'
    + '<a href="' + agreeLink  + '" style="background-color:#059669;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin-right:16px;font-size:14px;box-shadow:0 4px 12px rgba(5,150,105,0.15);letter-spacing:1px;">同意接受邀請</a>'
    + '<a href="' + declineLink + '" style="background-color:#e11d48;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(225,29,72,0.15);letter-spacing:1px;">拒絕此邀請</a>'
    + '</div>'
    + '<div style="font-size:13px;color:#94a3b8;margin-top:20px;border-top:1px dashed #e2e8f0;padding-top:16px;">如按鈕失效，您也可以直接點擊下方按鈕登入確認：<br>'
    + '<div style="margin-top:10px;"><a href="' + sysUrl + '" style="background-color:#475569;color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;box-shadow:0 4px 12px rgba(71,85,105,0.15);letter-spacing:1px;">登入系統確認</a></div></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 線上簽核邀請", "#2563eb", content);
  sendSystemEmail_(to, subject, htmlBody);
}

/** 批次邀請：一封信列齊全部節次，每節各自同意／拒絕 */
function sendSubInviteBatchEmail_(rows, currentUrl) {
  if (!rows || !rows.length) return;
  var first = rows[0];
  var to = first.targetTeacherEmail || first["受邀人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var requesterName = first.requesterName || first["申請人姓名"] || "";
  var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
  var reason = first.reason || first["請假事由"] || "請假";
  var fee = first.subFee || first["經費來源"] || "自費代課";
  var n = rows.length;
  var sysUrl = currentUrl || "http://localhost:8000";
  var subject = "【調代課系統】您收到一批來自 " + requesterName + " 老師的代課邀請（共 " + n + " 節）";

  var getShortDay = function (d) {
    return { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" }[String(d)] || "";
  };

  var batchId = first["批次ID"] || first.batchId || "";
  var agreeAllLink = sysUrl + "?action=respondBatch&batchId=" + encodeURIComponent(batchId) + "&status=agree";
  var declineAllLink = sysUrl + "?action=respondBatch&batchId=" + encodeURIComponent(batchId) + "&status=decline";

  var summary =
    '<table style="border-collapse:collapse;width:100%;margin:12px 0 18px;border:1px solid #e2e8f0;">'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;width:110px;color:#475569;font-size:14px;">請假教師</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + requesterName + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">代課教師</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + targetTeacherName + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">假別事由</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + reason + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">經費來源</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + fee + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">節數</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">共 ' + n + ' 節（可全部同意，或逐節處理）</td></tr>'
    + '</table>'
    + '<div style="margin:0 0 18px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">'
    + '<div style="font-weight:700;color:#166534;margin-bottom:10px;font-size:14px;">一次處理全部 ' + n + ' 節：</div>'
    + '<a href="' + agreeAllLink + '" style="background-color:#059669;color:#ffffff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin-right:12px;font-size:14px;">全部同意</a>'
    + '<a href="' + declineAllLink + '" style="background-color:#e11d48;color:#ffffff;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">全部拒絕</a>'
    + '</div>';

  var cards = rows.map(function (req, i) {
    var reqId = req.id || req.requestId || req["申請單ID"];
    var dateVal = req.requestDate || req["異動日期"] || "";
    var dayVal = req.requestPeriodDay || req["異動星期"] || "";
    var periodVal = req.requestPeriod || req["異動節次"] || "";
    var cls = req.className || req["班級"] || "";
    var subj = req.subject || req["科目"] || "";
    var serial = req.serial || req["單號"] || "";
    var agreeLink = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=agree";
    var declineLink = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=decline";
    var mmdd = "";
    if (dateVal && String(dateVal).length >= 10) {
      mmdd = String(dateVal).substr(5, 2) + "/" + String(dateVal).substr(8, 2);
    } else {
      mmdd = dateVal;
    }
    var title = (i + 1) + ". " + mmdd + "（" + getShortDay(dayVal) + "）第" + periodVal + "節 " + cls + " " + subj;
    return '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:0 0 12px;background:#fff;">'
      + '<div style="font-weight:700;color:#1e293b;font-size:14px;margin-bottom:4px;">' + title + '</div>'
      + (serial ? '<div style="font-size:12px;color:#94a3b8;margin-bottom:10px;">單號：' + serial + '</div>' : '')
      + '<div style="margin-top:8px;">'
      + '<a href="' + agreeLink + '" style="background-color:#059669;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin-right:10px;font-size:13px;">同意此節</a>'
      + '<a href="' + declineLink + '" style="background-color:#e11d48;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;">拒絕此節</a>'
      + '</div></div>';
  }).join("");

  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + targetTeacherName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + requesterName + '</b> 老師向您發起了<strong>一批代課邀請（共 ' + n + ' 節）</strong>。可先「全部同意」，或於下方逐節處理：</p>'
    + summary
    + '<p style="font-weight:700;color:#334155;font-size:14px;margin:8px 0 10px;">或逐節確認：</p>'
    + cards
    + '<div style="font-size:13px;color:#94a3b8;margin-top:16px;border-top:1px dashed #e2e8f0;padding-top:16px;">'
    + '如按鈕失效，請登入系統於「待辦簽核」處理：<br>'
    + '<div style="margin-top:10px;"><a href="' + sysUrl + '" style="background-color:#475569;color:#ffffff;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;">登入系統確認</a></div></div>';

  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次簽核邀請", "#2563eb", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendRespondAgreeBatchEmail_(rows, currentUrl) {
  if (!rows || !rows.length) return;
  var first = rows[0];
  var to = first.requesterEmail || first["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var requesterName = first.requesterName || first["申請人姓名"] || "";
  var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
  var n = rows.length;
  var sysUrl = currentUrl || "http://localhost:8000";
  var subject = "【調代課系統】" + targetTeacherName + " 老師已全部同意您的批次代課（共 " + n + " 節），待行政審核";
  var getShortDay = function (d) {
    return { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" }[String(d)] || "";
  };
  var listHtml = '<ul style="padding-left:20px;color:#1e293b;font-size:14px;line-height:1.7;">'
    + rows.map(function (req) {
      var dateVal = req.requestDate || req["異動日期"] || "";
      var dayVal = req.requestPeriodDay || req["異動星期"] || "";
      var periodVal = req.requestPeriod || req["異動節次"] || "";
      var cls = req.className || req["班級"] || "";
      var subj = req.subject || req["科目"] || "";
      return '<li>' + dateVal + ' (週' + getShortDay(dayVal) + ') 第' + periodVal + '節　' + cls + ' ' + subj + '</li>';
    }).join("")
    + '</ul>';
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + requesterName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + targetTeacherName + '</b> 老師已<strong>全部同意</strong>您的批次代課邀請（共 ' + n + ' 節）。</p>'
    + '<p style="color:#475569;">目前已送交教學組審核，明細如下：</p>'
    + listHtml
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看狀態</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次已同意", "#d97706", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendRespondRejectBatchEmail_(rows, currentUrl) {
  if (!rows || !rows.length) return;
  var first = rows[0];
  var to = first.requesterEmail || first["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var requesterName = first.requesterName || first["申請人姓名"] || "";
  var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
  var n = rows.length;
  var sysUrl = currentUrl || "http://localhost:8000";
  var subject = "【調代課系統】" + targetTeacherName + " 老師已全部拒絕您的批次代課（共 " + n + " 節）";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + requesterName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + targetTeacherName + '</b> 老師已<strong>全部拒絕</strong>您的批次代課邀請（共 ' + n + ' 節）。</p>'
    + '<p style="color:#475569;">請進入系統重新媒合：</p>'
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#475569;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">重新選擇代課教師</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次已拒絕", "#ef4444", content);
  sendSystemEmail_(to, subject, htmlBody);
}

/** 批次核准明細列：每節寫清請假人→代課人，避免多人混在同一封時資訊錯置 */
function _buildApproveSlotListHtml_(rows, opts) {
  opts = opts || {};
  var showLeave = opts.showLeave !== false;
  var showSub = opts.showSub !== false;
  var getShortDay = function (d) {
    return { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" }[String(d)] || "";
  };
  return '<ul style="padding-left:20px;color:#1e293b;font-size:14px;line-height:1.7;">'
    + (rows || []).map(function (req) {
      var dateVal = req.requestDate || req["異動日期"] || "";
      var dayVal = req.requestPeriodDay || req["異動星期"] || "";
      var periodVal = req.requestPeriod || req["異動節次"] || "";
      var cls = req.className || req["班級"] || "";
      var subj = req.subject || req["科目"] || "";
      var leaveN = req.requesterName || req["申請人姓名"] || "";
      var subN = req.targetTeacherName || req["受邀人姓名"] || "";
      var who = "";
      if (showLeave && showSub) {
        who = "　<strong>" + leaveN + "</strong>→<strong>" + subN + "</strong>";
      } else if (showLeave) {
        who = "　請假：<strong>" + leaveN + "</strong>";
      } else if (showSub) {
        who = "　代課：<strong>" + subN + "</strong>";
      }
      return "<li>" + dateVal + " (週" + getShortDay(dayVal) + ") 第" + periodVal + "節　" + cls + " " + subj + who + "</li>";
    }).join("")
    + "</ul>";
}

/**
 * 批次直接核准通知（方案：代課師一封全貌 + 請假師各收自己的節）
 * - 代課老師：收到「自己代的全部節」，每節標明代誰
 * - 請假老師：只收到「自己請假、被誰代」的節（不會看到別人的）
 * 解決：A 代 B、C 時舊版只寄 A/B 且兩節都寫成 A 代 B、C 收不到信
 */
function sendAdminApproveBatchEmail_(rows, currentUrl) {
  if (!rows || !rows.length) return;
  var sysUrl = currentUrl || "http://localhost:8000";
  var validEmail = function (e) {
    return e && String(e).indexOf("@") !== -1;
  };
  var normEm = function (e) {
    return String(e || "").toLowerCase().trim();
  };

  // 依代課老師分組 → 每人一封總表
  var bySub = {};
  rows.forEach(function (req) {
    var em = normEm(req.targetTeacherEmail || req["受邀人Email"]);
    if (!validEmail(em)) return;
    if (!bySub[em]) bySub[em] = { email: (req.targetTeacherEmail || req["受邀人Email"]), name: req.targetTeacherName || req["受邀人姓名"] || "", rows: [] };
    if (!bySub[em].name) bySub[em].name = req.targetTeacherName || req["受邀人姓名"] || "";
    bySub[em].rows.push(req);
  });

  Object.keys(bySub).forEach(function (emKey) {
    var g = bySub[emKey];
    var n = g.rows.length;
    var leaveNames = [];
    var seenLeave = {};
    g.rows.forEach(function (r) {
      var nm = r.requesterName || r["申請人姓名"] || "";
      if (nm && !seenLeave[nm]) {
        seenLeave[nm] = true;
        leaveNames.push(nm);
      }
    });
    var leaveLabel = leaveNames.length ? leaveNames.join("、") : "相關教師";
    var subject = "【調代課系統】批次代課已核准生效（您代課共 " + n + " 節）";
    var listHtml = _buildApproveSlotListHtml_(g.rows, { showLeave: true, showSub: true });
    var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + (g.name || "老師") + '</b> 老師，您好：</p>'
      + '<p style="color:#475569;margin-top:0;">以下 <b>' + n + " 節</b>代課已由教學組核准出單並生效（您為代課教師；請假：" + leaveLabel + "）：</p>"
      + listHtml
      + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看</a></div>';
    var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次已核准（代課）", "#059669", content);
    sendSystemEmail_(g.email, subject, htmlBody);
  });

  // 依請假老師分組 → 每人只寄自己的節
  var byLeave = {};
  rows.forEach(function (req) {
    var em = normEm(req.requesterEmail || req["申請人Email"]);
    if (!validEmail(em)) return;
    if (!byLeave[em]) byLeave[em] = { email: (req.requesterEmail || req["申請人Email"]), name: req.requesterName || req["申請人姓名"] || "", rows: [] };
    if (!byLeave[em].name) byLeave[em].name = req.requesterName || req["申請人姓名"] || "";
    byLeave[em].rows.push(req);
  });

  Object.keys(byLeave).forEach(function (emKey) {
    var g = byLeave[emKey];
    // 若此人同時是本批某一節的代課老師，代課全貌信已寄過；請假視角仍寄自己的節（內容不同）
    var n = g.rows.length;
    var subNames = [];
    var seenSub = {};
    g.rows.forEach(function (r) {
      var nm = r.targetTeacherName || r["受邀人姓名"] || "";
      if (nm && !seenSub[nm]) {
        seenSub[nm] = true;
        subNames.push(nm);
      }
    });
    var subLabel = subNames.length ? subNames.join("、") : "相關教師";
    var subject = "【調代課系統】批次代課已核准生效（您請假共 " + n + " 節）";
    var listHtml = _buildApproveSlotListHtml_(g.rows, { showLeave: false, showSub: true });
    var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + (g.name || "老師") + '</b> 老師，您好：</p>'
      + '<p style="color:#475569;margin-top:0;">以下 <b>' + n + " 節</b>為您請假、已由教學組核准出單並生效（代課：" + subLabel + "）：</p>"
      + listHtml
      + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看</a></div>';
    var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次已核准（請假）", "#059669", content);
    sendSystemEmail_(g.email, subject, htmlBody);
  });
}

function sendRespondAgreeEmail_(req, currentUrl) {
  var to = req.requesterEmail || req["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var serial = req.serial || req["單號"] || "SUB";
  var requesterName = req.requesterName || req["申請人姓名"];
  var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
  var subject = "【調代課系統】" + targetTeacherName + " 老師已接受您的代課邀請，待行政審核中";
  var sysUrl = currentUrl || "http://localhost:8000";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + requesterName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + targetTeacherName + '</b> 老師已同意接受了您的調代課邀請。</p>'
    + '<p style="color:#475569;">目前申請案已送交行政教學組，待行政最終審核後生效，明細如下：</p>'
    + _buildReqTable_(req)
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(37,99,235,0.15);letter-spacing:1px;">進入系統查看狀態</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 等候行政審核", "#d97706", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendRespondRejectEmail_(req, currentUrl) {
  var to = req.requesterEmail || req["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var requesterName = req.requesterName || req["申請人姓名"];
  var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
  var subject = "【調代課系統】" + targetTeacherName + " 老師已拒絕了您的調代課邀請";
  var sysUrl = currentUrl || "http://localhost:8000";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + requesterName + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + targetTeacherName + '</b> 老師已拒絕了您的調代課邀請。</p>'
    + '<p style="color:#475569;">此堂課表時段已重新開放代課，請進入系統為該課程重新媒合教師：</p>'
    + _buildReqTable_(req)
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#475569;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(71,85,105,0.15);letter-spacing:1px;">重新選擇代課教師</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 邀請已被拒絕", "#ef4444", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendAdminApproveEmail_(req, currentUrl) {
  var to1 = req.requesterEmail || req["申請人Email"];
  var to2 = req.targetTeacherEmail || req["受邀人Email"];
  var emails = [to1, to2].filter(function(e) { return e && e.indexOf("@") !== -1; });
  if (emails.length === 0) return;
  var serial = req.serial || req["單號"] || "SUB";
  var subject = "【調代課系統】您的調代課申請已由教學組核准出單並生效 (" + serial + ")";
  var sysUrl = currentUrl || "http://localhost:8000";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">兩位老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;">您申報的調代課案件已由教學組核准出單並生效，異動已自動寫入全校課表中。明細如下：</p>'
    + _buildReqTable_(req)
    + '<div style="margin-top:24px;border-top:1px dashed #e2e8f0;padding-top:16px;">'
    + '<h4 style="color:#ef4444;margin:0 0 8px 0;font-size:15px;">貼心提醒：</h4>'
    + '<ul style="margin:0;padding-left:20px;color:#475569;font-size:14px;">'
    + '<li style="margin-bottom:6px;">請兩位教師確實向對方交代班級上課進度與常規要求。</li>'
    + '<li>實際上課教師請確實於該班教室日誌上簽章。</li>'
    + '</ul></div>'
    + '<p style="color:#475569;margin-top:24px;font-size:14px;">您可以點擊下方按鈕前往查看最新的當週課表：</p>'
    + '<div style="margin:16px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(37,99,235,0.15);letter-spacing:1px;">進入系統查看課表</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 審核通過通知", "#10b981", content);
  emails.forEach(function (em) { sendSystemEmail_(em, subject, htmlBody); });
}

function sendAdminRejectEmail_(req, currentUrl) {
  var to1 = req.requesterEmail || req["申請人Email"];
  var to2 = req.targetTeacherEmail || req["受邀人Email"];
  var emails = [to1, to2].filter(function(e) { return e && e.indexOf("@") !== -1; });
  if (emails.length === 0) return;
  var serial = req.serial || req["單號"] || "SUB";
  var subject = "【調代課系統】您的調代課申請已被教學組駁回 (單號: " + serial + ")";
  var sysUrl = currentUrl || "http://localhost:8000";
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">兩位老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;">很抱歉通知您，您申報的調代課案件已被教學組駁回，未核准出單。明細如下：</p>'
    + _buildReqTable_(req)
    + '<p style="color:#475569;margin-top:24px;font-size:14px;">若有任何疑問，請向教學組洽詢。</p>'
    + '<div style="margin:16px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(37,99,235,0.15);letter-spacing:1px;">進入系統查看</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 申請被行政駁回", "#ef4444", content);
  emails.forEach(function (em) { sendSystemEmail_(em, subject, htmlBody); });
}

