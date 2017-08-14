#!/usr/bin/env node
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const testCases = require('./cases');

const IPERF_PATH = path.join(__dirname, 'iperf.sh');
const SEC_PER_CASE = 5;

function makeConfs(presets) {
  const common = {
    "dns": [],
    "dns_expire": 3600,
    "timeout": 600,
    "log_level": "error"
  };
  const server = {
    "transport": "tcp",
    "host": "127.0.0.1",
    "port": 1082,
    "key": "JJ9,$!.!sRG==v7$",
    "presets": presets
  };
  const clientConf = Object.assign({
    "host": "127.0.0.1",
    "port": 1081,
    "servers": [
      Object.assign({}, server, {
        "enabled": true,
        "presets": [{
          "name": "proxy", // proxy in tunnel mode
          "params": {
            "host": "127.0.0.1",
            "port": 1083
          }
        }].concat(server.presets)
      })
    ]
  }, common);
  const serverConf = Object.assign({}, server, common);
  return [clientConf, serverConf];
}

function writeConfs(caseId, presets) {
  const [clientConf, serverConf] = makeConfs(presets);
  const clientJson = path.join(__dirname, `jsons/case-${caseId}-client.json`);
  const serverJson = path.join(__dirname, `jsons/case-${caseId}-server.json`);
  fs.writeFileSync(clientJson, JSON.stringify(clientConf, null, '  '));
  fs.writeFileSync(serverJson, JSON.stringify(serverConf, null, '  '));
  return [clientJson, serverJson];
}

function parseStdout(stdout) {
  const matches = stdout.match(/\[SUM].*sec/g);
  return matches.slice(-2).map((line) => {
    const [interval, transfer, bitrate] = line.match(/\d+[.\d\-\s]+\w+[\/\w]+/g);
    return {interval, transfer, bitrate};
  });
}

function convertTransferToKBytes(transfer) {
  const [num, unit] = transfer.split(' ');
  const factor = {
    'GBytes': 1024 * 1024,
    'MBytes': 1024,
    'KBytes': 1
  }[unit];
  return num * factor;
}

function printSystemConf() {
  console.log(chalk.bold.underline('Operating System:'));
  const osParams = [
    ['cpu', os.cpus()[0].model],
    ['cores', os.cpus().length],
    ['memory', os.totalmem()],
    ['type', os.type()],
    ['platform', os.platform()],
    ['arch', os.arch()],
    ['release', os.release()]
  ];
  for (const [key, value] of osParams) {
    console.log('%s %s', key.padEnd(15), value);
  }
  console.log('');
  console.log(chalk.bold.underline('Node.js Versions:'));
  for (const [key, value] of Object.entries(process.versions)) {
    console.log('%s %s', key.padEnd(15), value);
  }
  console.log('');
}

function run(cases) {
  const results = [];
  for (let i = 0; i < cases.length; ++i) {
    const presets = cases[i];
    const [clientJson, serverJson] = writeConfs(i, presets);
    try {
      const stdout = child_process.execFileSync(
        IPERF_PATH, [clientJson, serverJson, SEC_PER_CASE.toString()], {encoding: 'utf-8'}
      );
      const [a, b] = parseStdout(stdout);
      console.log(`------------ ${chalk.green(`Test Case ${i}`)} ----------------`);
      console.log(JSON.stringify(presets));
      console.log('Interval         Transfer     Bitrate');
      console.log(`${a.interval}  ${a.transfer}  ${a.bitrate}  sender`);
      console.log(`${b.interval}  ${b.transfer}  ${b.bitrate}  receiver`);
      console.log('-----------------------------------------');
      console.log('');
      const conv = convertTransferToKBytes;
      results.push({
        id: i,
        transfers: [a.transfer, b.transfer],
        // NOTE: take average of sender transfer and receiver transfer to sort
        avgTransfer: (conv(a.transfer) + conv(b.transfer)) / 2,
        conf: JSON.stringify(presets)
      });
    } catch (err) {
      console.error(err);
    }
  }
  return results;
}

function summary(results) {
  const sorted = [].concat(results).sort((a, b) => b.avgTransfer - a.avgTransfer);
  console.log('(ranking):');
  console.log('');
  for (let i = 0; i < sorted.length; ++i) {
    const {id, transfers, conf} = sorted[i];
    console.log(`${(i + 1).toString().padStart(2)}: Test Case ${id}, Transfer=[${transfers.join(', ')}], ${conf}`);
  }
  console.log('');
}

printSystemConf();

console.log('running tests...');
console.log('');

summary(run(testCases));