// 學校調代課線上系統 - Google Apps Script 後端 API (純 Google Sheets + GSI 驗證版)

var _requestSpreadsheet_ = null;
var _requestSpreadsheetKey_ = "";

// 開啟/讀取試算表
function getSpreadsheet() {
  const prop = String(PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "").trim();
  const cacheKey = prop || "__active__";
  if (_requestSpreadsheet_ && _requestSpreadsheetKey_ === cacheKey) return _requestSpreadsheet_;
  if (prop) {
    _requestSpreadsheet_ = SpreadsheetApp.openById(prop);
    _requestSpreadsheetKey_ = cacheKey;
    return _requestSpreadsheet_;
  }
  if (getConfig_("ALLOW_ACTIVE_SPREADSHEET_FALLBACK", getActiveSpreadsheetFallbackDefault_()).toLowerCase() === "true") {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      _requestSpreadsheet_ = active;
      _requestSpreadsheetKey_ = cacheKey;
      return active;
    }
  }
  throw new Error("找不到可用的試算表；若此 GAS 未綁定 Google Sheet，請設定 SPREADSHEET_ID！");
}


// ----------------- 安全與效能設定 -----------------
function getActiveSpreadsheetFallbackDefault_() {
  return getConfig_("DEPLOYMENT_ENV", "development").toLowerCase() === "production" ? "false" : "true";
}

// 可在「專案設定 → 指令碼屬性」覆寫：DEPLOYMENT_ENV / EXPECTED_CLIENT_ID / ALLOWED_HD / ALLOW_MOCK_TOKEN
// SPREADSHEET_ID 可選：綁定試算表的 GAS 預設使用作用中試算表；獨立 Web App 再設定 SPREADSHEET_ID。
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
// 逗號分隔允許的 Workspace 網域（hd）；未設定時拒絕登入。
var ALLOWED_HD_ = getConfig_("ALLOWED_HD", "");
// 正式環境務必為 false；僅本機除錯時可在指令碼屬性設 ALLOW_MOCK_TOKEN=true
var ALLOW_MOCK_TOKEN_ = (getConfig_("ALLOW_MOCK_TOKEN", "false").toLowerCase() === "true");
// 預設禁止萬用網域；僅隔離測試環境可明確開啟。
var ALLOW_UNRESTRICTED_DOMAIN_ = (getConfig_("ALLOW_UNRESTRICTED_DOMAIN", "false").toLowerCase() === "true");
var SUPER_ADMIN_EMAILS_ = getConfig_("SUPER_ADMIN_EMAILS", "");
var PUBLIC_APP_URL_ = getConfig_("PUBLIC_APP_URL", "https://jcjh-timetable.vercel.app/");
// 全量／分層快取秒數（可於指令碼屬性覆寫）
var CACHE_TTL_FULL_ = parseInt(getConfig_("CACHE_TTL_FULL", "120"), 10) || 120; // admin 組裝後 payload
var CACHE_TTL_TEACHER_FULL_ = parseInt(getConfig_("CACHE_TTL_TEACHER_FULL", "60"), 10) || 60; // 教師共用底包（短 TTL）
var CACHE_TTL_SCHED_ = parseInt(getConfig_("CACHE_TTL_SCHED", "600"), 10) || 600; // 課表（少改）
var CACHE_TTL_TEACHERS_ = parseInt(getConfig_("CACHE_TTL_TEACHERS", "300"), 10) || 300;
var CACHE_TTL_META_ = parseInt(getConfig_("CACHE_TTL_META", "300"), 10) || 300;
var CACHE_TTL_REQ_ = parseInt(getConfig_("CACHE_TTL_REQ", "90"), 10) || 90; // 申請單時間窗
var CACHE_TTL_PENDING_ = parseInt(getConfig_("CACHE_TTL_PENDING", "45"), 10) || 45; // pendingOnly
var CACHE_TTL_MATCH_ = parseInt(getConfig_("CACHE_TTL_MATCH", "45"), 10) || 45; // 媒合候選短快取
var CACHE_SCHEMA_VERSION_ = "scheduleactive1";
var DATA_PAYLOAD_VERSION_ = "scheduleActive1";
var SCHOOL_SWAP_SHEET_ = "全校對調";

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

function parseEmailList_(raw) {
  return String(raw || "").split(/[,，;\s]+/).map(function (s) {
    return String(s || "").trim().toLowerCase();
  }).filter(Boolean);
}

function normalizeEmail_(raw, label) {
  var email = String(raw || "").trim().toLowerCase();
  if (!email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new Error((label || "Email") + "格式不正確！");
  }
  return email;
}

function getSuperAdminEmails_() {
  var out = parseEmailList_(SUPER_ADMIN_EMAILS_);
  try {
    var map = buildSettingsMap_();
    if (map && map.superAdminEmails) {
      out = out.concat(parseEmailList_(map.superAdminEmails));
    }
  } catch (e) {}
  var seen = {};
  return out.filter(function (email) {
    if (seen[email]) return false;
    seen[email] = true;
    return true;
  });
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
  var email = String(userEmail || "").trim().toLowerCase();
  var supers = getSuperAdminEmails_();
  if (supers.indexOf(email) !== -1) return "admin";
  if (!teachers || teachers.length === 0) {
    // 空教師名單不可再把第一個登入者自動升級為管理員。
    return "";
  }
  var currentTeacher = teachers.find(function (t) {
    return String(t["教師Email"] || t.email || t.loginEmail || "").trim().toLowerCase() === email;
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

function isTrueFlag_(raw) {
  if (raw === true || raw === 1) return true;
  var value = String(raw == null ? "" : raw).trim().toLowerCase();
  return value === "true" || value === "1" || value === "是" || value === "yes" || value === "y";
}

/** 登入前若客戶端學期過期，找出帳號實際所屬學期。 */
function findTeacherSemesterForLogin_(requestedSemesterId, userEmail) {
  var requested = String(requestedSemesterId || "").trim();
  var email = String(userEmail || "").trim().toLowerCase();
  if (!email) return "";

  var teacherRows = getTableData("教師名單") || [];
  var matches = teacherRows.filter(function (row) {
    var rowEmail = String(row["教師Email"] || row.email || row.loginEmail || "").trim().toLowerCase();
    var rowSemester = String(row["學期代號"] || row.semesterId || "").trim();
    return rowEmail === email && !!rowSemester;
  });
  if (!matches.length) return "";

  if (requested && matches.some(function (row) {
    return String(row["學期代號"] || row.semesterId || "").trim() === requested;
  })) {
    return requested;
  }

  var semesters = getTableData("學期設定") || [];
  var defaultSemester = semesters.find(function (row) {
    var flag = row["是否預設"] !== undefined ? row["是否預設"] : (row["預設"] !== undefined ? row["預設"] : row.isDefault);
    return isTrueFlag_(flag);
  });
  var defaultId = String(defaultSemester && (defaultSemester["學期代號"] || defaultSemester.id) || "").trim();
  if (defaultId && matches.some(function (row) {
    return String(row["學期代號"] || row.semesterId || "").trim() === defaultId;
  })) {
    return defaultId;
  }

  // 沒有預設學期時，採用教師名單中最後一筆所屬學期，通常是最新匯入的學期。
  return String(matches[matches.length - 1]["學期代號"] || matches[matches.length - 1].semesterId || "").trim();
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

// ----------------- 特殊流程契約 -----------------
var SPECIAL_FLOW_COMBINED_RETURN_ = "combined_return";
var SPECIAL_FLOW_COMBINED_RETURN_LABEL_ = "合班回原班";
var TRIANGLE_TYPE_ = "triangle";
var TRIANGLE_CONSENT_PENDING_ = "pending";
var TRIANGLE_CONSENT_AGREE_ = "agree";
var TRIANGLE_CONSENT_DECLINE_ = "decline";

function normalizeSpecialFlow_(value) {
  var raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (raw.toLowerCase() === SPECIAL_FLOW_COMBINED_RETURN_
      || raw === SPECIAL_FLOW_COMBINED_RETURN_LABEL_) {
    return SPECIAL_FLOW_COMBINED_RETURN_;
  }
  return raw;
}

function isCombinedReturnRequest_(row) {
  if (!row) return false;
  return normalizeSpecialFlow_(row["特殊流程"]) === SPECIAL_FLOW_COMBINED_RETURN_
    || normalizeSpecialFlow_(row.specialFlow) === SPECIAL_FLOW_COMBINED_RETURN_;
}

function isCombinedReturnFee_(fee) {
  var value = String(fee == null ? "" : fee).trim();
  return value === "公費代課" || value === "自費代課" || value === "第8節代課";
}

function isCombinedReturnPublicReason_(reason) {
  var value = String(reason == null ? "" : reason).trim();
  return value.indexOf("公假") >= 0
    || value.indexOf("公差") >= 0
    || value.indexOf("婚假") >= 0
    || value.indexOf("喪假") >= 0
    || value.indexOf("產前") >= 0
    || value.indexOf("分娩") >= 0
    || value.indexOf("身心調適") >= 0;
}

function combinedReturnExpectedFee_(row) {
  var period = parseInt(row && (row["異動節次"] != null ? row["異動節次"] : row.requestPeriod), 10);
  if (period === 8) return "第8節代課";
  var reason = row && (row["請假事由"] != null ? row["請假事由"] : row.reason);
  return isCombinedReturnPublicReason_(reason) ? "公費代課" : "自費代課";
}

function combinedReturnClassTokens_(value) {
  return String(value == null ? "" : value).trim().split(/[,，、\/／;；|｜&＆+＋\s]+/)
    .map(function (item) { return String(item || "").trim(); })
    .filter(Boolean);
}

function combinedReturnHasTag_(row, tag) {
  var raw = row && (row["特殊標記"] !== undefined ? row["特殊標記"] : row.specialTags);
  return String(raw == null ? "" : raw).split(/[,，、\/／;；|｜\s]+/)
    .map(function (item) { return String(item || "").trim(); })
    .indexOf(String(tag || "").trim()) >= 0;
}

function combinedReturnTeacherMatches_(row, name, email) {
  var wanted = [name, email].map(nameKeyNorm_).filter(Boolean);
  var actual = [row && row["教師姓名"], row && row.teacherName, row && row["教師Email"], row && row.teacherEmail]
    .map(nameKeyNorm_).filter(Boolean);
  return wanted.some(function (key) { return actual.indexOf(key) >= 0; });
}

function validateCombinedReturnTeacherSlot_(row, semesterId) {
  if (!semesterId) return;
  var dateText = String(row["異動日期"] || row.requestDate || "").trim().slice(0, 10);
  var period = parseInt(row["異動節次"] != null ? row["異動節次"] : row.requestPeriod, 10);
  var day = parseInt(row["異動星期"] != null ? row["異動星期"] : row.requestPeriodDay, 10);
  if (!day && dateText) {
    var date = new Date(dateText.replace(/-/g, "/"));
    if (!isNaN(date.getTime())) day = date.getDay() === 0 ? 7 : date.getDay();
  }
  if (!day || isNaN(period)) throw new Error("合班回原班缺少有效的日期或節次！");
  var requesterName = row["申請人姓名"] || row.requesterName || "";
  var requesterEmail = row["申請人Email"] || row.requesterEmail || "";
  var targetName = row["受邀人姓名"] || row.targetTeacherName || "";
  var targetEmail = row["受邀人Email"] || row.targetTeacherEmail || "";
  var classTokens = combinedReturnClassTokens_(row["班級"] || row.className);
  var schedules = (getTableData("教師課表") || []).filter(function (schedule) {
    return String(schedule["學期代號"] || schedule.semesterId || "").trim() === String(semesterId).trim()
      && parseInt(schedule["星期"] != null ? schedule["星期"] : schedule.dayOfWeek, 10) === day
      && parseInt(schedule["節次"] != null ? schedule["節次"] : schedule.period, 10) === period
      && scheduleActiveOnDate_(schedule, dateText);
  });
  var sourceRows = schedules.filter(function (schedule) {
    return combinedReturnTeacherMatches_(schedule, requesterName, requesterEmail);
  });
  var targetRows = schedules.filter(function (schedule) {
    return combinedReturnTeacherMatches_(schedule, targetName, targetEmail);
  });
  if (!sourceRows.length || !targetRows.length) {
    throw new Error("合班回原班的請假教師與代課教師必須同節有課！");
  }
  var validPair = sourceRows.some(function (source) {
    var sourceTokens = combinedReturnClassTokens_(source["班級"] || source.className);
    return targetRows.some(function (target) {
      var targetTokens = combinedReturnClassTokens_(target["班級"] || target.className);
      var sameClass = sourceTokens.concat(classTokens).some(function (name) {
        return targetTokens.indexOf(name) >= 0;
      });
      var markedPair = combinedReturnHasTag_(source, "併班") && combinedReturnHasTag_(target, "併班");
      return sameClass || markedPair;
    });
  });
  if (!validPair) throw new Error("合班回原班的代課教師必須是同節原本有課的併班任課教師！");
}

function validateCombinedReturnRequest_(row, semesterId) {
  if (!isCombinedReturnRequest_(row)) return;
  if (isPaperFlowValue_(row["紙本流程"]) || isPaperFlowValue_(row.paperFlow)) {
    throw new Error("合班回原班不可使用紙本流程！");
  }
  if (isPaperFlowValue_(row["直接核准"]) || isPaperFlowValue_(row.directApprove)) {
    throw new Error("合班回原班不可直接核准！");
  }
  if (isPaperFlowValue_(row["僅課務調整"]) || isPaperFlowValue_(row.courseAdjustmentOnly)) {
    throw new Error("合班回原班不可使用僅課務調整！");
  }
  var type = String(row["異動類型"] || row.type || "").trim().toLowerCase();
  if (type !== "substitution" && type !== "代課") {
    throw new Error("合班回原班只能使用代課類型！");
  }
  var targetName = String(row["受邀人姓名"] || row.targetTeacherName || "").trim();
  var targetEmail = String(row["受邀人Email"] || row.targetTeacherEmail || "").trim();
  if (!targetName && !targetEmail) throw new Error("合班回原班請指定同節併班代課教師！");
  var requesterName = String(row["申請人姓名"] || row.requesterName || "").trim();
  var requesterEmail = String(row["申請人Email"] || row.requesterEmail || "").trim();
  if ((targetEmail && requesterEmail && nameKeyNorm_(targetEmail) === nameKeyNorm_(requesterEmail))
      || (targetName && requesterName && nameKeyNorm_(targetName) === nameKeyNorm_(requesterName))) {
    throw new Error("合班回原班的請假教師與代課教師不可相同！");
  }
  var reason = String(row["請假事由"] || row.reason || "").trim();
  if (!reason || reason === SPECIAL_FLOW_COMBINED_RETURN_LABEL_ || reason === "併班上課"
      || reason === "課務調整" || reason === "空堂排班") {
    throw new Error("合班回原班請選擇實際的請假假別！");
  }
  var fee = String(row["經費來源"] || row.subFee || "").trim();
  var expectedFee = combinedReturnExpectedFee_(row);
  if (!isCombinedReturnFee_(fee) || fee !== expectedFee) {
    throw new Error("合班回原班請依假別使用" + expectedFee + "！");
  }
  var period = parseInt(row["異動節次"] != null ? row["異動節次"] : row.requestPeriod, 10);
  if (period === 8 && fee !== "第8節代課") {
    throw new Error("第8節合班回原班必須使用第8節代課！");
  }
  validateCombinedReturnTeacherSlot_(row, semesterId);
}

// ----------------- 姓名鍵資料契約 -----------------
// Domain sheets store names only. Email remains confined to 教師名單／auth／mail.
var NAME_KEY_DOMAIN_SHEETS_ = ["教師課表", "申請單", "代導紀錄", "額度帳本"];
var NAME_KEY_EMAIL_FIELDS_ = {
  "教師課表": ["教師Email", "teacherEmail"],
  "申請單": ["申請人Email", "受邀人Email", "代申請人Email", "requesterEmail", "targetTeacherEmail", "proxyByEmail"],
  "代導紀錄": ["原導師Email", "代導教師Email", "originalTeacherEmail", "actualTeacherEmail", "operatorEmail"],
  "額度帳本": ["教師Email", "email", "operatorEmail"]
};

function isNameKeyDomainSheet_(sheetName) {
  return NAME_KEY_DOMAIN_SHEETS_.indexOf(String(sheetName || "")) !== -1;
}

function nameKeyText_(value) {
  return String(value == null ? "" : value).trim();
}

function nameKeyNorm_(value) {
  return nameKeyText_(value).toLowerCase();
}

function nameKeySemester_(row, fallback) {
  return nameKeyText_((row && (row["學期代號"] !== undefined ? row["學期代號"] : row.semesterId)) || fallback);
}

function nameKeyDirectoryKey_(semesterId, value) {
  return nameKeyText_(semesterId) + "|" + nameKeyNorm_(value);
}

function nameKeyTeacherEmail_(teacher) {
  return nameKeyNorm_(teacher && (teacher["教師Email"] !== undefined ? teacher["教師Email"] : (teacher.email || teacher.loginEmail)));
}

function nameKeyTeacherName_(teacher) {
  return nameKeyText_(teacher && (teacher["教師姓名"] !== undefined ? teacher["教師姓名"] : (teacher.name || teacher.teacherName)));
}

function nameKeyEmailForName_(semesterId, name, directory) {
  var hit = directory.byName[nameKeyDirectoryKey_(semesterId, name)];
  return hit ? hit.email : "";
}

function buildNameKeyDirectory_(teacherRows) {
  var byName = {};
  var byEmail = {};
  var globalName = {};
  (teacherRows || []).forEach(function (teacher, index) {
    var sid = nameKeySemester_(teacher);
    var name = nameKeyTeacherName_(teacher);
    var email = nameKeyTeacherEmail_(teacher);
    if (!sid || !name) throw new Error("教師名單第" + (index + 1) + "列缺少學期代號或教師姓名");
    var nameKey = nameKeyDirectoryKey_(sid, name);
    if (byName[nameKey]) {
      throw new Error("同學期教師姓名重複：" + sid + "／" + name + "，已停止寫入");
    }
    var entry = { semesterId: sid, name: name, email: email, row: teacher, index: index };
    var globalNameKey = nameKeyNorm_(name);
    if (globalName[globalNameKey] && globalName[globalNameKey].email !== email) {
      throw new Error("教師姓名必須全歷史唯一：" + name + "，目前對應多個登入 Email，已停止寫入");
    }
    globalName[globalNameKey] = entry;
    byName[nameKey] = entry;
    if (email) {
      var emailKey = nameKeyDirectoryKey_(sid, email);
      if (byEmail[emailKey] && byEmail[emailKey].name !== name) {
        throw new Error("同學期教師 Email 對應多位教師：" + sid + "／" + email + "，已停止寫入");
      }
      byEmail[emailKey] = entry;
    }
  });
  return { byName: byName, byEmail: byEmail };
}

function assertTeacherRosterNameKeys_(rowsToSave) {
  var existing = getTableData("教師名單") || [];
  var merged = {};
  existing.forEach(function (row) {
    var sid = nameKeySemester_(row);
    var email = nameKeyTeacherEmail_(row);
    if (sid && email) merged[sid + "|" + email] = Object.assign({}, row);
  });
  (rowsToSave || []).forEach(function (row) {
    var sid = nameKeySemester_(row);
    var email = nameKeyTeacherEmail_(row);
    var name = nameKeyTeacherName_(row);
    if (!sid || !email || !name) throw new Error("教師名單資料必須包含學期代號、教師Email與教師姓名");
    var key = sid + "|" + email;
    merged[key] = Object.assign({}, merged[key] || {}, row, {
      "學期代號": sid,
      "教師Email": email,
      "教師姓名": name
    });
  });
  buildNameKeyDirectory_(Object.keys(merged).map(function (key) { return merged[key]; }));
}

function resolveNameKeyTeacher_(value, semesterId, directory, label, allowBlank) {
  var raw = nameKeyText_(value);
  if (!raw && allowBlank) return "";
  if (!raw) throw new Error((label || "教師") + "不可空白");
  var byName = directory.byName[nameKeyDirectoryKey_(semesterId, raw)];
  if (byName) return byName.name;
  var byEmail = directory.byEmail[nameKeyDirectoryKey_(semesterId, raw)];
  if (byEmail) return byEmail.name;
  throw new Error((label || "教師") + "無法對應目前學期教師名單：" + raw);
}

function resolveNameKeyPair_(nameValue, emailValue, semesterId, directory, label, allowBlank) {
  var name = nameKeyText_(nameValue);
  var email = nameKeyText_(emailValue);
  var fromName = name ? resolveNameKeyTeacher_(name, semesterId, directory, label, false) : "";
  var fromEmail = email ? resolveNameKeyTeacher_(email, semesterId, directory, label, false) : "";
  if (fromName && fromEmail && nameKeyNorm_(fromName) !== nameKeyNorm_(fromEmail)) {
    throw new Error((label || "教師") + "姓名與 Email 對應不一致：" + name + "／" + email);
  }
  if (!fromName && !fromEmail && allowBlank) return "";
  return fromName || fromEmail || resolveNameKeyTeacher_("", semesterId, directory, label, false);
}

function nameKeyPick_(row, names) {
  var source = row || {};
  for (var i = 0; i < names.length; i++) {
    var value = source[names[i]];
    if (value !== undefined && value !== null && nameKeyText_(value) !== "") return value;
  }
  return "";
}

function nameKeyDropEmailFields_(row, sheetName) {
  var out = Object.assign({}, row || {});
  var fields = NAME_KEY_EMAIL_FIELDS_[sheetName] || [];
  fields.forEach(function (field) { delete out[field]; });
  Object.keys(out).forEach(function (field) {
    if (/email|電子郵件|e-mail/i.test(field)) delete out[field];
  });
  return out;
}

function normalizeNameKeyDomainRow_(sheetName, row, teacherRows, fallbackSemesterId, directoryArg) {
  if (!isNameKeyDomainSheet_(sheetName)) return Object.assign({}, row || {});
  var source = Object.assign({}, row || {});
  var sid = nameKeySemester_(source, fallbackSemesterId);
  if (!sid) throw new Error(sheetName + "資料缺少學期代號");
  var directory = directoryArg || buildNameKeyDirectory_(teacherRows || getTableData("教師名單"));
  var out = nameKeyDropEmailFields_(source, sheetName);
  out["學期代號"] = sid;
  if (sheetName === "教師課表") {
    out["教師姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["教師姓名", "teacherName"]), nameKeyPick_(source, ["教師Email", "teacherEmail"]), sid, directory, "課表教師", false);
  } else if (sheetName === "申請單") {
    var combinedReturn = isCombinedReturnRequest_(source);
    out["申請人姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["申請人姓名", "requesterName"]), nameKeyPick_(source, ["申請人Email", "requesterEmail"]), sid, directory, "申請人", false);
    out["受邀人姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["受邀人姓名", "targetTeacherName"]), nameKeyPick_(source, ["受邀人Email", "targetTeacherEmail"]), sid, directory, "受邀人", true);
    if (combinedReturn) out["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
    out["代申請人姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["代申請人姓名", "proxyByName"]), nameKeyPick_(source, ["代申請人Email", "proxyByEmail"]), sid, directory, "代申請人", true);
  } else if (sheetName === "代導紀錄") {
    out["原導師姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["原導師姓名", "originalTeacherName"]), nameKeyPick_(source, ["原導師Email", "originalTeacherEmail"]), sid, directory, "原導師", false);
    out["代導教師姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["代導教師姓名", "actualTeacherName"]), nameKeyPick_(source, ["代導教師Email", "actualTeacherEmail"]), sid, directory, "代導教師", true);
    out["操作者"] = resolveNameKeyPair_(nameKeyPick_(source, ["操作者", "operatorName"]), nameKeyPick_(source, ["operatorEmail"]), sid, directory, "操作者", true);
  } else if (sheetName === "額度帳本") {
    out["教師姓名"] = resolveNameKeyPair_(nameKeyPick_(source, ["教師姓名", "name"]), nameKeyPick_(source, ["教師Email", "email"]), sid, directory, "額度教師", false);
    out["操作者"] = resolveNameKeyPair_(nameKeyPick_(source, ["操作者", "operatorName"]), nameKeyPick_(source, ["operatorEmail"]), sid, directory, "操作者", true);
    out["索引鍵"] = sid + "|" + nameKeyNorm_(out["教師姓名"]);
  }
  return out;
}

function normalizeNameKeyRows_(sheetName, rows, teacherRows, fallbackSemesterId) {
  var directory = buildNameKeyDirectory_(teacherRows || getTableData("教師名單"));
  return (rows || []).map(function (row) {
    return normalizeNameKeyDomainRow_(sheetName, row, teacherRows, fallbackSemesterId, directory);
  });
}

// Request actions still need Email internally for auth and mail routing; persistence remains name-only.
function prepareNameKeyRequestRow_(row, semesterId, teacherRows) {
  var source = Object.assign({}, row || {});
  var directory = buildNameKeyDirectory_(teacherRows || getTableData("教師名單"));
  var combinedReturn = isCombinedReturnRequest_(source);
  var requesterName = resolveNameKeyPair_(
    nameKeyPick_(source, ["申請人姓名", "requesterName"]),
    nameKeyPick_(source, ["申請人Email", "requesterEmail"]),
    semesterId, directory, "申請人", false
  );
  var targetRawName = nameKeyPick_(source, ["受邀人姓名", "targetTeacherName"]);
  var targetRawEmail = nameKeyPick_(source, ["受邀人Email", "targetTeacherEmail"]);
  var targetName = resolveNameKeyPair_(targetRawName, targetRawEmail, semesterId, directory, "受邀人", false);
  var proxyRaw = nameKeyPick_(source, ["代申請人姓名", "proxyByName", "代申請人Email", "proxyByEmail"]);
  var proxyName = proxyRaw
    ? resolveNameKeyPair_(
      nameKeyPick_(source, ["代申請人姓名", "proxyByName"]),
      nameKeyPick_(source, ["代申請人Email", "proxyByEmail"]),
      semesterId, directory, "代申請人", true
    )
    : "";
  var requesterEmail = nameKeyEmailForName_(semesterId, requesterName, directory);
  var targetEmail = nameKeyEmailForName_(semesterId, targetName, directory);
  var proxyEmail = proxyName ? nameKeyEmailForName_(semesterId, proxyName, directory) : "";
  if (!requesterEmail || !targetEmail) throw new Error("教師名單缺少申請人或受邀人的登入 Email");

  source["學期代號"] = semesterId;
  source["申請人姓名"] = requesterName;
  source["受邀人姓名"] = targetName;
  if (combinedReturn) source["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
  source["代申請人姓名"] = proxyName;
  // Internal compatibility fields are removed by normalizeNameKeyDomainRow_ before persistence.
  source["申請人Email"] = requesterEmail;
  source["受邀人Email"] = targetEmail;
  source["代申請人Email"] = proxyEmail;
  source.requesterName = requesterName;
  source.targetTeacherName = targetName;
  source.proxyByName = proxyName;
  source.requesterEmail = requesterEmail;
  source.targetTeacherEmail = targetEmail;
  source.proxyByEmail = proxyEmail;
  return source;
}

function nameKeyCanonicalHeaders_(sheetName) {
  var map = {
    "教師課表": ["學期代號", "課表ID", "教師姓名", "星期", "節次", "班級", "科目", "課堂屬性", "調課限制", "特殊標記", "啟用起日", "啟用迄日"],
    "申請單": ["學期代號", "申請單ID", "單號", "批次ID", "狀態", "直接核准", "紙本流程", "申請人姓名", "受邀人姓名", "代申請人姓名", "班級", "科目", "異動日期", "異動星期", "異動節次", "異動類型", "特殊流程", "對調目標日期", "對調目標星期", "對調目標節次", "對調目標班級", "對調目標科目", "三角調ID", "三角腳次", "三角同意狀態", "三角同意時間", "三角組狀態", "經費來源", "請假事由", "請假時間類型", "請假時間", "是否已印", "備註", "建立時間", "更新時間"],
    "代導紀錄": ["學期代號", "代導紀錄ID", "來源申請單ID", "原導師姓名", "班級", "代導日期", "請假時間類型", "請假時間", "代導教師姓名", "代導節數", "鐘點費", "狀態", "啟用", "建立時間", "更新時間", "操作者", "備註"],
    "額度帳本": ["學期代號", "流水ID", "時間", "教師姓名", "異動", "餘額後", "類型", "包ID", "事件ID", "事件名稱", "起日", "迄日", "申請單ID", "操作者", "備註", "索引鍵"]
  };
  return (map[sheetName] || []).slice();
}

function nameKeyPublicRow_(sheetName, row) {
  if (!isNameKeyDomainSheet_(sheetName)) return row;
  var out = {};
  var fields = NAME_KEY_EMAIL_FIELDS_[sheetName] || [];
  Object.keys(row || {}).forEach(function (field) {
    if (fields.indexOf(field) !== -1 || /email|電子郵件|e-mail/i.test(field)) return;
    out[field] = row[field];
  });
  return out;
}

function nameKeyPublicRows_(sheetName, rows) {
  return (rows || []).map(function (row) { return nameKeyPublicRow_(sheetName, row); });
}

// Internal compatibility aliases let legacy business rules run without persisting Email columns.
function hydrateNameKeyDomainRow_(sheetName, row) {
  if (!isNameKeyDomainSheet_(sheetName) || !row) return row;
  var teacherRows = getTableData("教師名單") || [];
  var directory = buildNameKeyDirectory_(teacherRows);
  var sid = nameKeySemester_(row);
  if (!sid) return row;
  var resolve = function (name, email, label, allowBlank) {
    return resolveNameKeyPair_(name, email, sid, directory, label, allowBlank);
  };
  if (sheetName === "教師課表") {
    row["教師姓名"] = resolve(row["教師姓名"] || row.teacherName, row["教師Email"] || row.teacherEmail, "課表教師", false);
    row["教師Email"] = nameKeyEmailForName_(sid, row["教師姓名"], directory) || nameKeyNorm_(row["教師Email"] || row.teacherEmail);
    row.teacherName = row["教師姓名"];
    row.teacherEmail = row["教師Email"];
  } else if (sheetName === "申請單") {
    var combinedReturnHydrate = isCombinedReturnRequest_(row);
    row["申請人姓名"] = resolve(row["申請人姓名"] || row.requesterName, row["申請人Email"] || row.requesterEmail, "申請人", false);
    // 舊有合班紀錄可能沒有代課教師，讀取時保留可見性；新寫入由送出驗證強制補齊。
    row["受邀人姓名"] = resolve(row["受邀人姓名"] || row.targetTeacherName, row["受邀人Email"] || row.targetTeacherEmail, "受邀人", true);
    if (combinedReturnHydrate) row["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
    row["代申請人姓名"] = resolve(row["代申請人姓名"] || row.proxyByName, row["代申請人Email"] || row.proxyByEmail, "代申請人", true);
    row["申請人Email"] = nameKeyEmailForName_(sid, row["申請人姓名"], directory) || nameKeyNorm_(row["申請人Email"] || row.requesterEmail);
    row["受邀人Email"] = nameKeyEmailForName_(sid, row["受邀人姓名"], directory) || nameKeyNorm_(row["受邀人Email"] || row.targetTeacherEmail);
    row["代申請人Email"] = row["代申請人姓名"] ? (nameKeyEmailForName_(sid, row["代申請人姓名"], directory) || nameKeyNorm_(row["代申請人Email"] || row.proxyByEmail)) : "";
    row.requesterName = row["申請人姓名"];
    row.targetTeacherName = row["受邀人姓名"];
    row.proxyByName = row["代申請人姓名"] || "";
    row.requesterEmail = row["申請人Email"];
    row.targetTeacherEmail = row["受邀人Email"];
    row.proxyByEmail = row["代申請人Email"];
  } else if (sheetName === "代導紀錄") {
    row["原導師姓名"] = resolve(row["原導師姓名"] || row.originalTeacherName, row["原導師Email"] || row.originalTeacherEmail, "原導師", false);
    row["代導教師姓名"] = resolve(row["代導教師姓名"] || row.actualTeacherName, row["代導教師Email"] || row.actualTeacherEmail, "代導教師", true);
    row["操作者"] = resolve(row["操作者"] || row.operatorName, row.operatorEmail, "操作者", true);
    row["原導師Email"] = nameKeyEmailForName_(sid, row["原導師姓名"], directory) || nameKeyNorm_(row["原導師Email"] || row.originalTeacherEmail);
    row["代導教師Email"] = row["代導教師姓名"] ? (nameKeyEmailForName_(sid, row["代導教師姓名"], directory) || nameKeyNorm_(row["代導教師Email"] || row.actualTeacherEmail)) : "";
    row.originalTeacherName = row["原導師姓名"];
    row.actualTeacherName = row["代導教師姓名"] || "";
    row.originalTeacherEmail = row["原導師Email"];
    row.actualTeacherEmail = row["代導教師Email"];
    row.operatorName = row["操作者"] || "";
  } else if (sheetName === "額度帳本") {
    row["教師姓名"] = resolve(row["教師姓名"] || row.name, row["教師Email"] || row.email, "額度教師", false);
    row["操作者"] = resolve(row["操作者"] || row.operatorName, row.operatorEmail, "操作者", true);
    row["教師Email"] = nameKeyEmailForName_(sid, row["教師姓名"], directory) || nameKeyNorm_(row["教師Email"] || row.email);
    row.email = row["教師Email"];
    row.name = row["教師姓名"];
    row.operatorName = row["操作者"] || "";
    row["索引鍵"] = sid + "|" + nameKeyNorm_(row["教師姓名"]);
  }
  return row;
}

function nameKeyRawRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { headers: [], rows: [] };
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (value) { return nameKeyText_(value); });
  var rows = values.slice(1).map(function (valuesRow) {
    var row = {};
    headers.forEach(function (header, index) { if (header) row[header] = valuesRow[index]; });
    return row;
  }).filter(function (row) {
    return Object.keys(row).some(function (field) { return row[field] !== "" && row[field] !== null && row[field] !== undefined; });
  });
  return { headers: headers, rows: rows };
}

function migrateNameKeySchema_() {
  var ss = getSpreadsheet();
  var teacherSheet = ss.getSheetByName("教師名單");
  if (!teacherSheet) throw new Error("找不到教師名單，無法進行姓名鍵 migration");
  var teacherRaw = nameKeyRawRows_(teacherSheet).rows;
  buildNameKeyDirectory_(teacherRaw);
  var prepared = [];
  NAME_KEY_DOMAIN_SHEETS_.forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var raw = nameKeyRawRows_(sheet);
    var rows = raw.rows.map(function (row) {
      return normalizeNameKeyDomainRow_(sheetName, row, teacherRaw, row["學期代號"]);
    });
    var canonical = nameKeyCanonicalHeaders_(sheetName);
    var extra = raw.headers.filter(function (header) {
      return header && canonical.indexOf(header) === -1 && !/email|電子郵件|e-mail/i.test(header);
    });
    prepared.push({ sheet: sheet, sheetName: sheetName, headers: canonical.concat(extra), rows: rows });
  });
  prepared.forEach(function (item) {
    var values = [item.headers].concat(item.rows.map(function (row) {
      return item.headers.map(function (header) { return translateCellForSheet_(item.sheetName, header, row[header] === undefined ? "" : row[header]); });
    }));
    item.sheet.clearContents();
    item.sheet.getRange(1, 1, values.length, item.headers.length).setValues(values);
    item.sheet.getRange(1, 1, 1, item.headers.length).setFontWeight("bold").setBackground("#f1f5f9");
  });
  _tableDataMem_ = {};
  _headersMem_ = {};
  prepared.forEach(function (item) { bustTableDataMem_(item.sheetName); });
  (getTableData("學期設定") || []).forEach(function (semester) {
    invalidateScheduleCaches_(semester["學期代號"] || semester.id || "");
  });
  return prepared.map(function (item) { return { sheet: item.sheetName, count: item.rows.length, headers: item.headers }; });
}

function renameTeacherNameKey_(semesterId, fromName, toName) {
  var sid = nameKeyText_(semesterId);
  var from = nameKeyText_(fromName);
  var to = nameKeyText_(toName);
  if (!sid || !from || !to) throw new Error("改名需要學期、原姓名與新姓名");
  if (nameKeyNorm_(from) === nameKeyNorm_(to)) throw new Error("新舊姓名不可相同");
  NAME_KEY_DOMAIN_SHEETS_.forEach(function (sheetName) {
    var headers = getHeadersForSheet(sheetName);
    if (headers.some(function (header) { return /email|電子郵件|e-mail/i.test(String(header || "")); })) {
      throw new Error("工作表「" + sheetName + "」仍是舊 Email schema，請先執行姓名鍵資料遷移");
    }
  });

  var teacherRows = getTableData("教師名單") || [];
  var directory = buildNameKeyDirectory_(teacherRows);
  var source = directory.byName[nameKeyDirectoryKey_(sid, from)];
  if (!source || !source.email) throw new Error("找不到目前學期教師或教師缺少登入 Email：" + from);
  var sourceEmail = source.email;
  var affectedSemesters = {};
  var nextTeachers = teacherRows.map(function (row) {
    var next = Object.assign({}, row);
    if (nameKeyTeacherEmail_(next) === sourceEmail) {
      affectedSemesters[nameKeySemester_(next)] = true;
      next["教師姓名"] = to;
    }
    return next;
  });
  // 先檢查所有學期，避免改名後才發現某一學期撞名。
  buildNameKeyDirectory_(nextTeachers);

  var relationFields = {
    "教師課表": [["教師姓名", "教師Email"]],
    "申請單": [["申請人姓名", "申請人Email"], ["受邀人姓名", "受邀人Email"], ["代申請人姓名", "代申請人Email"]],
    "代導紀錄": [["原導師姓名", "原導師Email"], ["代導教師姓名", "代導教師Email"], ["操作者", "operatorEmail"]],
    "額度帳本": [["教師姓名", "教師Email"], ["操作者", "operatorEmail"]]
  };
  var related = {};
  var changedCounts = {};
  NAME_KEY_DOMAIN_SHEETS_.forEach(function (sheetName) {
    var rows = getTableData(sheetName) || [];
    var fields = relationFields[sheetName] || [];
    var changed = 0;
    related[sheetName] = rows.map(function (row) {
      var next = Object.assign({}, row);
      var rowSid = nameKeySemester_(next);
      var rowDirectory = directory;
      fields.forEach(function (pair) {
        var nameField = pair[0];
        var emailField = pair[1];
        var currentName = nameKeyText_(next[nameField]);
        var currentEmail = emailField ? nameKeyNorm_(next[emailField]) : "";
        var nameBelongsToSource = currentName
          && nameKeyNorm_(nameKeyEmailForName_(rowSid, currentName, rowDirectory)) === sourceEmail;
        if (currentEmail === sourceEmail || nameBelongsToSource) {
          next[nameField] = to;
          changed++;
        }
      });
      if (sheetName === "額度帳本" && nameKeyText_(next["教師姓名"])) {
        next["索引鍵"] = rowSid + "|" + nameKeyNorm_(next["教師姓名"]);
      }
      return next;
    });
    changedCounts[sheetName] = changed;
  });

  saveRows("教師名單", nextTeachers, "教師Email");
  NAME_KEY_DOMAIN_SHEETS_.forEach(function (sheetName) {
    if (related[sheetName]) saveRows(sheetName, related[sheetName], {
      "教師課表": "課表ID",
      "申請單": "申請單ID",
      "代導紀錄": "代導紀錄ID",
      "額度帳本": "流水ID"
    }[sheetName]);
  });
  Object.keys(affectedSemesters).forEach(function (affectedSid) {
    invalidateScheduleCaches_(affectedSid);
  });
  return {
    semesterId: sid,
    fromName: from,
    toName: to,
    loginEmail: sourceEmail,
    counts: changedCounts
  };
}

function assertTeacherNameKeyCanDelete_(semesterId, teacherEmail) {
  var sid = nameKeyText_(semesterId);
  var email = nameKeyNorm_(teacherEmail);
  var teacher = (getTableData("教師名單") || []).find(function (row) {
    return nameKeySemester_(row) === sid && nameKeyTeacherEmail_(row) === email;
  });
  if (!teacher) return;
  var name = nameKeyNorm_(nameKeyTeacherName_(teacher));
  var fieldsBySheet = {
    "教師課表": ["教師姓名"],
    "申請單": ["申請人姓名", "受邀人姓名", "代申請人姓名"],
    "代導紀錄": ["原導師姓名", "代導教師姓名", "操作者"],
    "額度帳本": ["教師姓名", "操作者"]
  };
  NAME_KEY_DOMAIN_SHEETS_.forEach(function (sheetName) {
    (getTableData(sheetName) || []).forEach(function (row) {
      if (nameKeySemester_(row) !== sid) return;
      (fieldsBySheet[sheetName] || []).forEach(function (field) {
        if (nameKeyNorm_(row[field]) === name) {
          throw new Error("教師「" + nameKeyTeacherName_(teacher) + "」仍被「" + sheetName + "」使用，請改名或停用，不要刪除");
        }
      });
    });
  });
}

function sheetsReady_() {
  var ss = getSpreadsheet();
  var need = ["學期設定", "教師名單", "教師課表", "申請單", "系統設定", "空堂事件", "代導紀錄", SCHOOL_SWAP_SHEET_];
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
  var cachedHeaders = _headersMem_[sheetName];
  if (cachedHeaders) return cachedHeaders;
  const defaults = {
    "學期設定": ["學期代號", "學期名稱", "開始日期", "結束日期", "結算日期", "是否預設"],
    // Teacher roster keeps login Email; the four domain sheets use names as relation keys.
    "教師名單": ["學期代號", "教師Email", "教師姓名", "授課科目", "職務", "鐘點支出計畫", "系統角色", "基本鐘點", "折抵額度"],
    "教師課表": ["學期代號", "課表ID", "教師姓名", "星期", "節次", "班級", "科目", "課堂屬性", "調課限制", "特殊標記", "啟用起日", "啟用迄日"],
    "申請單": ["學期代號", "申請單ID", "單號", "批次ID", "狀態", "直接核准", "紙本流程", "申請人姓名", "受邀人姓名", "代申請人姓名", "班級", "科目", "異動日期", "異動星期", "異動節次", "異動類型", "特殊流程", "對調目標日期", "對調目標星期", "對調目標節次", "對調目標班級", "對調目標科目", "三角調ID", "三角腳次", "三角同意狀態", "三角同意時間", "三角組狀態", "經費來源", "請假事由", "請假時間類型", "請假時間", "是否已印", "備註", "建立時間", "更新時間"],
    "空堂事件": ["學期代號", "事件ID", "事件名稱", "起日", "迄日", "班級清單", "鐘點規則", "可進互代", "啟用", "備註"],
    "代導紀錄": ["學期代號", "代導紀錄ID", "來源申請單ID", "原導師姓名", "班級", "代導日期", "請假時間類型", "請假時間", "代導教師姓名", "代導節數", "鐘點費", "狀態", "啟用", "建立時間", "更新時間", "操作者", "備註"],
    "全校對調": ["學期代號", "對調ID", "事件名稱", "日期A", "星期A", "節次A", "日期B", "星期B", "節次B", "啟用", "建立時間", "更新時間", "操作者", "備註"],
    // Ledger truth: index = semester|teacher name; roster quota remains a cache.
    "額度帳本": ["學期代號", "流水ID", "時間", "教師姓名", "異動", "餘額後", "類型", "包ID", "事件ID", "事件名稱", "起日", "迄日", "申請單ID", "操作者", "備註", "索引鍵"],
    "系統設定": ["設定名稱", "設定值"]
  };
  
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (sheet && sheet.getLastRow() > 0) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var defaultHeaders = defaults[sheetName] || [];
    // Do not silently mix old Email schema with the new schema. Migration owns the rewrite.
    if (isNameKeyDomainSheet_(sheetName) && headers.some(function (header) {
      return /email|電子郵件|e-mail/i.test(String(header || ""));
    })) {
      _headersMem_[sheetName] = headers;
      return headers;
    }
    defaultHeaders.forEach(function (h) {
      if (headers.indexOf(h) === -1) {
        headers.push(h);
        sheet.getRange(1, headers.length).setValue(h).setFontWeight("bold").setBackground("#f1f5f9");
      }
    });
    _headersMem_[sheetName] = headers;
    return headers;
  }
  _headersMem_[sheetName] = defaults[sheetName] || [];
  return _headersMem_[sheetName];
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
         oldName === "代導紀錄" ||
         oldName === SCHOOL_SWAP_SHEET_ ||
        oldName === "系統日誌" || oldName === "操作日誌" ||
        oldName === "課表匯入暫存" || oldName === "課表匯入備份" ||
        oldName === "教師匯入備份") {
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
  const sheets = ["學期設定","教師名單","教師課表","申請單","空堂事件","額度帳本","代導紀錄",SCHOOL_SWAP_SHEET_,"系統設定","系統日誌"];
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
function isTimestampField_(headerName) {
  return ["建立時間", "更新時間", "申請時間", "建立日期", "申請日期"].indexOf(String(headerName || "").trim()) >= 0;
}

function rowArrayToObject_(sheetName, headers, row) {
  const obj = {};
  let hasValue = false;
  for (let j = 0; j < headers.length; j++) {
    let val = row[j];
    if (val instanceof Date) {
      val = isTimestampField_(headers[j]) ? toLocalTimeStr(val) : toLocalDateStr(val);
    }
    if (sheetName === "申請單" || sheetName === "代導紀錄") {
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
  return hasValue ? hydrateNameKeyDomainRow_(sheetName, obj) : null;
}

// 同一次 doPost／doGet 內的服務物件與資料快取。
var _tableDataMem_ = {}; // sheetName -> rows[]
var _headersMem_ = {}; // sheetName -> headers[]
var _scheduleImportWriteContext_ = false;
function resetRequestContext_() {
  _requestSpreadsheet_ = null;
  _requestSpreadsheetKey_ = "";
  _tableDataMem_ = {};
  _headersMem_ = {};
  _scheduleImportWriteContext_ = false;
}

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
  if (name === "教師課表" && !_scheduleImportWriteContext_) assertScheduleReadable_();
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
 * 申請單欄位掃描：先用 raw 欄位過濾，命中才 rowArrayToObject_（減少物件化成本）
 * opts.mode: 'pending' | 'window' | 'month' | 'all'
 * opts.cutoffYmd: window 用 YYYY-MM-DD
 * opts.monthStr: month 用 YYYY-MM
 * @returns {{ rows: Object[], allCount: number }}
 */
function scanRequestsFromSheet_(semesterId, opts) {
  opts = opts || {};
  var mode = opts.mode || "all";
  var sid = String(semesterId || "");
  var cutoffYmd = opts.cutoffYmd ? String(opts.cutoffYmd).slice(0, 10) : "";
  var monthStr = opts.monthStr ? String(opts.monthStr).slice(0, 7) : "";
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName("申請單");
  if (!sheet) return { rows: [], allCount: 0 };
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) return { rows: [], allCount: 0 };
  var headers = values[0];
  var col = {};
  var hi;
  for (hi = 0; hi < headers.length; hi++) {
    var h = String(headers[hi] || "").trim();
    if (h) col[h] = hi;
  }
  var iSem = col["學期代號"];
  var iSt = col["狀態"];
  var iDate = col["異動日期"];
  var iTgt = col["對調目標日期"];
  var iCreated = col["建立時間"];
  var out = [];
  var allCount = 0;
  var i;
  for (i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row) continue;
    if (iSem != null && sid && String(row[iSem] || "") !== sid) continue;
    allCount++;
    // 試算表可能存中文狀態（待行政審核）；須先轉英文再比
    var stRaw = iSt != null ? String(row[iSt] || "").trim() : "";
    var st = String(translateStatusToEn(stRaw) || stRaw).toLowerCase().trim();
    if (mode === "pending") {
      if (st !== "pending_teacher" && st !== "pending_admin") continue;
    } else if (mode === "window") {
      if (st === "pending_teacher" || st === "pending_admin") {
        // keep：進行中一律保留（不論中英文狀態欄）
      } else if (cutoffYmd) {
        var dWin = iDate != null ? String(row[iDate] || "").slice(0, 10) : "";
        if (!dWin && iCreated != null) dWin = String(row[iCreated] || "").slice(0, 10);
        // 日期欄若為 Date 物件，slice 會失效；轉字串
        if (dWin && dWin.indexOf("T") >= 0) dWin = dWin.slice(0, 10);
        if (dWin && dWin.length > 10) dWin = dWin.slice(0, 10);
        if (dWin && dWin < cutoffYmd) continue;
      }
    } else if (mode === "month") {
      if (!monthStr) continue;
      var d1 = iDate != null ? String(row[iDate] || "").slice(0, 7) : "";
      var d2 = iTgt != null ? String(row[iTgt] || "").slice(0, 7) : "";
      var d3 = iCreated != null ? String(row[iCreated] || "").slice(0, 7) : "";
      if (d1 !== monthStr && d2 !== monthStr && d3 !== monthStr) continue;
    }
    // mode === 'all'：學期內全收
    var obj = rowArrayToObject_("申請單", headers, row);
    if (obj) out.push(obj);
  }
  return { rows: out, allCount: allCount };
}

/** 只取出進行中申請（pending） */
function getPendingRequestsFromSheet_(semesterId) {
  return scanRequestsFromSheet_(semesterId, { mode: "pending" }).rows;
}

/** 指定月份申請（歷史 tab；不建 historyAll） */
function getMonthRequestsFromSheet_(semesterId, monthStr) {
  return scanRequestsFromSheet_(semesterId, { mode: "month", monthStr: monthStr }).rows;
}

// 欄位別名讀取
function pickFieldValue_(obj, headerName) {
  const fieldAliases = {
    "授課科目": ["任課科目"],
    "任課科目": ["授課科目"],
    "鐘點支出計畫": ["鐘點支出來源", "支出計畫", "計畫"],
    "鐘點支出來源": ["鐘點支出計畫", "支出計畫", "計畫"],
    "原授課教師Email": ["原任課教師Email"],
    "原任課教師Email": ["原授課教師Email"],
    "啟用起日": ["啟用開始日", "activeFrom", "activationStartDate", "effectiveStartDate"],
    "啟用迄日": ["啟用結束日", "activeTo", "activationEndDate", "effectiveEndDate"]
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
  if (sheetName === "申請單" || sheetName === "代導紀錄") {
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

function isSemesterScopedSheet_(sheetName) {
  return ["教師名單", "教師課表", "申請單", "空堂事件", "額度帳本", "代導紀錄", SCHOOL_SWAP_SHEET_].indexOf(sheetName) !== -1;
}

function rowKeyForSheet_(sheetName, row, keyName) {
  var key = row && row[keyName] != null ? row[keyName] : "";
  if (isSemesterScopedSheet_(sheetName) && keyName !== "學期代號") {
    return String(row["學期代號"] || "").trim() + "|" + String(key || "").trim().toLowerCase();
  }
  return String(key == null ? "" : key);
}

// 批次儲存/更新（增量：只更新變更列或 append，避免整表 clearContents）
function saveRows(sheetName, rowsToSave, keyName) {
  if (isNameKeyDomainSheet_(sheetName)) {
    var teacherRowsForWrite = getTableData("教師名單") || [];
    rowsToSave = normalizeNameKeyRows_(sheetName, rowsToSave || [], teacherRowsForWrite);
  } else if (sheetName === "教師名單") {
    rowsToSave = rowsToSave || [];
    assertTeacherRosterNameKeys_(rowsToSave);
  } else {
    rowsToSave = rowsToSave || [];
  }
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headers = getHeadersForSheet(sheetName);
  if (!headers || headers.length === 0) return;
  if (isNameKeyDomainSheet_(sheetName) && headers.some(function (header) {
    return /email|電子郵件|e-mail/i.test(String(header || ""));
  })) {
    throw new Error("工作表「" + sheetName + "」仍是舊 Email schema，請先執行姓名鍵 migration；原資料未刪除");
  }

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
  if (isSemesterScopedSheet_(sheetName) && keyName !== "學期代號") {
    // 學期內 key 才唯一，跨學期必須使用複合 key。
    const numDataRows = lastRow - 1;
    if (numDataRows > 0 && (rowsToSave || []).length <= 40) {
      // 小批量只讀學期欄與 key 欄，避免先將整張表物件化。
      const semesterCol = headers.indexOf("學期代號") + 1;
      const keyVals = sheet.getRange(2, keyCol, numDataRows, 1).getValues();
      const semesterVals = semesterCol > 0
        ? sheet.getRange(2, semesterCol, numDataRows, 1).getValues()
        : null;
      for (var si = 0; si < keyVals.length; si++) {
        var rawKey = keyVals[si][0];
        if (rawKey === "" || rawKey === null || rawKey === undefined) continue;
        var rawSemester = semesterVals ? semesterVals[si][0] : "";
        var existingKey = String(rawSemester || "").trim() + "|" + String(rawKey).trim().toLowerCase();
        if (existingKey !== "|") keyToRow[existingKey] = si + 2;
      }
    } else if (numDataRows > 0) {
      getTableData(sheetName).forEach(function (existing, idx) {
        var existingKey = rowKeyForSheet_(sheetName, existing, keyName);
        if (existingKey !== "|") keyToRow[existingKey] = idx + 2;
      });
    }
  } else if (lastRow >= 2) {
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
    var k0 = rowKeyForSheet_(sheetName, row, keyName);
    if (keyToRow[k0] && !seenNeed[k0]) {
      seenNeed[k0] = 1;
      keysNeed.push(k0);
    }
  });
  if (nSave > 40) {
    // 大批：一次全表（比 N 次 getRange 省）
    getTableData(sheetName).forEach(function (row) {
      if (row[keyName] !== undefined && row[keyName] !== null && row[keyName] !== "") {
        existingMap[rowKeyForSheet_(sheetName, row, keyName)] = row;
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
        var bk = rowKeyForSheet_(sheetName, objB, keyName);
        if (bk !== "|") existingMap[bk] = objB;
      }
      rStart = rEnd + 1;
    }
  }

  const toAppend = [];
  // 更新列先收集，再依 row 排序後連續區段一次 setValues（少 API 往返）
  const toUpdate = []; // { rowNum, arr }
  rowsToSave.forEach(function (row) {
    if (sheetName === "申請單" || sheetName === "代導紀錄") {
      if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
      // 每次寫入刷新更新時間（增量 softRefresh 水位線）
      row["更新時間"] = toLocalTimeStr(new Date());
    }
    const key = rowKeyForSheet_(sheetName, row, keyName);
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
  if (sheetName === "申請單" || sheetName === "代導紀錄") {
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
  data.forEach(function (row) { dataMap[rowKeyForSheet_(sheetName, row, keyName)] = row; });
  rowsToSave.forEach(function (row) {
    if (sheetName === "申請單" || sheetName === "代導紀錄") {
      if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
      row["更新時間"] = toLocalTimeStr(new Date());
    }
    var rowKey = rowKeyForSheet_(sheetName, row, keyName);
    dataMap[rowKey] = Object.assign({}, dataMap[rowKey] || {}, row);
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

function deleteSheetRowsDescending_(sheet, targets) {
  var seen = {};
  var rows = (targets || []).map(function (row) { return parseInt(row, 10); }).filter(function (row) {
    if (!row || seen[row]) return false;
    seen[row] = true;
    return true;
  }).sort(function (a, b) { return b - a; });
  var i = 0;
  while (i < rows.length) {
    var end = rows[i];
    var start = end;
    i++;
    while (i < rows.length && rows[i] === start - 1) {
      start = rows[i];
      i++;
    }
    var count = end - start + 1;
    if (typeof sheet.deleteRows === "function") sheet.deleteRows(start, count);
    else for (var row = end; row >= start; row--) sheet.deleteRow(row);
  }
}

// 刪除特定行（增量：連續列合併成一次 deleteRows）
function deleteRows(sheetName, keyName, keyValue, rowFilter) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const headers = getHeadersForSheet(sheetName);
  const keyCol = headers.indexOf(keyName) + 1;
  if (keyCol < 1) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  // getRange(row, column, numRows, numColumns)
  if (typeof rowFilter === "function") {
    var values = sheet.getDataRange().getValues();
    var targets = [];
    var targetKey = String(keyValue);
    for (var fi = 1; fi < values.length; fi++) {
      var filteredRow = rowArrayToObject_(sheetName, headers, values[fi]);
      if (!filteredRow || String(filteredRow[keyName]) !== targetKey) continue;
      if (rowFilter(filteredRow)) targets.push(fi + 1);
    }
    deleteSheetRowsDescending_(sheet, targets);
    bustTableDataMem_(sheetName);
    if (sheetName === "系統設定") bustSettingsMapCache_();
    return;
  }
  const keyVals = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
  const target = String(keyValue);
  var targetsByKey = [];
  for (var i = keyVals.length - 1; i >= 0; i--) {
    if (String(keyVals[i][0]) === target) {
      targetsByKey.push(i + 2);
    }
  }
  deleteSheetRowsDescending_(sheet, targetsByKey);
  bustTableDataMem_(sheetName);
  if (sheetName === "系統設定") bustSettingsMapCache_();
}

function deleteRowsBySemester_(sheetName, semesterId) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var headers = getHeadersForSheet(sheetName);
  var semCol = headers.indexOf("學期代號");
  if (semCol < 0) return 0;
  var values = sheet.getDataRange().getValues();
  var sid = String(semesterId || "");
  var targets = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][semCol] == null ? "" : values[i][semCol]).trim() === sid) targets.push(i + 1);
  }
  deleteSheetRowsDescending_(sheet, targets);
  if (targets.length) bustTableDataMem_(sheetName);
  return targets.length;
}

/**
 * 依 key 只讀一列（核准／同意／撤回熱路徑，避免全表 getTableData）
 * @returns {Object|null}
 */
function findRowByKey_(sheetName, keyName, keyValue, semesterId) {
  var map = findRowsByKeys_(sheetName, keyName, [keyValue], semesterId);
  var k = String(keyValue == null ? "" : keyValue);
  return map[k] || null;
}

/**
 * 依 key 一次取多列；只掃 key 欄＋讀命中列
 * @returns {Object} keyString -> rowObject
 */
function findRowsByKeys_(sheetName, keyName, keyValues, semesterId) {
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
  var sidFilter = semesterId == null ? null : String(semesterId || "").trim();
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
      if (sidFilter !== null && String(obj["學期代號"] || "").trim() !== sidFilter) continue;
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
function putCacheEntries_(cache, entries, expirationSeconds) {
  var keys = Object.keys(entries || {});
  if (!keys.length) return;
  if (typeof cache.putAll === "function") {
    try {
      cache.putAll(entries, expirationSeconds);
      return;
    } catch (e) {}
  }
  keys.forEach(function (key) {
    cache.put(key, entries[key], expirationSeconds);
  });
}

function getCacheEntries_(cache, keys) {
  var list = (keys || []).filter(Boolean);
  if (!list.length) return {};
  if (typeof cache.getAll === "function") {
    try {
      return cache.getAll(list) || {};
    } catch (e) {}
  }
  var out = {};
  list.forEach(function (key) {
    var value = cache.get(key);
    if (value !== null && value !== undefined) out[key] = value;
  });
  return out;
}

function removeCacheEntries_(cache, keys) {
  var list = (keys || []).filter(Boolean);
  if (!list.length) return;
  // Keep batches small so a large invalidation remains compatible with CacheService limits.
  for (var start = 0; start < list.length; start += 100) {
    var batch = list.slice(start, start + 100);
    if (typeof cache.removeAll === "function") {
      try {
        cache.removeAll(batch);
        continue;
      } catch (e) {}
    }
    batch.forEach(function (key) { cache.remove(key); });
  }
}

function putCacheChunked(key, value, expirationSeconds) {
  const cache = CacheService.getScriptCache();
  const chunkSize = 90 * 1024; // 90KB limit
  if (value.length <= chunkSize) {
    var single = {};
    single[key] = value;
    single[key + "_chunks"] = "1";
    putCacheEntries_(cache, single, expirationSeconds);
  } else {
    const numChunks = Math.ceil(value.length / chunkSize);
    var chunks = {};
    chunks[key + "_chunks"] = numChunks.toString();
    for (let i = 0; i < numChunks; i++) {
      chunks[key + "_part_" + i] = value.substring(i * chunkSize, (i + 1) * chunkSize);
    }
    putCacheEntries_(cache, chunks, expirationSeconds);
  }
}

function getCacheChunked(key) {
  const cache = CacheService.getScriptCache();
  const chunksVal = cache.get(key + "_chunks");
  if (!chunksVal) return null;
  const numChunks = parseInt(chunksVal);
  if (!numChunks || numChunks < 1) return null;
  if (numChunks === 1) {
    return cache.get(key);
  }
  const partKeys = [];
  for (let i = 0; i < numChunks; i++) partKeys.push(key + "_part_" + i);
  const parts = getCacheEntries_(cache, partKeys);
  let fullValue = "";
  for (let i = 0; i < partKeys.length; i++) {
    const chunk = parts[partKeys[i]];
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
  var removeKeys = [key + "_chunks"];
  if (numChunks === 1) {
    removeKeys.push(key);
  } else {
    for (let i = 0; i < numChunks; i++) removeKeys.push(key + "_part_" + i);
  }
  removeCacheEntries_(cache, removeKeys);
}

function removeCacheChunkedMany_(keys) {
  var list = Array.from(new Set((keys || []).filter(Boolean)));
  if (!list.length) return;
  var cache = CacheService.getScriptCache();
  var markerKeys = list.map(function (key) { return key + "_chunks"; });
  var markers = getCacheEntries_(cache, markerKeys);
  var removeKeys = [];
  list.forEach(function (key) {
    var marker = markers[key + "_chunks"];
    if (!marker) return;
    var numChunks = parseInt(marker);
    removeKeys.push(key + "_chunks");
    if (numChunks === 1) {
      removeKeys.push(key);
    } else if (numChunks > 1) {
      for (var i = 0; i < numChunks; i++) removeKeys.push(key + "_part_" + i);
    }
  });
  removeCacheEntries_(cache, removeKeys);
}

function getCacheGeneration_(namespace, semesterId) {
  var key = "jcjh_gen_" + CACHE_SCHEMA_VERSION_ + "_" + String(namespace || "data") + "_" + String(semesterId || "");
  var cache = CacheService.getScriptCache();
  var value = cache.get(key);
  if (value) return String(value);
  cache.put(key, "0", 21600);
  return "0";
}

function bumpCacheGeneration_(namespace, semesterId) {
  var key = "jcjh_gen_" + CACHE_SCHEMA_VERSION_ + "_" + String(namespace || "data") + "_" + String(semesterId || "");
  var cache = CacheService.getScriptCache();
  var previous = parseInt(cache.get(key) || "0", 10) || 0;
  var next = String(Math.max(Date.now(), previous + 1));
  cache.put(key, next, 21600);
  return next;
}

var SCHEDULE_IMPORT_STAGING_SHEET_ = "課表匯入暫存";
var SCHEDULE_IMPORT_BACKUP_SHEET_ = "課表匯入備份";
var TEACHER_IMPORT_BACKUP_SHEET_ = "教師匯入備份";

function createScheduleImportVersion_() {
  return "sched_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function getOrCreateScheduleImportSheet_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  return sheet || spreadsheet.insertSheet(sheetName);
}

function writeRowsInChunks_(sheet, startRow, headers, rows, chunkSize) {
  var list = rows || [];
  var width = (headers || []).length;
  var size = chunkSize || 500;
  for (var i = 0; i < list.length; i += size) {
    var block = list.slice(i, i + size);
    sheet.getRange(startRow + i, 1, block.length, width).setValues(block);
  }
}

function writeScheduleSnapshotSheet_(sheet, headers, rows) {
  var headerList = headers || [];
  if (!sheet || !headerList.length) throw new Error("課表快照缺少工作表或欄位");
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headerList.length).setValues([headerList]);
  sheet.getRange(1, 1, 1, headerList.length).setFontWeight("bold").setBackground("#f1f5f9");
  writeRowsInChunks_(sheet, 2, headerList, rows || [], 500);
}

function writeScheduleImportBackupSheet_(sheet, headers, rows, version, semesterId, sourceSheet) {
  var backupHeaders = ["備份版本", "備份時間", "來源學期", "來源工作表"].concat(headers || []);
  var stamp = toLocalTimeStr(new Date());
  var backupRows = (rows || []).map(function (row) {
    return [String(version || ""), stamp, String(semesterId || ""), String(sourceSheet || "")].concat(row);
  });
  writeScheduleSnapshotSheet_(sheet, backupHeaders, backupRows);
  return { version: String(version || ""), count: backupRows.length, timestamp: stamp };
}

function restoreScheduleImportSnapshots_(scheduleSheet, scheduleHeaders, scheduleRows,
    teacherSheet, teacherHeaders, teacherRows) {
  writeScheduleSnapshotSheet_(scheduleSheet, scheduleHeaders, scheduleRows || []);
  if (teacherSheet && teacherHeaders && teacherHeaders.length) {
    writeScheduleSnapshotSheet_(teacherSheet, teacherHeaders, teacherRows || []);
  }
  bustTableDataMem_("教師課表");
  bustTableDataMem_("教師名單");
}

function isPatrolScheduleRow_(row) {
  if (!row) return false;
  return [row["課堂屬性"], row["班級"], row["科目"], row.attr, row.className, row.subject]
    .some(function (value) { return String(value || "").trim().indexOf("巡堂") >= 0; });
}

function normalizePatrolScheduleRow_(row) {
  if (!isPatrolScheduleRow_(row)) return row;
  var normalized = Object.assign({}, row);
  normalized["班級"] = "";
  normalized["科目"] = "";
  normalized["課堂屬性"] = "巡堂";
  normalized["調課限制"] = "";
  normalized["特殊標記"] = "";
  return normalized;
}

function normalizeScheduleDate_(raw, label) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]" && !isNaN(raw.getTime())) {
    return toLocalDateStr(raw);
  }
  var text = String(raw).trim().split(/[T ]/)[0].replace(/\//g, "-");
  var match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error((label || "課表啟用日期") + "格式必須為 YYYY-MM-DD！");
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  var date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error((label || "課表啟用日期") + "不是有效日期！");
  }
  return match[1] + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function scheduleDateField_(row, names) {
  var source = row || {};
  for (var i = 0; i < names.length; i++) {
    if (source[names[i]] !== undefined && source[names[i]] !== null && String(source[names[i]]).trim() !== "") {
      return source[names[i]];
    }
  }
  return "";
}

function scheduleActiveFrom_(row, strict) {
  var raw = scheduleDateField_(row, ["啟用起日", "啟用開始日", "activeFrom", "activationStartDate", "effectiveStartDate"]);
  if (!raw) return "";
  try { return normalizeScheduleDate_(raw, "啟用起日"); } catch (e) { if (strict) throw e; return ""; }
}

function scheduleActiveTo_(row, strict) {
  var raw = scheduleDateField_(row, ["啟用迄日", "啟用結束日", "activeTo", "activationEndDate", "effectiveEndDate"]);
  if (!raw) return "";
  try { return normalizeScheduleDate_(raw, "啟用迄日"); } catch (e) { if (strict) throw e; return ""; }
}

/** 空白起訖日代表整個目前學期有效。 */
function scheduleActiveOnDate_(row, dateRaw) {
  var date = normalizeScheduleDate_(dateRaw, "課表查詢日期");
  var rawFrom = scheduleDateField_(row, ["啟用起日", "啟用開始日", "activeFrom", "activationStartDate", "effectiveStartDate"]);
  var rawTo = scheduleDateField_(row, ["啟用迄日", "啟用結束日", "activeTo", "activationEndDate", "effectiveEndDate"]);
  var from = scheduleActiveFrom_(row, false);
  var to = scheduleActiveTo_(row, false);
  if ((rawFrom && !from) || (rawTo && !to)) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return (!from || !to || from <= to);
}

function scheduleDateRange_(semesterId) {
  var sid = String(semesterId || "").trim();
  var semester = (getTableData("學期設定") || []).find(function (row) {
    return String(row["學期代號"] || row.id || "").trim() === sid;
  });
  if (!semester) return { start: "", end: "" };
  return {
    start: normalizeScheduleDate_(semester["開始日期"] || semester.startDate || "", "學期開始日期"),
    end: normalizeScheduleDate_(semester["結束日期"] || semester.endDate || "", "學期結束日期")
  };
}

function scheduleSlotKey_(row) {
  var name = String(row["教師姓名"] || row.teacherName || row["教師Email"] || row.teacherEmail || "").trim().toLowerCase();
  var day = parseInt(row["星期"] != null ? row["星期"] : row.dayOfWeek, 10);
  var period = parseInt(row["節次"] != null ? row["節次"] : row.period, 10);
  var cls = String(row["班級"] != null ? row["班級"] : row.className || "").trim().toLowerCase();
  var attr = String(row["課堂屬性"] != null ? row["課堂屬性"] : row.attr || "").trim();
  var parity = attr === "單週" ? "single" : (attr === "雙週" ? "double" : "all");
  return [name, day, period, cls, parity].join("|");
}

function scheduleSlotGroupKey_(row) {
  var name = String(row["教師姓名"] || row.teacherName || row["教師Email"] || row.teacherEmail || "").trim().toLowerCase();
  var day = parseInt(row["星期"] != null ? row["星期"] : row.dayOfWeek, 10);
  var period = parseInt(row["節次"] != null ? row["節次"] : row.period, 10);
  var attr = String(row["課堂屬性"] != null ? row["課堂屬性"] : row.attr || "").trim();
  var parity = attr === "單週" ? "single" : (attr === "雙週" ? "double" : "all");
  return [name, day, period, parity].join("|");
}

function scheduleClassTokens_(row) {
  return String(row && (row["班級"] != null ? row["班級"] : row.className) || "").trim()
    .split(/[,，、\/／;；|｜\s]+/)
    .map(function (value) { return String(value || "").trim().toLowerCase(); })
    .filter(Boolean);
}

function scheduleClassesOverlap_(a, b) {
  var bSet = Object.create(null);
  scheduleClassTokens_(b).forEach(function (value) { bSet[value] = true; });
  return scheduleClassTokens_(a).some(function (value) { return !!bSet[value]; });
}

function scheduleRangesOverlap_(a, b) {
  var aFrom = scheduleActiveFrom_(a, true) || "0000-01-01";
  var aTo = scheduleActiveTo_(a, true) || "9999-12-31";
  var bFrom = scheduleActiveFrom_(b, true) || "0000-01-01";
  var bTo = scheduleActiveTo_(b, true) || "9999-12-31";
  return aFrom <= bTo && bFrom <= aTo;
}

function schedulePreviousDate_(dateText) {
  var date = new Date(String(dateText || "").replace(/-/g, "/"));
  if (isNaN(date.getTime())) throw new Error("課表啟用起日不是有效日期！");
  date.setDate(date.getDate() - 1);
  return toLocalDateStr(date);
}

function scheduleRowId_(row) {
  return String(row && (row["課表ID"] != null ? row["課表ID"] : row.id) || "").trim();
}

function validateScheduleImportRows_(rows, semesterId, options) {
  options = options || {};
  var list = Array.isArray(rows) ? rows : [];
  var sid = String(semesterId || "").trim();
  var errors = [];
  var seenIds = Object.create(null);
  var seenSlots = Object.create(null);
  var seenPatrolSlots = Object.create(null);
  var existingRows = Array.isArray(options.existingRows) ? options.existingRows : [];
  var semesterRange = options.semesterRange || { start: "", end: "" };
  var ignoredIds = Object.create(null);
  (options.ignoreIds || []).forEach(function (id) {
    var key = String(id || "").trim();
    if (key) ignoredIds[key] = true;
  });

  existingRows.forEach(function (existing) {
    if (!existing) return;
    if (ignoredIds[scheduleRowId_(existing)]) return;
    var isPatrol = isPatrolScheduleRow_(existing);
    var day = parseInt(existing["星期"] != null ? existing["星期"] : existing.dayOfWeek, 10);
    var period = parseInt(existing["節次"] != null ? existing["節次"] : existing.period, 10);
    if (isPatrol) {
      var patrolKey = [day, period].join("|");
      if (!seenPatrolSlots[patrolKey]) seenPatrolSlots[patrolKey] = [];
      seenPatrolSlots[patrolKey].push(existing);
    } else {
      var slotKey = scheduleSlotGroupKey_(existing);
      if (!seenSlots[slotKey]) seenSlots[slotKey] = [];
      seenSlots[slotKey].push(existing);
    }
  });

  if (!sid) errors.push("缺少學期代號");
  if (!list.length) errors.push("匯入清單為空");

  for (var i = 0; i < list.length; i++) {
    var row = normalizePatrolScheduleRow_(list[i] || {});
    list[i] = row;
    var rowErrors = [];
    var rowSid = String(row["學期代號"] || "").trim();
    var id = String(row["課表ID"] || "").trim();
    var name = String(row["教師姓名"] || "").trim();
    var legacyEmail = String(row["教師Email"] || "").trim();
    var dayRaw = String(row["星期"] == null ? "" : row["星期"]).trim();
    var periodRaw = String(row["節次"] == null ? "" : row["節次"]).trim();
    var className = String(row["班級"] || "").trim();
    var subject = String(row["科目"] || "").trim();
    var attr = String(row["課堂屬性"] || "").trim().toLowerCase();
    var restriction = String(row["調課限制"] || "").trim().toLowerCase();
    var isPatrol = isPatrolScheduleRow_(row);
    var day = parseInt(dayRaw, 10);
    var period = parseInt(periodRaw, 10);
    var activeFrom = "";
    var activeTo = "";
    try {
      activeFrom = scheduleActiveFrom_(row, true);
      activeTo = scheduleActiveTo_(row, true);
    } catch (dateError) {
      rowErrors.push(dateError.message || "啟用日期格式錯誤");
    }

    if (rowSid !== sid) rowErrors.push("學期不一致");
    if (!id) rowErrors.push("缺少課表ID");
    if (!name) rowErrors.push("缺少教師姓名");
    if (legacyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(legacyEmail)) rowErrors.push("教師Email不正確");
    if (!/^\d+$/.test(dayRaw) || day < 1 || day > 5) rowErrors.push("星期須為1至5");
    if (!/^\d+$/.test(periodRaw) || !(period === 0 || period === 45 || (period >= 1 && period <= 8))) rowErrors.push("節次須為0至8或45");
    if (!isPatrol && !className) rowErrors.push("缺少班級");
    if (!isPatrol && !subject) rowErrors.push("缺少科目");
    if (id && seenIds[id]) rowErrors.push("課表ID重複");
    if (activeFrom && activeTo && activeFrom > activeTo) rowErrors.push("啟用起日不可晚於啟用迄日");
    if (semesterRange.start && activeFrom && activeFrom < semesterRange.start) rowErrors.push("啟用起日不在學期範圍內");
    if (semesterRange.end && activeFrom && activeFrom > semesterRange.end) rowErrors.push("啟用起日不在學期範圍內");
    if (semesterRange.start && activeTo && activeTo < semesterRange.start) rowErrors.push("啟用迄日不在學期範圍內");
    if (semesterRange.end && activeTo && activeTo > semesterRange.end) rowErrors.push("啟用迄日不在學期範圍內");

    if (activeFrom) row["啟用起日"] = activeFrom;
    if (activeTo) row["啟用迄日"] = activeTo;

    if (isPatrol) {
      var patrolSlotKey = [day, period].join("|");
      var patrolPrevious = (day && period ? (seenPatrolSlots[patrolSlotKey] || []) : []);
      if (patrolPrevious.some(function (previous) { return scheduleRangesOverlap_(previous, row); })) {
        rowErrors.push("同一星期與節次只能安排一位巡堂教師（啟用期間重疊）");
      }
      if (!rowErrors.length && day && period) patrolPrevious.push(row);
      if (day && period) seenPatrolSlots[patrolSlotKey] = patrolPrevious;
    } else {
      var slotKey = scheduleSlotGroupKey_(row);
      var previous = (name && day && period && className ? (seenSlots[slotKey] || []) : []);
      if (previous.some(function (prior) {
        return scheduleClassesOverlap_(prior, row) && scheduleRangesOverlap_(prior, row);
      })) {
        rowErrors.push("同一教師／時段／班級／科目重複：啟用期間重疊");
      }
      if (!rowErrors.length && name && day && period && className) previous.push(row);
      if (name && day && period && className) seenSlots[slotKey] = previous;
    }

    if (rowErrors.length) {
      errors.push("第" + (i + 1) + "列：" + rowErrors.join("、"));
      continue;
    }
    seenIds[id] = true;
  }

  if (errors.length) {
    var suffix = errors.length > 8 ? "；另有" + (errors.length - 8) + "項" : "";
    throw new Error("課表匯入資料驗證失敗：" + errors.slice(0, 8).join("；") + suffix);
  }
  return { count: list.length, versionable: true };
}

function scheduleImportStateKey_(semesterId) {
  return "jcjh_schedule_import_" + String(semesterId || "");
}

function scheduleImportActiveKey_() {
  return "jcjh_schedule_import_active";
}

function setScheduleImportState_(semesterId, state) {
  var cache = CacheService.getScriptCache();
  var activeKey = scheduleImportActiveKey_();
  if (cache.get(activeKey)) {
    throw new Error("已有課表匯入正在處理或前次匯入未完成，請稍後再試");
  }
  var stateValue = String(state || "writing");
  var payload = JSON.stringify({
    semesterId: String(semesterId || ""),
    state: stateValue,
    startedAt: Date.now()
  });
  cache.put(scheduleImportStateKey_(semesterId), stateValue, 180);
  cache.put(activeKey, payload, 180);
}

function clearScheduleImportState_(semesterId) {
  removeCacheEntries_(CacheService.getScriptCache(), [scheduleImportStateKey_(semesterId), scheduleImportActiveKey_()]);
}

function getScheduleImportState_(semesterId) {
  return CacheService.getScriptCache().get(scheduleImportStateKey_(semesterId)) || "";
}

function isScheduleImportInProgress_() {
  return !!CacheService.getScriptCache().get(scheduleImportActiveKey_());
}

function assertScheduleReadable_(semesterId) {
  if (isScheduleImportInProgress_() || (semesterId && getScheduleImportState_(semesterId))) {
    throw new Error("課表匯入處理中，請稍後再試");
  }
}

/** 清除公開班級課表快取（核准／寫入後立即失效） */
function clearPublicClassCache_(semesterId) {
  try {
    var cache = CacheService.getScriptCache();
    var sid = String(semesterId || "");
    bumpCacheGeneration_("public", sid);
    // 記錄過的班級 key 清單
    var listKey = "jcjh_pub_keys_" + sid;
    var raw = cache.get(listKey);
    var removeKeys = [];
    if (raw) {
      try {
        var keys = JSON.parse(raw);
        if (Array.isArray(keys) && keys.length) {
          removeKeys = keys;
        }
      } catch (e) {}
    }
    removeCacheChunkedMany_(removeKeys.concat(["jcjh_pub_" + sid + "_"]));
    removeCacheEntries_(cache, [listKey]);
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
  bumpCacheGeneration_("data", sid);
  var cacheKeys = [];
  try {
    [7, 14, 21, 30, 60, 90, 120].forEach(function (d) {
      cacheKeys.push("jcjh_data_" + sid + "_admin_w" + d);
      cacheKeys.push("jcjh_data_" + sid + "_teacher_w" + d);
      cacheKeys.push("jcjh_data_" + DATA_PAYLOAD_VERSION_ + "_" + sid + "_admin_w" + d);
      cacheKeys.push("jcjh_data_" + DATA_PAYLOAD_VERSION_ + "_" + sid + "_teacher_w" + d);
      cacheKeys.push("jcjh_req_" + sid + "_w" + d);
      cacheKeys.push("jcjh_reqonly_" + sid + "_admin_w" + d);
      cacheKeys.push("jcjh_reqonly_" + sid + "_teacher_w" + d);
    });
  } catch (ign) {}
  cacheKeys.push("jcjh_data_" + sid);
  cacheKeys.push("jcjh_data_" + sid + "_admin");
  cacheKeys.push("jcjh_data_" + sid + "_teacher");
  cacheKeys.push("jcjh_req_" + sid + "_all");
  cacheKeys.push("jcjh_pending_" + sid + "_a");
  cacheKeys.push("jcjh_pending_v2_" + sid + "_a");
  cacheKeys.push("jcjh_pending_v3_namekey_" + sid + "_a");
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
      cacheKeys.push("jcjh_hist_" + sid + "_" + ym + "_a");
    }
  } catch (ignH) {}
  removeCacheChunkedMany_(cacheKeys);
  clearPublicClassCache_(sid);
}

/** 課表／教師結構變更 */
function invalidateScheduleCaches_(semesterId) {
  var sid = String(semesterId || "");
  removeCacheChunkedMany_([
    "jcjh_sched_" + CACHE_SCHEMA_VERSION_ + "_" + sid,
    "jcjh_school_swap_" + CACHE_SCHEMA_VERSION_ + "_" + sid,
    "jcjh_teachers_" + sid,
    "jcjh_meta_" + sid,
    "jcjh_away_" + sid
  ]);
  invalidateRequestCaches_(semesterId);
}

/** 寫入後：預設清申請＋公開；大改課表請用 invalidateScheduleCaches_ */
function invalidateSemesterCaches_(semesterId) {
  invalidateRequestCaches_(semesterId);
  removeCacheChunkedMany_(["jcjh_meta_" + String(semesterId || "")]);
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
      "調課限制": s["調課限制"] || s.restriction || "",
      "特殊標記": s["特殊標記"] || s.specialTags || s.specialTagsText || "",
      "啟用起日": s["啟用起日"] || s.activeFrom || s.activationStartDate || s.effectiveStartDate || "",
      "啟用迄日": s["啟用迄日"] || s.activeTo || s.activationEndDate || s.effectiveEndDate || ""
    };
  });
}

/** 教師列瘦身：只留前端 mapTeacher 需要的欄 */
function slimTeacherRows_(rows, fallbackSemesterId) {
  return (rows || []).map(function (t) {
    if (!t) return t;

    return {
      "學期代號": t["學期代號"] || t.semesterId || fallbackSemesterId || "",
      "教師Email": t["教師Email"] || t.email || "",
      "教師姓名": t["教師姓名"] || t.name || "",
      "授課科目": t["授課科目"] || t["任課科目"] || t.subject || "",
      "職務": t["職務"] || t.jobTitle || "",
      "鐘點支出計畫": t["鐘點支出計畫"] || t["鐘點支出來源"] || t["支出計畫"] || t["計畫"] || t.expensePlan || t.plan || "",
      "系統角色": normalizeRole_(t["系統角色"] || t.role || "teacher"),
      "基本鐘點": t["基本鐘點"] != null && t["基本鐘點"] !== "" ? t["基本鐘點"] : (t.baseHours != null ? t.baseHours : 16),
      "折抵額度": t["折抵額度"] != null && t["折抵額度"] !== "" ? t["折抵額度"] : (t.mutualQuota != null ? t.mutualQuota : 0)
    };
  });
}

/** 回傳給已登入使用者的教師資料，避免一般角色取得額度與內部設定。 */
function sanitizeTeacherRowsForReader_(rows, readerEmail, isAdmin, isStaff) {
  var normalized = slimTeacherRows_(rows || []);
  if (isAdmin) return normalized;
  var me = String(readerEmail || "").toLowerCase().trim();
  return normalized.map(function (t) {
    return {
      "教師Email": t["教師Email"] || "",
      "教師姓名": t["教師姓名"] || "",
      "授課科目": t["授課科目"] || "",
      // 行政需要角色來顯示授權對象；一般教師一律視為普通教師。
      "系統角色": isStaff ? normalizeRole_(t["系統角色"] || "teacher") : "teacher",
      "目前登入者": String(t["教師Email"] || "").toLowerCase().trim() === me
    };
  });
}

/** 設定只回傳前端必要欄位，禁止把 mail API／super admin 名單下發。 */
function sanitizeSettingsForReader_(settings, readerEmail, isAdmin, isStaff, teachers) {
  var raw = settings || {};
  var onlineRaw = raw.onlineSubstitutionEnabled;
  var onlineEnabled = true;
  if (onlineRaw !== undefined && onlineRaw !== null && String(onlineRaw).trim() !== "") {
    var onlineText = String(onlineRaw).trim().toLowerCase();
    onlineEnabled = !(onlineRaw === false || onlineText === "false" || onlineText === "0"
      || onlineText === "no" || onlineText === "否" || onlineText === "關" || onlineText === "off");
  }
  var out = {
    allowedHd: raw.allowedHd || raw.ALLOWED_HD || "",
    onlineSubstitutionEnabled: onlineEnabled
  };
  if (isAdmin) {
    var granted = parseEmailList_(raw.proxySubmitEmails || raw.PROXY_SUBMIT_EMAILS || "");
    out.proxySubmitEmails = granted.join(",");
    out.proxySubmitEnabled = granted.length > 0;
    out.proxySubmitEnabledBy = raw.proxySubmitEnabledBy || "";
    out.proxySubmitEnabledAt = raw.proxySubmitEnabledAt || "";
  } else if (isStaff && canUserProxySubmit_(readerEmail, teachers || [])) {
    // 行政只需要知道自己是否被授權，不需要看到其他行政的 Email。
    out.proxySubmitEmails = String(readerEmail || "").toLowerCase().trim();
    out.proxySubmitEnabled = true;
  } else {
    out.proxySubmitEmails = "";
    out.proxySubmitEnabled = false;
  }
  return out;
}

/** 分層讀取：課表（長 TTL）— 快取存瘦身列 */
function getSemesterSchedulesCached_(semesterId) {
  var key = "jcjh_sched_" + CACHE_SCHEMA_VERSION_ + "_" + String(semesterId || "");
  assertScheduleReadable_(semesterId);
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var cached = JSON.parse(raw);
      if (Array.isArray(cached)) return slimScheduleRows_(cached);
    } catch (e) {}
  }
  var rows = getTableData("教師課表").filter(function (s) { return String(s["學期代號"] || "").trim() === String(semesterId || "").trim(); });
  var slim = slimScheduleRows_(rows);
  try { putCacheChunked(key, JSON.stringify(slim), CACHE_TTL_SCHED_); } catch (e2) {}
  return slim;
}


function schoolSwapPick_(row, names) {
  var source = row || {};
  for (var i = 0; i < names.length; i++) {
    var value = source[names[i]];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function schoolSwapEnabled_(row) {
  if (!row) return false;
  var raw = schoolSwapPick_(row, ["啟用", "enabled"]);
  if (raw === "" || raw === null || raw === undefined) return true;
  var text = String(raw).trim().toLowerCase();
  return !(raw === false || text === "false" || text === "0" || text === "否"
    || text === "no" || text === "停用" || text === "off");
}

function schoolSwapDate_(raw, label) {
  var value = raw;
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    value = toLocalDateStr(value);
  }
  var text = String(value == null ? "" : value).trim().slice(0, 10);
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error((label || "日期") + "格式必須為 YYYY-MM-DD！");
  var year = parseInt(match[1], 10);
  var month = parseInt(match[2], 10);
  var day = parseInt(match[3], 10);
  var date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error((label || "日期") + "不是有效日期！");
  }
  return text;
}

function schoolSwapWeekdayForDate_(dateStr) {
  var parts = String(dateStr || "").split("-").map(function (value) { return parseInt(value, 10); });
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  var day = date.getDay();
  return day === 0 ? 7 : day;
}

function schoolSwapPeriod_(raw, label) {
  var period = parseInt(raw, 10);
  if (!(period === 0 || period === 45 || (period >= 1 && period <= 8))) {
    throw new Error((label || "節次") + "必須為早自習0、1至8或午休45！");
  }
  return period;
}

function schoolSwapSemester_(semesterId) {
  var sid = String(semesterId || "").trim();
  var semester = (getTableData("學期設定") || []).find(function (row) {
    return String(row["學期代號"] || row.id || "").trim() === sid;
  });
  if (!semester) throw new Error("找不到目前學期設定：" + sid);
  return semester;
}

function schoolSwapAssertDateInSemester_(dateStr, semester, label) {
  var start = String(semester["開始日期"] || semester.startDate || "").slice(0, 10);
  var end = String(semester["結束日期"] || semester.endDate || "").slice(0, 10);
  if ((start && dateStr < start) || (end && dateStr > end)) {
    throw new Error((label || "對調日期") + "不在目前學期範圍內！");
  }
  if (schoolSwapWeekdayForDate_(dateStr) > 5) {
    throw new Error((label || "對調日期") + "必須是週一至週五！");
  }
}

function schoolSwapStoredRow_(row) {
  if (!row) return null;
  var dateA = "";
  var dateB = "";
  try {
    dateA = schoolSwapDate_(schoolSwapPick_(row, ["日期A", "dateA"]), "日期A");
    dateB = schoolSwapDate_(schoolSwapPick_(row, ["日期B", "dateB"]), "日期B");
  } catch (e) {
    return null;
  }
  var periodA = parseInt(schoolSwapPick_(row, ["節次A", "periodA"]), 10);
  var periodB = parseInt(schoolSwapPick_(row, ["節次B", "periodB"]), 10);
  if (!(periodA === 0 || periodA === 45 || (periodA >= 1 && periodA <= 8))
      || !(periodB === 0 || periodB === 45 || (periodB >= 1 && periodB <= 8))) return null;
  var sid = String(schoolSwapPick_(row, ["學期代號", "semesterId"])).trim();
  return {
    "學期代號": sid,
    "對調ID": String(schoolSwapPick_(row, ["對調ID", "id", "swapId"])).trim(),
    "事件名稱": String(schoolSwapPick_(row, ["事件名稱", "name"])).trim(),
    "日期A": dateA,
    "星期A": parseInt(schoolSwapPick_(row, ["星期A", "dayA"]), 10) || schoolSwapWeekdayForDate_(dateA),
    "節次A": periodA,
    "日期B": dateB,
    "星期B": parseInt(schoolSwapPick_(row, ["星期B", "dayB"]), 10) || schoolSwapWeekdayForDate_(dateB),
    "節次B": periodB,
    "啟用": schoolSwapEnabled_(row) ? "TRUE" : "FALSE",
    "建立時間": String(schoolSwapPick_(row, ["建立時間", "createdAt"])).trim(),
    "更新時間": String(schoolSwapPick_(row, ["更新時間", "updatedAt"])).trim(),
    "備註": String(schoolSwapPick_(row, ["備註", "note"])).trim()
  };
}

function schoolSwapPublicRow_(row) {
  var normalized = schoolSwapStoredRow_(row);
  if (!normalized) return null;
  return {
    "對調ID": normalized["對調ID"],
    "事件名稱": normalized["事件名稱"],
    "日期A": normalized["日期A"],
    "星期A": normalized["星期A"],
    "節次A": normalized["節次A"],
    "日期B": normalized["日期B"],
    "星期B": normalized["星期B"],
    "節次B": normalized["節次B"],
    "啟用": "TRUE",
    "備註": normalized["備註"]
  };
}

function getSemesterSchoolSwapsCached_(semesterId) {
  var sid = String(semesterId || "").trim();
  var key = "jcjh_school_swap_" + CACHE_SCHEMA_VERSION_ + "_" + sid;
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var cached = JSON.parse(raw);
      if (Array.isArray(cached)) return cached;
    } catch (e) {}
  }
  var rows = getTableData(SCHOOL_SWAP_SHEET_).filter(function (row) {
    return String(row["學期代號"] || row.semesterId || "").trim() === sid;
  }).map(schoolSwapStoredRow_).filter(function (row) { return !!row; });
  try { putCacheChunked(key, JSON.stringify(rows), CACHE_TTL_SCHED_); } catch (e2) {}
  return rows;
}

function getActiveSchoolSwapRows_(semesterId) {
  return getSemesterSchoolSwapsCached_(semesterId).filter(function (row) {
    return schoolSwapEnabled_(row);
  });
}

function resolveSchoolSwapSlot_(rows, dateStr, dayOfWeek, period) {
  var date = String(dateStr || "").slice(0, 10);
  var day = parseInt(dayOfWeek, 10);
  var per = parseInt(period, 10);
  var fallback = { dayOfWeek: day, period: per, row: null, endpoint: "" };
  (rows || []).some(function (row) {
    if (!schoolSwapEnabled_(row)) return false;
    var aHit = row["日期A"] === date && parseInt(row["節次A"], 10) === per;
    var bHit = row["日期B"] === date && parseInt(row["節次B"], 10) === per;
    if (aHit) {
      fallback = { dayOfWeek: parseInt(row["星期B"], 10), period: parseInt(row["節次B"], 10), row: row, endpoint: "A" };
      return true;
    }
    if (bHit) {
      fallback = { dayOfWeek: parseInt(row["星期A"], 10), period: parseInt(row["節次A"], 10), row: row, endpoint: "B" };
      return true;
    }
    return false;
  });
  return fallback;
}

function isPatrolScheduleRow_(row) {
  if (!row) return false;
  if (row.isPatrol === true) return true;
  var attr = String(row["課堂屬性"] || row.attr || "").trim();
  var className = String(row["班級"] || row.className || "").trim();
  var subject = String(row["科目"] || row.subject || "").trim();
  return attr === "巡堂" || attr.indexOf("巡堂") >= 0
    || className === "巡堂" || subject === "巡堂";
}

function resolveSchoolSwapSlotForTeacher_(rows, dateStr, dayOfWeek, period, schedules, teacherEmail) {
  var resolved = resolveSchoolSwapSlot_(rows, dateStr, dayOfWeek, period);
  if (!teacherEmail || !resolved.row) return resolved;
  var email = String(teacherEmail || "").toLowerCase().trim();
  function hasPatrolAt(day, per) {
    return (schedules || []).some(function (row) {
      var rowEmail = String(row["教師Email"] || row.teacherEmail || row.teacherName || "").toLowerCase().trim();
      var rowDay = parseInt(row["星期"] != null ? row["星期"] : row.dayOfWeek, 10);
      var rowPeriod = parseInt(row["節次"] != null ? row["節次"] : row.period, 10);
      return rowEmail === email && rowDay === parseInt(day, 10) && rowPeriod === parseInt(per, 10)
        && scheduleActiveOnDate_(row, dateStr)
        && isPatrolScheduleRow_(row);
    });
  }
  if (hasPatrolAt(dayOfWeek, period) || hasPatrolAt(resolved.dayOfWeek, resolved.period)) {
    return {
      dayOfWeek: parseInt(dayOfWeek, 10),
      period: parseInt(period, 10),
      row: null,
      endpoint: ""
    };
  }
  return resolved;
}

function schoolSwapSlotKey_(dateStr, period) {
  return String(dateStr || "") + "|" + String(parseInt(period, 10));
}

function normalizeSchoolSwapInput_(input, semesterId, existing) {
  var source = input || {};
  var sid = String(semesterId || source["學期代號"] || source.semesterId || "").trim();
  if (!sid) throw new Error("缺少學期代號！");
  var semester = schoolSwapSemester_(sid);
  var name = String(schoolSwapPick_(source, ["事件名稱", "name", "title"])).trim();
  if (!name) throw new Error("請填全校對調名稱！");
  if (name.length > 80) throw new Error("全校對調名稱不可超過80字！");
  var dateA = schoolSwapDate_(schoolSwapPick_(source, ["日期A", "dateA", "sourceDate"]), "日期A");
  var dateB = schoolSwapDate_(schoolSwapPick_(source, ["日期B", "dateB", "targetDate"]), "日期B");
  var periodA = schoolSwapPeriod_(schoolSwapPick_(source, ["節次A", "periodA", "sourcePeriod"]), "節次A");
  var periodB = schoolSwapPeriod_(schoolSwapPick_(source, ["節次B", "periodB", "targetPeriod"]), "節次B");
  var dayA = parseInt(schoolSwapPick_(source, ["星期A", "dayA", "sourceDay"]), 10);
  var dayB = parseInt(schoolSwapPick_(source, ["星期B", "dayB", "targetDay"]), 10);
  var actualDayA = schoolSwapWeekdayForDate_(dateA);
  var actualDayB = schoolSwapWeekdayForDate_(dateB);
  if (isNaN(dayA)) dayA = actualDayA;
  if (isNaN(dayB)) dayB = actualDayB;
  if (dayA !== actualDayA || dayB !== actualDayB) throw new Error("日期與星期不一致，請重新選擇！");
  schoolSwapAssertDateInSemester_(dateA, semester, "日期A");
  schoolSwapAssertDateInSemester_(dateB, semester, "日期B");
  if (schoolSwapSlotKey_(dateA, periodA) === schoolSwapSlotKey_(dateB, periodB)) {
    throw new Error("兩個對調端點不可相同！");
  }
  var id = String(schoolSwapPick_(source, ["對調ID", "id", "swapId"])).trim();
  if (!id) id = "swap_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  var note = String(schoolSwapPick_(source, ["備註", "note"])).trim();
  if (note.length > 300) throw new Error("備註不可超過300字！");
  return {
    "學期代號": sid,
    "對調ID": id,
    "事件名稱": name,
    "日期A": dateA,
    "星期A": dayA,
    "節次A": periodA,
    "日期B": dateB,
    "星期B": dayB,
    "節次B": periodB,
    "啟用": schoolSwapEnabled_(source) ? "TRUE" : "FALSE",
    "建立時間": existing && existing["建立時間"] ? existing["建立時間"] : toLocalTimeStr(new Date()),
    "更新時間": toLocalTimeStr(new Date()),
    "備註": note
  };
}

function assertSchoolSwapNoConflict_(row, existingRows) {
  if (!schoolSwapEnabled_(row)) return;
  var keys = [
    schoolSwapSlotKey_(row["日期A"], row["節次A"]),
    schoolSwapSlotKey_(row["日期B"], row["節次B"])
  ];
  (existingRows || []).forEach(function (other) {
    if (!other || String(other["對調ID"] || "").trim() === String(row["對調ID"] || "").trim()) return;
    if (!schoolSwapEnabled_(other)) return;
    var normalized = schoolSwapStoredRow_(other);
    if (!normalized) return;
    if (String(normalized["學期代號"] || "").trim() !== String(row["學期代號"] || "").trim()) return;
    var otherKeys = [
      schoolSwapSlotKey_(normalized["日期A"], normalized["節次A"]),
      schoolSwapSlotKey_(normalized["日期B"], normalized["節次B"])
    ];
    if (keys.some(function (key) { return otherKeys.indexOf(key) !== -1; })) {
      throw new Error("啟用中的全校對調時段重疊，請先停用既有設定！");
    }
  });
}

function saveSchoolSwapRow_(input, semesterId, operatorEmail) {
  var sid = String(semesterId || "").trim();
  var existingRows = getTableData(SCHOOL_SWAP_SHEET_) || [];
  var requestedId = String(schoolSwapPick_(input || {}, ["對調ID", "id", "swapId"])).trim();
  var existing = existingRows.find(function (row) {
    return String(row["學期代號"] || "").trim() === sid
      && String(row["對調ID"] || "").trim() === requestedId;
  });
  var row = normalizeSchoolSwapInput_(input, sid, existing);
  assertSchoolSwapNoConflict_(row, existingRows);
  row["操作者"] = String(operatorEmail || "").toLowerCase().trim();
  saveRows(SCHOOL_SWAP_SHEET_, [row], "對調ID");
  invalidateScheduleCaches_(sid);
  return schoolSwapStoredRow_(row);
}

var HOMEROOM_SHEET_ = "代導紀錄";
var HOMEROOM_FEE_ = 455;

/** 代導紀錄：空白／否值視為未啟用，其餘視為啟用（相容舊表） */
function homeroomRecordIsActive_(row) {
  if (!row) return false;
  var raw = row["啟用"];
  if (raw === undefined || raw === null || raw === "") return true;
  var s = String(raw).trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "否" || s === "no" || s === "停用");
}

function homeroomNormalizeRange_(raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/[～—–]/g, "~").replace(/\s*至\s*/g, "~").replace(/\s*-\s*/g, "~");
  return s;
}

function homeroomDefaultTime_(teacher) {
  var role = normalizeRole_(teacher && (teacher["系統角色"] || teacher.role || ""));
  if (role === "admin" || role === "staff") {
    return { type: "全天", range: "08:00~17:00" };
  }
  return { type: "全天", range: "08:00~16:00" };
}

function findSemesterTeacher_(semesterId, email) {
  var em = String(email || "").toLowerCase().trim();
  if (!em) return null;
  var rows = getSemesterTeachersCached_(semesterId) || [];
  return rows.find(function (t) {
    return String(t["教師Email"] || t.email || "").toLowerCase().trim() === em;
  }) || null;
}

function isHomeroomTeacher_(semesterId, email) {
  var t = findSemesterTeacher_(semesterId, email);
  var title = String(t && (t["職務"] || t.jobTitle || "") || "").trim();
  return !!title && title.indexOf("導師") >= 0;
}

function homeroomSourceIds_(row) {
  return String(row && row["來源申請單ID"] || "")
    .split(/[,，;\s]+/)
    .map(function (x) { return String(x || "").trim(); })
    .filter(Boolean);
}

function homeroomSourceHas_(row, requestId) {
  var rid = String(requestId || "").trim();
  return !!rid && homeroomSourceIds_(row).indexOf(rid) >= 0;
}

function homeroomRequestDate_(row) {
  return String(row && (row["異動日期"] || row.requestDate || row.date) || "").trim().slice(0, 10);
}

function homeroomRequestType_(row) {
  return String(translateTypeToEn(row && (row["異動類型"] || row.type) || "") || "").trim().toLowerCase();
}

function homeroomRequestStatus_(row) {
  return String(translateStatusToEn(row && (row["狀態"] || row.status) || "") || "").trim().toLowerCase();
}

function getSemesterHomeroomRecords_(semesterId) {
  return getTableData(HOMEROOM_SHEET_).filter(function (r) {
    return String(r["學期代號"] || "") === String(semesterId || "");
  });
}

/**
 * 依已核准代課申請同步一筆代導。
 * 規則：請假教師職務含「導師」即建立；不看原代課經費與假別。
 * 同一學期／日期／導師／班級只保留一筆，來源申請ID以逗號累積。
 */
function extractHomeroomClass_(teacher, fallbackClassName) {
  var title = String(teacher && (teacher["職務"] || teacher.jobTitle || "") || "").trim();
  var m = title.match(/([0-9一二三四五六七八九十0-9\-]+(?:\s*年\s*[0-9一二三四五六七八九十]+)?(?:\s*班)?)\s*導師/);
  if (m && m[1]) return m[1].trim();
  return String(fallbackClassName || "").trim() || "導師班";
}

/**
 * 依已核准代課申請同步一筆代導。
 * 規則：請假教師職務含「導師」即建立；不看原代課經費與假別。
 * 同一學期／日期／導師／班級只保留一筆，來源申請ID以逗號累積。
 */
function syncHomeroomRecordForRequest_(requestRow, operatorEmail) {
  if (!requestRow) return null;
  if (isCombinedReturnRequest_(requestRow)) return null;
  var sid = String(requestRow["學期代號"] || requestRow.semesterId || "").trim();
  var rid = String(requestRow["申請單ID"] || requestRow.id || "").trim();
  var leaveEmail = String(requestRow["申請人Email"] || requestRow.requesterEmail || "").toLowerCase().trim();
  var dateStr = homeroomRequestDate_(requestRow);
  var status = homeroomRequestStatus_(requestRow);
  var type = homeroomRequestType_(requestRow);

  var teacher = findSemesterTeacher_(sid, leaveEmail) || {};
  var className = extractHomeroomClass_(teacher, requestRow["班級"] || requestRow.className);

  var rows = getSemesterHomeroomRecords_(sid);
  var keyMatch = function (r) {
    return homeroomRecordIsActive_(r)
      && String(r["原導師Email"] || "").toLowerCase().trim() === leaveEmail
      && String(r["代導日期"] || "").slice(0, 10) === dateStr;
  };
  var related = rows.filter(function (r) { return homeroomSourceHas_(r, rid) || keyMatch(r); });
  var now = toLocalTimeStr(new Date());

  var eligible = status === "approved"
    && type === "substitution"
    && !!sid && !!rid && !!leaveEmail && !!dateStr
    && isHomeroomTeacher_(sid, leaveEmail);

  if (!eligible) {
    var changed = [];
    related.forEach(function (r) {
      var ids = homeroomSourceIds_(r);
      if (rid && ids.length) {
        ids = ids.filter(function (x) { return x !== rid; });
        r["來源申請單ID"] = ids.join(",");
      }
      if (!ids.length) {
        if (homeroomRecordIsActive_(r)) {
          r["啟用"] = "FALSE";
          r["狀態"] = "cancelled";
          r["更新時間"] = now;
          r["操作者"] = operatorEmail || "";
          changed.push(r);
        }
      } else {
        changed.push(r);
      }
    });
    if (changed.length) saveRows(HOMEROOM_SHEET_, changed, "代導紀錄ID");
    return null;
  }

  var fallbackTime = homeroomDefaultTime_(teacher);
  var timeType = String(requestRow["請假時間類型"] || requestRow.leaveTimeType || "").trim() || fallbackTime.type;
  var timeRange = homeroomNormalizeRange_(requestRow["請假時間"] || requestRow.leaveTime || "") || fallbackTime.range;
  var actualName = "";
  var actualEmail = "";
  var hit = related.length ? related[0] : null;
  if (hit && !homeroomRecordIsActive_(hit)) {
    hit["代導教師Email"] = "";
    hit["代導教師姓名"] = "";
    hit["狀態"] = "pending";
  }
  if (!hit) {
    hit = {
      "學期代號": sid,
      "代導紀錄ID": "mentor_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      "來源申請單ID": rid,
      "原導師Email": leaveEmail,
      "原導師姓名": String(requestRow["申請人姓名"] || requestRow.requesterName || teacher["教師姓名"] || teacher.name || ""),
      "班級": className,
      "代導日期": dateStr,
      "請假時間類型": timeType,
      "請假時間": timeRange,
      "代導教師Email": "",
      "代導教師姓名": "",
      "代導節數": 1,
      "鐘點費": HOMEROOM_FEE_,
      "狀態": "pending",
      "啟用": "TRUE",
      "建立時間": now,
      "更新時間": now,
      "操作者": operatorEmail || "",
      "備註": "導師排代自動建立，待指定代導教師"
    };
  } else {
    var ids2 = homeroomSourceIds_(hit);
    if (rid && ids2.indexOf(rid) < 0) ids2.push(rid);
    hit["來源申請單ID"] = ids2.join(",");
    hit["學期代號"] = sid;
    hit["原導師Email"] = leaveEmail;
    hit["原導師姓名"] = String(requestRow["申請人姓名"] || requestRow.requesterName || teacher["教師姓名"] || teacher.name || hit["原導師姓名"] || "");
    hit["班級"] = className;
    hit["代導日期"] = dateStr;
    hit["請假時間類型"] = timeType;
    hit["請假時間"] = timeRange;
    hit["代導節數"] = 1;
    hit["鐘點費"] = HOMEROOM_FEE_;
    hit["啟用"] = "TRUE";
    hit["更新時間"] = now;
    hit["操作者"] = operatorEmail || "";
    if (!String(hit["代導教師Email"] || "").trim()) {
      hit["狀態"] = "pending";
      hit["備註"] = "導師排代自動建立，待指定代導教師";
    } else {
      actualEmail = String(hit["代導教師Email"]).toLowerCase().trim();
      var actual = findSemesterTeacher_(sid, actualEmail);
      actualName = String(actual && (actual["教師姓名"] || actual.name) || hit["代導教師姓名"] || "");
      hit["代導教師Email"] = actualEmail;
      hit["代導教師姓名"] = actualName;
      hit["狀態"] = "assigned";
      hit["備註"] = "導師排代自動建立";
    }
  }
  saveRows(HOMEROOM_SHEET_, [hit], "代導紀錄ID");
  return hit;
}

/** 分層讀取：教師（中 TTL），快取存瘦身列；forceFresh 供登入前置檢查使用。 */
function getSemesterTeachersCached_(semesterId, forceFresh) {
  var sid = String(semesterId || "").trim();
  var key = "jcjh_teachers_" + sid;
  var raw = forceFresh ? null : getCacheChunked(key);
  if (raw) {
    try {
      var cachedT = JSON.parse(raw);
      if (Array.isArray(cachedT)) return slimTeacherRows_(cachedT, sid);
    } catch (e) {}
  }
  var rows = getTableData("教師名單").filter(function (t) { return String(t["學期代號"] || "").trim() === sid; });
  var slim = slimTeacherRows_(rows, sid);
  try { putCacheChunked(key, JSON.stringify(slim), CACHE_TTL_TEACHERS_); } catch (e2) {}
  return slim;
}

/** 分層讀取：申請單列（短 TTL；historyAll 另 key）— 快取一律 { allCount, rows } */
function getSemesterRequestsCached_(semesterId, historyAll, windowDays) {
  var sid = String(semesterId || "");
  var w = historyAll ? "all" : ("w" + (parseInt(windowDays, 10) || 14));
  var generation = getCacheGeneration_("data", sid);
  var key = "jcjh_req_" + sid + "_" + generation + "_" + w;
  var raw = getCacheChunked(key);
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      // 相容舊快取：純陣列
      if (Array.isArray(parsed)) return { allCount: parsed.length, rows: parsed };
      if (parsed && parsed.rows) return parsed;
    } catch (e) {}
  }
  // H2：欄位先濾再物件化（不再 getTableData 全物件再 filter）
  var scanned;
  if (historyAll) {
    scanned = scanRequestsFromSheet_(sid, { mode: "all" });
  } else {
    scanned = scanRequestsFromSheet_(sid, {
      mode: "window",
      cutoffYmd: requestWindowCutoffYmd_(windowDays)
    });
  }
  var pack = { allCount: scanned.allCount, rows: scanned.rows };
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
  return "jcjh_qled_all_" + CACHE_SCHEMA_VERSION_ + "_" + String(semesterId || "");
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
 * 舊帳本列補「索引鍵」＝學期|教師姓名（正規化）。
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
  var nameCol = headers.indexOf("教師姓名") + 1;
  if (idxCol < 1 || sidCol < 1 || nameCol < 1) return 0;
  var last = sheet.getLastRow();
  var n = last - 1;
  if (n < 1) return 0;
  var idxVals = sheet.getRange(2, idxCol, n, 1).getValues();
  var sidVals = sheet.getRange(2, sidCol, n, 1).getValues();
  var nameVals = sheet.getRange(2, nameCol, n, 1).getValues();
  var changed = 0;
  for (var i = 0; i < n; i++) {
    var cur = String(idxVals[i][0] || "").trim();
    if (cur) continue;
    var sid = String(sidVals[i][0] || "").trim();
    var name = String(nameVals[i][0] || "").trim();
    if (!sid || !name) continue;
    idxVals[i][0] = makeQuotaLedgerIndexKey_(sid, name);
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
 * names：可選，受影響教師姓名陣列；有則精準清姓名快取。
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
      var teacherName = quotaTeacherNameForKey_(sid, raw);
      var nameKey = nameKeyNorm_(teacherName);
      if (!nameKey || seen[nameKey]) return;
      seen[nameKey] = 1;
      limits.forEach(function (lim) {
        try { cache.remove("jcjh_qled_" + sid + "_" + nameKey + "_" + lim); } catch (e1) {}
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

function quotaTeacherNameForKey_(semesterId, value) {
  var raw = nameKeyText_(value);
  if (!raw) return "";
  if (raw.indexOf("@") < 0) return raw;
  var teachers = getTableData("教師名單") || [];
  var hit = teachers.find(function (teacher) {
    return nameKeySemester_(teacher) === String(semesterId || "")
      && nameKeyTeacherEmail_(teacher) === nameKeyNorm_(raw);
  });
  return hit ? nameKeyTeacherName_(hit) : raw;
}

/** Ledger index uses semester|teacher name, never a persisted Email key. */
function makeQuotaLedgerIndexKey_(semesterId, value) {
  return String(semesterId || "").trim() + "|" + nameKeyNorm_(quotaTeacherNameForKey_(semesterId, value));
}

/** 帳本新列：直接 append，不做 key 掃描 */
function appendQuotaLedgerRowsFast_(rows) {
  if (!rows || !rows.length) return;
  ensureQuotaSheets_();
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(QUOTA_LEDGER_SHEET_);
  if (!sheet) throw new Error("找不到工作表「" + QUOTA_LEDGER_SHEET_ + "」，請先建立分頁。");
  var headers = getHeadersForSheet(QUOTA_LEDGER_SHEET_);
  if (headers.some(function (header) { return /email|電子郵件|e-mail/i.test(String(header || "")); })) {
    throw new Error("額度帳本仍是舊 Email schema，請先執行姓名鍵 migration；原資料未刪除");
  }
  var teacherRows = getTableData("教師名單") || [];
  rows = normalizeNameKeyRows_(QUOTA_LEDGER_SHEET_, rows, teacherRows);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f1f5f9");
  }
  // 自動補索引鍵（舊列無此欄時 getHeaders 會補欄）
  rows.forEach(function (row) {
    if (!row) return;
    if (!row["索引鍵"]) {
      row["索引鍵"] = makeQuotaLedgerIndexKey_(row["學期代號"], row["教師姓名"]);
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
  var sid = String((list[0] && list[0]["學期代號"]) || "");
  var alreadySpent = {};
  if (sid) {
    (getQuotaLedgerRows_(sid) || []).forEach(function (ledgerRow) {
      if (String(ledgerRow["類型"] || "").toLowerCase() !== "spend") return;
      var requestId = String(ledgerRow["申請單ID"] || "").trim();
      if (requestId) alreadySpent[requestId] = true;
    });
  }
  list.forEach(function (r) {
    if (!r || !isQuotaDeductFee_(r["經費來源"])) return;
    var em = String(r["受邀人Email"] || "").toLowerCase().trim();
    if (!em) return;
    var requestId = String(r["申請單ID"] || r.id || "").trim();
    if (requestId && alreadySpent[requestId]) return;
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

  if (shortList.length) {
    var shortageText = shortList.map(function (x) {
      return (x.name || x.email) + " 缺 " + x.short + " 節額度";
    }).join("、");
    throw new Error("折抵額度不足，申請未寫入：" + shortageText);
  }

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
  var verified = info.email_verified === true || info.verified_email === true
    || String(info.email_verified || info.verified_email || "").toLowerCase() === "true";
  if (!verified) throw new Error("Google 帳號尚未完成 Email 驗證！");
  // aud 必須對應本系統 OAuth Client ID
  if (!info.aud || !EXPECTED_CLIENT_ID_ || String(info.aud) !== String(EXPECTED_CLIENT_ID_)) {
    throw new Error("登入用戶端驗證失敗（aud 不符）！");
  }
  // 網域限制：優先用 hd，否則用 email domain
  var email = String(info.email || "").toLowerCase();
  if (!email) throw new Error("無法取得登入帳號 Email！");
  var hd = String(info.hd || email.split("@")[1] || "").toLowerCase();
  var allowed = getAllowedHdList_();
  if (!allowed.length) {
    throw new Error("系統尚未設定允許的學校網域，請先設定 ALLOWED_HD！");
  }
  var unrestricted = allowed.indexOf("*") !== -1;
  if (unrestricted && !ALLOW_UNRESTRICTED_DOMAIN_) {
    throw new Error("系統網域設定不安全，請移除 ALLOWED_HD 的萬用值！");
  }
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

/** 紙本模式仍允許教學組寫入，但所有調代課通知信一律停寄。 */
function isOnlineSubstitutionEnabled_() {
  var raw = buildSettingsMap_().onlineSubstitutionEnabled;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  var text = String(raw).trim().toLowerCase();
  return !(raw === false || text === "false" || text === "0" || text === "no"
    || text === "否" || text === "關" || text === "關閉" || text === "off");
}

/** 申請單時間窗：未結案一律保留；已結案只留近 N 天（異動日或建立時間） */
function requestInWindow_(req, cutoffYmd) {
  var stRaw = String(req["狀態"] || req.status || "").trim();
  var st = String(translateStatusToEn(stRaw) || stRaw).toLowerCase();
  // 進行中：一律帶回（待簽核／待核准；含中文狀態）
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
  out.userRole = readerIsAdmin ? "admin" : (opts.isStaff ? "staff" : "teacher");
  out.requests = nameKeyPublicRows_("申請單", rows);
  if (out.schedules) out.schedules = nameKeyPublicRows_("教師課表", out.schedules);
  if (Array.isArray(shared.schoolSwaps)) {
    out.schoolSwaps = readerIsAdmin
      ? shared.schoolSwaps
      : shared.schoolSwaps.filter(function (row) { return schoolSwapEnabled_(row); }).map(schoolSwapPublicRow_).filter(function (row) { return !!row; });
  }
  if (out.homeroomRecords) out.homeroomRecords = nameKeyPublicRows_("代導紀錄", out.homeroomRecords);
  if (Object.prototype.hasOwnProperty.call(shared, "teachers")) {
    out.teachers = sanitizeTeacherRowsForReader_(shared.teachers || [], readerEmail, readerIsAdmin, !!opts.isStaff);
  }
  if (Object.prototype.hasOwnProperty.call(shared, "settings")) {
    out.settings = sanitizeSettingsForReader_(shared.settings || {}, readerEmail, readerIsAdmin, !!opts.isStaff, shared.teachers || []);
  }
  if (!readerIsAdmin && !opts.isStaff) {
    delete out.homeroomRecords;
  }
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
    .split(/[、,，;；/／|｜\s]+/)
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

var GENERIC_COURSE_REGEX_SERVER_ = /^(專題探究|專題|走讀|閱讀|閱讀素養|彈性|彈性課程|校訂|校訂課程|班會|週會|班週會|社團|社團活動|自主學習|自習|早自習|午休|導師時間)$/;

function isGenericCourseServer_(name) {
  if (!name) return false;
  return GENERIC_COURSE_REGEX_SERVER_.test(String(name).trim());
}

function normalizeSubjectTokenServer_(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[\s\-_]/g, "");
}

function areSubjectsCompatibleServer_(subjA, subjB) {
  if (!subjA || !subjB) return false;
  var a = normalizeSubjectTokenServer_(subjA);
  var b = normalizeSubjectTokenServer_(subjB);
  if (!a || !b) return false;
  return a === b;
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
  var rawSchedules = getSemesterSchedulesCached_(semesterId) || [];
  var teacherDirectory = null;
  try { teacherDirectory = buildNameKeyDirectory_(teachers); } catch (directoryError) { teacherDirectory = null; }
  var schedules = rawSchedules.map(function (schedule) {
    var rawEmail = String(schedule["教師Email"] || schedule.teacherEmail || "").toLowerCase().trim();
    if (!rawEmail && teacherDirectory) {
      rawEmail = nameKeyEmailForName_(semesterId, schedule["教師姓名"] || schedule.teacherName || "", teacherDirectory);
    }
    return rawEmail ? Object.assign({}, schedule, { teacherEmail: rawEmail }) : schedule;
  });
  function normalizedTeacherKey_(value) {
    return String(value || "").trim().toLowerCase();
  }
  function addUniqueSubject_(list, subject) {
    var value = String(subject || "").trim();
    if (value && list.indexOf(value) < 0) list.push(value);
  }
  function addSubjectsForKey_(map, key, raw) {
    var normalized = normalizedTeacherKey_(key);
    if (!normalized) return;
    if (!map[normalized]) map[normalized] = [];
    parseSubjectsServer_(raw).forEach(function (subject) {
      addUniqueSubject_(map[normalized], subject);
    });
  }
  function scheduleKeys_(schedule) {
    return [schedule["教師Email"], schedule.teacherEmail, schedule["教師姓名"], schedule.teacherName]
      .map(normalizedTeacherKey_)
      .filter(Boolean);
  }
  function teacherKeys_(teacher) {
    return [teacher["教師Email"], teacher.email, teacher.loginEmail, teacher.teacherEmail,
      teacher["教師姓名"], teacher.name, teacher.teacherName]
      .map(normalizedTeacherKey_)
      .filter(Boolean);
  }
  var scheduleSubjectsByTeacher = {};
  var knownDomains = {};
  schedules.forEach(function (schedule) {
    if (!schedule) return;
    if (dateStr && !scheduleActiveOnDate_(schedule, dateStr)) return;
    var scheduleSubject = schedule["科目"] || schedule.subject || "";
    if (scheduleSubject && !isGenericCourseServer_(scheduleSubject)) {
      knownDomains[scheduleSubject] = true;
      scheduleKeys_(schedule).forEach(function (key) {
        addSubjectsForKey_(scheduleSubjectsByTeacher, key, scheduleSubject);
      });
    }
  });
  function subjectDomainsForTeacher_(teacher) {
    var domains = parseSubjectsServer_(teacher["授課科目"] || teacher["任課科目"] || teacher.subject);
    teacherKeys_(teacher).forEach(function (key) {
      (scheduleSubjectsByTeacher[key] || []).forEach(function (subject) {
        addUniqueSubject_(domains, subject);
      });
    });
    return domains;
  }
  var schoolSwaps = getActiveSchoolSwapRows_(semesterId) || [];
  var reqPack = getSemesterRequestsCached_(semesterId, false, 14);
  var allReqRows = reqPack.rows || [];
  var approved = allReqRows.filter(function (r) {
    return String(r["狀態"] || "").toLowerCase() === "approved";
  });
  var pendingRows = allReqRows.filter(function (r) {
    var st = String(r["狀態"] || "").toLowerCase();
    return st === "pending_teacher" || st === "pending_admin";
  });

  // 基礎課：email|day|period → rows[]；同一時段可依啟用日期切換版本。
  var baseMap = {};
  schedules.forEach(function (s) {
    if (!s) return;
    var em = String(s["教師Email"] || s.teacherEmail || "").toLowerCase().trim();
    var d = parseInt(s["星期"] != null ? s["星期"] : s.dayOfWeek, 10);
    var p = parseInt(s["節次"] != null ? s["節次"] : s.period, 10);
    if (!em || isNaN(d) || isNaN(p)) return;
    var key = em + "|" + d + "|" + p;
    if (!baseMap[key]) baseMap[key] = [];
    baseMap[key].push(s);
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
  function courseAt(email, date, per, day) {
    var em = String(email || "").toLowerCase().trim();
    var p0 = parseInt(per, 10);
    var d0 = parseInt(day, 10);
    if (!em || isNaN(p0) || isNaN(d0)) return { className: "", subject: "" };
    var effective = resolveSchoolSwapSlotForTeacher_(schoolSwaps, date, d0, p0, schedules, em);
    var key = em + "|" + parseInt(effective.dayOfWeek, 10) + "|" + parseInt(effective.period, 10);
    var rows = (baseMap[key] || []).filter(function (row) {
      return scheduleActiveOnDate_(row, date);
    });
    var row = rows[0];
    return row ? {
      className: String(row["班級"] || row.className || "").trim(),
      subject: String(row["科目"] || row.subject || "").trim(),
      attr: String(row["課堂屬性"] || row.attr || "").trim()
    } : { className: "", subject: "" };
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
      var targetDate = r["對調目標日期"] || r.targetDate;
      var targetPeriod = r["對調目標節次"] || r.targetPeriod;
      var targetDay = r["對調目標星期"] || r.targetDayOfWeek || _dayFromDateStr_(targetDate);
      // 課程跟著原授課教師移動：源時段由受邀人帶自己的目標課程調入。
      var targetCourse = courseAt(tgtEm, targetDate, targetPeriod, targetDay);
      var targetCls = r["對調目標班級"] || r.targetClassName || targetCourse.className;
      var targetSubj = r["對調目標科目"] || r.targetSubject || targetCourse.subject;
      markEdge(reqDate, reqPer, reqEm, tgtEm, targetCls, targetSubj);
      markEdge(targetDate, targetPeriod, tgtEm, reqEm, cls, subj);
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
    var effective = resolveSchoolSwapSlotForTeacher_(schoolSwaps, dateStr, d, p, schedules, em);
    var key = em + "|" + effective.dayOfWeek + "|" + effective.period;
    var baseRow = (baseMap[key] || []).find(function (row) {
      return scheduleActiveOnDate_(row, dateStr);
    });
    var base = baseRow ? {
      className: String(baseRow["班級"] || baseRow.className || "").trim(),
      subject: String(baseRow["科目"] || baseRow.subject || "").trim(),
      attr: String(baseRow["課堂屬性"] || baseRow.attr || "").trim()
    } : null;
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
    if (dateStr && !scheduleActiveOnDate_(s, dateStr)) return;
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

  teachers.forEach(function (t) {
    subjectDomainsForTeacher_(t).forEach(function (subject) {
      if (!isGenericCourseServer_(subject)) knownDomains[subject] = true;
    });
  });
  var leaveDomains = parseSubjectsServer_(myDomainRaw);
  leaveDomains.forEach(function (s) {
    if (!isGenericCourseServer_(s)) knownDomains[s] = true;
  });
  var demandDomain = "";
  if (myCourse && !isGenericCourseServer_(myCourse) && knownDomains[myCourse]) demandDomain = myCourse;
  else if (leaveDomains.length) demandDomain = leaveDomains[0];
  if (!demandDomain && /英資/.test(myClass)) demandDomain = "英語資優";
  else if (!demandDomain && /數資/.test(myClass)) demandDomain = "數理資優";

  var freeList = [];
  teachers.forEach(function (t) {
    var em = String(t["教師Email"] || t.email || "").toLowerCase().trim();
    if (!em || em === leaveEmail) return;
    var fi = isFreeAt(em, period);
    if (!fi.free) return;
    var rosterDomains = parseSubjectsServer_(t["授課科目"] || t["任課科目"] || t.subject);
    var candDomains = subjectDomainsForTeacher_(t);
    var isSameCourse = !!sameCourseTeachers[em];
    var isSameSubject = false;
    var isPrimarySubject = false;
    var subjectMatchRank = 0;
    // 支援多科：收齊 demandDomain + 請假教師全部科目，候選人命中任一即算同科
    var effectiveDemands = [];
    if (demandDomain && effectiveDemands.indexOf(demandDomain) < 0) effectiveDemands.push(demandDomain);
    leaveDomains.forEach(function (d) {
      if (d && !isGenericCourseServer_(d) && effectiveDemands.indexOf(d) < 0) effectiveDemands.push(d);
    });
    if (effectiveDemands.length > 0) {
      candDomains.forEach(function (candSubj) {
        effectiveDemands.forEach(function (dd) {
          if (areSubjectsCompatibleServer_(candSubj, dd)) {
            isSameSubject = true;
            var isDemandExact = demandDomain && normalizeSubjectTokenServer_(dd) === normalizeSubjectTokenServer_(demandDomain);
            var inRoster = rosterDomains.some(function (r) {
              return areSubjectsCompatibleServer_(r, dd);
            });
            var isRosterPrimary = rosterDomains.length > 0
              && areSubjectsCompatibleServer_(rosterDomains[0], dd);
            var rank = isDemandExact
              ? (isRosterPrimary ? 4 : (inRoster ? 3 : 2))
              : (isRosterPrimary ? 2 : 1);
            if (rank > subjectMatchRank) {
              subjectMatchRank = rank;
              if (isRosterPrimary) isPrimarySubject = true;
            }
          }
        });
      });
    }
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
      teacherName: String(t["教師姓名"] || t.name || "").trim(),
      name: String(t["教師姓名"] || t.name || "").trim(),
      subject: String(t["授課科目"] || t["任課科目"] || t.subject || "").trim(),
      jobTitle: String(t["職務"] || t.jobTitle || "").trim(),
      role: String(t["系統角色"] || t.role || "teacher"),
      baseHours: t["基本鐘點"] != null ? t["基本鐘點"] : (t.baseHours != null ? t.baseHours : 16),
      mutualQuota: t["折抵額度"] != null ? t["折抵額度"] : (t.mutualQuota != null ? t.mutualQuota : 0),
      todayPeriodCount: busy,
      isSameCourse: isSameCourse,
      isSameSubject: isSameSubject,
      isPrimarySubject: isPrimarySubject,
      subjectMatchRank: subjectMatchRank,
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
    return b.score - a.score
      || (b.subjectMatchRank || 0) - (a.subjectMatchRank || 0)
      || a.todayPeriodCount - b.todayPeriodCount;
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
    requests: nameKeyPublicRows_("申請單", changed),
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
    var teachersOnlyRows = getSemesterTeachersCached_(semesterId);
    return {
      success: true,
      kind: "teachersOnly",
      teachers: sanitizeTeacherRowsForReader_(teachersOnlyRows, userEmail, isAdmin, !!opts.isStaff),
      scope: isAdmin ? "admin" : "teacher",
      userRole: isAdmin ? "admin" : (opts.isStaff ? "staff" : "teacher"),
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
  const schoolSwaps = getSemesterSchoolSwapsCached_(semesterId);

  return {
    success: true,
    userRole: isAdmin ? "admin" : (opts.isStaff ? "staff" : "teacher"),
    semesters: semesters,
    teachers: allTeachers,
    schedules: allSchedules,
    schoolSwaps: schoolSwaps,
    classNames: buildClassNames_(allSchedules),
    substitutions: [],
    homeroomRecords: isAdmin ? getSemesterHomeroomRecords_(semesterId) : [],
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

function splitClassNames_(raw) {
  return String(raw || "").split(/[、,，\/／|｜\s]+/).map(function (value) {
    return String(value || "").trim();
  }).filter(function (value) {
    return value && !/^0+$/.test(value);
  });
}

function classFieldIncludes_(raw, className) {
  var target = String(className || "").trim();
  if (!target) return false;
  return splitClassNames_(raw).indexOf(target) !== -1 || String(raw || "").trim() === target;
}

function buildClassNames_(schedules) {
  var seen = {};
  (schedules || []).forEach(function (row) {
    splitClassNames_(row && (row["班級"] !== undefined ? row["班級"] : row.className)).forEach(function (name) {
      seen[name] = true;
    });
  });
  return Object.keys(seen).sort(function (a, b) {
    return String(a).localeCompare(String(b), "zh-Hant", { numeric: true });
  });
}

// 公開班級課表（免登入）：最小化欄位，禁止全校名單／全表 fallback
function buildPublicClassPayload_(semesterId, className) {
  var sid = semesterId;
  var allSems = getTableData("學期設定");
  if (!sid) {
    var def = allSems.find(function (s) {
      var flag = s["是否預設"] !== undefined ? s["是否預設"] : (s["預設"] !== undefined ? s["預設"] : s.isDefault);
      return isTrueFlag_(flag);
    });
    sid = def ? (def["學期代號"] || def.id) : (allSems[0] && (allSems[0]["學期代號"] || allSems[0].id)) || "";
  }
  sid = String(sid || "").trim();
  var cls = String(className || "").trim();
  // 走分層快取（勿每次 getTableData 全表）
  var semesterSchedules = getSemesterSchedulesCached_(sid) || [];
  // 班級名清單（僅名稱，供拼錯提示；不附 Email）
  var classNames = buildClassNames_(semesterSchedules);

  var scheduleRows = cls
    ? semesterSchedules.filter(function (s) { return classFieldIncludes_(s["班級"] || s["className"], cls); })
    : [];

  var schedules = scheduleRows.map(function (s, idx) {
    return {
      "課表ID": "public_" + String(sid) + "_" + idx,
      "教師姓名": s["教師姓名"] || s.teacherName || "",
      "星期": s["星期"] != null ? s["星期"] : s.dayOfWeek,
      "節次": s["節次"] != null ? s["節次"] : s.period,
      "班級": s["班級"] || s.className || "",
      "科目": s["科目"] || s.subject || "",
      "課堂屬性": s["課堂屬性"] || s.attr || "",
      "調課限制": s["調課限制"] || s.restriction || "",
      "啟用起日": s["啟用起日"] || s.activeFrom || s.activationStartDate || s.effectiveStartDate || "",
      "啟用迄日": s["啟用迄日"] || s.activeTo || s.activationEndDate || s.effectiveEndDate || ""
    };
  });

  // 僅該班相關教師（姓名顯示用），不回全校
  var teacherNameNeed = {};
  schedules.forEach(function (s) {
    var teacherName = String(s["教師姓名"] || s.teacherName || "").trim().toLowerCase();
    if (teacherName) teacherNameNeed[teacherName] = 1;
  });

  // 申請：用學期快取後再 filter 已核准＋該班（公開不需 pending）
  var reqPackPub = getSemesterRequestsCached_(sid, true, 14);
  var approved = (reqPackPub.rows || []).filter(function (req) {
    if (String(req["狀態"] || req.status || "") !== "approved") return false;
    // 調課的網頁課表會把兩端原課帶到對方時段，來源班與目標班都要公開。
    if (cls
        && !classFieldIncludes_(req["班級"] || req.className, cls)
        && !classFieldIncludes_(req["對調目標班級"] || req.targetClassName, cls)) return false;
    return true;
  }).map(function (req, idx) {
    // 公開：保留顯示用姓名與課堂欄，不附備註全文
    return {
      "申請單ID": "public_" + String(sid) + "_" + idx,
      "狀態": req["狀態"],
      "申請人姓名": req["申請人姓名"],
      "受邀人姓名": req["受邀人姓名"],
      "實際授課教師姓名": req["受邀人姓名"],
      "班級": req["班級"],
      "科目": req["科目"],
      "異動日期": req["異動日期"],
      "異動星期": req["異動星期"],
      "異動節次": req["異動節次"],
      "異動類型": req["異動類型"],
      "對調目標日期": req["對調目標日期"],
      "對調目標星期": req["對調目標星期"],
      "對調目標節次": req["對調目標節次"],
      "經費來源": "",
      "請假事由": ""
    };
  });

  var teachers = (getSemesterTeachersCached_(sid) || []).filter(function (t) {
    return teacherNameNeed[String(t["教師姓名"] || t.name || "").trim().toLowerCase()];
  }).map(function (t) {
    return {
      "教師姓名": t["教師姓名"] || t.name || "",
      "授課科目": t["授課科目"] || t["任課科目"] || t["科目"] || t.subject || "",
      "系統角色": "teacher"
    };
  });

  var semRow = allSems.filter(function (s) {
    return String(s["學期代號"] || s.id || "").trim() === sid;
  });

  var classAwayEvents = getSemesterClassAwayCached_(sid);
  var schoolSwaps = getActiveSchoolSwapRows_(sid).map(schoolSwapPublicRow_).filter(function (row) { return !!row; });

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
    schoolSwaps: schoolSwaps,
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
  var semesterId = String(postData.semesterId || "").trim();
  const idToken = postData.idToken;
  let reqData = postData.data || {};
  const scope = String(reqData.scope || postData.scope || "full").toLowerCase();

  // 公開班級課表：免登入（節流 + 短快取）
  if (action === "getPublicClassData") {
    assertPublicClassRateLimit_();
    var pubCls = reqData.className || reqData.class || postData.className || "";
    var pubSid = semesterId || reqData.semesterId || "";
     var pubGeneration = getCacheGeneration_("public", pubSid);
     var pubCacheKey = "jcjh_pub_v3_" + CACHE_SCHEMA_VERSION_ + "_" + pubSid + "_" + pubGeneration + "_" + String(pubCls).trim();
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
  var readerEmail = String((tokenInfo && tokenInfo.email) || "").trim().toLowerCase();
  var readerTeachers = getSemesterTeachersCached_(semesterId, scope === "fresh") || [];
  var readerRole = resolveTeacherRole_(readerEmail, readerTeachers);
  if (!readerRole && action === "getMetaData") {
    var loginSemesterId = findTeacherSemesterForLogin_(semesterId, readerEmail);
    if (loginSemesterId && (loginSemesterId !== semesterId || scope !== "fresh")) {
      semesterId = loginSemesterId;
      readerTeachers = getSemesterTeachersCached_(semesterId, true) || [];
      readerRole = resolveTeacherRole_(readerEmail, readerTeachers);
    }
  }
  if (!readerRole) {
    throw new Error("您的帳號不在目前學期教師名單中，無法讀取系統資料！");
  }
  var readerIsAdmin = readerRole === "admin";
  var readerIsStaff = readerRole === "staff";

  // 代課媒合候選（讀取、不佔寫鎖；短快取 45s，申請寫入時代次戳失效）
  if (action === "getMatchCandidates") {
    var mLeaveRaw = nameKeyText_(reqData.leaveName || reqData.leaveEmail || "");
    var mLeave = readerEmail;
    var mLeaveName = "";
    if (mLeaveRaw) {
      var mDirectory = buildNameKeyDirectory_(readerTeachers);
      mLeaveName = resolveNameKeyTeacher_(mLeaveRaw, semesterId, mDirectory, "原教師", false);
      mLeave = nameKeyEmailForName_(semesterId, mLeaveName, mDirectory);
      if (!mLeave) throw new Error("原教師缺少登入 Email");
      reqData = Object.assign({}, reqData, { leaveEmail: mLeave, leaveName: mLeaveName });
    }
    if (!mLeaveRaw) reqData = Object.assign({}, reqData, { leaveEmail: mLeave });
    if (!readerIsAdmin && mLeave !== readerEmail
        && !(readerIsStaff && canUserProxySubmit_(readerEmail, readerTeachers))) {
      throw new Error("您無權查詢其他教師的媒合候選！");
    }
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
     var matchCacheKey = "jcjh_match_" + CACHE_SCHEMA_VERSION_ + "_" + String(semesterId || "") + "_" + mGen + "_"
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
    // 若系統設定未填 allowedHd，回傳 Script Properties 的明確設定。
    if (!settings.allowedHd) {
      settings.allowedHd = ALLOWED_HD_;
    }
    var metaKey = "jcjh_meta_" + String(semesterId || "");
    var metaCached = getCacheChunked(metaKey);
    if (metaCached && scope !== "fresh") {
      try {
        var metaObj = JSON.parse(metaCached);
        if (metaObj && metaObj.success) {
          var cachedOut = Object.assign({}, metaObj);
          cachedOut.semesterId = semesterId;
          cachedOut.teachers = sanitizeTeacherRowsForReader_(readerTeachers, readerEmail, readerIsAdmin, readerIsStaff);
          cachedOut.settings = sanitizeSettingsForReader_(settings, readerEmail, readerIsAdmin, readerIsStaff, readerTeachers);
          cachedOut.userRole = readerRole;
          return ContentService.createTextOutput(JSON.stringify(cachedOut)).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (metaE) {}
    }
    var metaPayload = {
      success: true,
      semesterId: semesterId,
      semesters: getTableData("學期設定"),
      teachers: readerTeachers,
      settings: settings
    };
    try { putCacheChunked(metaKey, JSON.stringify(metaPayload), CACHE_TTL_META_); } catch (metaPutE) {}
    var metaOut = Object.assign({}, metaPayload);
    metaOut.teachers = sanitizeTeacherRowsForReader_(readerTeachers, readerEmail, readerIsAdmin, readerIsStaff);
    metaOut.settings = sanitizeSettingsForReader_(settings, readerEmail, readerIsAdmin, readerIsStaff, readerTeachers);
    metaOut.userRole = readerRole;
    return ContentService.createTextOutput(JSON.stringify(metaOut)).setMimeType(ContentService.MimeType.JSON);
  }

  // 極輕量：只回進行中申請（待辦對齊用，不含課表）
  if (action === "getPendingOnly") {
    var teachersP = getSemesterTeachersCached_(semesterId);
    var isAdminP = resolveIsAdmin_(readerEmail, teachersP);
    // v2：中文狀態掃描修正後換 key，避免舊空陣列快取鎖 45s
    var pendingKey = "jcjh_pending_v3_namekey_" + semesterId + "_a";
    var pending = null;
    if (scope !== "fresh") {
      var pendingCached = getCacheChunked(pendingKey);
      if (pendingCached) {
        try {
          var parsedP = JSON.parse(pendingCached);
          if (Array.isArray(parsedP)) pending = parsedP;
        } catch (pE) { pending = null; }
      }
    }
    if (pending === null) {
      // 只掃出 pending 列（中文狀態已 translateStatusToEn）
      pending = getPendingRequestsFromSheet_(semesterId);
      try {
        // 空結果只快取 12 秒，避免誤掃／舊 bug 鎖死待辦
        var pTtl = (pending && pending.length) ? CACHE_TTL_PENDING_ : 12;
        putCacheChunked(pendingKey, JSON.stringify(pending || []), pTtl);
      } catch (pPut) {}
    }
    if (!isAdminP) {
      pending = (pending || []).filter(function (req) {
        return requestVisibleToReader_(req, readerEmail, false);
      });
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      kind: "pendingOnly",
      requests: nameKeyPublicRows_("申請單", pending || []),
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
     var histKey = "jcjh_hist_" + CACHE_SCHEMA_VERSION_ + "_" + semesterId + "_" + monthStr + (isAdminH ? "_a" : "_u");
    if (isAdminH) {
      var histCached = getCacheChunked(histKey);
      if (histCached) {
        return ContentService.createTextOutput(histCached).setMimeType(ContentService.MimeType.JSON);
      }
    }
    // H1：只掃該月列（不建 historyAll 全量包）
    var monthRows = getMonthRequestsFromSheet_(semesterId, monthStr);
    if (!isAdminH) {
      monthRows = monthRows.filter(function (req) {
        return requestVisibleToReader_(req, readerEmail, false);
      });
    }
    var histPayload = {
      success: true,
      kind: "historyMonth",
      month: monthStr,
      requests: nameKeyPublicRows_("申請單", monthRows),
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
    var targetRaw = nameKeyText_(reqData.name || reqData.teacherName || reqData.email || reqData.teacherEmail || postData.name || postData.email);
    var teachersL = getSemesterTeachersCached_(semesterId) || [];
    var readerHitL = teachersL.find(function (teacher) {
      return nameKeyTeacherEmail_(teacher) === readerEmail;
    });
    var targetName = targetRaw && targetRaw.indexOf("@") < 0 ? targetRaw : "";
    var targetEmail = targetRaw && targetRaw.indexOf("@") >= 0 ? nameKeyNorm_(targetRaw) : "";
    if (!targetRaw) {
      targetEmail = readerEmail;
      targetName = readerHitL ? nameKeyTeacherName_(readerHitL) : "";
    }
    if (targetName) {
      var targetHitByName = teachersL.find(function (teacher) {
        return nameKeyTeacherName_(teacher) === targetName;
      });
      if (!targetHitByName) throw new Error("查無目前學期教師姓名：" + targetName);
      targetEmail = nameKeyTeacherEmail_(targetHitByName);
    }
    var isSelfLed = targetEmail === readerEmail;
    var isAdminL = resolveIsAdmin_(readerEmail, teachersL);
    if (!isSelfLed && !isAdminL) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "僅能查看自己的額度歷程"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    if (!targetName && targetEmail) {
      var targetHitByEmail = teachersL.find(function (teacher) {
        return nameKeyTeacherEmail_(teacher) === targetEmail;
      });
      targetName = targetHitByEmail ? nameKeyTeacherName_(targetHitByEmail) : "";
    }
    var limitL = parseInt(reqData.limit != null ? reqData.limit : 50, 10) || 50;
    if (limitL > 120) limitL = 120;
    // Per-teacher cache key is name-based; Email is only used for auth lookup.
    var ledCacheKey = "jcjh_qled_" + semesterId + "_" + nameKeyNorm_(targetName) + "_" + limitL;
    try {
      var ledCached = CacheService.getScriptCache().get(ledCacheKey);
      if (ledCached) {
        return ContentService.createTextOutput(ledCached).setMimeType(ContentService.MimeType.JSON);
      }
    } catch (eLedC) {}
    // 走 getQuotaLedgerRows_（ScriptCache＋mem）；再 filter 教師
    var sidL = String(semesterId || "");
    var idxKeyL = makeQuotaLedgerIndexKey_(sidL, targetName);
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

  if (action === "getHomeroomRecords") {
    var hTeachers = getSemesterTeachersCached_(semesterId);
    var hIsAdmin = resolveIsAdmin_(readerEmail, hTeachers);
    if (!hIsAdmin) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "僅管理員可查看代導紀錄"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      homeroomRecords: nameKeyPublicRows_("代導紀錄", getSemesterHomeroomRecords_(semesterId))
    })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getInitialData") {
    var teachersForRole = readerTeachers;
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
    var dataGeneration = getCacheGeneration_("data", semesterId);

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
      var roSharedKey = "jcjh_reqonly_" + semesterId + "_" + dataGeneration + "_admin_w" + wDays;
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
        isStaff: readerIsStaff,
        teachersOnly: true
      });
      return ContentService.createTextOutput(JSON.stringify(toOut))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── 全量：admin／教師共用底包（課表全校；申請全校列，回傳前淺拷 filter）──
    // 行政與教學組皆吃 full 底包（課表不瘦身）；一般教師用 teacher 鍵（內容相同，個人化再瘦）
    var fullSharedKey = (readerIsAdmin || readerIsStaff)
      ? ("jcjh_data_" + DATA_PAYLOAD_VERSION_ + "_" + semesterId + "_" + dataGeneration + "_admin_w" + wDays)
      : ("jcjh_data_" + DATA_PAYLOAD_VERSION_ + "_" + semesterId + "_" + dataGeneration + "_teacher_w" + wDays);
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
          var fullSharedJson = JSON.stringify(fullShared);
          putCacheChunked(fullSharedKey, fullSharedJson, ttl);
          // 教師／admin 底包內容相同時互寫，提高命中（共用字串，少 stringify 一次）
          if (readerIsAdmin || readerIsStaff) {
            putCacheChunked(
              "jcjh_data_" + DATA_PAYLOAD_VERSION_ + "_" + semesterId + "_" + dataGeneration + "_teacher_w" + wDays,
              fullSharedJson,
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
    resetRequestContext_();
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

var REQUEST_ALLOWED_STATES_ = {
  adminApprove: ["pending_admin"],
  adminApproveBatch: ["pending_admin"],
  adminReject: ["pending_admin"],
  adminRejectBatch: ["pending_admin"],
  respondToRequest: ["pending_teacher"],
  respondToBatch: ["pending_teacher"],
  cancelRequest: ["pending_teacher", "pending_admin"],
  withdrawRequest: ["pending_admin"],
  deleteSubstitutionRecord: ["approved"]
};

function assertRequestState_(row, action) {
  var allowed = REQUEST_ALLOWED_STATES_[action] || [];
  var status = String(translateStatusToEn(row && row["狀態"] || "") || "").toLowerCase();
  if (allowed.indexOf(status) === -1) {
    throw new Error("申請單目前狀態為「" + (translateStatusToZh(status) || status || "未知") + "」，無法執行此操作！");
  }
  return status;
}

function assertNewRequestId_(requestId, semesterId, requesterEmail, targetEmail, batchId) {
  var rid = String(requestId || "").trim();
  if (!rid) throw new Error("缺少申請單 ID！");
  var current = findRowByKey_("申請單", "申請單ID", rid, semesterId);
  if (current) {
    var samePeople = String(current["申請人Email"] || "").toLowerCase().trim() === String(requesterEmail || "").toLowerCase().trim()
      && String(current["受邀人Email"] || "").toLowerCase().trim() === String(targetEmail || "").toLowerCase().trim();
    var sameBatch = !batchId || String(current["批次ID"] || "").trim() === String(batchId || "").trim();
    if (samePeople && sameBatch) return current;
    throw new Error("申請單 ID 已存在且內容不一致，拒絕覆寫！");
  }
  var sameIdOtherSemester = findRowByKey_("申請單", "申請單ID", rid);
  if (sameIdOtherSemester && String(sameIdOtherSemester["學期代號"] || "").trim() !== String(semesterId || "").trim()) {
    throw new Error("申請單 ID 已存在其他學期，拒絕跨學期操作！");
  }
  return null;
}

function isPaperFlowValue_(value) {
  if (value === true || value === 1) return true;
  var text = String(value == null ? "" : value).trim().toLowerCase();
  return text === "true" || text === "1" || text === "是" || text === "紙本";
}

function isPaperFlowRow_(row) {
  return !!(row && isPaperFlowValue_(row["紙本流程"] !== undefined ? row["紙本流程"] : row.paperFlow));
}

function validateRequestRow_(row, semesterId) {
  var dateStr = String(row && (row["異動日期"] || row.requestDate || "") || "").trim().slice(0, 10);
  var period = parseInt(row && (row["異動節次"] || row.requestPeriod || 0), 10);
  var day = row && (row["異動星期"] != null ? row["異動星期"] : row.requestPeriodDay);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error("異動日期格式必須為 YYYY-MM-DD！");
  if (!(period === 0 || period === 45 || (period >= 1 && period <= 8))) throw new Error("異動節次必須為早自習0、1至8或午休45！");
  if (day !== undefined && day !== null && day !== "" && (parseInt(day, 10) < 1 || parseInt(day, 10) > 7)) {
    throw new Error("異動星期格式不正確！");
  }
  var type = String(row && (row["異動類型"] || row.type || "") || "").toLowerCase();
  if (type !== "substitution" && type !== "代課" && type !== "exchange" && type !== "對調"
      && type !== TRIANGLE_TYPE_ && type !== "三角調") {
    throw new Error("異動類型不正確！");
  }
  validateCombinedReturnRequest_(row, semesterId);
  if (type === "exchange" || type === "對調") {
    var targetDate = String(row["對調目標日期"] || row.targetDate || "").trim().slice(0, 10);
    var targetPeriod = parseInt(row["對調目標節次"] || row.targetPeriod || 0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !(targetPeriod === 0 || targetPeriod === 45 || (targetPeriod >= 1 && targetPeriod <= 8))) {
      throw new Error("對調日期與節次格式不正確！");
    }
  }
  var sem = getTableData("學期設定").find(function (s) {
    return String(s["學期代號"] || s.id || "").trim() === String(semesterId || "").trim();
  });
  if (sem) {
    var start = String(sem["開始日期"] || sem.startDate || "").slice(0, 10);
    var end = String(sem["結束日期"] || sem.endDate || "").slice(0, 10);
    if ((start && dateStr < start) || (end && dateStr > end)) throw new Error("異動日期不在目前學期範圍內！");
  }
}

// ----------------- 三角調：群組驗證／資料契約 -----------------
// 三角調仍寫入「申請單」三列；每列代表一條 source → target 腳，三列共用三角調ID。
function isTriangleRequest_(row) {
  var type = String(row && (row["異動類型"] || row.type) || "").trim().toLowerCase();
  return type === TRIANGLE_TYPE_ || type === "三角調";
}

function triangleText_(value) {
  return String(value == null ? "" : value).trim();
}

function trianglePick_(row, names) {
  var source = row || {};
  for (var i = 0; i < names.length; i++) {
    if (source[names[i]] !== undefined && source[names[i]] !== null
        && triangleText_(source[names[i]]) !== "") return source[names[i]];
  }
  return "";
}

function trianglePersonValue_(value, field) {
  if (!value || typeof value !== "object") return triangleText_(value);
  if (field === "email") return triangleText_(value.email || value.loginEmail || value["教師Email"]);
  return triangleText_(value.name || value.teacherName || value["教師姓名"] || value.email || value.loginEmail);
}

function triangleDateDay_(dateText) {
  var date = new Date(String(dateText || "").replace(/-/g, "/"));
  if (isNaN(date.getTime())) return 0;
  return date.getDay() === 0 ? 7 : date.getDay();
}

function trianglePeriod_(value) {
  if (value === 0 || value === "0") return 0;
  if (value === 45 || value === "45") return 45;
  var period = parseInt(value, 10);
  return period === 0 || period === 45 || (period >= 1 && period <= 8) ? period : null;
}

function triangleSlotFromRow_(row, target) {
  var isTarget = target === true;
  var date = trianglePick_(row, isTarget
    ? ["對調目標日期", "targetDate", "dateB"]
    : ["異動日期", "requestDate", "dateA"]);
  var day = trianglePick_(row, isTarget
    ? ["對調目標星期", "targetDayOfWeek", "targetDay", "dayB"]
    : ["異動星期", "requestPeriodDay", "sourceDay", "dayA"]);
  var period = trianglePick_(row, isTarget
    ? ["對調目標節次", "targetPeriod", "periodB"]
    : ["異動節次", "requestPeriod", "sourcePeriod", "periodA"]);
  date = triangleText_(date).slice(0, 10);
  period = trianglePeriod_(period);
  day = parseInt(day, 10);
  if (!(day >= 1 && day <= 7)) day = triangleDateDay_(date);
  return { date: date, day: day || 0, period: period };
}

function triangleCourseFromRow_(row, target) {
  var isTarget = target === true;
  var className = trianglePick_(row, isTarget
    ? ["對調目標班級", "targetClassName", "classB"]
    : ["班級", "className", "classA"]);
  var subject = trianglePick_(row, isTarget
    ? ["對調目標科目", "targetSubject", "subjectB"]
    : ["科目", "subject", "subjectA"]);
  return {
    className: triangleText_(className),
    subject: triangleText_(subject)
  };
}

function triangleClassList_(value) {
  return triangleText_(value).split(/[、,，\/／;；\s]+/).map(function (item) {
    return triangleText_(item);
  }).filter(Boolean);
}

function triangleSameClass_(left, right) {
  var a = triangleClassList_(left);
  var b = triangleClassList_(right);
  if (!a.length || !b.length) return false;
  return a.some(function (item) { return b.indexOf(item) !== -1; });
}

function triangleTeacherEmailFromRow_(row, target, semesterId, directory) {
  var isTarget = target === true;
  var name = trianglePick_(row, isTarget
    ? ["受邀人姓名", "targetTeacherName", "toTeacher", "targetTeacher"]
    : ["申請人姓名", "requesterName", "fromTeacher", "sourceTeacher"]);
  var email = trianglePick_(row, isTarget
    ? ["受邀人Email", "targetTeacherEmail"]
    : ["申請人Email", "requesterEmail"]);
  name = trianglePersonValue_(name, "name");
  email = trianglePersonValue_(email, "email");
  if (!email && name && directory) email = nameKeyEmailForName_(semesterId, name, directory);
  return triangleText_(email).toLowerCase();
}

function triangleTeacherNameFromEmail_(email, semesterId, directory) {
  var em = triangleText_(email).toLowerCase();
  if (!em || !directory) return "";
  var entry = directory.byEmail[nameKeyDirectoryKey_(semesterId, em)];
  return entry ? entry.name : "";
}

function triangleScheduleContext_(semesterId) {
  var sid = String(semesterId || "").trim();
  var teachers = getSemesterTeachersCached_(sid) || [];
  var directory = buildNameKeyDirectory_(teachers);
  var schedules = (getSemesterSchedulesCached_(sid) || []).map(function (row) {
    var name = triangleText_(row["教師姓名"] || row.teacherName);
    var email = triangleText_(row["教師Email"] || row.teacherEmail).toLowerCase();
    if (!email && name) email = nameKeyEmailForName_(sid, name, directory);
    return {
      row: row,
      email: email,
      name: name,
      day: parseInt(row["星期"] != null ? row["星期"] : row.dayOfWeek, 10),
      period: parseInt(row["節次"] != null ? row["節次"] : row.period, 10),
      className: triangleText_(row["班級"] || row.className),
      subject: triangleText_(row["科目"] || row.subject),
      attr: triangleText_(row["課堂屬性"] || row.attr)
    };
  }).filter(function (item) {
    return !!item.email && !isNaN(item.day) && !isNaN(item.period);
  });
  return {
    semesterId: sid,
    directory: directory,
    schedules: schedules,
    schoolSwaps: getActiveSchoolSwapRows_(sid) || [],
    edges: {},
    pending: {}
  };
}

function triangleCellKey_(email, date, period) {
  return triangleText_(email).toLowerCase() + "|" + triangleText_(date).slice(0, 10) + "|" + String(trianglePeriod_(period));
}

function triangleBaseCell_(context, email, date, day, period) {
  var em = triangleText_(email).toLowerCase();
  var resolved = resolveSchoolSwapSlotForTeacher_(context.schoolSwaps, date, day, period,
    context.schedules.map(function (item) { return item.row; }), em);
  var hit = context.schedules.find(function (item) {
    return item.email === em && item.day === parseInt(resolved.dayOfWeek, 10)
      && item.period === parseInt(resolved.period, 10) && scheduleActiveOnDate_(item.row, date);
  });
  if (!hit) return null;
  return {
    occupied: !!(hit.className && hit.subject) || isPatrolScheduleRow_(hit.row),
    changed: false,
    isPatrol: isPatrolScheduleRow_(hit.row),
    className: hit.className,
    subject: hit.subject,
    attr: hit.attr,
    row: hit.row
  };
}

function triangleAddEdge_(edges, email, date, period, direction, course, requestId) {
  var key = triangleCellKey_(email, date, period);
  if (!edges[key]) edges[key] = [];
  edges[key].push({
    direction: direction,
    className: triangleText_(course && course.className),
    subject: triangleText_(course && course.subject),
    requestId: triangleText_(requestId)
  });
}

function triangleBuildEdgeIndex_(context, ignoreTriangleId) {
  var pack = getSemesterRequestsCached_(context.semesterId, true, 0);
  var rows = pack && pack.rows ? pack.rows : [];
  var ignored = triangleText_(ignoreTriangleId);
  rows.forEach(function (row) {
    var status = String(translateStatusToEn(row && row["狀態"] || row && row.status) || "").toLowerCase();
    if (status !== "approved") return;
    var type = String(translateTypeToEn(row && row["異動類型"] || row && row.type) || "").toLowerCase();
    var rid = triangleText_(row && row["申請單ID"] || row && row.id);
    var triId = triangleText_(row && row["三角調ID"] || row && row.triangleId);
    if (type === TRIANGLE_TYPE_) {
      if (ignored && triId === ignored) return;
      var triSource = triangleTeacherEmailFromRow_(row, false, context.semesterId, context.directory);
      var triTarget = triangleTeacherEmailFromRow_(row, true, context.semesterId, context.directory);
      var triTargetSlot = triangleSlotFromRow_(row, true);
      var triSourceCourse = triangleCourseFromRow_(row, false);
      var triTargetCourse = triangleCourseFromRow_(row, true);
      // 三角調只在目標原課時段建立一組 edge：目標原教師調出，來源教師帶著原課調入。
      // 三條 leg 合併後，三位教師各自的來源時段自然形成完整閉環。
      triangleAddEdge_(context.edges, triTarget, triTargetSlot.date, triTargetSlot.period, "out", triTargetCourse, rid);
      triangleAddEdge_(context.edges, triSource, triTargetSlot.date, triTargetSlot.period, "in", triSourceCourse, rid);
      return;
    }
    var source = triangleTeacherEmailFromRow_(row, false, context.semesterId, context.directory);
    var target = triangleTeacherEmailFromRow_(row, true, context.semesterId, context.directory);
    var sourceSlot = triangleSlotFromRow_(row, false);
    var sourceCourse = triangleCourseFromRow_(row, false);
    triangleAddEdge_(context.edges, source, sourceSlot.date, sourceSlot.period, "out", sourceCourse, rid);
    triangleAddEdge_(context.edges, target, sourceSlot.date, sourceSlot.period, "in", sourceCourse, rid);
    if (type === "exchange") {
      var targetSlot = triangleSlotFromRow_(row, true);
      var targetCourse = triangleCourseFromRow_(row, true);
      triangleAddEdge_(context.edges, target, targetSlot.date, targetSlot.period, "out", targetCourse, rid);
      triangleAddEdge_(context.edges, source, targetSlot.date, targetSlot.period, "in", targetCourse, rid);
    }
  });
}

function triangleAddPendingSlot_(pending, email, date, period) {
  var em = triangleText_(email).toLowerCase();
  var p = trianglePeriod_(period);
  var d = triangleText_(date).slice(0, 10);
  if (!em || !d || p === null) return;
  pending[triangleCellKey_(em, d, p)] = true;
}

function triangleBuildPendingIndex_(context, ignoreTriangleId) {
  var pack = getSemesterRequestsCached_(context.semesterId, true, 0);
  var rows = pack && pack.rows ? pack.rows : [];
  var ignored = triangleText_(ignoreTriangleId);
  rows.forEach(function (row) {
    var status = String(translateStatusToEn(row && row["狀態"] || row && row.status) || "").toLowerCase();
    if (status !== "pending_teacher" && status !== "pending_admin") return;
    var type = String(translateTypeToEn(row && row["異動類型"] || row && row.type) || "").toLowerCase();
    var triId = triangleText_(row && row["三角調ID"] || row && row.triangleId);
    if (ignored && triId === ignored) return;
    var source = triangleTeacherEmailFromRow_(row, false, context.semesterId, context.directory);
    var target = triangleTeacherEmailFromRow_(row, true, context.semesterId, context.directory);
    var sourceSlot = triangleSlotFromRow_(row, false);
    if (type === TRIANGLE_TYPE_) {
      var triangleTargetSlot = triangleSlotFromRow_(row, true);
      triangleAddPendingSlot_(context.pending, source, sourceSlot.date, sourceSlot.period);
      triangleAddPendingSlot_(context.pending, source, triangleTargetSlot.date, triangleTargetSlot.period);
      return;
    }
    triangleAddPendingSlot_(context.pending, source, sourceSlot.date, sourceSlot.period);
    triangleAddPendingSlot_(context.pending, target, sourceSlot.date, sourceSlot.period);
    var targetSlot = triangleSlotFromRow_(row, true);
    if (type === "exchange") {
      triangleAddPendingSlot_(context.pending, source, targetSlot.date, targetSlot.period);
      triangleAddPendingSlot_(context.pending, target, targetSlot.date, targetSlot.period);
    }
  });
}

function triangleCurrentCell_(context, email, date, day, period) {
  var key = triangleCellKey_(email, date, period);
  var edges = context.edges[key] || [];
  var incoming = edges.find(function (edge) { return edge.direction === "in"; });
  if (incoming) {
    return {
      occupied: true,
      changed: true,
      isPatrol: false,
      className: incoming.className,
      subject: incoming.subject,
      attr: ""
    };
  }
  var outgoing = edges.find(function (edge) { return edge.direction === "out"; });
  if (outgoing) return { occupied: false, changed: true, isPatrol: false, className: "", subject: "", attr: "" };
  return triangleBaseCell_(context, email, date, day, period);
}

function triangleCourseUsable_(cell) {
  return !!(cell && cell.occupied && !cell.isPatrol && cell.className && cell.subject);
}

function trianglePullOut_(cell) {
  return !!(cell && String(cell.attr || "").trim() === "抽離");
}

function triangleSameSlot_(a, b) {
  return !!(a && b && triangleText_(a.date).slice(0, 10) === triangleText_(b.date).slice(0, 10)
    && trianglePeriod_(a.period) === trianglePeriod_(b.period));
}

function triangleValidateDateInSemester_(date, semesterId) {
  var value = triangleText_(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !triangleDateDay_(value)) return false;
  var semester = (getTableData("學期設定") || []).find(function (row) {
    return String(row["學期代號"] || row.id || "").trim() === String(semesterId || "").trim();
  });
  if (semester) {
    var start = String(semester["開始日期"] || semester.startDate || "").slice(0, 10);
    var end = String(semester["結束日期"] || semester.endDate || "").slice(0, 10);
    if ((start && value < start) || (end && value > end)) return false;
  }
  return true;
}

function validateTriangleRequestRows_(rows, semesterId, ignoreTriangleId) {
  var list = Array.isArray(rows) ? rows : [];
  var errors = [];
  var context = triangleScheduleContext_(semesterId);
  triangleBuildEdgeIndex_(context, ignoreTriangleId);
  triangleBuildPendingIndex_(context, ignoreTriangleId);
  var sourceSet = {};
  var targetSet = {};
  var legs = [];
  var pullOutCount = 0;
  var classNames = [];

  if (list.length !== 3) errors.push("三角調必須正好包含三條交換關係");
  list.forEach(function (row, index) {
    var no = index + 1;
    if (!isTriangleRequest_(row)) {
      errors.push("第" + no + "列異動類型不是三角調");
      return;
    }
    var source = triangleTeacherEmailFromRow_(row, false, context.semesterId, context.directory);
    var target = triangleTeacherEmailFromRow_(row, true, context.semesterId, context.directory);
    var sourceSlot = triangleSlotFromRow_(row, false);
    var targetSlot = triangleSlotFromRow_(row, true);
    var sourceCourse = triangleCourseFromRow_(row, false);
    var targetCourse = triangleCourseFromRow_(row, true);
    if (!source || !target) errors.push("第" + no + "列缺少來源或目標教師");
    if (source && target && source === target) errors.push("第" + no + "列來源教師與目標教師不可相同");
    if (source && sourceSet[source]) errors.push("同一位教師不可提供兩堂原課");
    if (target && targetSet[target]) errors.push("同一位教師不可接收兩個目標時段");
    if (source) sourceSet[source] = true;
    if (target) targetSet[target] = true;
    if (!triangleValidateDateInSemester_(sourceSlot.date, semesterId) || sourceSlot.period === null) {
      errors.push("第" + no + "列來源課堂日期／節次無效");
    }
    if (!triangleValidateDateInSemester_(targetSlot.date, semesterId) || targetSlot.period === null) {
      errors.push("第" + no + "列目標課堂日期／節次無效");
    }
    if (!source || !target || sourceSlot.period === null || targetSlot.period === null) return;
    var sourceCell = triangleCurrentCell_(context, source, sourceSlot.date, sourceSlot.day, sourceSlot.period);
    var targetCell = triangleCurrentCell_(context, target, targetSlot.date, targetSlot.day, targetSlot.period);
    if (!sourceCell || sourceCell.changed || !triangleCourseUsable_(sourceCell)) {
      errors.push("第" + no + "列來源課堂必須是尚未異動的有效一般課程");
    }
    if (!targetCell || targetCell.changed || !triangleCourseUsable_(targetCell)) {
      errors.push("第" + no + "列目標課堂必須是尚未異動的有效一般課程");
    }
    if (context.pending[triangleCellKey_(source, sourceSlot.date, sourceSlot.period)]
        || context.pending[triangleCellKey_(target, targetSlot.date, targetSlot.period)]) {
      errors.push("第" + no + "列課堂已有進行中的異動申請");
    }
    if (sourceCell && sourceCell.occupied) {
      if (sourceCourse.className && sourceCourse.className !== sourceCell.className) errors.push("第" + no + "列來源班級與目前課表不一致");
      if (sourceCourse.subject && sourceCourse.subject !== sourceCell.subject) errors.push("第" + no + "列來源科目與目前課表不一致");
      row["班級"] = sourceCell.className;
      row["科目"] = sourceCell.subject;
    }
    if (targetCell && targetCell.occupied) {
      if (targetCourse.className && targetCourse.className !== targetCell.className) errors.push("第" + no + "列目標班級與目前課表不一致");
      if (targetCourse.subject && targetCourse.subject !== targetCell.subject) errors.push("第" + no + "列目標科目與目前課表不一致");
      row["對調目標班級"] = targetCell.className;
      row["對調目標科目"] = targetCell.subject;
    }
    classNames.push(row["班級"] || sourceCourse.className, row["對調目標班級"] || targetCourse.className);
    if (trianglePullOut_(sourceCell)) pullOutCount++;
    legs.push({ source: source, target: target, sourceSlot: sourceSlot, targetSlot: targetSlot,
      sourceCourse: sourceCourse, targetCourse: targetCourse });
  });

  if (Object.keys(sourceSet).length === 3 && Object.keys(targetSet).length === 3) {
    var classReference = classNames.find(function (name) { return triangleText_(name) !== ""; }) || "";
    if (!classReference || classNames.some(function (name) {
      return triangleText_(name) !== "" && !triangleSameClass_(classReference, name);
    })) {
      errors.push("三角調三條原課必須屬於同一班");
    }
    Object.keys(sourceSet).forEach(function (key) {
      if (!targetSet[key]) errors.push("三角調三位教師必須形成閉環");
    });
    legs.forEach(function (leg) {
      var next = legs.find(function (candidate) { return candidate.source === leg.target; });
      if (!next || !triangleSameSlot_(leg.targetSlot, next.sourceSlot)) {
        errors.push("目標課堂必須是目標教師提供的原課，且三條關係必須閉環");
      }
    });
  }
  if (pullOutCount > 0 && pullOutCount < legs.length) {
    errors.push("抽離課只能三堂全部為抽離課，不能與一般課混調");
  }

  // 先移除每位教師的來源課，再檢查新增目標時段，允許交換中間暫時衝堂。
  legs.forEach(function (leg, index) {
    if (leg.sourceSlot.period === null) return;
    var key = triangleCellKey_(leg.source, leg.targetSlot.date, leg.targetSlot.period);
    if (triangleSameSlot_(leg.sourceSlot, leg.targetSlot)) return;
    if (context.pending[key]) errors.push("第" + (index + 1) + "列新增目標時段已有進行中的異動申請");
    var finalCell = triangleCurrentCell_(context, leg.source, leg.targetSlot.date, leg.targetSlot.day, leg.targetSlot.period);
    if (finalCell && finalCell.occupied) errors.push("完整三角交換後仍有教師最終時段衝堂");
  });

  var unique = [];
  errors.forEach(function (error) { if (unique.indexOf(error) === -1) unique.push(error); });
  if (unique.length) throw new Error("三角調資料驗證失敗：" + unique.slice(0, 10).join("；"));
  return { legs: legs, context: context };
}

function triangleGroupIdFromRow_(row) {
  return triangleText_(row && (row["三角調ID"] || row.triangleId || row["批次ID"]));
}

function getTriangleGroupRows_(semesterId, triangleId) {
  var id = triangleText_(triangleId);
  if (!id) return [];
  return findRowsByColumnValue_("申請單", "三角調ID", id, function (row) {
    return String(row["學期代號"] || "").trim() === String(semesterId || "").trim()
      && isTriangleRequest_(row);
  }).sort(function (a, b) {
    return (parseInt(a["三角腳次"], 10) || 0) - (parseInt(b["三角腳次"], 10) || 0);
  });
}

function triangleAssertGroup_(rows, semesterId, action, ignoreTriangleId) {
  var list = Array.isArray(rows) ? rows : [];
  if (list.length !== 3) throw new Error("三角調整組必須完整包含三條申請單，無法" + action + "！");
  var id = triangleGroupIdFromRow_(list[0]);
  if (!id || list.some(function (row) { return triangleGroupIdFromRow_(row) !== id; })) {
    throw new Error("三角調群組資料不完整，無法" + action + "！");
  }
  validateTriangleRequestRows_(list, semesterId, ignoreTriangleId || id);
  return list;
}

function triangleInputRows_(data, semesterId, teachers, actorEmail, actorName) {
  var payload = data || {};
  var rawLegs = payload.legs || payload.requests || (payload.triangle && payload.triangle.legs) || [];
  if (!Array.isArray(rawLegs) || rawLegs.length !== 3) throw new Error("三角調必須提供正好三條交換關係！");
  var directory = buildNameKeyDirectory_(teachers || []);
  var requestedId = triangleText_(payload.triangleId || payload["三角調ID"]);
  if (requestedId && !/^[A-Za-z0-9_-]{4,80}$/.test(requestedId)) throw new Error("三角調ID格式不正確！");
  var triangleId = requestedId || ("tri_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  var serialBase = triangleText_(payload.serial || payload["單號"]) || triangleId;
  var triangleReason = triangleText_(payload.reason || payload["請假事由"]) || "請假";
  var triangleLeaveTimeType = triangleText_(payload.leaveTimeType || payload["請假時間類型"]);
  var triangleLeaveTime = triangleText_(payload.leaveTime || payload["請假時間"]);
  var triangleNote = triangleText_(payload.note || payload["備註"]);
  var now = toLocalTimeStr(new Date());
  var rows = rawLegs.map(function (raw, index) {
    var sourcePerson = trianglePick_(raw, ["sourceTeacher", "fromTeacher", "requesterName", "申請人姓名"]);
    var targetPerson = trianglePick_(raw, ["targetTeacher", "toTeacher", "targetTeacherName", "受邀人姓名"]);
    var sourceEmailInput = trianglePick_(raw, ["sourceTeacherEmail", "requesterEmail", "申請人Email"]);
    var targetEmailInput = trianglePick_(raw, ["targetTeacherEmail", "受邀人Email"]);
    var sourceName = resolveNameKeyPair_(trianglePersonValue_(sourcePerson, "name"), trianglePersonValue_(sourceEmailInput, "email"), semesterId, directory, "三角調來源教師", false);
    var targetName = resolveNameKeyPair_(trianglePersonValue_(targetPerson, "name"), trianglePersonValue_(targetEmailInput, "email"), semesterId, directory, "三角調目標教師", false);
    var sourceEmail = nameKeyEmailForName_(semesterId, sourceName, directory);
    var targetEmail = nameKeyEmailForName_(semesterId, targetName, directory);
    var sourceSlot = raw.sourceSlot || raw.source || raw;
    var targetSlot = raw.targetSlot || raw.target || raw;
    var sourceCourse = raw.sourceCourse || raw.course || raw;
    var targetCourse = raw.targetCourse || raw.targetCourseData || raw.target || {};
    var sourceDate = trianglePick_(sourceSlot, ["date", "sourceDate", "requestDate", "異動日期"]);
    var sourceDay = trianglePick_(sourceSlot, ["day", "sourceDay", "dayOfWeek", "異動星期"]);
    var sourcePeriod = trianglePick_(sourceSlot, ["period", "sourcePeriod", "requestPeriod", "異動節次"]);
    var targetDate = trianglePick_(targetSlot, ["date", "targetDate", "對調目標日期"]);
    var targetDay = trianglePick_(targetSlot, ["day", "targetDay", "dayOfWeek", "對調目標星期"]);
    var targetPeriod = trianglePick_(targetSlot, ["period", "targetPeriod", "對調目標節次"]);
    var sourceClass = triangleText_(trianglePick_(sourceCourse, ["className", "class", "班級"]));
    var sourceSubject = triangleText_(trianglePick_(sourceCourse, ["subject", "科目"]));
    var targetClass = triangleText_(trianglePick_(targetCourse, ["className", "class", "班級"]));
    var targetSubject = triangleText_(trianglePick_(targetCourse, ["subject", "科目"]));
    var row = {
      "學期代號": semesterId,
      "申請單ID": triangleText_(raw.requestId || raw.id) || (triangleId + "_" + (index + 1)),
      "單號": serialBase + "-" + (index + 1),
      "批次ID": triangleId,
      "狀態": "pending_teacher",
      "直接核准": "",
      "紙本流程": "FALSE",
      "申請人姓名": sourceName,
      "受邀人姓名": targetName,
      "申請人Email": sourceEmail,
      "受邀人Email": targetEmail,
      "班級": sourceClass,
      "科目": sourceSubject,
      "異動日期": triangleText_(sourceDate).slice(0, 10),
      "異動星期": parseInt(sourceDay, 10) || triangleDateDay_(sourceDate),
      "異動節次": trianglePeriod_(sourcePeriod),
      "異動類型": TRIANGLE_TYPE_,
      "特殊流程": "",
      "對調目標日期": triangleText_(targetDate).slice(0, 10),
      "對調目標星期": parseInt(targetDay, 10) || triangleDateDay_(targetDate),
      "對調目標節次": trianglePeriod_(targetPeriod),
      "對調目標班級": targetClass,
      "對調目標科目": targetSubject,
      "三角調ID": triangleId,
      "三角腳次": index + 1,
      "三角同意狀態": TRIANGLE_CONSENT_PENDING_,
      "三角同意時間": "",
      "三角組狀態": "pending_teacher",
      "經費來源": "無",
      "請假事由": triangleReason,
      "請假時間類型": triangleLeaveTimeType,
      "請假時間": triangleLeaveTime,
      "是否已印": "FALSE",
      "備註": triangleText_(raw.note || raw["備註"]) || triangleNote,
      "建立時間": now,
      "更新時間": now
    };
    row.requesterName = sourceName;
    row.targetTeacherName = targetName;
    row.requesterEmail = sourceEmail;
    row.targetTeacherEmail = targetEmail;
    return row;
  });
  var people = {};
  rows.forEach(function (row) {
    people[row["申請人Email"]] = true;
    people[row["受邀人Email"]] = true;
  });
  if (!people[triangleText_(actorEmail).toLowerCase()]) {
    var actorIsAdmin = resolveIsAdmin_(actorEmail, teachers || []);
    var actorCanProxy = canUserProxySubmit_(actorEmail, teachers || []);
    if (!actorIsAdmin && !actorCanProxy) throw new Error("三角調發起人必須是三位參與教師，或由已授權行政代送！");
    rows.forEach(function (row) {
      row["代申請人姓名"] = actorName || actorEmail;
      row["代申請人Email"] = actorEmail;
    });
  }
  validateTriangleRequestRows_(rows, semesterId, "");
  return { triangleId: triangleId, rows: rows };
}

function triangleGroupRowsForRequest_(requestRow, semesterId, action) {
  var triangleId = triangleGroupIdFromRow_(requestRow);
  if (!triangleId) throw new Error("三角調申請單缺少三角調ID，無法" + action + "！");
  var rows = getTriangleGroupRows_(semesterId, triangleId);
  return triangleAssertGroup_(rows, semesterId, action, triangleId);
}

function triangleGroupAllAgreed_(rows) {
  return (rows || []).length === 3 && rows.every(function (row) {
    return String(row["三角同意狀態"] || "").trim().toLowerCase() === TRIANGLE_CONSENT_AGREE_;
  });
}

function triangleSetGroupStatus_(rows, status) {
  (rows || []).forEach(function (row) {
    row["狀態"] = status;
    row["三角組狀態"] = status;
  });
}

function respondTriangleRequest_(requestRow, semesterId, userEmail, response, currentUrl) {
  var resp = String(response || "").toLowerCase().trim();
  if (resp !== TRIANGLE_CONSENT_AGREE_ && resp !== TRIANGLE_CONSENT_DECLINE_) {
    throw new Error("三角調簽核回應格式不正確！");
  }
  var rows = triangleGroupRowsForRequest_(requestRow, semesterId, "簽核");
  var actor = String(userEmail || "").toLowerCase().trim();
  var own = rows.find(function (row) {
    return String(row["受邀人Email"] || "").toLowerCase().trim() === actor;
  });
  if (!own || String(own["狀態"] || "") !== "pending_teacher") {
    throw new Error("您無權對此三角調邀請進行操作，或該邀請已處理！");
  }
  var now = toLocalTimeStr(new Date());
  own["三角同意狀態"] = resp;
  own["三角同意時間"] = now;
  if (resp === TRIANGLE_CONSENT_DECLINE_) {
    rows.forEach(function (row) {
      if (row !== own && String(row["三角同意狀態"] || "") === TRIANGLE_CONSENT_PENDING_) {
        row["三角同意狀態"] = "declined_by_group";
        row["三角同意時間"] = now;
      }
    });
    triangleSetGroupStatus_(rows, "rejected");
  } else if (triangleGroupAllAgreed_(rows)) {
    triangleSetGroupStatus_(rows, "pending_admin");
  } else {
    triangleSetGroupStatus_(rows, "pending_teacher");
  }
  saveRows("申請單", rows, "申請單ID");
  if (resp === TRIANGLE_CONSENT_AGREE_ && triangleGroupAllAgreed_(rows)) {
    queueMail_("sendTriangleReadyEmail", function () {
      sendTriangleReadyEmail_(rows, currentUrl);
    });
  }
  invalidateSemesterCaches_(semesterId);
  return {
    success: true,
    triangleId: triangleGroupIdFromRow_(rows[0]),
    response: resp,
    groupStatus: String(rows[0]["三角組狀態"] || ""),
    count: rows.length
  };
}

function approveTriangleRequest_(requestRow, semesterId, operatorEmail, currentUrl, note) {
  var rows = triangleGroupRowsForRequest_(requestRow, semesterId, "核准");
  var paperFlow = rows.every(function (row) { return isPaperFlowRow_(row); });
  if (rows.some(function (row) { return String(row["狀態"] || "") !== "pending_admin"; })) {
    throw new Error("三角調必須等三位教師全部同意後，才能由教學組核准！");
  }
  if (!paperFlow && !triangleGroupAllAgreed_(rows)) throw new Error("三角調尚未完成三方同意！");
  validateTriangleRequestRows_(rows, semesterId, triangleGroupIdFromRow_(rows[0]));
  triangleSetGroupStatus_(rows, "approved");
  if (paperFlow) {
    var paperApprovedAt = toLocalTimeStr(new Date());
    rows.forEach(function (row) {
      row["三角同意狀態"] = "paper_agreed";
      row["三角同意時間"] = paperApprovedAt;
    });
  }
  if (note) rows.forEach(function (row) { row["備註"] = note; });
  saveRows("申請單", rows, "申請單ID");
  if (!paperFlow) {
    queueMail_("sendTriangleApprovedEmail", function () {
      sendTriangleApprovedEmail_(rows, currentUrl);
    });
  }
  invalidateSemesterCaches_(semesterId);
  return { success: true, triangleId: triangleGroupIdFromRow_(rows[0]), count: rows.length };
}

function rejectTriangleRequest_(requestRow, semesterId, operatorEmail, currentUrl, note) {
  var rows = triangleGroupRowsForRequest_(requestRow, semesterId, "駁回");
  if (rows.some(function (row) { return String(row["狀態"] || "") !== "pending_admin"; })) {
    throw new Error("三角調目前不是待行政審核狀態！");
  }
  triangleSetGroupStatus_(rows, "admin_rejected");
  if (note) rows.forEach(function (row) { row["備註"] = note; });
  saveRows("申請單", rows, "申請單ID");
  invalidateSemesterCaches_(semesterId);
  return { success: true, triangleId: triangleGroupIdFromRow_(rows[0]), count: rows.length };
}

function cancelTriangleRequest_(requestRow, semesterId, actorEmail, nextStatus) {
  var rows = triangleGroupRowsForRequest_(requestRow, semesterId, "撤回");
  var actor = String(actorEmail || "").toLowerCase().trim();
  var allowed = resolveIsAdmin_(actor, getSemesterTeachersCached_(semesterId) || [])
    || rows.some(function (row) { return String(row["申請人Email"] || "").toLowerCase().trim() === actor; });
  if (!allowed) throw new Error("您無權撤回此三角調群組！");
  if (rows.some(function (row) {
    var status = String(translateStatusToEn(row["狀態"]) || row["狀態"] || "").toLowerCase();
    return status !== "pending_teacher" && status !== "pending_admin";
  })) throw new Error("三角調目前狀態無法撤回！");
  triangleSetGroupStatus_(rows, nextStatus || "cancelled");
  rows.forEach(function (row) {
    if (String(row["三角同意狀態"] || "") === TRIANGLE_CONSENT_PENDING_
        || String(row["三角同意狀態"] || "") === "paper_pending") {
      row["三角同意狀態"] = "cancelled_by_group";
      row["三角同意時間"] = toLocalTimeStr(new Date());
    }
  });
  saveRows("申請單", rows, "申請單ID");
  invalidateSemesterCaches_(semesterId);
  return { success: true, triangleId: triangleGroupIdFromRow_(rows[0]), count: rows.length };
}

function deleteApprovedTriangleRequest_(requestRow, semesterId) {
  var rows = triangleGroupRowsForRequest_(requestRow, semesterId, "撤銷");
  if (rows.some(function (row) { return String(translateStatusToEn(row["狀態"]) || row["狀態"] || "").toLowerCase() !== "approved"; })) {
    throw new Error("三角調目前不是已核准狀態，無法撤銷！");
  }
  triangleSetGroupStatus_(rows, "cancelled");
  rows.forEach(function (row) {
    row["備註"] = String(row["備註"] || "").trim() || "管理員撤銷三角調";
  });
  saveRows("申請單", rows, "申請單ID");
  invalidateSemesterCaches_(semesterId);
  return { success: true, triangleId: triangleGroupIdFromRow_(rows[0]), count: rows.length };
}

function persistRequestRowsWithQuota_(rows, operatorEmail) {
  var list = Array.isArray(rows) ? rows : [];
  var quotaResult = spendMutualQuotaForRequests_(list, operatorEmail);
  try {
    saveRows("申請單", list, "申請單ID");
  } catch (saveErr) {
    if (quotaResult && quotaResult.wrote) {
      try { restoreMutualQuotaForRequests_(list); } catch (restoreErr) { logError_("restoreQuota_after_request_save_failure", restoreErr); }
    }
    throw saveErr;
  }
  return quotaResult;
}

// ----------------- 主入口：doPost（讀寫） -----------------
function doPost(e) {
  var requestContext = {
    requestId: "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    action: "unknown",
    operator: "",
    semesterId: "",
    importVersion: ""
  };
  try {
    resetRequestContext_();
    ensureInit_();
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;
    requestContext.action = String(action || "unknown");
    requestContext.semesterId = String(postData.semesterId || "").trim();

    // 讀取類：不佔寫入鎖；getPublicClassData 免 Token
    if (action === "getInitialData" || action === "getMetaData" || action === "getPublicClassData"
        || action === "getPendingOnly" || action === "getHistoryMonth"
        || action === "getMatchCandidates" || action === "getMutualQuotaLedger"
        || action === "getHomeroomRecords") {
      return handleReadAction_(postData);
    }

    // 驗證／權限在鎖外（Token＋教師快取），縮短鎖持有時間
    const idToken = postData.idToken;
    const semesterId = String(postData.semesterId || "").trim();
    let reqData = postData.data;
    const currentUrl = postData.currentUrl || "";
    const user = verifyGoogleIdToken(idToken);
    const userEmail = String(user.email || "").trim().toLowerCase();
    requestContext.operator = userEmail;
    // 權限用快取教師名單；寫入教師結構的 action 仍會 invalidate
    const teachers = getSemesterTeachersCached_(semesterId) || [];
    const currentTeacher = teachers.find(function (t) {
      return String(t["教師Email"] || t.email || t.loginEmail || "").trim().toLowerCase() === userEmail;
    });
    const isAdmin = resolveIsAdmin_(userEmail, teachers);
    const isStaff = resolveIsStaff_(userEmail, teachers);
    var ADMIN_ONLY_ACTIONS = {
      saveSemester: 1, deleteSemester: 1, setDefaultSemester: 1,
       saveClassAwayEvent: 1, deleteClassAwayEvent: 1,
       saveSchoolSwap: 1, deleteSchoolSwap: 1,
      saveTeacher: 1, deleteTeacher: 1, importTeachersBatch: 1, updateMutualQuotas: 1,
      earnMutualQuotaFromActivity: 1,
      saveScheduleCell: 1, clearScheduleCell: 1, importSchedulesBatch: 1,
      adminApprove: 1, adminReject: 1, adminApproveBatch: 1, adminRejectBatch: 1,
      saveHomeroomCoverTeacher: 1,
      deleteSubstitutionRecord: 1,
      saveHistoryEdit: 1, batchMarkPrinted: 1, saveMailSettings: 1, sendBatchNotices: 1,
      migrateNameKeySchema: 1, renameTeacherNameKey: 1
    };
    if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
      throw new Error("權限不足：此操作僅限教學組管理員！");
    }
    if (!isAdmin && !currentTeacher) {
      throw new Error("您的帳號不在本校教師名單中，無法操作！");
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    beginDeferredMails_();
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
    if (action === "migrateNameKeySchema") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var migrationSummary = migrateNameKeySchema_();
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        migrated: true,
        sheets: migrationSummary
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "renameTeacherNameKey") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var renameResult = renameTeacherNameKey_(
        reqData.semesterId || semesterId,
        reqData.fromName || reqData.oldName,
        reqData.toName || reqData.newName
      );
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        renamed: renameResult
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "saveSemester") {
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
      var deleteSid = String(reqData.semesterId || "").trim();
      if (!deleteSid) throw new Error("缺少學期代號！");
      var deleteSem = getTableData("學期設定").find(function (s) {
        return String(s["學期代號"] || s.id || "").trim() === deleteSid;
      });
      if (!deleteSem) throw new Error("找不到要刪除的學期！");
      var deleteIsDefault = String(deleteSem["是否預設"] || deleteSem["預設"] || "").toLowerCase();
      if (deleteIsDefault === "true" || deleteIsDefault === "是" || deleteIsDefault === "1") {
        throw new Error("請先將其他學期設為預設，再刪除此學期！");
      }
       ["教師名單", "教師課表", "申請單", "空堂事件", "額度帳本", "代導紀錄", SCHOOL_SWAP_SHEET_].forEach(function (sheetName) {
        deleteRowsBySemester_(sheetName, deleteSid);
      });
      deleteRows("學期設定", "學期代號", deleteSid);
      invalidateScheduleCaches_(deleteSid);
      
    } else if (action === "setDefaultSemester") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const sems = getTableData("學期設定");
      sems.forEach(s => {
        s["是否預設"] = (s["學期代號"] === reqData.semesterId) ? "TRUE" : "FALSE";
      });
      saveRows("學期設定", sems, "學期代號");
      sems.forEach(function (s) { invalidateSemesterCaches_(s["學期代號"]); });

    } else if (action === "saveSchoolSwap") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var savedSchoolSwap = saveSchoolSwapRow_(reqData || {}, semesterId, userEmail);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        schoolSwap: savedSchoolSwap
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "deleteSchoolSwap") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var deleteSchoolSwapId = String((reqData && (reqData.id || reqData["對調ID"])) || "").trim();
      if (!deleteSchoolSwapId) throw new Error("缺少對調ID！");
      deleteRows(SCHOOL_SWAP_SHEET_, "對調ID", deleteSchoolSwapId, function (row) {
        return String(row["學期代號"] || "").trim() === String(semesterId || "").trim();
      });
      invalidateScheduleCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        id: deleteSchoolSwapId
      })).setMimeType(ContentService.MimeType.JSON);

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
       deleteRows("空堂事件", "事件ID", delId, function (row) {
         return String(row["學期代號"] || "").trim() === String(semesterId || "").trim();
       });
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "saveTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      reqData["學期代號"] = semesterId;
      reqData["教師Email"] = normalizeEmail_(reqData["教師Email"] || reqData.email, "教師 Email");
      reqData["教師姓名"] = nameKeyText_(reqData["教師姓名"] || reqData.name);
      if (!reqData["教師姓名"]) throw new Error("教師姓名不可空白");
      var rosterBeforeSave = getTableData("教師名單") || [];
      var oldTeacher = rosterBeforeSave.find(function (row) {
        return nameKeySemester_(row) === String(semesterId || "")
          && nameKeyTeacherEmail_(row) === reqData["教師Email"];
      });
      if (oldTeacher && nameKeyNorm_(nameKeyTeacherName_(oldTeacher)) !== nameKeyNorm_(reqData["教師姓名"])) {
        renameTeacherNameKey_(semesterId, nameKeyTeacherName_(oldTeacher), reqData["教師姓名"]);
      }
      if (reqData["系統角色"] != null || reqData.role != null) {
        reqData["系統角色"] = normalizeRole_(reqData["系統角色"] != null ? reqData["系統角色"] : reqData.role);
      }
      saveRows("教師名單", [reqData], "教師Email");
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "deleteTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var deleteTeacherEmail = normalizeEmail_(reqData.email || reqData["教師Email"], "教師 Email");
      assertTeacherNameKeyCanDelete_(semesterId, deleteTeacherEmail);
      deleteRows("教師名單", "教師Email", deleteTeacherEmail, function (row) {
        return String(row["學期代號"] || "").trim() === String(semesterId || "").trim();
      });
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "importTeachersBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      const list = (reqData.list || []).map(function (t) {
        t["學期代號"] = semesterId;
        t["教師Email"] = normalizeEmail_(t["教師Email"] || t.email, "教師 Email");
        t["教師姓名"] = nameKeyText_(t["教師姓名"] || t.name);
        if (!t["教師姓名"]) throw new Error("教師姓名不可空白");
        if (t["系統角色"] != null || t.role != null) {
          t["系統角色"] = normalizeRole_(t["系統角色"] != null ? t["系統角色"] : t.role);
        }
        return t;
      });
      var importNamesByEmail = {};
      list.forEach(function (row) {
        var em = row["教師Email"];
        var nm = nameKeyNorm_(row["教師姓名"]);
        if (importNamesByEmail[em] && importNamesByEmail[em] !== nm) {
          throw new Error("同一批教師匯入中，Email 對應多個姓名：" + em);
        }
        importNamesByEmail[em] = nm;
      });
      var rosterBeforeImport = getTableData("教師名單") || [];
      Object.keys(importNamesByEmail).forEach(function (em) {
        var oldRow = rosterBeforeImport.find(function (row) {
          return nameKeySemester_(row) === String(semesterId || "") && nameKeyTeacherEmail_(row) === em;
        });
        var incoming = list.find(function (row) { return row["教師Email"] === em; });
        if (oldRow && incoming && nameKeyNorm_(nameKeyTeacherName_(oldRow)) !== nameKeyNorm_(incoming["教師姓名"])) {
          renameTeacherNameKey_(semesterId, nameKeyTeacherName_(oldRow), incoming["教師姓名"]);
        }
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
      reqData = normalizePatrolScheduleRow_(reqData);
      reqData["學期代號"] = semesterId;
      var currentScheduleRows = getTableData("教師課表") || [];
      var scheduleId = String(reqData["課表ID"] || "").trim();
      var previousId = String(reqData["前課表ID"] || reqData.previousId || "").trim();
      var saveRowsList = [reqData];
      var ignoredScheduleIds = [scheduleId];
      if (previousId) {
        if (!reqData["啟用起日"] && !reqData.activeFrom) {
          throw new Error("建立課表新版本時必須填寫啟用起日！");
        }
        if (previousId === scheduleId) throw new Error("課表新版本不可使用相同的課表ID！");
        var previousRow = currentScheduleRows.find(function (row) {
          return String(row["學期代號"] || "").trim() === String(semesterId || "").trim()
            && scheduleRowId_(row) === previousId;
        });
        if (!previousRow) throw new Error("找不到要結束的舊課表版本！");
        if (scheduleSlotGroupKey_(previousRow) !== scheduleSlotGroupKey_(reqData)) {
          throw new Error("課表新版本必須與舊版本維持相同教師、星期、節次與單／雙週設定，班級與科目可變更！");
        }
        var newActiveFrom = scheduleActiveFrom_(reqData, true);
        var previousActiveFrom = scheduleActiveFrom_(previousRow, false);
        if (previousActiveFrom && newActiveFrom <= previousActiveFrom) {
          throw new Error("新版本啟用起日必須晚於舊版本啟用起日！");
        }
        var closedPrevious = Object.assign({}, previousRow);
        var closedTo = schedulePreviousDate_(newActiveFrom);
        var existingPreviousTo = scheduleActiveTo_(previousRow, false);
        if (existingPreviousTo && existingPreviousTo < closedTo) closedTo = existingPreviousTo;
        closedPrevious["啟用迄日"] = closedTo;
        closedPrevious["啟用起日"] = previousActiveFrom;
        saveRowsList.unshift(closedPrevious);
        ignoredScheduleIds.push(previousId);
      }
      var scheduleExistingRows = currentScheduleRows.filter(function (row) {
        return String(row["學期代號"] || "").trim() === String(semesterId || "").trim();
      });
      validateScheduleImportRows_(saveRowsList, semesterId, {
        existingRows: scheduleExistingRows,
        ignoreIds: ignoredScheduleIds,
        semesterRange: scheduleDateRange_(semesterId)
      });
      saveRows("教師課表", saveRowsList, "課表ID");
      invalidateScheduleCaches_(semesterId);
      
    } else if (action === "clearScheduleCell") {
      if (!isAdmin) throw new Error("無管理員權限！");
       deleteRows("教師課表", "課表ID", reqData.id, function (row) {
         return String(row["學期代號"] || "").trim() === String(semesterId || "").trim();
       });
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
      var teacherSheetImp = ssImp.getSheetByName("教師名單");
      var teacherHeadersImp = getHeadersForSheet("教師名單");
      var semKey = "學期代號";
      var sidStr = String(semesterId || "");
      if (headersImp.some(function (header) { return /email|電子郵件|e-mail/i.test(String(header || "")); })) {
        throw new Error("教師課表仍是舊 Email schema，請先執行姓名鍵 migration；原資料未刪除");
      }
      var allTeacherExisting = getTableData("教師名單") || [];
      // 課表只允許連接既有教師姓名；教師帳號與 Email 必須先在教師名單建立。
      var importTeacherRows = allTeacherExisting;

      var list = normalizeNameKeyRows_("教師課表", importList, importTeacherRows, sidStr).map(function (s) {
        s[semKey] = semesterId;
        if (!s["課表ID"]) {
          var name0 = String(s["教師姓名"] || "t").replace(/\s+/g, "_");
          s["課表ID"] = "sched_" + name0 + "_" + s["星期"] + "_" + s["節次"] + "_" +
            String(s["班級"] || "x") + "_" + Utilities.getUuid().replace(/-/g, "").substr(0, 8);
        }
        return s;
      });

      var allExisting = getTableData("教師課表") || [];
      validateScheduleImportRows_(list, sidStr, {
        existingRows: replaceAll ? [] : allExisting.filter(function (row) {
          return String(row[semKey] || "").trim() === sidStr;
        }),
        ignoreIds: replaceAll ? [] : list.map(function (row) { return row["課表ID"]; }),
        semesterRange: scheduleDateRange_(sidStr)
      });
      // 所有快照先在寫入閘門外準備，避免內部回復讀取被匯入狀態阻擋。
      var scheduleBackupRows = allExisting.map(function (row) {
        return buildRowArray_("教師課表", headersImp, row);
      });
      var teacherBackupRows = allTeacherExisting.map(function (row) {
        return buildRowArray_("教師名單", teacherHeadersImp, row);
      });
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
      var importRows = list.map(function (row) {
        return buildRowArray_("教師課表", headersImp, row);
      });
      var importVersion = createScheduleImportVersion_();
      requestContext.importVersion = importVersion;
      var stagingSheet = getOrCreateScheduleImportSheet_(ssImp, SCHEDULE_IMPORT_STAGING_SHEET_);
      var scheduleBackupSheet = getOrCreateScheduleImportSheet_(ssImp, SCHEDULE_IMPORT_BACKUP_SHEET_);
      var teacherBackupSheet = getOrCreateScheduleImportSheet_(ssImp, TEACHER_IMPORT_BACKUP_SHEET_);

      logOperation_("importSchedulesBatch", "started", {
        requestId: requestContext.requestId,
        operator: userEmail,
        semesterId: sidStr,
        count: list.length,
        replaceAll: replaceAll,
        version: importVersion
      });
      writeScheduleSnapshotSheet_(stagingSheet, headersImp, replaceAll ? outRows : importRows);
      writeScheduleImportBackupSheet_(scheduleBackupSheet, headersImp, scheduleBackupRows,
        importVersion, sidStr, "教師課表");
      writeScheduleImportBackupSheet_(teacherBackupSheet, teacherHeadersImp, teacherBackupRows,
        importVersion, sidStr, "教師名單");

      // 讀取端不佔寫鎖；匯入期間先標記，避免快取未命中時掃到半成品。
      var importStateStarted = false;
      try {
        setScheduleImportState_(sidStr, "writing");
        importStateStarted = true;
        _scheduleImportWriteContext_ = true;
        if (replaceAll) {
          // 暫存快照已驗證；正式表只在讀取閘門內一次覆寫。
          writeScheduleSnapshotSheet_(sheetImp, headersImp, outRows);
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
        _scheduleImportWriteContext_ = false;
        clearScheduleImportState_(sidStr);
        invalidateScheduleCaches_(semesterId);
        logOperation_("importSchedulesBatch", "completed", {
          requestId: requestContext.requestId,
          operator: userEmail,
          semesterId: sidStr,
          count: list.length,
          replaceAll: replaceAll,
          version: importVersion,
          teachersAdded: (reqData.teachers && reqData.teachers.length) || 0
        });
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          count: list.length,
          replaceAll: !!replaceAll,
          semesterOnly: true,
          version: importVersion,
          teachersAdded: (reqData.teachers && reqData.teachers.length) || 0
        })).setMimeType(ContentService.MimeType.JSON);
      } catch (importError) {
        _scheduleImportWriteContext_ = false;
        if (importStateStarted) {
          try {
            restoreScheduleImportSnapshots_(sheetImp, headersImp, scheduleBackupRows,
              teacherSheetImp, teacherHeadersImp, teacherBackupRows);
            clearScheduleImportState_(sidStr);
            invalidateScheduleCaches_(semesterId);
            requestContext.importRolledBack = true;
          } catch (restoreError) {
            requestContext.importRollbackError = String(restoreError);
          }
        }
        throw importError;
      }
      
    } else if (action === "saveHomeroomCoverTeacher") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var recordId = String(reqData.recordId || reqData.id || "").trim();
      var coverDirectory = buildNameKeyDirectory_(teachers);
      var actualRaw = nameKeyText_(reqData.actualTeacherName || reqData.actualTeacherEmail || reqData.teacherName || reqData.teacherEmail);
      var actualName = actualRaw
        ? resolveNameKeyTeacher_(actualRaw, semesterId, coverDirectory, "代導教師", false)
        : "";
      var actualEmail = actualName ? nameKeyEmailForName_(semesterId, actualName, coverDirectory) : "";
      if (!recordId || !actualEmail) throw new Error("缺少代導紀錄或代導教師");
      var coverRows = getSemesterHomeroomRecords_(semesterId);
      var coverRow = coverRows.find(function (r) {
        return String(r["代導紀錄ID"] || r.id || "").trim() === recordId;
      });
      if (!coverRow || !homeroomRecordIsActive_(coverRow)) {
        throw new Error("找不到可指定的代導紀錄");
      }
      var originalEmail = String(coverRow["原導師Email"] || "").trim().toLowerCase();
      if (actualEmail === originalEmail) {
        throw new Error("代導教師不可與原導師相同");
      }
      var coverTeacher = findSemesterTeacher_(semesterId, actualEmail);
      if (!coverTeacher) throw new Error("代導教師不在目前學期教師名單");
      var duplicate = coverRows.some(function (r) {
        if (String(r["代導紀錄ID"] || "").trim() === recordId) return false;
        if (!homeroomRecordIsActive_(r)) return false;
        return String(r["代導日期"] || "").slice(0, 10) === String(coverRow["代導日期"] || "").slice(0, 10)
          && String(r["班級"] || "").trim() === String(coverRow["班級"] || "").trim()
          && String(r["代導教師Email"] || "").trim().toLowerCase() === actualEmail;
      });
      if (duplicate) throw new Error("同日同班的代導教師已有另一筆代導紀錄");
       var coverName = String(coverTeacher["教師姓名"] || coverTeacher.name || actualName);
      var nowCover = toLocalTimeStr(new Date());
      coverRow["代導教師Email"] = actualEmail;
      coverRow["代導教師姓名"] = coverName;
      coverRow["代導節數"] = 1;
      coverRow["鐘點費"] = HOMEROOM_FEE_;
      coverRow["狀態"] = "assigned";
      coverRow["啟用"] = "TRUE";
      coverRow["更新時間"] = nowCover;
      coverRow["操作者"] = userEmail;
      coverRow["備註"] = "教學組指定代導教師";
      saveRows(HOMEROOM_SHEET_, [coverRow], "代導紀錄ID");
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        homeroomRecord: coverRow
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "saveManualHomeroomRecord") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var manualDirectory = buildNameKeyDirectory_(teachers);
      var leaveRaw = nameKeyText_(reqData.leaveName || reqData.leaveEmail || reqData.originalTeacherName || reqData.originalTeacherEmail);
      var leaveName = leaveRaw
        ? resolveNameKeyTeacher_(leaveRaw, semesterId, manualDirectory, "原導師", false)
        : "";
      var leaveEmail = leaveName ? nameKeyEmailForName_(semesterId, leaveName, manualDirectory) : "";
      var dateStr = String(reqData.date || reqData.dateStr || "").trim().slice(0, 10);
      if (!leaveEmail || !dateStr) throw new Error("請提供原導師與代導日期");
      var origTeacher = findSemesterTeacher_(semesterId, leaveEmail);
      if (!origTeacher) throw new Error("原導師不在目前學期教師名單");
      var origName = String(origTeacher["教師姓名"] || origTeacher.name || leaveName);
      var className = extractHomeroomClass_(origTeacher, reqData.className);
      var fallbackTime = homeroomDefaultTime_(origTeacher);
      var timeType = String(reqData.leaveTimeType || "").trim() || fallbackTime.type;
      var timeRange = homeroomNormalizeRange_(reqData.leaveTime || "") || fallbackTime.range;

       var actualRaw = nameKeyText_(reqData.actualTeacherName || reqData.actualTeacherEmail);
       var actualName = actualRaw
         ? resolveNameKeyTeacher_(actualRaw, semesterId, manualDirectory, "代導教師", false)
         : "";
       var actualEmail = actualName ? nameKeyEmailForName_(semesterId, actualName, manualDirectory) : "";
       var status = "pending";
      if (actualEmail) {
        if (actualEmail === leaveEmail) throw new Error("代導教師不可與原導師相同");
        var actualTeacher = findSemesterTeacher_(semesterId, actualEmail);
        if (!actualTeacher) throw new Error("代導教師不在目前學期教師名單");
         actualName = String(actualTeacher["教師姓名"] || actualTeacher.name || actualName);
        status = "assigned";
      }

      var nowManual = toLocalTimeStr(new Date());
      var manualHit = {
        "學期代號": semesterId,
        "代導紀錄ID": "mentor_manual_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
        "來源申請單ID": "manual",
        "原導師Email": leaveEmail,
        "原導師姓名": origName,
        "班級": className,
        "代導日期": dateStr,
        "請假時間類型": timeType,
        "請假時間": timeRange,
        "代導教師Email": actualEmail,
        "代導教師姓名": actualName,
        "代導節數": 1,
        "鐘點費": HOMEROOM_FEE_,
        "狀態": status,
        "啟用": "TRUE",
        "建立時間": nowManual,
        "更新時間": nowManual,
        "操作者": userEmail || "",
        "備註": String(reqData.note || "管理員手動新增代導費").trim()
      };
      saveRows(HOMEROOM_SHEET_, [manualHit], "代導紀錄ID");
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        homeroomRecord: manualHit
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "deleteHomeroomRecord") {
      if (!isAdmin) throw new Error("無管理員權限！");
      var delRecordId = String(reqData.recordId || reqData.id || "").trim();
      if (!delRecordId) throw new Error("缺少代導紀錄ID");
      var delRows = getSemesterHomeroomRecords_(semesterId);
      var delRow = delRows.find(function (r) {
        return String(r["代導紀錄ID"] || r.id || "").trim() === delRecordId;
      });
      if (!delRow) throw new Error("找不到該筆代導紀錄");
      var nowDel = toLocalTimeStr(new Date());
      delRow["啟用"] = "FALSE";
      delRow["狀態"] = "cancelled";
      delRow["更新時間"] = nowDel;
      delRow["操作者"] = userEmail || "";
      saveRows(HOMEROOM_SHEET_, [delRow], "代導紀錄ID");
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        recordId: delRecordId
      })).setMimeType(ContentService.MimeType.JSON);
    } else if (action === "adminApprove") {
      if (!isAdmin) throw new Error("無管理員權限！");
       var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
       if (!targetReq) throw new Error("找不到該申請單");
        assertRequestState_(targetReq, "adminApprove");
        if (isTriangleRequest_(targetReq)) {
          approveTriangleRequest_(targetReq, semesterId, userEmail, currentUrl, reqData.note || "");
        } else {
         if (isCombinedReturnRequest_(targetReq)) {
            validateCombinedReturnRequest_(targetReq, semesterId);
           targetReq["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
         }

        targetReq["狀態"] = "approved";
       if (reqData.note) targetReq["備註"] = reqData.note;
       saveRows("申請單", [targetReq], "申請單ID");
        if (!isCombinedReturnRequest_(targetReq)) syncHomeroomRecordForRequest_(targetReq, userEmail);
       // 紙本流程已由紙本通知，不因之後切回線上模式而補寄系統信。
        if (!isPaperFlowRow_(targetReq)) {
          queueMail_("sendAdminApproveEmail", function () { sendAdminApproveEmail_(targetReq, currentUrl); });
        }
        }
       invalidateSemesterCaches_(semesterId);

    } else if (action === "adminApproveBatch") {
      // 批次核准：只讀目標列、一次 saveRows、再寄信
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "adminApproveBatch");
      var apIds = reqData.requestIds || reqData.ids || [];
      if (!apIds.length) throw new Error("請提供 requestIds");
      if (apIds.length > 40) throw new Error("單次批次核准最多 40 筆");
      var apNormIds = apIds.map(function (id) { return String(id || "").replace(/_[12]$/, ""); });
       var apById = findRowsByKeys_("申請單", "申請單ID", apNormIds, semesterId);
      var apNote = reqData.note || "";
      var apToSave = [];
      var apOkIds = [];
      var apMiss = 0;
      apNormIds.forEach(function (rid) {
         var row = apById[rid];
         if (!row) { apMiss++; return; }
         assertRequestState_(row, "adminApproveBatch");
         row["狀態"] = "approved";
        if (apNote) row["備註"] = apNote;
        apToSave.push(row);
        apOkIds.push(rid);
       });
       if (!apToSave.length) throw new Error("找不到可核准的申請單");
        apToSave.forEach(function (r) {
          if (isCombinedReturnRequest_(r)) {
             validateCombinedReturnRequest_(r, semesterId);
            r["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
          }
        });
       saveRows("申請單", apToSave, "申請單ID");
       apToSave.forEach(function (r) {
         if (!isCombinedReturnRequest_(r)) syncHomeroomRecordForRequest_(r, userEmail);
       });
       // 通知：同受邀人合併（鎖外）；紙本流程不寄信。
       var apMailRows = apToSave.filter(function (r) { return !isPaperFlowRow_(r); });
       if (apMailRows.length) queueMail_("adminApproveBatchMail", function () {
         var apBySub = {};
          apMailRows.forEach(function (r) {
            var em = String(r["受邀人Email"] || "").toLowerCase().trim();
          if (!em) return;
          if (!apBySub[em]) apBySub[em] = [];
          apBySub[em].push(r);
        });
         Object.keys(apBySub).forEach(function (em) {
          var g = apBySub[em];
          if (g.length === 1) sendAdminApproveEmail_(g[0], currentUrl);
           else sendAdminApproveBatchEmail_(g, currentUrl);
         });
         apMailRows.forEach(function (r) {
           if (isCombinedReturnRequest_(r)) sendAdminApproveEmail_(r, currentUrl);
         });
      });
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        count: apToSave.length,
        ids: apOkIds,
        missing: apMiss
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "adminReject") {
      if (!isAdmin) throw new Error("無管理員權限！");
       var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
       if (!targetReq) throw new Error("找不到該申請單");
       assertRequestState_(targetReq, "adminReject");
       if (isTriangleRequest_(targetReq)) {
         rejectTriangleRequest_(targetReq, semesterId, userEmail, currentUrl, reqData.note || "");
       } else {
       try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_adminReject", qE); throw qE; }
       targetReq["狀態"] = "admin_rejected";
       saveRows("申請單", [targetReq], "申請單ID");
       if (!isCombinedReturnRequest_(targetReq)) syncHomeroomRecordForRequest_(targetReq, userEmail);
       if (!isPaperFlowRow_(targetReq)) {
         queueMail_("sendAdminRejectEmail", function () { sendAdminRejectEmail_(targetReq, currentUrl); });
       }
       }
       invalidateSemesterCaches_(semesterId);

    } else if (action === "adminRejectBatch") {
      if (!isAdmin) throw new Error("無管理員權限！");
      assertNotTooFrequent_(userEmail, "adminRejectBatch");
      var rjIds = reqData.requestIds || reqData.ids || [];
      if (!rjIds.length) throw new Error("請提供 requestIds");
      if (rjIds.length > 40) throw new Error("單次批次駁回最多 40 筆");
      var rjNormIds = rjIds.map(function (id) { return String(id || "").replace(/_[12]$/, ""); });
       var rjById = findRowsByKeys_("申請單", "申請單ID", rjNormIds, semesterId);
      var rjToSave = [];
      var rjOkIds = [];
      var rjMiss = 0;
      rjNormIds.forEach(function (rid) {
         var row = rjById[rid];
         if (!row) { rjMiss++; return; }
         assertRequestState_(row, "adminRejectBatch");
         rjToSave.push(row);
        rjOkIds.push(rid);
      });
      if (!rjToSave.length) throw new Error("找不到可駁回的申請單");
      // 一次批次還額（勿逐人 restore → 重複讀寫帳本）
       try { restoreMutualQuotaForRequests_(rjToSave); } catch (qE) { logError_("restoreMutualQuota_adminRejectBatch", qE); throw qE; }
      rjToSave.forEach(function (row) { row["狀態"] = "admin_rejected"; });
      saveRows("申請單", rjToSave, "申請單ID");
       rjToSave.forEach(function (r) {
         if (!isCombinedReturnRequest_(r)) syncHomeroomRecordForRequest_(r, userEmail);
       });
       var rjMailRows = rjToSave.filter(function (r) { return !isPaperFlowRow_(r); });
       if (rjMailRows.length) queueMail_("adminRejectBatchMail", function () {
         rjMailRows.forEach(function (r) { sendAdminRejectEmail_(r, currentUrl); });
       });
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
      var deletedSubRequest = false;
       if (reqData.requestId && reqData.requestId !== "N/A") {
          var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
          if (targetReq) {
            assertRequestState_(targetReq, "deleteSubstitutionRecord");
            if (isTriangleRequest_(targetReq)) {
              deleteApprovedTriangleRequest_(targetReq, semesterId);
              deletedSubRequest = true;
              targetReq = null;
            }
            if (!targetReq) {
              // 三角調已由群組函式一次撤銷，避免落入單列舊流程。
            } else {
             try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); throw qE; }
           targetReq["狀態"] = "cancelled";
           saveRows("申請單", [targetReq], "申請單ID");
            syncHomeroomRecordForRequest_(targetReq, userEmail);
            deletedSubRequest = true;
            }
         }
       } else if (reqData.id) {
          var reqIdDel = String(reqData.id).replace(/_[12]$/, "");
          var targetReqDel = findRowByKey_("申請單", "申請單ID", reqIdDel, semesterId);
          if (targetReqDel) {
            assertRequestState_(targetReqDel, "deleteSubstitutionRecord");
            if (isTriangleRequest_(targetReqDel)) {
              deleteApprovedTriangleRequest_(targetReqDel, semesterId);
              deletedSubRequest = true;
              targetReqDel = null;
            }
            if (!targetReqDel) {
              // 三角調已由群組函式一次撤銷，避免落入單列舊流程。
            } else {
             try { restoreMutualQuotaForRequests_(targetReqDel); } catch (qE) { logError_("restoreMutualQuota_deleteSub", qE); throw qE; }
           targetReqDel["狀態"] = "cancelled";
           saveRows("申請單", [targetReqDel], "申請單ID");
            syncHomeroomRecordForRequest_(targetReqDel, userEmail);
            deletedSubRequest = true;
            }
         }
       }
       if (!deletedSubRequest) throw new Error("找不到可撤銷的已核准申請單！");
       invalidateSemesterCaches_(semesterId);
      
    } else if (action === "saveHistoryEdit") {
      // 管理員可修正已生效之代／調課全部欄位（教師、日期節次、班級科目、假別經費等）
      if (!isAdmin) throw new Error("無管理員權限！");
      var reqId = String(reqData.id || reqData.requestId || "").replace(/_[12]$/, "");
      if (!reqId) throw new Error("缺少申請單ID");
       var targetReq = findRowByKey_("申請單", "申請單ID", reqId, semesterId);
      if (!targetReq) throw new Error("找不到該紀錄");

       var editDirectory = buildNameKeyDirectory_(teachers);
       var combinedReturnEdit = isCombinedReturnRequest_(targetReq);
       if (isCombinedReturnRequest_(reqData) && !combinedReturnEdit) {
         throw new Error("一般紀錄不可改為合班回原班，請重新建立特殊流程申請單");
       }
       var leaveName = resolveNameKeyPair_(
         nameKeyPick_(reqData, ["requesterName", "申請人姓名"]),
         nameKeyPick_(reqData, ["requesterEmail", "申請人Email"]),
         semesterId, editDirectory, "申請人", false
       );
        var subName = resolveNameKeyPair_(
           nameKeyPick_(reqData, ["targetTeacherName", "受邀人姓名"]),
           nameKeyPick_(reqData, ["targetTeacherEmail", "受邀人Email"]),
           semesterId, editDirectory, "受邀人", false
         );
        var leaveEmail = nameKeyEmailForName_(semesterId, leaveName, editDirectory);
        var subEmail = nameKeyEmailForName_(semesterId, subName, editDirectory);
        if (!leaveEmail || !subEmail) throw new Error("教師名單缺少請假教師或代課教師 Email");
        if (leaveEmail === subEmail) throw new Error("請假教師與代課教師不可相同");

        var isEx = !combinedReturnEdit && (reqData.type === "exchange" || reqData.type === "對調"
          || targetReq["異動類型"] === "exchange" || targetReq["異動類型"] === "對調");
       if (reqData.type === "substitution" || reqData.type === "代課") isEx = false;
       if (!combinedReturnEdit && (reqData.type === "exchange" || reqData.type === "對調")) isEx = true;

      var reqDate = String(reqData.requestDate || reqData["異動日期"] || "").trim();
      var reqPeriod = parseInt(reqData.requestPeriod || reqData["異動節次"] || 0, 10);
       if (!reqDate || isNaN(reqPeriod)) throw new Error("請假日期與節次必填");
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
        targetReq["請假事由"] = combinedReturnEdit
          ? (reqData.reason != null ? reqData.reason : (targetReq["請假事由"] || ""))
          : (reqData.reason != null ? reqData.reason : (targetReq["請假事由"] || ""));
       targetReq["請假時間類型"] = combinedReturnEdit ? "" : (reqData.leaveTimeType != null ? reqData.leaveTimeType : (targetReq["請假時間類型"] || ""));
       targetReq["請假時間"] = combinedReturnEdit ? "" : (reqData.leaveTime != null ? reqData.leaveTime : (targetReq["請假時間"] || ""));
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
        if (combinedReturnEdit) {
          targetReq["異動類型"] = "substitution";
          targetReq["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
          targetReq["直接核准"] = "";
          targetReq["紙本流程"] = "FALSE";
          targetReq["經費來源"] = combinedReturnExpectedFee_(targetReq);
           validateCombinedReturnRequest_(targetReq, semesterId);
        }

       saveRows("申請單", [targetReq], "申請單ID");
      syncHomeroomRecordForRequest_(targetReq, userEmail);
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
      if (reqData && reqData.onlineSubstitutionEnabled !== undefined && reqData.onlineSubstitutionEnabled !== null) {
        var onlineApplyOn = reqData.onlineSubstitutionEnabled === true
          || reqData.onlineSubstitutionEnabled === "true"
          || reqData.onlineSubstitutionEnabled === "TRUE"
          || reqData.onlineSubstitutionEnabled === 1
          || reqData.onlineSubstitutionEnabled === "1"
          || reqData.onlineSubstitutionEnabled === "是"
          || reqData.onlineSubstitutionEnabled === "開";
        upsertSystemSetting_("onlineSubstitutionEnabled", onlineApplyOn ? "true" : "false");
      }
      // 其餘鍵值一併寫入（allowedHd 等）
      if (reqData && typeof reqData === "object") {
        var skipKeys = {
          url: 1, proxySubmitEnabled: 1, proxySubmitEnabledBy: 1, proxySubmitEnabledAt: 1,
          proxySubmitEmails: 1, onlineSubstitutionEnabled: 1
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
       var printById = findRowsByKeys_("申請單", "申請單ID", printIds, semesterId);
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
    } else if (action === "submitTriangleRequest") {
       assertNotTooFrequent_(userEmail, "submitTriangleRequest");
       var triangleActorName = currentTeacher
         ? String(currentTeacher["教師姓名"] || currentTeacher.name || userEmail)
         : userEmail;
       var trianglePaperFlow = !isOnlineSubstitutionEnabled_();
       var triangleBuilt = triangleInputRows_(reqData || {}, semesterId, teachers, userEmail, triangleActorName);
       var triangleRows = triangleBuilt.rows;
       if (trianglePaperFlow) {
         // 紙本流程由三位教師在同一張單據簽名，完成後交教學組核審，不建立線上待簽邀請。
         triangleRows.forEach(function (row) {
           row["紙本流程"] = "TRUE";
           row["狀態"] = "pending_admin";
           row["三角同意狀態"] = "paper_pending";
           row["三角組狀態"] = "pending_admin";
         });
       }
       var triangleSeenIds = {};
       triangleRows.forEach(function (row) {
         var triangleRequestId = String(row["申請單ID"] || "").trim();
         if (!triangleRequestId || triangleSeenIds[triangleRequestId]) throw new Error("三角調內含重複的申請單ID！");
         triangleSeenIds[triangleRequestId] = true;
       });
       var triangleExisting = triangleRows.map(function (row) {
         return assertNewRequestId_(row["申請單ID"], semesterId,
           row["申請人Email"], row["受邀人Email"], triangleBuilt.triangleId);
       });
       if (triangleExisting.some(function (row) { return !!row; })) {
         if (triangleExisting.every(function (row) { return !!row; })) {
           var existingTriangleRows = getTriangleGroupRows_(semesterId, triangleBuilt.triangleId);
           if (existingTriangleRows.length === 3) {
             return ContentService.createTextOutput(JSON.stringify({
               success: true,
               idempotent: true,
               triangleId: triangleBuilt.triangleId,
               status: String(existingTriangleRows[0]["三角組狀態"] || existingTriangleRows[0]["狀態"] || ""),
               count: existingTriangleRows.length,
               ids: existingTriangleRows.map(function (row) { return row["申請單ID"]; })
             })).setMimeType(ContentService.MimeType.JSON);
           }
         }
         throw new Error("三角調群組部分申請單ID已存在，為避免半組寫入請重新整理後再試！");
       }
       persistRequestRowsWithQuota_(triangleRows, userEmail);
        var skipTriangleNotify = trianglePaperFlow
          || reqData.skipNotify === true
          || reqData.skipNotify === "true";
       if (!skipTriangleNotify) {
         queueMail_("sendTriangleInviteEmail", function () {
           triangleRows.forEach(function (row) { sendTriangleInviteEmail_(row, currentUrl, triangleRows); });
         });
       }
       invalidateSemesterCaches_(semesterId);
       return ContentService.createTextOutput(JSON.stringify({
         success: true,
         triangleId: triangleBuilt.triangleId,
          status: trianglePaperFlow ? "pending_admin" : "pending_teacher",
          paperFlow: trianglePaperFlow,
          physicalSignatureRequired: trianglePaperFlow,
         count: triangleRows.length,
         skipNotify: !!skipTriangleNotify,
         ids: triangleRows.map(function (row) { return row["申請單ID"]; })
       })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "submitRequest") {
       assertNotTooFrequent_(userEmail, "submitRequest");
        // 發起調代課申請（狀態一律由伺服器決定，忽略前端竄改）
        if (!reqData.request || typeof reqData.request !== "object") throw new Error("缺少申請單資料！");
        reqData.request = prepareNameKeyRequestRow_(reqData.request, semesterId, teachers);
        var combinedReturnOne = isCombinedReturnRequest_(reqData.request);
        if (combinedReturnOne && !isAdmin) throw new Error("合班回原班僅限教學組建立！");
        var leaveEmailOne = normalizeEmail_(reqData.request["申請人Email"], "申請人 Email");
        var targetEmailOne = normalizeEmail_(reqData.request["受邀人Email"], "受邀人 Email");
        if (!findSemesterTeacher_(semesterId, leaveEmailOne)) throw new Error("申請人不在目前學期教師名單！");
        if (!findSemesterTeacher_(semesterId, targetEmailOne)) throw new Error("受邀人不在目前學期教師名單！");
        if (leaveEmailOne === targetEmailOne) throw new Error("申請人與受邀人不可為同一人！");
        if (combinedReturnOne) {
          reqData.request["經費來源"] = combinedReturnExpectedFee_(reqData.request);
          reqData.request.specialFlow = SPECIAL_FLOW_COMBINED_RETURN_;
          reqData.request.courseAdjustmentOnly = false;
          reqData.request["僅課務調整"] = "";
        }
        reqData.request["申請人Email"] = leaveEmailOne;
        reqData.request["受邀人Email"] = targetEmailOne;
       validateRequestRow_(reqData.request, semesterId);
       var existingOne = assertNewRequestId_(reqData.request["申請單ID"], semesterId, leaveEmailOne, targetEmailOne, reqData.request["批次ID"] || "");
       if (existingOne) {
         return ContentService.createTextOutput(JSON.stringify({
           success: true,
           idempotent: true,
           requestId: existingOne["申請單ID"],
           status: translateStatusToEn(existingOne["狀態"])
         })).setMimeType(ContentService.MimeType.JSON);
       }
        var isSelfOne = leaveEmailOne === userEmail;
       var paperFlowRequestedOne = isPaperFlowValue_(reqData.paperFlow)
         || isPaperFlowValue_(reqData.request.paperFlow)
         || isPaperFlowValue_(reqData.request["紙本流程"]);
       if (paperFlowRequestedOne && isOnlineSubstitutionEnabled_()) {
         throw new Error("目前為線上模式，不能使用紙本流程！");
       }
       // 紙本模式的本人申請直接送教學組核准；教學組勾直接核准則保留線上直核。
       var paperFlowOne = !isOnlineSubstitutionEnabled_()
         && isSelfOne
         && !(isAdmin && reqData.directApprove === true);
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
       if (!combinedReturnOne && !isSelfOne) {
        if (isAdmin && reqData.directApprove === true) {
          isProxyOne = false;
        } else if (staffCanProxy || isAdmin) {
          isProxyOne = true;
        }
      }
      // 扣額度／活動公費／第8節代課：僅管理員（活動互代）
       var feeOne = String(reqData.request["經費來源"] || "");
       if (combinedReturnOne) {
          validateCombinedReturnRequest_(reqData.request, semesterId);
       }
      if ((feeOne === "扣額度" || feeOne === "互代不結" || feeOne === "活動公費" || feeOne === "第8節代課") && !isAdmin) {
        throw new Error("扣額度／活動公費相關經費僅限管理員發起！");
      }
      // 寫入狀態（伺服器最終裁定）
        if (combinedReturnOne) {
          reqData.request["狀態"] = "pending_admin";
          reqData.request["紙本流程"] = "FALSE";
          reqData.request.paperFlow = false;
          reqData.request.directApprove = false;
          reqData.request["直接核准"] = "";
          reqData.request["特殊流程"] = SPECIAL_FLOW_COMBINED_RETURN_LABEL_;
        } else if (paperFlowOne) {
         reqData.request["狀態"] = "pending_admin";
         reqData.request["紙本流程"] = "TRUE";
         reqData.request.paperFlow = true;
         reqData.request.directApprove = false;
       } else if (isAdmin && reqData.directApprove === true && !isProxyOne) {
         reqData.request["狀態"] = "approved";
         reqData.request["紙本流程"] = "FALSE";
       } else if (isProxyOne) {
         reqData.request["狀態"] = "pending_admin";
         reqData.request["紙本流程"] = "FALSE";
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
          reqData.request["紙本流程"] = "FALSE";
        }
        reqData.request["直接核准"] = (!combinedReturnOne && isAdmin && reqData.directApprove === true && !isProxyOne && !paperFlowOne)
         ? "是"
         : "";
       // 雙重保險：代別人且非直接核准，絕不寫成 pending_teacher
      if (!isSelfOne && String(reqData.request["狀態"] || "") === "pending_teacher") {
        if (isAdmin || staffCanProxy) {
          reqData.request["狀態"] = "pending_admin";
          reqData.request["代申請人Email"] = userEmail;
          isProxyOne = true;
        }
      }
      if (!reqData.request["批次ID"]) reqData.request["批次ID"] = "";
      
       persistRequestRowsWithQuota_([reqData.request], userEmail);
       if (String(reqData.request["狀態"] || "") === "approved") {
         syncHomeroomRecordForRequest_(reqData.request, userEmail);
       }
      // skipNotify=true：只寫單不寄信
      // 行政代申請／pending_admin：絕不寄受邀邀請信（受邀者不需同意；教學組核准時再寄）
      var statusOne = String(reqData.request["狀態"] || "");
       var skipNotifyOne = reqData.skipNotify === true || reqData.skipNotify === "true"
         || isProxyOne || statusOne === "pending_admin" || paperFlowOne || !isOnlineSubstitutionEnabled_();
      if (!skipNotifyOne) {
        if (statusOne === "approved") {
          queueMail_("sendAdminApproveEmail", function () { sendAdminApproveEmail_(reqData.request, currentUrl); });
        } else if (statusOne === "pending_teacher") {
          queueMail_("sendSubInviteEmail", function () { sendSubInviteEmail_(reqData.request, currentUrl); });
        }
        // pending_admin：不寄信，等 adminApprove 再通知
      }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "submitRequestBatch") {
      // 方案 A：多筆申請單＋同一批次ID（每節仍獨立簽核）
      assertNotTooFrequent_(userEmail, "submitRequestBatch");
       var rawList = reqData.requests || [];
       if (!rawList.length) throw new Error("批次申請清單為空！");
       if (rawList.length > 20) throw new Error("單次批次最多 20 節！");
        var list = rawList.map(function (rawRow) {
          return prepareNameKeyRequestRow_(rawRow, semesterId, teachers);
        });
       if (list.some(function (row) { return isCombinedReturnRequest_(row); })) {
         throw new Error("合班回原班目前只能建立單筆申請，不可使用批次申請！");
       }
       var batchId = String(reqData.batchId || ("bat_" + Date.now())).trim();
      if (!batchId) throw new Error("缺少批次 ID！");
      var staffCanProxyBatch = canUserProxySubmit_(userEmail, teachers);
      // 先掃一遍：是否含代申請（非本人）
      var anyOther = false;
      for (var bi0 = 0; bi0 < list.length; bi0++) {
        if (normalizeEmail_((list[bi0] || {})["申請人Email"], "申請人 Email") !== userEmail) {
          anyOther = true;
          break;
        }
      }
       if (anyOther && !isAdmin && !staffCanProxyBatch) {
         throw new Error("批次中含非本人申請，已拒絕！（僅「已授權的行政」可代申請）");
       }
       var paperFlowRequestedBatch = isPaperFlowValue_(reqData.paperFlow)
         || list.some(function (row) {
           return isPaperFlowValue_(row && (row.paperFlow !== undefined ? row.paperFlow : row["紙本流程"]));
         });
       if (paperFlowRequestedBatch && isOnlineSubstitutionEnabled_()) {
         throw new Error("目前為線上模式，不能使用紙本流程！");
       }
       var paperFlowBatch = !isOnlineSubstitutionEnabled_()
         && !anyOther
         && !(isAdmin && reqData.directApprove === true);
       // 代別人：已授權行政，或教學組未勾直接核准 → pending_admin
       var directOk = isAdmin && reqData.directApprove === true && !paperFlowBatch;
       var isProxyBatch = !!(anyOther && !directOk && (staffCanProxyBatch || isAdmin));
       var finalStatus = paperFlowBatch ? "pending_admin" : (directOk ? "approved" : (isProxyBatch ? "pending_admin" : "pending_teacher"));
      var actorNameBatch = currentTeacher
        ? String(currentTeacher["教師姓名"] || currentTeacher.name || userEmail)
        : userEmail;
      var rows = [];
      var existingBatchRows = [];
      var seenBatchRequestIds = {};
      for (var bi = 0; bi < list.length; bi++) {
        var row = list[bi] || {};
        var leaveEmB = normalizeEmail_(row["申請人Email"], "申請人 Email");
        var targetEmB = normalizeEmail_(row["受邀人Email"] || row.targetTeacherEmail, "受邀人 Email");
        if (!findSemesterTeacher_(semesterId, leaveEmB)) throw new Error("批次申請人不在目前學期教師名單！");
        if (!findSemesterTeacher_(semesterId, targetEmB)) throw new Error("批次受邀人不在目前學期教師名單！");
        if (leaveEmB === targetEmB) throw new Error("批次申請人與受邀人不可為同一人！");
        row["申請人Email"] = leaveEmB;
        row["受邀人Email"] = targetEmB;
        validateRequestRow_(row, semesterId);
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
          row["直接核准"] = directOk ? "是" : "";
          row["紙本流程"] = paperFlowBatch ? "TRUE" : "FALSE";
         row.paperFlow = paperFlowBatch;
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
        var batchRequestId = String(row["申請單ID"] || "").trim();
        if (seenBatchRequestIds[batchRequestId]) throw new Error("批次內含重複的申請單 ID！");
        seenBatchRequestIds[batchRequestId] = true;
        var existingBatch = assertNewRequestId_(row["申請單ID"], semesterId, leaveEmB, targetEmB, batchId);
        if (existingBatch) existingBatchRows.push(existingBatch);
        if (!row["建立時間"]) row["建立時間"] = toLocalTimeStr(new Date());
        rows.push(row);
      }
      if (existingBatchRows.length) {
        if (existingBatchRows.length !== rows.length) {
          throw new Error("批次中部分申請單 ID 已存在，為避免重複寫入請重新整理後再試！");
        }
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          idempotent: true,
          batchId: batchId,
          count: existingBatchRows.length,
          ids: existingBatchRows.map(function (r) { return r["申請單ID"]; })
        })).setMimeType(ContentService.MimeType.JSON);
      }
      persistRequestRowsWithQuota_(rows, userEmail);
      if (finalStatus === "approved") {
        rows.forEach(function (r) { syncHomeroomRecordForRequest_(r, userEmail); });
      }
      // skipNotify=true：只寫單不寄信；代申請／pending_admin 不寄邀請信
       var skipNotifyBatch = reqData.skipNotify === true || reqData.skipNotify === "true"
         || isProxyBatch || finalStatus === "pending_admin" || paperFlowBatch || !isOnlineSubstitutionEnabled_();
      if (!skipNotifyBatch) {
        queueMail_("submitRequestBatchMail", function () {
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
        });
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
      if (!isOnlineSubstitutionEnabled_()) {
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          skipped: true,
          reason: "paperMode",
          found: 0,
          approved: 0,
          pending: 0,
          mailCount: 0,
          recipientEst: 0,
          sent: 0,
          failed: 0
        })).setMimeType(ContentService.MimeType.JSON);
      }
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
       var noticeById = findRowsByKeys_("申請單", "申請單ID", noticeNormIds, semesterId);
       var noticeRows = noticeNormIds.map(function (rid) { return noticeById[rid]; }).filter(Boolean);
       if (!noticeRows.length) throw new Error("找不到對應申請單！");
       var paperNoticeCount = noticeRows.filter(isPaperFlowRow_).length;
       var mailableNoticeRows = noticeRows.filter(function (r) { return !isPaperFlowRow_(r); });

       var approvedRows = [];
       var pendingRows = [];
       mailableNoticeRows.forEach(function (r) {
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

      // 預估 mailCount（實際寄信鎖外，不阻塞其他寫入）
      if (approvedRows.length === 1) {
        var a0e = approvedRows[0];
        var ae1e = normEm(a0e["申請人Email"] || a0e.requesterEmail);
        var ae2e = normEm(a0e["受邀人Email"] || a0e.targetTeacherEmail);
        var n0e = 0;
        if (validEm(ae1e)) n0e++;
        if (validEm(ae2e) && ae2e !== ae1e) n0e++;
        mailCount += n0e || 1;
        sent++;
      } else if (approvedRows.length > 1) {
        var byPe = {};
        approvedRows.forEach(function (r) {
          var c = normEm(r["受邀人Email"] || r.targetTeacherEmail);
          var l = normEm(r["申請人Email"] || r.requesterEmail);
          if (validEm(c)) byPe[c] = 1;
          if (validEm(l)) byPe[l] = 1;
        });
        mailCount += Object.keys(byPe).length;
        sent++;
      }
      var bySubPe = {};
      pendingRows.forEach(function (r) {
        var em = normEm(r["受邀人Email"] || r.targetTeacherEmail);
        if (!validEm(em)) return;
        if (!bySubPe[em]) bySubPe[em] = [];
        bySubPe[em].push(r);
      });
      mailCount += Object.keys(bySubPe).length;
      sent += Object.keys(bySubPe).length;

      queueMail_("sendBatchNotices", function () {
        if (approvedRows.length === 1) {
          sendAdminApproveEmail_(approvedRows[0], currentUrl);
        } else if (approvedRows.length > 1) {
          sendAdminApproveBatchEmail_(approvedRows, currentUrl);
        }
        Object.keys(bySubPe).forEach(function (em) {
          var group = bySubPe[em];
          if (group.length === 1) sendSubInviteEmail_(group[0], currentUrl);
          else sendSubInviteBatchEmail_(group, currentUrl);
        });
      });

      return ContentService.createTextOutput(JSON.stringify({
         success: true,
         found: noticeRows.length,
         paperSkipped: paperNoticeCount,
        approved: approvedRows.length,
        pending: pendingRows.length,
        mailCount: mailCount || Object.keys(estRecipients).length,
        recipientEst: Object.keys(estRecipients).length,
        sent: sent,
        failed: failed
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "respondTriangleRequest") {
      var triangleResponseId = String(reqData.requestId || "").trim();
      var triangleResponseRow = findRowByKey_("申請單", "申請單ID", triangleResponseId, semesterId);
      if (!triangleResponseRow || !isTriangleRequest_(triangleResponseRow)) throw new Error("找不到該三角調申請單");
      assertRequestState_(triangleResponseRow, "respondToRequest");
      var triangleResponseResult = respondTriangleRequest_(
        triangleResponseRow, semesterId, userEmail, reqData.response, currentUrl
      );
      return ContentService.createTextOutput(JSON.stringify(triangleResponseResult))
        .setMimeType(ContentService.MimeType.JSON);

    } else if (action === "respondToRequest") {
      // 同意或拒絕調代課邀請
      var responseOne = String(reqData.response || "").toLowerCase();
      if (responseOne !== "agree" && responseOne !== "decline") throw new Error("簽核回應格式不正確！");
      var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
       if (!targetReq) throw new Error("找不到該申請單");
       assertRequestState_(targetReq, "respondToRequest");

       if (isTriangleRequest_(targetReq)) {
         var triangleResponse = respondTriangleRequest_(targetReq, semesterId, userEmail, responseOne, currentUrl);
         return ContentService.createTextOutput(JSON.stringify(triangleResponse))
           .setMimeType(ContentService.MimeType.JSON);
       }

      // 確保操作者是受邀教師
      if (String(targetReq["受邀人Email"] || "").toLowerCase() !== userEmail) {
        throw new Error("您無權對此邀請單進行操作！");
      }
      
       if (responseOne !== "agree") {
         try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_respond", qE); throw qE; }
      }
       if (responseOne === "agree") {
        targetReq["狀態"] = "pending_admin";
      } else {
        targetReq["狀態"] = "rejected";
      }
      saveRows("申請單", [targetReq], "申請單ID");
      syncHomeroomRecordForRequest_(targetReq, userEmail);
       if (responseOne === "agree") {
        queueMail_("sendRespondAgreeEmail", function () { sendRespondAgreeEmail_(targetReq, currentUrl); });
      } else {
        queueMail_("sendRespondRejectEmail", function () { sendRespondRejectEmail_(targetReq, currentUrl); });
      }
      invalidateSemesterCaches_(semesterId);

    } else if (action === "respondToBatch") {
      // 批次一次全部同意／全部拒絕（僅 pending_teacher 且本人為受邀人）
      assertNotTooFrequent_(userEmail, "respondToBatch");
      var batchId = String(reqData.batchId || "").trim();
      if (!batchId) throw new Error("缺少批次ID！");
       var respRaw = String(reqData.response || "").toLowerCase();
       if (respRaw !== "agree" && respRaw !== "decline") throw new Error("批次簽核回應格式不正確！");
       var resp = respRaw;
      var peers = findRowsByColumnValue_("申請單", "批次ID", batchId, function (r) {
        return String(r["學期代號"] || "").trim() === String(semesterId || "").trim()
          && String(r["狀態"] || "") === "pending_teacher"
          && String(r["受邀人Email"] || "").toLowerCase() === userEmail;
      });
      if (!peers.length) throw new Error("找不到可處理的批次申請（可能已處理或不屬於您）！");
      if (resp !== "agree") {
         try { restoreMutualQuotaForRequests_(peers); } catch (qE) { logError_("restoreMutualQuota_respondBatch", qE); throw qE; }
      }
      var newStatus = resp === "agree" ? "pending_admin" : "rejected";
      peers.forEach(function (r) { r["狀態"] = newStatus; });
      saveRows("申請單", peers, "申請單ID");
      peers.forEach(function (r) { syncHomeroomRecordForRequest_(r, userEmail); });
      queueMail_("respondToBatchMail", function () {
        if (resp === "agree") {
          sendRespondAgreeBatchEmail_(peers, currentUrl);
        } else {
          sendRespondRejectBatchEmail_(peers, currentUrl);
        }
      });
      invalidateSemesterCaches_(semesterId);
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        batchId: batchId,
        count: peers.length,
        response: resp
      })).setMimeType(ContentService.MimeType.JSON);
      
    } else if (action === "cancelRequest") {
      // 撤回申請
       var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
       if (!targetReq) throw new Error("找不到該申請單");
       assertRequestState_(targetReq, "cancelRequest");
       if (isTriangleRequest_(targetReq)) {
         var cancelledTriangle = cancelTriangleRequest_(targetReq, semesterId, userEmail, "cancelled");
         return ContentService.createTextOutput(JSON.stringify(cancelledTriangle))
           .setMimeType(ContentService.MimeType.JSON);
       }

      // 僅限本人或管理員撤回
      if (String(targetReq["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權撤回他人的申請單！");
      }
       try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_cancel", qE); throw qE; }
      targetReq["狀態"] = "cancelled";
      saveRows("申請單", [targetReq], "申請單ID");
      syncHomeroomRecordForRequest_(targetReq, userEmail);
      invalidateSemesterCaches_(semesterId);
      
    } else if (action === "withdrawRequest") {
      // 已送到行政端待簽核時，一般教師撤回
       var targetReq = findRowByKey_("申請單", "申請單ID", reqData.requestId, semesterId);
       if (!targetReq) throw new Error("找不到該申請單");
       assertRequestState_(targetReq, "withdrawRequest");
       if (isTriangleRequest_(targetReq)) {
         var withdrawnTriangle = cancelTriangleRequest_(targetReq, semesterId, userEmail, "withdrawn");
         return ContentService.createTextOutput(JSON.stringify(withdrawnTriangle))
           .setMimeType(ContentService.MimeType.JSON);
       }

      if (String(targetReq["申請人Email"] || "").toLowerCase() !== userEmail && !isAdmin) {
        throw new Error("您無權撤回此申請單！");
      }
       try { restoreMutualQuotaForRequests_(targetReq); } catch (qE) { logError_("restoreMutualQuota_withdraw", qE); throw qE; }
      targetReq["狀態"] = "withdrawn";
      saveRows("申請單", [targetReq], "申請單ID");
      syncHomeroomRecordForRequest_(targetReq, userEmail);
      invalidateSemesterCaches_(semesterId);
      
    } else {
      throw new Error("未定義的 POST Action");
    }
    
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
    } finally {
      try { lock.releaseLock(); } catch (ign) {}
      // P1：放鎖後再寄信（return 的 JSON 已就緒，寄信失敗不影響寫入結果）
      try { flushDeferredMails_(); } catch (ignM) { logError_("flushDeferredMails_", ignM); }
    }
  } catch (err) {
    _scheduleImportWriteContext_ = false;
    if (requestContext.action === "importSchedulesBatch") {
      logOperation_("importSchedulesBatch", "failed", {
        requestId: requestContext.requestId,
        operator: requestContext.operator,
        semesterId: requestContext.semesterId,
        version: requestContext.importVersion,
        rolledBack: requestContext.importRolledBack === true,
        rollbackError: requestContext.importRollbackError || "",
        error: String(err)
      });
    }
    try { flushDeferredMails_(); } catch (ignM2) {}
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ----------------- 狀態與類型中英文對照翻譯 -----------------
function translateStatusToEn(zhStatus) {
  var s = String(zhStatus == null ? "" : zhStatus).trim();
  // 已是英文碼：直接回傳
  var en = s.toLowerCase();
  if (en === "pending_teacher" || en === "pending_admin" || en === "approved"
      || en === "rejected" || en === "admin_rejected" || en === "cancelled" || en === "withdrawn") {
    return en;
  }
  const map = {
    "待受邀人簽核": "pending_teacher",
    "待行政審核": "pending_admin",
    "送交教學組": "pending_admin",
    "已核准": "approved",
    "核准生效": "approved",
    "受邀人已拒絕": "rejected",
    "行政已退回": "admin_rejected",
    "行政駁回": "admin_rejected",
    "已取消": "cancelled",
    "已撤銷": "cancelled",
    "已撤回": "withdrawn"
  };
  return map[s] || s;
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
    "對調": "exchange",
    "三角調": TRIANGLE_TYPE_
  };
  return map[zhType] || zhType;
}

function translateTypeToZh(enType) {
  const map = {
    "substitution": "代課",
    "exchange": "對調",
    "triangle": "三角調"
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

function logOperation_(action, status, details) {
  try {
    const ss = getSpreadsheet();
    var logSheet = ss.getSheetByName("操作日誌");
    if (!logSheet) {
      logSheet = ss.insertSheet("操作日誌");
      logSheet.appendRow(["時間", "操作", "狀態", "操作者", "學期代號", "請求ID", "摘要"]);
      logSheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#e0f2fe");
    }
    var data = details || {};
    var summary = typeof data === "string" ? data : JSON.stringify(data);
    logSheet.appendRow([
      toLocalTimeStr(new Date()),
      String(action || ""),
      String(status || ""),
      String(data.operator || ""),
      String(data.semesterId || ""),
      String(data.requestId || ""),
      summary
    ]);
  } catch (e) {}
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

/** P1：寫入鎖內只排隊寄信，放鎖後再寄（避免多人簽核卡 10 秒） */
var _deferredMails_ = null;
function beginDeferredMails_() {
  _deferredMails_ = [];
}
function queueMail_(label, fn) {
  if (!isOnlineSubstitutionEnabled_()) return;
  if (!_deferredMails_) {
    try { fn(); } catch (e) { logError_(label || "mail", e); }
    return;
  }
  _deferredMails_.push({ label: label || "mail", fn: fn });
}
function flushDeferredMails_() {
  var jobs = _deferredMails_ || [];
  _deferredMails_ = null;
  for (var i = 0; i < jobs.length; i++) {
    try { jobs[i].fn(); } catch (e) { logError_(jobs[i].label, e); }
  }
}

function escapeHtml_(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trustedSystemUrl_(candidate) {
  var fallback = String(PUBLIC_APP_URL_ || "https://jcjh-timetable.vercel.app/").trim();
  var fallbackMatch = fallback.match(/^(https?:\/\/[^/?#]+)(?:\/[^?#]*)?$/i);
  var fallbackOrigin = fallbackMatch ? fallbackMatch[1].replace(/\/$/, "") : "https://jcjh-timetable.vercel.app";
  var allowedOrigins = {
    "https://jcjh-timetable.vercel.app": true,
    "http://localhost:8000": true,
    "http://127.0.0.1:8000": true
  };
  allowedOrigins[fallbackOrigin.toLowerCase()] = true;
  var raw = String(candidate || "").trim();
  var match = raw.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/i);
  if (match && allowedOrigins[match[1].replace(/\/$/, "").toLowerCase()]
      && (!match[2] || match[2] === "/")) {
    return match[1].replace(/\/$/, "") + "/";
  }
  return fallbackOrigin + "/";
}

/** 統一寄信：主旨 RFC 2047 編碼 + HTML UTF-8 */
function sendSystemEmail_(to, subject, htmlBody) {
  if (!to || String(to).indexOf("@") === -1) return;
  var encSubject = _mimeEncodeSubject_(String(subject || "").replace(/[\r\n]+/g, " "));
  var body = String(htmlBody || "");
  if (body.indexOf("charset") === -1) {
    body = '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' + body;
  }
  GmailApp.sendEmail(String(to), encSubject, "請使用可顯示 HTML 的郵件用戶端開啟此通知。", {
    htmlBody: body,
    name: "建成國中線上課表系統"
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
  var isCombinedReturn = isCombinedReturnRequest_(req);
  var isExchange = !!(req.targetDate || req["對調目標日期"]);
  
  var leaveDay = req.requestPeriodDay || req["異動星期"] || _dayFromDateStr_(req.requestDate || req["異動日期"]);
  var leavePeriod = req.requestPeriod || req["異動節次"];
  var leaveClass = req.className || req["班級"] || "";
  var leaveSubject = req.subject || req["科目"] || "";
  var leaveDateText = req.requestDate || req["異動日期"];
  var leaveTimeText = _fmtSlotLine_(leaveDateText, leaveDay, leavePeriod, leaveClass, leaveSubject);
  var rows = isCombinedReturn ? [
    ["請假教師", req.requesterName || req["申請人姓名"]],
    ["代課教師", targetTeacher || ""],
    ["特殊流程", "合班回原班"],
    ["假別", req.reason || req["請假事由"] || "請假"],
    ["被代教師扣減類別", req.subFee || req["經費來源"] || "自費代課"],
    ["課堂", leaveTimeText]
  ] : [
    ["請假教師", req.requesterName || req["申請人姓名"]],
    [isExchange ? "對調教師" : "代課教師", targetTeacher || ""],
    ["請假原因", req.reason || req["請假事由"] || "公假"],
    ["請假課堂", leaveTimeText]
  ];
  var targetDateVal = req.targetDate || req["對調目標日期"];
  if (targetDateVal) {
    var sidesTbl = _resolveExchangeSides_(req);
    var leaveSlot = _fmtSlotLine_(sidesTbl.leaveDate, sidesTbl.leaveDay, sidesTbl.leavePeriod, sidesTbl.leaveClass, sidesTbl.leaveSubject);
    var targetSlot = _fmtSlotLine_(sidesTbl.targetDate, sidesTbl.targetDay, sidesTbl.targetPeriod, sidesTbl.targetClass, sidesTbl.targetSubject);
    rows[3] = ["對調內容", leaveSlot + " ⇄ " + targetSlot];
  } else if (!isCombinedReturn) {
    var feeText = req.subFee || req["經費來源"] || "自理";
    if (feeText === "代課費") { feeText = "公費代課"; }
    else if (feeText === "自理") { feeText = "基本鐘點/自理"; }
    rows.push(["經費鐘點", feeText]);
  }
  var noteVal = req.note || req["備註"];
  if (noteVal) { rows.push(["備註", noteVal]); }
  var trs = rows.map(function(r) {
    return '<tr><td style="padding:12px 16px;background-color:#f1f5f9;font-weight:bold;border:1px solid #e2e8f0;width:120px;color:#475569;font-size:14px;">' + escapeHtml_(r[0]) + '</td><td style="padding:12px 16px;border:1px solid #e2e8f0;color:#1e293b;font-size:14px;background:#fff;">' + escapeHtml_(r[1]) + '</td></tr>';
  }).join("");
  return '<table style="border-collapse:collapse;width:100%;margin:18px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">' + trs + '</table>';
}

function sendSubInviteEmail_(req, currentUrl) {
  if (isCombinedReturnRequest_(req)) return;
  var to = req.targetTeacherEmail || req["受邀人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var serial = req.serial || req["單號"] || "SUB";
  var requesterName = req.requesterName || req["申請人姓名"];
  var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
  var subject = "【建成國中線上課表系統】您收到一份來自 " + requesterName + " 老師的線上簽核邀請 (" + serial + ")";
   var sysUrl = trustedSystemUrl_(currentUrl);
   var reqId = req.id || req.requestId || req["申請單ID"];
   var agreeLink  = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=agree";
   var declineLink = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=decline";
   var safeRequesterName = escapeHtml_(requesterName);
   var safeTargetTeacherName = escapeHtml_(targetTeacherName);
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + safeTargetTeacherName + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + safeRequesterName + '</b> 老師向您發起了調代課邀請，明細如下：</p>'
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

function triangleGroupPeople_(rows) {
  var seen = {};
  var out = [];
  (rows || []).forEach(function (row) {
    [row["申請人姓名"], row["受邀人姓名"]].forEach(function (name) {
      var key = triangleText_(name);
      if (key && !seen[key]) {
        seen[key] = true;
        out.push(key);
      }
    });
  });
  return out;
}

function triangleGroupRecipientEmails_(rows) {
  var seen = {};
  var out = [];
  (rows || []).forEach(function (row) {
    [row["申請人Email"], row["受邀人Email"]].forEach(function (email) {
      var key = triangleText_(email).toLowerCase();
      if (key && key.indexOf("@") >= 0 && !seen[key]) {
        seen[key] = true;
        out.push(key);
      }
    });
  });
  return out;
}

function sendTriangleInviteEmail_(req, currentUrl, groupRows) {
  var to = triangleText_(req["受邀人Email"] || req.targetTeacherEmail);
  if (!to || to.indexOf("@") === -1) return;
  var serial = req["單號"] || "三角調";
  var targetName = req["受邀人姓名"] || "老師";
  var sourceName = req["申請人姓名"] || "教師";
  var sysUrl = trustedSystemUrl_(currentUrl);
  var reqId = req["申請單ID"] || req.id;
  var agreeLink = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=agree";
  var declineLink = sysUrl + "?action=respond&id=" + encodeURIComponent(reqId) + "&status=decline";
  var people = triangleGroupPeople_(groupRows || [req]).join("、");
  var targetDate = String(req["對調目標日期"] || "");
  var targetDay = req["對調目標星期"] || _dayFromDateStr_(targetDate);
  var targetPeriod = req["對調目標節次"] || "";
  var targetSlot = _fmtSlotLine_(targetDate, targetDay, targetPeriod,
    String(req["對調目標班級"] || ""), String(req["對調目標科目"] || ""));
  var receiveSlot = _fmtSlotLine_(targetDate, targetDay, targetPeriod,
    String(req["班級"] || ""), String(req["科目"] || ""));
  var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(targetName) + '</b> 老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;"><b>' + escapeHtml_(sourceName) + '</b> 老師邀請您參與三角調課。這是一組三位教師、三堂原課的整堂循環交換，必須三方都同意後才會送教學組核准。</p>'
    + '<table style="border-collapse:collapse;width:100%;margin:18px 0;border:1px solid #e2e8f0;">'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;width:120px;color:#475569;">本組教師</td><td style="padding:10px 14px;color:#1e293b;">' + escapeHtml_(people) + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;">您提供的原課</td><td style="padding:10px 14px;color:#1e293b;">' + escapeHtml_(targetSlot) + '</td></tr>'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;">您將接手</td><td style="padding:10px 14px;color:#1e293b;">' + escapeHtml_(receiveSlot) + '</td></tr>'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;">假別／課務類型</td><td style="padding:10px 14px;color:#1e293b;">' + escapeHtml_(req["請假事由"] || "請假") + '</td></tr>'
    + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;">單號</td><td style="padding:10px 14px;color:#1e293b;">' + escapeHtml_(serial) + '</td></tr>'
    + '</table>'
    + '<p style="margin-top:24px;font-weight:bold;color:#1e293b;">請確認您是否同意這組三角調：</p>'
    + '<div style="margin:20px 0;">'
    + '<a href="' + agreeLink + '" style="background:#059669;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin-right:16px;">同意三角調</a>'
    + '<a href="' + declineLink + '" style="background:#e11d48;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">拒絕整組</a>'
    + '</div>'
    + '<div style="font-size:13px;color:#94a3b8;margin-top:20px;border-top:1px dashed #e2e8f0;padding-top:16px;">如按鈕失效，請登入系統於「待辦簽核」處理：<br>'
    + '<div style="margin-top:10px;"><a href="' + sysUrl + '" style="background:#475569;color:#fff;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">登入系統確認</a></div></div>';
  sendSystemEmail_(to, "【建成國中線上課表系統】三角調課協議邀請（" + serial + "）", _wrapHtmlTemplate_("三角調課線上簽核邀請", "#2563eb", content));
}

function sendTriangleGroupStatusEmail_(rows, currentUrl, status) {
  var recipients = triangleGroupRecipientEmails_(rows);
  if (!recipients.length) return;
  var first = rows[0] || {};
  var id = triangleGroupIdFromRow_(first);
  var title = status === "approved" ? "三角調已核准生效" : "三方已同意三角調，待教學組核准";
  var message = status === "approved"
    ? "這組三角調已由教學組核准，最終課表已更新。"
    : "三位教師已全部同意，這組三角調已送交教學組審核。";
  var content = '<p style="color:#1e293b;font-size:15px;">您好：</p>'
    + '<p style="color:#475569;">' + escapeHtml_(message) + '</p>'
    + '<p style="color:#475569;">參與教師：' + escapeHtml_(triangleGroupPeople_(rows).join("、")) + '</p>'
    + '<p style="color:#475569;">三角調ID：' + escapeHtml_(id) + '</p>'
    + '<div style="margin:24px 0;"><a href="' + trustedSystemUrl_(currentUrl) + '" style="background:#2563eb;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">進入系統查看</a></div>';
  var html = _wrapHtmlTemplate_("三角調課狀態通知", status === "approved" ? "#059669" : "#d97706", content);
  recipients.forEach(function (email) {
    sendSystemEmail_(email, "【建成國中線上課表系統】" + title, html);
  });
}

function sendTriangleReadyEmail_(rows, currentUrl) {
  sendTriangleGroupStatusEmail_(rows, currentUrl, "pending_admin");
}

function sendTriangleApprovedEmail_(rows, currentUrl) {
  sendTriangleGroupStatusEmail_(rows, currentUrl, "approved");
}

/** 批次邀請：一封信列齊全部節次，每節各自同意／拒絕 */
function sendSubInviteBatchEmail_(rows, currentUrl) {
  rows = (rows || []).filter(function (row) { return !isCombinedReturnRequest_(row); });
  if (!rows.length) return;
  var first = rows[0];
  var to = first.targetTeacherEmail || first["受邀人Email"];
  if (!to || to.indexOf("@") === -1) return;
   var requesterName = first.requesterName || first["申請人姓名"] || "";
   var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
   var reason = first.reason || first["請假事由"] || "請假";
   var fee = first.subFee || first["經費來源"] || "自費代課";
   var n = rows.length;
   var sysUrl = trustedSystemUrl_(currentUrl);
   var safeRequesterName = escapeHtml_(requesterName);
   var safeTargetTeacherName = escapeHtml_(targetTeacherName);
   var safeReason = escapeHtml_(reason);
   var safeFee = escapeHtml_(fee);
  var subject = "【建成國中線上課表系統】您收到一批來自 " + requesterName + " 老師的代課邀請（共 " + n + " 節）";

  var batchId = first["批次ID"] || first.batchId || "";
  var agreeAllLink = sysUrl + "?action=respondBatch&batchId=" + encodeURIComponent(batchId) + "&status=agree";
  var declineAllLink = sysUrl + "?action=respondBatch&batchId=" + encodeURIComponent(batchId) + "&status=decline";

  var summary =
    '<table style="border-collapse:collapse;width:100%;margin:12px 0 18px;border:1px solid #e2e8f0;">'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;width:110px;color:#475569;font-size:14px;">請假教師</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + safeRequesterName + '</td></tr>'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">代課教師</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + safeTargetTeacherName + '</td></tr>'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">假別事由</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + safeReason + '</td></tr>'
     + '<tr><td style="padding:10px 14px;background:#f1f5f9;font-weight:bold;color:#475569;font-size:14px;">經費來源</td><td style="padding:10px 14px;color:#1e293b;font-size:14px;">' + safeFee + '</td></tr>'
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
    var title = (i + 1) + ". " + _fmtSlotLine_(dateVal, dayVal, periodVal, cls, subj);
    return '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:0 0 12px;background:#fff;">'
       + '<div style="font-weight:700;color:#1e293b;font-size:14px;margin-bottom:4px;">' + escapeHtml_(title) + '</div>'
       + (serial ? '<div style="font-size:12px;color:#94a3b8;margin-bottom:10px;">單號：' + escapeHtml_(serial) + '</div>' : '')
      + '<div style="margin-top:8px;">'
      + '<a href="' + agreeLink + '" style="background-color:#059669;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;margin-right:10px;font-size:13px;">同意此節</a>'
      + '<a href="' + declineLink + '" style="background-color:#e11d48;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;">拒絕此節</a>'
      + '</div></div>';
  }).join("");

   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + safeTargetTeacherName + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + safeRequesterName + '</b> 老師向您發起了<strong>一批代課邀請（共 ' + n + ' 節）</strong>。可先「全部同意」，或於下方逐節處理：</p>'
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
  rows = (rows || []).filter(function (row) { return !isCombinedReturnRequest_(row); });
  if (!rows.length) return;
  var first = rows[0];
  var to = first.requesterEmail || first["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
   var requesterName = first.requesterName || first["申請人姓名"] || "";
   var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
   var n = rows.length;
   var sysUrl = trustedSystemUrl_(currentUrl);
   var safeRequesterName = escapeHtml_(requesterName);
   var safeTargetTeacherName = escapeHtml_(targetTeacherName);
  var subject = "【建成國中線上課表系統】" + targetTeacherName + " 老師已全部同意您的批次代課（共 " + n + " 節），待行政審核";
  var listHtml = '<ul style="padding-left:20px;color:#1e293b;font-size:14px;line-height:1.7;">'
    + rows.map(function (req) {
      var dateVal = req.requestDate || req["異動日期"] || "";
      var dayVal = req.requestPeriodDay || req["異動星期"] || "";
      var periodVal = req.requestPeriod || req["異動節次"] || "";
      var cls = req.className || req["班級"] || "";
      var subj = req.subject || req["科目"] || "";
        return '<li>' + escapeHtml_(_fmtSlotLine_(dateVal, dayVal, periodVal, cls, subj)) + '</li>';
    }).join("")
    + '</ul>';
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + safeRequesterName + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + safeTargetTeacherName + '</b> 老師已<strong>全部同意</strong>您的批次代課邀請（共 ' + n + ' 節）。</p>'
    + '<p style="color:#475569;">目前已送交教學組審核，明細如下：</p>'
    + listHtml
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看狀態</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 批次已同意", "#d97706", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendRespondRejectBatchEmail_(rows, currentUrl) {
  rows = (rows || []).filter(function (row) { return !isCombinedReturnRequest_(row); });
  if (!rows.length) return;
  var first = rows[0];
  var to = first.requesterEmail || first["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
   var requesterName = first.requesterName || first["申請人姓名"] || "";
   var targetTeacherName = first.targetTeacherName || first["受邀人姓名"] || "";
   var n = rows.length;
   var sysUrl = trustedSystemUrl_(currentUrl);
   var safeRequesterName = escapeHtml_(requesterName);
   var safeTargetTeacherName = escapeHtml_(targetTeacherName);
  var subject = "【建成國中線上課表系統】" + targetTeacherName + " 老師已全部拒絕您的批次代課（共 " + n + " 節）";
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + safeRequesterName + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + safeTargetTeacherName + '</b> 老師已<strong>全部拒絕</strong>您的批次代課邀請（共 ' + n + ' 節）。</p>'
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
    "0": "07:40-08:30", "45": "12:35-13:15",
    "1": "08:30-09:15", "2": "09:25-10:10", "3": "10:20-11:05", "4": "11:15-12:00",
    "5": "13:20-14:05", "6": "14:15-15:00", "7": "15:15-16:00", "8": "16:10-16:55"
  };
  return times[String(p)] || "";
}

function _shortDay_(d) {
  var text = String(d == null ? "" : d).trim();
  return { "1": "一", "2": "二", "3": "三", "4": "四", "5": "五" }[text]
    || ({ "一": "一", "二": "二", "三": "三", "四": "四", "五": "五" }[text] || "");
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
function _lookupScheduleClassSubject_(email, dayOfWeek, period, semesterId, dateStr) {
  var out = { className: "", subject: "" };
  var em = String(email || "").toLowerCase().trim();
  var day = parseInt(dayOfWeek, 10);
  var per = parseInt(period, 10);
  if (!em || !day || !Number.isFinite(per) || !(per === 0 || per === 45 || (per >= 1 && per <= 8))) return out;
  try {
    var schedules = getTableData("教師課表") || [];
    var sid = String(semesterId || "").trim();
    var directory = null;
    try {
      directory = buildNameKeyDirectory_(sid ? (getSemesterTeachersCached_(sid) || []) : (getTableData("教師名單") || []));
    } catch (directoryError) {}
    var hit = null;
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s) continue;
      if (sid) {
        var sSid = String(s["學期代號"] || s.semesterId || "").trim();
        if (sSid && sSid !== sid) continue;
      }
      var sEmail = String(s.teacherEmail || s["教師Email"] || "").toLowerCase().trim();
      if (!sEmail && directory) {
        sEmail = nameKeyEmailForName_(sid, s["教師姓名"] || s.teacherName || "", directory);
      }
      if (sEmail !== em) continue;
      if (parseInt(s.dayOfWeek || s["星期"], 10) !== day) continue;
      if (parseInt(s.period || s["節次"], 10) !== per) continue;
      if (dateStr && !scheduleActiveOnDate_(s, dateStr)) continue;
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
    var leaveCs = _lookupScheduleClassSubject_(leaveEmail, leaveDay, leavePeriod, semesterId, leaveDate);
    leaveClass = leaveCs.className || leaveClass;
    leaveSubject = leaveCs.subject || leaveSubject;
  }

  var targetClass = String(req.targetClassName || req["對調目標班級"] || "").trim();
  var targetSubject = String(req.targetSubject || req["對調目標科目"] || "").trim();
  if ((!targetClass && !targetSubject) && targetEmail && targetDay && targetPeriod) {
    var tCs = _lookupScheduleClassSubject_(targetEmail, targetDay, targetPeriod, semesterId, targetDate);
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
  var rawDate = String(dateVal || "");
  if (!dayTxt && rawDate) dayTxt = _shortDay_(_dayFromDateStr_(rawDate));
  var head = rawDate.length >= 10 ? rawDate.substr(5, 5).replace("-", "/") : rawDate;
  if (dayTxt) head += "(" + dayTxt + ")";
  head += " 第" + periodVal + "節";
  var course = (String(cls || "") + String(subj || "")).trim();
  return (course ? (head + " " + course) : head).trim();
}

/**
 * 緊湊節次：3/20(三) 第2節 701國文
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
  s += " 第" + periodVal + "節";
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
        if (isCombinedReturnRequest_(req)) {
          if (role === "leave") {
            return '<li style="' + liStyle + '"><strong>【不用上】</strong>' + escapeHtml_(slot) + "　由 <strong>" + escapeHtml_(subN) + "</strong> 代課</li>";
          }
          if (role === "cover") {
            return '<li style="' + liStyle + '"><strong>【代課】</strong>' + escapeHtml_(slot) + "　代 <strong>" + escapeHtml_(leaveN) + "</strong> 老師</li>";
          }
          return '<li style="' + liStyle + '"><strong>【合班回原班】</strong>' + escapeHtml_(slot) + "　請假：<strong>" + escapeHtml_(leaveN) + "</strong>　代課：<strong>" + escapeHtml_(subN) + "</strong></li>";
        }
       if (role === "leave") {
          return '<li style="' + liStyle + '"><strong>【不用上】</strong>' + escapeHtml_(slot) + "　由 <strong>" + escapeHtml_(subN) + "</strong> 代課</li>";
        }
        if (role === "cover") {
          return '<li style="' + liStyle + '"><strong>【代課】</strong>' + escapeHtml_(slot) + "　代 <strong>" + escapeHtml_(leaveN) + "</strong> 老師</li>";
        }
        var who = "";
        if (showLeave && showSub) who = "　" + escapeHtml_(leaveN) + "→" + escapeHtml_(subN);
        else if (showLeave) who = "　請假：" + escapeHtml_(leaveN);
        else if (showSub) who = "　代課：" + escapeHtml_(subN);
        return '<li style="' + liStyle + '"><strong>【代課】</strong>' + escapeHtml_(slot) + who + "</li>";
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
      return '<li style="' + liStyle + '"><strong>【調課】</strong>不用上 ' + escapeHtml_(outC) + " → 改上 " + escapeHtml_(inC)
        + (peer ? "　與<strong>" + escapeHtml_(peer) + "</strong>" : "")
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

  if (isCombinedReturnRequest_(req)) {
    var combinedDate = req.requestDate || req["異動日期"] || "";
    var combinedPeriod = req.requestPeriod || req["異動節次"] || "";
    var combinedClass = req.className || req["班級"] || "";
    var combinedSubject = req.subject || req["科目"] || "";
    if (!combinedDate || combinedPeriod == null || combinedPeriod === "") return null;
    var combinedTimeSpan = _periodTimeSpan_(combinedPeriod);
    if (!combinedTimeSpan) return null;
    var combinedParts = combinedTimeSpan.split("-");
    var combinedDatePart = String(combinedDate).replace(/-/g, "");
    var combinedSlot = (String(combinedClass || "") + " " + String(combinedSubject || "")).trim() || "課堂";
    var combinedLeaveName = req.requesterName || req["申請人姓名"] || "請假教師";
    var combinedCoverName = req.targetTeacherName || req["受邀人姓名"] || "其他併班任課教師";
    var combinedTitleTag = role === "leave" ? "不用上" : (role === "cover" ? "代課" : "合班回原班");
    var combinedAction = role === "leave"
      ? "本節不用上。由 " + combinedCoverName + " 代課。"
      : (role === "cover"
        ? "本節請代課。請假教師：" + combinedLeaveName + "。"
        : "請假：" + combinedLeaveName + "　代課：" + combinedCoverName);
    return {
      title: "【" + combinedTitleTag + "】" + combinedSlot,
      startIso: combinedDatePart + "T" + combinedParts[0].replace(":", "") + "00",
      endIso: combinedDatePart + "T" + combinedParts[1].replace(":", "") + "00",
      details: combinedAction
        + "\n流程：合班回原班（請假教師由其他併班任課教師代課）"
        + "\n請假教師：" + combinedLeaveName
        + "\n代課教師：" + combinedCoverName
        + "\n經費鐘點：" + (req.subFee || req["經費來源"] || "自費代課")
        + "\n單號：" + serial + "\n（建成國中線上課表系統）",
      titleTag: combinedTitleTag
    };
  }

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
        + "\n假別事由：" + reason + "\n單號：" + serial + "\n（建成國中線上課表系統）",
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
    // 申請人：在受邀人原課的時間調入，顯示申請人自己的原課班科。
    eventDate = sides.targetDate || sides.leaveDate;
    eventPeriod = sides.targetPeriod != null && sides.targetPeriod !== "" ? sides.targetPeriod : sides.leavePeriod;
    className = sides.leaveClass;
    subject = sides.leaveSubject;
    actionLine = "【調入】本則為您要上的節次（您的課程："
      + ((className + " " + subject).trim() || "—") + "）。\n"
      + "【調出】" + sides.leaveDate + "第" + sides.leavePeriod + "節（"
      + ((sides.leaveClass + " " + sides.leaveSubject).trim() || "—") + "）不用上，由 "
      + sides.coverName + " 上。";
  } else {
    // 受邀人：在申請人原課的時間調入，顯示受邀人自己的原課班科。
    eventDate = sides.leaveDate;
    eventPeriod = sides.leavePeriod;
    className = sides.targetClass;
    subject = sides.targetSubject;
    actionLine = "【調入】本則為您要上的節次（您的課程："
      + ((className + " " + subject).trim() || "—") + "）。\n"
      + "【調出】" + sides.targetDate + "第" + sides.targetPeriod + "節（"
      + ((sides.targetClass + " " + sides.targetSubject).trim() || "—") + "）不用上，由 "
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
    + "\n（建成國中線上課表系統）";
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
     ? ('<a href="' + calUrl + '" style="background-color:#0f766e;color:#ffffff;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;margin:0 8px 8px 0;">' + escapeHtml_(calLabel) + "</a>")
    : "";
  var sysBtn = '<a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;margin:0 8px 8px 0;">進入系統查看課表</a>';
  var printHint = '<p style="color:#64748b;font-size:13px;margin:12px 0 0;line-height:1.55;">通知單請登入系統 →「歷史紀錄」或案件詳情 →「印通知」依學校原版格式列印代（調、補）課單。</p>';
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
       + '<a href="' + url + '" style="color:#0f766e;font-weight:600;text-decoration:underline;">' + escapeHtml_(label) + "</a>"
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
   var sysUrl = trustedSystemUrl_(currentUrl);
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
    var subject = "【建成國中線上課表系統】" + noun + "已核准生效（您有 " + n + " 項異動）";

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
       calItems.push('<li style="margin-bottom:4px;"><a href="' + url + '" style="color:#0f766e;font-weight:600;text-decoration:underline;">' + escapeHtml_(label) + "</a></li>");
    });
    if (calItems.length) {
      calHtml = '<div style="margin:14px 0;padding:10px 12px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;">'
        + '<div style="font-weight:700;color:#0f766e;margin-bottom:6px;font-size:13px;">加入行事曆</div>'
        + '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.55;">' + calItems.join("") + "</ul></div>";
    }

     var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(g.name || "老師") + "</b> 老師，您好：</p>"
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
  if (isCombinedReturnRequest_(req)) return;
  var to = req.requesterEmail || req["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
  var serial = req.serial || req["單號"] || "SUB";
   var requesterName = req.requesterName || req["申請人姓名"];
   var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
   var subject = "【建成國中線上課表系統】" + targetTeacherName + " 老師已接受您的代課邀請，待行政審核中";
   var sysUrl = trustedSystemUrl_(currentUrl);
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(requesterName) + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + escapeHtml_(targetTeacherName) + '</b> 老師已同意接受了您的調代課邀請。</p>'
    + '<p style="color:#475569;">目前申請案已送交行政教學組，待行政最終審核後生效，明細如下：</p>'
    + _buildReqTable_(req)
    + '<div style="margin:24px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(37,99,235,0.15);letter-spacing:1px;">進入系統查看狀態</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 等候行政審核", "#d97706", content);
  sendSystemEmail_(to, subject, htmlBody);
}

function sendRespondRejectEmail_(req, currentUrl) {
  if (isCombinedReturnRequest_(req)) return;
  var to = req.requesterEmail || req["申請人Email"];
  if (!to || to.indexOf("@") === -1) return;
   var requesterName = req.requesterName || req["申請人姓名"];
   var targetTeacherName = req.targetTeacherName || req["受邀人姓名"];
   var subject = "【建成國中線上課表系統】" + targetTeacherName + " 老師已拒絕了您的調代課邀請";
   var sysUrl = trustedSystemUrl_(currentUrl);
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(requesterName) + '</b> 老師，您好：</p>'
     + '<p style="color:#475569;margin-top:0;"><b>' + escapeHtml_(targetTeacherName) + '</b> 老師已拒絕了您的調代課邀請。</p>'
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
    var sysUrl = trustedSystemUrl_(currentUrl);
    if (isCombinedReturnRequest_(req)) {
      var combinedLeaveName = req.requesterName || req["申請人姓名"] || "請假教師";
      var combinedCoverName = req.targetTeacherName || req["受邀人姓名"] || "代課教師";
      var combinedSubject = "【建成國中線上課表系統】合班回原班申請已核准生效 (" + serial + ")";
      if (to1 && String(to1).indexOf("@") !== -1) {
        var leaveContent = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(combinedLeaveName) + "</b> 老師，您好：</p>"
          + '<p style="color:#475569;margin-top:0;">您的「合班回原班」申請已由教學組核准生效，本節不用上，由 ' + escapeHtml_(combinedCoverName) + " 老師代課。</p>"
          + _buildReqTable_(req)
          + _approveActionButtonsHtml_(req, "leave", sysUrl);
        sendSystemEmail_(to1, combinedSubject, _wrapHtmlTemplate_("調代課線上系統 - 合班回原班核准", "#059669", leaveContent));
      }
      if (to2 && String(to2).indexOf("@") !== -1
          && String(to2).toLowerCase().trim() !== String(to1 || "").toLowerCase().trim()) {
        var coverContent = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(combinedCoverName) + "</b> 老師，您好：</p>"
          + '<p style="color:#475569;margin-top:0;">「合班回原班」申請已由教學組核准生效，請於該節協助 ' + escapeHtml_(combinedLeaveName) + " 老師代課。</p>"
          + _buildReqTable_(req)
          + _approveActionButtonsHtml_(req, "cover", sysUrl);
        sendSystemEmail_(to2, combinedSubject, _wrapHtmlTemplate_("調代課線上系統 - 合班代課核准", "#059669", coverContent));
      }
      return;
    }
   var isExchange = !!(req.targetDate || req["對調目標日期"]
    || req.type === "exchange" || req["異動類型"] === "exchange" || req["異動類型"] === "對調");
   var subject = "【建成國中線上課表系統】您的調代課申請已由教學組核准出單並生效 (" + serial + ")";

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
     var contentLeave = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(name1) + "</b> 老師，您好：</p>"
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
     var contentCover = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">親愛的 <b>' + escapeHtml_(name2) + "</b> 老師，您好：</p>"
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
   var subject = "【建成國中線上課表系統】您的調代課申請已被教學組駁回 (單號: " + serial + ")";
    var sysUrl = trustedSystemUrl_(currentUrl);
    if (isCombinedReturnRequest_(req)) {
      var combinedContent = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">請假／代課教師您好：</p>'
        + '<p style="color:#475569;margin-top:0;">「合班回原班」申請已被教學組駁回，未核准生效，原課表不變。</p>'
        + _buildReqTable_(req)
        + '<p style="color:#475569;margin-top:24px;font-size:14px;">若有任何疑問，請向教學組洽詢。</p>'
        + '<div style="margin:16px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">進入系統查看</a></div>';
      emails.forEach(function (em) {
         sendSystemEmail_(em, "【建成國中線上課表系統】合班回原班申請已駁回 (單號: " + serial + ")", _wrapHtmlTemplate_("建成國中線上課表系統 - 合班回原班駁回", "#ef4444", combinedContent));
      });
      return;
   }
   var content = '<p style="color:#1e293b;font-size:15px;margin-bottom:8px;">兩位老師，您好：</p>'
    + '<p style="color:#475569;margin-top:0;">很抱歉通知您，您申報的調代課案件已被教學組駁回，未核准出單。明細如下：</p>'
    + _buildReqTable_(req)
    + '<p style="color:#475569;margin-top:24px;font-size:14px;">若有任何疑問，請向教學組洽詢。</p>'
    + '<div style="margin:16px 0;"><a href="' + sysUrl + '" style="background-color:#2563eb;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;box-shadow:0 4px 12px rgba(37,99,235,0.15);letter-spacing:1px;">進入系統查看</a></div>';
  var htmlBody = _wrapHtmlTemplate_("調代課線上系統 - 申請被行政駁回", "#ef4444", content);
  emails.forEach(function (em) { sendSystemEmail_(em, subject, htmlBody); });
}
