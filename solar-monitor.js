import { execSync } from 'child_process';
import fs from 'fs';
import nodemailer from 'nodemailer';

const METRIC_FILE = 'production.json'; // we only care about production.json

// Read JWT and prospect_id from environment variables
const jwtToken = process.env.SUNRUN_JWT;
const prospectId = process.env.SUNRUN_PROSPECT;

if (!jwtToken || !prospectId) {
  throw new Error('SUNRUN_JWT or SUNRUN_PROSPECT environment variable not set');
}

// Write a temporary config.json for the extractor
const config = { jwt_token: jwtToken, prospect_id: prospectId };
fs.writeFileSync('config.json', JSON.stringify(config));

function runExtractor() {
  console.log('📡 Running Sunrun Rust extractor...');
  // Run the Rust binary
  execSync(
    './sunrun-api-extractor/target/release/sunrun-api-extractor --config config.json',
    { stdio: 'inherit' }
  );
}

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
    to: process.env.EMAIL_TO, // phone SMS gateway
    subject: '', // SMS gateways usually ignore this
    text: message,
  });

  console.log('📨 SMS sent:', message);
}

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
    await sendSMS('Failed to get solar production data');
  } finally {
    // Clean up temporary config
    try {
      fs.unlinkSync('config.json');
    } catch {}
  }
})();
