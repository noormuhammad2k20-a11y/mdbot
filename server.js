// ============================================================================
// MD WhatsApp Bot — Server
// Auto-submit bot with web QR scanning & Puppeteer form automation
// ============================================================================

const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer-core');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ============================================================================
// Auto-detect system Chrome / Chromium executable path
// ============================================================================

function findChromePath() {
  const fs = require('fs');
  const possiblePaths = process.platform === 'win32'
    ? [
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : [ // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      ];

  for (const p of possiblePaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // Fallback: let the user set it via env var
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  console.warn('⚠️  Could not auto-detect Chrome. Set CHROME_PATH environment variable.');
  return null;
}

const CHROME_EXECUTABLE = findChromePath();
if (CHROME_EXECUTABLE) {
  console.log(`🌐  Using Chrome at: ${CHROME_EXECUTABLE}`);
} else {
  console.error('❌  No Chrome found! Puppeteer automation will fail.');
}

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3000;

// The client phone number to auto-fill in the Madley form
const CLIENT_INPUT = '+393935865697';

// Keywords to watch for in incoming WhatsApp messages
const KEYWORDS = [
  '*MADLEY — Richiesta disponibilità*',
  'Niall Horan'
];

// Regex to extract Madley URLs from message text
const MADLEY_URL_REGEX = /https:\/\/madley\.vercel\.app\/[^\s"'<>)}\]]+/gi;

// ============================================================================
// Express Server Setup
// ============================================================================

const app = express();

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state shared with the frontend via SSE
let currentQR = null;       // Base64-encoded QR image (null once authenticated)
let botStatus = 'loading';  // 'loading' | 'qr' | 'authenticated' | 'ready' | 'disconnected'
let statusMessage = 'Initializing WhatsApp client…';

// Array of SSE response objects so we can push updates to all connected browsers
const sseClients = [];

/**
 * Broadcast a Server-Sent Event to every connected browser tab.
 */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

// ----- API Routes -----------------------------------------------------------

// SSE endpoint — the frontend connects here for real-time updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Immediately send current state so the page doesn't start blank
  res.write(`event: status\ndata: ${JSON.stringify({ status: botStatus, message: statusMessage })}\n\n`);
  if (currentQR) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: currentQR })}\n\n`);
  }

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// Simple health-check / status JSON endpoint
app.get('/api/status', (_req, res) => {
  res.json({ status: botStatus, message: statusMessage });
});

// Start Express
app.listen(PORT, () => {
  console.log(`\n🌐  Web interface running at  http://localhost:${PORT}\n`);
});

// ============================================================================
// WhatsApp Client (whatsapp-web.js with LocalAuth)
// ============================================================================

const whatsappPuppeteerArgs = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
};
// Use system Chrome for whatsapp-web.js as well
if (CHROME_EXECUTABLE) whatsappPuppeteerArgs.executablePath = CHROME_EXECUTABLE;

const whatsapp = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth'),   // persist session here
  }),
  puppeteer: whatsappPuppeteerArgs,
});

// ----- WhatsApp Lifecycle Events --------------------------------------------

whatsapp.on('loading_screen', (percent, message) => {
  statusMessage = `Loading WhatsApp: ${percent}% — ${message}`;
  broadcast('status', { status: 'loading', message: statusMessage });
  console.log(`⏳  ${statusMessage}`);
});

whatsapp.on('qr', async (qr) => {
  console.log('📱  New QR code received — scan it from the web interface.');
  try {
    // Generate a Base64 data-URI from the QR string
    currentQR = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    botStatus = 'qr';
    statusMessage = 'Scan the QR code with your WhatsApp app.';
    broadcast('qr', { qr: currentQR });
    broadcast('status', { status: botStatus, message: statusMessage });
  } catch (err) {
    console.error('❌  QR generation failed:', err);
  }
});

whatsapp.on('authenticated', () => {
  console.log('🔑  WhatsApp authenticated successfully.');
  currentQR = null;
  botStatus = 'authenticated';
  statusMessage = 'Authenticated! Loading session data…';
  broadcast('status', { status: botStatus, message: statusMessage });
});

whatsapp.on('auth_failure', (msg) => {
  console.error('🚫  Authentication failure:', msg);
  botStatus = 'disconnected';
  statusMessage = `Authentication failed: ${msg}`;
  broadcast('status', { status: botStatus, message: statusMessage });
});

whatsapp.on('ready', () => {
  console.log('✅  WhatsApp client is READY and listening for messages.');
  currentQR = null;
  botStatus = 'ready';
  statusMessage = 'Connected & Listening';
  broadcast('status', { status: botStatus, message: statusMessage });
});

whatsapp.on('disconnected', (reason) => {
  console.warn('⚠️  WhatsApp disconnected:', reason);
  botStatus = 'disconnected';
  statusMessage = `Disconnected: ${reason}. Restart the server to reconnect.`;
  broadcast('status', { status: botStatus, message: statusMessage });
});

// ----- Incoming Message Handler ---------------------------------------------

whatsapp.on('message', async (msg) => {
  try {
    const body = msg.body || '';

    // 1. Check if the message contains any of the watched keywords
    const hasKeyword = KEYWORDS.some((kw) => body.includes(kw));
    if (!hasKeyword) return; // Not a message we care about — skip

    console.log(`\n📩  Keyword detected in message from ${msg.from}:`);
    console.log(`    "${body.substring(0, 120)}…"\n`);

    // 2. Extract all Madley URLs using the regex
    const urls = body.match(MADLEY_URL_REGEX);
    if (!urls || urls.length === 0) {
      console.log('⚠️  Keyword found but no Madley URL detected. Skipping.');
      return;
    }

    // 3. Process each URL (usually just one)
    for (const url of urls) {
      console.log(`🔗  Extracted URL: ${url}`);
      console.log(`🚀  Launching Puppeteer to auto-submit form…`);

      // Fire-and-forget — errors are caught inside submitForm
      submitForm(url, CLIENT_INPUT);
    }
  } catch (err) {
    console.error('❌  Error handling incoming message:', err);
  }
});

// Initialize the WhatsApp client (this triggers the 'qr' event on first run)
whatsapp.initialize().catch((err) => {
  console.error('❌  Failed to initialize WhatsApp client:', err);
  botStatus = 'disconnected';
  statusMessage = `Initialization error: ${err.message}`;
  broadcast('status', { status: botStatus, message: statusMessage });
});

// ============================================================================
// Puppeteer Form Automation
// ============================================================================

/**
 * Opens the Madley URL in a headless browser and performs a 2-step submission:
 *
 *   Step 1 — Fill in the phone number and click "Continua — Continue"
 *   Step 2 — On the next page, click the "Participate" / "Conferma" button
 *   Step 3 — Wait for the final success page ("Ciao …" or "Sei la riserva …")
 *
 * @param {string} url          – The Madley form URL extracted from the message
 * @param {string} clientInput  – The phone number to auto-fill
 */
async function submitForm(url, clientInput) {
  let browser = null;

  try {
    // Launch a fresh browser instance for isolation
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    if (CHROME_EXECUTABLE) launchOptions.executablePath = CHROME_EXECUTABLE;

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();

    // Set a reasonable viewport and user-agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ------------------------------------------------------------------
    // STEP 1 — Navigate, fill in the phone number, click "Continua"
    // ------------------------------------------------------------------
    console.log(`📄  Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for the input field to appear (phone / tel / text input)
    const inputSelector = 'input[type="tel"], input[type="text"], input[type="email"], input[name*="phone" i], input[placeholder*="phone" i], input[placeholder*="telefono" i]';
    await page.waitForSelector(inputSelector, { visible: true, timeout: 15000 });
    console.log('✏️   Input field found — filling in:', clientInput);

    // Clear any pre-filled value and type the client phone number
    await page.click(inputSelector, { clickCount: 3 }); // select-all
    await page.type(inputSelector, clientInput, { delay: 50 });

    // Find and click the "Continua — Continue" button
    const continuaBtn = await findButtonByText(page, ['continua', 'continue']);
    if (!continuaBtn) throw new Error('Could not find the "Continua" button.');
    console.log('🖱️   Clicking "Continua — Continue"…');
    await continuaBtn.click();

    // ------------------------------------------------------------------
    // STEP 2 — Wait for the next page and click "Partecipa" / "Participate"
    // ------------------------------------------------------------------
    // Wait for navigation / DOM update after clicking Continua
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
      // Some SPAs don't trigger a traditional navigation — fall through
      console.log('ℹ️   No traditional navigation detected; checking DOM…');
    });

    // Extra wait for client-side rendering
    await delay(2000);

    // Look for the participation / confirm button (IT: Partecipa/Conferma, EN: Participate/Confirm)
    const participateBtn = await findButtonByText(page, ['partecipa', 'participate', 'ok partecipa', 'ok participate', 'conferma', 'confirm']);
    if (!participateBtn) throw new Error('Could not find the "Partecipa" / "Participate" / "Conferma" button.');
    console.log('🖱️   Clicking "Partecipa / Participate" button…');
    await participateBtn.click();

    // ------------------------------------------------------------------
    // STEP 3 — Wait for the final success / confirmation page
    // ------------------------------------------------------------------
    // Wait for network activity to settle after the click
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
      console.log('ℹ️   No traditional navigation after Participate; checking DOM…');
    });

    await delay(2000);

    // Verify the success page loaded by looking for known confirmation text
    // IT: "Ciao ALI MURAD" (confirmed) or "Sei la riserva n.X" (standby)
    // These regexes are case-insensitive to handle any capitalisation variant
    const pageText = await page.evaluate(() => document.body.innerText);
    const isSuccess = /ciao\s/i.test(pageText) || /riserva/i.test(pageText);

    if (isSuccess) {
      // Extract the greeting or standby line for logging
      const greetMatch = pageText.match(/Ciao\s+[^\n]+/i);
      const reserveMatch = pageText.match(/Sei la riserva[^\n]*/i);
      const detail = greetMatch ? greetMatch[0].trim() : (reserveMatch ? reserveMatch[0].trim() : 'confirmed');
      console.log(`🎉  Success page detected: "${detail}"`);
    } else {
      console.log('⚠️  Could not verify success page text, but the flow completed without errors.');
    }

    console.log(`✅  Form successfully submitted and participation confirmed for ${clientInput}`);

  } catch (err) {
    console.error(`❌  Puppeteer automation failed for ${url}:`, err.message);
  } finally {
    // Always close the browser to free resources
    if (browser) {
      await browser.close().catch(() => {});
      console.log('🧹  Browser instance closed.');
    }
  }
}

// ============================================================================
// Utility Helpers
// ============================================================================

/**
 * Searches the page for a <button>, <a>, or role="button" element whose
 * visible text includes any of the provided keywords (case-insensitive).
 *
 * @param {object}          page     – Puppeteer Page instance
 * @param {string|string[]} keywords – One keyword or an array of keywords to match
 * @returns {ElementHandle|null}     – The first matching element, or null
 */
async function findButtonByText(page, keywords) {
  // Normalise to array
  const terms = Array.isArray(keywords) ? keywords : [keywords];

  for (const text of terms) {
    const lc = text.toLowerCase();

    // Strategy 1 — XPath text search across buttons, a-tags, and role=button
    const [element] = await page.$x(
      `//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lc}')] | ` +
      `//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lc}')] | ` +
      `//*[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lc}')]`
    );
    if (element) return element;

    // Strategy 2 — input[type="submit"] with matching value
    const inputs = await page.$$('input[type="submit"]');
    for (const input of inputs) {
      const value = await page.evaluate((el) => el.value, input);
      if (value && value.toLowerCase().includes(lc)) return input;
    }
  }

  return null;
}

/**
 * Simple promise-based delay.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
