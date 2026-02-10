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
        }, timestamp: ${row.timestamp}`
      );
    });
  }

  // Also show daily totals for context
  console.log('\n📊 Daily production totals:');
  const dailyTotals = db
    .prepare(
      `
    SELECT 
      DATE(timestamp) as date,
      SUM(solar) as total_kwh,
      COUNT(*) as readings,
      MIN(timestamp) as first_reading,
      MAX(timestamp) as last_reading
    FROM solar 
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
    LIMIT 7
  `
    )
    .all();

  dailyTotals.forEach((row) => {
    console.log(
      `  ${row.date}: ${row.total_kwh?.toFixed(2) || 0} kWh (${
        row.readings
      } readings)`
    );
  });

  // Calculate total solar production in the 24-hour window
  let totalSolar = 0;
  recentRecords.forEach((row) => {
    totalSolar += row.solar || 0;
  });

  console.log(
    `\n🔋 Total solar production (last 24h): ${totalSolar.toFixed(2)} kWh`
  );

  db.close();
  return {
    yesterdayTotalKwh: totalSolar,
    recordsCount: recentRecords.length,
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
    if (
      productionData &&
      productionData.yesterdayTotalKwh != null &&
      productionData.recordsCount > 0
    ) {
      message = `Solar production (last 24h): ${productionData.yesterdayTotalKwh.toFixed(
        2
      )} kWh (${productionData.recordsCount} readings)`;
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
