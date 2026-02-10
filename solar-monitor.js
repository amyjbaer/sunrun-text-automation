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
// Convert UTC timestamp to Mountain Time date string
// -----------------------------
function getMountainTimeDate(utcTimestamp) {
  const utcDate = new Date(utcTimestamp);
  // Mountain Time is UTC-7 (MDT) or UTC-6 (MST) - use -7 for simplicity
  const mtDate = new Date(utcDate.getTime() - 7 * 60 * 60 * 1000);
  return mtDate.toISOString().split('T')[0];
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
  console.log(`📊 Total records in database: ${allRecords.length}`);

  // Calculate 24-hour window (from 24 hours ago until now)
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const nowISO = now.toISOString();
  const twentyFourHoursAgoISO = twentyFourHoursAgo.toISOString();

  console.log(
    `📅 Looking at last 24 hours: ${twentyFourHoursAgoISO} to ${nowISO}`
  );

  // Query for records in the last 24 hours
  const recentRecords = db
    .prepare(
      'SELECT * FROM solar WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC'
    )
    .all(twentyFourHoursAgoISO, nowISO);

  console.log(`📅 Found ${recentRecords.length} records in last 24 hours`);

  // Log ALL records for debugging
  if (recentRecords.length > 0) {
    console.log('📋 All records in last 24 hours:');
    recentRecords.forEach((row, i) => {
      console.log(
        `  [${i + 1}] pv_solar: ${row.pv_solar}, solar: ${
          row.solar
        }, timestamp: ${row.timestamp} (MT: ${getMountainTimeDate(
          row.timestamp
        )})`
      );
    });
  }

  // Calculate daily totals grouped by Mountain Time date
  console.log('\n📊 Daily production totals (Mountain Time):');

  // Get all records with their raw timestamps
  const allRecordsRaw = db
    .prepare('SELECT solar, timestamp FROM solar ORDER BY timestamp ASC')
    .all();

  // Group by Mountain Time date
  const dailyMap = {};
  allRecordsRaw.forEach((row) => {
    const mtDateStr = getMountainTimeDate(row.timestamp);

    if (!dailyMap[mtDateStr]) {
      dailyMap[mtDateStr] = { total: 0, readings: 0 };
    }
    dailyMap[mtDateStr].total += row.solar || 0;
    dailyMap[mtDateStr].readings += 1;
  });

  // Sort by date descending and log
  const sortedDates = Object.keys(dailyMap).sort().reverse();
  sortedDates.slice(0, 7).forEach((date) => {
    const data = dailyMap[date];
    console.log(
      `  ${date}: ${data.total.toFixed(2)} kWh (${data.readings} readings)`
    );
  });

  db.close();

  // Get the most recent day with data for fallback SMS (using Mountain Time)
  const mostRecentDate = sortedDates.find((d) => (dailyMap[d].total || 0) > 0);

  return {
    recordsCount: recentRecords.length,
    mostRecentDayTotal: mostRecentDate ? dailyMap[mostRecentDate].total : null,
    mostRecentDayDate: mostRecentDate,
  };
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

    console.log('\n📊 Production data result:', productionData);

    let message;
    if (productionData && productionData.mostRecentDayTotal) {
      message = `Solar production (${
        productionData.mostRecentDayDate
      }): ${productionData.mostRecentDayTotal.toFixed(2)} kWh`;
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
