const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (optional, since same-origin)
app.use(cors());

// Parse JSON body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// API PROXY - This fixes the CORS issue!
// All requests to /api/* are forwarded to 
// https://api-rca.englishhelper.com:8443/RcaServer/api
// ============================================
const API_TARGET = 'https://api-rca.englishhelper.com:8443';

const apiProxy = createProxyMiddleware({
  target: API_TARGET,
  changeOrigin: true,
  secure: true,
  pathRewrite: {
    '^/api': '/RcaServer/api', // rewrite /api/login -> /RcaServer/api/login
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log('[PROXY]', req.method, req.url, '->', API_TARGET + proxyReq.path);
  },
  onProxyRes: (proxyRes, req, res) => {
    // Add CORS headers to the proxied response
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, x-request-id, x-journey-id';
  },
  onError: (err, req, res) => {
    console.error('[PROXY ERROR]', err.message);
    res.status(500).json({ 
      success: false, 
      message: 'Proxy error: ' + err.message 
    });
  }
});

// Apply proxy to all /api/* routes
app.use('/api', apiProxy);

// ============================================
// STATIC FILES - Serve the frontend
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log('========================================');
  console.log('  IELTS Dashboard Server Running!');
  console.log('========================================');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('  API Proxy: /api/* -> ' + API_TARGET + '/RcaServer/api');
  console.log('========================================');
});
