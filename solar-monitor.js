import { execSync } from 'child_process';
import fs from 'fs';
import nodemailer from 'nodemailer';
import path from 'path';

// -----------------------------
// Constants & paths
// -----------------------------
const EXTRACTOR_DIR = path.resolve('sunrun-api-extractor');
const CONFIG_FILE = path.join(EXTRACTOR_DIR, 'config.json');
const METRIC_FILE = path.join(EXTRACTOR_DIR, 'production.json');

// -----------------------------
// Environment variables
// -----------------------------
const jwtToken = process.env.SUNRUN_JWT;
const prospectId = process.env.SUNRUN_PROSPECT;

if (!jwtToken || !prospectId) {
  throw new Error('SUNRUN_JWT or SUNRUN_PROSPECT environment variable not set');
}

// -----------------------------
// Write temporary config.json
// -----------------------------
const config = {
  jwt_token: jwtToken,
  prospect_id: prospectId,
};

fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));

// -----------------------------
// Run Rust extractor
// -----------------------------
function runExtractor() {
  console.log('📡 Running Sunrun Rust extractor...');

  execSync('./target/release/sunrun-data-api --config config.json', {
    cwd: EXTRACTOR_DIR,
    stdio: 'inherit',
  });
}

// -----------------------------
// Helpers
// -----------------------------
function readJsonIfExists(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

async function sendSMS(message) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    subject: '',
    text: message,
  });

  console.log('📨 SMS sent:', message);
}

// -----------------------------
// Main
// -----------------------------
(async () => {
  try {
    runExtractor();

    const productionData = readJsonIfExists(METRIC_FILE);

    let message;
    if (productionData && productionData.yesterdayTotalKwh != null) {
      message = `Solar production yesterday was ${productionData.yesterdayTotalKwh} kWh`;
    } else {
      message = 'Failed to get solar production data';
    }

    await sendSMS(message);
  } catch (err) {
    console.error('❌ Script failed:', err);
    try {
      await sendSMS('Failed to get solar production data');
    } catch {}
  } finally {
    // Clean up temporary config
    try {
      fs.unlinkSync(CONFIG_FILE);
    } catch {}
  }
})();
