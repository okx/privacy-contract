#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  let filePath;
  
  if (req.url === '/deployments.json' || req.url.startsWith('/deployments.json')) {
    filePath = path.join(__dirname, '..', 'deployments.json');
  } else {
    filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code == 'ENOENT') {
        console.log(`  ❌ File not found: ${filePath}`);
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        console.log(`  ❌ Server error: ${error.code}`);
        res.writeHead(500);
        res.end('Server Error: ' + error.code + ' ..\n');
      }
    } else {
      console.log(`  ✅ Serving file: ${filePath}`);
      res.writeHead(200, { 
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log('\n🚂 Railgun Privacy Wallet Demo');
  console.log('================================');
  console.log(`✅ Server running at http://localhost:${PORT}/`);
  console.log('\nPress Ctrl+C to stop\n');
});
