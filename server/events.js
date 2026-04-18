'use strict';

const EventEmitter = require('events');

// Bus de eventos interno: services.js emite → index.js escucha y hace broadcast SSE
const emitter = new EventEmitter();

module.exports = emitter;
