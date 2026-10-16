/**
 * Shared runtime context: the live config + client, in one dependency-free
 * module that every feature can require without circular imports.
 */
let _config = null;
let client = null;

function setConfig(cfg) {
  _config = cfg;
}

function currentConfig() {
  // never null for callers: schema defaults are valid everywhere
  return _config || require('./schema').defaults();
}

function setClient(c) {
  client = c;
}

function getClient() {
  return client;
}

module.exports = { setConfig, currentConfig, setClient, getClient };