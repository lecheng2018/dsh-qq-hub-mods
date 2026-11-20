// Test-process guard; this is not an OS sandbox for hostile JavaScript.
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const { syncBuiltinESMExports } = require('node:module');

function allowed(host) {
  const value = String(host || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}
function refuse(host) {
  if (!allowed(host)) {
    const error = new Error('Tests may access loopback only; mock external network requests');
    error.code = 'ERR_TEST_EXTERNAL_NETWORK';
    throw error;
  }
}
function checkHttp(args) {
  const first = args[0];
  let hostname = 'localhost';
  if (typeof first === 'string' || first instanceof URL) hostname = new URL(first).hostname;
  const options = (first && typeof first === 'object' && !(first instanceof URL)) ? first : args[1];
  if (options && typeof options === 'object') {
    if (options.socketPath) return;
    if (options.hostname) hostname = options.hostname;
    else if (options.host) hostname = String(options.host).startsWith('[')
      ? String(options.host).split(']')[0] + ']'
      : String(options.host).split(':')[0];
  }
  refuse(hostname);
}
for (const module of [http, https]) {
  const request = module.request;
  module.request = function (...args) { checkHttp(args); return request.apply(this, args); };
  module.get = function (...args) { const result = module.request(...args); result.end(); return result; };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  if (options && typeof options === 'object') {
    if (!options.path) refuse(options.host || 'localhost');
  } else if (typeof options === 'number') {
    refuse(typeof args[1] === 'string' ? args[1] : 'localhost');
  }
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const options = args.find(value => value && typeof value === 'object' && !Array.isArray(value));
  if (options && !options.path) refuse(options.host || options.servername || 'localhost');
  else if (typeof args[1] === 'string') refuse(args[1]);
  return tlsConnect.apply(this, args);
};
const fetch = globalThis.fetch;
if (fetch) globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  refuse(url.hostname);
  return fetch.call(this, input, options);
};
syncBuiltinESMExports();
