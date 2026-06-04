const http = require('http');

const data = JSON.stringify({
  user_id: 1,
  type: 'idea',
  target_id: 1,
  message: 'Test message',
  duration_months: 3,
  monitoring_type: 'Mingguan'
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/applications',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk) => {
    body += chunk;
  });
  res.on('end', () => {
    console.log('BODY:', body);
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
