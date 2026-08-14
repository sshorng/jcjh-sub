# -*- coding: utf-8 -*-
"""One-shot patch: P1 deferred mail after lock + P3 single stringify."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "code.gs"
text = p.read_text(encoding="utf-8")

helper = """
/** P1：寫入鎖內只排隊寄信，放鎖後再寄（避免多人簽核卡 10 秒） */
var _deferredMails_ = null;
function beginDeferredMails_() {
  _deferredMails_ = [];
}
function queueMail_(label, fn) {
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

"""

if "beginDeferredMails_" not in text:
    si = text.find("function sendSystemEmail_")
    if si < 0:
        raise SystemExit("sendSystemEmail_ not found")
    text = text[:si] + helper + text[si:]
    print("inserted helpers")
else:
    print("helpers exist")

old_lock = """    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {"""
new_lock = """    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    beginDeferredMails_();
    try {"""
if old_lock in text:
    text = text.replace(old_lock, new_lock, 1)
    print("beginDeferredMails_ on lock")
else:
    print("MISS lock begin")

old_finally = """    } finally {
      try { lock.releaseLock(); } catch (ign) {}
    }"""
new_finally = """    } finally {
      try { lock.releaseLock(); } catch (ign) {}
      try { flushDeferredMails_(); } catch (ignM) { logError_("flushDeferredMails_", ignM); }
    }"""
if old_finally in text:
    text = text.replace(old_finally, new_finally, 1)
    print("flush after unlock")
else:
    print("MISS finally")

replacements = [
    (
        'try { sendAdminApproveEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }',
        "queueMail_('sendAdminApproveEmail', function () { sendAdminApproveEmail_(targetReq, currentUrl); });",
    ),
    (
        'try { sendAdminRejectEmail_(targetReq, currentUrl); } catch(ignE) { logError_("sendAdminRejectEmail", ignE); }',
        "queueMail_('sendAdminRejectEmail', function () { sendAdminRejectEmail_(targetReq, currentUrl); });",
    ),
    (
        'try { sendAdminApproveEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendAdminApproveEmail", ignE); }',
        "queueMail_('sendAdminApproveEmail', function () { sendAdminApproveEmail_(reqData.request, currentUrl); });",
    ),
    (
        'try { sendSubInviteEmail_(reqData.request, currentUrl); } catch(ignE) { logError_("sendSubInviteEmail", ignE); }',
        "queueMail_('sendSubInviteEmail', function () { sendSubInviteEmail_(reqData.request, currentUrl); });",
    ),
    (
        'try { sendRespondAgreeEmail_(targetReq, currentUrl); } catch (ignE) { logError_("sendRespondAgreeEmail", ignE); }',
        "queueMail_('sendRespondAgreeEmail', function () { sendRespondAgreeEmail_(targetReq, currentUrl); });",
    ),
    (
        'try { sendRespondRejectEmail_(targetReq, currentUrl); } catch (ignE) { logError_("sendRespondRejectEmail", ignE); }',
        "queueMail_('sendRespondRejectEmail', function () { sendRespondRejectEmail_(targetReq, currentUrl); });",
    ),
]
for a, b in replacements:
    c = text.count(a)
    text = text.replace(a, b)
    print(("OK" if c else "MISS"), c, a[:48])

old_batch_ap = """      try {
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
      } catch (apMailOuter) { logError_("adminApproveBatchMailOuter", apMailOuter); }"""

new_batch_ap = """      queueMail_('adminApproveBatchMail', function () {
        var apBySub = {};
        apToSave.forEach(function (r) {
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
      });"""
print("batch ap", "OK" if old_batch_ap in text else "MISS")
text = text.replace(old_batch_ap, new_batch_ap)

old_rj = """      try {
        rjToSave.forEach(function (r) {
          try { sendAdminRejectEmail_(r, currentUrl); } catch (rjMailE) { logError_("adminRejectBatchMail", rjMailE); }
        });
      } catch (rjOuter) { logError_("adminRejectBatchMailOuter", rjOuter); }"""
new_rj = """      queueMail_('adminRejectBatchMail', function () {
        rjToSave.forEach(function (r) {
          sendAdminRejectEmail_(r, currentUrl);
        });
      });"""
print("batch rj", "OK" if old_rj in text else "MISS")
text = text.replace(old_rj, new_rj)

old_resp = """      try {
        if (resp === "agree") {
          sendRespondAgreeBatchEmail_(peers, currentUrl);
        } else {
          sendRespondRejectBatchEmail_(peers, currentUrl);
        }
      } catch (ignBatchResp) {
        logError_("respondToBatchMail", ignBatchResp);
      }"""
new_resp = """      queueMail_('respondToBatchMail', function () {
        if (resp === "agree") {
          sendRespondAgreeBatchEmail_(peers, currentUrl);
        } else {
          sendRespondRejectBatchEmail_(peers, currentUrl);
        }
      });"""
print("resp batch", "OK" if old_resp in text else "MISS")
text = text.replace(old_resp, new_resp)

# submitRequestBatch mail blocks - search patterns
# Look for sendAdminApproveBatchEmail_ and sendSubInvite inside submitRequestBatch
# Manual fix if complex

old_p3 = """          var ttl = (readerIsAdmin || readerIsStaff) ? CACHE_TTL_FULL_ : CACHE_TTL_TEACHER_FULL_;
          putCacheChunked(fullSharedKey, JSON.stringify(fullShared), ttl);
          // 教師／admin 底包內容相同時互寫，提高命中
          if (readerIsAdmin || readerIsStaff) {
            putCacheChunked(
              "jcjh_data_" + semesterId + "_teacher_w" + wDays,
              JSON.stringify(fullShared),
              CACHE_TTL_TEACHER_FULL_
            );
          }"""
new_p3 = """          var ttl = (readerIsAdmin || readerIsStaff) ? CACHE_TTL_FULL_ : CACHE_TTL_TEACHER_FULL_;
          var fullSharedJson = JSON.stringify(fullShared);
          putCacheChunked(fullSharedKey, fullSharedJson, ttl);
          // 教師／admin 底包內容相同時互寫，提高命中（共用字串）
          if (readerIsAdmin || readerIsStaff) {
            putCacheChunked(
              "jcjh_data_" + semesterId + "_teacher_w" + wDays,
              fullSharedJson,
              CACHE_TTL_TEACHER_FULL_
            );
          }"""
print("P3", "OK" if old_p3 in text else "MISS")
text = text.replace(old_p3, new_p3)

p.write_text(text, encoding="utf-8")
print("written", p)
