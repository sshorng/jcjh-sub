#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { startServer } = require('../dev-server');

function request(server, method, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path: requestPath
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async function run() {
  const server = startServer({ host: '127.0.0.1', port: 0, silent: true });
  await once(server, 'listening');
  try {
    const root = await request(server, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.body.toString('utf8'), /<title>建成國中線上課表系統<\/title>/);
    assert.match(root.body.toString('utf8'), /application-name" content="JCJH Timetable"/);
      assert.match(root.body.toString('utf8'), /domain-match\.js\?v=20260904-overtime-tags/);
      assert.match(root.body.toString('utf8'), /ui-request\.js\?v=20260904-overtime-tags/);
      assert.match(root.body.toString('utf8'), /20260904-overtime-tags/);
    assert.equal(root.headers['cache-control'], 'no-cache');
    assert.match(root.headers['content-security-policy'], /frame-ancestors 'none'/);

      const app = await request(server, 'GET', '/app.js?v=20260904-overtime-tags');
    assert.equal(app.status, 200);
    assert.match(app.body.toString('utf8'), /params\.set\('response_type', 'id_token token'\)/);

      const head = await request(server, 'HEAD', '/style.css?v=20260904-overtime-tags');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);

    const template = await request(server, 'GET', '/templates/invigilation-template.xlsx');
    assert.equal(template.status, 200);
    assert.match(template.headers['content-type'], /spreadsheetml\.sheet/);
    assert.ok(template.body.length > 1000);

    const post = await request(server, 'POST', '/');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');

    const hidden = await request(server, 'GET', '/code.gs');
    assert.equal(hidden.status, 404);

    const traversal = await request(server, 'GET', '/%2e%2e%2fcode.gs');
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('http smoke tests PASS');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
