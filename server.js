#!/usr/bin/env node
/**
 * RCA IELTS Dashboard – Optimized Edition (FIXED v3)
 * ✓ LearnEnglish Units/Lessons Fixed
 * ✓ Session Refresh (No Expiration on Long Tasks)
 * ✓ Fast Login with Real-time Feedback
 * ✓ Hide Empty 0/0 Activities
 * ✓ Lazy Load Section Data
 * ✓ Better Error Recovery
 * ✓ LearnEnglish: Per-Activity Completion Status
 * ✓ Live API Console Logging for Jobs
 * ✓ Complete All (Level) + Complete All Levels support
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

function detectLessonCompletion(lesson) {
  if (lesson.isCompleted === true || lesson.completed === true) return true;
  if (lesson.progress === 100 || lesson.progress === "100") return true;
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

    // Log API request for live console
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

        // Log API response for live console
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
        const units = await rcaRequest("GET", "/units", {
          token,
          query: { curriculumLevelMappingId: mappingId, packageId: "4" },
          loginId,
          clientInfo,
        });

        const resultUnits = [];
        const allSkills = {};

        for (const unit of units || []) {
          const unitId = unit.id;
          const lessons = await rcaRequest("GET", `/lessons/unit/${unitId}/8/false/${Date.now()}/4`, {
            token,
            loginId,
            clientInfo,
          });

          const unitLessons = [];
          for (const lesson of lessons || []) {
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
            const isComplete = detectLessonCompletion(lesson);

            unitLessons.push({
              lessonId: lesson.id,
              lessonName: lesson.lessonName || lesson.name || "Lesson " + lesson.lessonNumber,
              activitySetId: actId || null,
              skillKey,
              isCompleted: isComplete,
              status: isComplete ? "COMPLETED" : "NEW",
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

      let activity = await rcaRequest("GET", `/activitySetDetails/${activitySetId}/0/${ts}/false`, {
        token,
        loginId,
        clientInfo,
        apiLogger,
      });

      if (!activity) throw new Error("Null activity payload");

      if (activity.activityState === "SUBMITTED" || activity.isCompleted === true) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);
      if (allAlreadyCorrect) {
        onLog && onLog("All questions correct: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "all_questions_done" };
      }

      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);

      onLog && onLog("✓ Completed: " + activitySetId + " (" + allQuestions.length + " Qs)", "success");

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

      let activity = await rcaRequest("GET", `/activitySetDetails/${activitySetId}/0/${ts}/false`, {
        token,
        loginId,
        clientInfo,
        apiLogger,
      });

      if (!activity) throw new Error("Null activity payload");

      if (activity.activityState === "SUBMITTED" || activity.isCompleted === true) {
        onLog && onLog("Already completed: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "already_completed" };
      }

      const allQuestions = activity.activityQuestionDetailsList || [];
      const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);
      if (allAlreadyCorrect) {
        onLog && onLog("All questions correct: " + activitySetId, "warn");
        return { skipped: true, activitySetId, reason: "all_questions_done" };
      }

      activity = fillAnswers(activity);
      activity.activityState = "INPROGRESS";
      activity.learnerId = learnerId;
      activity.startDate = Date.now() - 25000;

      await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, apiLogger);
      activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, apiLogger);

      onLog && onLog("✓ Completed IELTS: " + activitySetId + " (" + allQuestions.length + " Qs)", "success");

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
  let alreadyDoneCount = 0;
  const list = activity.activityQuestionDetailsList || [];

  list.forEach((q) => {
    if (q.userAnswer != null && q.isUserAnswerCorrect === true) {
      alreadyDoneCount++;
      correctCount++;
      return;
    }
    if (q.answerType === "ESSAY") {
      q.userAnswer = "Good essay";
      q.essaySubmittedToGyan = false;
      correctCount++;
      return;
    }

    const ans = pickCorrectAnswer(q);
    if (ans != null && ans !== "") {
      q.userAnswer = ans;
      const opts = q.activityAnswerDTO || [];
      const matched = opts.find((o) => o.id == ans);
      q.isUserAnswerCorrect = matched ? !!matched.isCorrect : String(ans) === String(q.correctAnswer);
      if (q.isUserAnswerCorrect) correctCount++;
    } else {
      q.userAnswer = null;
      q.isUserAnswerCorrect = false;
    }
    q.allAnswersRecorded = true;
  });

  activity.totalQuestionsAttempted = list.length;
  activity.totalAnswersCorrect = correctCount;
  activity.totalEarnedScore = correctCount;
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

// ==================== LOGIN ====================
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

      return {
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

  // API Logger for live console
  const apiLogger = (log) => {
    const icon = log.type === "request" ? "→" : "←";
    const msg = log.type === "request"
      ? `${icon} ${log.method} ${log.path} | Body: ${log.body ? log.body.substring(0, 120) + "..." : "none"}`
      : `${icon} ${log.method} ${log.path} | Status: ${log.status} | Resp: ${log.data ? log.data.substring(0, 120) + "..." : "none"}`;
    jobLog(job, `[API] ${msg}`, "api");
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
        const activity = await rcaRequest("GET", `/activitySetDetails/${t.activitySetId}/0/${Date.now()}/false`, {
          token: t.session.accessToken,
          loginId: t.session.loginId,
          clientInfo: t.session.clientInfo,
          apiLogger,
        });

        const alreadyDone = activity && (
          activity.activityState === "SUBMITTED" ||
          activity.activityState === "COMPLETED" ||
          activity.isCompleted === true
        );

        const allQuestions = activity.activityQuestionDetailsList || [];
        const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);

        if (!alreadyDone && !allAlreadyCorrect) {
          pendingTasks.push(t);
        }
      } catch (e) {
        jobLog(job, `[${t.userName}] Check error, marking as pending: ${t.activitySetId}`, "warn");
        pendingTasks.push(t);
      }
    }

    job.current = 0;
    job.total = pendingTasks.length;

    if (pendingTasks.length === 0) {
      job.status = "done";
      job.task = "All tasks already completed ✓";
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

      try {
        await section.completeActivity(t.session, t.activitySetId, (msg, lvl) => jobLog(job, `[${t.userName}] ${msg}`, lvl), apiLogger);
      } catch (err) {
        jobLog(job, `[${t.userName}] Error: ${err.message}`, "error");
      }

      job.current = i + 1;
      if (CONFIG.DELAY_BETWEEN_TASKS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
    }

    job.status = job.status === "cancelled" ? "cancelled" : "done";
    job.task = `Completed ${pendingTasks.length} tasks ✓`;
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

const ROUTES = {
  "/": "index.html",
  "/single": "single.html",
  "/bulk": "bulk.html"
};

function serveStatic(req, res, pathname) {
  let filePath;
  if (ROUTES[pathname]) {
    filePath = path.join(PUBLIC, ROUTES[pathname]);
  } else {
    filePath = path.resolve(PUBLIC, pathname.replace(/^\/+/, ""));
  }

  if (!filePath.startsWith(path.resolve(PUBLIC))) {
    res.writeHead(403); res.end("Access Denied"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  const clientInfo = getClientInfo(req);

  // LOGIN
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const password = body.password || CONFIG.APP_PASSWORD;
    const loginIdRaw = String(body.loginId || "").trim();
    const isBulk = body.bulk === true;
    const loginIds = loginIdRaw.split(/,|，/).map((id) => id.trim()).filter(Boolean);

    if (!loginIds.length) return sendJson(res, 400, { error: "Enter User ID" });
    if (isBulk && loginIds.length > CONFIG.MAX_BULK_USERS) {
      return sendJson(res, 400, { error: `Max ${CONFIG.MAX_BULK_USERS} IDs` });
    }

    const results = { bulk: isBulk, total: loginIds.length, successCount: 0, errorCount: 0, users: [], errors: [] };
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
    return sendJson(res, 200, { user: publicUser(s.users[0]), allUsers: s.users.map(publicUser) });
  }

  // GET SECTIONS
  if (pathname === "/api/sections" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const list = Object.values(SECTIONS).map(sec => ({
      id: sec.id,
      name: sec.name,
      description: sec.description,
    }));
    return sendJson(res, 200, { sections: list });
  }

  // GET LEVELS for a section (LAZY LOAD)
  if (pathname === "/api/levels" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const sectionId = req.url.split('?').length > 1 ? new URLSearchParams(req.url.split('?')[1]).get('section') : 'ielts';
    const section = SECTIONS[sectionId];
    if (!section) return sendJson(res, 400, { error: "Invalid section" });

    try {
      const allUserLevels = await Promise.all(
        s.users.map(async (user) => {
          const out = [];
          let levelList;
          if (sectionId === 'ielts') {
            levelList = LEVEL_META.map((meta, idx) => ({ ...meta, id: idx + 4 }));
          } else {
            const rawLevels = await section.getUserLevels(user.accessToken, user.loginId, user.clientInfo);
            levelList = rawLevels;
          }

          for (const level of levelList) {
            try {
              const data = await section.loadLevelData(user.accessToken, level, user.loginId, user.clientInfo);

              // Filter out 0/0 skills but keep activities with completion status
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
          return { loginId: user.loginId, name: user.name, learnerId: user.learnerId, levels: out };
        })
      );
      return sendJson(res, 200, { users: allUserLevels });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
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

    let targetUsers = s.users;
    if (targetUser && targetUser !== "ALL") {
      targetUsers = s.users.filter((u) => u.loginId === String(targetUser));
    }
    if (!targetUsers.length) return sendJson(res, 400, { error: "No target user" });

    const rawTasks = [];
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

          // If unitId is provided (LearnEnglish), only queue tasks from that unit
          if (unitId && data.units && data.units.length > 0) {
            const targetUnit = data.units.find(u => String(u.unitId) === String(unitId));
            if (targetUnit && targetUnit.lessons) {
              targetUnit.lessons.forEach((lesson) => {
                if (!lesson.isCompleted && lesson.activitySetId) {
                  rawTasks.push({
                    userName: session.name,
                    userLoginId: session.loginId,
                    skillName: lesson.skillKey || 'SKILL',
                    activitySetId: lesson.activitySetId,
                    session,
                  });
                }
              });
            }
            continue;
          }

          let skillKeys = Object.keys(data.skills).filter(k => (data.skills[k].totalActivities || 0) > 0);
          if (skillKey) skillKeys = skillKeys.filter(k => k === skillKey);

          for (const key of skillKeys) {
            const skillData = data.skills[key];
            if (!skillData || skillData.completed || !skillData.activitySetIds) continue;

            let activityIds = skillData.activitySetIds || [];
            if (activitySetId) {
              activityIds = activityIds.filter((id) => String(id) === String(activitySetId));
            }

            activityIds.forEach((actId) => {
              rawTasks.push({
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

    const job = createJob(mode, { mode, userCount: targetUsers.length, section });
    setImmediate(() => runCompleteJob(job, targetUsers, rawTasks, section));

    return sendJson(res, 200, {
      jobId: job.id,
      coins: s.users[0].coins,
      tasksCount: rawTasks.length
    });
  }

  // JOB MONITORING
  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (jobMatch && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });
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
    serveStatic(req, res, u.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log("=".repeat(70));
  console.log(" 🚀 RCA IELTS Dashboard (Optimized v3 - Live Console Edition)");
  console.log(" 📍 URL: http://%s:%d", CONFIG.HOST, CONFIG.PORT);
  console.log(" 🔒 Session: 24h TTL + Auto-Refresh");
  console.log(" ⚡ Connection: Keep-Alive + Smart Retry");
  console.log(" 📚 Sections: LearnEnglish + IELTS");
  console.log(" 📡 Live API Console: Enabled");
  console.log(" ✅ Complete All Level + Complete All Levels: Supported");
  console.log("=".repeat(70));
});
