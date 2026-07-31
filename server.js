#!/usr/bin/env node
/**
 * RCA IELTS Dashboard – Proxy-Only Edition (No Direct Fallback)
 * Routes: / (Home), /single (Single User), /bulk (Bulk 5-User)
 * Features: No task delays, No coin cost, Real client headers, Skip done questions,
 *           4 Proxy rotation ONLY (no fallback), Prefetch filtering
 */

"use strict";

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ==================== PROXY CONFIGURATION ====================
const PROXY_POOL = [
  { host: "p.webshare.io", port: 80, auth: { user: "hicpsinw-rotate", pass: "ywkvmkka7p5" } },
  { host: "p.webshare.io", port: 80, auth: { user: "izoustos-rotate", pass: "fyqvtcyw4tg0" } },
  { host: "p.webshare.io", port: 80, auth: { user: "coyygzup-rotate", pass: "qwjxinyubv4t" } },
  { host: "p.webshare.io", port: 80, auth: { user: "zledclhf-rotate", pass: "24bnj7l970ip" } },
];

let proxyRoundRobinIndex = 0;

function getProxyOrder() {
  const ordered = [];
  for (let i = 0; i < PROXY_POOL.length; i++) {
    ordered.push(PROXY_POOL[(proxyRoundRobinIndex + i) % PROXY_POOL.length]);
  }
  proxyRoundRobinIndex++;
  return ordered;
}

function createProxyConnection(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: {
        "Host": `${targetHost}:${targetPort}`,
        ...(proxy.auth ? {
          "Proxy-Authorization": "Basic " + Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString("base64")
        } : {})
      }
    });

    proxyReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket: socket,
        servername: targetHost,
        rejectUnauthorized: false
      }, () => {
        resolve(tlsSocket);
      });
      tlsSocket.on("error", reject);
    });

    proxyReq.on("error", reject);
    proxyReq.end();
  });
}

const connMeta = { mode: "proxy", proxyUser: null };

// ==================== CONFIGURATION ====================
const CONFIG = {
  HOST: "127.0.0.1",
  PORT: 8765,
  API_BASE: "https://api-rca.englishhelper.com:8443/RcaServer/api",
  PACKAGE_ID: 5,
  ACTIVITY_TYPE_ID: 4,
  CURRICULUM_ID: 21,
  APP_PASSWORD: "Password",
  COIN_PASSKEY: "MyselfAnkit",
  DELAY_BETWEEN_QUESTIONS_MS: 0,
  DELAY_BETWEEN_TASKS_MS: 0,
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  MAX_BULK_USERS: 5,
  MAX_COINS_PER_REQUEST: 500
};

const LEVELS = [
  { id: 4, name: "A1", title: "Beginner", subtitle: "Foundation Level", color: "a1" },
  { id: 5, name: "A2", title: "Elementary", subtitle: "Basic Communication", color: "a2" },
  { id: 6, name: "B1", title: "Intermediate", subtitle: "Independent User", color: "b1" },
  { id: 7, name: "B2", title: "Upper Intermediate", subtitle: "Fluent Communication", color: "b2" },
  { id: 8, name: "C1", title: "Advanced", subtitle: "Proficient User", color: "c1" },
  { id: 9, name: "C2", title: "Mastery", subtitle: "Expert Level", color: "c2" },
];

const SKILLS = [
  { key: "LISTENING", name: "Listening", icon: "fa-headphones" },
  { key: "SPEAKING", name: "Speaking", icon: "fa-microphone" },
  { key: "WRITING", name: "Writing", icon: "fa-pen" },
  { key: "READING", name: "Reading", icon: "fa-book-open" },
];

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");

const sessions = new Map();
const jobs = new Map();

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== CLIENT INFO (Real IP/UA from Frontend) ====================
function getClientInfo(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(",")[0].trim() : (req.socket.remoteAddress || "127.0.0.1");
  return {
    ip,
    ua: req.headers["x-client-ua"] || req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    screen: req.headers["x-client-screen"] || "1920x1080",
    timezone: req.headers["x-client-timezone"] || "Asia/Kolkata",
    lang: req.headers["x-client-lang"] || "en-US",
    platform: req.headers["x-client-platform"] || "Win32",
  };
}

// ==================== UNIQUE HEADERS PER USER (with real client data) ====================
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

// ==================== HTTPS CLIENT (Proxy-Only, No Fallback) ====================
function executeRequest(opts, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.request(opts, (res) => {
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

        if (res.statusCode >= 400) {
          console.error(`[RCA API ERROR] Path: ${opts.path} | Code: ${res.statusCode} | Raw: ${raw}`);
          const err = new Error((data && (data.message || data.error)) || raw || "HTTP " + res.statusCode);
          err.status = res.statusCode;
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });

    req.on("error", (e) => {
      console.error(`[RCA Network Error] ${e.message}`);
      reject(e);
    });

    req.setTimeout(30000, () => req.destroy(new Error("RCA Network Timeout")));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function rcaRequest(method, apiPath, { token, body, query, loginId, clientInfo, useProxy = true } = {}) {
  return new Promise(async (resolve, reject) => {
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
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 8443,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers,
      rejectUnauthorized: false,
    };

    // ===== PROXY-ONLY: No direct fallback =====
    const proxyOrder = getProxyOrder();
    const attempts = [...proxyOrder]; // Sirf proxies, direct nahi

    let lastError;

    for (const proxy of attempts) {
      try {
        let requestOpts = { ...opts };
        const socket = await createProxyConnection(proxy, opts.hostname, opts.port || 8443);
        requestOpts.createConnection = () => socket;
        const data = await executeRequest(requestOpts, payload);
        connMeta.mode = "proxy";
        connMeta.proxyUser = proxy.auth.user;
        resolve(data);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`[Connection Fail] ${proxy.auth.user}@${proxy.host}: ${e.message}`);
      }
    }

    reject(lastError || new Error("All proxy attempts failed"));
  });
}

// ==================== SESSION MANAGEMENT ====================
function getSession(req) {
  let sid = null;

  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (m) sid = decodeURIComponent(m[1]);

  if (!sid) sid = req.headers["x-auth-token"] || null;

  if (!sid && req.headers["authorization"]) {
    const auth = req.headers["authorization"];
    if (auth.startsWith("Bearer ")) sid = auth.slice(7);
  }

  if (!sid) return null;

  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > CONFIG.SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...s };
}

function setSessionCookie(res, sid) {
  const cookieVal = "sid=" + encodeURIComponent(sid) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(CONFIG.SESSION_TTL_MS / 1000);
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

function publicUser(u) {
  return { loginId: u.loginId, learnerId: u.learnerId, name: u.name, coins: u.coins };
}

// ==================== RCA AUTOMATION ====================
async function rcaLogin(loginId, userPassword, clientInfo) {
  const reqPassword = userPassword || CONFIG.APP_PASSWORD;
  console.log(`[Attempting Login] ID: ${loginId} | IP: ${clientInfo ? clientInfo.ip : "unknown"}`);

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
    useProxy: true,
  });

  if (!loginRes || (!loginRes.accessToken && !loginRes.token)) {
    throw new Error("Invalid response received from RCA server");
  }

  const token = loginRes.accessToken || loginRes.token;
  let details = {};
  try {
    details = await rcaRequest("POST", "/userDetails?inputKeywordList=0", { token, body: "", loginId, clientInfo, useProxy: true });
  } catch (e) {
    console.warn(`[UserDetails Warning] ${e.message}`);
  }

  return {
    accessToken: token,
    loginId: String(loginId).trim(),
    learnerId: details.learnerId || loginRes.learnerId || String(loginId),
    userId: details.authorizedUserId || loginRes.userId || String(loginId),
    name: [details.firstName, details.lastName].filter(Boolean).join(" ").trim() || "User " + loginId,
    coins: details.totalCoins || 0,
    packageId: details.packageId || CONFIG.PACKAGE_ID,
    curriculumId: details.curriculumId || CONFIG.CURRICULUM_ID,
    clientInfo,
  };
}

async function loadLevelData(token, level, loginId, clientInfo, useProxy = true) {
  const list = await rcaRequest("GET", "/ielts/create-lessons", {
    token,
    query: {
      time: "60",
      activityTypeId: String(CONFIG.ACTIVITY_TYPE_ID),
      standardLevelId: String(level.id),
      packageId: String(CONFIG.PACKAGE_ID),
    },
    loginId,
    clientInfo,
    useProxy,
  });
  const skills = {};
  let allDone = true;
  (list || []).forEach((section) => {
    const key = section.skill;
    const ids = (section.activitySetIds || []).map(String);
    const completed = !!section.isCompleted;
    if (!completed) allDone = false;
    skills[key] = {
      name: key ? key.charAt(0) + key.slice(1).toLowerCase() : "Skill",
      completed,
      score: section.totalScore || 0,
      totalActivities: ids.length,
      completedActivities: completed ? ids.length : 0,
      time: section.time || "10",
      activitySetIds: ids,
      testSummaryId: section.testSummaryId,
    };
  });
  SKILLS.forEach((s) => {
    if (!skills[s.key]) {
      skills[s.key] = { name: s.name, completed: false, score: 0, totalActivities: 0, completedActivities: 0, time: "10", activitySetIds: [], testSummaryId: null };
      allDone = false;
    }
  });
  return { level, skills, testSummaryId: (list && list[0] && list[0].testSummaryId) || null, isCompleted: allDone };
}

function pickCorrectAnswer(q) {
  const opts = q.activityAnswerDTO || [];
  const correct = opts.find((o) => o.isCorrect === true);
  if (correct) return correct.id;
  if (q.correctAnswer != null && q.correctAnswer !== "") {
    const n = Number(q.correctAnswer);
    return isNaN(n) ? q.correctAnswer : n;
  }
  if (q.itemType === "FIB" || q.itemType === "FILLINBLANK") return q.correctAnswer || "";
  if (opts.length) return opts[0].id;
  return null;
}

// ==================== PARTIAL COMPLETION FIX ====================
function fillAnswers(activity) {
  const list = activity.activityQuestionDetailsList || [];
  let correctCount = 0;
  let alreadyDoneCount = 0;

  list.forEach((q) => {
    // ===== SKIP ALREADY CORRECT QUESTIONS =====
    if (q.isUserAnswerCorrect === true && q.userAnswer != null) {
      correctCount++;
      alreadyDoneCount++;
      q.allAnswersRecorded = true;
      return;
    }

    if (q.itemType === "IELTSWRITING" || q.itemType === "WRITING") {
      q.userEssay = "In today's world, consistency and focused preparation form the core foundation for achieving strong scores in IELTS examinations.";
      q.isUserAnswerCorrect = true;
      q.userAnswer = null;
      q.isSubmitClicked = true;
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

  console.log(`[FillAnswers] Total Qs: ${list.length}, Already Correct: ${alreadyDoneCount}, Newly Filled: ${list.length - alreadyDoneCount}`);

  activity.totalQuestionsAttempted = list.length;
  activity.totalAnswersCorrect = correctCount;
  activity.totalEarnedScore = correctCount;
  return activity;
}

async function submitActivity(token, activity, state, learnerId, loginId, clientInfo, useProxy = true) {
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
  await rcaRequest("POST", "/activity/data", { token, body: payload, loginId, clientInfo, useProxy });
  return payload;
}

async function updateTimeTaken(token, learnerId, lessonId, activitySetId, secs, loginId, clientInfo, useProxy = true) {
  try {
    await rcaRequest("POST", "/update-user-time-taken", {
      token,
      query: {
        lessonId: String(lessonId),
        activitySetId: String(activitySetId),
        timeInSecs: String(secs),
        learnerId: String(learnerId),
        activityType: "Ielts",
      },
      body: "",
      loginId,
      clientInfo,
      useProxy,
    });
  } catch (e) {
    console.warn("Time sync error:", e.message);
  }
}

async function completeOneActivity(session, activitySetId, onLog, useProxy = true) {
  const token = session.accessToken;
  const learnerId = session.learnerId;
  const loginId = session.loginId;
  const clientInfo = session.clientInfo;
  const ts = Date.now();
  onLog && onLog("Fetching Activity: " + activitySetId, "info");

  let activity = await rcaRequest("GET", "/activitySetDetails/" + activitySetId + "/0/" + ts + "/false", { 
    token, loginId, clientInfo, 
    useProxy: true 
  });
  if (!activity) throw new Error("Null activity payload for ID " + activitySetId);

  // ===== SKIP FULLY COMPLETED ACTIVITY =====
  const alreadyDone = activity.activityState === "SUBMITTED" ||
                      activity.activityState === "COMPLETED" ||
                      activity.isCompleted === true;
  if (alreadyDone) {
    onLog && onLog("Already completed (" + (activity.activityState || "done") + "), skipping: " + activitySetId, "warn");
    return { skipped: true, activitySetId, reason: "already_completed" };
  }

  // ===== SKIP IF ALL QUESTIONS ALREADY CORRECT =====
  const allQuestions = activity.activityQuestionDetailsList || [];
  const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);
  if (allAlreadyCorrect) {
    onLog && onLog("All questions already correct, skipping: " + activitySetId, "warn");
    return { skipped: true, activitySetId, reason: "all_questions_done" };
  }

  activity.activityState = "INPROGRESS";
  activity.learnerId = learnerId;
  activity.startDate = Date.now() - 25000;

  try {
    await submitActivity(token, activity, "INPROGRESS", learnerId, loginId, clientInfo, useProxy);
  } catch (e) {
    onLog && onLog("State sync warning: " + e.message, "error");
  }

  activity = fillAnswers(activity);
  const qCount = allQuestions.length;

  if (CONFIG.DELAY_BETWEEN_QUESTIONS_MS > 0 && qCount > 0) {
    await sleep(CONFIG.DELAY_BETWEEN_QUESTIONS_MS);
  }

  activity = await submitActivity(token, activity, "SUBMITTED", learnerId, loginId, clientInfo, useProxy);
  onLog && onLog("Completed Set " + activitySetId + " (" + qCount + " Qs, " + (allAlreadyCorrect ? "0 new" : "filled") + ")", "success");

  const lessonId = activity.lessonId || activitySetId;
  await updateTimeTaken(token, learnerId, lessonId, activitySetId, activity.totalTimeTaken || 30, loginId, clientInfo, true);
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
  if (job.logs.length > 250) job.logs.shift();
}

async function runCompleteJob(job, userSessions, rawTasks) {
  try {
    // ===== PHASE 1: Prefetch & Filter (proxy-only) =====
    job.status = "loading";
    job.task = "Loading tasks...";
    jobLog(job, "Prefetching activity statuses to skip already completed ones...", "info");

    const pendingTasks = [];
    const totalToCheck = rawTasks.length;

    for (let i = 0; i < rawTasks.length; i++) {
      if (job.status === "cancelled") break;
      const t = rawTasks[i];
      job.current = i;
      job.total = totalToCheck;
      job.task = `Loading tasks... (${i + 1}/${totalToCheck})`;

      try {
        const activity = await rcaRequest("GET", `/activitySetDetails/${t.activitySetId}/0/${Date.now()}/false`, {
          token: t.session.accessToken,
          loginId: t.session.loginId,
          clientInfo: t.session.clientInfo,
          useProxy: true,
        });

        const alreadyDone = activity && (
          activity.activityState === "SUBMITTED" ||
          activity.activityState === "COMPLETED" ||
          activity.isCompleted === true
        );

        const allQuestions = activity.activityQuestionDetailsList || [];
        const allAlreadyCorrect = allQuestions.length > 0 && allQuestions.every(q => q.isUserAnswerCorrect === true && q.userAnswer != null);

        if (alreadyDone || allAlreadyCorrect) {
          jobLog(job, `[${t.userName}] Already done, skipping: ${t.activitySetId}`, "warn");
        } else {
          pendingTasks.push(t);
        }
      } catch (e) {
        jobLog(job, `[${t.userName}] Prefetch error for ${t.activitySetId}: ${e.message}, treating as pending`, "warn");
        pendingTasks.push(t);
      }
    }

    // ===== PHASE 2: Execute only pending tasks =====
    job.current = 0;
    job.total = pendingTasks.length;

    if (pendingTasks.length === 0) {
      job.status = "done";
      job.task = "All tasks already completed. Nothing to do.";
      job.finishedAt = Date.now();
      return;
    }

    job.status = "running";
    jobLog(job, `Starting ${pendingTasks.length} pending tasks (skipped ${rawTasks.length - pendingTasks.length} already done)`, "success");

    for (let i = 0; i < pendingTasks.length; i++) {
      if (job.status === "cancelled") break;
      const t = pendingTasks[i];
      job.current = i;
      job.task = `[${t.userName}] ${t.skillName} -> ${t.activitySetId}`;
      try {
        const result = await completeOneActivity(t.session, t.activitySetId, (msg, lvl) => jobLog(job, `[${t.userName}] ${msg}`, lvl), true);
        if (result && result.skipped) {
          jobLog(job, `[${t.userName}] Skipped ${t.activitySetId} (${result.reason})`, "warn");
        }
      } catch (err) {
        jobLog(job, `[${t.userName}] Error on ${t.activitySetId}: ${err.message}`, "error");
      }
      job.current = i + 1;
      if (CONFIG.DELAY_BETWEEN_TASKS_MS > 0) await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
    }

    job.status = job.status === "cancelled" ? "cancelled" : "done";
    job.task = `Completed ${pendingTasks.length} tasks (${rawTasks.length - pendingTasks.length} skipped)`;
    job.finishedAt = Date.now();
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    jobLog(job, "Fatal Engine Error: " + err.message, "error");
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
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("Invalid JSON formatting")); }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) { sendJson(res, 401, { error: "Authentication session expired" }); return null; }
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
    filePath = path.resolve(PUBLIC, pathname.replace(/^\/+/ , ""));
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

    if (!loginIds.length) return sendJson(res, 400, { error: "Enter at least one User ID" });
    if (isBulk && loginIds.length > CONFIG.MAX_BULK_USERS) {
      return sendJson(res, 400, { error: `Maximum ${CONFIG.MAX_BULK_USERS} IDs allowed per batch.` });
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
        console.error(`Login error for ID ${loginId}: ${e.message}`);
        results.errors.push({ loginId, error: e.message || "Authentication failed" });
        results.errorCount++;
      }
    }

    if (successfulLogins.length === 0) {
      const detailedErr = results.errors.map(x => `${x.loginId}: ${x.error}`).join(" | ");
      return sendJson(res, 401, { error: `Auth Failed (${detailedErr})`, ...results });
    }

    const sid = uuid();
    sessions.set(sid, { users: successfulLogins, createdAt: Date.now() });
    setSessionCookie(res, sid);

    return sendJson(res, 200, {
      user: publicUser(successfulLogins[0]),
      allUsers: successfulLogins.map(publicUser),
      token: sid,
      connection: { mode: connMeta.mode, proxy: connMeta.proxyUser },
      ...results,
    });
  }

  // LOGOUT
  if (pathname === "/api/logout" && req.method === "POST") {
    const s = getSession(req);
    if (s) sessions.delete(s.sid);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // USER DATA
  if (pathname === "/api/me" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    return sendJson(res, 200, { user: publicUser(s.users[0]), allUsers: s.users.map(publicUser) });
  }

  // GET LEVELS
  if (pathname === "/api/levels" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    try {
      const allUserLevels = await Promise.all(
        s.users.map(async (user) => {
          const out = [];
          for (const level of LEVELS) {
            try {
              const data = await loadLevelData(user.accessToken, level, user.loginId, user.clientInfo, true);
              out.push({
                id: level.id,
                name: level.name,
                title: level.title,
                subtitle: level.subtitle,
                color: level.color,
                isCompleted: data.isCompleted,
                skills: SKILLS.map((sk) => {
                  const sd = data.skills[sk.key] || {};
                  return {
                    key: sk.key,
                    name: sk.name,
                    icon: sk.icon,
                    completed: !!sd.completed,
                    completedActivities: sd.completedActivities || 0,
                    totalActivities: sd.totalActivities || 0,
                    activitySetIds: sd.activitySetIds || [],
                  };
                }),
              });
            } catch (e) {
              out.push({ id: level.id, name: level.name, title: level.title, subtitle: level.subtitle, color: level.color, isCompleted: false, error: e.message, skills: [] });
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
    if (body.passkey !== CONFIG.COIN_PASSKEY) return sendJson(res, 403, { error: "Invalid Passkey" });
    const amount = parseInt(body.amount, 10);
    if (!amount || amount < 1 || amount > CONFIG.MAX_COINS_PER_REQUEST) return sendJson(res, 400, { error: `Amount must be 1-${CONFIG.MAX_COINS_PER_REQUEST}` });

    for (const u of s.users) {
      u.coins += amount;
      try {
        await rcaRequest("POST", "/learners/add-coins", {
          token: u.accessToken,
          query: { learnerId: String(u.learnerId), coinsToAdd: String(amount) },
          body: "",
          loginId: u.loginId,
          clientInfo: u.clientInfo,
          useProxy: true,
        });
      } catch (e) { console.warn("Coin credit error:", e.message); }
    }
    sessions.set(s.sid, s);
    return sendJson(res, 200, { coins: s.users[0].coins, totalUsers: s.users.length });
  }

  // COMPLETE TASK
  if (pathname === "/api/complete" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const body = await readJson(req);
    const { mode, targetUser, levelId, skillKey, activitySetId } = body;

    let targetUsers = s.users;
    if (targetUser && targetUser !== "ALL") {
      targetUsers = s.users.filter((u) => u.loginId === String(targetUser));
    }
    if (!targetUsers.length) return sendJson(res, 400, { error: "Target User not active" });

    const rawTasks = [];
    for (const session of targetUsers) {
      let levelsToScan = LEVELS;
      if (levelId) levelsToScan = LEVELS.filter((l) => l.id === Number(levelId));

      for (const level of levelsToScan) {
        try {
          const data = await loadLevelData(session.accessToken, level, session.loginId, session.clientInfo, true);
          let skillKeys = SKILLS.map((s) => s.key);
          if (skillKey) skillKeys = [skillKey];

          for (const key of skillKeys) {
            const skillData = data.skills[key];
            if (!skillData || skillData.completed) continue;

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
        } catch (e) { console.warn("Queue construction skip:", e.message); }
      }
    }

    const job = createJob(mode, { mode, userCount: targetUsers.length });
    setImmediate(() => runCompleteJob(job, targetUsers, rawTasks));

    return sendJson(res, 200, { 
      jobId: job.id, 
      coins: s.users[0].coins, 
      tasksCount: rawTasks.length,
      connection: { mode: connMeta.mode, proxy: connMeta.proxyUser }
    });
  }

  // JOB MONITORING
  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (jobMatch && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job instance lost" });
    return sendJson(res, 200, {
      id: job.id,
      status: job.status,
      current: job.current,
      total: job.total,
      task: job.task,
      error: job.error,
      logs: job.logs.slice(-50),
      percent: job.total > 0 ? Math.round((job.current / job.total) * 100) : 0,
    });
  }

  sendJson(res, 404, { error: "API Route Not Found" });
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
  console.log("=".repeat(60));
  console.log(" RCA IELTS Dashboard PROXY-ONLY (No Direct Fallback)");
  console.log(" URL: http://%s:%d", CONFIG.HOST, CONFIG.PORT);
  console.log(" Modes: / (Home) | /single (1 User) | /bulk (5 Users)");
  console.log(" Proxies: " + PROXY_POOL.length + " configured (rotating only)");
  console.log("=".repeat(60));
});
