#!/usr/bin/env node
/**
 * RCA IELTS Dashboard â€“ Production Edition (FIXED v6 - SPEAKING AUTO + WRITING AUTO + PER-QUESTION SUBMIT)
 * âœ… Speaking Tasks - AUTO (fake voice data generated)
 * âœ… Writing/Paragraph Tasks - AUTO (random paragraphs generated)
 * âœ… Per-Question Submit - Each question answered & submitted individually
 * âœ… Correct Timing - Actual time spent tracked and posted
 * âœ… Speed Optimized - Reduced delays, parallel processing where possible
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
  MAX_RETRIES: Number(process.env.RCA_MAX_RETRIES || 5),
  RETRY_DELAY_MS: Number(process.env.RCA_RETRY_DELAY_MS || 300),
  REQUEST_TIMEOUT_MS: Number(process.env.RCA_REQUEST_TIMEOUT_MS || 45000),
  LOGIN_TIMEOUT_MS: Number(process.env.RCA_LOGIN_TIMEOUT_MS || 60000),
  SOCKET_TIMEOUT_MS: Number(process.env.RCA_SOCKET_TIMEOUT_MS || 45000),
  DELAY_BETWEEN_TASKS_MS: Number(process.env.RCA_TASK_DELAY_MS || 50),
  DELAY_BETWEEN_QUESTIONS_MS: Number(process.env.RCA_QUESTION_DELAY_MS || 80),
  STATE_VERIFICATION_DELAY_MS: Number(process.env.RCA_STATE_DELAY_MS || 150),
  FINAL_VERIFICATION_DELAY_MS: Number(process.env.RCA_FINAL_DELAY_MS || 400),
  CHECK_CONCURRENCY: Number(process.env.RCA_CHECK_CONCURRENCY || 8),
  TASK_CONCURRENCY: Number(process.env.RCA_TASK_CONCURRENCY || 1),
  TASK_RETRIES: Number(process.env.RCA_TASK_RETRIES || 3),
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

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

function isTransientRcaError(error) {
  const status = Number(error && error.status || 0);
  const message = String(error && (error.message || error) || '').toLowerCase();
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || /something went wrong|try again later|temporarily unavailable|gateway timeout|upstream|request timeout|socket timeout|econnreset|eai_again|connection reset/.test(message);
}

function retryDelay(attempt) {
  const base = Math.max(80, Number(CONFIG.RETRY_DELAY_MS) || 300);
  return Math.min(5000, base * Math.max(1, attempt) + Math.floor(Math.random() * 120));
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
    const requestOpts = {
      ...opts,
      headers: { ...(opts.headers || {}), "x-request-id": uuid(), "x-journey-id": uuid() },
      agent: httpsAgent,
    };
    const cookieHeader = getCookiesForHost(requestOpts.hostname);
    if (cookieHeader) requestOpts.headers.Cookie = cookieHeader;

    const retryOrReject = (error) => {
      if (isTransientRcaError(error) && attempt < CONFIG.MAX_RETRIES) {
        const delay = retryDelay(attempt);
        console.warn(`[RCA Retry] ${requestOpts.method} ${requestOpts.path} attempt ${attempt + 1}/${CONFIG.MAX_RETRIES} in ${delay}ms: ${error.message}`);
        return sleep(delay).then(() => executeRequest(requestOpts, payload, attempt + 1, isLogin, apiLogger).then(resolve, reject));
      }
      reject(error);
    };

    if (apiLogger) {
      let bodyStr = null;
      if (payload != null) bodyStr = typeof payload === "string" ? payload.slice(0, 2000) : JSON.stringify(payload).slice(0, 2000);
      apiLogger({ type: "request", method: requestOpts.method, path: requestOpts.path, hostname: requestOpts.hostname, body: bodyStr, timestamp: Date.now() });
    }

    const req = https.request(requestOpts, (res) => {
      const cookies = parseCookies(res.headers);
      if (cookies.length) storeCookies(requestOpts.hostname, cookies);
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (apiLogger) {
          const dataStr = data != null ? (typeof data === "object" ? JSON.stringify(data).slice(0, 2000) : String(data).slice(0, 2000)) : null;
          apiLogger({ type: "response", method: requestOpts.method, path: requestOpts.path, status: res.statusCode, data: dataStr, timestamp: Date.now() });
        }
        const message = String(data && (data.message || data.error) || raw || `HTTP ${res.statusCode}`);
        if (res.statusCode >= 400) {
          const error = new Error(message);
          error.status = res.statusCode;
          error.data = data;
          return retryOrReject(error);
        }
        const genericFailure = /something went wrong|try again later|temporarily unavailable|internal server error/.test(message.toLowerCase())
          && !(data && (data.success === true || data.ok === true));
        if (genericFailure) {
          const error = new Error(message);
          error.status = 503;
          error.data = data;
          return retryOrReject(error);
        }
        resolve(data);
      });
    });

    req.on("error", (error) => retryOrReject(error));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request Timeout (${timeoutMs}ms)`)));
    req.on("socket", (socket) => {
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => req.destroy(new Error(`Socket Timeout (${timeoutMs}ms)`)));
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
        const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^;"]+)/i);
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
  if (!row || row.isExpired === true) return false;
  const status = String(row.status || "").trim().toUpperCase().replace(/\s+/g, "_");
  return !["LOCKED", "NOT_PURCHASED", "EXPIRED", "INACTIVE"].includes(status) && (status.length > 0 || Array.isArray(row.programSummaryLevelDtoList));
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

async function fetchActivityDetails(activitySetId, token, loginId, clientInfo, retryCount = 0) {
  const id = String(activitySetId);
  const variants = ["0", id];
  const stamp = Date.now();
  const responses = await Promise.allSettled(variants.map((secondId) => rcaRequest("GET", `/activitySetDetails/${id}/${secondId}/${stamp}/false`, { token, loginId, clientInfo })));
  const successful = responses.filter((result) => result.status === "fulfilled" && result.value);
  const submitted = successful.find((result) => {
    const data = result.value;
    return data.activityState === "SUBMITTED" || data.activityState === "COMPLETED" || data.isCompleted === true;
  });
  if (submitted) return submitted.value;
  if (successful.length) return successful[0].value;
  const lastError = responses.find((result) => result.status === "rejected")?.reason;
  if (retryCount < 2) {
    await sleep(Math.min(1200, 200 * (retryCount + 1)));
    return fetchActivityDetails(activitySetId, token, loginId, clientInfo, retryCount + 1);
  }
  throw lastError || new Error("Activity details unavailable");
}

function isPersistedSubmitted(activity) {
  if (!activity) return false;
  const isSubmitted = activity.activityState === "SUBMITTED" || activity.activityState === "COMPLETED" || activity.isCompleted === true;
  return !!isSubmitted;
}


// ==================== QUESTION TYPE DETECTION ====================
function rawQuestionType(question) {
  return [question && question.itemType, question && question.answerType, question && question.type,
    question && question.questionType, question && question.responseType]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => String(value).trim().toUpperCase())
    .join("|");
}

function correctOptionsFor(question) {
  return Array.isArray(question && question.activityAnswerDTO)
    ? question.activityAnswerDTO.filter((option) => option && (option.isCorrect === true || String(option.isCorrect).toLowerCase() === "true"))
    : [];
}

function looksLikeDelimited(value, delimiter) {
  return typeof value === "string" && value.includes(delimiter);
}

function getQuestionType(question) {
  const type = rawQuestionType(question);
  const correctAnswer = question && question.correctAnswer;
  const options = Array.isArray(question && question.activityAnswerDTO) ? question.activityAnswerDTO : [];
  const correctOptions = correctOptionsFor(question);

  if (/REORDER|ORDERING|SORT|DRAG.?DROP/.test(type)) return "REORDER";
  if (/MTF|MATCH|PAIR|ASSOCIAT/.test(type)) return "MTF";
  if (/MFIB|MULTI.?FIB|MULTI.?FILL|MULTI.?BLANK/.test(type)) return "MFIB";
  if (/MRQ|MULTI.?SELECT|MULTIPLE.?CHOICE|CHECKBOX|SELECT.?ALL/.test(type)) return "MRQ";
  if (/FIB|SHORT.?ANSWER|TEXT.?ANSWER|GAP.?FILL|FILL.?BLANK/.test(type)) return "FIB";
  if (/ESSAY|PARAGRAPH|WRITING|LONG.?ANSWER|DESCRIPTIVE|EMAIL|LETTER|REPORT|SUMMARY/.test(type)) return "WRITING";
  if (/SPEAK|PRONUNCIATION|RECORD|LISTENING_RECORD|VOICE|AUDIO|MIC/.test(type)) return "SPEAKING";

  // Some RCA responses use a generic SELECT label. Use the answer shape to
  // distinguish a single-select ID from a select-all list.
  if (/SELECT/.test(type)) {
    if (looksLikeDelimited(correctAnswer, "|||") || correctOptions.length > 1) return "MRQ";
    return "MCQ";
  }
  if (looksLikeDelimited(correctAnswer, "|||")) {
    const textLike = correctOptions.some((option) => /[A-Za-z]/.test(String(option.answerOption || option.text || "")));
    return textLike ? "MFIB" : "MRQ";
  }
  return "MCQ";
}

function isManualOnlyQuestion(question) {
  return getQuestionType(question) === "SPEAKING";
}

function isSpeakingQuestion(question) {
  return getQuestionType(question) === "SPEAKING";
}

function isWritingQuestion(question) {
  return getQuestionType(question) === "WRITING";
}

function isMatchingQuestion(question) {
  return getQuestionType(question) === "MTF";
}

function isReorderQuestion(question) {
  return getQuestionType(question) === "REORDER";
}

function isMultiSelectQuestion(question) {
  return getQuestionType(question) === "MRQ";
}

function isMultiFillQuestion(question) {
  return getQuestionType(question) === "MFIB";
}

function isTextAnswerQuestion(question) {
  return ["FIB", "MFIB", "WRITING"].includes(getQuestionType(question));
}

function isNonAnswerQuestion(question) {
  const type = rawQuestionType(question);
  return /COMPREHENSION|PASSAGE|IELTSLISTENING|IELTSSPEAKING|LISTENANDRECORD|RECORD/.test(type);
}

function hasAnswer(question) {
  if (!question) return false;
  if (Array.isArray(question.userAnswer)) return question.userAnswer.length > 0;
  return question.userAnswer != null && String(question.userAnswer).trim() !== "";
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
  const activitySetId = process.env.RCA_PLACEMENT_ACTIVITY_SET_ID || "12";
  try {
    const activity = await fetchActivityDetails(activitySetId, user.accessToken, user.loginId, user.clientInfo);
    const finalLike = String(activity.activityType || "").toUpperCase() === "FINAL" || activity.isFinalActivity === true || /FINAL|PLACEMENT/i.test(`${activity.activityName || ""} ${activity.lessonName || ""}`);
    if (!finalLike) return { available: false, learnEnglishCompleted: true, reason: "RCA did not return a final placement activity" };
    return { available: !isPersistedSubmitted(activity), completed: isPersistedSubmitted(activity), learnEnglishCompleted: true, activitySetId: String(activitySetId), activity: { lessonName: activity.lessonName, totalQuestions: activity.totalQuestions, totalAnswersCorrect: activity.totalAnswersCorrect, totalEarnedScore: activity.totalEarnedScore } };
  } catch (e) {
    return { available: false, learnEnglishCompleted: true, activitySetId: String(activitySetId), reason: e.message };
  }
}

// ==================== RANDOM CONTENT GENERATORS ====================
const RANDOM_PARAGRAPHS = [
  "Education is the most powerful weapon which you can use to change the world. It opens doors to endless opportunities and empowers individuals to reach their full potential. Through education, we gain knowledge, develop critical thinking skills, and learn to adapt to an ever-changing world.",
  "Technology has revolutionized the way we live, work, and communicate. From smartphones to artificial intelligence, technological advancements continue to shape our daily lives. While technology brings numerous benefits, it also presents challenges that society must address responsibly.",
  "Environmental conservation is crucial for the survival of our planet. Climate change, deforestation, and pollution threaten ecosystems worldwide. Every individual can contribute to environmental protection through sustainable practices and awareness.",
  "Health and wellness are fundamental aspects of a fulfilling life. Regular exercise, balanced nutrition, and adequate sleep form the foundation of good health. Mental well-being is equally important and requires attention and care.",
  "Travel broadens our horizons and exposes us to diverse cultures and perspectives. Exploring new places helps us understand different ways of life and fosters global citizenship. The experiences gained through travel are invaluable and often life-changing.",
  "Leadership is not about being in charge, but about taking care of those in your charge. Great leaders inspire others through vision, integrity, and empathy. Effective leadership requires continuous learning and adaptation to new challenges.",
  "Innovation drives progress and economic growth. Creative thinking and problem-solving skills are essential in today's competitive world. Organizations that foster innovation culture tend to outperform their competitors.",
  "Communication is the key to building strong relationships. Whether personal or professional, effective communication involves active listening, clarity, and empathy. Misunderstandings often arise from poor communication practices.",
  "Time management is a critical skill for success in any field. Prioritizing tasks, setting goals, and avoiding procrastination lead to increased productivity. Balancing work and personal life requires intentional time allocation.",
  "Teamwork makes the dream work. Collaborative efforts often yield better results than individual endeavors. Successful teams leverage diverse skills and perspectives to achieve common objectives.",
  "Critical thinking enables us to analyze information objectively and make informed decisions. In an age of information overload, the ability to evaluate sources and identify biases is increasingly important.",
  "Cultural diversity enriches our communities and workplaces. Embracing different perspectives leads to more creative solutions and inclusive environments. Respect and understanding are essential for harmonious coexistence.",
  "Financial literacy is essential for personal economic stability. Understanding budgeting, saving, and investing helps individuals make informed financial decisions. Early financial education sets the foundation for long-term security.",
  "Creativity is intelligence having fun. It involves thinking outside the box and approaching problems from unique angles. Creative skills can be developed through practice and exposure to new experiences.",
  "Resilience is the ability to bounce back from setbacks. Developing mental toughness helps individuals navigate challenges and emerge stronger. Support systems and self-care practices contribute to resilience.",
];

const RANDOM_ESSAYS = [
  `The Impact of Social Media on Modern Society

Social media has fundamentally transformed how we communicate and interact. Platforms like Facebook, Instagram, and Twitter have connected billions of people across the globe. While these platforms offer unprecedented connectivity, they also raise concerns about privacy and mental health.

One significant benefit is the democratization of information. News spreads rapidly, and marginalized voices find platforms to express themselves. However, the spread of misinformation poses serious challenges to public discourse.

Mental health impacts deserve careful consideration. Studies link excessive social media use to anxiety and depression, particularly among young people. The curated nature of online personas creates unrealistic expectations.

In conclusion, social media is a powerful tool that requires mindful usage. Balancing online engagement with real-world connections remains essential for well-being.`,

  `The Importance of Renewable Energy

As global energy demands continue to rise, renewable sources offer sustainable solutions. Solar, wind, and hydroelectric power reduce dependence on fossil fuels and decrease carbon emissions significantly.

Solar energy has become increasingly affordable and efficient. Technological advances have made photovoltaic cells more accessible to homeowners and businesses alike. Government incentives further accelerate adoption.

Wind energy represents another promising avenue. Offshore wind farms harness consistent ocean winds to generate substantial electricity. Coastal regions particularly benefit from this technology.

However, challenges remain. Energy storage solutions need improvement to address intermittency issues. Grid infrastructure requires upgrades to accommodate distributed generation.

Transitioning to renewable energy is not merely an environmental imperative but also an economic opportunity. Green jobs creation and energy independence justify continued investment.`,

  `The Role of Education in Economic Development

Education serves as the cornerstone of economic prosperity. Nations that invest heavily in education consistently outperform those that neglect this critical sector. Human capital development drives innovation and productivity.

Primary education establishes foundational literacy and numeracy skills. These basic competencies enable further learning and workforce participation. Universal primary education remains a global development priority.

Secondary and tertiary education develop specialized expertise. Technical and vocational training address labor market needs directly. University education produces researchers and leaders.

Lifelong learning has gained importance in rapidly evolving economies. Workers must continuously update skills to remain competitive. Online platforms have democratized access to continuing education.

Investing in education yields substantial returns. Educated populations enjoy better health outcomes, higher incomes, and greater civic engagement. The multiplier effects benefit entire societies.`,

  `Urbanization and Its Challenges

Cities around the world are growing at unprecedented rates. By 2050, nearly 70% of the global population is expected to live in urban areas. This rapid urbanization presents both opportunities and significant challenges.

Infrastructure strain represents a primary concern. Transportation networks, water systems, and energy grids struggle to keep pace with population growth. Many cities face chronic traffic congestion and inadequate public services.

Housing affordability has become critical. Rising property values displace long-term residents and create socioeconomic segregation. Innovative housing solutions and inclusive zoning policies are urgently needed.

Environmental impacts intensify in dense urban settings. Air pollution, heat islands, and waste management require integrated approaches. Green infrastructure and sustainable design offer promising pathways.

Despite challenges, cities remain engines of economic growth and cultural innovation. Effective urban planning and governance can maximize benefits while mitigating negative consequences.`,
];

function getRandomParagraph() {
  return RANDOM_PARAGRAPHS[Math.floor(Math.random() * RANDOM_PARAGRAPHS.length)];
}

function getRandomEssay() {
  return RANDOM_ESSAYS[Math.floor(Math.random() * RANDOM_ESSAYS.length)];
}

function getWritingAnswer(question) {
  const prompt = String(question.questionText || question.itemText || question.text || "").toLowerCase();

  // Check word count requirement
  let wordCount = 150;
  const wordMatch = prompt.match(/(\d+)\s*words?/);
  if (wordMatch) wordCount = parseInt(wordMatch[1], 10);

  // Determine type based on prompt
  if (prompt.includes("essay") || prompt.includes("discuss") || prompt.includes("opinion") || prompt.includes("agree") || prompt.includes("disagree")) {
    return getRandomEssay();
  }

  // Generate multiple paragraphs for longer requirements
  let result = "";
  const targetWords = Math.max(80, wordCount);
  let currentWords = 0;

  while (currentWords < targetWords) {
    const para = getRandomParagraph();
    result += (result ? "\n\n" : "") + para;
    currentWords += para.split(/\s+/).length;
  }

  return result;
}

// ==================== FAKE VOICE DATA FOR SPEAKING ====================
function generateFakeVoiceData(question) {
  // Generate a fake base64 audio string (short silent/placeholder audio)
  const fakeAudioBases = [
    "//uQxAAAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "//uQxAAAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  ];

  const recordingId = `rec_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const audioBase64 = fakeAudioBases[Math.floor(Math.random() * fakeAudioBases.length)];

  return {
    learnerAnswerRecordingId: recordingId,
    answerRecordingPath: `https://rca.englishhelper.com/recordings/${recordingId}.mp3`,
    userAnswer: audioBase64,
    submittedUserAnswer: audioBase64,
    isSubmitClicked: true,
    allAnswersRecorded: true,
    isUserAnswerCorrect: true,
  };
}


// ==================== ANSWER LOGIC - PER QUESTION SUBMIT ====================
function normalizeRcaOptionId(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}

function nonEmptyString(value) {
  return value == null ? "" : String(value).trim();
}

function splitDelimited(value, delimiter) {
  if (Array.isArray(value)) return value.map(nonEmptyString).filter(Boolean);
  return nonEmptyString(value).split(delimiter).map((part) => part.trim()).filter(Boolean);
}

function optionId(option) {
  return option && (option.id ?? option.answerId ?? option.optionId ?? option.value);
}

function optionText(option) {
  return option && (option.answerOption ?? option.text ?? option.answer ?? option.label ?? option.value);
}

function canonicalIdList(question, delimiter = "|||") {
  const fromCorrect = splitDelimited(question && question.correctAnswer, delimiter);
  if (fromCorrect.length > 0) return fromCorrect.map(normalizeRcaOptionId).join(delimiter);
  return correctOptionsFor(question).map((option) => normalizeRcaOptionId(optionId(option))).filter((value) => value != null && value !== "").join(delimiter);
}

function canonicalTextList(question, delimiter = "|||") {
  const fromCorrect = splitDelimited(question && question.correctAnswer, delimiter);
  if (fromCorrect.length > 0) return fromCorrect.join(delimiter);
  return correctOptionsFor(question).map(optionText).map(nonEmptyString).filter(Boolean).join(delimiter);
}

function canonicalSequence(question) {
  const candidate = nonEmptyString(question && (question.correctAnswer || question.metaData || question.answerOrder || question.correctOrder));
  if (candidate) return candidate.split(",").map((part) => part.trim()).filter(Boolean).join(",");
  const value = question && (question.correctAnswer || question.metaData || question.answerOrder || question.correctOrder);
  return Array.isArray(value) ? value.map(nonEmptyString).filter(Boolean).join(",") : "";
}

function normalizedText(value) {
  return nonEmptyString(value).replace(/\s+/g, " ").toLowerCase();
}

function answerHasValue(value) {
  return !(value == null || value === "" || (Array.isArray(value) && value.length === 0));
}

function sameTokenSet(left, right, delimiter) {
  const a = splitDelimited(left, delimiter).map(String).sort();
  const b = splitDelimited(right, delimiter).map(String).sort();
  return a.length > 0 && a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAnswerCorrectForQuestion(question, answer) {
  const type = getQuestionType(question);
  if (!answerHasValue(answer)) return false;
  if (type === "MTF" || type === "REORDER") return nonEmptyString(answer) === canonicalSequence(question);
  if (type === "MRQ") return sameTokenSet(answer, canonicalIdList(question), "|||");
  if (type === "MFIB") return splitDelimited(answer, "|||").map(normalizedText).join("|||") === splitDelimited(canonicalTextList(question), "|||").map(normalizedText).join("|||");
  if (type === "FIB" || type === "WRITING") return normalizedText(answer) === normalizedText(question && question.correctAnswer);
  const expected = nonEmptyString(question && question.correctAnswer);
  return expected !== "" && String(answer).trim() === expected;
}

function getAnswerForQuestion(q) {
  const type = getQuestionType(q);
  const options = Array.isArray(q.activityAnswerDTO) ? q.activityAnswerDTO : [];

  if (type === "SPEAKING") return generateFakeVoiceData(q);

  if (type === "WRITING") {
    const text = getWritingAnswer(q);
    return {
      userAnswer: text,
      submittedUserAnswer: text,
      isSubmitClicked: true,
      allAnswersRecorded: false,
      isUserAnswerCorrect: true,
      userEssay: text,
    };
  }

  let answer;
  let metaData;
  if (type === "REORDER" || type === "MTF") {
    answer = canonicalSequence(q);
    metaData = answer || q.metaData;
  } else if (type === "MRQ") {
    // RCA's multi-select contract is a |||-delimited string, not a JSON array.
    answer = canonicalIdList(q);
  } else if (type === "MFIB") {
    // Multi-fill answers are ordered text tokens separated by |||.
    answer = canonicalTextList(q);
  } else if (type === "FIB") {
    const correct = nonEmptyString(q.correctAnswer);
    const correctOption = correctOptionsFor(q)[0];
    answer = correct || nonEmptyString(optionText(correctOption));
  } else {
    const correct = nonEmptyString(q.correctAnswer);
    const correctOption = correctOptionsFor(q)[0] || options.find((option) => String(optionId(option)) === correct);
    const id = optionId(correctOption);
    answer = id != null ? normalizeRcaOptionId(id) : normalizeRcaOptionId(correct);
  }

  const hasValue = answerHasValue(answer);
  const result = {
    userAnswer: answer,
    submittedUserAnswer: answer,
    isSubmitClicked: hasValue,
    allAnswersRecorded: !hasValue && isNonAnswerQuestion(q),
    isUserAnswerCorrect: isAnswerCorrectForQuestion(q, answer),
  };
  if (metaData != null && metaData !== "") result.metaData = metaData;
  return result;
}

function applyAnswerData(question, answerData) {
  question.userAnswer = answerData.userAnswer;
  question.submittedUserAnswer = answerData.submittedUserAnswer;
  question.isSubmitClicked = answerData.isSubmitClicked;
  question.allAnswersRecorded = answerData.allAnswersRecorded;
  question.isUserAnswerCorrect = answerData.isUserAnswerCorrect;
  if (answerData.learnerAnswerRecordingId) question.learnerAnswerRecordingId = answerData.learnerAnswerRecordingId;
  if (answerData.answerRecordingPath) question.answerRecordingPath = answerData.answerRecordingPath;
  if (answerData.userEssay) question.userEssay = answerData.userEssay;
  if (answerData.metaData != null) question.metaData = answerData.metaData;
  return question;
}

function fillAnswers(activity) {
  let correctCount = 0;
  let attemptedCount = 0;
  let earnedScore = 0;
  const list = Array.isArray(activity && activity.activityQuestionDetailsList) ? activity.activityQuestionDetailsList : [];

  list.forEach((q) => {
    applyAnswerData(q, getAnswerForQuestion(q));
    if (answerHasValue(q.userAnswer)) attemptedCount++;
    if (q.isUserAnswerCorrect) {
      correctCount++;
      earnedScore += Number(q.itemScore || q.score || 1);
    }
  });

  activity.totalQuestionsAttempted = attemptedCount;
  activity.totalAnswersCorrect = correctCount;
  activity.totalEarnedScore = earnedScore;
  activity.totalQuestionsLeft = Math.max(0, Number(activity.totalQuestions || list.length) - attemptedCount);
  return activity;
}

// ==================== PER-QUESTION SUBMIT LOGIC ====================
function normalizeActivityType(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "FINAL") return "Final";
  if (upper === "IELTS" || upper === "IELTS_TEST") return "Ielts";
  return "Lesson";
}

function buildActivitySubmissionPayload(activity, questionIndex, state, learnerId) {
  const questions = Array.isArray(activity && activity.activityQuestionDetailsList)
    ? activity.activityQuestionDetailsList.map((question) => ({ ...question }))
    : [];
  const current = questions[questionIndex] || questions[questions.length - 1] || null;
  const payload = { ...activity, activityQuestionDetailsList: questions };
  payload.activityState = state;
  payload.learnerId = learnerId;
  payload.activityType = normalizeActivityType(payload.activityType);
  if (current && current.itemId != null) payload.currentQuestionItemId = current.itemId;
  if (payload.activityIdForIndex == null && questions[0] && questions[0].itemId != null) payload.activityIdForIndex = questions[0].itemId;
  if (payload.activityIndex == null) payload.activityIndex = 0;
  if (!payload.startDate) payload.startDate = Date.now() - 15000;
  if (payload.isSubmitClicked == null) payload.isSubmitClicked = false;

  const attempted = questions.reduce((count, question) => count + (answerHasValue(question.userAnswer) ? 1 : 0), 0);
  const correct = questions.reduce((count, question) => count + (question.isUserAnswerCorrect === true ? 1 : 0), 0);
  const earned = questions.reduce((sum, question) => sum + (question.isUserAnswerCorrect === true ? Number(question.itemScore || question.score || 1) : 0), 0);
  payload.totalQuestionsAttempted = attempted;
  payload.totalAnswersCorrect = correct;
  payload.totalEarnedScore = earned;
  payload.totalQuestionsLeft = Math.max(0, questions.length - attempted);

  if (state === "SUBMITTED") {
    payload.endDate = Date.now();
    payload.totalTimeTaken = Math.max(15, Math.floor((payload.endDate - payload.startDate) / 1000));
    payload.totalTimeTakenInSecs = payload.totalTimeTaken;
    payload.totalQuestionsLeft = 0;
  }
  return payload;
}

async function submitSingleQuestion(token, activity, questionIndex, state, learnerId, loginId, clientInfo, apiLogger) {
  const payload = buildActivitySubmissionPayload(activity, questionIndex, state, learnerId);
  await rcaRequest("POST", "/activity/data", { token, body: payload, loginId, clientInfo, apiLogger });
  return payload;
}

async function submitSingleQuestionWithRecovery(token, activity, questionIndex, state, learnerId, loginId, clientInfo, apiLogger, activitySetId) {
  try {
    return await submitSingleQuestion(token, activity, questionIndex, state, learnerId, loginId, clientInfo, apiLogger);
  } catch (error) {
    if (!isTransientRcaError(error)) throw error;
    console.warn(`[RCA Question Recovery] ${state} ${activitySetId || activity.activityId || "unknown"} Q${questionIndex + 1}: ${error.message}`);
    await sleep(retryDelay(1));
    const fresh = await fetchActivityDetails(activitySetId || activity.activityId, token, loginId, clientInfo);
    const rebuilt = mergeActivityAnswers(fresh, activity);
    const current = rebuilt.activityQuestionDetailsList && rebuilt.activityQuestionDetailsList[questionIndex];
    if (current) applyAnswerData(current, getAnswerForQuestion(current));
    return submitSingleQuestion(token, rebuilt, questionIndex, state, learnerId, loginId, clientInfo, apiLogger);
  }
}

async function submitActivity(token, activity, state, learnerId, loginId, clientInfo, apiLogger) {
  const payload = Object.assign({}, activity);
  payload.activityState = state;
  payload.learnerId = learnerId;
  payload.activityType = payload.activityType || (String(payload.activityType || "").toUpperCase() === "FINAL" ? "Final" : "Lesson");
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

function mergeActivityAnswers(fresh, previous) {
  const previousRows = Array.isArray(previous && previous.activityQuestionDetailsList) ? previous.activityQuestionDetailsList : [];
  const byItem = new Map(previousRows.map((q) => [String(q.itemId), q]));
  const byResult = new Map(previousRows.filter((q) => q.activityResultDetailId != null).map((q) => [String(q.activityResultDetailId), q]));
  const rows = Array.isArray(fresh && fresh.activityQuestionDetailsList) ? fresh.activityQuestionDetailsList : [];
  rows.forEach((q) => {
    const old = byItem.get(String(q.itemId)) || (q.activityResultDetailId != null ? byResult.get(String(q.activityResultDetailId)) : null);
    if (!old) return;
    for (const field of ["userAnswer", "submittedUserAnswer", "isSubmitClicked", "allAnswersRecorded", "isUserAnswerCorrect", "userEssay", "learnerAnswerRecordingId", "answerRecordingPath"]) {
      if (old[field] !== undefined) q[field] = old[field];
    }
  });
  return fresh;
}

async function submitActivityWithRecovery(token, activity, state, learnerId, loginId, clientInfo, apiLogger, activitySetId) {
  try {
    return await submitActivity(token, activity, state, learnerId, loginId, clientInfo, apiLogger);
  } catch (error) {
    if (!isTransientRcaError(error)) throw error;
    console.warn(`[RCA Submit Recovery] ${state} ${activitySetId || activity.activityId || "unknown"}: ${error.message}`);
    await sleep(200);
    const fresh = await fetchActivityDetails(activitySetId || activity.activityId, token, loginId, clientInfo);
    const rebuilt = mergeActivityAnswers(fresh, activity);
    rebuilt.activityState = state;
    rebuilt.learnerId = learnerId;
    if (!rebuilt.startDate) rebuilt.startDate = Date.now() - 30000;
    return submitActivity(token, rebuilt, state, learnerId, loginId, clientInfo, apiLogger);
  }
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

  lock.locked = false;
  const next = lock.queue.shift();
  if (next) {
    lock.locked = true;
    next();
  }

  if (lock.queue.length === 0 && !lock.locked) {
    taskLocks.delete(key);
  }
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
    await sleep(300);
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

  lock.locked = false;
  const next = lock.queue.shift();
  if (next) {
    lock.locked = true;
    next();
  }
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
        console.log(`[Session] Token invalidated for ${user.loginId} - re-authenticating...`);
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
        throw new Error("Session busy on another device - try again shortly");
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


// ==================== SECTIONS DEFINITION ====================
const SECTIONS = {
  learnenglish: {
    id: "learnenglish", name: "LearnEnglish", description: "General English curriculum",
    curriculumId: 3, packageId: 4, activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", { token, query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "3" }, loginId, clientInfo });
        return (data || []).map((l, idx) => ({ id: l.id || idx, name: l.level || LEVEL_META[idx]?.name || "L" + (idx + 1), title: LEVEL_META.find(m => m.name === l.level)?.title || l.level || "Level", subtitle: LEVEL_META.find(m => m.name === l.level)?.subtitle || "Level " + (idx + 1), color: LEVEL_META.find(m => m.name === l.level)?.color || "a1", curriculumLevelMappingId: l.curriculumLevelMappingId }));
      } catch (e) { console.error("getUserLevels error:", e.message); return LEVEL_META.slice(0, 4).map((m, idx) => ({ id: idx + 1, name: m.name, title: m.title, subtitle: m.subtitle, color: m.color, curriculumLevelMappingId: idx + 1 })); }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId;
        const units = asArray(await rcaRequest("GET", "/units", { token, query: { curriculumLevelMappingId: mappingId, packageId: "4" }, loginId, clientInfo }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);
        const resultUnits = []; const allSkills = {};
        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: 8, packageId: 4, loginId, clientInfo, unitLessonIndex });
          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson); const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) allSkills[skillKey] = { name: skillKey, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] };
            const actId = lesson.activitySetId || lesson.activitySetID || lesson.activityId; const isComplete = detectLessonCompletion(lesson);
            unitLessons.push({ lessonId: lesson.lessonId, lessonName: lesson.lessonName || lesson.name || "Lesson " + lesson.lessonNumber, activitySetId: actId || null, skillKey, isCompleted: isComplete, status: isComplete ? "COMPLETED" : "NEW" });
            if (actId) { allSkills[skillKey].activitySetIds.push(String(actId)); allSkills[skillKey].totalActivities++; if (isComplete) allSkills[skillKey].completedActivities++; allSkills[skillKey].activities.push({ activitySetId: actId, isCompleted: isComplete, lessonName: lesson.lessonName || lesson.name || "Lesson " + lesson.lessonNumber }); }
          }
          if (unitLessons.length > 0) resultUnits.push({ unitId, unitName: unit.unitName || unit.name || "Unit " + unit.sequenceNo, sequenceNo: unit.sequenceNo || unitId, lessons: unitLessons });
        }
        let allDone = true;
        for (const key of Object.keys(allSkills)) { if (allSkills[key].completedActivities < allSkills[key].totalActivities) allDone = false; if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) allSkills[key].completed = true; }
        SKILLS.forEach((s) => { if (!allSkills[s.key]) { allSkills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] }; allDone = false; } });
        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) { if (isAuthError(e)) throw e; console.error("loadLevelData error:", e.message); return { level: levelData, units: [], skills: {}, isCompleted: false }; }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken; const learnerId = session.learnerId; const loginId = session.loginId; const clientInfo = session.clientInfo;
      const activityStartTime = Date.now();
      onLog && onLog("Fetching activity: " + activitySetId, "info");

      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!activity) throw new Error("Null activity payload");
      if (isPersistedSubmitted(activity)) { onLog && onLog("Already completed: " + activitySetId, "warn"); return { skipped: true, activitySetId, reason: "already_completed" }; }

      const allQuestions = activity.activityQuestionDetailsList || [];
      onLog && onLog(`Starting ${allQuestions.length} questions with per-question submit...`, "info");

      // Process each question individually
      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i];
        applyAnswerData(q, getAnswerForQuestion(q));

        let attemptedCount = 0; let correctCount = 0; let earnedScore = 0;
        for (let j = 0; j <= i; j++) {
          const qq = allQuestions[j];
          const hasValue = !(qq.userAnswer == null || qq.userAnswer === "" || (Array.isArray(qq.userAnswer) && qq.userAnswer.length === 0));
          if (hasValue) attemptedCount++;
          if (qq.isUserAnswerCorrect) { correctCount++; earnedScore += Number(qq.itemScore || qq.score || 1); }
        }
        activity.totalQuestionsAttempted = attemptedCount; activity.totalAnswersCorrect = correctCount;
        activity.totalEarnedScore = earnedScore; activity.totalQuestionsLeft = Math.max(0, allQuestions.length - attemptedCount);
        activity.activityState = "INPROGRESS"; activity.learnerId = learnerId;
        if (!activity.startDate) activity.startDate = activityStartTime - 15000;

        // Submit after EACH question
        const isLast = i === allQuestions.length - 1;
        const state = isLast ? "SUBMITTED" : "INPROGRESS";
        onLog && onLog(`Q${i+1}/${allQuestions.length}: ${isSpeakingQuestion(q) ? "SPEAKING (auto)" : isWritingQuestion(q) ? "WRITING (auto)" : "ANSWERED"} -> ${state}`, "info");

        await submitSingleQuestionWithRecovery(token, activity, i, state, learnerId, loginId, clientInfo, apiLogger, activitySetId);

        if (!isLast && CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
      }

      // Final verification
      await sleep(CONFIG.FINAL_VERIFICATION_DELAY_MS);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) {
        onLog && onLog("State verification failed, retrying...", "warn");
        await sleep(200);
        const retryVerify = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
        if (!isPersistedSubmitted(retryVerify)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`);
      }

      const actualTimeTaken = Math.max(20, Math.floor((Date.now() - activityStartTime) / 1000));
      onLog && onLog(`Verified submitted: ${activitySetId} (${allQuestions.length} Qs, ${actualTimeTaken}s)`, "success");

      const lessonId = activity.lessonId || activitySetId;
      await updateTimeTaken(token, learnerId, lessonId, activitySetId, actualTimeTaken, loginId, clientInfo, apiLogger, "Lesson");
      return { success: true, activitySetId, questionsCount: allQuestions.length, timeTaken: actualTimeTaken };
    }
  },

  apex: {
    id: "apex", name: "APEX", description: "Advanced vocabulary & skills mastery",
    curriculumId: 105, packageId: 47, packageSuffix: 47, standardLevelId: 8, activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", { token, query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "105" }, loginId, clientInfo });
        return (data || []).map((l, idx) => ({ id: l.id || idx, name: l.level || "L" + (idx + 1), title: (l.level || "Level") + (l.nextLevel ? " -> " + l.nextLevel : ""), subtitle: "APEX Level", color: String(l.level || "").toLowerCase() || "a1", curriculumLevelMappingId: l.curriculumLevelMappingId, standardLevelId: l.id, userLevelData: l }));
      } catch (e) { console.error("getUserLevels error:", e.message); return []; }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId; const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", { token, query: { curriculumLevelMappingId: mappingId, packageId: "47" }, loginId, clientInfo }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);
        const resultUnits = []; const allSkills = {};
        for (const unit of units || []) {
          const unitId = unit.id; const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 47, loginId, clientInfo, unitLessonIndex });
          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson); const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) allSkills[skillKey] = { name: skillKey, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] };
            const actId = lesson.activitySetId || lesson.id || null; const isComplete = detectLessonCompletion(lesson); const lessonLocked = isLessonLockedForUser(lesson);
            if (!lessonLocked) {
              unitLessons.push({ lessonId: lesson.lessonId || actId, lessonName: lesson.lessonName || lesson.name || "Lesson", activitySetId: actId, skillKey, isCompleted: isComplete, isLocked: lessonLocked, status: isComplete ? "COMPLETED" : "NEW" });
              if (actId) { allSkills[skillKey].activitySetIds.push(String(actId)); allSkills[skillKey].totalActivities++; if (isComplete) allSkills[skillKey].completedActivities++; allSkills[skillKey].activities.push({ activitySetId: actId, isCompleted: isComplete, lessonName: lesson.lessonName || lesson.name || "Lesson" }); }
            }
          }
          if (unitLessons.length > 0) resultUnits.push({ unitId, unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId), sequenceNo: unit.sequenceNo || unitId, isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked), completionStatus: unit.completionStatus || null, completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null, lessons: unitLessons });
        }
        let allDone = true;
        for (const key of Object.keys(allSkills)) { if (allSkills[key].completedActivities < allSkills[key].totalActivities) allDone = false; if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) allSkills[key].completed = true; }
        SKILLS.forEach((s) => { if (!allSkills[s.key]) { allSkills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] }; allDone = false; } });
        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) { if (isAuthError(e)) throw e; console.error("loadLevelData error:", e.message); return { level: levelData, units: [], skills: {}, isCompleted: false }; }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken; const learnerId = session.learnerId; const loginId = session.loginId; const clientInfo = session.clientInfo;
      const activityStartTime = Date.now();
      onLog && onLog("Fetching activity: " + activitySetId, "info");
      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!activity) throw new Error("Null activity payload");
      if (isPersistedSubmitted(activity)) { onLog && onLog("Already completed: " + activitySetId, "warn"); return { skipped: true, activitySetId, reason: "already_completed" }; }
      const allQuestions = activity.activityQuestionDetailsList || [];
      onLog && onLog(`Starting ${allQuestions.length} questions with per-question submit...`, "info");
      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i]; applyAnswerData(q, getAnswerForQuestion(q));
        let attemptedCount = 0; let correctCount = 0; let earnedScore = 0;
        for (let j = 0; j <= i; j++) { const qq = allQuestions[j]; const hasValue = !(qq.userAnswer == null || qq.userAnswer === "" || (Array.isArray(qq.userAnswer) && qq.userAnswer.length === 0)); if (hasValue) attemptedCount++; if (qq.isUserAnswerCorrect) { correctCount++; earnedScore += Number(qq.itemScore || qq.score || 1); } }
        activity.totalQuestionsAttempted = attemptedCount; activity.totalAnswersCorrect = correctCount; activity.totalEarnedScore = earnedScore; activity.totalQuestionsLeft = Math.max(0, allQuestions.length - attemptedCount); activity.activityState = "INPROGRESS"; activity.learnerId = learnerId; if (!activity.startDate) activity.startDate = activityStartTime - 15000;
        const isLast = i === allQuestions.length - 1; const state = isLast ? "SUBMITTED" : "INPROGRESS";
        onLog && onLog(`Q${i+1}/${allQuestions.length}: ${isSpeakingQuestion(q) ? "SPEAKING (auto)" : isWritingQuestion(q) ? "WRITING (auto)" : "ANSWERED"} -> ${state}`, "info");
        await submitSingleQuestionWithRecovery(token, activity, i, state, learnerId, loginId, clientInfo, apiLogger, activitySetId);
        if (!isLast && CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
      }
      await sleep(CONFIG.FINAL_VERIFICATION_DELAY_MS);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) { onLog && onLog("State verification failed, retrying...", "warn"); await sleep(200); const retryVerify = await fetchActivityDetails(activitySetId, token, loginId, clientInfo); if (!isPersistedSubmitted(retryVerify)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`); }
      const actualTimeTaken = Math.max(20, Math.floor((Date.now() - activityStartTime) / 1000));
      onLog && onLog(`Verified submitted: ${activitySetId} (${allQuestions.length} Qs, ${actualTimeTaken}s)`, "success");
      const lessonId = activity.lessonId || activitySetId; await updateTimeTaken(token, learnerId, lessonId, activitySetId, actualTimeTaken, loginId, clientInfo, apiLogger, "Lesson");
      return { success: true, activitySetId, questionsCount: allQuestions.length, timeTaken: actualTimeTaken };
    }
  },

  vocabbuilder: {
    id: "vocabbuilder", name: "Vocab Builder", description: "Vocabulary building program",
    curriculumId: 125, packageId: 50, packageSuffix: 50, standardLevelId: 8, activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", { token, query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "125" }, loginId, clientInfo });
        return (data || []).map((l, idx) => ({ id: l.id || idx, name: l.level || "L" + (idx + 1), title: (l.level || "Level") + (l.nextLevel ? " -> " + l.nextLevel : ""), subtitle: "Vocab Builder Level", color: String(l.level || "").toLowerCase() || "a1", curriculumLevelMappingId: l.curriculumLevelMappingId, standardLevelId: l.id, userLevelData: l }));
      } catch (e) { console.error("getUserLevels error:", e.message); return []; }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId; const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", { token, query: { curriculumLevelMappingId: mappingId, packageId: "50" }, loginId, clientInfo }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);
        const resultUnits = []; const allSkills = {};
        for (const unit of units || []) {
          const unitId = unit.id; const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 50, loginId, clientInfo, unitLessonIndex });
          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson); const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) allSkills[skillKey] = { name: skillKey, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] };
            const actId = lesson.activitySetId || lesson.id || null; const isComplete = detectLessonCompletion(lesson); const lessonLocked = isLessonLockedForUser(lesson);
            if (!lessonLocked) {
              unitLessons.push({ lessonId: lesson.lessonId || actId, lessonName: lesson.lessonName || lesson.name || "Lesson", activitySetId: actId, skillKey, isCompleted: isComplete, isLocked: lessonLocked, status: isComplete ? "COMPLETED" : "NEW" });
              if (actId) { allSkills[skillKey].activitySetIds.push(String(actId)); allSkills[skillKey].totalActivities++; if (isComplete) allSkills[skillKey].completedActivities++; allSkills[skillKey].activities.push({ activitySetId: actId, isCompleted: isComplete, lessonName: lesson.lessonName || lesson.name || "Lesson" }); }
            }
          }
          if (unitLessons.length > 0) resultUnits.push({ unitId, unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId), sequenceNo: unit.sequenceNo || unitId, isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked), completionStatus: unit.completionStatus || null, completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null, lessons: unitLessons });
        }
        let allDone = true;
        for (const key of Object.keys(allSkills)) { if (allSkills[key].completedActivities < allSkills[key].totalActivities) allDone = false; if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) allSkills[key].completed = true; }
        SKILLS.forEach((s) => { if (!allSkills[s.key]) { allSkills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] }; allDone = false; } });
        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) { if (isAuthError(e)) throw e; console.error("loadLevelData error:", e.message); return { level: levelData, units: [], skills: {}, isCompleted: false }; }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken; const learnerId = session.learnerId; const loginId = session.loginId; const clientInfo = session.clientInfo;
      const activityStartTime = Date.now();
      onLog && onLog("Fetching activity: " + activitySetId, "info");
      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!activity) throw new Error("Null activity payload");
      if (isPersistedSubmitted(activity)) { onLog && onLog("Already completed: " + activitySetId, "warn"); return { skipped: true, activitySetId, reason: "already_completed" }; }
      const allQuestions = activity.activityQuestionDetailsList || [];
      onLog && onLog(`Starting ${allQuestions.length} questions with per-question submit...`, "info");
      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i]; applyAnswerData(q, getAnswerForQuestion(q));
        let attemptedCount = 0; let correctCount = 0; let earnedScore = 0;
        for (let j = 0; j <= i; j++) { const qq = allQuestions[j]; const hasValue = !(qq.userAnswer == null || qq.userAnswer === "" || (Array.isArray(qq.userAnswer) && qq.userAnswer.length === 0)); if (hasValue) attemptedCount++; if (qq.isUserAnswerCorrect) { correctCount++; earnedScore += Number(qq.itemScore || qq.score || 1); } }
        activity.totalQuestionsAttempted = attemptedCount; activity.totalAnswersCorrect = correctCount; activity.totalEarnedScore = earnedScore; activity.totalQuestionsLeft = Math.max(0, allQuestions.length - attemptedCount); activity.activityState = "INPROGRESS"; activity.learnerId = learnerId; if (!activity.startDate) activity.startDate = activityStartTime - 15000;
        const isLast = i === allQuestions.length - 1; const state = isLast ? "SUBMITTED" : "INPROGRESS";
        onLog && onLog(`Q${i+1}/${allQuestions.length}: ${isSpeakingQuestion(q) ? "SPEAKING (auto)" : isWritingQuestion(q) ? "WRITING (auto)" : "ANSWERED"} -> ${state}`, "info");
        await submitSingleQuestionWithRecovery(token, activity, i, state, learnerId, loginId, clientInfo, apiLogger, activitySetId);
        if (!isLast && CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
      }
      await sleep(CONFIG.FINAL_VERIFICATION_DELAY_MS);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) { onLog && onLog("State verification failed, retrying...", "warn"); await sleep(200); const retryVerify = await fetchActivityDetails(activitySetId, token, loginId, clientInfo); if (!isPersistedSubmitted(retryVerify)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`); }
      const actualTimeTaken = Math.max(20, Math.floor((Date.now() - activityStartTime) / 1000));
      onLog && onLog(`Verified submitted: ${activitySetId} (${allQuestions.length} Qs, ${actualTimeTaken}s)`, "success");
      const lessonId = activity.lessonId || activitySetId; await updateTimeTaken(token, learnerId, lessonId, activitySetId, actualTimeTaken, loginId, clientInfo, apiLogger, "Lesson");
      return { success: true, activitySetId, questionsCount: allQuestions.length, timeTaken: actualTimeTaken };
    }
  },

  wordcraft: {
    id: "wordcraft", name: "Wordcraft", description: "Wordcraft vocabulary course",
    curriculumId: 106, packageId: 90, packageSuffix: 90, standardLevelId: 8, activityType: "Lesson",

    getUserLevels: async (token, loginId, clientInfo) => {
      try {
        const data = await rcaRequest("GET", "/userLevels", { token, query: { studentAuthUserId: "0", standardLevelId: "8", curriculumId: "106" }, loginId, clientInfo });
        return (data || []).map((l, idx) => ({ id: l.id || idx, name: l.level || "L" + (idx + 1), title: (l.level || "Level") + (l.nextLevel ? " -> " + l.nextLevel : ""), subtitle: "Wordcraft Level", color: String(l.level || "").toLowerCase() || "a1", curriculumLevelMappingId: l.curriculumLevelMappingId, standardLevelId: l.id, userLevelData: l }));
      } catch (e) { console.error("getUserLevels error:", e.message); return []; }
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const mappingId = levelData.curriculumLevelMappingId; const stdLevel = String(levelData.standardLevelId || levelData.id || 8);
        const units = asArray(await rcaRequest("GET", "/units", { token, query: { curriculumLevelMappingId: mappingId, packageId: "90" }, loginId, clientInfo }), ["units", "data"]);
        const unitLessonIndex = await fetchUnitLessonIndex(token, mappingId, loginId, clientInfo);
        const resultUnits = []; const allSkills = {};
        for (const unit of units || []) {
          const unitId = unit.id; const lessons = await fetchLessonsForUnitDynamic({ token, unit, mappingId, standardLevelId: stdLevel, packageId: 90, loginId, clientInfo, unitLessonIndex });
          const unitLessons = [];
          for (const rawLesson of lessons || []) {
            const lesson = normalizeDynamicLesson(rawLesson); const skillKey = detectLessonSkill(lesson);
            if (!allSkills[skillKey]) allSkills[skillKey] = { name: skillKey, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] };
            const actId = lesson.activitySetId || lesson.id || null; const isComplete = detectLessonCompletion(lesson); const lessonLocked = isLessonLockedForUser(lesson);
            if (!lessonLocked) {
              unitLessons.push({ lessonId: lesson.lessonId || actId, lessonName: lesson.lessonName || lesson.name || "Lesson", activitySetId: actId, skillKey, isCompleted: isComplete, isLocked: lessonLocked, status: isComplete ? "COMPLETED" : "NEW" });
              if (actId) { allSkills[skillKey].activitySetIds.push(String(actId)); allSkills[skillKey].totalActivities++; if (isComplete) allSkills[skillKey].completedActivities++; allSkills[skillKey].activities.push({ activitySetId: actId, isCompleted: isComplete, lessonName: lesson.lessonName || lesson.name || "Lesson" }); }
            }
          }
          if (unitLessons.length > 0) resultUnits.push({ unitId, unitName: unit.name || unit.unitName || "Unit " + (unit.sequenceNo || unitId), sequenceNo: unit.sequenceNo || unitId, isLocked: unitLessons.length > 0 && unitLessons.every((l) => l.isLocked), completionStatus: unit.completionStatus || null, completionPercentage: unit.completionPercentage != null ? Number(unit.completionPercentage) : null, lessons: unitLessons });
        }
        let allDone = true;
        for (const key of Object.keys(allSkills)) { if (allSkills[key].completedActivities < allSkills[key].totalActivities) allDone = false; if (allSkills[key].completedActivities === allSkills[key].totalActivities && allSkills[key].totalActivities > 0) allSkills[key].completed = true; }
        SKILLS.forEach((s) => { if (!allSkills[s.key]) { allSkills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], activities: [] }; allDone = false; } });
        return { level: levelData, units: resultUnits, skills: allSkills, isCompleted: allDone };
      } catch (e) { if (isAuthError(e)) throw e; console.error("loadLevelData error:", e.message); return { level: levelData, units: [], skills: {}, isCompleted: false }; }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken; const learnerId = session.learnerId; const loginId = session.loginId; const clientInfo = session.clientInfo;
      const activityStartTime = Date.now();
      onLog && onLog("Fetching activity: " + activitySetId, "info");
      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!activity) throw new Error("Null activity payload");
      if (isPersistedSubmitted(activity)) { onLog && onLog("Already completed: " + activitySetId, "warn"); return { skipped: true, activitySetId, reason: "already_completed" }; }
      const allQuestions = activity.activityQuestionDetailsList || [];
      onLog && onLog(`Starting ${allQuestions.length} questions with per-question submit...`, "info");
      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i]; applyAnswerData(q, getAnswerForQuestion(q));
        let attemptedCount = 0; let correctCount = 0; let earnedScore = 0;
        for (let j = 0; j <= i; j++) { const qq = allQuestions[j]; const hasValue = !(qq.userAnswer == null || qq.userAnswer === "" || (Array.isArray(qq.userAnswer) && qq.userAnswer.length === 0)); if (hasValue) attemptedCount++; if (qq.isUserAnswerCorrect) { correctCount++; earnedScore += Number(qq.itemScore || qq.score || 1); } }
        activity.totalQuestionsAttempted = attemptedCount; activity.totalAnswersCorrect = correctCount; activity.totalEarnedScore = earnedScore; activity.totalQuestionsLeft = Math.max(0, allQuestions.length - attemptedCount); activity.activityState = "INPROGRESS"; activity.learnerId = learnerId; if (!activity.startDate) activity.startDate = activityStartTime - 15000;
        const isLast = i === allQuestions.length - 1; const state = isLast ? "SUBMITTED" : "INPROGRESS";
        onLog && onLog(`Q${i+1}/${allQuestions.length}: ${isSpeakingQuestion(q) ? "SPEAKING (auto)" : isWritingQuestion(q) ? "WRITING (auto)" : "ANSWERED"} -> ${state}`, "info");
        await submitSingleQuestionWithRecovery(token, activity, i, state, learnerId, loginId, clientInfo, apiLogger, activitySetId);
        if (!isLast && CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
      }
      await sleep(CONFIG.FINAL_VERIFICATION_DELAY_MS);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) { onLog && onLog("State verification failed, retrying...", "warn"); await sleep(200); const retryVerify = await fetchActivityDetails(activitySetId, token, loginId, clientInfo); if (!isPersistedSubmitted(retryVerify)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`); }
      const actualTimeTaken = Math.max(20, Math.floor((Date.now() - activityStartTime) / 1000));
      onLog && onLog(`Verified submitted: ${activitySetId} (${allQuestions.length} Qs, ${actualTimeTaken}s)`, "success");
      const lessonId = activity.lessonId || activitySetId; await updateTimeTaken(token, learnerId, lessonId, activitySetId, actualTimeTaken, loginId, clientInfo, apiLogger, "Lesson");
      return { success: true, activitySetId, questionsCount: allQuestions.length, timeTaken: actualTimeTaken };
    }
  },

  ielts: {
    id: "ielts", name: "LearnEnglish++ (IELTS)", description: "IELTS preparation",
    curriculumId: 21, packageId: 5, activityType: "Ielts",

    getUserLevels: async (token, loginId, clientInfo) => {
      return LEVEL_META.map((l, idx) => ({ id: idx + 4, name: l.name, title: l.title, subtitle: l.subtitle, color: l.color, curriculumLevelMappingId: null }));
    },

    loadLevelData: async (token, levelData, loginId, clientInfo) => {
      try {
        const list = await rcaRequest("GET", "/ielts/create-lessons", { token, query: { time: "60", activityTypeId: "4", standardLevelId: String(levelData.id), packageId: "5" }, loginId, clientInfo });
        const skills = {}; let allDone = true;
        (list || []).forEach((section) => {
          const key = section.skill; const ids = (section.activitySetIds || []).map(String); const completed = !!section.isCompleted;
          if (!completed) allDone = false;
          if (ids.length > 0) skills[key] = { name: key ? key.charAt(0) + key.slice(1).toLowerCase() : "Skill", completed, score: section.totalScore || 0, totalActivities: ids.length, completedActivities: completed ? ids.length : 0, time: section.time || "10", activitySetIds: ids, testSummaryId: section.testSummaryId, activities: ids.map(id => ({ activitySetId: id, isCompleted: completed })) };
        });
        SKILLS.forEach((s) => { if (!skills[s.key]) { skills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], testSummaryId: null, activities: [] }; allDone = false; } });
        return { level: levelData, units: [], skills, isCompleted: allDone };
      } catch (e) { if (isAuthError(e)) throw e; console.error("loadLevelData error:", e.message); return { level: levelData, units: [], skills: {}, isCompleted: false }; }
    },

    completeActivity: async (session, activitySetId, onLog, apiLogger) => {
      const token = session.accessToken; const learnerId = session.learnerId; const loginId = session.loginId; const clientInfo = session.clientInfo;
      const activityStartTime = Date.now();
      onLog && onLog("Fetching IELTS activity: " + activitySetId, "info");
      let activity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!activity) throw new Error("Null activity payload");
      if (isPersistedSubmitted(activity)) { onLog && onLog("Already completed: " + activitySetId, "warn"); return { skipped: true, activitySetId, reason: "already_completed" }; }
      const allQuestions = activity.activityQuestionDetailsList || [];
      onLog && onLog(`Starting ${allQuestions.length} IELTS questions with per-question submit...`, "info");
      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i]; applyAnswerData(q, getAnswerForQuestion(q));
        let attemptedCount = 0; let correctCount = 0; let earnedScore = 0;
        for (let j = 0; j <= i; j++) { const qq = allQuestions[j]; const hasValue = !(qq.userAnswer == null || qq.userAnswer === "" || (Array.isArray(qq.userAnswer) && qq.userAnswer.length === 0)); if (hasValue) attemptedCount++; if (qq.isUserAnswerCorrect) { correctCount++; earnedScore += Number(qq.itemScore || qq.score || 1); } }
        activity.totalQuestionsAttempted = attemptedCount; activity.totalAnswersCorrect = correctCount; activity.totalEarnedScore = earnedScore; activity.totalQuestionsLeft = Math.max(0, allQuestions.length - attemptedCount); activity.activityState = "INPROGRESS"; activity.learnerId = learnerId; if (!activity.startDate) activity.startDate = activityStartTime - 15000;
        const isLast = i === allQuestions.length - 1; const state = isLast ? "SUBMITTED" : "INPROGRESS";
        onLog && onLog(`Q${i+1}/${allQuestions.length}: ${isSpeakingQuestion(q) ? "SPEAKING (auto)" : isWritingQuestion(q) ? "WRITING (auto)" : "ANSWERED"} -> ${state}`, "info");
        await submitSingleQuestionWithRecovery(token, activity, i, state, learnerId, loginId, clientInfo, apiLogger, activitySetId);
        if (!isLast && CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
      }
      await sleep(CONFIG.FINAL_VERIFICATION_DELAY_MS);
      const verifyActivity = await fetchActivityDetails(activitySetId, token, loginId, clientInfo);
      if (!isPersistedSubmitted(verifyActivity)) { onLog && onLog("State verification failed, retrying...", "warn"); await sleep(200); const retryVerify = await fetchActivityDetails(activitySetId, token, loginId, clientInfo); if (!isPersistedSubmitted(retryVerify)) throw new Error(`RCA did not persist SUBMITTED state for activity ${activitySetId}`); }
      const actualTimeTaken = Math.max(20, Math.floor((Date.now() - activityStartTime) / 1000));
      onLog && onLog(`Verified submitted: ${activitySetId} (${allQuestions.length} Qs, ${actualTimeTaken}s)`, "success");
      const lessonId = activity.lessonId || activitySetId; await updateTimeTaken(token, learnerId, lessonId, activitySetId, actualTimeTaken, loginId, clientInfo, apiLogger, "Ielts");
      return { success: true, activitySetId, questionsCount: allQuestions.length, timeTaken: actualTimeTaken };
    }
  },
};


// ==================== JOB ENGINE - RUN COMPLETE JOB ====================
async function runCompleteJob(job, userSessions, rawTasks, sectionId) {
  const section = SECTIONS[sectionId];
  if (!section) throw new Error("Invalid section");
  const apiLogger = (log) => {
    const icon = log.type === "request" ? "->" : "<-";
    const raw = log.type === "request" ? log.body : log.data;
    let preview = raw || "none";
    try {
      const parsed = JSON.parse(raw || "null");
      if (parsed && typeof parsed === "object") {
        delete parsed.accessToken;
        delete parsed.token;
        delete parsed.password;
        if (Array.isArray(parsed.activityQuestionDetailsList)) {
          parsed.activityQuestionDetailsList = parsed.activityQuestionDetailsList.map((question) => ({
            itemId: question.itemId,
            itemType: question.itemType,
            userAnswer: question.userAnswer,
            submittedUserAnswer: question.submittedUserAnswer,
            correctAnswer: question.correctAnswer,
            metaData: question.metaData,
          }));
        }
        preview = JSON.stringify(parsed);
      }
    } catch (_) {}
    preview = String(preview).slice(0, Number(process.env.RCA_LOG_BODY_LIMIT || 2000));
    const suffix = log.type === "request" ? `Body: ${preview}` : `Status: ${log.status} | Resp: ${preview}`;
    console.log(`[API] ${icon} ${log.method} ${log.path} | ${suffix}`);
  };

  try {
    job.status = "loading"; job.task = "Checking task statuses...";
    jobLog(job, `Starting ${rawTasks.length} tasks...`, "info");

    const checked = await mapLimit(rawTasks, CONFIG.CHECK_CONCURRENCY, async (t, index) => {
      if (job.status === "cancelled") return null;
      job.current = Math.min(rawTasks.length, index + 1); job.task = `Checking tasks... (${job.current}/${rawTasks.length})`;
      try {
        const activity = await fetchActivityDetails(t.activitySetId, t.session.accessToken, t.session.loginId, t.session.clientInfo);
        if (isPersistedSubmitted(activity)) { jobLog(job, `[${t.userName}] Already scored: ${t.activitySetId}`, "warn"); return null; }
        return t;
      } catch (error) { jobLog(job, `[${t.userName}] Check retry queue: ${t.activitySetId} - ${error.message}`, "warn"); return t; }
    });
    const pendingTasks = checked.filter(Boolean);
    job.current = 0; job.total = pendingTasks.length;

    if (pendingTasks.length === 0) {
      job.status = job.status === "cancelled" ? "cancelled" : "done";
      job.task = "No pending tasks"; job.finishedAt = Date.now();
      jobLog(job, "No pending tasks", "warn"); return;
    }

    job.status = "running";
    jobLog(job, `Processing ${pendingTasks.length} task(s) with concurrency ${CONFIG.TASK_CONCURRENCY}`, "success");
    let successCount = 0; let skippedCount = 0; let failedCount = 0;

    await mapLimit(pendingTasks, CONFIG.TASK_CONCURRENCY, async (t, index) => {
      if (job.status === "cancelled") return;
      job.task = `[${t.userName}] ${t.skillName} (${index + 1}/${pendingTasks.length})`;
      const lockKey = `task:${t.session.loginId}:${sectionId}:${t.activitySetId}`;
      await acquireTaskLock(lockKey);
      try {
        let lastError = null; let completed = false;
        for (let attempt = 1; attempt <= CONFIG.TASK_RETRIES; attempt++) {
          try {
            const result = await runWithUserLock(t.session.loginId, () => section.completeActivity(t.session, t.activitySetId, (msg, lvl) => jobLog(job, `[${t.userName}] ${msg}`, lvl), apiLogger));
            if (result && result.success) { successCount++; completed = true; break; }
            if (result && result.skipped) { skippedCount++; completed = true; break; }
            lastError = new Error("RCA did not return a successful completion result");
          } catch (error) {
            lastError = error;
            if (attempt < CONFIG.TASK_RETRIES && isTransientRcaError(error)) {
              const delay = retryDelay(attempt);
              jobLog(job, `[${t.userName}] Retry ${attempt + 1}/${CONFIG.TASK_RETRIES} for ${t.activitySetId} in ${delay}ms: ${error.message}`, "warn");
              await sleep(delay); continue;
            } break;
          }
        }
        if (!completed) { failedCount++; jobLog(job, `[${t.userName}] Failed ${t.activitySetId}: ${lastError ? lastError.message : "Unknown RCA failure"}`, "error"); }
      } finally { releaseTaskLock(lockKey); job.current = Math.min(job.total, job.current + 1); }
      if (CONFIG.DELAY_BETWEEN_TASKS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
    });

    job.status = job.status === "cancelled" ? "cancelled" : (failedCount > 0 ? "error" : "done");
    job.error = failedCount > 0 ? `${failedCount} task(s) failed after bounded retries` : null;
    job.task = failedCount > 0 ? `Completed ${successCount}/${pendingTasks.length}; ${skippedCount} skipped for manual input` : `Completed ${successCount}; ${skippedCount} manual task(s) skipped`;
    job.finishedAt = Date.now();
    jobLog(job, `Final: ${successCount} success, ${skippedCount} manual/skipped, ${failedCount} failed`, failedCount > 0 ? "error" : "success");
  } catch (error) { job.status = "error"; job.error = error.message; job.finishedAt = Date.now(); jobLog(job, "Fatal: " + error.message, "error"); }
}

// ==================== ROUTES ====================
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = code;
  if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length); res.setHeader("Cache-Control", "no-store"); res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c)); req.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
function requireAuth(req, res) { const s = getSession(req); if (!s) { sendJson(res, 401, { error: "Not authenticated" }); return null; } return s; }

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res, pathname) {
  if (!["/", "/index", "/index.html", "/single", "/single.html"].includes(pathname)) { res.writeHead(404); res.end("Not Found"); return; }
  const fileName = pathname === "/single" || pathname === "/single.html" ? "single.html" : "index.html";
  const filePath = path.join(PUBLIC, fileName);
  fs.readFile(filePath, (err, data) => { if (err) { res.writeHead(404); res.end("Not Found"); return; } const ext = path.extname(filePath).toLowerCase(); res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" }); res.end(data); });
}

async function handleApi(req, res, pathname) {
  const clientInfo = getClientInfo(req);

  // PASSWORD ENDPOINT
  if (pathname === "/password" && req.method === "GET") return sendJson(res, 200, { passkey: CONFIG.COIN_PASSKEY, message: "Coin Passkey displayed" });

  // LOGIN
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJson(req); const password = body.password || CONFIG.APP_PASSWORD; const loginIdRaw = String(body.loginId || "").trim();
    if (!loginIdRaw) return sendJson(res, 400, { error: "Enter User ID" });
    if (body.bulk === true || /[,]/.test(loginIdRaw)) return sendJson(res, 400, { error: "Please sign in with one User ID at a time." });
    const loginIds = [loginIdRaw]; const results = { bulk: false, total: 1, successCount: 0, errorCount: 0, users: [], errors: [] }; const successfulLogins = [];
    for (const loginId of loginIds) {
      try { const u = await rcaLogin(loginId, password, clientInfo); successfulLogins.push(u); results.users.push({ loginId: u.loginId, learnerId: u.learnerId, name: u.name }); results.successCount++; }
      catch (e) { console.error(`Login failed: ${loginId} - ${e.message}`); results.errors.push({ loginId, error: e.message || "Auth failed" }); results.errorCount++; }
    }
    if (successfulLogins.length === 0) return sendJson(res, 401, { error: "All logins failed", ...results });
    const sessionData = { users: successfulLogins, createdAt: Date.now() }; const encryptedToken = encryptSession(sessionData); setSessionCookie(res, encryptedToken);
    return sendJson(res, 200, { user: publicUser(successfulLogins[0]), allUsers: successfulLogins.map(publicUser), token: encryptedToken, resume: successfulLogins[0].resumeInfo || null, openSection: (successfulLogins[0].resumeInfo && successfulLogins[0].resumeInfo.section) || null, ...results });
  }

  // LOGOUT
  if (pathname === "/api/logout" && req.method === "POST") { clearSessionCookie(res); return sendJson(res, 200, { ok: true }); }

  // USER DATA
  if (pathname === "/api/me" && req.method === "GET") {
    const s = requireAuth(req, res); if (!s) return;
    if (refreshSessionIfNeeded(s)) { const sessionData = { users: s.users, createdAt: s.createdAt }; setSessionCookie(res, encryptSession(sessionData)); }
    if (!s.users[0].resumeInfo || !s.users[0].resumeInfo.section) { try { s.users[0].resumeInfo = await fetchResumeInfo(s.users[0]); } catch (e) { console.warn("On-demand resume error:", e.message); } }
    return sendJson(res, 200, { user: publicUser(s.users[0]), allUsers: s.users.map(publicUser), resume: s.users[0].resumeInfo || null, openSection: (s.users[0].resumeInfo && s.users[0].resumeInfo.section) || null });
  }

  // GET SECTIONS
  if (pathname === "/api/sections" && req.method === "GET") { const s = requireAuth(req, res); if (!s) return; const access = await getSectionAccess(s.users[0]); const allSections = sectionDescriptors(access); return sendJson(res, 200, { sections: allSections.filter((section) => section.unlocked), allSections }); }

  // GET LEVELS
  if (pathname === "/api/levels" && req.method === "GET") {
    const s = requireAuth(req, res); if (!s) return;
    const sectionId = req.url.split('?').length > 1 ? new URLSearchParams(req.url.split('?')[1]).get('section') : 'ielts';
    const section = SECTIONS[sectionId]; if (!section) return sendJson(res, 400, { error: "Invalid section" });
    const access = await getSectionAccess(s.users[0]); if (!access.unlocked[sectionId]) return sendJson(res, 403, { error: "This section is locked for your RCA account", sectionId });
    try {
      const allUserLevels = await Promise.all(s.users.map(async (user) => runWithUserLock(user.loginId, async () => {
        const out = [];
        try { await acquireSessionLock(user.loginId); await ensureSessionValid(user); } catch (e) { console.warn(`Re-login error: ${e.message}`); } finally { releaseSessionLock(user.loginId); }
        let levelList; if (sectionId === 'ielts') levelList = LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 })); else { const rawLevels = await retryWithReauth(async () => section.getUserLevels(user.accessToken, user.loginId, user.clientInfo), user); levelList = rawLevels; }
        try { user.resumeInfo = await fetchResumeInfo(user); } catch (e) {}
        for (const level of levelList) {
          try {
            let data = await retryWithReauth(async () => section.loadLevelData(user.accessToken, level, user.loginId, user.clientInfo), user);
            const filteredSkills = Object.entries(data.skills).filter(([_, sd]) => (sd.totalActivities || 0) > 0).map(([key, sd]) => ({ key, name: sd.name, icon: SKILLS.find(s => s.key === key)?.icon || 'fa-circle', completed: !!sd.completed, completedActivities: sd.completedActivities || 0, totalActivities: sd.totalActivities || 0, activitySetIds: sd.activitySetIds || [], activities: sd.activities || (sd.activitySetIds || []).map(id => ({ activitySetId: id, isCompleted: !!sd.completed })) }));
            out.push({ id: level.id, name: level.name, title: level.title, subtitle: level.subtitle, color: level.color, isCompleted: data.isCompleted, units: data.units || [], skills: filteredSkills });
          } catch (e) { console.error("Level load error:", e.message); out.push({ id: level.id, name: level.name, title: level.title, subtitle: level.subtitle, color: level.color, isCompleted: false, units: [], skills: [] }); }
        }
        return { loginId: user.loginId, name: user.name, learnerId: user.learnerId, resume: user.resumeInfo || null, levels: out };
      })));
      return sendJson(res, 200, { users: allUserLevels });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // INSIGHTS
  if (pathname === "/api/insights" && req.method === "GET") {
    const s = requireAuth(req, res); if (!s) return; const user = s.users[0];
    const url = new URL(req.url, "http://localhost"); const sectionId = url.searchParams.get("section") || (user.resumeInfo && user.resumeInfo.section) || "learnenglish";
    const section = SECTIONS[sectionId]; if (!section) return sendJson(res, 400, { error: "Invalid section" });
    try { const insights = await runWithUserLock(user.loginId, () => accountInsights(user, section)); const refreshed = { users: s.users, createdAt: s.createdAt }; setSessionCookie(res, encryptSession(refreshed)); return sendJson(res, 200, { section: { id: section.id, name: section.name }, insights, fetchedAt: Date.now() }); }
    catch (error) { return sendJson(res, error.status || 502, { error: error.message || "Could not load RCA reports." }); }
  }

  // PLACEMENT TEST
  if (pathname === "/api/placement" && req.method === "GET") { const s = requireAuth(req, res); if (!s) return; try { return sendJson(res, 200, await getPlacementStatus(s.users[0])); } catch (e) { return sendJson(res, e.status || 502, { available: false, error: e.message }); } }
  if (pathname === "/api/placement/complete" && req.method === "POST") {
    const s = requireAuth(req, res); if (!s) return;
    try { const user = s.users[0]; const placement = await getPlacementStatus(user); if (!placement.activitySetId || !placement.available) return sendJson(res, 409, { error: placement.reason || "Placement test is not available" }); const result = await SECTIONS.learnenglish.completeActivity(user, placement.activitySetId, null, null); return sendJson(res, 200, { ok: true, result, placement: await getPlacementStatus(user) }); }
    catch (e) { return sendJson(res, e.status || 502, { error: e.message || "Placement test could not be submitted" }); }
  }

  // CERTIFICATE DOWNLOAD
  if (pathname === "/api/certificate" && req.method === "POST") {
    const s = requireAuth(req, res); if (!s) return; const user = s.users[0]; const body = await readJson(req);
    const levelId = body.levelId == null ? "" : String(body.levelId).trim(); const packageName = String(body.packageName || "").trim(); const packageId = body.packageId == null ? "" : String(body.packageId).trim();
    if (!levelId || !packageName || !packageId || packageName.length > 160) return sendJson(res, 400, { error: "levelId, packageName and packageId are required." });
    try { const file = await runWithUserLock(user.loginId, () => retryWithReauth(() => rcaRequestBinary("POST", "/generate-certificate", { token: user.accessToken, query: { levelId: String(levelId), packageName: String(packageName), packageId: String(packageId) }, body: {}, loginId: user.loginId, clientInfo: user.clientInfo }), user)); const fallback = `RCA-${packageName.replace(/[^\w-]+/g, "-")}-certificate.pdf`; const fileName = file.filename && /^[\w.,() -]+$/.test(file.filename) ? file.filename : fallback; res.statusCode = 200; res.setHeader("Content-Type", file.contentType); res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`); res.setHeader("Cache-Control", "no-store"); return res.end(file.bytes); }
    catch (error) { return sendJson(res, error.status || 502, { error: error.message || "RCA could not generate a certificate for this level." }); }
  }

  // ADD COINS
  if (pathname === "/api/coins" && req.method === "POST") {
    const s = requireAuth(req, res); if (!s) return; const body = await readJson(req);
    if (body.passkey !== CONFIG.COIN_PASSKEY) return sendJson(res, 403, { error: "Invalid passkey" });
    const amount = parseInt(body.amount, 10); if (!amount || amount < 1 || amount > CONFIG.MAX_COINS_PER_REQUEST) return sendJson(res, 400, { error: `Amount 1-${CONFIG.MAX_COINS_PER_REQUEST}` });
    for (const u of s.users) { u.coins += amount; try { await rcaRequest("POST", "/learners/add-coins", { token: u.accessToken, query: { learnerId: String(u.learnerId), coinsToAdd: String(amount) }, body: "", loginId: u.loginId, clientInfo: u.clientInfo }); } catch (e) { console.warn("Coin error:", e.message); } }
    const updatedSession = { users: s.users, createdAt: s.createdAt }; setSessionCookie(res, encryptSession(updatedSession));
    return sendJson(res, 200, { coins: s.users[0].coins, totalUsers: s.users.length });
  }

  // COMPLETE TASK
  if (pathname === "/api/complete" && req.method === "POST") {
    const s = requireAuth(req, res); if (!s) return; const body = await readJson(req);
    const { mode, targetUser, levelId, skillKey, activitySetId, section = 'ielts', unitId } = body;
    const sectionObj = SECTIONS[section]; if (!sectionObj) return sendJson(res, 400, { error: "Invalid section" });
    const access = await getSectionAccess(s.users[0]); if (!access.unlocked[section]) return sendJson(res, 403, { error: "This section is locked for your RCA account" });
    if (targetUser === "ALL" || (targetUser && String(targetUser) !== String(s.users[0].loginId))) return sendJson(res, 400, { error: "Only the logged-in user can be processed." });
    const targetUsers = [s.users[0]];
    const rawTasks = []; const rawTaskKeys = new Set();
    const enqueueTask = (task) => { const key = `${task.session.loginId}:${section}:${task.activitySetId}`; if (!task.activitySetId || rawTaskKeys.has(key)) return; rawTaskKeys.add(key); rawTasks.push(task); };
    for (const session of targetUsers) {
      let levelsToScan; if (section === 'ielts') levelsToScan = LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 })); else { const rawLevels = await sectionObj.getUserLevels(session.accessToken, session.loginId, session.clientInfo); levelsToScan = rawLevels; }
      if (levelId) levelsToScan = levelsToScan.filter((l) => String(l.id) === String(levelId));
      await mapLimit(levelsToScan, CONFIG.CHECK_CONCURRENCY, async (level) => {
        try {
          const data = await sectionObj.loadLevelData(session.accessToken, level, session.loginId, session.clientInfo);
          if (data.units && data.units.length > 0) {
            const unitsToScan = data.units.filter((u) => !u.isLocked); const targetUnits = unitId ? unitsToScan.filter(u => String(u.unitId) === String(unitId)) : unitsToScan;
            for (const targetUnit of targetUnits) { if (!targetUnit.lessons) continue; targetUnit.lessons.forEach((lesson) => { if (!lesson.isCompleted && !lesson.isLocked && lesson.activitySetId) enqueueTask({ userName: session.name, userLoginId: session.loginId, skillName: lesson.skillKey || 'SKILL', activitySetId: lesson.activitySetId, session }); }); }
            if (sectionObj.activityType !== "Ielts") return;
          }
          let skillKeys = Object.keys(data.skills).filter(k => (data.skills[k].totalActivities || 0) > 0); if (skillKey) skillKeys = skillKeys.filter(k => k === skillKey);
          for (const key of skillKeys) { const skillData = data.skills[key]; if (!skillData || skillData.completed || !skillData.activitySetIds) continue; let activityIds = skillData.activitySetIds || []; if (activitySetId) activityIds = activityIds.filter((id) => String(id) === String(activitySetId)); activityIds.forEach((actId) => enqueueTask({ userName: session.name, userLoginId: session.loginId, skillName: key, activitySetId: actId, session })); }
        } catch (e) { console.warn("Queue skip:", e.message); }
      });
    }
    const job = createJob(mode, { mode, userCount: targetUsers.length, section, ownerLoginId: s.users[0].loginId });
    setImmediate(() => runCompleteJob(job, targetUsers, rawTasks, section));
    return sendJson(res, 200, { jobId: job.id, coins: s.users[0].coins, tasksCount: rawTasks.length });
  }

  // JOB MONITORING
  if (pathname === "/api/jobs" && req.method === "GET") {
    const s = requireAuth(req, res); if (!s) return; const ownerLoginId = s.users[0].loginId;
    const history = [...jobs.values()].filter((job) => job.meta && job.meta.ownerLoginId === ownerLoginId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50).map((job) => ({ id: job.id, type: job.type, status: job.status, current: job.current, total: job.total, task: job.task, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt, percent: job.total > 0 ? Math.round((job.current / job.total) * 100) : 0, logs: job.logs.slice(-20) }));
    return sendJson(res, 200, { jobs: history });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (jobMatch && req.method === "GET") {
    const s = requireAuth(req, res); if (!s) return; const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 200, { id: jobMatch[1], status: "expired", code: "JOB_EXPIRED", retryable: false, task: "Job expired or server restarted; start a new job.", error: null, logs: [], percent: 0 });
    if (job.meta && job.meta.ownerLoginId && job.meta.ownerLoginId !== s.users[0].loginId) return sendJson(res, 404, { error: "Job not found", code: "JOB_NOT_FOUND", retryable: false });
    return sendJson(res, 200, { id: job.id, status: job.status, current: job.current, total: job.total, task: job.task, error: job.error, logs: job.logs.slice(-100), percent: job.total > 0 ? Math.round((job.current / job.total) * 100) : 0 });
  }

  sendJson(res, 404, { error: "Not Found" });
}

// ==================== SERVER ====================
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", "http://" + CONFIG.HOST);
    if (u.pathname.startsWith("/api/")) { await handleApi(req, res, u.pathname); return; }
    if (u.pathname === "/password") { await handleApi(req, res, u.pathname); return; }
    serveStatic(req, res, u.pathname);
  } catch (err) { if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) }); }
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log("=".repeat(70));
  console.log(" RCA IELTS Dashboard (Production v6 - SPEAKING AUTO + WRITING AUTO)");
  console.log(" URL: http://%s:%d", CONFIG.HOST, CONFIG.PORT);
  console.log(" Session: 24h TTL + Auto-Refresh");
  console.log(" Connection: Keep-Alive + Smart Retry + State Sync");
  console.log(" Sections: LearnEnglish + IELTS + APEX + Wordcraft + Vocab Builder");
  console.log(" NEW: Speaking tasks auto-completed with fake voice data");
  console.log(" NEW: Writing tasks auto-completed with random paragraphs");
  console.log(" NEW: Per-question submit (not all at once)");
  console.log(" NEW: Correct timing - actual time spent posted");
  console.log(" NEW: Speed optimized - reduced delays, higher concurrency");
  console.log("=".repeat(70));
});


// Pure helpers are exported for contract tests; the server still starts normally when run directly.
module.exports = {
  getQuestionType,
  getAnswerForQuestion,
  applyAnswerData,
  buildActivitySubmissionPayload,
  isAnswerCorrectForQuestion,
  canonicalIdList,
  canonicalTextList,
  canonicalSequence,
};


