#!/usr/bin/env node
/**
 * RCA IELTS Dashboard – secure backend
 *
 * - All English Helper API calls, tokens, answer-filling stay on the server
 * - Browser only talks to this server (session cookie)
 * - Serves a thin UI from /public
 *
 * Usage:
 *   node server.js
 *   Open http://127.0.0.1:8765
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// ==================== CONFIG (server-only secrets) ====================
const CONFIG = {
  HOST: "127.0.0.1",
  PORT: 8765,
  API_BASE: "https://api-rca.englishhelper.com:8443/RcaServer/api",
  PACKAGE_ID: 5,
  ACTIVITY_TYPE_ID: 4,
  CURRICULUM_ID: 21,
  APP_PASSWORD: "Password", // RCA login password
  COIN_PASSKEY: "MyselfAnkit",
  DELAY_BETWEEN_ANSWERS_MS: 1000,
  DELAY_BETWEEN_TASKS_MS: 2000,
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
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

// sessionId -> { accessToken, loginId, learnerId, userId, name, coins, createdAt }
const sessions = new Map();
// jobId -> job state for long-running complete tasks
const jobs = new Map();

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== HTTPS client to RCA API ====================
function rcaRequest(method, apiPath, { token, body, query } = {}) {
  return new Promise((resolve, reject) => {
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

    const headers = {
      Accept: "application/json, text/plain, */*",
      Origin: "https://rca.englishhelper.com",
      Referer: "https://rca.englishhelper.com/",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36",
      "x-request-id": uuid(),
      "x-journey-id": uuid(),
    };
    if (token) headers.Authorization = "Bearer " + token;
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const url = new URL(CONFIG.API_BASE + pathStr);
    const opts = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = raw;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (_) {}
        if (res.statusCode >= 400) {
          const err = new Error(
            (data && data.message) || raw || "HTTP " + res.statusCode
          );
          err.status = res.statusCode;
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("RCA timeout")));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ==================== Session helpers ====================
function getSession(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const sid = decodeURIComponent(m[1]);
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > CONFIG.SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...s };
}

function setSessionCookie(res, sid) {
  res.setHeader(
    "Set-Cookie",
    "sid=" +
      encodeURIComponent(sid) +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
      Math.floor(CONFIG.SESSION_TTL_MS / 1000)
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function publicUser(s) {
  return {
    loginId: s.loginId,
    learnerId: s.learnerId,
    name: s.name,
    coins: s.coins,
  };
}

// ==================== RCA business logic (server-only) ====================
async function rcaLogin(loginId, password) {
  if (password !== CONFIG.APP_PASSWORD) {
    const e = new Error("Invalid password");
    e.status = 401;
    throw e;
  }
  const loginRes = await rcaRequest("POST", "/login", {
    body: {
      loginId: String(loginId),
      password: CONFIG.APP_PASSWORD,
      levelId: 0,
      role: "",
      caLoginConfigId: "0",
      date: Date.now(),
    },
  });
  if (!loginRes || !loginRes.accessToken) {
    throw new Error("Login failed: no accessToken");
  }
  const details = await rcaRequest("POST", "/userDetails?inputKeywordList=0", {
    token: loginRes.accessToken,
    body: "",
  });
  return {
    accessToken: loginRes.accessToken,
    loginId: String(loginId),
    learnerId: details.learnerId,
    userId: details.authorizedUserId,
    name:
      [details.firstName, details.lastName].filter(Boolean).join(" ").trim() ||
      "User " + loginId,
    packageId: details.packageId || CONFIG.PACKAGE_ID,
    curriculumId: details.curriculumId || CONFIG.CURRICULUM_ID,
  };
}

async function loadLevelData(token, level) {
  const list = await rcaRequest("GET", "/ielts/create-lessons", {
    token,
    query: {
      time: "60",
      activityTypeId: String(CONFIG.ACTIVITY_TYPE_ID),
      standardLevelId: String(level.id),
      packageId: String(CONFIG.PACKAGE_ID),
    },
  });
  const skills = {};
  let allDone = true;
  (list || []).forEach((section) => {
    const key = section.skill;
    const ids = (section.activitySetIds || []).map(String);
    const completed = !!section.isCompleted;
    if (!completed) allDone = false;
    skills[key] = {
      name: key.charAt(0) + key.slice(1).toLowerCase(),
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
      skills[s.key] = {
        name: s.name,
        completed: false,
        score: 0,
        totalActivities: 0,
        completedActivities: 0,
        time: "10",
        activitySetIds: [],
        testSummaryId: null,
      };
      allDone = false;
    }
  });
  return {
    level,
    skills,
    testSummaryId: (list && list[0] && list[0].testSummaryId) || null,
    isCompleted: allDone,
  };
}

function pickCorrectAnswer(q) {
  const opts = q.activityAnswerDTO || [];
  const correct = opts.find((o) => o.isCorrect === true);
  if (correct) return correct.id;
  if (q.correctAnswer != null && q.correctAnswer !== "") {
    const n = Number(q.correctAnswer);
    return isNaN(n) ? q.correctAnswer : n;
  }
  if (q.itemType === "FIB" || q.itemType === "FILLINBLANK") {
    return q.correctAnswer || "";
  }
  if (opts.length) return opts[0].id;
  return null;
}

function fillAnswers(activity) {
  const list = activity.activityQuestionDetailsList || [];
  let correctCount = 0;
  list.forEach((q) => {
    if (q.itemType === "IELTSWRITING" || q.itemType === "WRITING") {
      q.userEssay =
        "In today's world, education and independence play a vital role in shaping our future. Many young people choose to leave their hometowns for better opportunities, while others prefer staying close to family. Both sides have merits. Moving out can build confidence and career growth, whereas living in hometowns offers support and cultural roots. In my opinion, a balanced approach works best: gain experience outside, then decide based on personal goals. Overall, adults should carefully weigh pros and cons before making such decisions.";
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
      q.isUserAnswerCorrect = matched
        ? !!matched.isCorrect
        : String(ans) === String(q.correctAnswer);
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

async function submitActivity(token, activity, state, learnerId) {
  const payload = Object.assign({}, activity);
  payload.activityState = state;
  payload.learnerId = learnerId;
  payload.activityType = payload.activityType || "Ielts";
  const now = Date.now();
  if (!payload.startDate) payload.startDate = now - 30000;
  if (state === "SUBMITTED") {
    payload.endDate = now;
    payload.totalTimeTaken = Math.max(
      20,
      Math.floor((payload.endDate - payload.startDate) / 1000)
    );
  }
  await rcaRequest("POST", "/activity/data", { token, body: payload });
  return payload;
}

async function updateTimeTaken(token, learnerId, lessonId, activitySetId, secs) {
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
    });
  } catch (e) {
    console.warn("time update", e.message);
  }
}

async function submitWritingEssay(token, activity) {
  const q = (activity.activityQuestionDetailsList || []).find(
    (x) => x.itemType === "IELTSWRITING" || x.itemType === "WRITING"
  );
  if (!q) return;
  try {
    const essay = encodeURIComponent(
      q.userEssay || "Sample essay for IELTS writing task."
    );
    const t = encodeURIComponent(new Date().toISOString());
    await rcaRequest(
      "GET",
      "/ielts/essay-report?activityItemId=" +
        q.itemId +
        "&currentTime=" +
        t +
        "&userEssay=" +
        essay,
      { token }
    );
  } catch (e) {
    console.warn("essay-report", e.message);
  }
}

async function completeOneActivity(session, activitySetId, onLog) {
  const token = session.accessToken;
  const learnerId = session.learnerId;
  const ts = Date.now();
  onLog && onLog("Fetching " + activitySetId, "info");

  let activity = await rcaRequest(
    "GET",
    "/activitySetDetails/" + activitySetId + "/0/" + ts + "/false",
    { token }
  );
  if (!activity) throw new Error("Empty activity details for " + activitySetId);

  activity.activityState = "INPROGRESS";
  activity.learnerId = learnerId;
  activity.startDate = Date.now() - 25000;
  try {
    await submitActivity(token, activity, "INPROGRESS", learnerId);
    onLog && onLog("INPROGRESS " + activitySetId, "info");
  } catch (e) {
    onLog && onLog("INPROGRESS warn: " + e.message, "error");
  }

  await sleep(CONFIG.DELAY_BETWEEN_ANSWERS_MS);
  activity = fillAnswers(activity);
  const qCount = (activity.activityQuestionDetailsList || []).length;
  onLog && onLog("Answering " + qCount + " q for " + activitySetId, "success");
  await sleep(CONFIG.DELAY_BETWEEN_ANSWERS_MS);

  const hasWriting = (activity.activityQuestionDetailsList || []).some(
    (q) => q.itemType === "IELTSWRITING" || q.itemType === "WRITING"
  );
  if (hasWriting) await submitWritingEssay(token, activity);

  activity = await submitActivity(token, activity, "SUBMITTED", learnerId);
  onLog && onLog("SUBMITTED " + activitySetId, "success");

  const lessonId = activity.lessonId || activitySetId;
  await updateTimeTaken(
    token,
    learnerId,
    lessonId,
    activitySetId,
    activity.totalTimeTaken || 30
  );
}

function createJob(type, meta) {
  const id = uuid();
  const job = {
    id,
    type,
    meta,
    status: "running",
    current: 0,
    total: 0,
    task: "Starting...",
    logs: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function jobLog(job, message, level) {
  job.logs.push({
    t: new Date().toISOString(),
    message,
    level: level || "info",
  });
  if (job.logs.length > 200) job.logs.shift();
}

async function runCompleteJob(job, session, levelIds) {
  try {
    const tasks = [];
    for (const levelId of levelIds) {
      const level = LEVELS.find((l) => l.id === levelId);
      if (!level) continue;
      const data = await loadLevelData(session.accessToken, level);
      SKILLS.forEach((skill) => {
        const skillData = data.skills[skill.key];
        if (!skillData || skillData.completed) return;
        (skillData.activitySetIds || []).forEach((id) => {
          tasks.push({
            levelId: level.id,
            levelName: level.name,
            skillName: skill.name,
            activitySetId: id,
          });
        });
      });
    }

    job.total = tasks.length;
    if (tasks.length === 0) {
      job.status = "done";
      job.task = "No pending tasks";
      job.finishedAt = Date.now();
      return;
    }

    for (let i = 0; i < tasks.length; i++) {
      if (job.status === "cancelled") break;
      const t = tasks[i];
      job.current = i;
      job.task = t.levelName + "/" + t.skillName + " " + t.activitySetId;
      try {
        await completeOneActivity(session, t.activitySetId, (msg, lvl) =>
          jobLog(job, msg, lvl)
        );
      } catch (err) {
        jobLog(job, "Error " + t.activitySetId + ": " + err.message, "error");
      }
      job.current = i + 1;
      if (i < tasks.length - 1) {
        jobLog(job, "Pause " + CONFIG.DELAY_BETWEEN_TASKS_MS / 1000 + "s", "info");
        await sleep(CONFIG.DELAY_BETWEEN_TASKS_MS);
      }
    }

    job.status = job.status === "cancelled" ? "cancelled" : "done";
    job.task = "Finished";
    job.finishedAt = Date.now();
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    jobLog(job, err.message, "error");
  }
}

// ==================== HTTP helpers ====================
function sendJson(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    },
    extraHeaders || {}
  );
  res.writeHead(code, headers);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) {
    sendJson(res, 401, { error: "Not logged in" });
    return null;
  }
  return s;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(PUBLIC, "index.html");
  } else {
    const rel = decodeURIComponent(pathname).replace(/\0/g, "").replace(/^\/+/, "");
    filePath = path.resolve(PUBLIC, rel);
    if (!filePath.startsWith(path.resolve(PUBLIC))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

// ==================== API routes ====================
async function handleApi(req, res, pathname) {
  // POST /api/login
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const loginId = String(body.loginId || "").trim();
    const password = body.password || "";
    if (!loginId) return sendJson(res, 400, { error: "loginId required" });
    try {
      const u = await rcaLogin(loginId, password);
      const sid = uuid();
      const coins = 0;
      sessions.set(sid, {
        accessToken: u.accessToken,
        loginId: u.loginId,
        learnerId: u.learnerId,
        userId: u.userId,
        name: u.name,
        coins,
        createdAt: Date.now(),
      });
      setSessionCookie(res, sid);
      return sendJson(res, 200, {
        user: {
          loginId: u.loginId,
          learnerId: u.learnerId,
          name: u.name,
          coins,
        },
      });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message || "Login failed" });
    }
  }

  // POST /api/logout
  if (pathname === "/api/logout" && req.method === "POST") {
    const s = getSession(req);
    if (s) sessions.delete(s.sid);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/me
  if (pathname === "/api/me" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    return sendJson(res, 200, { user: publicUser(s) });
  }

  // GET /api/levels
  if (pathname === "/api/levels" && req.method === "GET") {
    const s = requireAuth(req, res);
    if (!s) return;
    try {
      const out = [];
      for (const level of LEVELS) {
        try {
          const data = await loadLevelData(s.accessToken, level);
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
                score: sd.score || 0,
              };
            }),
          });
        } catch (e) {
          out.push({
            id: level.id,
            name: level.name,
            title: level.title,
            subtitle: level.subtitle,
            color: level.color,
            isCompleted: false,
            error: e.message,
            skills: SKILLS.map((sk) => ({
              key: sk.key,
              name: sk.name,
              icon: sk.icon,
              completed: false,
              completedActivities: 0,
              totalActivities: 0,
              score: 0,
            })),
          });
        }
      }
      return sendJson(res, 200, { levels: out });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/coins  { passkey, amount }
  if (pathname === "/api/coins" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const body = await readJson(req);
    if (body.passkey !== CONFIG.COIN_PASSKEY) {
      return sendJson(res, 403, { error: "Invalid pass key" });
    }
    const amount = parseInt(body.amount, 10);
    if (!amount || amount < 1 || amount > 1000) {
      return sendJson(res, 400, { error: "Amount must be 1-1000" });
    }
    s.coins += amount;
    sessions.set(s.sid, s);
    // best-effort upstream coins
    try {
      await rcaRequest("POST", "/learners/add-coins", {
        token: s.accessToken,
        query: {
          learnerId: String(s.learnerId),
          coinsToAdd: String(amount),
        },
        body: "",
      });
    } catch (e) {
      console.warn("add-coins upstream", e.message);
    }
    return sendJson(res, 200, { coins: s.coins });
  }

  // POST /api/complete  { mode: "level"|"all", levelId?: number }
  if (pathname === "/api/complete" && req.method === "POST") {
    const s = requireAuth(req, res);
    if (!s) return;
    const body = await readJson(req);
    const mode = body.mode || "level";
    let cost = 10;
    let levelIds = [];
    if (mode === "all") {
      cost = 50;
      levelIds = LEVELS.map((l) => l.id);
    } else {
      const levelId = parseInt(body.levelId, 10);
      if (!LEVELS.some((l) => l.id === levelId)) {
        return sendJson(res, 400, { error: "Invalid levelId" });
      }
      levelIds = [levelId];
    }
    if (s.coins < cost) {
      return sendJson(res, 402, {
        error: "Insufficient coins",
        need: cost,
        coins: s.coins,
      });
    }
    s.coins -= cost;
    sessions.set(s.sid, s);

    const job = createJob(mode, { levelIds, loginId: s.loginId });
    // run async – client polls /api/jobs/:id
    const sessionSnapshot = { ...s };
    setImmediate(() => runCompleteJob(job, sessionSnapshot, levelIds));

    return sendJson(res, 200, {
      jobId: job.id,
      coins: s.coins,
      message: "Job started",
    });
  }

  // GET /api/jobs/:id
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
      logs: job.logs.slice(-50),
      percent:
        job.total > 0 ? Math.round((job.current / job.total) * 100) : 0,
    });
  }

  sendJson(res, 404, { error: "Not found" });
}

// ==================== Server ====================
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", "http://" + CONFIG.HOST);
    const pathname = u.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Credentials": "true",
      });
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  }
});

if (!fs.existsSync(path.join(PUBLIC, "index.html"))) {
  console.error("Missing public/index.html – create frontend first");
  process.exit(1);
}

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log("=".repeat(60));
  console.log(" RCA Secure Backend running");
  console.log(" Open:  http://%s:%d", CONFIG.HOST, CONFIG.PORT);
  console.log(" Secrets & RCA tokens stay on the server");
  console.log(" Stop:  Ctrl+C");
  console.log("=".repeat(60));
});
