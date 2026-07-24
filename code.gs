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
  // 系統設定可覆寫（走 mem 快取，勿每次整表）
  try {
    var map = buildSettingsMap_();
    if (map && map.allowedHd) {
      return String(map.allowedHd).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    }
  } catch (e) {}
  return String(ALLOWED_HD_).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function getSuperAdminEmails_() {
  try {
    var map = buildSettingsMap_();
    if (map && map.superAdminEmails) {
      return String(map.superAdminEmails).split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    }
  } catch (e) {}
  return [];
}

/** 系統角色正規化：admin／staff／teacher */
function normalizeRole_(raw) {
  var s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "teacher";
  if (s === "admin" || s.indexOf("管理") >= 0 || s.indexOf("教學組") >= 0
      || s.indexOf("主管") >= 0 || s === "administrator") return "admin";
  if (s === "staff" || s === "行政" || s.indexOf("行政") >= 0 || s === "clerk") return "staff";
  if (s === "teacher" || s.indexOf("教師") >= 0 || s.indexOf("老師") >= 0) return "teacher";
  return "teacher";
}

function resolveTeacherRole_(userEmail, teachers) {
  var email = String(userEmail || "").toLowerCase();
  var supers = getSuperAdminEmails_();
  if (supers.indexOf(email) !== -1) return "admin";
  if (!teachers || teachers.length === 0) {
    if (supers.length > 0) return "teacher";
    return "admin";
  }
  var currentTeacher = teachers.find(function (t) {
    return String(t["教師Email"] || t.email || "").toLowerCase() === email;
  });
  if (!currentTeacher) return "";
  return normalizeRole_(currentTeacher["系統角色"] || currentTeacher.role || "teacher");
}

function resolveIsAdmin_(userEmail, teachers) {
  return resolveTeacherRole_(userEmail, teachers) === "admin";
}

function resolveIsStaff_(userEmail, teachers) {
  return resolveTeacherRole_(userEmail, teachers) === "staff";
}

/** 系統設定：可代申請的行政 Email 白名單（小寫陣列） */
function getProxySubmitEmails_() {
  try {
    var settings = buildSettingsMap_();
    var raw = settings.proxySubmitEmails;
    if (raw === undefined || raw === null || raw === "") {
      raw = settings.PROXY_SUBMIT_EMAILS != null ? settings.PROXY_SUBMIT_EMAILS : "";
    }
    if (!raw) return [];
    return String(raw).split(/[,，;\s]+/).map(function (s) {
      return String(s || "").trim().toLowerCase();
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** 指定 Email 是否獲行政代申請授權（須另驗證 role=staff） */
function isProxySubmitEmailGranted_(email) {
  var em = String(email || "").toLowerCase();
  if (!em) return false;
  var list = getProxySubmitEmails_();
  return list.indexOf(em) !== -1;
}

/** 行政 + 在白名單 → 可代申請（非一鍵全開所有行政） */
function canUserProxySubmit_(userEmail, teachers) {
  var em = String(userEmail || "").toLowerCase().trim();
  if (!em) return false;
  if (!resolveIsStaff_(userEmail, teachers)) return false;
  // 白名單比對再 trim 一次，避免試算表多空白
  var list = getProxySubmitEmails_();
  for (var i = 0; i < list.length; i++) {
    if (String(list[i] || "").toLowerCase().trim() === em) return true;
  }
  return false;
}

/** @deprecated 相容：改為「是否至少有一人被授權」 */
function isProxySubmitEnabled_() {
  return getProxySubmitEmails_().length > 0;
}

/** 寫入／更新系統設定鍵值（設定名稱為 key） */
function upsertSystemSetting_(key, value) {
  var k = String(key || "").trim();
  if (!k) return;
  saveRows("系統設定", [{ "設定名稱": k, "設定值": value == null ? "" : String(value) }], "設定名稱");
  bustSettingsMapCache_();
}

/** 申請單是否與讀者相關（含行政代送） */
function requestVisibleToReader_(req, readerEmail, readerIsAdmin) {
  if (readerIsAdmin) return true;
  var em = String(readerEmail || "").toLowerCase();
  if (!em || !req) return false;
  var a = String(req["申請人Email"] || req.requesterEmail || "").toLowerCase();
  var b = String(req["受邀人Email"] || req.targetTeacherEmail || "").toLowerCase();
  var p = String(req["代申請人Email"] || req.proxyByEmail || "").toLowerCase();
  if (a === em || b === em || (p && p === em)) return true;
  var note = String(req["備註"] || req.note || "");
  // 備註備援：舊資料無代申請人欄時
  if (note.indexOf("[行政代申請") >= 0 && p === em) return true;
  return false;
}

function sheetsReady_() {
  var ss = getSpreadsheet();
  var need = ["學期設定", "教師名單", "教師課表", "申請單", "系統設定", "空堂事件"];
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
    "教師名單": ["學期代號", "教師Email", "教師姓名", "授課科目", "系統角色", "基本鐘點", "折抵額度"],
    "教師課表": ["學期代號", "課表ID", "教師Email", "教師姓名", "星期", "節次", "班級", "科目", "課堂屬性", "調課限制"],
    "申請單": ["學期代號", "申請單ID", "單號", "批次ID", "狀態", "申請人Email", "申請人姓名", "受邀人Email", "受邀人姓名", "代申請人Email", "代申請人姓名", "班級", "科目", "異動日期", "異動星期", "異動節次", "異動類型", "對調目標日期", "對調目標星期", "對調目標節次", "經費來源", "請假事由", "是否已印", "備註", "建立時間", "更新時間"],
    "空堂事件": ["學期代號", "事件ID", "事件名稱", "起日", "迄日", "班級清單", "鐘點規則", "可進互代", "啟用", "備註"],
    // 額度帳本（單表）：流水即真相；包剩餘＝同包ID異動加總；教師名單「折抵額度」為快取
    // 索引鍵＝學期代號|教師Email（小寫），讀歷程可先 filter 再掃
    "額度帳本": ["學期代號", "流水ID", "時間", "教師Email", "教師姓名", "異動", "餘額後", "類型", "包ID", "事件ID", "事件名稱", "起日", "迄日", "申請單ID", "操作者", "備註", "索引鍵"],
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
        oldName === "空堂事件" ||
        oldName === "額度帳本" ||
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
  const sheets = ["學期設定","教師名單","教師課表","申請單","空堂事件","額度帳本","系統設定","系統日誌"];
  sheets.forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) { sheet = ss.insertSheet(name); }
    if (sheet.getLastRow() === 0) {
      const headers = getHeadersForSheet(name);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
    } else {
      try { getHeadersForSheet(name); } catch (eH) {}
    }
  });
}

/** 一列 values → 物件（與 getTableData 欄位規則一致） */
function rowArrayToObject_(sheetName, headers, row) {
  const obj = {};
  let hasValue = false;
  for (let j = 0; j < headers.length; j++) {
    let val = row[j];
    if (val instanceof Date) {
      val = toLocalDateStr(val);
    }
    if (sheetName === "申請單") {
      if (headers[j] === "狀態") {
        val = translateStatusToEn(val);
      } else if (headers[j] === "異動類型") {
        val = translateTypeToEn(val);
      }
    }
    if (sheetName === "空堂事件") {
      if (headers[j] === "班級清單" || headers[j] === "事件ID" || headers[j] === "事件名稱"
          || headers[j] === "鐘點規則" || headers[j] === "可進互代" || headers[j] === "啟用"
          || headers[j] === "備註" || headers[j] === "學期代號") {
        if (val !== "" && val !== null && val !== undefined) {
          val = String(val);
          if (headers[j] === "班級清單") {
            val = val.replace(/^'+/, "");
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
  return hasValue ? obj : null;
}

// 同一次 doPost／doGet 內表資料 mem 快取（避免系統設定／申請單重複整表讀）
var _tableDataMem_ = {}; // sheetName -> rows[]
function bustTableDataMem_(sheetName) {
  if (sheetName) {
    try { delete _tableDataMem_[sheetName]; } catch (e) { _tableDataMem_[sheetName] = undefined; }
    return;
  }
  _tableDataMem_ = {};
}

// 讀取工作表並轉換為物件陣列（二維陣列一次性讀取；請求內 mem）
function getTableData(sheetName) {
  var name = String(sheetName || "");
  if (name && _tableDataMem_[name]) return _tableDataMem_[name];
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    if (name) _tableDataMem_[name] = [];
    return [];
  }
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    if (name) _tableDataMem_[name] = [];
    return [];
  }
  const headers = values[0];
  const data = [];
  for (let i = 1; i < values.length; i++) {
    const obj = rowArrayToObject_(name, headers, values[i]);
    if (obj) data.push(obj);
  }
  if (name) _tableDataMem_[name] = data;
  return data;
}

/**
 * 只取出「進行中」申請（pending_teacher／pending_admin）
 * 仍需讀申請單表一次，但不組 historyAll 全量快取、payload 只含 pending
 */
function getPendingRequestsFromSheet_(semesterId) {
  var sid = String(semesterId || "");
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("申請單");
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  var headers = values[0];
  var statusCol = -1;
  var semCol = -1;
  var hi;
  for (hi = 0; hi < headers.length; hi++) {
    var h = String(headers[hi] || "").trim();
    if (h === "狀態") statusCol = hi;
    else if (h === "學期代號") semCol = hi;
  }
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row) continue;
    if (semCol >= 0 && sid && String(row[semCol] || "") !== sid) continue;
    var st = statusCol >= 0 ? String(row[statusCol] || "").toLowerCase().trim() : "";
    if (st !== "pending_teacher" && st !== "pending_admin") continue;
    var obj = rowArrayToObject_("申請單", headers, row);
    if (obj) out.push(obj);
  }
  return out;
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

  // merge 用既有列：小批量只讀目標列；大批量才全表（匯入熱路徑）
  const existingMap = {};
  const nSave = (rowsToSave || []).length;
  const keysNeed = [];
  const seenNeed = {};
  (rowsToSave || []).forEach(function (row) {
    if (!row || row[keyName] === undefined || row[keyName] === null || row[keyName] === "") return;
    var k0 = String(row[keyName]);
    if (keyToRow[k0] && !seenNeed[k0]) {
      seenNeed[k0] = 1;
      keysNeed.push(k0);
    }
  });
  if (nSave > 40) {
    // 大批：一次全表（比 N 次 getRange 省）
    getTableData(sheetName).forEach(function (row) {
      if (row[keyName] !== undefined && row[keyName] !== null && row[keyName] !== "") {
        existingMap[String(row[keyName])] = row;
      }
    });
  } else if (keysNeed.length) {
    // 小批：只讀要更新的列（核准／送出／同意熱路徑）
    var rowNums = keysNeed.map(function (k) { return keyToRow[k]; }).filter(Boolean);
    rowNums.sort(function (a, b) { return a - b; });
    var rStart = 0;
    while (rStart < rowNums.length) {
      var rEnd = rStart;
      while (rEnd + 1 < rowNums.length && rowNums[rEnd + 1] === rowNums[rEnd] + 1) rEnd++;
      var blockStart = rowNums[rStart];
      var blockLen = rEnd - rStart + 1;
      var blockVals = sheet.getRange(blockStart, 1, blockLen, headers.length).getValues();
      for (var bi = 0; bi < blockVals.length; bi++) {
        var objB = rowArrayToObject_(sheetName, headers, blockVals[bi]);
        if (!objB) continue;
        var bk = objB[keyName];
        if (bk !== undefined && bk !== null && bk !== "") existingMap[String(bk)] = objB;
      }
      rStart = rEnd + 1;
    }
  }

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
  // 寫入後清該表 mem（同請求後續讀取才會看到新資料）
  bustTableDataMem_(sheetName);
  if (sheetName === "系統設定") bustSettingsMapCache_();
  if (sheetName === "申請單") {
    // pending 快取另由 invalidateRequestCaches_ 清；此處只清表 mem
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
  bustTableDataMem_(sheetName);
  if (sheetName === "系統設定") bustSettingsMapCache_();
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
  bustTableDataMem_(sheetName);
  if (sheetName === "系統設定") bustSettingsMapCache_();
}

/**
 * 依 key 只讀一列（核准／同意／撤回熱路徑，避免全表 getTableData）
 * @returns {Object|null}
 */
function findRowByKey_(sheetName, keyName, keyValue) {
  var map = findRowsByKeys_(sheetName, keyName, [keyValue]);
  var k = String(keyValue == null ? "" : keyValue);
  return map[k] || null;
}

/**
 * 依 key 一次取多列；只掃 key 欄＋讀命中列
 * @returns {Object} keyString -> rowObject
 */
function findRowsByKeys_(sheetName, keyName, keyValues) {
  var out = {};
  var want = {};
  var nWant = 0;
  (keyValues || []).forEach(function (kv) {
    var k = String(kv == null ? "" : kv).replace(/_[12]$/, "");
    if (!k || want[k]) return;
    want[k] = 1;
    nWant++;
  });
  if (!nWant) return out;
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return out;
  var headers = getHeadersForSheet(sheetName);
  var keyCol = headers.indexOf(keyName) + 1;
  if (keyCol < 1) return out;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var num = lastRow - 1;
  var keyVals = sheet.getRange(2, keyCol, num, 1).getValues();
  var hitRows = [];
  for (var i = 0; i < keyVals.length; i++) {
    var k = String(keyVals[i][0] == null ? "" : keyVals[i][0]);
    if (want[k]) hitRows.push(i + 2);
  }
  if (!hitRows.length) return out;
  hitRows.sort(function (a, b) { return a - b; });
  var rStart = 0;
  while (rStart < hitRows.length) {
    var rEnd = rStart;
    while (rEnd + 1 < hitRows.length && hitRows[rEnd + 1] === hitRows[rEnd] + 1) rEnd++;
    var blockStart = hitRows[rStart];
    var blockLen = rEnd - rStart + 1;
    var blockVals = sheet.getRange(blockStart, 1, blockLen, headers.length).getValues();
    for (var bi = 0; bi < blockVals.length; bi++) {
      var obj = rowArrayToObject_(sheetName, headers, blockVals[bi]);
      if (!obj) continue;
      var bk = obj[keyName];
      if (bk !== undefined && bk !== null && bk !== "") out[String(bk)] = obj;
    }
    rStart = rEnd + 1;
  }
  return out;
}

/**
 * 依「批次ID」取列（respondToBatch）；只掃批次欄再讀命中列
 * @returns {Array}
 */
function findRowsByColumnValue_(sheetName, colName, colValue, extraFilter) {
  var out = [];
  var target = String(colValue == null ? "" : colValue);
  if (!target) return out;
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return out;
  var headers = getHeadersForSheet(sheetName);
  var col = headers.indexOf(colName) + 1;
  if (col < 1) return out;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var num = lastRow - 1;
  var colVals = sheet.getRange(2, col, num, 1).getValues();
  var hitRows = [];
  for (var i = 0; i < colVals.length; i++) {
    if (String(colVals[i][0] == null ? "" : colVals[i][0]) === target) hitRows.push(i + 2);
  }
  if (!hitRows.length) return out;
  hitRows.sort(function (a, b) { return a - b; });
  var rStart = 0;
  while (rStart < hitRows.length) {
    var rEnd = rStart;
    while (rEnd + 1 < hitRows.length && hitRows[rEnd + 1] === hitRows[rEnd] + 1) rEnd++;
    var blockStart = hitRows[rStart];
    var blockLen = rEnd - rStart + 1;
    var blockVals = sheet.getRange(blockStart, 1, blockLen, headers.length).getValues();
    for (var bi = 0; bi < blockVals.length; bi++) {
      var obj = rowArrayToObject_(sheetName, headers, blockVals[bi]);
      if (!obj) continue;
      if (typeof extraFilter === "function" && !extraFilter(obj)) continue;
      out.push(obj);
    }
    rStart = rEnd + 1;
  }
  return out;
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
      "系統角色": normalizeRole_(t["系統角色"] || t.role || "teacher"),
      "基本鐘點": t["基本鐘點"] != null && t["基本鐘點"] !== "" ? t["基本鐘點"] : (t.baseHours != null ? t.baseHours : 16),
      "折抵額度": t["折抵額度"] != null && t["折抵額度"] !== "" ? t["折抵額度"] : (t.mutualQuota != null ? t.mutualQuota : 0)
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

/** 分層讀取：空堂事件（中 TTL） */
function getSemesterClassAwayCached_(semesterId) {
  var key = "jcjh_away_" + String(semesterId || "");
  var raw = getCacheChunked(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  var rows = getTableData("空堂事件").filter(function (ev) {
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

/** 星期數字 → 中文（1=一…7=日；0 亦當日） */
function quotaDowZh_(dow) {
  var n = parseInt(dow, 10);
  if (isNaN(n) || n < 0) n = 0;
  var map = { 0: "日", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };
  return map[n] || "";
}

/** 日期 → M/D（例 10/13） */
function quotaMdLabel_(dateStr) {
  var s = String(dateStr || "").trim().slice(0, 10);
  if (!s) return "";
  var p = s.split(/[-/]/);
  if (p.length < 3) return s;
  var m = parseInt(p[1], 10);
  var d = parseInt(p[2], 10);
  if (isNaN(m) || isNaN(d)) return s;
  return m + "/" + d;
}

/**
 * 扣額度帳本：事件名稱＋備註
 * 1) 活動互代：事件名＝空堂事件（包上／備註帶入）；備註＝10/13四王小明（代誰）
 * 2) 空堂排班：事件名＝空堂任務；備註＝10/13四（不加人名）
 * 3) 其他代課：事件名＝代課；備註＝10/13四請假老師
 * @returns {{ eventId: string, eventName: string, note: string, kind: string }}
 */
function buildQuotaSpendMeta_(req, pack) {
  req = req || {};
  pack = pack || {};
  var reason = String(req["請假事由"] || req.reason || "").trim();
  var noteRaw = String(req["備註"] || req.note || "").trim();
  var fee = String(req["經費來源"] || req.subFee || "").trim();
  var leaveName = String(req["申請人姓名"] || req.requesterName || "").trim();
  var leaveEm = String(req["申請人Email"] || req.requesterEmail || "").toLowerCase().trim();
  var subEm = String(req["受邀人Email"] || req.targetTeacherEmail || "").toLowerCase().trim();
  var dateStr = String(req["異動日期"] || req.requestDate || req.date || "").slice(0, 10);
  var dow = req["異動星期"] != null ? req["異動星期"] : req.requestPeriodDay;
  if ((dow == null || dow === "") && dateStr) {
    try {
      var dt = new Date(dateStr.replace(/-/g, "/") + " 00:00:00");
      if (!isNaN(dt.getTime())) {
        var w = dt.getDay(); // 0日
        dow = w === 0 ? 7 : w;
      }
    } catch (eD) {}
  }
  var md = quotaMdLabel_(dateStr);
  var zh = quotaDowZh_(dow);
  var when = md + zh; // 10/13四

  var isEmptyAssign = reason === "空堂排班"
    || noteRaw.indexOf("[空堂排班]") >= 0
    || req.isEmptySlotAssign === true
    || (leaveEm && subEm && leaveEm === subEm && noteRaw.indexOf("空堂") >= 0);

  // 活動互代：優先帳本包上的空堂事件名（發放時寫入）；備註「畢旅 起日～」可備援
  var packEventName = String(pack.eventName || "").trim();
  var packEventId = String(pack.eventId || "").trim();
  var reservedNames = { "代課": 1, "加課": 1, "空堂任務": 1, "手動調整": 1, "申請扣額度": 1 };
  var activityName = "";
  if (packEventName && !reservedNames[packEventName]) {
    activityName = packEventName;
  } else {
    var noteClean = noteRaw
      .replace(/\[直接核准\]/g, "")
      .replace(/\[空堂排班\]/g, "")
      .replace(/\[行政代申請[^\]]*\]/g, "")
      .trim();
    // 活動互代統一備註常以事件名開頭（如「畢旅 2026-07-15～…」）
    if (noteClean && (reason === "公假" || fee === "活動公費" || noteClean.indexOf("～") >= 0 || noteClean.indexOf("~") >= 0)) {
      var firstTok = noteClean.split(/\s+/)[0] || "";
      if (firstTok && !reservedNames[firstTok] && firstTok.indexOf("行政") < 0 && !/^\d/.test(firstTok)) {
        activityName = firstTok;
      }
    }
  }

  var eventId = packEventId;
  var eventName = "";
  var note = "";
  var kind = "sub";

  if (isEmptyAssign) {
    kind = "add";
    eventName = "空堂任務";
    if (!eventId) eventId = "evt_empty_slot";
    note = when || "空堂任務";
  } else if (activityName) {
    kind = "activity";
    eventName = activityName;
    // 代誰：請假／帶隊老師姓名
    note = when + (leaveName || "");
  } else {
    kind = "sub";
    eventName = "代課";
    if (!eventId) eventId = "evt_sub";
    note = when + (leaveName || "");
  }

  if (!note) note = eventName || "扣額度";
  return {
    eventId: eventId || "",
    eventName: eventName || "代課",
    note: note,
    kind: kind
  };
}

/** 已作廢狀態：不應再還額度（防重複操作） */
function isTerminalQuotaStatus_(status) {
  var s = String(status || "").toLowerCase().trim();
  return s === "cancelled" || s === "rejected" || s === "admin_rejected" || s === "withdrawn"
    || s === "已取消" || s === "受邀人已拒絕" || s === "行政駁回" || s === "已撤回";
}

/** 帳本用時間字串 */
function quotaNowStr_() {
  try { return toLocalTimeStr(new Date()); } catch (e) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
  }
}

var QUOTA_LEDGER_SHEET_ = "額度帳本";

function ensureQuotaSheets_() {
  // 只確保帳本表存在，勿每次 initSheets／搬舊表（極慢）
  try {
    var ss = getSpreadsheet();
    var sh = ss.getSheetByName(QUOTA_LEDGER_SHEET_);
    if (!sh) {
      sh = ss.insertSheet(QUOTA_LEDGER_SHEET_);
      var headers = getHeadersForSheet(QUOTA_LEDGER_SHEET_);
      sh.appendRow(headers);
      sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
    } else if (sh.getLastRow() === 0) {
      var headers2 = getHeadersForSheet(QUOTA_LEDGER_SHEET_);
      sh.appendRow(headers2);
      sh.getRange(1, 1, 1, headers2.length).setFontWeight("bold").setBackground("#f1f5f9");
    } else {
      try { getHeadersForSheet(QUOTA_LEDGER_SHEET_); } catch (eH) {}
    }
  } catch (e) {
    try { initSheets(); } catch (e2) {}
  }
}

/** 讀帳本列（單表）；請求內 mem + ScriptCache，避免每次開歷程整表重讀 */
var _quotaLedgerMem_ = { key: "", rows: null, ts: 0 };
/** 本請求是否已 backfill（寫入路徑才寫表） */
var _quotaIndexBackfillDone_ = false;
var CACHE_TTL_QLEDGER_ = 180; // 學期帳本列快取（寫入會 bust）
function quotaLedgerCacheKey_(semesterId) {
  return "jcjh_qled_all_" + String(semesterId || "");
}
function getQuotaLedgerRows_(semesterId) {
  var sid = String(semesterId || "");
  var now = Date.now();
  if (_quotaLedgerMem_.key === sid && _quotaLedgerMem_.rows && (now - _quotaLedgerMem_.ts) < 15000) {
    return _quotaLedgerMem_.rows;
  }
  // ScriptCache：跨請求共用，開歷程不必每次 getDataRange
  if (sid) {
    try {
      var cached = getCacheChunked(quotaLedgerCacheKey_(sid));
      if (cached) {
        var parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed)) {
          _quotaLedgerMem_ = { key: sid, rows: parsed, ts: now };
          return parsed;
        }
      }
    } catch (eQc) { /* ignore */ }
  }
  // 不呼叫 ensureQuotaSheets_（getTableData 找不到表會回 []）
  var all = getTableData(QUOTA_LEDGER_SHEET_) || [];
  var rows = all.filter(function (r) {
    if (!sid) return true;
    var ik = String(r["索引鍵"] || "");
    if (ik) return ik.indexOf(sid + "|") === 0;
    return String(r["學期代號"] || "") === sid;
  });
  _quotaLedgerMem_ = { key: sid, rows: rows, ts: now };
  if (sid) {
    try {
      putCacheChunked(quotaLedgerCacheKey_(sid), JSON.stringify(rows), CACHE_TTL_QLEDGER_);
    } catch (eQp) { /* 過大則略過快取，仍回 rows */ }
  }
  return rows;
}

/**
 * 舊帳本列補「索引鍵」＝學期|email（小寫）。
 * 僅在寫入鎖內呼叫（earn／spend／adjust）；讀路徑不寫表。
 */
function backfillQuotaLedgerIndexKeys_() {
  if (_quotaIndexBackfillDone_) return 0;
  _quotaIndexBackfillDone_ = true;
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(QUOTA_LEDGER_SHEET_);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var headers = getHeadersForSheet(QUOTA_LEDGER_SHEET_);
  var idxCol = headers.indexOf("索引鍵") + 1;
  var sidCol = headers.indexOf("學期代號") + 1;
  var emCol = headers.indexOf("教師Email") + 1;
  if (idxCol < 1 || sidCol < 1 || emCol < 1) return 0;
  var last = sheet.getLastRow();
  var n = last - 1;
  if (n < 1) return 0;
  var idxVals = sheet.getRange(2, idxCol, n, 1).getValues();
  var sidVals = sheet.getRange(2, sidCol, n, 1).getValues();
  var emVals = sheet.getRange(2, emCol, n, 1).getValues();
  var changed = 0;
  for (var i = 0; i < n; i++) {
    var cur = String(idxVals[i][0] || "").trim();
    if (cur) continue;
    var sid = String(sidVals[i][0] || "").trim();
    var em = String(emVals[i][0] || "").toLowerCase().trim();
    if (!sid || !em) continue;
    idxVals[i][0] = makeQuotaLedgerIndexKey_(sid, em);
    changed++;
  }
  if (changed > 0) {
    sheet.getRange(2, idxCol, n, 1).setValues(idxVals);
    bustQuotaLedgerMem_();
  }
  return changed;
}
function bustQuotaLedgerMem_() {
  _quotaLedgerMem_ = { key: "", rows: null, ts: 0 };
}
function bustQuotaLedgerScriptCache_(semesterId) {
  var sid = String(semesterId || "");
  if (!sid) return;
  try { removeCacheChunked(quotaLedgerCacheKey_(sid)); } catch (eB) {}
}
/**
 * 額度寫入後：清教師快取＋歷程快取（不必清課表）
 * emails：可選，受影響教師 email 陣列；有則精準清 jcjh_qled_sid_email_limit
 */
function invalidateQuotaCaches_(semesterId, emails) {
  var sid = String(semesterId || "");
  removeCacheChunked("jcjh_teachers_" + sid);
  removeCacheChunked("jcjh_meta_" + sid);
  bustQuotaLedgerMem_();
  bustQuotaLedgerScriptCache_(sid);
  try {
    var cache = CacheService.getScriptCache();
    cache.remove("jcjh_qled_" + sid);
    var list = Array.isArray(emails) ? emails : [];
    var seen = {};
    var limits = [40, 50, 80, 200];
    list.forEach(function (raw) {
      var em = String(raw || "").toLowerCase().trim();
      if (!em || seen[em]) return;
      seen[em] = 1;
      limits.forEach(function (lim) {
        try { cache.remove("jcjh_qled_" + sid + "_" + em + "_" + lim); } catch (e1) {}
      });
    });
  } catch (e) {}
}

/** 額度包 ID：學期＋事件＋完整 email（小寫），勿截斷以免碰撞誤判已發放 */
function makeQuotaPackId_(semesterId, eventId, email) {
  var sid = String(semesterId || "").trim();
  var eid = String(eventId || "").trim().replace(/[^\w.\-@\u4e00-\u9fff]/g, "_");
  var em = String(email || "").toLowerCase().trim();
  return "pkg_" + sid + "_" + eid + "_" + em;
}

/**
 * 批次發放（一次讀帳本／教師、一次寫入）
 * 已發放判斷：同「學期＋事件ID＋教師Email」且類型=earn 才略過（勿用 packId 截斷／d>0 誤判）
 */
function batchEarnMutualQuota_(semesterId, earnList, meta) {
  meta = meta || {};
  ensureQuotaSheets_();
  var sid = String(semesterId || "");
  var eventId = String(meta.eventId || "").trim();
  var eventName = String(meta.eventName || "").trim();
  var startDate = String(meta.startDate || "").slice(0, 10);
  var endDate = String(meta.endDate || "").slice(0, 10);
  var forceAdd = meta.forceAdd === true;
  var operator = meta.operator || "";
  var noteBase = meta.note || ("發放：" + eventName);
  if (!eventId) {
    eventId = "act_" + startDate + "_" + endDate + "_" + String(meta.awayKey || "manual");
  }

  // 寫入路徑：先補舊列索引鍵（每請求一次）
  try { backfillQuotaLedgerIndexKeys_(); } catch (eBfE) {}

  // 一次讀帳本（本學期）：教師總餘額 + 本事件已 earn 的教師
  var allLedger = getQuotaLedgerRows_(sid);
  var teacherBal = {}; // email -> sum delta（本學期）
  var earnedKey = {}; // email -> true（僅類型 earn）
  allLedger.forEach(function (r) {
    var em = String(r["教師Email"] || "").toLowerCase().trim();
    if (!em) return;
    var d = parseFloat(r["異動"]);
    if (isNaN(d)) d = 0;
    teacherBal[em] = Math.round(((teacherBal[em] || 0) + d) * 1000) / 1000;
    var typ = String(r["類型"] || "").trim().toLowerCase();
    var rid = String(r["事件ID"] || "").trim();
    // 只認明確的 earn；事件ID 必須相符
    if (typ === "earn" && rid && rid === eventId) {
      earnedKey[em] = true;
    }
  });

  // 一次讀教師（快取；僅本學期）
  var teachersAll = getSemesterTeachersCached_(sid) || [];
  var tMap = {};
  var sheetQuota = {};
  teachersAll.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (!em) return;
    tMap[em] = t;
    var q = parseFloat(t["折抵額度"] != null ? t["折抵額度"] : t.mutualQuota);
    if (isNaN(q) || q < 0) q = 0;
    sheetQuota[em] = Math.round(q * 1000) / 1000;
  });

  var ledgerRows = [];
  var results = [];
  var earned = 0;
  var skipped = 0;
  var now = quotaNowStr_();
  var seq = 0;
  var finalBal = {};

  (earnList || []).forEach(function (item) {
    var em = String(item.email || "").toLowerCase().trim();
    // 釋出額度可為 0.5 倍數（前端已 ×0.5）
    var released = parseFloat(item.released != null ? item.released : item.earn);
    if (isNaN(released) || released <= 0) return;
    released = Math.round(released * 1000) / 1000;
    var packId = makeQuotaPackId_(sid, eventId, em);
    var hadEarn = !!earnedKey[em];
    if (hadEarn && !forceAdd) {
      skipped++;
      results.push({
        email: em,
        packageId: packId,
        skipped: true,
        reason: "already_earned",
        remaining: released,
        balance: Math.max(0, teacherBal[em] != null ? teacherBal[em] : (sheetQuota[em] || 0))
      });
      return;
    }
    // 餘額：帳本加總優先；若帳本完全沒有此師紀錄，用名單現值
    var prevBal = teacherBal[em];
    if (prevBal == null || isNaN(prevBal)) {
      prevBal = sheetQuota[em] != null ? sheetQuota[em] : 0;
    }
    if (prevBal < 0) prevBal = 0;
    var nextBal = prevBal + released;
    teacherBal[em] = nextBal;
    finalBal[em] = nextBal;
    earnedKey[em] = true;
    seq++;
    var lid = "ql_" + Date.now() + "_" + seq + "_" + Math.random().toString(36).substr(2, 5);
    var tRow = tMap[em];
    var tName = item.name || (tRow && tRow["教師姓名"]) || "";
    ledgerRows.push({
      "學期代號": sid,
      "流水ID": lid,
      "時間": now,
      "教師Email": em,
      "教師姓名": tName,
      "異動": released,
      "餘額後": nextBal,
      "類型": "earn",
      "包ID": packId,
      "事件ID": eventId,
      "事件名稱": eventName,
      "起日": startDate,
      "迄日": endDate,
      "申請單ID": "",
      "操作者": operator,
      "備註": noteBase
    });
    earned++;
    results.push({
      email: em,
      packageId: packId,
      skipped: false,
      reason: "",
      remaining: released,
      balance: nextBal
    });
  });

  if (ledgerRows.length) {
    appendQuotaLedgerRowsFast_(ledgerRows);
    bustQuotaLedgerMem_();
  }
  if (Object.keys(finalBal).length) {
    patchTeacherMutualQuotaColumn_(sid, finalBal);
  }
  invalidateQuotaCaches_(sid, Object.keys(finalBal));
  return {
    earned: earned,
    skipped: skipped,
    results: results,
    eventId: eventId,
    eventName: eventName,
    wroteLedger: ledgerRows.length,
    wroteTeachers: Object.keys(finalBal).length
  };
}

/** 帳本索引鍵：學期|email（小寫），讀歷程／filter 用 */
function makeQuotaLedgerIndexKey_(semesterId, email) {
  return String(semesterId || "").trim() + "|" + String(email || "").toLowerCase().trim();
}

/** 帳本新列：直接 append，不做 key 掃描 */
function appendQuotaLedgerRowsFast_(rows) {
  if (!rows || !rows.length) return;
  ensureQuotaSheets_();
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(QUOTA_LEDGER_SHEET_);
  if (!sheet) throw new Error("找不到工作表「" + QUOTA_LEDGER_SHEET_ + "」，請先建立分頁。");
  var headers = getHeadersForSheet(QUOTA_LEDGER_SHEET_);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
  }
  // 自動補索引鍵（舊列無此欄時 getHeaders 會補欄）
  rows.forEach(function (row) {
    if (!row) return;
    if (!row["索引鍵"]) {
      row["索引鍵"] = makeQuotaLedgerIndexKey_(row["學期代號"], row["教師Email"]);
    }
  });
  var arrs = rows.map(function (row) {
    return buildRowArray_(QUOTA_LEDGER_SHEET_, headers, row);
  });
  var start = sheet.getLastRow() + 1;
  var CHUNK = 200;
  for (var i = 0; i < arrs.length; i += CHUNK) {
    var block = arrs.slice(i, i + CHUNK);
    // setValues(row, col, numRows, numCols) — 第三參數是列數
    sheet.getRange(start + i, 1, block.length, headers.length).setValues(block);
  }
  // 寫入後同步記憶體快取（同請求後續 spend 可讀到新列）；並 bust ScriptCache
  var sidTouched = {};
  if (_quotaLedgerMem_ && _quotaLedgerMem_.rows && _quotaLedgerMem_.key) {
    var sidM = _quotaLedgerMem_.key;
    rows.forEach(function (r) {
      if (String(r["學期代號"] || "") === sidM) _quotaLedgerMem_.rows.push(r);
      var s = String(r["學期代號"] || "");
      if (s) sidTouched[s] = 1;
    });
    _quotaLedgerMem_.ts = Date.now();
  } else {
    rows.forEach(function (r) {
      var s = String(r["學期代號"] || "");
      if (s) sidTouched[s] = 1;
    });
  }
  Object.keys(sidTouched).forEach(function (s) {
    bustQuotaLedgerScriptCache_(s);
  });
}

/**
 * 只更新教師名單「折抵額度」欄（本學期列），一次讀 key＋一欄寫回
 * @param {string} semesterId
 * @param {Object} balByEmail email(lower) -> number
 */
function patchTeacherMutualQuotaColumn_(semesterId, balByEmail) {
  balByEmail = balByEmail || {};
  var emails = Object.keys(balByEmail);
  if (!emails.length) return;
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("教師名單");
  if (!sheet) throw new Error("找不到工作表「教師名單」");
  var headers = getHeadersForSheet("教師名單");
  var emailCol = headers.indexOf("教師Email") + 1;
   var quotaCol = headers.indexOf("折抵額度") + 1;
  var semCol = headers.indexOf("學期代號") + 1;
  if (emailCol < 1 || quotaCol < 1) {
    // 後備
    var list = [];
    emails.forEach(function (em) {
      list.push({ "教師Email": em, "折抵額度": balByEmail[em], "學期代號": semesterId });
    });
    saveRows("教師名單", list, "教師Email");
    return;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var num = lastRow - 1;
  var emailVals = sheet.getRange(2, emailCol, num, 1).getValues();
  var semVals = semCol > 0 ? sheet.getRange(2, semCol, num, 1).getValues() : null;
  var quotaVals = sheet.getRange(2, quotaCol, num, 1).getValues();
  var sid = String(semesterId || "");
  var want = {};
  emails.forEach(function (em) { want[String(em).toLowerCase().trim()] = balByEmail[em]; });
  var changed = false;
  for (var r = 0; r < emailVals.length; r++) {
    var em = String(emailVals[r][0] || "").toLowerCase().trim();
    if (!em || want[em] === undefined) continue;
    if (semVals && String(semVals[r][0] || "") !== sid) continue;
    var q = parseFloat(want[em]);
    if (isNaN(q) || q < 0) q = 0;
    q = Math.round(q * 1000) / 1000;
    var curQ = parseFloat(quotaVals[r][0]);
    if (isNaN(curQ)) curQ = 0;
    curQ = Math.round(curQ * 1000) / 1000;
    if (curQ !== q) {
      quotaVals[r][0] = q;
      changed = true;
    }
  }
  if (changed) {
    sheet.getRange(2, quotaCol, num, 1).setValues(quotaVals);
  }
}


/**
 * 寫一筆帳本（單表）— 走快速 append，勿 saveRows 全表掃
 */
function appendQuotaLedger_(o) {
  o = o || {};
  var sid = String(o.semesterId || "");
  var em = String(o.email || "").toLowerCase().trim();
  if (!sid || !em) return null;
  var delta = parseInt(o.delta, 10);
  if (isNaN(delta) || delta === 0) return null;
  var bal = parseInt(o.balanceAfter, 10);
  if (isNaN(bal) || bal < 0) bal = Math.max(0, sumTeacherLedgerBalance_(sid, em) + delta);
  var row = {
    "學期代號": sid,
    "流水ID": o.ledgerId || ("ql_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6)),
    "時間": o.time || quotaNowStr_(),
    "教師Email": em,
    "教師姓名": o.name || "",
    "異動": delta,
    "餘額後": bal,
    "類型": o.type || "adjust",
    "包ID": o.packageId || "",
    "事件ID": o.eventId || "",
    "事件名稱": o.eventName || "",
    "起日": o.startDate || "",
    "迄日": o.endDate || "",
    "申請單ID": o.requestId || "",
    "操作者": o.operator || "",
    "備註": o.note || ""
  };
  try {
    appendQuotaLedgerRowsFast_([row]);
    bustQuotaLedgerMem_();
    return row;
  } catch (e) {
    logError_("appendQuotaLedger_", e);
    return null;
  }
}

/** 教師帳本餘額＝該學期全部異動加總（用快取列，勿每次重讀表） */
function sumTeacherLedgerBalance_(semesterId, email) {
  var em = String(email || "").toLowerCase().trim();
  var sid = String(semesterId || "");
  if (!em || !sid) return 0;
  var sum = 0;
  getQuotaLedgerRows_(sid).forEach(function (r) {
    if (String(r["教師Email"] || "").toLowerCase().trim() !== em) return;
    var d = parseFloat(r["異動"]);
    if (!isNaN(d)) sum += d;
  });
  return Math.max(0, Math.round(sum * 1000) / 1000);
}

/**
 * 依帳本加總各包剩餘（同包ID異動加總）
 * @returns {Array<{packageId,eventId,eventName,startDate,endDate,email,name,earned,used,remaining,firstTime}>}
 */
function buildPackagesFromLedger_(semesterId, emailFilter) {
  var sid = String(semesterId || "");
  var emFilter = emailFilter ? String(emailFilter).toLowerCase().trim() : "";
  var byPack = {};
  getQuotaLedgerRows_(sid).forEach(function (r) {
    var em = String(r["教師Email"] || "").toLowerCase().trim();
    if (emFilter && em !== emFilter) return;
    var packId = String(r["包ID"] || "").trim();
    if (!packId) packId = "nopack_" + em;
    if (!byPack[packId]) {
      byPack[packId] = {
        packageId: packId,
        eventId: "",
        eventName: "",
        startDate: "",
        endDate: "",
        email: em,
        name: r["教師姓名"] || "",
        earned: 0,
        used: 0,
        remaining: 0,
        firstTime: r["時間"] || ""
      };
    }
    var p = byPack[packId];
    var d = parseFloat(r["異動"]);
    if (isNaN(d)) d = 0;
    d = Math.round(d * 1000) / 1000;
    p.remaining = Math.round((p.remaining + d) * 1000) / 1000;
    if (d > 0) p.earned = Math.round((p.earned + d) * 1000) / 1000;
    if (d < 0) p.used = Math.round((p.used + (-d)) * 1000) / 1000;
    if (r["事件ID"] && !p.eventId) p.eventId = r["事件ID"];
    if (r["事件名稱"] && !p.eventName) p.eventName = r["事件名稱"];
    if (r["起日"] && !p.startDate) p.startDate = r["起日"];
    if (r["迄日"] && !p.endDate) p.endDate = r["迄日"];
    if (r["教師姓名"]) p.name = r["教師姓名"];
    var t = String(r["時間"] || "");
    if (t && (!p.firstTime || t < p.firstTime)) p.firstTime = t;
  });
  return Object.keys(byPack).map(function (k) {
    var p = byPack[k];
    p.remaining = Math.max(0, p.remaining);
    return p;
  });
}

/** 寫回教師名單折抵額度快取（單人 → 走欄位批次） */
function writeTeacherQuotaCache_(semesterId, email, balance, name) {
  var em = String(email || "").toLowerCase().trim();
  var sid = String(semesterId || "");
  if (!em || !sid) return;
  var bal = Math.max(0, parseInt(balance, 10) || 0);
  var map = {};
  map[em] = bal;
  patchTeacherMutualQuotaColumn_(sid, map);
}

/**
 * 寫帳本一筆後同步教師餘額快取
 */
function postLedgerAndSync_(o) {
  o = o || {};
  var sid = String(o.semesterId || "");
  var em = String(o.email || "").toLowerCase().trim();
  var delta = parseInt(o.delta, 10) || 0;
  if (!sid || !em || !delta) return sumTeacherLedgerBalance_(sid, em);
  var balBefore = sumTeacherLedgerBalance_(sid, em);
  var balAfter = Math.max(0, balBefore + delta);
  o.balanceAfter = balAfter;
  appendQuotaLedger_(o);
  writeTeacherQuotaCache_(sid, em, balAfter, o.name);
  return balAfter;
}

/**
 * 一次讀帳本，建 email → 包餘額（FIFO 用）
 */
function buildTeacherPackStateFromLedger_(semesterId) {
  var sid = String(semesterId || "");
  var byEmail = {}; // em -> { bal, packs: [{packageId, eventId, eventName, remaining, firstTime, name}] }
  getQuotaLedgerRows_(sid).forEach(function (r) {
    var em = String(r["教師Email"] || "").toLowerCase().trim();
    if (!em) return;
    if (!byEmail[em]) byEmail[em] = { bal: 0, packs: {}, name: "" };
    var st = byEmail[em];
    var d = parseFloat(r["異動"]);
    if (isNaN(d)) d = 0;
    d = Math.round(d * 1000) / 1000;
    st.bal = Math.round((st.bal + d) * 1000) / 1000;
    if (r["教師姓名"]) st.name = r["教師姓名"];
    var pid = String(r["包ID"] || "").trim() || ("nopack_" + em);
    if (!st.packs[pid]) {
      st.packs[pid] = {
        packageId: pid,
        eventId: "",
        eventName: "",
        remaining: 0,
        firstTime: r["時間"] || "",
        name: r["教師姓名"] || ""
      };
    }
    var p = st.packs[pid];
    p.remaining += d;
    if (r["事件ID"] && !p.eventId) p.eventId = r["事件ID"];
    if (r["事件名稱"] && !p.eventName) p.eventName = r["事件名稱"];
    var t = String(r["時間"] || "");
    if (t && (!p.firstTime || t < p.firstTime)) p.firstTime = t;
  });
  Object.keys(byEmail).forEach(function (em) {
    var st = byEmail[em];
    st.bal = Math.max(0, Math.round(st.bal * 1000) / 1000);
    var list = [];
    Object.keys(st.packs).forEach(function (pid) {
      var p = st.packs[pid];
      p.remaining = Math.max(0, Math.round((p.remaining || 0) * 1000) / 1000);
      if (p.remaining > 0) list.push(p);
    });
    list.sort(function (a, b) {
      return String(a.firstTime || "").localeCompare(String(b.firstTime || ""));
    });
    st.packList = list;
  });
  return byEmail;
}

/**
 * 批次扣額度：一次讀帳本、一次 append、一次改教師欄（送出申請熱路徑）
 * 逐筆申請寫 spend：事件名／備註依活動互代、代課、空堂任務區分
 */
function spendMutualQuotaForRequests_(reqs, operatorEmail) {
  var list = Array.isArray(reqs) ? reqs : (reqs ? [reqs] : []);
  if (!list.length) return { spentTeachers: 0, shortList: [] };
  try { backfillQuotaLedgerIndexKeys_(); } catch (eBfS) {}

  // 只留扣額度申請；維持傳入順序
  var spendReqs = [];
  var sid = "";
  list.forEach(function (r) {
    if (!r || !isQuotaDeductFee_(r["經費來源"])) return;
    var em = String(r["受邀人Email"] || "").toLowerCase().trim();
    if (!em) return;
    if (!sid) sid = String(r["學期代號"] || "");
    spendReqs.push(r);
  });
  if (!spendReqs.length) return { spentTeachers: 0, shortList: [] };
  if (!sid) sid = String((list[0] && list[0]["學期代號"]) || "");

  var state = buildTeacherPackStateFromLedger_(sid);
  var teachersAll = getSemesterTeachersCached_(sid) || [];
  var sheetQ = {};
  teachersAll.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (!em) return;
    var sq = parseFloat(t["折抵額度"] != null ? t["折抵額度"] : t.mutualQuota);
    if (isNaN(sq) || sq < 0) sq = 0;
    sq = Math.round(sq * 1000) / 1000;
    sheetQ[em] = sq;
    if (!state[em]) state[em] = { bal: sq, packList: [], name: t["教師姓名"] || t.name || "" };
    else if (!state[em].name && (t["教師姓名"] || t.name)) state[em].name = t["教師姓名"] || t.name;
  });

  // 執行期餘額／包列表（同批多筆共用）
  var runBal = {};
  var runPacks = {};
  Object.keys(state).forEach(function (em) {
    var st = state[em];
    var b = typeof st.bal === "number" ? st.bal : (sheetQ[em] || 0);
    if (isNaN(b) || b < 0) b = 0;
    runBal[em] = Math.round(b * 1000) / 1000;
    runPacks[em] = (st.packList || []).map(function (p) {
      return {
        packageId: p.packageId,
        eventId: p.eventId || "",
        eventName: p.eventName || "",
        remaining: p.remaining || 0
      };
    });
  });

  var ledgerRows = [];
  var finalBal = {};
  var shortList = [];
  var shortMap = {};
  var now = quotaNowStr_();
  var seq = 0;
  var touched = {};

  spendReqs.forEach(function (req) {
    var em = String(req["受邀人Email"] || "").toLowerCase().trim();
    if (!em) return;
    if (runBal[em] == null) {
      runBal[em] = sheetQ[em] || 0;
      runPacks[em] = [];
    }
    var bal = runBal[em];
    var packs = runPacks[em] || [];
    var subName = String(req["受邀人姓名"] || "").trim()
      || (state[em] && state[em].name) || "";
    var reqId = String(req["申請單ID"] || req.id || "").trim();

    // 選 FIFO 包（有餘額 ≥1 優先；否則總餘額）
    var pack = null;
    var pi;
    for (pi = 0; pi < packs.length; pi++) {
      if (Math.floor(packs[pi].remaining || 0) >= 1) {
        pack = packs[pi];
        break;
      }
    }
    // 須餘額 ≥ 1 才扣
    if (bal + 1e-9 < 1) {
      if (!shortMap[em]) {
        shortMap[em] = { email: em, name: subName, short: 0, spent: 0 };
        shortList.push(shortMap[em]);
      }
      shortMap[em].short += 1;
      return;
    }

    var meta = buildQuotaSpendMeta_(req, pack || {});
    bal = Math.round(Math.max(0, bal - 1) * 1000) / 1000;
    runBal[em] = bal;
    finalBal[em] = bal;
    touched[em] = true;
    if (pack) {
      pack.remaining = Math.round(Math.max(0, (pack.remaining || 0) - 1) * 1000) / 1000;
    }
    if (shortMap[em]) shortMap[em].spent += 1;

    seq++;
    ledgerRows.push({
      "學期代號": sid,
      "流水ID": "ql_" + Date.now() + "_" + seq + "_" + Math.random().toString(36).substr(2, 4),
      "時間": now,
      "教師Email": em,
      "教師姓名": subName,
      "異動": -1,
      "餘額後": bal,
      "類型": "spend",
      "包ID": (pack && pack.packageId) || ("pkg_balance_" + em),
      "事件ID": meta.eventId || (pack && pack.eventId) || "",
      "事件名稱": meta.eventName,
      "起日": String(req["異動日期"] || req.requestDate || "").slice(0, 10),
      "迄日": "",
      "申請單ID": reqId,
      "操作者": operatorEmail || "",
      "備註": meta.note
    });
  });

  if (ledgerRows.length) {
    appendQuotaLedgerRowsFast_(ledgerRows);
    bustQuotaLedgerMem_();
  }
  if (Object.keys(finalBal).length) {
    patchTeacherMutualQuotaColumn_(sid, finalBal);
  }
  var emails = Object.keys(touched);
  invalidateQuotaCaches_(sid, emails);
  return { spentTeachers: emails.length, shortList: shortList, wrote: ledgerRows.length };
}

/**
 * 申請作廢批次還額：一次讀、一次寫
 */
function restoreMutualQuotaForRequests_(reqs) {
  var list = Array.isArray(reqs) ? reqs : (reqs ? [reqs] : []);
  if (!list.length) return 0;
  try { backfillQuotaLedgerIndexKeys_(); } catch (eBfR) {}
  var addMap = {};
  var metaMap = {};
  var sid = "";
  list.forEach(function (r) {
    if (!r) return;
    var st = r._prevStatus != null ? r._prevStatus : r["狀態"];
    if (isTerminalQuotaStatus_(st)) return;
    if (!isQuotaDeductFee_(r["經費來源"])) return;
    var em = String(r["受邀人Email"] || "").toLowerCase().trim();
    if (!em) return;
    if (!sid) sid = String(r["學期代號"] || "");
    addMap[em] = (addMap[em] || 0) + 1;
    if (!metaMap[em]) {
      metaMap[em] = {
        name: r["受邀人姓名"] || "",
        requestId: r["申請單ID"] || ""
      };
    }
  });
  var emails = Object.keys(addMap);
  if (!emails.length) return 0;
  if (!sid) sid = String((list[0] && list[0]["學期代號"]) || "");

  var state = buildTeacherPackStateFromLedger_(sid);
  var teachersAll = getSemesterTeachersCached_(sid) || [];
  var sheetQ = {};
  teachersAll.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (!em) return;
    var sqR = parseFloat(t["折抵額度"] != null ? t["折抵額度"] : t.mutualQuota);
    if (isNaN(sqR) || sqR < 0) sqR = 0;
    sheetQ[em] = Math.round(sqR * 1000) / 1000;
  });

  // 最近 spend 包
  var lastSpendPack = {};
  getQuotaLedgerRows_(sid).forEach(function (r) {
    if (String(r["類型"] || "").toLowerCase() !== "spend") return;
    var em = String(r["教師Email"] || "").toLowerCase().trim();
    if (!em) return;
    var t = String(r["時間"] || "");
    if (!lastSpendPack[em] || t > lastSpendPack[em].time) {
      lastSpendPack[em] = {
        time: t,
        packageId: r["包ID"] || "",
        eventId: r["事件ID"] || "",
        eventName: r["事件名稱"] || ""
      };
    }
  });

  var ledgerRows = [];
  var finalBal = {};
  var now = quotaNowStr_();
  var seq = 0;
  emails.forEach(function (em) {
    var need = addMap[em];
    var meta = metaMap[em] || {};
    var prev = state[em] ? state[em].bal : (sheetQ[em] || 0);
    if (prev == null || isNaN(prev)) prev = sheetQ[em] || 0;
    if (prev < 0) prev = 0;
    var next = prev + need;
    var sp = lastSpendPack[em] || {};
    var packId = sp.packageId || ("pkg_restore_" + em);
    seq++;
    ledgerRows.push({
      "學期代號": sid,
      "流水ID": "ql_" + Date.now() + "_" + seq + "_" + Math.random().toString(36).substr(2, 4),
      "時間": now,
      "教師Email": em,
      "教師姓名": meta.name || "",
      "異動": need,
      "餘額後": next,
      "類型": "restore",
      "包ID": packId,
      "事件ID": sp.eventId || "",
      "事件名稱": sp.eventName || "",
      "起日": "",
      "迄日": "",
      "申請單ID": meta.requestId || "",
      "操作者": "",
      "備註": "申請作廢還額 ×" + need
    });
    finalBal[em] = next;
  });

  if (ledgerRows.length) {
    appendQuotaLedgerRowsFast_(ledgerRows);
    bustQuotaLedgerMem_();
  }
  if (Object.keys(finalBal).length) {
    patchTeacherMutualQuotaColumn_(sid, finalBal);
  }
  invalidateQuotaCaches_(sid, emails);
  return emails.length;
}

/** 單人扣用（後備；批次請用 spendMutualQuotaForRequests_） */
function spendFromActivityPackages_(semesterId, email, n, meta) {
  return spendMutualQuotaForRequests_([{
    "學期代號": semesterId,
    "受邀人Email": email,
    "受邀人姓名": (meta && meta.name) || "",
    "申請單ID": (meta && meta.requestId) || "",
    "經費來源": "扣額度"
  }], (meta && meta.operator) || "");
}

function restoreToActivityPackages_(semesterId, email, n, meta) {
  return restoreMutualQuotaForRequests_([{
    "學期代號": semesterId,
    "受邀人Email": email,
    "受邀人姓名": (meta && meta.name) || "",
    "申請單ID": (meta && meta.requestId) || "",
    "經費來源": "扣額度",
    "狀態": "approved",
    _prevStatus: "approved"
  }]);
}

/**
 * 發放：帳本寫 earn（同包ID 已有 earn 則略過，防重複）
 */
function upsertActivityQuotaPackage_(o) {
  o = o || {};
  ensureQuotaSheets_();
  var sid = String(o.semesterId || "");
  var em = String(o.email || "").toLowerCase().trim();
  var eventId = String(o.eventId || "").trim();
  var released = parseFloat(o.released);
  if (isNaN(released) || released <= 0) return null;
  released = Math.round(released * 1000) / 1000;
  if (!sid || !em || released <= 0) return null;
  if (!eventId) {
    eventId = "evt_" + String(o.startDate || "") + "_" + String(o.endDate || "") + "_" + String(o.awayKey || "manual");
  }
  var packId = "pkg_" + sid + "_" + eventId + "_" + em.replace(/[^a-z0-9@._-]/gi, "_");
  var mode = o.mode === "set" ? "set" : "add";
  // 是否已發放：同包已有任何列（通常是 earn）
  var hadEarn = false;
  var packRem = 0;
  getQuotaLedgerRows_(sid).forEach(function (r) {
    if (String(r["包ID"] || "") !== packId) return;
    var dR = parseFloat(r["異動"]);
    if (isNaN(dR)) dR = 0;
    dR = Math.round(dR * 1000) / 1000;
    if (String(r["類型"] || "") === "earn" || dR > 0) hadEarn = true;
    packRem += dR;
  });
  packRem = Math.round(packRem * 1000) / 1000;
  if (hadEarn && mode === "add" && !o.forceAdd) {
    return {
      packageId: packId,
      skipped: true,
      reason: "already_earned",
      row: { "剩餘": Math.max(0, packRem), "包ID": packId }
    };
  }
  var delta = released;
  if (hadEarn && mode === "set") {
    // 覆寫：補差額到「獲得=released、已用不變」→ 目標剩餘 = max(0, released - used)
    // used = earned_old - rem_old；簡化：目標餘額包 = released - used = rem + (released - earned_old)
    // 用 force：直接 + (released - current_pack_positive_earns) 太複雜；set 時若已有則略過除非 forceAdd
    if (!o.forceAdd) {
      return {
        packageId: packId,
        skipped: true,
        reason: "already_earned",
        row: { "剩餘": Math.max(0, packRem), "包ID": packId }
      };
    }
  }
  var bal = postLedgerAndSync_({
    semesterId: sid,
    email: em,
    name: o.name || "",
    delta: delta,
    type: "earn",
    packageId: packId,
    eventId: eventId,
    eventName: o.eventName || "",
    startDate: o.startDate || "",
    endDate: o.endDate || "",
    operator: o.operator || "",
    note: o.note || ("活動發放 " + delta)
  });
  return {
    packageId: packId,
    skipped: false,
    row: { "剩餘": Math.max(0, packRem + delta), "包ID": packId, "獲得": delta },
    delta: delta,
    balance: bal
  };
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
/** 系統設定 map：請求內 mem + ScriptCache（少改、常讀） */
var _settingsMapMem_ = { map: null, ts: 0 };
var CACHE_TTL_SETTINGS_ = 300;
function bustSettingsMapCache_() {
  _settingsMapMem_ = { map: null, ts: 0 };
  try { removeCacheChunked("jcjh_settings_map"); } catch (e) {}
  bustTableDataMem_("系統設定");
}
function buildSettingsMap_() {
  var now = Date.now();
  if (_settingsMapMem_.map && (now - _settingsMapMem_.ts) < 60000) {
    return _settingsMapMem_.map;
  }
  try {
    var cached = getCacheChunked("jcjh_settings_map");
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && typeof parsed === "object") {
        _settingsMapMem_ = { map: parsed, ts: now };
        return parsed;
      }
    }
  } catch (eC) {}
  const rawSettings = getTableData("系統設定");
  const settings = {};
  rawSettings.forEach(function (s) {
    var key = s["設定名稱"] !== undefined ? s["設定名稱"] : s["設定鍵"];
    if (key) settings[key] = s["設定值"];
  });
  _settingsMapMem_ = { map: settings, ts: now };
  try { putCacheChunked("jcjh_settings_map", JSON.stringify(settings), CACHE_TTL_SETTINGS_); } catch (eP) {}
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
/**
 * 個人化 payload。
 * opts.canViewAllTimetables：教學組或行政 → 全校課表
 * opts.isStaff：行政（申請可見範圍含代送）
 */
function personalizeSharedPayload_(shared, readerEmail, readerIsAdmin, opts) {
  if (!shared) return shared;
  opts = opts || {};
  var canViewAll = !!(readerIsAdmin || opts.canViewAllTimetables || opts.isStaff);
  var out = {};
  for (var k in shared) {
    if (Object.prototype.hasOwnProperty.call(shared, k)) out[k] = shared[k];
  }
  var rows = shared.requests || [];
  var em = String(readerEmail || "").toLowerCase();
  if (!readerIsAdmin) {
    rows = rows.filter(function (req) {
      return requestVisibleToReader_(req, em, false);
    });
  }
  if (canViewAll) {
    out.scope = readerIsAdmin ? (shared.scope || "admin") : "staff";
    out.scheduleScope = "full";
  } else {
    out.scope = "teacher";
    if (out.schedules) {
      out.schedules = slimSchedulesForTeacher_(out.schedules, em);
      out.scheduleScope = "teacher_self_and_class";
    }
  }
  out.requests = rows;
  if (out.requestWindow) {
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
      mutualQuota: t["折抵額度"] != null ? t["折抵額度"] : (t.mutualQuota != null ? t.mutualQuota : 0),
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
      return requestVisibleToReader_(req, em, false);
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
 * opts.teachersOnly=true：只回教師名單（額度發放後 soft 用，不含課表／申請）。
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
  const teachersOnly = opts.teachersOnly === true || opts.teachersOnly === "true" || opts.teachersOnly === 1;
  // 額度發放後：只回教師（折抵額度），跳過申請／課表讀取
  if (teachersOnly) {
    return {
      success: true,
      kind: "teachersOnly",
      teachers: getSemesterTeachersCached_(semesterId),
      scope: isAdmin ? "admin" : "teacher",
      serverTime: toLocalTimeStr(new Date())
    };
  }
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
  // 走分層快取（勿每次 getTableData 全表）
  var semesterSchedules = getSemesterSchedulesCached_(sid) || [];
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

  // 申請：用學期快取後再 filter 已核准＋該班（公開不需 pending）
  var reqPackPub = getSemesterRequestsCached_(sid, true, 14);
  var approved = (reqPackPub.rows || []).filter(function (req) {
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
      "學期代號": req["學期代號"] || sid,
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

  var teachers = (getSemesterTeachersCached_(sid) || []).filter(function (t) {
    return emailNeed[String(t["教師Email"] || t.email || "").toLowerCase()];
  }).map(function (t) {
    return {
      "學期代號": sid,
      "教師姓名": t["教師姓名"] || t.name || "",
      "教師Email": t["教師Email"] || t.email || "",
      "授課科目": t["授課科目"] || t["任課科目"] || t["科目"] || t.subject || "",
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
      // 只掃出 pending 列（不建 historyAll 全量快取）
      pending = getPendingRequestsFromSheet_(semesterId);
      try { putCacheChunked(pendingKey, JSON.stringify(pending), CACHE_TTL_PENDING_); } catch (pPut) {}
    }
    if (!isAdminP) {
      pending = (pending || []).filter(function (req) {
        return requestVisibleToReader_(req, readerEmail, false);
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
    // 單月快取 60s（admin 全校）— 先查快取再掃
    var histKey = "jcjh_hist_" + semesterId + "_" + monthStr + (isAdminH ? "_a" : "_u");
    if (isAdminH) {
      var histCached = getCacheChunked(histKey);
      if (histCached) {
        return ContentService.createTextOutput(histCached).setMimeType(ContentService.MimeType.JSON);
      }
    }
    // 走申請全學期快取，再 filter 月份（勿每次全表）
    var packH = getSemesterRequestsCached_(semesterId, true, 14);
    var monthRows = (packH.rows || []).filter(function (req) {
      var d1 = String(req["異動日期"] || "").slice(0, 7);
      var d2 = String(req["對調目標日期"] || "").slice(0, 7);
      var d3 = String(req["建立時間"] || "").slice(0, 7);
      return d1 === monthStr || d2 === monthStr || d3 === monthStr;
    });
    if (!isAdminH) {
      monthRows = monthRows.filter(function (req) {
        return requestVisibleToReader_(req, readerEmail, false);
      });
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

  // 折抵額度歷程：讀「額度帳本」列（管理員可查任一師；教師僅自己）
  if (action === "getMutualQuotaLedger") {
    var targetEmail = String(reqData.email || reqData.teacherEmail || postData.email || "").toLowerCase().trim();
    if (!targetEmail) targetEmail = readerEmail;
    // 權限：先快路徑（查自己免整包教師）；查他人才載教師名單
    var isSelfLed = targetEmail === readerEmail;
    var teachersL = null;
    var isAdminL = false;
    if (!isSelfLed) {
      teachersL = getSemesterTeachersCached_(semesterId);
      isAdminL = resolveIsAdmin_(readerEmail, teachersL);
      if (!isAdminL) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "僅能查看自己的額度歷程"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      // 自己：輕量確認是否 admin（顯示用姓名可後補）
      try {
        teachersL = getSemesterTeachersCached_(semesterId);
        isAdminL = resolveIsAdmin_(readerEmail, teachersL);
      } catch (eT) { teachersL = []; }
    }
    var limitL = parseInt(reqData.limit != null ? reqData.limit : 50, 10) || 50;
    if (limitL > 120) limitL = 120;
    // 分師結果快取 120s（寫入會精準 bust）
    var ledCacheKey = "jcjh_qled_" + semesterId + "_" + targetEmail + "_" + limitL;
    try {
      var ledCached = CacheService.getScriptCache().get(ledCacheKey);
      if (ledCached) {
        return ContentService.createTextOutput(ledCached).setMimeType(ContentService.MimeType.JSON);
      }
    } catch (eLedC) {}
    // 走 getQuotaLedgerRows_（ScriptCache＋mem）；再 filter 教師
    var sidL = String(semesterId || "");
    var idxKeyL = makeQuotaLedgerIndexKey_(sidL, targetEmail);
    var balSum = 0;
    var rowsL = [];
    (getQuotaLedgerRows_(sidL) || []).forEach(function (r) {
      var ik = String(r["索引鍵"] || "").trim();
      if (ik) {
        if (ik !== idxKeyL) return;
      } else {
        var em = String(r["教師Email"] || "").toLowerCase().trim();
        if (em !== targetEmail) return;
      }
      var d = parseFloat(r["異動"]);
      if (isNaN(d)) d = 0;
      balSum = Math.round((balSum + d) * 1000) / 1000;
      rowsL.push(r);
    });
    // 時間倒序（新→舊）；同秒再以流水ID 倒序
    rowsL.sort(function (a, b) {
      var ta = String(a["時間"] || "").replace("T", " ").trim();
      var tb = String(b["時間"] || "").replace("T", " ").trim();
      if (tb !== ta) return tb < ta ? -1 : 1;
      var ida = String(a["流水ID"] || "");
      var idb = String(b["流水ID"] || "");
      if (idb !== ida) return idb < ida ? -1 : 1;
      return 0;
    });
    if (rowsL.length > limitL) rowsL = rowsL.slice(0, limitL);
    var typeLabel = function (t) {
      var k = String(t || "").toLowerCase();
      if (k === "earn") return "發放";
      if (k === "spend") return "扣用";
      if (k === "restore") return "還原";
      if (k === "adjust") return "手動調整";
      return t || "—";
    };
    var ledger = rowsL.map(function (r) {
      var d = parseFloat(r["異動"]);
      if (isNaN(d)) d = 0;
      d = Math.round(d * 1000) / 1000;
      var ba = parseFloat(r["餘額後"]);
      if (isNaN(ba)) ba = 0;
      ba = Math.round(ba * 1000) / 1000;
      return {
        id: r["流水ID"] || "",
        time: r["時間"] || "",
        email: r["教師Email"] || "",
        name: r["教師姓名"] || "",
        delta: d,
        balanceAfter: ba,
        type: r["類型"] || "",
        typeLabel: typeLabel(r["類型"]),
        packageId: r["包ID"] || "",
        eventId: r["事件ID"] || "",
        eventName: r["事件名稱"] || "",
        startDate: r["起日"] || "",
        endDate: r["迄日"] || "",
        requestId: r["申請單ID"] || "",
        operator: r["操作者"] || "",
        note: r["備註"] || ""
      };
    });
    var balance = Math.max(0, balSum);
    var tHit = null;
    if (teachersL && teachersL.length) {
      tHit = teachersL.find(function (t) {
        return String(t["教師Email"] || t.email || "").toLowerCase() === targetEmail;
      });
    }
    var sheetQLed = balance;
    if (tHit) {
      var sqL = parseFloat(tHit["折抵額度"] != null ? tHit["折抵額度"] : tHit.mutualQuota);
      if (isNaN(sqL) || sqL < 0) sqL = 0;
      sheetQLed = Math.round(sqL * 1000) / 1000;
    }
    // 名單餘額優先（與畫面教師列表一致）；帳本加總作備援
    if (tHit && sheetQLed != null) balance = sheetQLed;
    var outLed = {
      success: true,
      email: targetEmail,
      name: tHit ? (tHit["教師姓名"] || tHit.name || "") : (ledger[0] && ledger[0].name) || "",
      balance: balance,
      sheetQuota: sheetQLed,
      ledger: ledger,
      count: ledger.length
    };
    var outLedJson = JSON.stringify(outLed);
    try { CacheService.getScriptCache().put(ledCacheKey, outLedJson, 120); } catch (eLedP) {}
    return ContentService.createTextOutput(outLedJson).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getInitialData") {
    var teachersForRole = getSemesterTeachersCached_(semesterId);
    var readerIsAdmin = resolveIsAdmin_(readerEmail, teachersForRole);
    var readerIsStaff = resolveIsStaff_(readerEmail, teachersForRole);
    var personalizeOpts = { isStaff: readerIsStaff, canViewAllTimetables: !!(readerIsAdmin || readerIsStaff) };
    var historyAllFlag = reqData.historyAll === true || reqData.historyAll === "true" || reqData.historyAll === 1
      || postData.historyAll === true || postData.historyAll === "true";
    var requestsOnlyFlag = reqData.requestsOnly === true || reqData.requestsOnly === "true" || reqData.requestsOnly === 1
      || postData.requestsOnly === true || postData.requestsOnly === "true";
    var teachersOnlyFlag = reqData.teachersOnly === true || reqData.teachersOnly === "true" || reqData.teachersOnly === 1
      || postData.teachersOnly === true || postData.teachersOnly === "true";
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
      if (readerIsStaff) deltaOut.scope = "staff";
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
      var roOut = personalizeSharedPayload_(roShared, readerEmail, readerIsAdmin, personalizeOpts);
      return ContentService.createTextOutput(JSON.stringify(roOut))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── teachersOnly：只回教師名單（額度發放後 soft；不走課表）──
    if (teachersOnlyFlag) {
      var toOut = buildFullSemesterPayload_(semesterId, {
        userEmail: readerEmail,
        isAdmin: readerIsAdmin,
        teachersOnly: true
      });
      return ContentService.createTextOutput(JSON.stringify(toOut))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── 全量：admin／教師共用底包（課表全校；申請全校列，回傳前淺拷 filter）──
    // 行政與教學組皆吃 full 底包（課表不瘦身）；一般教師用 teacher 鍵（內容相同，個人化再瘦）
    var fullSharedKey = (readerIsAdmin || readerIsStaff)
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
          var ttl = (readerIsAdmin || readerIsStaff) ? CACHE_TTL_FULL_ : CACHE_TTL_TEACHER_FULL_;
          putCacheChunked(fullSharedKey, JSON.stringify(fullShared), ttl);
          // 教師／admin 底包內容相同時互寫，提高命中
          if (readerIsAdmin || readerIsStaff) {
            putCacheChunked(
              "jcjh_data_" + semesterId + "_teacher_w" + wDays,
              JSON.stringify(fullShared),
              CACHE_TTL_TEACHER_FULL_
            );
          }
        } catch (eFullPut) {}
      }
    }
    var fullOut = personalizeSharedPayload_(fullShared, readerEmail, readerIsAdmin, personalizeOpts);
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
        || action === "getMatchCandidates" || action === "getMutualQuotaLedger") {
      return handleReadAction_(postData);
    }

    // 驗證／權限在鎖外（Token＋教師快取），縮短鎖持有時間
    const idToken = postData.idToken;
    const semesterId = postData.semesterId;
    const reqData = postData.data;
    const currentUrl = postData.currentUrl || "";
    const user = verifyGoogleIdToken(idToken);
    const userEmail = user.email.toLowerCase();
    // 權限用快取教師名單；寫入教師結構的 action 仍會 invalidate
    const teachers = getSemesterTeachersCached_(semesterId) || [];
    const currentTeacher = teachers.find(function (t) {
      return String(t["教師Email"] || t.email || "").toLowerCase() === userEmail;
    });
    const isAdmin = resolveIsAdmin_(userEmail, teachers);
    const isStaff = resolveIsStaff_(userEmail, teachers);
    var ADMIN_ONLY_ACTIONS = {
      saveSemester: 1, deleteSemester: 1, setDefaultSemester: 1,
      saveClassAwayEvent: 1, deleteClassAwayEvent: 1,
      saveTeacher: 1, deleteTeacher: 1, importTeachersBatch: 1, updateMutualQuotas: 1,
      earnMutualQuotaFromActivity: 1,
      saveScheduleCell: 1, clearScheduleCell: 1, importSchedulesBatch: 1,
      adminApprove: 1, adminReject: 1, adminApproveBatch: 1, adminRejectBatch: 1,
      deleteSubstitutionRecord: 1,
      saveHistoryEdit: 1, batchMarkPrinted: 1, saveMailSettings: 1, sendBatchNotices: 1
    };
    if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
      throw new Error("權限不足：此操作僅限教學組管理員！");
    }
    if (!isAdmin && teachers.length > 0 && !currentTeacher) {
      throw new Error("您的帳號不在本校教師名單中，無法操作！");
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
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
      saveRows("空堂事件", [cae], "事件ID");
      // 強制班級欄為文字格式，避免下次被讀成 number
      try {
        var shCae = getSpreadsheet().getSheetByName("空堂事件");
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
      deleteRows("空堂事件", "事件ID", delId);
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "saveTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      reqData["學期代號"] = semesterId;
      if (reqData["系統角色"] != null || reqData.role != null) {
        reqData["系統角色"] = normalizeRole_(reqData["系統角色"] != null ? reqData["系統角色"] : reqData.role);
      }
      saveRows("教師名單", [reqData], "教師Email");
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "deleteTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      deleteRows("教師名單", "教師Email", reqData.email);
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "importTeachersBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const list = reqData.list.map(function (t) {
        t["學期代號"] = semesterId;
        if (t["系統角色"] != null || t.role != null) {
          t["系統角色"] = normalizeRole_(t["系統角色"] != null ? t["系統角色"] : t.role);
        }
        return t;
      });
      // 一次性批次覆蓋/儲存
      saveRows("教師名單", list, "教師Email");
      invalidateScheduleCaches_(semesterId);

    } else if (action === "updateMutualQuotas") {
      // 手動覆寫：一次讀帳本算 prev → 批次 append 帳本 → 一次改額度欄（勿逐人 saveRows）
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "updateMutualQuotas");
      var qList = reqData.list || reqData.updates || [];
      if (!qList.length) throw new Error("更新清單為空！");
      if (qList.length > 300) throw new Error("單次最多 300 筆！");
      var sidAdj = String(semesterId || "");
      try { backfillQuotaLedgerIndexKeys_(); } catch (eBfA) {}
      var teachersAll = getSemesterTeachersCached_(sidAdj) || [];
      var tMap = {};
      var sheetQ = {};
      teachersAll.forEach(function (t) {
        var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
        if (!em) return;
        tMap[em] = t;
        var sq = parseFloat(t["折抵額度"] != null ? t["折抵額度"] : t.mutualQuota);
        if (isNaN(sq) || sq < 0) sq = 0;
        sheetQ[em] = Math.round(sq * 1000) / 1000;
      });
      // 一次掃帳本：每人餘額
      var balMap = {};
      getQuotaLedgerRows_(sidAdj).forEach(function (r) {
        var em = String(r["教師Email"] || "").toLowerCase().trim();
        if (!em) return;
        var d = parseFloat(r["異動"]);
        if (isNaN(d)) d = 0;
        balMap[em] = Math.round(((balMap[em] || 0) + d) * 1000) / 1000;
      });
      var ledgerRows = [];
      var finalBal = {};
      var now = quotaNowStr_();
      var seq = 0;
      var changedN = 0;
      qList.forEach(function (item) {
        var em = String(item.email || item["教師Email"] || "").toLowerCase().trim();
        if (!em || !tMap[em]) return;
        var prev = balMap[em];
        if (prev == null || isNaN(prev)) prev = sheetQ[em] || 0;
        if (prev === 0 && (sheetQ[em] || 0) > 0) prev = sheetQ[em];
        if (prev < 0) prev = 0;
        prev = Math.round(prev * 1000) / 1000;
        var q = parseFloat(item.mutualQuota != null ? item.mutualQuota : item["折抵額度"]);
        if (isNaN(q) || q < 0) q = 0;
        q = Math.round(q * 1000) / 1000;
        var delta = q - prev;
        if (delta === 0) {
          finalBal[em] = q;
          return;
        }
        balMap[em] = q;
        finalBal[em] = q;
        seq++;
        changedN++;
        ledgerRows.push({
          "學期代號": sidAdj,
          "流水ID": "ql_" + Date.now() + "_" + seq + "_" + Math.random().toString(36).substr(2, 4),
          "時間": now,
          "教師Email": em,
          "教師姓名": tMap[em]["教師姓名"] || "",
          "異動": delta,
          "餘額後": q,
          "類型": "adjust",
          "包ID": "pkg_manual_" + sidAdj + "_" + em,
          "事件ID": "manual",
          "事件名稱": "手動調整",
          "起日": "",
          "迄日": "",
          "申請單ID": "",
          "操作者": userEmail,
          "備註": item.note || "手動調整額度"
        });
      });
      if (!Object.keys(finalBal).length && !ledgerRows.length) {
        throw new Error("沒有可更新的教師！");
      }
      if (ledgerRows.length) {
        appendQuotaLedgerRowsFast_(ledgerRows);
        bustQuotaLedgerMem_();
      }
      if (Object.keys(finalBal).length) {
        patchTeacherMutualQuotaColumn_(sidAdj, finalBal);
      }
      invalidateQuotaCaches_(sidAdj, Object.keys(finalBal));
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: Object.keys(finalBal).length,
        adjusted: changedN,
        wroteLedger: ledgerRows.length
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "earnMutualQuotaFromActivity") {
      // 活動發放：批次一次寫帳本＋教師餘額（勿逐人 saveRows）
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "earnMutualQuotaFromActivity");
      var earnList = reqData.list || [];
      if (!earnList.length) throw new Error("發放清單為空！");
      if (earnList.length > 300) throw new Error("單次最多 300 筆！");
      var eventNameEarn = String(reqData.eventName || "").trim();
      if (!eventNameEarn) throw new Error("請提供空堂事件名稱（eventName）！");
      var batchRes = batchEarnMutualQuota_(semesterId, earnList, {
        eventId: String(reqData.eventId || "").trim(),
        eventName: eventNameEarn,
        startDate: String(reqData.startDate || "").slice(0, 10),
        endDate: String(reqData.endDate || "").slice(0, 10),
        mode: reqData.mode === "set" ? "set" : "add",
        forceAdd: reqData.forceAdd === true,
        operator: userEmail,
        note: reqData.note || ("發放：" + eventNameEarn),
        awayKey: reqData.awayKey || ""
      });
      // 額度寫入不必清課表快取（batchEarn 內已 invalidateQuotaCaches_）
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        eventId: batchRes.eventId,
        eventName: batchRes.eventName,
        earned: batchRes.earned,
        skipped: batchRes.skipped,
        wroteLedger: batchRes.wroteLedger,
        wroteTeachers: batchRes.wroteTeachers,
        results: batchRes.results
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "getMutualQuotaPackages") {
      // 從帳本加總活動包（管理員全校；教師僅自己）
      ensureQuotaSheets_();
      var packs = buildPackagesFromLedger_(semesterId, isAdmin ? "" : userEmail);
      var outPacks = packs.map(function (p) {
        return {
          packageId: p.packageId,
          eventId: p.eventId,
          eventName: p.eventName,
          startDate: p.startDate,
          endDate: p.endDate,
          email: p.email,
          name: p.name,
          earned: p.earned,
          used: p.used,
          remaining: p.remaining,
          status: p.remaining > 0 ? "open" : "empty",
          createdAt: p.firstTime || "",
          updatedAt: p.firstTime || ""
        };
      });
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        packages: outPacks
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
      // S1：只清「目前學期」課表後再寫入（其他學期列完整保留；一次整表覆寫，勿逐列 deleteRow）
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "importSchedulesBatch");
      var importList = reqData.list || [];
      if (!importList.length) throw new Error("匯入清單為空！");
      if (importList.length > 8000) throw new Error("單次最多 8000 節，請拆檔匯入");
      var replaceAll = reqData.replaceAll !== false; // 預設 S1 全學期覆寫
      var ssImp = getSpreadsheet();
      var sheetImp = ssImp.getSheetByName("教師課表");
      if (!sheetImp) throw new Error("找不到教師課表工作表");
      var headersImp = getHeadersForSheet("教師課表");
      var semKey = "學期代號";
      var sidStr = String(semesterId || "");

      var list = importList.map(function (s) {
        s[semKey] = semesterId;
        if (!s["課表ID"]) {
          var em0 = String(s["教師Email"] || "").split("@")[0] || "t";
          s["課表ID"] = "sched_" + em0 + "_" + s["星期"] + "_" + s["節次"] + "_" +
            String(s["班級"] || "x") + "_" + Utilities.getUuid().replace(/-/g, "").substr(0, 8);
        }
        return s;
      });

      if (replaceAll) {
        // 一次讀取 → 保留其他學期 → 整表重寫（表頭 + 其他學期 + 本學期新資料）
        var allExisting = getTableData("教師課表") || [];
        var keptOtherSem = allExisting.filter(function (row) {
          return String(row[semKey] || "") !== sidStr;
        });
        var outRows = [];
        keptOtherSem.forEach(function (row) {
          outRows.push(buildRowArray_("教師課表", headersImp, row));
        });
        list.forEach(function (row) {
          outRows.push(buildRowArray_("教師課表", headersImp, row));
        });
        // 清空後一次寫入（比逐列 deleteRow 快一個數量級）
        sheetImp.clearContents();
        sheetImp.getRange(1, 1, 1, headersImp.length).setValues([headersImp]);
        sheetImp.getRange(1, 1, 1, headersImp.length).setFontWeight("bold").setBackground("#f1f5f9");
        if (outRows.length > 0) {
          var WCHUNK = 500;
          for (var wi = 0; wi < outRows.length; wi += WCHUNK) {
            var block = outRows.slice(wi, wi + WCHUNK);
            sheetImp.getRange(2 + wi, 1, block.length, headersImp.length).setValues(block);
          }
        }
      } else {
        // 非 S1：增量 append／更新
        var CHUNK = 400;
        for (var ci = 0; ci < list.length; ci += CHUNK) {
          saveRows("教師課表", list.slice(ci, ci + CHUNK), "課表ID");
        }
      }
      if (reqData.teachers && reqData.teachers.length > 0) {
        var tList = reqData.teachers.map(function (t) {
          t[semKey] = semesterId;
          return t;
        });
        saveRows("教師名單", tList, "教師Email");
      }
      invalidateScheduleCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: list.length,
        replaceAll: !!replaceAll,
        semesterOnly: true,
        teachersAdded: (reqData.teachers && reqData.teachers.length) || 0
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "adminApprove") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      targetReq["狀態"] = "approved";
      if (reqData.note) targetReq["備註"] = reqData.note;
      saveRows("申請單", [targetReq], "申請單ID");
      // 待審核准一律寄通知信
      try { sendAdminApproveEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "adminApproveBatch") {
      // 批次核准：只讀目標列、一次 saveRows、再寄信
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "adminApproveBatch");
      var apIds = reqData.requestIds || reqData.ids || [];
      if (!apIds.length) throw new Error("請提供 requestIds");
      if (apIds.length > 40) throw new Error("單次批次核准最多 40 筆");
      var apNormIds = apIds.map(function (id) { return String(id || "").replace(/_[12]$/, ""); });
      var apById = findRowsByKeys_("申請單", "申請單ID", apNormIds);
      var apNote = reqData.note || "";
      var apToSave = [];
      var apOkIds = [];
      var apMiss = 0;
      apNormIds.forEach(function (rid) {
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
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
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
      var rjNormIds = rjIds.map(function (id) { return String(id || "").replace(/_[12]$/, ""); });
      var rjById = findRowsByKeys_("申請單", "申請單ID", rjNormIds);
      var rjToSave = [];
      var rjOkIds = [];
      var rjMiss = 0;
      rjNormIds.forEach(function (rid) {
        var row = rjById[rid];
        if (!row) { rjMiss++; return; }
        rjToSave.push(row);
        rjOkIds.push(rid);
      });
      if (!rjToSave.length) throw new Error("找不到可駁回的申請單");
      // 一次批次還額（勿逐人 restore → 重複讀寫帳本）
      try { restoreMutualQuotaForRequests_(rjToSave); } catch (qE) { logError_("restoreMutualQuota_adminRejectBatch", qE); }
      rjToSave.forEach(function (row) { row["狀態"] = "admin_rejected"; });
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
      // 若有 requestId，將申請單狀態改回 cancelled；扣額度單還原折抵額度
      if (reqData.requestId && reqData.requestId !== "N/A") {
        var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
        if (targetReq) {
          try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); }
          targetReq["狀態"] = "cancelled";
          saveRows("申請單", [targetReq], "申請單ID");
        }
      } else if (reqData.id) {
        var reqIdDel = String(reqData.id).replace(/_[12]$/, "");
        var targetReqDel = findRowByKey_("申請單", "申請單ID", reqIdDel);
        if (targetReqDel) {
          try { restoreMutualQuotaForRequests_(targetReqDel); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); }
          targetReqDel["狀態"] = "cancelled";
          saveRows("申請單", [targetReqDel], "申請單ID");
        }
      }
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "saveHistoryEdit") {
      // 管理員可修正已生效之代／調課全部欄位（教師、日期節次、班級科目、假別經費等）
      if (!isAdmin) throw new Error("無管理員權限！");
      var reqId = String(reqData.id || reqData.requestId || "").replace(/_[12]$/, "");
      if (!reqId) throw new Error("缺少申請單ID");
      var targetReq = findRowByKey_("申請單", "申請單ID", reqId);
      if (!targetReq) throw new Error("找不到該紀錄");

      var leaveEmail = String(reqData.requesterEmail || reqData["申請人Email"] || "").trim();
      var subEmail = String(reqData.targetTeacherEmail || reqData["受邀人Email"] || "").trim();
      if (!leaveEmail || !subEmail) throw new Error("請假教師與代課／對調教師皆必填");
      var leaveName = String(reqData.requesterName || reqData["申請人姓名"] || "").trim();
      var subName = String(reqData.targetTeacherName || reqData["受邀人姓名"] || "").trim();
      if (!leaveName || !subName) {
        var tAll = getSemesterTeachersCached_(semesterId) || [];
        var findT = function (em) {
          em = String(em || "").toLowerCase();
          var hit = tAll.find(function (t) {
            return String(t["教師Email"] || t.email || "").toLowerCase() === em;
          });
          return hit ? String(hit["教師姓名"] || hit.name || "") : em;
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
      // 相容舊用法：只傳 url → 寫 gasMailApiUrl
      if (reqData && reqData.url != null && String(reqData.url).trim() !== "") {
        upsertSystemSetting_("gasMailApiUrl", reqData.url);
      }
      // 行政代申請：指定行政 Email 白名單（非一鍵全開）
      if (reqData && reqData.proxySubmitEmails !== undefined && reqData.proxySubmitEmails !== null) {
        var emailRaw = String(reqData.proxySubmitEmails || "").trim();
        var emailList = emailRaw
          ? emailRaw.split(/[,，;\s]+/).map(function (s) { return String(s || "").trim().toLowerCase(); }).filter(Boolean)
          : [];
        // 只保留目前角色為 staff 的 Email
        var staffSet = {};
        (teachers || []).forEach(function (t) {
          if (normalizeRole_(t["系統角色"] || t.role) === "staff") {
            var te = String(t["教師Email"] || t.email || "").toLowerCase();
            if (te) staffSet[te] = 1;
          }
        });
        var cleaned = [];
        var seenEm = {};
        emailList.forEach(function (e) {
          if (!e || seenEm[e] || !staffSet[e]) return;
          seenEm[e] = 1;
          cleaned.push(e);
        });
        upsertSystemSetting_("proxySubmitEmails", cleaned.join(","));
        upsertSystemSetting_("proxySubmitEnabled", cleaned.length > 0 ? "true" : "false");
        upsertSystemSetting_("proxySubmitEnabledBy", reqData.proxySubmitEnabledBy || userEmail);
        upsertSystemSetting_("proxySubmitEnabledAt", reqData.proxySubmitEnabledAt || toLocalTimeStr(new Date()));
      } else if (reqData && (reqData.proxySubmitEnabled !== undefined && reqData.proxySubmitEnabled !== null && reqData.proxySubmitEnabled !== "")) {
        // 舊版全校開關：關閉＝清空名單；開啟＝不自動全開，僅寫 by/at
        var proxyOn = reqData.proxySubmitEnabled === true || reqData.proxySubmitEnabled === "true"
          || reqData.proxySubmitEnabled === "TRUE" || reqData.proxySubmitEnabled === 1
          || reqData.proxySubmitEnabled === "1" || reqData.proxySubmitEnabled === "是" || reqData.proxySubmitEnabled === "開";
        if (!proxyOn) {
          upsertSystemSetting_("proxySubmitEmails", "");
          upsertSystemSetting_("proxySubmitEnabled", "false");
          upsertSystemSetting_("proxySubmitEnabledBy", "");
          upsertSystemSetting_("proxySubmitEnabledAt", "");
        } else {
          upsertSystemSetting_("proxySubmitEnabledBy", reqData.proxySubmitEnabledBy || userEmail);
          upsertSystemSetting_("proxySubmitEnabledAt", reqData.proxySubmitEnabledAt || toLocalTimeStr(new Date()));
        }
      }
      // 其餘鍵值一併寫入（allowedHd 等）
      if (reqData && typeof reqData === "object") {
        var skipKeys = {
          url: 1, proxySubmitEnabled: 1, proxySubmitEnabledBy: 1, proxySubmitEnabledAt: 1,
          proxySubmitEmails: 1
        };
        Object.keys(reqData).forEach(function (k) {
          if (skipKeys[k]) return;
          if (k === "gasMailApiUrl" || k === "allowedHd" || k === "superAdminEmails") {
            upsertSystemSetting_(k, reqData[k]);
          }
        });
      }
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "batchMarkPrinted") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var printIds = (reqData.ids || []).map(function (id) {
        return String(id || "").replace(/_[12]$/, "");
      });
      var printById = findRowsByKeys_("申請單", "申請單ID", printIds);
      var listToUpdate = [];
      printIds.forEach(function (reqId) {
        var req = printById[reqId];
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
      var leaveEmailOne = String(reqData.request["申請人Email"] || reqData.request.requesterEmail || "").toLowerCase().trim();
      var isSelfOne = leaveEmailOne === userEmail;
      // 已授權行政（role=staff 且在白名單）
      var staffCanProxy = canUserProxySubmit_(userEmail, teachers);
      // 代別人：admin 永遠可；行政須已授權；一般教師不可
      if (!isSelfOne && !isAdmin && !staffCanProxy) {
        if (isStaff) throw new Error("您尚未被教學組授權代申請，無法代他人送出！");
        throw new Error("您無權代表他人發起申請單！");
      }
      // 狀態：
      // - 教學組 + directApprove → approved
      // - 代別人（已授權行政，或教學組未直接核准）→ pending_admin（跳過受邀確認）
      // - 自己申請 → pending_teacher
      var isProxyOne = false;
      if (!isSelfOne) {
        if (isAdmin && reqData.directApprove === true) {
          isProxyOne = false;
        } else if (staffCanProxy || isAdmin) {
          isProxyOne = true;
        }
      }
      // 扣額度／活動公費／第8節代課：僅管理員（活動互代）
      var feeOne = String(reqData.request["經費來源"] || "");
      if ((feeOne === "扣額度" || feeOne === "互代不結" || feeOne === "活動公費" || feeOne === "第8節代課") && !isAdmin) {
        throw new Error("扣額度／活動公費相關經費僅限管理員發起！");
      }
      // 寫入狀態（伺服器最終裁定）
      if (isAdmin && reqData.directApprove === true && !isProxyOne) {
        reqData.request["狀態"] = "approved";
      } else if (isProxyOne) {
        reqData.request["狀態"] = "pending_admin";
        reqData.request["代申請人Email"] = userEmail;
        if (!reqData.request["代申請人姓名"]) {
          reqData.request["代申請人姓名"] = currentTeacher
            ? String(currentTeacher["教師姓名"] || currentTeacher.name || userEmail)
            : userEmail;
        }
        var noteOne = String(reqData.request["備註"] || "").trim();
        if (noteOne.indexOf("[行政代申請") < 0) {
          var leaveNmOne = String(reqData.request["申請人姓名"] || leaveEmailOne);
          var actorNmOne = String(reqData.request["代申請人姓名"] || userEmail);
          var tagOne = "[行政代申請：" + actorNmOne + " 代 " + leaveNmOne + "]";
          reqData.request["備註"] = noteOne ? (tagOne + " " + noteOne) : tagOne;
        }
      } else {
        reqData.request["狀態"] = "pending_teacher";
      }
      // 雙重保險：代別人且非直接核准，絕不寫成 pending_teacher
      if (!isSelfOne && String(reqData.request["狀態"] || "") === "pending_teacher") {
        if (isAdmin || staffCanProxy) {
          reqData.request["狀態"] = "pending_admin";
          reqData.request["代申請人Email"] = userEmail;
          isProxyOne = true;
        }
      }
      if (!reqData.request["批次ID"]) reqData.request["批次ID"] = "";
      
      saveRows("申請單", [reqData.request], "申請單ID");
      // 扣額度：後端活動包 FIFO 扣用（與流水）
      try { spendMutualQuotaForRequests_([reqData.request], userEmail); } catch (qSpend1) {
        logError_("spendMutualQuota_submitRequest", qSpend1);
      }
      // skipNotify=true：只寫單不寄信
      // 行政代申請／pending_admin：絕不寄受邀邀請信（受邀者不需同意；教學組核准時再寄）
      var statusOne = String(reqData.request["狀態"] || "");
      var skipNotifyOne = reqData.skipNotify === true || reqData.skipNotify === "true"
        || isProxyOne || statusOne === "pending_admin";
      if (!skipNotifyOne) {
        if (statusOne === "approved") {
          try { sendAdminApproveEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }
        } else if (statusOne === "pending_teacher") {
          try { sendSubInviteEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendSubInviteEmail", ignE); }
        }
        // pending_admin：不寄信，等 adminApprove 再通知
      }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "submitRequestBatch") {
      // 方案 A：多筆申請單＋同一批次ID（每節仍獨立簽核）
      assertNotTooFrequent_(userEmail, "submitRequestBatch");
      var list = reqData.requests || [];
      if (!list.length) throw new Error("批次申請清單為空！");
      if (list.length > 20) throw new Error("單次批次最多 20 節！");
      var batchId = String(reqData.batchId || ("bat_" + Date.now())).trim();
      var staffCanProxyBatch = canUserProxySubmit_(userEmail, teachers);
      // 先掃一遍：是否含代申請（非本人）
      var anyOther = false;
      for (var bi0 = 0; bi0 < list.length; bi0++) {
        if (String((list[bi0] || {})["申請人Email"] || "").toLowerCase() !== userEmail) {
          anyOther = true;
          break;
        }
      }
      if (anyOther && !isAdmin && !staffCanProxyBatch) {
        throw new Error("批次中含非本人申請，已拒絕！（僅「已授權的行政」可代申請）");
      }
      // 代別人：已授權行政，或教學組未勾直接核准 → pending_admin
      var directOk = isAdmin && reqData.directApprove === true;
      var isProxyBatch = !!(anyOther && !directOk && (staffCanProxyBatch || isAdmin));
      var finalStatus = directOk ? "approved" : (isProxyBatch ? "pending_admin" : "pending_teacher");
      var actorNameBatch = currentTeacher
        ? String(currentTeacher["教師姓名"] || currentTeacher.name || userEmail)
        : userEmail;
      var rows = [];
      for (var bi = 0; bi < list.length; bi++) {
        var row = list[bi] || {};
        var leaveEmB = String(row["申請人Email"] || "").toLowerCase();
        if (leaveEmB !== userEmail && !isAdmin && !isProxyBatch) {
          throw new Error("批次中含非本人申請，已拒絕！");
        }
        var feeRow = String(row["經費來源"] || "");
        if ((feeRow === "扣額度" || feeRow === "互代不結" || feeRow === "活動公費" || feeRow === "第8節代課") && !isAdmin) {
          throw new Error("扣額度／活動公費相關經費僅限管理員發起！");
        }
        row["學期代號"] = semesterId;
        row["批次ID"] = batchId;
        row["狀態"] = finalStatus;
        if (isProxyBatch && leaveEmB !== userEmail) {
          row["代申請人Email"] = userEmail;
          row["代申請人姓名"] = actorNameBatch;
          var noteB = String(row["備註"] || "").trim();
          if (noteB.indexOf("[行政代申請") < 0) {
            var leaveNmB = String(row["申請人姓名"] || leaveEmB);
            var tagB = "[行政代申請：" + actorNameBatch + " 代 " + leaveNmB + "]";
            row["備註"] = noteB ? (tagB + " " + noteB) : tagB;
          }
        }
        if (!row["申請單ID"]) row["申請單ID"] = "req_" + Date.now() + "_" + bi + "_" + Math.random().toString(36).substr(2, 6);
        if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
        rows.push(row);
      }
      saveRows("申請單", rows, "申請單ID");
      try { spendMutualQuotaForRequests_(rows, userEmail); } catch (qSpendB) {
        logError_("spendMutualQuota_submitRequestBatch", qSpendB);
      }
      // skipNotify=true：只寫單不寄信；代申請／pending_admin 不寄邀請信
      var skipNotifyBatch = reqData.skipNotify === true || reqData.skipNotify === "true"
        || isProxyBatch || finalStatus === "pending_admin";
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
          } else if (finalStatus === "pending_teacher") {
            Object.keys(byInvitee).forEach(function (em) {
              var group = byInvitee[em];
              if (group.length === 1) {
                sendSubInviteEmail_(group[0], currentUrl);
              } else {
                sendSubInviteBatchEmail_(group, currentUrl);
              }
            });
          }
          // pending_admin：不寄信，等 adminApprove 再通知
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
        proxySubmit: !!isProxyBatch,
        ids: rows.map(function (r) { return r["申請單ID"]; })
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "sendBatchNotices") {
      // 歷史紀錄後發通知：核准信寄雙方；邀請信只寄受邀人；同人合併
      if (!isAdmin) throw new Error("僅管理員可批次發通知！");
      assertNotTooFrequent_(userEmail, "sendBatchNotices");
      var noticeIds = reqData.requestIds || reqData.ids || [];
      if (!noticeIds.length) throw new Error("請先選擇要通知的申請單！");
      if (noticeIds.length > 50) throw new Error("單次最多 50 筆！");
      var noticeNormIds = [];
      var seenRid = {};
      noticeIds.forEach(function (id) {
        var rid = String(id || "").replace(/_[12]$/, "");
        if (!rid || seenRid[rid]) return;
        seenRid[rid] = true;
        noticeNormIds.push(rid);
      });
      var noticeById = findRowsByKeys_("申請單", "申請單ID", noticeNormIds);
      var noticeRows = noticeNormIds.map(function (rid) { return noticeById[rid]; }).filter(Boolean);
      if (!noticeRows.length) throw new Error("找不到對應申請單！");

      var approvedRows = [];
      var pendingRows = [];
      noticeRows.forEach(function (r) {
        var st = String(r["狀態"] || "");
        if (st === "approved" || st === "已核准") approvedRows.push(r);
        else pendingRows.push(r);
      });

      var sent = 0;
      var failed = 0;
      var mailCount = 0;
      var validEm = function (e) {
        return e && String(e).indexOf("@") !== -1;
      };
      var normEm = function (e) {
        return String(e || "").toLowerCase().trim();
      };
      // 預估收件人數（核准＝雙方去重；邀請＝受邀人）
      var estRecipients = {};
      approvedRows.forEach(function (r) {
        var e1 = normEm(r["申請人Email"] || r.requesterEmail);
        var e2 = normEm(r["受邀人Email"] || r.targetTeacherEmail);
        if (validEm(e1)) estRecipients[e1] = 1;
        if (validEm(e2)) estRecipients[e2] = 1;
      });
      pendingRows.forEach(function (r) {
        var e2 = normEm(r["受邀人Email"] || r.targetTeacherEmail);
        if (validEm(e2)) estRecipients[e2] = 1;
      });

      // 已核准：整批一次走批次核准信（內部分 cover／leave 雙方）
      if (approvedRows.length) {
        try {
          if (approvedRows.length === 1) {
            sendAdminApproveEmail_(approvedRows[0], currentUrl);
            // 單筆：雙方各一封（同人則 1）
            var a0 = approvedRows[0];
            var ae1 = normEm(a0["申請人Email"] || a0.requesterEmail);
            var ae2 = normEm(a0["受邀人Email"] || a0.targetTeacherEmail);
            var n0 = 0;
            if (validEm(ae1)) n0++;
            if (validEm(ae2) && ae2 !== ae1) n0++;
            mailCount += n0 || 1;
          } else {
            sendAdminApproveBatchEmail_(approvedRows, currentUrl);
            // 批次：一人一封（申請人／受邀人去重）
            var byP = {};
            approvedRows.forEach(function (r) {
              var c = normEm(r["受邀人Email"] || r.targetTeacherEmail);
              var l = normEm(r["申請人Email"] || r.requesterEmail);
              if (validEm(c)) byP[c] = 1;
              if (validEm(l)) byP[l] = 1;
            });
            mailCount += Object.keys(byP).length;
          }
          sent++;
        } catch (eMailA) {
          failed++;
          logError_("sendBatchNotices_approved", eMailA);
        }
      }

      // 待簽核：只寄受邀人（依受邀人合併）
      if (pendingRows.length) {
        var bySubP = {};
        pendingRows.forEach(function (r) {
          var em = normEm(r["受邀人Email"] || r.targetTeacherEmail);
          if (!validEm(em)) return;
          if (!bySubP[em]) bySubP[em] = [];
          bySubP[em].push(r);
        });
        Object.keys(bySubP).forEach(function (em) {
          try {
            var group = bySubP[em];
            if (group.length === 1) sendSubInviteEmail_(group[0], currentUrl);
            else sendSubInviteBatchEmail_(group, currentUrl);
            mailCount += 1;
            sent++;
          } catch (eMailP) {
            failed++;
            logError_("sendBatchNotices_pending", eMailP);
          }
        });
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        found: noticeRows.length,
        approved: approvedRows.length,
        pending: pendingRows.length,
        mailCount: mailCount || Object.keys(estRecipients).length,
        recipientEst: Object.keys(estRecipients).length,
        sent: sent,
        failed: failed
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "respondToRequest") {
      // 同意或拒絕調代課邀請
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      // 確保操作者是受邀教師
      if (String(targetReq["受邀人Email"] || "").toLowerCase() !== userEmail) {
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
      if (reqData.response === "agree") {
        try { sendRespondAgreeEmail_(targetReq, currentUrl); } catch (ignE) { logError_("sendRespondAgreeEmail", ignE); }
      } else {
        try { sendRespondRejectEmail_(targetReq, currentUrl); } catch (ignE) { logError_("sendRespondRejectEmail", ignE); }
      }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "respondToBatch") {
      // 批次一次全部同意／全部拒絕（僅 pending_teacher 且本人為受邀人）
      assertNotTooFrequent_(userEmail, "respondToBatch");
      var batchId = String(reqData.batchId || "").trim();
      if (!batchId) throw new Error("缺少批次ID！");
      var resp = reqData.response === "agree" ? "agree" : "decline";
      var peers = findRowsByColumnValue_("申請單", "批次ID", batchId, function (r) {
        return String(r["狀態"] || "") === "pending_teacher"
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
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      // 僅限本人或管理員撤回
      if (String(targetReq["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權撤回他人的申請單！");
      }
      try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_cancel", qE); }
      targetReq["狀態"] = "cancelled";
      saveRows("申請單", [targetReq], "申請單ID");
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "withdrawRequest") {
      // 已送到行政端待簽核時，一般教師撤回
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId);
      if (!targetReq) throw new Error("找不到該申請單");
      
      if (String(targetReq["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
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
    var sidesTbl = _resolveExchangeSides_(req);
    var leaveSlot = _fmtSlotLine_(sidesTbl.leaveDate, sidesTbl.leaveDay, sidesTbl.leavePeriod, sidesTbl.leaveClass, sidesTbl.leaveSubject);
    var targetSlot = _fmtSlotLine_(sidesTbl.targetDate, sidesTbl.targetDay, sidesTbl.targetPeriod, sidesTbl.targetClass, sidesTbl.targetSubject);
    rows[3] = ["對調內容", leaveSlot + " ⇄ " + targetSlot];
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

function _isExchangeReq_(req) {
  if (!req) return false;
  return !!(req.targetDate || req["對調目標日期"]
    || req.type === "exchange" || req["異動類型"] === "exchange" || req["異動類型"] === "對調");
}

/** 一批申請的類型：exchange | substitution | mixed */
function _batchModeKind_(rows) {
  var hasEx = false;
  var hasSub = false;
  (rows || []).forEach(function (r) {
    if (_isExchangeReq_(r)) hasEx = true;
    else hasSub = true;
  });
  if (hasEx && hasSub) return "mixed";
  if (hasEx) return "exchange";
  return "substitution";
}

/** 建成國中節次時間（與 date-utils.js 一致） */
function _periodTimeSpan_(p) {
  var times = {
    "1": "08:30-09:15", "2": "09:25-10:10", "3": "10:20-11:05", "4": "11:15-12:00",
    "5": "13:20-14:05", "6": "14:15-15:00", "7": "15:15-16:00", "8": "16:10-16:55"
  };
  return times[String(p)] || "";
}

function _shortDay_(d) {
  return { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" }[String(d)] || "";
}

/** 由日期推星期 1–5（失敗回 0） */
function _dayFromDateStr_(dateStr) {
  if (!dateStr) return 0;
  try {
    var d = new Date(String(dateStr).replace(/-/g, "/"));
    if (isNaN(d.getTime())) return 0;
    var wd = d.getDay();
    return wd === 0 ? 7 : wd;
  } catch (e) {
    return 0;
  }
}

/**
 * 查教師課表班科（email + 星期 + 節次；可限學期）
 * 勿回傳錯誤人的課；查不到回空字串
 */
function _lookupScheduleClassSubject_(email, dayOfWeek, period, semesterId) {
  var out = { className: "", subject: "" };
  var em = String(email || "").toLowerCase().trim();
  var day = parseInt(dayOfWeek, 10);
  var per = parseInt(period, 10);
  if (!em || !day || !per) return out;
  try {
    var schedules = getTableData("教師課表") || [];
    var sid = String(semesterId || "").trim();
    var hit = null;
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s) continue;
      if (sid) {
        var sSid = String(s["學期代號"] || s.semesterId || "").trim();
        if (sSid && sSid !== sid) continue;
      }
      var sEmail = String(s.teacherEmail || s["教師Email"] || "").toLowerCase().trim();
      if (sEmail !== em) continue;
      if (parseInt(s.dayOfWeek || s["星期"], 10) !== day) continue;
      if (parseInt(s.period || s["節次"], 10) !== per) continue;
      hit = s;
      break;
    }
    if (hit) {
      out.className = String(hit.className || hit["班級"] || "").trim();
      out.subject = String(hit.subject || hit["科目"] || "").trim();
    }
  } catch (e) {}
  return out;
}

/**
 * 對調雙方班科
 * - leave：申請人請假節（申請單班級／科目）
 * - target：受邀人原課（對調目標節）；查課表，禁止回退成申請人班科
 */
function _resolveExchangeSides_(req) {
  var leaveClass = String(req.className || req["班級"] || "").trim();
  var leaveSubject = String(req.subject || req["科目"] || "").trim();
  var leaveDate = req.requestDate || req["異動日期"] || "";
  var leavePeriod = req.requestPeriod || req["異動節次"] || "";
  var leaveDay = req.requestPeriodDay || req["異動星期"] || _dayFromDateStr_(leaveDate);
  var leaveEmail = req.requesterEmail || req["申請人Email"] || "";
  var targetDate = req.targetDate || req["對調目標日期"] || "";
  var targetPeriod = req.targetPeriod || req["對調目標節次"] || "";
  var targetDay = req.targetDayOfWeek || req["對調目標星期"] || _dayFromDateStr_(targetDate);
  var targetEmail = req.targetTeacherEmail || req["受邀人Email"] || "";
  var semesterId = req.semesterId || req["學期代號"] || "";

  // 請假節缺班科 → 查申請人課表
  if ((!leaveClass && !leaveSubject) && leaveEmail && leaveDay && leavePeriod) {
    var leaveCs = _lookupScheduleClassSubject_(leaveEmail, leaveDay, leavePeriod, semesterId);
    leaveClass = leaveCs.className || leaveClass;
    leaveSubject = leaveCs.subject || leaveSubject;
  }

  var targetClass = String(req.targetClassName || req["對調目標班級"] || "").trim();
  var targetSubject = String(req.targetSubject || req["對調目標科目"] || "").trim();
  if ((!targetClass && !targetSubject) && targetEmail && targetDay && targetPeriod) {
    var tCs = _lookupScheduleClassSubject_(targetEmail, targetDay, targetPeriod, semesterId);
    targetClass = tCs.className;
    targetSubject = tCs.subject;
  }
  // 禁止用申請人班科填受邀人（那是「抓成對方的課」的元兇）

  return {
    leaveDate: leaveDate,
    leavePeriod: leavePeriod,
    leaveDay: leaveDay,
    leaveClass: leaveClass,
    leaveSubject: leaveSubject,
    leaveName: req.requesterName || req["申請人姓名"] || "",
    leaveEmail: leaveEmail,
    targetDate: targetDate,
    targetPeriod: targetPeriod,
    targetDay: targetDay,
    targetClass: targetClass,
    targetSubject: targetSubject,
    coverName: req.targetTeacherName || req["受邀人姓名"] || "",
    coverEmail: targetEmail,
    serial: req.serial || req["單號"] || "",
    reason: req.reason || req["請假事由"] || "請假"
  };
}

function _fmtSlotLine_(dateVal, dayVal, periodVal, cls, subj) {
  var dayTxt = _shortDay_(dayVal);
  var head = String(dateVal || "");
  if (dayTxt) head += " (週" + dayTxt + ")";
  head += " 第" + periodVal + "節";
  var course = (String(cls || "") + " " + String(subj || "")).trim();
  return course ? (head + "　" + course) : head;
}

/**
 * 緊湊節次：3/20(三)第2節 701國文
 */
function _fmtSlotCompact_(dateVal, dayVal, periodVal, cls, subj) {
  var mmdd = "";
  var ds = String(dateVal || "");
  if (ds.length >= 10) mmdd = ds.substr(5, 2) + "/" + ds.substr(8, 2);
  else mmdd = ds;
  var dayTxt = _shortDay_(dayVal);
  var course = (String(cls || "") + String(subj || "")).trim();
  var s = mmdd;
  if (dayTxt) s += "(" + dayTxt + ")";
  s += "第" + periodVal + "節";
  if (course) s += " " + course;
  return s;
}

/**
 * 批次／個人異動明細（緊湊單行）
 * opts.role: leave | cover | '' 
 * 調課：不用上 A → 改上 B　與Ｘ老師
 */
function _buildApproveSlotListHtml_(rows, opts) {
  opts = opts || {};
  var showLeave = opts.showLeave !== false;
  var showSub = opts.showSub !== false;
  var role = opts.role || "";
  var liStyle = 'margin:0;padding:2px 0;line-height:1.45;';
  var items = (rows || []).map(function (req) {
      var isEx = _isExchangeReq_(req);
      var leaveN = req.requesterName || req["申請人姓名"] || "";
      var subN = req.targetTeacherName || req["受邀人姓名"] || "";
      if (!isEx) {
        var dateVal = req.requestDate || req["異動日期"] || "";
        var dayVal = req.requestPeriodDay || req["異動星期"] || "";
        var periodVal = req.requestPeriod || req["異動節次"] || "";
        var cls = req.className || req["班級"] || "";
        var subj = req.subject || req["科目"] || "";
        var slot = _fmtSlotCompact_(dateVal, dayVal, periodVal, cls, subj);
        if (role === "leave") {
          return '<li style="' + liStyle + '"><strong>【不用上】</strong>' + slot + "　由 <strong>" + subN + "</strong> 代課</li>";
        }
        if (role === "cover") {
          return '<li style="' + liStyle + '"><strong>【代課】</strong>' + slot + "　代 <strong>" + leaveN + "</strong> 老師</li>";
        }
        var who = "";
        if (showLeave && showSub) who = "　" + leaveN + "→" + subN;
        else if (showLeave) who = "　請假：" + leaveN;
        else if (showSub) who = "　代課：" + subN;
        return '<li style="' + liStyle + '"><strong>【代課】</strong>' + slot + who + "</li>";
      }

      var sides = _resolveExchangeSides_(req);
      var outC = "";
      var inC = "";
      var peer = "";
      if (role === "cover") {
        outC = _fmtSlotCompact_(sides.targetDate, sides.targetDay, sides.targetPeriod, sides.targetClass, sides.targetSubject);
        inC = _fmtSlotCompact_(sides.leaveDate, sides.leaveDay, sides.leavePeriod, sides.targetClass, sides.targetSubject);
        peer = leaveN;
      } else if (role === "leave") {
        outC = _fmtSlotCompact_(sides.leaveDate, sides.leaveDay, sides.leavePeriod, sides.leaveClass, sides.leaveSubject);
        inC = _fmtSlotCompact_(sides.targetDate, sides.targetDay, sides.targetPeriod, sides.leaveClass, sides.leaveSubject);
        peer = subN;
      } else {
        outC = _fmtSlotCompact_(sides.leaveDate, sides.leaveDay, sides.leavePeriod, sides.leaveClass, sides.leaveSubject);
        inC = _fmtSlotCompact_(sides.targetDate, sides.targetDay, sides.targetPeriod, sides.targetClass, sides.targetSubject);
        peer = leaveN + "⇄" + subN;
      }
      return '<li style="' + liStyle + '"><strong>【調課】</strong>不用上 ' + outC + " → 改上 " + inC
        + (peer ? "　與<strong>" + peer + "</strong>" : "")
        + "</li>";
    });
  if (opts.itemsOnly) return items.join("");
  return '<ul style="padding-left:18px;color:#1e293b;font-size:14px;margin:6px 0 10px;list-style:disc;">'
    + items.join("")
    + "</ul>";
}

/**
 * 核准信行事曆內容（依收件人身分）
 * role: 'leave' | 'cover'
 * 調入：時間＝對方節次；班科＝自己的課（禁止用對方班科填空）
 */
function _calendarDetailsForRole_(req, role) {
  if (!req) return null;
  var isExchange = _isExchangeReq_(req);
  var serial = req.serial || req["單號"] || "";
  var reason = req.reason || req["請假事由"] || "請假";

  if (!isExchange) {
    var leaveDate0 = req.requestDate || req["異動日期"] || "";
    var leavePeriod0 = req.requestPeriod || req["異動節次"] || "";
    var leaveClass0 = req.className || req["班級"] || "";
    var leaveSubject0 = req.subject || req["科目"] || "";
    var leaveName0 = req.requesterName || req["申請人姓名"] || "";
    var coverName0 = req.targetTeacherName || req["受邀人姓名"] || "";
    if (!leaveDate0 || leavePeriod0 == null || leavePeriod0 === "") return null;
    var timeSpan0 = _periodTimeSpan_(leavePeriod0);
    if (!timeSpan0) return null;
    var parts0 = timeSpan0.split("-");
    var datePart0 = String(leaveDate0).replace(/-/g, "");
    var titleTag0 = role === "leave" ? "不用上" : "代課";
    var action0 = role === "leave"
      ? ("本節不用上。\n由 " + coverName0 + " 代課。")
      : ("本節請代課。\n請假教師：" + leaveName0 + "。");
    var slot0 = (String(leaveClass0 || "") + " " + String(leaveSubject0 || "")).trim() || "課堂";
    return {
      title: "【" + titleTag0 + "】" + slot0,
      startIso: datePart0 + "T" + parts0[0].replace(":", "") + "00",
      endIso: datePart0 + "T" + parts0[1].replace(":", "") + "00",
      details: action0 + "\n\n請假教師：" + leaveName0 + "\n代課教師：" + coverName0
        + "\n假別事由：" + reason + "\n單號：" + serial + "\n（建成國中調代課系統）",
      titleTag: titleTag0
    };
  }

  var sides = _resolveExchangeSides_(req);
  var eventDate = sides.leaveDate;
  var eventPeriod = sides.leavePeriod;
  var className = sides.leaveClass;
  var subject = sides.leaveSubject;
  var titleTag = "調入";
  var actionLine = "";

  if (role === "leave") {
    // 申請人：行事曆記「調入」＝對方時間＋自己班科
    eventDate = sides.targetDate || sides.leaveDate;
    eventPeriod = sides.targetPeriod != null && sides.targetPeriod !== "" ? sides.targetPeriod : sides.leavePeriod;
    className = sides.leaveClass;
    subject = sides.leaveSubject;
    actionLine = "【調入】本則為您要上的節次（您的課程："
      + ((className + " " + subject).trim() || "—") + "）。\n"
      + "【調出】" + sides.leaveDate + "第" + sides.leavePeriod + "節不用上，由 "
      + sides.coverName + " 上。";
  } else {
    // 受邀人：行事曆記「調入」＝申請人時間＋自己班科（目標節原課）
    eventDate = sides.leaveDate;
    eventPeriod = sides.leavePeriod;
    className = sides.targetClass;
    subject = sides.targetSubject;
    actionLine = "【調入】本則為您要上的節次（您的課程："
      + ((className + " " + subject).trim() || "—") + "）。\n"
      + "【調出】" + sides.targetDate + "第" + sides.targetPeriod + "節不用上，由 "
      + sides.leaveName + " 上。";
  }

  if (!eventDate || eventPeriod == null || eventPeriod === "") return null;
  var timeSpan = _periodTimeSpan_(eventPeriod);
  if (!timeSpan) return null;
  var parts = timeSpan.split("-");
  var datePart = String(eventDate).replace(/-/g, "");
  var slotLabel = (String(className || "") + " " + String(subject || "")).trim() || "課堂";
  var details = actionLine
    + "\n\n請假教師：" + sides.leaveName
    + "\n對調教師：" + sides.coverName
    + "\n假別事由：" + reason
    + "\n單號：" + serial
    + "\n對調：" + sides.leaveDate + "第" + sides.leavePeriod + "節（"
    + ((sides.leaveClass + " " + sides.leaveSubject).trim() || "—") + "） ⇄ "
    + sides.targetDate + "第" + sides.targetPeriod + "節（"
    + ((sides.targetClass + " " + sides.targetSubject).trim() || "—") + "）"
    + "\n（建成國中調代課系統）";
  return {
    title: "【" + titleTag + "】" + slotLabel,
    startIso: datePart + "T" + parts[0].replace(":", "") + "00",
    endIso: datePart + "T" + parts[1].replace(":", "") + "00",
    details: details,
    titleTag: titleTag
  };
}

function _googleCalendarUrl_(cal) {
  if (!cal) return "";
  return "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(cal.title)
    + "&dates=" + encodeURIComponent(cal.startIso + "/" + cal.endIso)
    + "&details=" + encodeURIComponent(cal.details);
}

/** 核准信按鈕列：行事曆（身分）＋進入系統（通知單請至系統列印） */
function _approveActionButtonsHtml_(req, role, sysUrl) {
  var cal = _calendarDetailsForRole_(req, role);
  var calUrl = _googleCalendarUrl_(cal);
  var calLabel = cal ? ("加入行事曆（" + cal.titleTag + "）") : "加入行事曆";
  var calBtn = calUrl
    ? ('<a href="' + calUrl + '" style="background-color:#0f766e;color:#ffffff;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;margin:0 8px 8px 0;">' + calLabel + "</a>")
    : "";
  var sysBtn = '<a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;margin:0 8px 8px 0;">進入系統查看課表</a>';
  var printHint = '<p style="color:#64748b;font-size:13px;margin:12px 0 0;line-height:1.55;">通知單請登入系統 →「歷史紀錄」或案件詳情 →「印通知」列印教師聯／班級聯。</p>';
  return '<div style="margin:20px 0 8px;">' + calBtn + sysBtn + "</div>" + printHint;
}

/** 批次：多節各一則行事曆（調課＝調入節；標題已含自己班科） */
function _batchCalendarLinksHtml_(rows, role) {
  if (!rows || !rows.length) return "";
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var cal = _calendarDetailsForRole_(rows[i], role);
    if (!cal) continue;
    var url = _googleCalendarUrl_(cal);
    if (!url) continue;
    var label = cal.title || "加入行事曆";
    if (cal.startIso && cal.startIso.length >= 11) {
      var d = cal.startIso.substring(0, 4) + "-" + cal.startIso.substring(4, 6) + "-" + cal.startIso.substring(6, 8);
      label = d + "　" + label;
    }
    items.push(
      '<li style="margin-bottom:6px;">'
      + '<a href="' + url + '" style="color:#0f766e;font-weight:600;text-decoration:underline;">' + label + "</a>"
      + "</li>"
    );
  }
  if (!items.length) return "";
  return '<div style="margin:16px 0;padding:12px 14px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;">'
    + '<div style="font-weight:700;color:#0f766e;margin-bottom:8px;font-size:14px;">加入行事曆（調課＝調入節／自己的課）：</div>'
    + '<ul style="margin:0;padding-left:18px;color:#134e4a;font-size:13px;line-height:1.6;">' + items.join("") + "</ul>"
    + "</div>";
}

/**
 * 批次核准：一人一封異動信
 * - 同人若同時有調出／調入／代課，全部併在同一封
 * - 每筆依「此人是申請人或受邀人」用對應 role 產生一行
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

  // personKey -> { email, name, items: [{ req, role }] }
  var byPerson = {};
  var pushItem = function (emailRaw, nameRaw, req, role) {
    var em = normEm(emailRaw);
    if (!validEmail(em)) return;
    if (!byPerson[em]) {
      byPerson[em] = { email: emailRaw, name: nameRaw || "", items: [] };
    }
    if (nameRaw && !byPerson[em].name) byPerson[em].name = nameRaw;
    // 同一申請單同一 role 不重複
    var rid = String(req["申請單ID"] || req.id || "");
    var dup = byPerson[em].items.some(function (it) {
      return it.role === role && String(it.req["申請單ID"] || it.req.id || "") === rid;
    });
    if (!dup) byPerson[em].items.push({ req: req, role: role });
  };

  rows.forEach(function (req) {
    pushItem(
      req.requesterEmail || req["申請人Email"],
      req.requesterName || req["申請人姓名"],
      req,
      "leave"
    );
    pushItem(
      req.targetTeacherEmail || req["受邀人Email"],
      req.targetTeacherName || req["受邀人姓名"],
      req,
      "cover"
    );
  });

  Object.keys(byPerson).forEach(function (emKey) {
    var g = byPerson[emKey];
    var items = g.items || [];
    if (!items.length) return;
    var n = items.length;
    var hasEx = items.some(function (it) { return _isExchangeReq_(it.req); });
    var hasSub = items.some(function (it) { return !_isExchangeReq_(it.req); });
    var noun = hasEx && hasSub ? "調代課" : (hasEx ? "調課" : "代課");
    var subject = "【調代課系統】" + noun + "已核准生效（您有 " + n + " 項異動）";

    // 單一清單：依 items 順序串 li（避免兩段 ul 疊出大行距）
    var liParts = items.map(function (it) {
      return _buildApproveSlotListHtml_([it.req], { role: it.role, itemsOnly: true });
    }).join("");
    var listParts = liParts
      ? ('<ul style="padding-left:18px;color:#1e293b;font-size:14px;margin:6px 0 10px;list-style:disc;">' + liParts + "</ul>")
      : "";

    // 行事曆：調課用調入、代課用 cover／leave 對應
    var calHtml = "";
    var calItems = [];
    items.forEach(function (it) {
      var cal = _calendarDetailsForRole_(it.req, it.role);
      if (!cal) return;
      var url = _googleCalendarUrl_(cal);
      if (!url) return;
      var label = cal.title || "行事曆";
      if (cal.startIso && cal.startIso.length >= 11) {
        label = cal.startIso.substring(0, 4) + "-" + cal.startIso.substring(4, 6) + "-" + cal.startIso.substring(6, 8) + "　" + label;
      }
      calItems.push('<li style="margin-bottom:4px;"><a href="' + url + '" style="color:#0f766e;font-weight:600;text-decoration:underline;">' + label + "</a></li>");
    });
    if (calItems.length) {
      calHtml = '<div style="margin:14px 0;padding:10px 12px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;">'
        + '<div style="font-weight:700;color:#0f766e;margin-bottom:6px;font-size:13px;">加入行事曆</div>'
        + '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.55;">' + calItems.join("") + "</ul></div>";
    }

    var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + (g.name || "老師") + "</b> 老師，您好：</p>"
      + '<p style="color:#475569;margin-top:0;">以下 <b>' + n + "</b> 項異動已由教學組核准出單並生效：</p>"
      + listParts
      + calHtml
      + '<div style="margin:18px 0 8px;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看課表</a></div>'
      + '<p style="color:#64748b;font-size:13px;margin:8px 0 0;line-height:1.55;">通知單請登入系統 →「歷史紀錄」勾選後列印。</p>';
    var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 審核通過", "#059669", content);
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

/**
 * 單筆核准通知：請假方／代課方分寄，行事曆依身分（不用上／代課／調入）
 */
function sendAdminApproveEmail_(req, currentUrl) {
  var to1 = req.requesterEmail || req["申請人Email"];
  var to2 = req.targetTeacherEmail || req["受邀人Email"];
  var name1 = req.requesterName || req["申請人姓名"] || "老師";
  var name2 = req.targetTeacherName || req["受邀人姓名"] || "老師";
  var serial = req.serial || req["單號"] || "SUB";
  var sysUrl = currentUrl || "http://localhost:8000";
  var isExchange = !!(req.targetDate || req["對調目標日期"]
    || req.type === "exchange" || req["異動類型"] === "exchange" || req["異動類型"] === "對調");
  var subject = "【調代課系統】您的調代課申請已由教學組核准出單並生效 (" + serial + ")";

  var tips = '<div style="margin-top:24px;border-top:1px dashed #e2e8f0;padding-top:16px;">'
    + '<h4 style="color:#ef4444;margin:0 0 8px 0;font-size:15px;">貼心提醒：</h4>'
    + '<ul style="margin:0;padding-left:20px;color:#475569;font-size:14px;">'
    + '<li style="margin-bottom:6px;">請兩位教師確實向對方交代班級上課進度與常規要求。</li>'
    + '<li>實際上課教師請確實於該班教室日誌上簽章。</li>'
    + "</ul></div>";

  var table = _buildReqTable_(req);

  // 請假／調出方
  if (to1 && String(to1).indexOf("@") !== -1) {
    var roleLeave = "leave";
    var greetLeave = isExchange
      ? "您的調課案件已由教學組核准出單並生效。"
      : "您的代課案件已由教學組核准出單並生效。";
    var contentLeave = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + name1 + "</b> 老師，您好：</p>"
      + '<p style="color:#475569;margin-top:0;">' + greetLeave + "</p>"
      + table
      + tips
      + _approveActionButtonsHtml_(req, roleLeave, sysUrl);
    sendSystemEmail_(to1, subject, _wrapHtmlTemplate_("調代課線上系統 - 審核通過", "#10b981", contentLeave));
  }

  // 代課／調入方（若與請假同一人則略過，避免重複）
  if (to2 && String(to2).indexOf("@") !== -1
      && String(to2).toLowerCase().trim() !== String(to1 || "").toLowerCase().trim()) {
    var roleCover = "cover";
    var greetCover = isExchange
      ? "調課案件已由教學組核准出單並生效。"
      : "代課案件已由教學組核准出單並生效。";
    var contentCover = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + name2 + "</b> 老師，您好：</p>"
      + '<p style="color:#475569;margin-top:0;">' + greetCover + "</p>"
      + table
      + tips
      + _approveActionButtonsHtml_(req, roleCover, sysUrl);
    sendSystemEmail_(to2, subject, _wrapHtmlTemplate_("調代課線上系統 - 審核通過", "#10b981", contentCover));
  }
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

