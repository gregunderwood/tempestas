import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChromeArguments,
  buildPageListUrl,
  findDevToolsUrl,
  fitViewportToContent,
  FORM_FACTORS,
  parseArguments,
} from './full-page-screenshot.mjs';

const DEVTOOLS_URL =
  'ws://127.0.0.1:36381/devtools/browser/b41bcb08-e7ae-4815-b3e9-7abf779c47a1';

function layoutWithContentHeight(height) {
  return { cssContentSize: { x: 0, y: 0, width: 1280, height } };
}

describe('parseArguments', () => {
  it('reads the form factor, url, file and profile folder', () => {
    assert.deepEqual(
      parseArguments([
        'phone',
        'http://localhost:4220/reports',
        'shot.png',
        'profile',
      ]),
      {
        formFactor: FORM_FACTORS.phone,
        url: 'http://localhost:4220/reports',
        pngFile: 'shot.png',
        profileFolder: 'profile',
      },
    );
  });

  it('refuses a form factor it does not know', () => {
    assert.throws(
      () =>
        parseArguments([
          'tablet',
          'http://localhost:4220/',
          'shot.png',
          'profile',
        ]),
      /Usage/,
    );
  });

  it('refuses a missing argument', () => {
    assert.throws(
      () => parseArguments(['desktop', 'http://localhost:4220/']),
      /Usage/,
    );
  });
});

describe('FORM_FACTORS', () => {
  it('keeps the widths the comment labels: 1280 px desktop and 390 px phone', () => {
    assert.equal(FORM_FACTORS.desktop.width, 1280);
    assert.equal(FORM_FACTORS.phone.width, 390);
  });

  it('lays the phone out as a mobile viewport, the desktop not', () => {
    assert.equal(FORM_FACTORS.phone.mobile, true);
    assert.equal(FORM_FACTORS.desktop.mobile, false);
  });
});

describe('buildChromeArguments', () => {
  it('runs headless on a free debugging port, with its own profile and the form factor window', () => {
    const chromeArguments = buildChromeArguments(
      FORM_FACTORS.phone,
      '/tmp/profile',
    );
    assert.ok(chromeArguments.includes('--headless=new'));
    assert.ok(chromeArguments.includes('--remote-debugging-port=0'));
    assert.ok(chromeArguments.includes('--user-data-dir=/tmp/profile'));
    assert.ok(chromeArguments.includes('--window-size=390,844'));
  });
});

describe('findDevToolsUrl', () => {
  it('finds the browser endpoint among the lines Chrome prints', () => {
    const chromeOutput = `[1:2:ERROR:ssl_client_socket_impl.cc] handshake failed\n\nDevTools listening on ${DEVTOOLS_URL}\n`;
    assert.equal(findDevToolsUrl(chromeOutput), DEVTOOLS_URL);
  });

  it('finds nothing before Chrome is listening', () => {
    assert.equal(
      findDevToolsUrl('[1:2:WARNING:something unrelated]\n'),
      undefined,
    );
  });
});

describe('buildPageListUrl', () => {
  it('asks the same host and port for its page targets', () => {
    assert.equal(
      buildPageListUrl(DEVTOOLS_URL),
      'http://127.0.0.1:36381/json/list',
    );
  });
});

describe('fitViewportToContent', () => {
  it('stretches the viewport to a long page, at the same width and scale', () => {
    assert.deepEqual(
      fitViewportToContent(FORM_FACTORS.phone, layoutWithContentHeight(3120.4)),
      { ...FORM_FACTORS.phone, height: 3121 },
    );
  });

  it('keeps the window height for a page shorter than the window', () => {
    assert.deepEqual(
      fitViewportToContent(FORM_FACTORS.desktop, layoutWithContentHeight(400)),
      FORM_FACTORS.desktop,
    );
  });
});
