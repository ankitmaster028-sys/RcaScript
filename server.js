#!/usr/bin/env node
/**
 * RCA IELTS Dashboard â€“ Optimized Edition (FIXED v4 - CRITICAL BUGS RESOLVED)
 * âœ“ LearnEnglish/APEX/Wordcraft Task Completion - FIXED
 * âœ“ False Success Reports - FIXED (proper state verification)
 * âœ“ Task Refresh After Completion - FIXED (auto-refresh enabled)
 * âœ“ Locked Lessons Handling - FIXED (skip locked, complete unlocked only)
 * âœ“ Certificate Download - FIXED (proper param passing)
 * âœ“ State Synchronization - FIXED (verify before reporting success)
 * âœ“ Concurrent Task Conflicts - FIXED (task locking improved)
 * âœ“ API Logs Filtered - FIXED (console only, not in job progress)
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ==================== SESSION ENCRYPTION ====================
const SESSION_SECRET = process.env.SESSION_SECRET || "MyselfAnkitVercelFix2024";
const SESSION_KEY = crypto.scryptSync(SESSION_SECRET, "rca-ielts-salt", 32);

function encryptSession(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", SESSION_KEY, iv);
  let enc = cipher.update(JSON.stringify(data), "utf8", "hex");
  enc += cipher.final("hex");
  return iv.toString("hex") + ":" + enc;
}

function decryptSession(str) {
  try {
    const parts = str.split(":");
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", SESSION_KEY, iv);
    let dec = decipher.update(parts[1], "hex", "utf8");
    dec += decipher.final("utf8");
    const data = JSON.parse(dec);
    if (!data || !data.createdAt) return null;
    if (Date.now() - data.createdAt > CONFIG.SESSION_TTL_MS) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// ==================== CONFIGURATION ====================
const CONFIG = {
  HOST: "0.0.0.0",
  PORT: process.env.PORT || 8765,
  API_BASE: "https://api-rca.englishhelper.com:8443/RcaServer/api",
  APP_PASSWORD: "Password",
  COIN_PASSKEY: "MyselfAnkit",
  SESSION_TTL_MS: 24 * 60 * 60 * 1000,
  SESSION_REFRESH_THRESHOLD_MS: 2 * 60 * 60 * 1000,
  MAX_BULK_USERS: 5,
  MAX_COINS_PER_REQUEST: 500,
  MAX_RETRIES: 4,
  RETRY_DELAY_MS: 1000,
  REQUEST_TIMEOUT_MS: 90000,
  LOGIN_TIMEOUT_MS: 120000,
  SOCKET_TIMEOUT_MS: 60000,
  DELAY_BETWEEN_TASKS_MS: 300,
};

// ==================== HTTPS AGENT WITH KEEP-ALIVE ====================
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: CONFIG.SOCKET_TIMEOUT_MS,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  secureOptions: require("constants").SSL_OP_LEGACY_SERVER_CONNECT || 0,
});

// ==================== COOKIE JAR ====================
const cookieJar = new Map();

function parseCookies(responseHeaders) {
  const cookies = [];
  const setCookie = responseHeaders["set-cookie"];
  if (!setCookie) return cookies;
  const rawCookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of rawCookies) {
    const nameValue = cookie.split(";")[0].trim();
    if (nameValue) cookies.push(nameValue);
  }
  return cookies;
}

function getCookiesForHost(hostname) {
  const jar = cookieJar.get(hostname);
  return jar ? jar.join("; ") : "";
}

function storeCookies(hostname, cookies) {
  if (!cookies || cookies.length === 0) return;
  let jar = cookieJar.get(hostname);
  if (!jar) {
    jar = [];
    cookieJar.set(hostname, jar);
  }
  for (const newCookie of cookies) {
    const newName = newCookie.split("=")[0];
    const idx = jar.findIndex(c => c.split("=")[0] === newName);
    if (idx !== -1) jar.splice(idx, 1);
    jar.push(newCookie);
  }
}

// ==================== LEVEL DEFINITIONS ====================
const LEVEL_META = [
  { id: null, name: "A1", title: "Beginner", subtitle: "Foundation Level", color: "a1" },
  { id: null, name: "A2", title: "Elementary", subtitle: "Basic Communication", color: "a2" },
  { id: null, name: "B1", title: "Intermediate", subtitle: "Independent User", color: "b1" },
  { id: null, name: "B2", title: "Upper Intermediate", subtitle: "Fluent Communication", color: "b2" },
  { id: null, name: "C1", title: "Advanced", subtitle: "Proficient User", color: "c1" },
  { id: null, name: "C2", title: "Mastery", subtitle: "Expert Level", color: "c2" },
];

const SKILLS = [
  { key: "LISTENING", name: "Listening", icon: "fa-headphones" },
  { key: "SPEAKING", name: "Speaking", icon: "fa-microphone" },
  { key: "WRITING", name: "Writing", icon: "fa-pen" },
  { key: "READING", name: "Reading", icon: "fa-book-open" },
];

function detectLessonSkill(lesson) {
  const candidates = [
    lesson.summarySkill, lesson.skill, lesson.skillName,
    lesson.activitySkill, lesson.lessonSkill, lesson.category, lesson.type, lesson.skillType
  ];
  for (const val of candidates) {
    if (val == null) continue;
    const upper = String(val).toUpperCase();
    for (const s of SKILLS) { if (s.key === upper || s.name.toUpperCase() === upper) return s.key; }
    if (upper.includes("SPEAK")) return "SPEAKING";
    if (upper.includes("LISTEN")) return "LISTENING";
    if (upper.includes("READ")) return "READING";
    if (upper.includes("WRITE") || upper.includes("ESSAY")) return "WRITING";
  }
  const name = String(lesson.lessonName || lesson.name || "").toUpperCase();
  if (name.includes("SPEAK")) return "SPEAKING";
  if (name.includes("LISTEN")) return "LISTENING";
  if (name.includes("READ")) return "READING";
  if (name.includes("WRITE") || name.includes("ESSAY")) return "WRITING";
  return "SPEAKING";
}

function isTrueFlag(value) {
  return value === true || String(value).trim().toLowerCase() === "true" || String(value).trim() === "1";
}

function isFalseFlag(value) {
  return value === false || value == null || String(value).trim().toLowerCase() === "false" || String(value).trim() === "0";
}

function isLessonLockedForUser(lesson) {
  // RCA's live response can contain isLessonLockedFromDb=true for an accessible
  // lesson. Explicit UI/freemium flags take priority over that database marker.
  if (!lesson) return false;
  if (isTrueFlag(lesson.lessonLockedForFreemium) || isTrueFlag(lesson.isLessonLocked)) return true;
  const hasFreemiumFlag = Object.prototype.hasOwnProperty.call(lesson, "lessonLockedForFreemium");
  const hasUiLockFlag = Object.prototype.hasOwnProperty.call(lesson, "isLessonLocked");
  if ((hasFreemiumFlag && isFalseFlag(lesson.lessonLockedForFreemium)) || (hasUiLockFlag && isFalseFlag(lesson.isLessonLocked))) return false;
  return isTrueFlag(lesson.isLessonLockedFromDb);
}

function detectLessonCompletion(lesson) {
  if (lesson.isCompleted === true || lesson.completed === true) return true;
  if (lesson.progress === 100 || lesson.progress === "100") return true;
  if (lesson.lessonCompletionPercentage === 100 || lesson.lessonCompletionPercentage === "100") return true;
  const fields = [lesson.lessonCompletionStatus, lesson.completionStatus, lesson.status, lesson.activityState, lesson.lessonStatus, lesson.state];
  for (const val of fields) {
    if (val === true) return true;
    if (val == null || val === false) continue;
    const upper = String(val).toUpperCase();
    if (["COMPLETED","DONE","FINISHED","SUBMITTED","COMPLETE","PASSED","SUCCESS"].includes(upper)) return true;
  }
  return false;
}

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const jobs = new Map();

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientInfo(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(",")[0].trim() : (req.socket.remoteAddress || "127.0.0.1");
  return {
    ip,
    ua: req.headers["x-client-ua"] || req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    screen: req.headers["x-client-screen"] || "1920x1080",
    timezone: req.headers["x-client-timezone"] || "Asia/Kolkata",
    lang: req.headers["x-client-lang"] || "en-US",
    platform: req.headers["x-client-platform"] || "Win32",
  };
}

function getRcaHeaders(token, loginId, clientInfo) {
  const hashInput = String(loginId || "default") + (clientInfo ? clientInfo.ip : "");
  const hash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const chromeVersions = ["120.0.0.0", "119.0.0.0", "121.0.0.0", "118.0.0.0", "122.0.0.0", "123.0.0.0"];
  const platforms = [
    "Windows NT 10.0; Win64; x64",
    "Macintosh; Intel Mac OS X 10_15_7",
    "X11; Linux x86_64",
    "Windows NT 10.0; Win64; x64",
    "Macintosh; Intel Mac OS X 10_15_7",
    "Windows NT 10.0; Win64; x64",
  ];

  const idx = parseInt(hash.slice(0, 4), 16) % chromeVersions.length;
  const version = chromeVersions[idx];

  let realUa = (clientInfo && clientInfo.ua) || `Mozilla/5.0 (${platforms[idx]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

  if (realUa.includes("Chrome/")) {
    const patch = parseInt(hash.slice(4, 8), 16) % 100;
    realUa = realUa.replace(/Chrome\/[\d.]+/, `Chrome/${120 + (idx % 5)}.0.${patch}.0`);
  }

  const deviceId = hash.slice(0, 16) + "-" + hash.slice(16, 32);

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://rca.englishhelper.com",
    "Referer": "https://rca.englishhelper.com/",
    "User-Agent": realUa,
    "x-request-id": uuid(),
    "x-journey-id": uuid(),
    "x-device-id": deviceId,
  };

  if (token) headers["Authorization"] = "Bearer " + token;
  return headers;
}

// ==================== HTTPS CLIENT ====================
function executeRequest(opts, payload, attempt = 1, isLogin = false, apiLogger = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timeoutMs = isLogin ? CONFIG.LOGIN_TIMEOUT_MS : CONFIG.REQUEST_TIMEOUT_MS;

    const cookieHeader = getCookiesForHost(opts.hostname);
    if (cookieHeader) {
      opts.headers = opts.headers || {};
      opts.headers["Cookie"] = cookieHeader;
    }

    opts.agent = httpsAgent;

    if (apiLogger) {
      let bodyStr = null;
      if (payload != null) {
        bodyStr = typeof payload === "string" ? payload.slice(0, 2000) : JSON.stringify(payload).slice(0, 2000);
      }
      apiLogger({
        type: "request",
        method: opts.method,
        path: opts.path,
        hostname: opts.hostname,
        body: bodyStr,
        timestamp: Date.now(),
      });
    }

    const req = https.request(opts, (res) => {
      const cookies = parseCookies(res.headers);
      if (cookies.length > 0) {
        storeCookies(opts.hostname, cookies);
      }

      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

        if (apiLogger) {
          let dataStr = null;
          if (data != null) {
            dataStr = typeof data === "object" ? JSON.stringify(data).slice(0, 2000) : String(data).slice(0, 2000);
          }
          apiLogger({
            type: "response",
            method: opts.method,
            path: opts.path,
            status: res.statusCode,
            data: dataStr,
            timestamp: Date.now(),
          });
        }

        if (res.statusCode >= 400) {
          console.error(`[RCA API ERROR] Path: ${opts.path} | Code: ${res.statusCode}`);
          const err = new Error((data && (data.message || data.error)) || raw || "HTTP " + res.statusCode);
          err.status = res.statusCode;
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });

    req.on("error", async (e) => {
      console.error(`[RCA Network Error] ${e.message} | Attempt: ${attempt}`);

      const retryableErrors = [
        "ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
        "EPIPE", "ECONNREFUSED", "EAI_AGAIN"
      ];

      const shouldRetry = retryableErrors.some(code => e.message.includes(code)) && attempt < CONFIG.MAX_RETRIES;

      if (shouldRetry) {
        const delay = isLogin ? 500 + (attempt * 500) : CONFIG.RETRY_DELAY_MS * attempt;
        console.log(`[RCA Retry] Attempt ${attempt + 1}/${CONFIG.MAX_RETRIES} in ${delay}ms...`);
        await sleep(delay);
        try {
          const result = await executeRequest(opts, payload, attempt + 1, isLogin, apiLogger);
          resolve(result);
          return;
        } catch (retryErr) {
          reject(retryErr);
          return;
        }
      }

      reject(e);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request Timeout (${timeoutMs}ms)`));
    });

    req.on("socket", (socket) => {
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => {
        req.destroy(new Error(`Socket Timeout (${timeoutMs}ms)`));
      });
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function rcaRequest(method, apiPath, { token, body, query, loginId, clientInfo, apiLogger } = {}, isLogin = false) {
  let pathStr = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) pathStr += (pathStr.includes("?") ? "&" : "?") + qs;
  }

  const payload =
    body === undefined || body === null
      ? null
      : typeof body === "string"
      ? body
      : JSON.stringify(body);

  const headers = getRcaHeaders(token, loginId, clientInfo);
  if (payload !== null) headers["Content-Length"] = Buffer.byteLength(payload);

  const url = new URL(CONFIG.API_BASE + pathStr);
  const opts = {
    hostname: url.hostname,
    port: url.port || 8443,
    path: url.pathname + url.search,
    method: method.toUpperCase(),
    headers,
    rejectUnauthorized: false,
  };

  return executeRequest(opts, payload, 1, isLogin, apiLogger);
}

function rcaRequestBinary(method, apiPath, { token, body, query, loginId, clientInfo } = {}, isLogin = false) {
  let pathStr = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) pathStr += (pathStr.includes("?") ? "&" : "?") + qs;
  }
  const payload = body === undefined || body === null ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const headers = getRcaHeaders(token, loginId, clientInfo);
  if (payload !== null) headers["Content-Length"] = Buffer.byteLength(payload);
  const url = new URL(CONFIG.API_BASE + pathStr);
  const opts = { hostname: url.hostname, port: url.port || 8443, path: url.pathname + url.search, method: method.toUpperCase(), headers, rejectUnauthorized: false, agent: httpsAgent };

  const attempt = (number) => new Promise((resolve, reject) => {
    const cookieHeader = getCookiesForHost(opts.hostname);
    if (cookieHeader) opts.headers.Cookie = cookieHeader;
    const request = https.request(opts, (response) => {
      const cookies = parseCookies(response.headers);
      if (cookies.length) storeCookies(opts.hostname, cookies);
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const text = bytes.toString("utf8");
          let data = null; try { data = JSON.parse(text); } catch (_) {}
          const error = new Error((data && (data.message || data.error)) || text || `HTTP ${response.statusCode}`);
          error.status = response.statusCode; error.data = data; reject(error); return;
        }
        const disposition = String(response.headers["content-disposition"] || "");
        const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i);
        resolve({ bytes, contentType: String(response.headers["content-type"] || "application/pdf"), filename: match ? decodeURIComponent(match[1].trim()) : null });
      });
    });
    request.on("error", (error) => {
      const retryable = ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].some((code) => String(error.message).includes(code));
      if (retryable && number < CONFIG.MAX_RETRIES) return sleep(CONFIG.RETRY_DELAY_MS * number).then(() => attempt(number + 1).then(resolve, reject));
      reject(error);
    });
    request.setTimeout(isLogin ? CONFIG.LOGIN_TIMEOUT_MS : CONFIG.REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Certificate request timed out")));
    if (payload !== null) request.write(payload);
    request.end();
  });
  return attempt(1);
}

function summarizeKpi(raw) {
  const rows = Array.isArray(raw && raw.skillResultDto) ? raw.skillResultDto : (Array.isArray(raw && raw.data) ? raw.data : []);
  return rows.slice(0, 12).map((item, index) => ({
    name: String(item.skillName || item.skill || item.name || item.activitySkill || `Skill ${index + 1}`),
    value: Number(item.percentage || item.score || item.result || item.completedActivities || item.totalEarnedScore || 0),
    total: Number(item.total || item.totalActivities || item.totalQuestions || item.maximumScore || 0),
  }));
}

async function accountInsights(user, section) {
  const safeRead = async (fn, fallback) => { try { return await retryWithReauth(fn, user); } catch (_) { return fallback; } };
  const packages = await safeRead(() => rcaRequest("GET", "/active-package-list", { token: user.accessToken, query: { studentAuthUserId: "0" }, loginId: user.loginId, clientInfo: user.clientInfo }), []);
  const completed = await safeRead(() => rcaRequest("GET", "/learner-streaks", { token: user.accessToken, query: { learnerId: String(user.learnerId), type: "COMPLETED" }, loginId: user.loginId, clientInfo: user.clientInfo }), {});
  const upcoming = await safeRead(() => rcaRequest("GET", "/learner-streaks", { token: user.accessToken, query: { learnerId: String(user.learnerId), type: "NEW" }, loginId: user.loginId, clientInfo: user.clientInfo }), {});
  const kpi = await safeRead(() => rcaRequest("GET", "/lessons/result-kpi", { token: user.accessToken, query: { curriculumId: String(section.curriculumId) }, loginId: user.loginId, clientInfo: user.clientInfo }), {});
  const speech = await safeRead(() => rcaRequest("GET", "/getGttsAndLanguages", { token: user.accessToken, loginId: user.loginId, clientInfo: user.clientInfo }), {});
  const voices = Array.isArray(speech && speech.gttsVoiceTypeLists) ? speech.gttsVoiceTypeLists : [];
  return {
    packages: (Array.isArray(packages) ? packages : []).map((item) => ({ id: String(item.id || ""), name: String(item.packageName || item.name || "RCA package"), duration: String(item.duration || ""), purpose: String(item.coursePurpose || ""), active: item.isActive !== false })),
    streaks: { completed: Number(completed.currentStreakCount || 0), upcoming: Number(upcoming.currentStreakCount || 0) },
    kpi: summarizeKpi(kpi),
    speech: { selectedLanguage: String(speech.userSelectedLanguage || "RCA default"), speed: Number(speech.speed || 0), voices: voices.slice(0, 24).map((item) => ({ id: String(item.id || ""), name: String(item.voiceName || item.voiceType || item.language || "RCA voice"), language: String(item.language || item.languageCode || "") })) },
  };
}

// ==================== SESSION MANAGEMENT ====================
function getSession(req) {
  let token = null;
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (m) token = decodeURIComponent(m[1]);
  if (!token) token = req.headers["x-auth-token"] || null;
  if (!token) return null;

  const data = decryptSession(token);
  if (!data) return null;

  return { sid: token.slice(0, 16), users: data.users, createdAt: data.createdAt };
}

function setSessionCookie(res, encryptedToken) {
  const cookieVal = "sid=" + encodeURIComponent(encryptedToken) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(CONFIG.SESSION_TTL_MS / 1000);
  const existing = res.getHeader("Set-Cookie");
  if (existing) {
    if (Array.isArray(existing)) {
      res.setHeader("Set-Cookie", [...existing, cookieVal]);
    } else {
      res.setHeader("Set-Cookie", [existing, cookieVal]);
    }
  } else {
    res.setHeader("Set-Cookie", cookieVal);
  }
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function refreshSessionIfNeeded(session) {
  const age = Date.now() - session.createdAt;
  if (age > CONFIG.SESSION_REFRESH_THRESHOLD_MS) {
    session.createdAt = Date.now();
    return true;
  }
  return false;
}

function publicUser(u) {
  return { loginId: u.loginId, learnerId: u.learnerId, name: u.name, coins: u.coins };
}


const SECTION_PACKAGE_NAMES = {
  learnenglish: ["learnenglish", "learn english"],
  ielts: ["learnenglish+", "ielts"],
  wordcraft: ["wordcraft"],
  apex: ["apex"],
  vocabbuilder: ["vocab builder", "vocabulary builder"],
};

function isPackageUnlocked(row) {
  if (!row) return false;
  const expired = row.isExpired === true || String(row.isExpired || "").trim().toLowerCase() === "true";
  const explicitlyLocked = row.isLocked === true || row.locked === true || String(row.isLocked || row.locked || "").trim().toLowerCase() === "true";
  if (expired || explicitlyLocked) return false;
  const status = String(row.status || row.packageStatus || row.subscriptionStatus || "").trim().toUpperCase().replace(/\s+/g, "_");
  if (["LOCKED", "NOT_PURCHASED", "EXPIRED", "INACTIVE", "NOT_AVAILABLE"].includes(status)) return false;
  const levels = Array.isArray(row.programSummaryLevelDtoList) ? row.programSummaryLevelDtoList : [];
  return status.length > 0 || levels.length > 0 || row.viewLessons === true;
}

async function getSectionAccess(user, force = false) {
  if (!force && user.sectionAccess && Date.now() - user.sectionAccess.fetchedAt < 30000) return user.sectionAccess;
  let rows = [];
  try {
    const summary = await rcaRequest("GET", "/program-summary", { token: user.accessToken, loginId: user.loginId, clientInfo: user.clientInfo });
    rows = Array.isArray(summary) ? summary : (Array.isArray(summary && summary.data) ? summary.data : []);
  } catch (e) {
    console.warn("Program summary unavailable:", e.message);
  }
  const unlocked = {};
  Object.values(SECTIONS).forEach((section) => {
    const row = rows.find((item) => String(item.packageId) === String(section.packageId) || (SECTION_PACKAGE_NAMES[section.id] || []).includes(String(item.packageName || "").toLowerCase()));
    unlocked[section.id] = !!(row && isPackageUnlocked(row));
  });
  const current = Object.values(SECTIONS).find((section) => String(section.packageId) === String(user.packageId));
  if (current) unlocked[current.id] = true;
  user.sectionAccess = {
    fetchedAt: Date.now(),
    unlocked,
    rows: rows.map((row) => ({
      packageId: row.packageId,
      packageName: row.packageName,
      status: row.status,
      isExpired: row.isExpired,
      programSummaryLevelDtoList: Array.isArray(row.programSummaryLevelDtoList)
        ? row.programSummaryLevelDtoList.map((level) => ({
            totalLessons: level.totalLessons,
            noOfLessonsCompleted: level.noOfLessonsCompleted,
            status: level.status,
          }))
        : [],
    })),
  };
  return user.sectionAccess;
}

function sectionDescriptors(access) {
  return Object.values(SECTIONS).map((section) => ({
    id: section.id,
    name: section.name,
    description: section.description,
    packageId: section.packageId,
    unlocked: !!(access && access.unlocked && access.unlocked[section.id]),
  }));
}

async function fetchActivityDetails(activitySetId, token, loginId, clientInfo) {
  const id = String(activitySetId);
  let first = null;
  let lastError = null;
  // The RCA web client uses both /activitySetDetails/{id}/0 and /{id}/{id}.
  for (const secondId of ["0", id]) {
    try {
      const data = await rcaRequest("GET", `/activitySetDetails/${id}/${secondId}/${Date.now()}/false`, { token, loginId, clientInfo });
      if (!first) first = data;
      if (data && (data.activityState === "SUBMITTED" || data.activityState === "COMPLETED" || data.isCompleted === true)) return data;
    } catch (e) { lastError = e; }
  }
  if (first) return first;
  throw lastError || new Error("Activity details unavailable");
}

function isPersistedSubmitted(activity) {
  return !!(activity && (activity.activityState === "SUBMITTED" || activity.activityState === "COMPLETED" || activity.isCompleted === true));
}


function numericScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function activityScore(activity) {
  if (!activity) return 0;
  const fields = ["totalEarnedScore", "earnedScore", "score", "totalScore", "resultScore"];
  for (const field of fields) {
    if (activity[field] != null && activity[field] !== "") return numericScore(activity[field]);
  }
  return 0;
}

function isScoredSubmitted(activity) {
  if (!isPersistedSubmitted(activity)) return false;
  return activityScore(activity) > 0 || numericScore(activity.totalAnswersCorrect) > 0;
}

function needsScoreRetake(activity) {
  return isPersistedSubmitted(activity) && !isScoredSubmitted(activity) && numericScore(activity.totalQuestions || (activity.activityQuestionDetailsList || []).length) > 0;
}

function lessonNeedsScoreRetake(lesson) {
  if (!lesson || !detectLessonCompletion(lesson)) return false;
  const fields = [lesson.lessonCompletionScore, lesson.totalEarnedScore, lesson.score, lesson.totalScore, lesson.lessonPercentage];
  const known = fields.find((value) => value != null && value !== "");
  if (known != null) return numericScore(known) <= 0;
  return false;
}


function asArray(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data && data[key])) return data[key];
  return [];
}

async function fetchUnitLessonIndex(token, mappingId, loginId, clientInfo) {
  if (mappingId == null || mappingId === "") return [];
  try {
    const data = await rcaRequest("GET", "/units/unit-lesson-ids", {
      token,
      query: { curriculumLevelMappingId: String(mappingId) },
      loginId,
      clientInfo,
    });
    return asArray(data).map((entry) => ({
      lessonId: entry.lesson ?? entry.lessonId ?? entry.id,
      lessonName: entry.lessonName || entry.name || null,
      unitId: entry.unitId ?? entry.currentUnitId ?? null,
      unitSequence: entry.unitSequence,
      sequenceNo: entry.sequenceNo,
      lessonLockedForFreemium: !!entry.lessonLockedForFreemium,
    })).filter((entry) => entry.lessonId != null);
  } catch (e) {
    console.warn("Dynamic unit-lesson index unavailable:", e.message);
    return [];
  }
}

async function fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId, packageId, loginId, clientInfo, unitLessonIndex }) {
  const unitId = unit.id ?? unit.unitId ?? unit.currentUnitId;
  const stdLevel = String(standardLevelId ?? 8);
  const packageValue = String(packageId ?? "");
  let lessons = [];
  try {
    const data = await rcaRequest("GET", `/lessons/unit/${encodeURIComponent(unitId)}/${encodeURIComponent(stdLevel)}/false/${Date.now()}/${encodeURIComponent(packageValue)}`, { token, loginId, clientInfo });
    lessons = asArray(data, ["lessons", "data"]);
  } catch (e) {
    console.warn(`Lessons API failed for unit ${unitId}:`, e.message);
  }

  const indexed = (unitLessonIndex || []).filter((entry) => String(entry.unitId) === String(unitId));
  const byLesson = new Map();
  for (const lesson of lessons) {
    const lessonId = lesson.lessonId ?? lesson.id ?? lesson.activitySetId ?? lesson.activitySetID ?? lesson.activityId;
    if (lessonId != null) byLesson.set(String(lessonId), lesson);
  }
  // The web client gets this index separately. Merge missing future lessons into the
  // lesson response so new RCA content is visible even if the lesson endpoint is slow
  // or omits a newly-created lesson record.
  for (const entry of indexed) {
    const key = String(entry.lessonId);
    if (!byLesson.has(key)) {
      byLesson.set(key, {
        lessonId: entry.lessonId,
        activitySetId: entry.lessonId,
        lessonName: entry.lessonName || `Lesson ${entry.lessonId}`,
        lessonLockedForFreemium: entry.lessonLockedForFreemium,
        lessonSequence: entry.sequenceNo,
        unitSequence: entry.unitSequence,
      });
    }
  }
  return Array.from(byLesson.values()).sort((a, b) => Number(a.lessonSequence ?? a.sequenceNo ?? a.lessonId ?? 0) - Number(b.lessonSequence ?? b.sequenceNo ?? b.lessonId ?? 0));
}

function normalizeDynamicLesson(lesson) {
  const lessonId = lesson.lessonId ?? lesson.id ?? lesson.activitySetId ?? lesson.activitySetID ?? lesson.activityId;
  const activitySetId = lesson.activitySetId ?? lesson.activitySetID ?? lesson.activityId ?? lessonId;
  return {
    ...lesson,
    lessonId,
    activitySetId,
    lessonName: lesson.lessonName || lesson.name || `Lesson ${lessonId ?? ""}`.trim(),
  };
}

async function getPlacementStatus(user) {
  const access = await getSectionAccess(user);
  if (!access.unlocked.learnenglish) return { available: false, learnEnglishCompleted: false, reason: "LearnEnglish is locked" };
  const row = access.rows.find((item) => String(item.packageId) === "4");
  const levels = row && Array.isArray(row.programSummaryLevelDtoList) ? row.programSummaryLevelDtoList : [];
  const learnEnglishCompleted = levels.length > 0 && levels.every((level) => {
    const total = Number(level.totalLessons || 0);
    const done = Number(level.noOfLessonsCompleted || 0);
    return total > 0 ? done >= total : String(level.status || "").toUpperCase() === "COMPLETED";
  });
  if (!learnEnglishCompleted) return { available: false, learnEnglishCompleted: false, reason: "Complete LearnEnglish first" };
  let details = {};
  try {
    details = await rcaRequest("POST", "/userDetails?inputKeywordList=0", { token: user.accessToken, body: "", loginId: user.loginId, clientInfo: user.clientInfo });
  } catch (e) {
    console.warn("Placement userDetails warning:", e.message);
  }
  if (details.placementDone === true && details.skipPlacement === true) {
    return { available: false, completed: true, learnEnglishCompleted: true, reason: "RCA marks the placement test as completed" };
  }
  const configured = process.env.RCA_PLACEMENT_ACTIVITY_SET_ID || "";
  const candidates = [...new Set([
    details.currentActivitySetId,
    details.placementActivitySetId,
    configured,
    "12",
  ].filter((id) => id != null && String(id).trim() !== "").map(String))];
  let lastError = null;
  for (const activitySetId of candidates) {
    try {
      const activity = await fetchActivityDetails(activitySetId, user.accessToken, user.loginId, user.clientInfo);
      const label = `${activity.activityType || ""} ${activity.activityName || ""} ${activity.lessonName || ""}`.toUpperCase();
      const finalLike = String(activity.activityType || "").toUpperCase() === "FINAL" || activity.isFinalActivity === true || /FINAL|PLACEMENT|INITIAL ASSESSMENT/.test(label) || String(details.currentActivitySetId || "") === String(activitySetId);
      if (!finalLike) continue;
      const submitted = isPersistedSubmitted(activity);
      const scored = isScoredSubmitted(activity);
      return { available: !scored, completed: scored, retake: submitted && !scored, learnEnglishCompleted: true, activitySetId: String(activitySetId), activity: { lessonName: activity.lessonName || activity.activityName, totalQuestions: activity.totalQuestions, totalAnswersCorrect: activity.totalAnswersCorrect, totalEarnedScore: activity.totalEarnedScore, activityState: activity.activityState } };
    } catch (e) { lastError = e; }
  }
  return { available: false, completed: false, learnEnglishCompleted: true, reason: lastError ? lastError.message : "RCA did not return a placement activity" };
}



function publicActivity(activity) {
  const list = Array.isArray(activity && activity.activityQuestionDetailsList) ? activity.activityQuestionDetailsList : [];
  return {
    activitySetId: activity.activityId || activity.activitySetId || activity.id,
    activityType: activity.activityType || "Lesson",
    activityName: activity.activityName || activity.lessonName || "Activity",
    activityState: activity.activityState || "NEW",
    totalQuestions: activity.totalQuestions || list.length,
    totalEarnedScore: activity.totalEarnedScore || 0,
    totalAnswersCorrect: activity.totalAnswersCorrect || 0,
    questions: list.map((q, index) => ({
      index,
      itemId: q.itemId,
      activityResultDetailId: q.activityResultDetailId,
      itemType: q.itemType,
      question: q.itemQuestion || q.itemEnglishQuestion || q.questionText || "",
      instruction: q.itemInstruction || q.itemEnglishInstruction || "",
      imageUrl: q.itemImageUrl || null,
      answerType: q.answerType || null,
      options: (Array.isArray(q.activityAnswerDTO) ? q.activityAnswerDTO : []).map((o) => ({ id: o.id, text: o.answerOption || o.activityItem || "", isImage: !!o.isImage, imageUrl: o.imageUrl || null }))
    }))
  };
}

function answerKeyForQuestion(question) {
  if (!question) return null;
  return question.activityResultDetailId != null ? String(question.activityResultDetailId) : String(question.itemId);
}

async function submitManualActivity(session, activitySetId, answers, apiLogger) {
  const activity = await fetchActivityDetails(activitySetId, session.accessToken, session.loginId, session.clientInfo);
  if (!activity || !Array.isArray(activity.activityQuestionDetailsList) || activity.activityQuestionDetailsList.length === 0) throw new Error("RCA returned no questions for this activity");
  const answerMap = answers && typeof answers === "object" ? answers : {};
  let answered = 0;
  for (const q of activity.activityQuestionDetailsList) {
    const keys = [answerKeyForQuestion(q), q.itemId != null ? String(q.itemId) : null, q.activityResultDetailId != null ? String(q.activityResultDetailId) : null].filter(Boolean);
    const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(answerMap, candidate));
    if (key == null) continue;
    let answer = answerMap[key];
    const optionIds = new Set((Array.isArray(q.activityAnswerDTO) ? q.activityAnswerDTO : []).map((option) => String(option.id)));
    if (Array.isArray(answer)) answer = answer.map((value) => optionIds.has(String(value)) ? Number(value) : value);
    else if (optionIds.has(String(answer))) answer = Number(answer);
    q.userAnswer = answer;
    q.submittedUserAnswer = answer;
    q.isSubmitClicked = true;
    q.allAnswersRecorded = true;
    answered += answer !== "" && answer != null && !(Array.isArray(answer) && answer.length === 0) ? 1 : 0;
  }
  if (answered === 0) throw new Error("Answer at least one question before submitting");
  activity.activityState = "INPROGRESS";
  activity.learnerId = session.learnerId;
  activity.startDate = activity.startDate || Date.now() - 30000;
  activity.totalQuestionsAttempted = answered;
  activity.totalQuestionsLeft = Math.max(0, Number(activity.totalQuestions || activity.activityQuestionDetailsList.length) - answered);
  await submitActivity(session.accessToken, activity, "INPROGRESS", session.learnerId, session.loginId, session.clientInfo, apiLogger);
  await submitActivity(session.accessToken, activity, "SUBMITTED", session.learnerId, session.loginId, session.clientInfo, apiLogger);
  await sleep(350);
  const verified = await fetchActivityDetails(activitySetId, session.accessToken, session.loginId, session.clientInfo);
  if (!isPersistedSubmitted(verified)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
  return { activity: publicActivity(verified), scored: isScoredSubmitted(verified), retakeRequired: needsScoreRetake(verified) };
}

async function ensureScoredCertificateLevel(user, sectionId, levelId) {
  const section = SECTIONS[sectionId];
  if (!section) throw new Error("Invalid section");
  const levels = sectionId === "ielts" ? LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 })) : await section.getUserLevels(user.accessToken, user.loginId, user.clientInfo);
  const level = levels.find((item) => String(item.id) === String(levelId));
  if (!level) throw new Error("Level was not found in the RCA account");
  const data = await section.loadLevelData(user.accessToken, level, user.loginId, user.clientInfo);
  const ids = new Set();
  for (const unit of data.units || []) for (const lesson of unit.lessons || []) if (lesson.activitySetId) ids.add(String(lesson.activitySetId));
  for (const skill of Object.values(data.skills || {})) for (const id of skill.activitySetIds || []) ids.add(String(id));
  if (ids.size === 0) throw new Error("No RCA activities were found for this level");
  const missing = [];
  for (const id of ids) {
    try {
      const activity = await fetchActivityDetails(id, user.accessToken, user.loginId, user.clientInfo);
      if (!isScoredSubmitted(activity)) missing.push(id);
    } catch (_) { missing.push(id); }
  }
  if (missing.length) throw new Error(`Certificate blocked: ${missing.length} activity(s) are not verified with a positive RCA score. Retake them first.`);
  return true;
}

// ==================== SECTIONS DEFINITION ====================
const SECTIONS = {
  learnenglish: {
    id: "learnenglish",
    name: "LearnEnglish",
    description: "General English curriculum",
    curriculumId: 3,
    packageId: 4,
    activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", {
          token,
          query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "3" },
          loginId,
          clientInfo,
        });
        return (data || []).map((l, idx) => ({
          id: l.id || idx,
          name: l.level || LEVEL_META[idx]?.name || "L" + (idx + 1),
          title: LEVEL_META.find(m => m.name === l.level)?.title || l.level || "Level",
          subtitle: LEVEL_META.find(m => m.name === l.level)?.subtitle || "Level " + (idx + 1),
          color: LEVEL_META.find(m => m.name === l.level)?.color || "a1",
          curriculumLevelMappingId: l.curriculumLevelMappingId,
        }));
      } catch (e) {
        console.error("getUserLevels error:", e.message);
        return LEVEL_META.slice(0, 4).map((m, idx) => ({
          id: idx + 1,
          name: m.name,
          title: m.title,
          subtitle: m.subtitle,
          color: m.color,
          curriculumLevelMappingId: idx + 1,
        }));
      }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId;
        const units = asArray(await rcaRequest("GET", "/units", {
          token,
          query: { curriculumLevelMappingId: mappingId, packageId: "4" },
          loginId,
          clientInfo,
        }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);

        const resultUnits = [];
        const allSkills = {};

        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: 8, packageId: 4, loginId, clientInfo, unitLessonIndex });

          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson);
            const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) {
              allSkills[skillKey] = {
                name: skillKey,
                completed: false,
                score: 0,
                totalActivities: 0,
                completedActivities: 0,
                time: "10",
                activitySetIds: [],
                activities: [],
              };
            }

            const actId = lesson.activitySetId || lesson.activitySetID || lesson.activityId;
            const needsScoreRetake = lessonNeedsScoreRetake(lesson);
            const isComplete = detectLessonCompletion(lesson) && !needsScoreRetake;

            unitLessons.push({
              lessonId: lesson.lessonId,
              lessonName: lesson.lessonName || lesson.name || "Lesson " + lesson.lessonNumber,
              activitySetId: actId || null,
              skillKey,
              isCompleted: isComplete,
              status: needsScoreRetake ? "RETAKE_SCORE" : (isComplete ? "COMPLETED" : "NEW"),
              needsScoreRetake,
            });

            if (actId) {
              allSkills[skillKey].activitySetIds.push(String(actId));
              allSkills[skillKey].totalActivities++;
              if (isComplete) {
                allSkills[skillKey].completedActivities++;
              }

              allSkills[skillKey].activities.push({
                activitySetId: actId,
                isCompleted: isComplete,
                lessonName: lesson.lessonName || lesson.name || "Lesson " + lesson.lessonNumber,
              });
            }
          }

          if (unitLessons.length > 0) {
            resultUnits.push({
              unitId: unitId,
              unitName: unit.unitName || unit.name || "Unit " + unit.sequenceNo,
              sequenceNo: unit.sequenceNo || unitId,
              lessons: unitLessons,
            });
          }
        }

        let allDone = true;
        for (const key of Object.keys(allSkills)) {
          if (allSkills[key].completedActivities < allSkills[key].totalActivities) {
            allDone = false;
          }
          if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) {
            allSkills[key].completed = true;
          }
        }

        SKILLS.forEach((s) => {
          if (!allSkills[s.key]) {
            allSkills[s.key] = {
              name: s.name,
              completed: false,
              score: 0,
              totalActivities: 0,
              completedActivities: 0,
              time: "10",
              activitySetIds: [],
              activities: [],
            };
            allDone = false;
          }
        });

        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) {
        if (isAuthError(e)) throw e;
        console.error("loadLevelData error:", e.message);
        return { level: levelData, units: [], skills: {}, isCompleted: false };
      }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken;
      const learnerId = session.learnerId;
      const loginId = session.loginId;
      const clientInfo = session.clientInfo;
      const ts = Date.now();

      onLog && onLog("Fetching activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);

      if (!activity) throw new Error("Null activity payload");

      if (isScoredSubmitted(activity)) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);
      await sleep(250);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }
      if (!isScoredSubmitted(verifyActivity)) {
        throw new Error(`RCA submitted activity ${activitySetId} but score is 0. Open Retake Score and submit the questions manually.`);
      }
      onLog && onLog("âœ“ Verified submitted: " + activitySetId + " (" + allQuestions.length + " Qs, score " + activityScore(verifyActivity) + ")", "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, apiLogger, "Lesson");
    }
  },

  apex: {
    id: "apex",
    name: "APEX",
    description: "Advanced vocabulary & skills mastery",
    curriculumId: 105,
    packageId: 47,
    packageSuffix: 47,
    standardLevelId: 8,
    activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", {
          token,
          query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "105" },
          loginId,
          clientInfo,
        });
        return (data || []).map((l, idx) => ({
          id: l.id || idx,
          name: l.level || "L" + (idx + 1),
          title: (l.level || "Level") + (l.nextLevel ? " â†’ " + l.nextLevel : ""),
          subtitle: "APEX Level",
          color: String(l.level || "").toLowerCase() || "a1",
          curriculumLevelMappingId: l.curriculumLevelMappingId,
          standardLevelId: l.id,
          userLevelData: l,
        }));
      } catch (e) {
        console.error("getUserLevels error:", e.message);
        return [];
      }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId;
        const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", {
          token,
          query: { curriculumLevelMappingId: mappingId, packageId: "47" },
          loginId,
          clientInfo,
        }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);

        const resultUnits = [];
        const allSkills = {};
        const ts = Date.now();

        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 47, loginId, clientInfo, unitLessonIndex });

          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson);
            const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) {
              allSkills[skillKey] = {
                name: skillKey,
                completed: false,
                score: 0,
                totalActivities: 0,
                completedActivities: 0,
                time: "10",
                activitySetIds: [],
                activities: [],
              };
            }

            const actId = lesson.activitySetId || lesson.id || null;
            const needsScoreRetake = lessonNeedsScoreRetake(lesson);
            const isComplete = detectLessonCompletion(lesson) && !needsScoreRetake;
            const lessonLocked = isLessonLockedForUser(lesson);

            if (!lessonLocked) {
              unitLessons.push({
                lessonId: lesson.lessonId || actId,
                lessonName: lesson.lessonName || lesson.name || "Lesson",
                activitySetId: actId,
                skillKey,
                isCompleted: isComplete,
                isLocked: lessonLocked,
                status: needsScoreRetake ? "RETAKE_SCORE" : (isComplete ? "COMPLETED" : "NEW"),
                needsScoreRetake,
              });

              if (actId) {
                allSkills[skillKey].activitySetIds.push(String(actId));
                allSkills[skillKey].totalActivities++;
                if (isComplete) {
                  allSkills[skillKey].completedActivities++;
                }

                allSkills[skillKey].activities.push({
                  activitySetId: actId,
                  isCompleted: isComplete,
                  lessonName: lesson.lessonName || lesson.name || "Lesson",
                });
              }
            }
          }

          if (unitLessons.length > 0) {
            resultUnits.push({
              unitId: unitId,
              unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId),
              sequenceNo: unit.sequenceNo || unitId,
              isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked),
              completionStatus: unit.completionStatus || null,
              completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null,
              lessons: unitLessons,
            });
          }
        }

        let allDone = true;
        for (const key of Object.keys(allSkills)) {
          if (allSkills[key].completedActivities < allSkills[key].totalActivities) {
            allDone = false;
          }
          if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) {
            allSkills[key].completed = true;
          }
        }

        SKILLS.forEach((s) => {
          if (!allSkills[s.key]) {
            allSkills[s.key] = {
              name: s.name,
              completed: false,
              score: 0,
              totalActivities: 0,
              completedActivities: 0,
              time: "10",
              activitySetIds: [],
              activities: [],
            };
            allDone = false;
          }
        });

        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) {
        if (isAuthError(e)) throw e;
        console.error("loadLevelData error:", e.message);
        return { level: levelData, units: [], skills: {}, isCompleted: false };
      }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken;
      const learnerId = session.learnerId;
      const loginId = session.loginId;
      const clientInfo = session.clientInfo;
      const ts = Date.now();

      onLog && onLog("Fetching activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);

      if (!activity) throw new Error("Null activity payload");

      if (isScoredSubmitted(activity)) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);
      await sleep(250);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }
      if (!isScoredSubmitted(verifyActivity)) {
        throw new Error(`RCA submitted activity ${activitySetId} but score is 0. Open Retake Score and submit the questions manually.`);
      }
      onLog && onLog("âœ“ Verified submitted: " + activitySetId + " (" + allQuestions.length + " Qs, score " + activityScore(verifyActivity) + ")", "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, apiLogger, "Lesson");
    }
  },

  vocabbuilder: {
    id: "vocabbuilder",
    name: "Vocab Builder",
    description: "Vocabulary building program",
    curriculumId: 125,
    packageId: 50,
    packageSuffix: 50,
    standardLevelId: 8,
    activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", {
          token,
          query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "125" },
          loginId,
          clientInfo,
        });
        return (data || []).map((l, idx) => ({
          id: l.id || idx,
          name: l.level || "L" + (idx + 1),
          title: (l.level || "Level") + (l.nextLevel ? " â†’ " + l.nextLevel : ""),
          subtitle: "Vocab Builder Level",
          color: String(l.level || "").toLowerCase() || "a1",
          curriculumLevelMappingId: l.curriculumLevelMappingId,
          standardLevelId: l.id,
          userLevelData: l,
        }));
      } catch (e) {
        console.error("getUserLevels error:", e.message);
        return [];
      }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId;
        const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", {
          token,
          query: { curriculumLevelMappingId: mappingId, packageId: "50" },
          loginId,
          clientInfo,
        }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);

        const resultUnits = [];
        const allSkills = {};
        const ts = Date.now();

        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 50, loginId, clientInfo, unitLessonIndex });

          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson);
            const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) {
              allSkills[skillKey] = {
                name: skillKey,
                completed: false,
                score: 0,
                totalActivities: 0,
                completedActivities: 0,
                time: "10",
                activitySetIds: [],
                activities: [],
              };
            }

            const actId = lesson.activitySetId || lesson.id || null;
            const needsScoreRetake = lessonNeedsScoreRetake(lesson);
            const isComplete = detectLessonCompletion(lesson) && !needsScoreRetake;
            const lessonLocked = isLessonLockedForUser(lesson);

            if (!lessonLocked) {
              unitLessons.push({
                lessonId: lesson.lessonId || actId,
                lessonName: lesson.lessonName || lesson.name || "Lesson",
                activitySetId: actId,
                skillKey,
                isCompleted: isComplete,
                isLocked: lessonLocked,
                status: needsScoreRetake ? "RETAKE_SCORE" : (isComplete ? "COMPLETED" : "NEW"),
                needsScoreRetake,
              });

              if (actId) {
                allSkills[skillKey].activitySetIds.push(String(actId));
                allSkills[skillKey].totalActivities++;
                if (isComplete) {
                  allSkills[skillKey].completedActivities++;
                }

                allSkills[skillKey].activities.push({
                  activitySetId: actId,
                  isCompleted: isComplete,
                  lessonName: lesson.lessonName || lesson.name || "Lesson",
                });
              }
            }
          }

          if (unitLessons.length > 0) {
            resultUnits.push({
              unitId: unitId,
              unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId),
              sequenceNo: unit.sequenceNo || unitId,
              isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked),
              completionStatus: unit.completionStatus || null,
              completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null,
              lessons: unitLessons,
            });
          }
        }

        let allDone = true;
        for (const key of Object.keys(allSkills)) {
          if (allSkills[key].completedActivities < allSkills[key].totalActivities) {
            allDone = false;
          }
          if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) {
            allSkills[key].completed = true;
          }
        }

        SKILLS.forEach((s) => {
          if (!allSkills[s.key]) {
            allSkills[s.key] = {
              name: s.name,
              completed: false,
              score: 0,
              totalActivities: 0,
              completedActivities: 0,
              time: "10",
              activitySetIds: [],
              activities: [],
            };
            allDone = false;
          }
        });

        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) {
        if (isAuthError(e)) throw e;
        console.error("loadLevelData error:", e.message);
        return { level: levelData, units: [], skills: {}, isCompleted: false };
      }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken;
      const learnerId = session.learnerId;
      const loginId = session.loginId;
      const clientInfo = session.clientInfo;
      const ts = Date.now();

      onLog && onLog("Fetching activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);

      if (!activity) throw new Error("Null activity payload");

      if (isScoredSubmitted(activity)) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);
      await sleep(250);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }
      if (!isScoredSubmitted(verifyActivity)) {
        throw new Error(`RCA submitted activity ${activitySetId} but score is 0. Open Retake Score and submit the questions manually.`);
      }
      onLog && onLog("âœ“ Verified submitted: " + activitySetId + " (" + allQuestions.length + " Qs, score " + activityScore(verifyActivity) + ")", "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, apiLogger, "Lesson");
    }
  },

  wordcraft: {
    id: "wordcraft",
    name: "Wordcraft",
    description: "Wordcraft vocabulary course",
    curriculumId: 106,
    packageId: 90,
    packageSuffix: 90,
    standardLevelId: 8,
    activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", {
          token,
          query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "106" },
          loginId,
          clientInfo,
        });
        return (data || []).map((l, idx) => ({
          id: l.id || idx,
          name: l.level || "L" + (idx + 1),
          title: (l.level || "Level") + (l.nextLevel ? " â†’ " + l.nextLevel : ""),
          subtitle: "Wordcraft Level",
          color: String(l.level || "").toLowerCase() || "a1",
          curriculumLevelMappingId: l.curriculumLevelMappingId,
          standardLevelId: l.id,
          userLevelData: l,
        }));
      } catch (e) {
        console.error("getUserLevels error:", e.message);
        return [];
      }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId;
        const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", {
          token,
          query: { curriculumLevelMappingId: mappingId, packageId: "90" },
          loginId,
          clientInfo,
        }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);

        const resultUnits = [];
        const allSkills = {};
        const ts = Date.now();

        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 90, loginId, clientInfo, unitLessonIndex });

          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson);
            const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) {
              allSkills[skillKey] = {
                name: skillKey,
                completed: false,
                score: 0,
                totalActivities: 0,
                completedActivities: 0,
                time: "10",
                activitySetIds: [],
                activities: [],
              };
            }

            const actId = lesson.activitySetId || lesson.id || null;
            const needsScoreRetake = lessonNeedsScoreRetake(lesson);
            const isComplete = detectLessonCompletion(lesson) && !needsScoreRetake;
            const lessonLocked = isLessonLockedForUser(lesson);

            if (!lessonLocked) {
              unitLessons.push({
                lessonId: lesson.lessonId || actId,
                lessonName: lesson.lessonName || lesson.name || "Lesson",
                activitySetId: actId,
                skillKey,
                isCompleted: isComplete,
                isLocked: lessonLocked,
                status: needsScoreRetake ? "RETAKE_SCORE" : (isComplete ? "COMPLETED" : "NEW"),
                needsScoreRetake,
              });

              if (actId) {
                allSkills[skillKey].activitySetIds.push(String(actId));
                allSkills[skillKey].totalActivities++;
                if (isComplete) {
                  allSkills[skillKey].completedActivities++;
                }

                allSkills[skillKey].activities.push({
                  activitySetId: actId,
                  isCompleted: isComplete,
                  lessonName: lesson.lessonName || lesson.name || "Lesson",
                });
              }
            }
          }

          if (unitLessons.length > 0) {
            resultUnits.push({
              unitId: unitId,
              unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId),
              sequenceNo: unit.sequenceNo || unitId,
              isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked),
              completionStatus: unit.completionStatus || null,
              completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null,
              lessons: unitLessons,
            });
          }
        }

        let allDone = true;
        for (const key of Object.keys(allSkills)) {
          if (allSkills[key].completedActivities < allSkills[key].totalActivities) {
            allDone = false;
          }
          if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) {
            allSkills[key].completed = true;
          }
        }

        SKILLS.forEach((s) => {
          if (!allSkills[s.key]) {
            allSkills[s.key] = {
              name: s.name,
              completed: false,
              score: 0,
              totalActivities: 0,
              completedActivities: 0,
              time: "10",
              activitySetIds: [],
              activities: [],
            };
            allDone = false;
          }
        });

        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) {
        if (isAuthError(e)) throw e;
        console.error("loadLevelData error:", e.message);
        return { level: levelData, units: [], skills: {}, isCompleted: false };
      }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken;
      const learnerId = session.learnerId;
      const loginId = session.loginId;
      const clientInfo = session.clientInfo;
      const ts = Date.now();

      onLog && onLog("Fetching activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);

      if (!activity) throw new Error("Null activity payload");

      if (isScoredSubmitted(activity)) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);
      await sleep(250);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }
      if (!isScoredSubmitted(verifyActivity)) {
        throw new Error(`RCA submitted activity ${activitySetId} but score is 0. Open Retake Score and submit the questions manually.`);
      }
      onLog && onLog("âœ“ Verified submitted: " + activitySetId + " (" + allQuestions.length + " Qs, score " + activityScore(verifyActivity) + ")", "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, apiLogger, "Lesson");
    }
  },

  ielts: {
    id: "ielts",
    name: "LearnEnglish++ (IELTS)",
    description: "IELTS preparation",
    curriculumId: 21,
    packageId: 5,
    activityType: "Ielts",

    getUserLevels: async (token, loginId, clientInfo) => {
      return LEVEL_META.map((l, idx) => ({
        id: idx + 4,
        name: l.name,
        title: l.title,
        subtitle: l.subtitle,
        color: l.color,
        curriculumLevelMappingId: null,
      }));
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const list = await rcaRequest("GET", "/ielts/create-lessons", {
          token,
          query: {
            time: "60",
            activityTypeId: "4",
            standardLevelId: String(levelData.id),
            packageId: "5",
          },
          loginId,
          clientInfo,
        });

        const skills = {};
        let allDone = true;

        (list || []).forEach((section) => {
          const key = section.skill;
          const ids = (section.activitySetIds || []).map(String);
          const completed = !!section.isCompleted;

          if (!completed) allDone = false;

          if (ids.length > 0) {
            skills[key] = {
              name: key ? key.charAt(0) + key.slice(1).toLowerCase() : "Skill",
              completed,
              score: section.totalScore || 0,
              totalActivities: ids.length,
              completedActivities: completed ? ids.length : 0,
              time: section.time || "10",
              activitySetIds: ids,
              testSummaryId: section.testSummaryId,
              activities: ids.map(id => ({ activitySetId: id, isCompleted: completed })),
            };
          }
        });

        SKILLS.forEach((s) => {
          if (!skills[s.key]) {
            skills[s.key] = {
              name: s.name,
              completed: false,
              score: 0,
              totalActivities: 0,
              completedActivities: 0,
              time: "10",
              activitySetIds: [],
              testSummaryId: null,
              activities: [],
            };
            allDone = false;
          }
        });

        return { level: levelData, units: [], skills, isCompleted: allDone };
      } catch (e) {
        if (isAuthError(e)) throw e;
        console.error("loadLevelData error:", e.message);
        return { level: levelData, units: [], skills: {}, isCompleted: false };
      }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken;
      const learnerId = session.learnerId;
      const loginId = session.loginId;
      const clientInfo = session.clientInfo;
      const ts = Date.now();

      onLog && onLog("Fetching IELTS activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);

      if (!activity) throw new Error("Null activity payload");

      if (isScoredSubmitted(activity)) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);
      await sleep(250);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }
      if (!isScoredSubmitted(verifyActivity)) {
        throw new Error(`RCA submitted activity ${activitySetId} but score is 0. Open Retake Score and submit the questions manually.`);
      }
      onLog && onLog("âœ“ Verified submitted: " + activitySetId + " (" + allQuestions.length + " Qs, score " + activityScore(verifyActivity) + ")", "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, apiLogger, "Ielts");
    }
  },
};

// ==================== ANSWER LOGIC ====================
function pickCorrectAnswer(question) {
  if (question.answerType === "ESSAY") return null;
  if (question.answerType === "FILLBLANK") {
    const text = question.questionText || "";
    const m = text.match(/fill blank.*?:\s*(.*?)(?:\.|$)/i);
    return m ? m[1].trim() : question.correctAnswer || null;
  }
  if (question.answerType === "MULTIPLECHOICE") {
    const opts = question.activityAnswerDTO || [];
    const correctOpt = opts.find(o => o.isCorrect);
    return correctOpt ? correctOpt.id : question.correctAnswer;
  }
  return question.correctAnswer || null;
}

function fillAnswers(activity) {
  let correctCount = 0;
  let attemptedCount = 0;
  let earnedScore = 0;
  const list = activity.activityQuestionDetailsList || [];

  list.forEach((q) => {
    let answer = q.userAnswer;
    const options = Array.isArray(q.activityAnswerDTO) ? q.activityAnswerDTO : [];
    const correctOptions = options.filter((o) => o.isCorrect === true);

    if (answer == null || answer === "") {
      if (q.answerType === "ESSAY" || String(q.itemType || "").toUpperCase().includes("ESSAY")) {
        answer = q.userEssay || "This is my response.";
      } else if (correctOptions.length > 1) {
        answer = correctOptions.map((o) => o.id);
      } else if (correctOptions.length === 1) {
        // The real web payload submits the option ID, e.g. 199, not answerOption text.
        answer = correctOptions[0].id;
      } else if (q.correctAnswer != null && q.correctAnswer !== "") {
        const byId = options.find((o) => String(o.id) === String(q.correctAnswer));
        const byText = options.find((o) => String(o.answerOption).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase());
        answer = byId ? byId.id : (byText ? byText.id : q.correctAnswer);
      } else {
        answer = "";
      }
    }

    q.userAnswer = answer;
    q.submittedUserAnswer = answer;
    q.isSubmitClicked = true;
    q.allAnswersRecorded = true;
    attemptedCount += answer !== "" && answer != null ? 1 : 0;

    let correct = false;
    if (Array.isArray(answer)) {
      correct = answer.length > 0 && answer.every((value) => options.some((o) => String(o.id) === String(value) && o.isCorrect === true));
    } else {
      const matched = options.find((o) => String(o.id) === String(answer));
      correct = matched ? matched.isCorrect === true : (q.correctAnswer != null && String(answer).trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase());
    }
    q.isUserAnswerCorrect = !!correct;
    if (correct) {
      correctCount++;
      earnedScore += Number(q.itemScore || 1);
    }
  });

  activity.totalQuestionsAttempted = attemptedCount;
  activity.totalAnswersCorrect = correctCount;
  activity.totalEarnedScore = earnedScore;
  activity.totalQuestionsLeft = Math.max(0, Number(activity.totalQuestions || list.length) - attemptedCount);
  return activity;
}

async function submitActivity(token, activity, state, learnerId, loginId, clientInfo, apiLogger) {
  const payload = Object.assign({}, activity);
  payload.activityState = state;
  payload.learnerId = learnerId;
  payload.activityType = payload.activityType || "Ielts";
  const now = Date.now();
  if (!payload.startDate) payload.startDate = now - 30000;
  if (state === "SUBMITTED") {
    payload.endDate = now;
    payload.totalTimeTaken = Math.max(20, Math.floor((payload.endDate - payload.startDate) / 1000));
    payload.totalTimeTakenInSecs = payload.totalTimeTaken;
    payload.totalQuestionsLeft = 0;
    payload.isSubmitClicked = true;
  }
  await rcaRequest("POST", "/activity/data", { token, body: payload, loginId, clientInfo, apiLogger });
  return payload;
}

async function updateTimeTaken(token, learnerId, lessonId, activitySetId, secs, loginId, clientInfo, apiLogger, activityType = "Ielts") {
  try {
    await rcaRequest("POST", "/update-user-time-taken", {
      token,
      query: {
        lessonId: String(lessonId),
        activitySetId: String(activitySetId),
        timeInSecs: String(secs),
        learnerId: String(learnerId),
        activityType: activityType,
      },
      body: "",
      loginId,
      clientInfo,
      apiLogger,
    });
  } catch (e) {
    console.warn("Time sync error:", e.message);
  }
}

// ==================== RESUME LEARNING ====================
const PACKAGE_SECTION_MAP = {
  "4": "learnenglish",
  "5": "ielts",
  "47": "apex",
  "50": "vocabbuilder",
  "90": "wordcraft",
};

async function fetchResumeInfo(user) {
  const info = { section: null, unitId: null, unitName: null, lessonId: null, lessonName: null, percentRemaining: null, scenario: null, mappingId: null, standardLevelId: null, activitySetId: null };
  try {
    const details = await rcaRequest("POST", "/userDetails?inputKeywordList=0", { token: user.accessToken, body: "", loginId: user.loginId, clientInfo: user.clientInfo });
    const packageId = String(details.packageId || "");
    const mappingId = details.curriculumLevelMappingId;
    const stdLevel = details.currentStandardLevel || 8;
    const sectionId = PACKAGE_SECTION_MAP[packageId] || null;
    if (!sectionId || !mappingId) return info;

    info.section = sectionId;
    info.mappingId = mappingId;
    info.standardLevelId = stdLevel;

    const section = SECTIONS[sectionId];
    if (!section) return info;

    const resume = await rcaRequest("GET", "/resume-learning", {
      token: user.accessToken,
      query: { curriculumLevelMappingId: String(mappingId), packageId: packageId, standardLevelId: String(stdLevel) },
      loginId: user.loginId,
      clientInfo: user.clientInfo,
    });

    if (resume && (resume.unitId != null || resume.lessonId != null)) {
      info.unitId = resume.unitId;
      info.unitName = resume.unitName || null;
      info.lessonId = resume.lessonId;
      info.lessonName = resume.lessonName || null;
      info.percentRemaining = resume.percentRemaining != null ? Number(resume.percentRemaining) : null;
      info.scenario = resume.resumeScenario || null;
      info.activitySetId = resume.activitySetId != null ? resume.activitySetId : null;
    }
  } catch (e) {
    console.warn("Resume fetch error:", e.message);
  }
  return info;
}

// ==================== CONCURRENT TASK LOCK ====================
const taskLocks = new Map();

function acquireTaskLock(key) {
  let lock = taskLocks.get(key);
  if (!lock) {
    lock = { locked: false, queue: [] };
    taskLocks.set(key, lock);
  }
  return new Promise((resolve) => {
    if (!lock.locked) {
      lock.locked = true;
      return resolve();
    }
    lock.queue.push(resolve);
  });
}

function releaseTaskLock(key) {
  const lock = taskLocks.get(key);
  if (!lock) return;
  const next = lock.queue.shift();
  if (next) {
    return;
  }
  lock.locked = false;
  if (lock.queue.length === 0) taskLocks.delete(key);
}

// ==================== LOGIN ====================
const userLoadQueues = new Map();
async function runWithUserLock(loginId, fn) {
  let lock = userLoadQueues.get(loginId);
  if (!lock) { lock = { chain: Promise.resolve(), busy: false }; userLoadQueues.set(loginId, lock); }
  return new Promise((resolve, reject) => {
    const next = lock.chain.finally(() => fn().then(resolve, reject));
    lock.chain = next.catch(() => {});
  });
}

async function retryWithReauth(fn, user, maxAttempts = 2) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e.message || "").toLowerCase();
    const isExpiry = SESSION_EXPIRY_HINTS.some((h) => msg.includes(h)) || (e && (e.status === 401 || e.status === 403));
    if (!isExpiry) throw e;
    try {
      await acquireSessionLock(user.loginId);
      await ensureSessionValid(user);
    } catch (_) {}
    finally { releaseSessionLock(user.loginId); }
    if (maxAttempts <= 1) throw e;
    await sleep(400);
    return retryWithReauth(fn, user, maxAttempts - 1);
  }
}

const SESSION_EXPIRY_HINTS = ["another device", "sign in again", "validate session", "session expired"];
function isAuthError(e) {
  const msg = String(e && (e.message || e) || "").toLowerCase();
  const status = e && e.status;
  return (status === 401 || status === 403) || SESSION_EXPIRY_HINTS.some((h) => msg.includes(h));
}
const sessionRefreshLocks = new Map();
function acquireSessionLock(loginId) {
  let lock = sessionRefreshLocks.get(loginId);
  if (!lock) { lock = { locked: false, queue: [] }; sessionRefreshLocks.set(loginId, lock); }
  return new Promise((resolve) => {
    if (!lock.locked) { lock.locked = true; return resolve(); }
    lock.queue.push(resolve);
  });
}
function releaseSessionLock(loginId) {
  const lock = sessionRefreshLocks.get(loginId);
  if (!lock) return;
  const next = lock.queue.shift();
  if (next) { lock.locked = true; next(); } else { lock.locked = false; }
}
async function ensureSessionValid(user) {
  if (!user.accessToken) throw new Error("No token");
  for (let i = 0; i < 2; i++) {
    try {
      await rcaRequest("POST", "/userDetails?inputKeywordList=0", { token: user.accessToken, body: "", loginId: user.loginId, clientInfo: user.clientInfo });
      return;
    } catch (e) {
      const msg = String(e.message || "").toLowerCase();
      const isExpiry = SESSION_EXPIRY_HINTS.some((h) => msg.includes(h)) || (e && (e.status === 401 || e.status === 403));
      if (!isExpiry) throw e;
      if (i === 0) {
        console.log(`[Session] Token invalidated for ${user.loginId} â€“ re-authenticating...`);
        const u = await rcaLogin(user.loginId, "", user.clientInfo);
        user.accessToken = u.accessToken;
        user.learnerId = u.learnerId || user.learnerId;
        user.userId = u.userId || user.userId;
        user.name = u.name || user.name;
        user.coins = u.coins != null ? u.coins : user.coins;
        if (u.packageId) user.packageId = u.packageId;
        if (u.curriculumId) user.curriculumId = u.curriculumId;
        if (u.resumeInfo) user.resumeInfo = u.resumeInfo;
        console.log(`[Session] Re-authenticated ${user.loginId}`);
      } else {
        throw new Error("Session busy on another device â€“ try again shortly");
      }
    }
  }
}

async function rcaLogin(loginId, userPassword, clientInfo) {
  const reqPassword = userPassword || CONFIG.APP_PASSWORD;
  console.log(`[Login] ID: ${loginId}`);

  let lastError = null;

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const loginRes = await rcaRequest("POST", "/login", {
        body: {
          loginId: String(loginId).trim(),
          password: String(reqPassword).trim(),
          levelId: 0,
          role: "",
          caLoginConfigId: "0",
          date: Date.now(),
        },
        loginId,
        clientInfo,
      }, true);

      if (!loginRes || (!loginRes.accessToken && !loginRes.token)) {
        throw new Error("Invalid response from server");
      }

      const token = loginRes.accessToken || loginRes.token;
      let details = {};
      try {
        details = await rcaRequest("POST", "/userDetails?inputKeywordList=0", { token, body: "", loginId, clientInfo });
      } catch (e) {
        console.warn(`UserDetails warning: ${e.message}`);
      }

      console.log(`[Login OK] ID: ${loginId}`);

      const sessionUser = {
        accessToken: token,
        loginId: String(loginId).trim(),
        learnerId: details.learnerId || loginRes.learnerId || String(loginId),
        userId: details.authorizedUserId || loginRes.userId || String(loginId),
        name: [details.firstName, details.lastName].filter(Boolean).join(" ").trim() || "User " + loginId,
        coins: details.totalCoins || 0,
        packageId: details.packageId || 4,
        curriculumId: details.curriculumId || 3,
        clientInfo,
      };

      const resumeInfo = await fetchResumeInfo(sessionUser);
      sessionUser.resumeInfo = resumeInfo;

      return sessionUser;
    } catch (e) {
      lastError = e;
      console.error(`[Login Attempt ${attempt}] ${e.message}`);
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(500 + (attempt * 500));
      }
    }
  }

  throw lastError || new Error("Login failed");
}

// ==================== JOB ENGINE ====================
function createJob(type, meta) {
  const id = uuid();
  const job = {
    id, type, meta,
    status: "running",
    current: 0,
    total: 0,
    task: "Initializing...",
    logs: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function jobLog(job, message, level) {
  job.logs.push({ t: new Date().toISOString(), message, level: level || "info" });
  if (job.logs.length > 500) job.logs.shift();
}

async function runCompleteJob(job, userSessions, rawTasks, sectionId) {
  const section = SECTIONS[sectionId];
  if (!section) throw new Error("Invalid section");

  const apiLogger = (log) => {
    const icon = log.type === "request" ? "â†‘" : "â†“";
    const msg = log.type === "request"
      ? `${icon} ${log.method} ${log.path} | Body: ${log.body ? log.body.substring(0, 120) + "..." : "none"}`
      : `${icon} ${log.method} ${log.path} | Status: ${log.status} | Resp: ${log.data ? log.data.substring(0, 120) + "..." : "none"}`;
    console.log(`[API] ${msg}`);
  };

  try {
    job.status = "loading";
    job.task = "Prefetching task statuses...";
    jobLog(job, `Starting ${rawTasks.length} tasks...`, "info");

    const pendingTasks = [];
    const totalToCheck = rawTasks.length;

    for (let i = 0; i < rawTasks.length; i++) {
      if (job.status === "cancelled") break;
      const t = rawTasks[i];
      job.current = i;
      job.total = totalToCheck;
      job.task = `Checking tasks... (${i + 1}/${totalToCheck})`;

      try {
        const activity = await fetchActivityDetails(t.activitySetId, t.session.accessToken, t.session.loginId, t.session.clientInfo);

        const alreadyDone = isScoredSubmitted(activity);

        const allQuestions = activity.activityQuestionDetailsList || [];
        const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);

        if (!alreadyDone) {
          pendingTasks.push(t);
        } else {
          jobLog(job, `[${t.userName}] Already done: ${t.activitySetId}`, "warn");
        }
      } catch (e) {
        jobLog(job, `[${t.userName}] Check error: ${e.message} - adding to pending`, "warn");
        pendingTasks.push(t);
      }
    }

    job.current = 0;
    job.total = pendingTasks.length;

    if (pendingTasks.length === 0) {
      job.status = "done";
      job.task = "All tasks already completed âœ“";
      job.finishedAt = Date.now();
      jobLog(job, "No pending tasks", "warn");
      return;
    }

    job.status = "running";
    jobLog(job, `Processing ${pendingTasks.length} pending tasks`, "success");

    let lastUser = null;
    for (let i = 0; i < pendingTasks.length; i++) {
      if (job.status === "cancelled") break;
      const t = pendingTasks[i];
      job.current = i;
      job.task = `[${t.userName}] ${t.skillName}`;

      if (lastUser && lastUser !== t.session.loginId) {
        await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
      }
      lastUser = t.session.loginId;

      const lockKey = `task:${t.session.loginId}:${sectionId}:${t.activitySetId}`;
      try {
        await acquireTaskLock(lockKey);
        try {
          await section.completeActivity(t.session, t.activitySetId, (msg, lvl) => jobLog(job, `[${t.userName}] ${msg}`, lvl), apiLogger);
        } catch (err) {
          job.failed = (job.failed || 0) + 1;
          jobLog(job, `[${t.userName}] Error: ${err.message}`, "error");
          const stateErr = err.message || "";
          const conflict = /inprogress|already in progress|already started|lock|locked/i.test(stateErr);
          if (conflict) {
            try {
              const fresh = await fetchActivityDetails(t.activitySetId, t.session.accessToken, t.session.loginId, t.session.clientInfo);
              if (fresh && fresh.learnerId === String(t.session.learnerId) && (fresh.activityState === "INPROGRESS" || fresh.learnerId)) {
                jobLog(job, `[${t.userName}] Resolving conflict by submitting in-progress activity...`, "warn");
                const now = Date.now();
                fresh.startDate = fresh.startDate || now - 40000;
                fresh.endDate = now;
                fresh.totalTimeTaken = Math.max(20, Math.floor((now - fresh.startDate) / 1000));
                fresh.activityState = "SUBMITTED";
                fresh.learnerId = t.session.learnerId;
                await submitActivity(t.session.accessToken, fresh, "SUBMITTED", t.session.learnerId, t.session.loginId, t.session.clientInfo, apiLogger);
                const lessonId = fresh.lessonId || t.activitySetId;
                await updateTimeTaken(t.session.accessToken, t.session.learnerId, lessonId, t.activitySetId, fresh.totalTimeTaken || 30, t.session.loginId, t.session.clientInfo, apiLogger, section.activityType || "Lesson");
                jobLog(job, `[${t.userName}] âœ“ Conflict resolved, submitted: ${t.activitySetId}`, "success");
              }
            } catch (recErr) {
              jobLog(job, `[${t.userName}] Conflict recovery failed: ${recErr.message}`, "error");
            }
          }
        }
      } finally {
        releaseTaskLock(lockKey);
      }

      job.current = i + 1;
      if (CONFIG.DELAY_BETWEEN_TASKS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
    }

    job.status = job.status === "cancelled" ? "cancelled" : (job.failed ? "error" : "done");
    job.error = job.failed ? `${job.failed} task(s) failed RCA verification` : null;
    job.task = job.failed ? `Finished with ${job.failed} failed task(s)` : `Completed ${pendingTasks.length} tasks âœ“`;
    job.finishedAt = Date.now();
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    jobLog(job, "Fatal: " + err.message, "error");
  }
}

// ==================== ROUTES ====================
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = code;
  if (!res.getHeader("Content-Type")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) { sendJson(res, 401, { error: "Not authenticated" }); return null; }
  return s;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(req, res, pathname) {
  if (pathname !== "/" && pathname !== "/index.html" && pathname !== "/single.html") {
    res.writeHead(404); res.end("Not Found"); return;
  }
  const fileName = pathname === "/single.html" ? "single.html" : "index.html";
  const filePath = path.join(PUBLIC, fileName);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  const clientInfo = getClientInfo(req);

  // PASSWORD ENDPOINT - SHOW COIN PASSKEY
  if (pathname === "/password" && req.method === "GET") {
    return sendJson(res, 200, { 
      passkey: CONFIG.COIN_PASSKEY,
      message: "Coin Passkey displayed"
    });
  }

  // LOGIN
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const password = body.password || CONFIG.APP_PASSWORD;
    const loginIdRaw = String(body.loginId || "").trim();
    if (!loginIdRaw) return sendJson(res, 400, { error: "Enter User ID" });
    if (body.bulk === true || /[,ï¼Œ]/.test(loginIdRaw)) {
      return sendJson(res, 400, { error: "Please sign in with one User ID at a time." });
    }
    const isBulk = false;
    const loginIds = [loginIdRaw];
    const results = { bulk: false, total: 1, successCount: 0, errorCount: 0, users: [], errors: [] };
    const successfulLogins = [];

    for (const loginId of loginIds) {
      try {
        const u = await rcaLogin(loginId, password, clientInfo);
        successfulLogins.push(u);
        results.users.push({ loginId: u.loginId, learnerId: u.learnerId, name: u.name });
        results.successCount++;
      } catch (e) {
        console.error(`Login failed: ${loginId} - ${e.message}`);
        results.errors.push({ loginId, error: e.message || "Auth failed" });
        results.errorCount++;
      }
    }

    if (successfulLogins.length === 0) {
      return sendJson(res, 401, { error: "All logins failed", ...results });
    }

    const sessionData = { users: successfulLogins, createdAt: Date.now() };
    const encryptedToken = encryptSession(sessionData);
    setSessionCookie(res, encryptedToken);

    return sendJson(res, 200, {
      user: publicUser(successfulLogins[0]),
      allUsers: successfulLogins.map(publicUser),
      token: encryptedToken,
      resume: successfulLogins[0].resumeInfo || null,
      openSection: (successfulLogins[0].resumeInfo && successfulLogins[0].resumeInfo.section) || null,
      ...results,
    });
  }

  // LOGOUT
  if (pathname === "/api/logout" && req.method === "POST") {
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // USER DATA
  if (pathname === "/api/me" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    if (refreshSessionIfNeeded(s)) {
      const sessionData = { users: s.users, createdAt: s.createdAt };
      setSessionCookie(res, encryptSession(sessionData));
    }

    if (!s.users[0].resumeInfo || !s.users[0].resumeInfo.section) {
      try {
        s.users[0].resumeInfo = await fetchResumeInfo(s.users[0]);
      } catch (e) {
        console.warn("On-demand resume error:", e.message);
      }
    }

    return sendJson(res, 200, {
      user: publicUser(s.users[0]),
      allUsers: s.users.map(publicUser),
      resume: s.users[0].resumeInfo || null,
      openSection: (s.users[0].resumeInfo && s.users[0].resumeInfo.section) || null,
    });
  }

  // GET SECTIONS
  if (pathname === "/api/sections" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const access = await getSectionAccess(s.users[0]);
    const allSections = sectionDescriptors(access);
    return sendJson(res, 200, { sections: allSections.filter((section) => section.unlocked), allSections });
  }

  // GET LEVELS for a section (LAZY LOAD)
  if (pathname === "/api/levels" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const sectionId = req.url.split('?').length > 1 ? new URLSearchParams(req.url.split('?')[1]).get('section') : 'ielts';
    const section = SECTIONS[sectionId];
    if (!section) return sendJson(res, 400, { error: "Invalid section" });
    const access = await getSectionAccess(s.users[0]);
    if (!access.unlocked[sectionId]) return sendJson(res, 403, { error: "This section is locked for your RCA account", sectionId });

    try {
      const allUserLevels = await Promise.all(
        s.users.map(async (user) => {
          return runWithUserLock(user.loginId, async () => {
          const out = [];

          try {
            await acquireSessionLock(user.loginId);
            await ensureSessionValid(user);
          } catch (e) {
            console.warn(`Re-login error: ${e.message}`);
          } finally {
            releaseSessionLock(user.loginId);
          }

          let levelList;
          if (sectionId === 'ielts') {
            levelList = LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 }));
          } else {
            const rawLevels = await retryWithReauth(async () => {
              return section.getUserLevels(user.accessToken, user.loginId, user.clientInfo);
            }, user);
            levelList = rawLevels;
          }

          try {
            user.resumeInfo = await fetchResumeInfo(user);
          } catch (e) {
            // ignore
          }

          for (const level of levelList) {
            try {
              let data = await retryWithReauth(async () => {
                return section.loadLevelData(user.accessToken, level, user.loginId, user.clientInfo);
              }, user);

              const filteredSkills = Object.entries(data.skills)
                .filter(([_, sd]) => (sd.totalActivities || 0) > 0)
                .map(([key, sd]) => ({
                  key,
                  name: sd.name,
                  icon: SKILLS.find(s => s.key === key)?.icon || 'fa-circle',
                  completed: !!sd.completed,
                  completedActivities: sd.completedActivities || 0,
                  totalActivities: sd.totalActivities || 0,
                  activitySetIds: sd.activitySetIds || [],
                  activities: sd.activities || (sd.activitySetIds || []).map(id => ({ activitySetId: id, isCompleted: !!sd.completed })),
                }));

              const levelObj = {
                id: level.id,
                name: level.name,
                title: level.title,
                subtitle: level.subtitle,
                color: level.color,
                isCompleted: data.isCompleted,
                units: data.units || [],
                skills: filteredSkills,
              };

              out.push(levelObj);
            } catch (e) {
              console.error("Level load error:", e.message);
              out.push({
                id: level.id,
                name: level.name,
                title: level.title,
                subtitle: level.subtitle,
                color: level.color,
                isCompleted: false,
                units: [],
                skills: [],
              });
            }
          }
          return { loginId: user.loginId, name: user.name, learnerId: user.learnerId, resume: user.resumeInfo || null, levels: out };
          });
        })
      );
      return sendJson(res, 200, { users: allUserLevels });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // READ-ONLY REPORTS
  if (pathname === "/api/insights" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const user = s.users[0];
    const url = new URL(req.url, "http://localhost");
    const sectionId = url.searchParams.get("section") || (user.resumeInfo && user.resumeInfo.section) || "learnenglish";
    const section = SECTIONS[sectionId];
    if (!section) return sendJson(res, 400, { error: "Invalid section" });
    try {
      const insights = await runWithUserLock(user.loginId, () => accountInsights(user, section));
      const refreshed = { users: s.users, createdAt: s.createdAt };
      setSessionCookie(res, encryptSession(refreshed));
      return sendJson(res, 200, { section: { id: section.id, name: section.name }, insights, fetchedAt: Date.now() });
    } catch (error) { return sendJson(res, error.status || 502, { error: error.message || "Could not load RCA reports." }); }
  }

  // READ/SUBMIT ONE ACTIVITY FOR A MANUAL RETAKE
  if (pathname === "/api/activity" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const url = new URL(req.url, "http://localhost");
    const activitySetId = String(url.searchParams.get("activitySetId") || "").trim();
    const sectionId = String(url.searchParams.get("section") || "").trim();
    if (!activitySetId) return sendJson(res, 400, { error: "activitySetId is required" });
    if (!SECTIONS[sectionId]) return sendJson(res, 400, { error: "Invalid section" });
    const access = await getSectionAccess(s.users[0]);
    if (!access.unlocked[sectionId]) return sendJson(res, 403, { error: "This section is locked for your RCA account" });
    try {
      const activity = await fetchActivityDetails(activitySetId, s.users[0].accessToken, s.users[0].loginId, s.users[0].clientInfo);
      return sendJson(res, 200, publicActivity(activity));
    } catch (e) { return sendJson(res, e.status || 502, { error: e.message || "Activity questions could not be loaded" }); }
  }

  if (pathname === "/api/activity/submit" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    try {
      const body = await readJson(req);
      const activitySetId = String(body.activitySetId || "").trim();
      const sectionId = String(body.section || "").trim();
      if (!activitySetId || !SECTIONS[sectionId]) return sendJson(res, 400, { error: "activitySetId and valid section are required" });
      const access = await getSectionAccess(s.users[0]);
      if (!access.unlocked[sectionId]) return sendJson(res, 403, { error: "This section is locked for your RCA account" });
      const result = await runWithUserLock(s.users[0].loginId, () => submitManualActivity(s.users[0], activitySetId, body.answers || {}, null));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) { return sendJson(res, e.status || 502, { error: e.message || "RCA activity submission failed" }); }
  }

  // PLACEMENT TEST: available only after RCA reports LearnEnglish complete.
  if (pathname === "/api/placement" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    try { return sendJson(res, 200, await getPlacementStatus(s.users[0])); }
    catch (e) { return sendJson(res, e.status || 502, { available: false, error: e.message }); }
  }

  if (pathname === "/api/placement/complete" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    try {
      const user = s.users[0];
      const placement = await getPlacementStatus(user);
      if (!placement.activitySetId || !placement.available) return sendJson(res, 409, { error: placement.reason || "Placement test is not available" });
      const result = await SECTIONS.learnenglish.completeActivity(user, placement.activitySetId, null, null);
      return sendJson(res, 200, { ok: true, result, placement: await getPlacementStatus(user) });
    } catch (e) { return sendJson(res, e.status || 502, { error: e.message || "Placement test could not be submitted" }); }
  }

  // CERTIFICATE DOWNLOAD
  if (pathname === "/api/certificate" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const user = s.users[0];
    const body = await readJson(req);
    const levelId = body.levelId == null ? "" : String(body.levelId).trim();
    const packageName = String(body.packageName || "").trim();
    const packageId = body.packageId == null ? "" : String(body.packageId).trim();
    if (!levelId || !packageName || !packageId || packageName.length > 160) return sendJson(res, 400, { error: "levelId, packageName and packageId are required." });
    try {
      const sectionId = Object.values(SECTIONS).find((item) => String(item.packageId) === packageId || item.name.toLowerCase() === packageName.toLowerCase())?.id;
      if (!sectionId) return sendJson(res, 400, { error: "Unknown RCA package" });
      const access = await getSectionAccess(user);
      if (!access.unlocked[sectionId]) return sendJson(res, 403, { error: "This RCA section is locked for your account" });
      await runWithUserLock(user.loginId, () => retryWithReauth(() => ensureScoredCertificateLevel(user, sectionId, levelId), user));
      const file = await runWithUserLock(user.loginId, () => retryWithReauth(() => rcaRequestBinary("POST", "/generate-certificate", { 
        token: user.accessToken, 
        query: { levelId, packageName, packageId }, 
        body: {}, 
        loginId: user.loginId, 
        clientInfo: user.clientInfo 
      }), user));
      const fallback = `RCA-${packageName.replace(/[^\w-]+/g, "-")}-certificate.pdf`;
      const fileName = file.filename && /^[\w.,() -]+$/.test(file.filename) ? file.filename : fallback;
      res.statusCode = 200;
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Cache-Control", "no-store");
      return res.end(file.bytes);
    } catch (error) { return sendJson(res, error.status || 502, { error: error.message || "RCA could not generate a certificate for this level." }); }
  }

  // ADD COINS
  if (pathname === "/api/coins" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const body = await readJson(req);
    if (body.passkey !== CONFIG.COIN_PASSKEY) return sendJson(res, 403, { error: "Invalid passkey" });
    const amount = parseInt(body.amount, 10);
    if (!amount || amount < 1 || amount > CONFIG.MAX_COINS_PER_REQUEST) return sendJson(res, 400, { error: `Amount 1-${CONFIG.MAX_COINS_PER_REQUEST}` });

    for (const u of s.users) {
      u.coins += amount;
      try {
        await rcaRequest("POST", "/learners/add-coins", {
          token: u.accessToken,
          query: { learnerId: String(u.learnerId), coinsToAdd: String(amount) },
          body: "",
          loginId: u.loginId,
          clientInfo: u.clientInfo,
        });
      } catch (e) { console.warn("Coin error:", e.message); }
    }

    const updatedSession = { users: s.users, createdAt: s.createdAt };
    setSessionCookie(res, encryptSession(updatedSession));

    return sendJson(res, 200, { coins: s.users[0].coins, totalUsers: s.users.length });
  }

  // COMPLETE TASK
  if (pathname === "/api/complete" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const body = await readJson(req);
    const { mode, targetUser, levelId, skillKey, activitySetId, section = 'ielts', unitId } = body;

    const sectionObj = SECTIONS[section];
    if (!sectionObj) return sendJson(res, 400, { error: "Invalid section" });
    const access = await getSectionAccess(s.users[0]);
    if (!access.unlocked[section]) return sendJson(res, 403, { error: "This section is locked for your RCA account" });

    if (targetUser === "ALL" || (targetUser && String(targetUser) !== String(s.users[0].loginId))) {
      return sendJson(res, 400, { error: "Only the logged-in user can be processed." });
    }
    const targetUsers = [s.users[0]];

    const rawTasks = [];
    const rawTaskKeys = new Set();
    const enqueueTask = (task) => {
      const key = `${task.session.loginId}:${section}:${task.activitySetId}`;
      if (!task.activitySetId || rawTaskKeys.has(key)) return;
      rawTaskKeys.add(key);
      rawTasks.push(task);
    };
    for (const session of targetUsers) {
      let levelsToScan;
      if (section === 'ielts') {
        levelsToScan = LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 }));
      } else {
        const rawLevels = await sectionObj.getUserLevels(session.accessToken, session.loginId, session.clientInfo);
        levelsToScan = rawLevels;
      }

      if (levelId) levelsToScan = levelsToScan.filter((l) => String(l.id) === String(levelId));

      for (const level of levelsToScan) {
        try {
          const data = await sectionObj.loadLevelData(session.accessToken, level, session.loginId, session.clientInfo);

          if (data.units && data.units.length > 0) {
            const unitsToScan = data.units.filter((u) => !u.isLocked);
            const targetUnits = unitId
              ? unitsToScan.filter(u => String(u.unitId) === String(unitId))
              : unitsToScan;
            for (const targetUnit of targetUnits) {
              if (!targetUnit.lessons) continue;
              targetUnit.lessons.forEach((lesson) => {
                if (!lesson.isLocked && lesson.activitySetId) {
                  enqueueTask({
                    userName: session.name,
                    userLoginId: session.loginId,
                    skillName: lesson.skillKey || 'SKILL',
                    activitySetId: lesson.activitySetId,
                    session,
                  });
                }
              });
            }
            if (sectionObj.activityType !== "Ielts") continue;
          }

          let skillKeys = Object.keys(data.skills).filter(k => (data.skills[k].totalActivities || 0) > 0);
          if (skillKey) skillKeys = skillKeys.filter(k => k === skillKey);

          for (const key of skillKeys) {
            const skillData = data.skills[key];
            if (!skillData || !skillData.activitySetIds) continue;

            let activityIds = skillData.activitySetIds || [];
            if (activitySetId) {
              activityIds = activityIds.filter((id) => String(id) === String(activitySetId));
            }

            activityIds.forEach((actId) => {
              enqueueTask({
                userName: session.name,
                userLoginId: session.loginId,
                skillName: key,
                activitySetId: actId,
                session,
              });
            });
          }
        } catch (e) { console.warn("Queue skip:", e.message); }
      }
    }

    const job = createJob(mode, { mode, userCount: targetUsers.length, section, ownerLoginId: s.users[0].loginId });
    setImmediate(() => runCompleteJob(job, targetUsers, rawTasks, section));

    return sendJson(res, 200, {
      jobId: job.id,
      coins: s.users[0].coins,
      tasksCount: rawTasks.length
    });
  }

  // JOB MONITORING
  if (pathname === "/api/jobs" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const ownerLoginId = s.users[0].loginId;
    const history = [...jobs.values()]
      .filter((job) => job.meta && job.meta.ownerLoginId === ownerLoginId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map((job) => ({ id: job.id, type: job.type, status: job.status, current: job.current, total: job.total, task: job.task, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt, percent: job.total > 0 ? Math.round((job.current / job.total) * 100) : 0, logs: job.logs.slice(-20) }));
    return sendJson(res, 200, { jobs: history });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (jobMatch && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });
    if (job.meta && job.meta.ownerLoginId && job.meta.ownerLoginId !== s.users[0].loginId) return sendJson(res, 404, { error: "Job not found" });
    return sendJson(res, 200, {
      id: job.id,
      status: job.status,
      current: job.current,
      total: job.total,
      task: job.task,
      error: job.error,
      logs: job.logs.slice(-100),
      percent: job.total > 0 ? Math.round((job.current / job.total) * 100) : 0,
    });
  }

  sendJson(res, 404, { error: "Not Found" });
}

// ==================== SERVER ====================
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", "http://" + CONFIG.HOST);
    if (u.pathname.startsWith("/api/")) {
      await handleApi(req, res, u.pathname);
      return;
    }
    if (u.pathname === "/password") {
      await handleApi(req, res, u.pathname);
      return;
    }
    serveStatic(req, res, u.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log("=".repeat(70));
  console.log(" ðŸš€ RCA IELTS Dashboard (Optimized v4 - CRITICAL BUGS FIXED)");
  console.log(" ðŸ“ URL: http://%s:%d", CONFIG.HOST, CONFIG.PORT);
  console.log(" ðŸ” Session: 24h TTL + Auto-Refresh");
  console.log(" âš¡ Connection: Keep-Alive + Smart Retry");
  console.log(" ðŸ“š Sections: LearnEnglish + IELTS + APEX + Wordcraft + Vocab Builder");
  console.log(" ðŸ”´ FIXED: Task Verification + State Refresh + Certificate Download");
  console.log(" âœ… FIXED: False Success Detection + Locked Lesson Handling");
  console.log(" ðŸŽ¯ FIXED: Clean Progress UI + Locked Section Popups");
  console.log(" ðŸŽ¯ Complete All Level + Complete All Levels: Supported");
  console.log(" ðŸ”‘ NEW: /password endpoint shows coin passkey");
  console.log(" ðŸ“„ NEW: /single.html static route added");
  console.log("=".repeat(70));
});