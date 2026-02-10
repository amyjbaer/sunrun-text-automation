import { execSync } from 'child_process';
import fs from 'fs';
import nodemailer from 'nodemailer';
import path from 'path';
import Database from 'better-sqlite3';

// -----------------------------
// Constants & paths
// -----------------------------
const EXTRACTOR_DIR = path.resolve('sunrun-api-extractor');
const CONFIG_FILE = path.join(EXTRACTOR_DIR, 'data.hcl');
const DB_FILE = path.join(EXTRACTOR_DIR, 'sunrun.sqlite3');

// -----------------------------
// Environment variables
// -----------------------------
const jwtToken = process.env.SUNRUN_JWT;
const prospectId = process.env.SUNRUN_PROSPECT;

if (!jwtToken || !prospectId) {
  throw new Error('SUNRUN_JWT or SUNRUN_PROSPECT environment variable not set');
}

// -----------------------------
// Write temporary data.hcl (HCL format)
// -----------------------------
const configHCL = `prospect_id = "${prospectId}"
jwt_token = "${jwtToken}"
`;

fs.writeFileSync(CONFIG_FILE, configHCL);

// -----------------------------
// Run Rust extractor
// -----------------------------
function runExtractor() {
  console.log('📡 Running Sunrun Rust extractor...');

  execSync('./target/release/sunrun-data-api', {
    cwd: EXTRACTOR_DIR,
    stdio: 'inherit',
  });
}

// -----------------------------
// Query SQLite for production data
// -----------------------------
function getProductionData() {
  console.log('🔍 Querying SQLite database...');

  if (!fs.existsSync(DB_FILE)) {
    console.error('❌ Database file not found:', DB_FILE);
    return null;
  }

  const db = new Database(DB_FILE);

  // Get all records
  const allRecords = db
    .prepare('SELECT * FROM solar ORDER BY timestamp DESC')
    .all();
  console.log(`📊 Found ${allRecords.length} records in database`);

  // Log sample data for debugging
  if (allRecords.length > 0) {
    console.log('📋 Sample records:');
    allRecords.slice(0, 5).forEach((row, i) => {
      console.log(
        `  [${i + 1}] pv_solar: ${row.pv_solar}, solar: ${
          row.solar
        }, timestamp: ${row.timestamp}`
      );
    });
  }

  // Calculate yesterday's total
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterdayStart = yesterday.toISOString();
  const todayStart = today.toISOString();

  console.log(
    `📅 Looking for records between ${yesterdayStart} and ${todayStart}`
  );

  const yesterdayRecords = db
    .prepare('SELECT * FROM solar WHERE timestamp >= ? AND timestamp < ?')
    .all(yesterdayStart, todayStart);

  console.log(`📅 Found ${yesterdayRecords.length} records for yesterday`);

  if (yesterdayRecords.length === 0) {
    // Try using local date parsing
    const localYesterdayStart =
      yesterday.toISOString().split('T')[0] + ' 00:00:00';
    const localTodayStart = today.toISOString().split('T')[0] + ' 00:00:00';
    console.log(
      `📅 Trying local dates: ${localYesterdayStart} to ${localTodayStart}`
    );

    const yesterdayRecordsLocal = db
      .prepare('SELECT * FROM solar WHERE timestamp >= ? AND timestamp < ?')
      .all(localYesterdayStart, localTodayStart);

    console.log(
      `📅 Found ${yesterdayRecordsLocal.length} records using local dates`
    );

    if (yesterdayRecordsLocal.length > 0) {
      const totalSolar = yesterdayRecordsLocal.reduce(
        (sum, row) => sum + (row.solar || 0),
        0
      );
      console.log(
        `🔋 Yesterday's total solar production: ${totalSolar.toFixed(2)} kWh`
      );
      db.close();
      return { yesterdayTotalKwh: totalSolar };
    }
  }

  if (yesterdayRecords.length > 0) {
    const totalSolar = yesterdayRecords.reduce(
      (sum, row) => sum + (row.solar || 0),
      0
    );
    console.log(
      `🔋 Yesterday's total solar production: ${totalSolar.toFixed(2)} kWh`
    );
    db.close();
    return { yesterdayTotalKwh: totalSolar };
  }

  db.close();
  return null;
}

// -----------------------------
// Helpers
// -----------------------------
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

    const productionData = getProductionData();

    console.log('📊 Production data result:', productionData);

    let message;
    if (productionData && productionData.yesterdayTotalKwh != null) {
      message = `Solar production yesterday was ${productionData.yesterdayTotalKwh.toFixed(
        2
      )} kWh`;
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
