'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSkyjo } = require('./skyjo.js');

const INDEX_FILE = path.join(__dirname, 'index.html');

function createServer() {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname !== '/' && url.pathname !== '/index.html' && url.pathname !== '/skyjo') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Seite fehlt'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(data);
    });
  });
  const skyjo = createSkyjo();
  server.on('upgrade', (req, socket, head) => {
    let p = '';
    try { p = new URL(req.url, 'http://x').pathname; } catch (e) { /* ungueltig */ }
    if (p !== '/ws-skyjo') { socket.destroy(); return; }
    skyjo.wss.handleUpgrade(req, socket, head, (ws) => skyjo.wss.emit('connection', ws, req));
  });
  server.on('close', () => skyjo.dispose());
  return server;
}

module.exports = { createServer };
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Skyjo läuft auf http://localhost:${port}`));
}
