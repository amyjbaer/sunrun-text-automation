import { execSync } from "child_process";
import fs from "fs";
import nodemailer from "nodemailer";

const METRIC_FILES = ["production.json", "site.json", "battery.json"];

// Read JWT and prospect_id from environment variables
const jwtToken = process.env.SUNRUN_JWT;
const prospectId = process.env.SUNRUN_PROSPECT;

if (!jwtToken || !prospectId) {
  throw new Error("SUNRUN_JWT or SUNRUN_PROSPECT environment variable not set");
}

// Write a temporary config.json for the extractor
const config = { jwt_token: jwtToken, prospect_id: prospectId };
fs.writeFileSync("config.json", JSON.stringify(config));

function runExtractor() {
  console.log("📡 Running Sunrun extractor...");
  execSync("npx sunrun-api-extractor --config config.json", { stdio: "inherit" });
}

function readJsonIfExists(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function buildEmailContent(allMetrics) {
  let lines = [];
  let hasData = false;

  for (const file of METRIC_FILES) {
    lines.push(`=== ${file} ===`);
    const data = allMetrics[file];
    if (!data) {
      lines.push("No data available or not applicable to this system\n");
      continue;
    }
    hasData = true;
    for (const key of Object.keys(data)) {
      lines.push(`${key}: ${JSON.stringify(data[key])}`);
    }
    lines.push(""); // blank line between sections
  }

  if (!hasData) {
    lines.push("⚠️ No metrics were returned by sunrun-api-extractor!");
  }

  return lines.join("\n");
}

async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject,
    text: body,
  });

  console.log("📨 Email sent:", subject);
}

(async () => {
  try {
    runExtractor();

    // Load all metric files if present
    const allMetrics = {};
    for (const file of METRIC_FILES) {
      allMetrics[file] = readJsonIfExists(file);
    }

    const emailBody = buildEmailContent(allMetrics);
    await sendEmail("☀️ Weekly Solar Metrics", emailBody);

  } catch (err) {
    console.error("❌ Script failed:", err);

    // Send failure email
    const body = `The solar monitor script encountered an error:\n\n${err.stack}`;

