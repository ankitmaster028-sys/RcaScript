export default async function handler(req, res) {
  const targetBase = 'https://api-rca.englishhelper.com:8443/RcaServer/api';
  const path = req.url.replace(/^\/api\/?/, '');
  const targetUrl = targetBase + (path ? '/' + path : '');

  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': req.headers['accept'] || 'application/json, text/plain, */*',
    'x-request-id': req.headers['x-request-id'] || generateUUID(),
    'x-journey-id': req.headers['x-journey-id'] || generateUUID(),
    'Origin': 'https://rca.englishhelper.com',
    'Referer': 'https://rca.englishhelper.com/',
  };

  if (req.headers['authorization']) {
    headers['Authorization'] = req.headers['authorization'];
  }

  const fetchOptions = {
    method: req.method,
    headers: headers,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      fetchOptions.body = JSON.stringify(req.body);
    } catch (e) {
      fetchOptions.body = req.body;
    }
  }

  try {
    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await response.json();
      res.status(response.status).json(data);
    } else {
      data = await response.text();
      res.status(response.status).send(data);
    }
  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Proxy error: ' + error.message
    });
  }
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
