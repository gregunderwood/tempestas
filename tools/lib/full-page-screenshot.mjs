#!/usr/bin/env node
// Saves a screenshot of a page's full height, at desktop or phone width, through headless Chrome's DevTools protocol.
// Usage: node tools/lib/full-page-screenshot.mjs <desktop|phone> <url> <png file> <chrome profile folder>

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORM_FACTORS = {
  desktop: { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const USAGE = `Usage: node tools/lib/full-page-screenshot.mjs <${Object.keys(FORM_FACTORS).join('|')}> <url> <png file> <chrome profile folder>`;
const PAGE_SETTLE_MILLISECONDS = 8000;
const RELAYOUT_SETTLE_MILLISECONDS = 1000;
const GIVE_UP_AFTER_MILLISECONDS = 120_000;
const CHROME_EXIT_GRACE_MILLISECONDS = 5000;
const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)/;

export function parseArguments(commandLine) {
  const [formFactorName, url, pngFile, profileFolder] = commandLine;
  const formFactor = FORM_FACTORS[formFactorName];
  if (!formFactor || !url || !pngFile || !profileFolder) {
    throw new Error(USAGE);
  }
  return { formFactor, url, pngFile, profileFolder };
}

export function buildChromeArguments(formFactor, profileFolder) {
  return [
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileFolder}`,
    `--window-size=${formFactor.width},${formFactor.height}`,
    'about:blank',
  ];
}

export function findDevToolsUrl(chromeOutput) {
  return chromeOutput.match(DEVTOOLS_LISTENING_PATTERN)?.[1];
}

export function buildPageListUrl(devToolsUrl) {
  const { hostname, port } = new URL(devToolsUrl);
  return `http://${hostname}:${port}/json/list`;
}

export function fitViewportToContent(formFactor, layoutMetrics) {
  const contentHeight = Math.ceil(layoutMetrics.cssContentSize.height);
  const atLeastWindowHeight = Math.max(formFactor.height, contentHeight);
  return { ...formFactor, height: atLeastWindowHeight };
}

class DevToolsSession {
  #socket;
  #nextCommandId = 1;
  #pendingCommands = new Map();
  #eventListeners = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`could not connect to ${url}`)),
        { once: true },
      );
    });
    return new DevToolsSession(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) =>
      this.#receive(JSON.parse(event.data)),
    );
  }

  send(method, params = {}) {
    const id = this.#nextCommandId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pendingCommands.set(id, { method, resolve, reject }),
    );
  }

  waitForEvent(method) {
    return new Promise((resolve) => this.#eventListeners.set(method, resolve));
  }

  close() {
    this.#socket.close();
  }

  #receive(message) {
    if (message.id === undefined) {
      this.#eventListeners.get(message.method)?.(message.params);
      return;
    }
    const command = this.#pendingCommands.get(message.id);
    this.#pendingCommands.delete(message.id);
    if (message.error) {
      command.reject(
        new Error(`${command.method} failed: ${message.error.message}`),
      );
    } else {
      command.resolve(message.result);
    }
  }
}

async function main() {
  const { formFactor, url, pngFile, profileFolder } = parseArguments(
    process.argv.slice(2),
  );
  const chrome = spawn(
    'google-chrome',
    buildChromeArguments(formFactor, profileFolder),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  try {
    const screenshot = await withTimeout(
      captureFullPage(chrome, formFactor, url),
      GIVE_UP_AFTER_MILLISECONDS,
      `no screenshot of ${url} within ${GIVE_UP_AFTER_MILLISECONDS / 1000} s`,
    );
    writeFileSync(pngFile, screenshot);
  } finally {
    await stopChrome(chrome);
  }
}

async function captureFullPage(chrome, formFactor, url) {
  const devToolsUrl = await waitForDevToolsUrl(chrome);
  const session = await DevToolsSession.connect(
    await findPageSocketUrl(devToolsUrl),
  );
  try {
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', formFactor);
    await loadAndSettle(session, url);
    const fullPage = fitViewportToContent(
      formFactor,
      await session.send('Page.getLayoutMetrics'),
    );
    await session.send('Emulation.setDeviceMetricsOverride', fullPage);
    await runVirtualTime(session, RELAYOUT_SETTLE_MILLISECONDS);
    const { data: pngBase64 } = await session.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    return Buffer.from(pngBase64, 'base64');
  } finally {
    session.close();
  }
}

// Page.navigate returns once the new document commits; a policy set before that would stay with about:blank.
async function loadAndSettle(session, url) {
  const { errorText } = await session.send('Page.navigate', { url });
  if (errorText) {
    throw new Error(`could not load ${url}: ${errorText}`);
  }
  await runVirtualTime(session, PAGE_SETTLE_MILLISECONDS);
}

// As Chrome's --virtual-time-budget does: the page's clock runs only while no request is pending.
async function runVirtualTime(session, milliseconds) {
  const budgetExpired = session.waitForEvent(
    'Emulation.virtualTimeBudgetExpired',
  );
  await session.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: milliseconds,
  });
  await budgetExpired;
}

function waitForDevToolsUrl(chrome) {
  return new Promise((resolve, reject) => {
    let chromeOutput = '';
    chrome.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      chromeOutput += chunk;
      const devToolsUrl = findDevToolsUrl(chromeOutput);
      if (devToolsUrl) {
        resolve(devToolsUrl);
      }
    });
    chrome.once('exit', (code, signal) =>
      reject(
        new Error(`Chrome exited before it was ready (${signal ?? code})`),
      ),
    );
    chrome.once('error', reject);
  });
}

async function findPageSocketUrl(devToolsUrl) {
  const response = await fetch(buildPageListUrl(devToolsUrl));
  const targets = await response.json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) {
    throw new Error('Chrome opened no page to drive');
  }
  return page.webSocketDebuggerUrl;
}

async function withTimeout(promise, milliseconds, message) {
  let timeoutTimer;
  const timeout = new Promise((_resolve, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function stopChrome(chrome) {
  if (hasExited(chrome)) {
    return;
  }
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  const killTimer = setTimeout(
    () => chrome.kill('SIGKILL'),
    CHROME_EXIT_GRACE_MILLISECONDS,
  );
  await exited;
  clearTimeout(killTimer);
}

function hasExited(chrome) {
  return chrome.exitCode !== null || chrome.signalCode !== null;
}

function isRunAsScript() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
}

if (isRunAsScript()) {
  main().catch((error) => {
    console.error(`full-page-screenshot: ${error.message}`);
    process.exit(1);
  });
}
