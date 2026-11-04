require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const tar = require("tar");

const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, "bin");
const CONFIG_PATH = path.join(APP_DIR, "config.json");

const WALLET = process.env.XMR_WALLET || "";
const POOL_URL = process.env.POOL_URL || "";
const POOL_PASS = process.env.POOL_PASS || "";
const RIG_ID = process.env.RIG_ID || "";
const POOL_TLS = String(process.env.POOL_TLS || "false").toLowerCase() === "true";
const DONATE_LEVEL = process.env.DONATE_LEVEL || "";

const XMRIG_THREADS = process.env.XMRIG_THREADS || "0";
const XMRIG_MAX_THREADS_HINT = process.env.XMRIG_MAX_THREADS_HINT || "";

const GITHUB_LATEST_RELEASE = "https://api.github.com/repos/xmrig/xmrig/releases/latest";

function log(message) {
  console.log(`[xmrig] ${message}`);
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "node-xmrig-downloader",
          Accept: "application/vnd.github+json"
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchJson(res.headers.location).then(resolve).catch(reject);
        }

        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }

          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destination).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        fs.unlink(destination, () => {});
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }

      res.pipe(file);

      file.on("finish", () => {
        file.close(() => resolve());
      });
    }).on("error", (err) => {
      fs.unlink(destination, () => {});
      reject(err);
    });
  });
}

async function getXMRigAssetUrl() {
  const release = await fetchJson(GITHUB_LATEST_RELEASE);
  const assets = release.assets || [];

  const asset = assets.find((a) => {
    const name = (a.name || "").toLowerCase();

    const hasTar = name.endsWith(".tar.gz");
    const isLinux = name.includes("linux");
    const hasArch =
      name.includes("x64") ||
      name.includes("x86_64") ||
      name.includes("amd64");

    const isNotArm =
      !name.includes("arm") &&
      !name.includes("aarch") &&
      !name.includes("arm64") &&
      !name.includes("android") &&
      !name.includes("darwin") &&
      !name.includes("macos") &&
      !name.includes("win");

    return hasTar && isLinux && hasArch && isNotArm;
  });

  if (!asset) {
    const names = assets.map((a) => a.name).join("\n");
    throw new Error(
      "No compatible XMRig Linux x64 tar.gz asset was found in the latest release.\nAvailable assets:\n" + names
    );
  }

  return asset.browser_download_url;
}

async function ensureXMRigBinary() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const binaryPath = path.join(BIN_DIR, "xmrig");
  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  const assetUrl = await getXMRigAssetUrl();
  const archivePath = path.join(BIN_DIR, "xmrig.tar.gz");

  log(`Downloading XMRig from ${assetUrl}`);
  await downloadFile(assetUrl, archivePath);

  log("Extracting XMRig...");
  await tar.x({
    file: archivePath,
    cwd: BIN_DIR,
    strip: 1
  });

  const realBinary = path.join(BIN_DIR, "xmrig");
  if (!fs.existsSync(realBinary)) {
    throw new Error("XMRig binary was not found after extraction.");
  }

  fs.chmodSync(realBinary, 0o755);

  try {
    fs.unlinkSync(archivePath);
  } catch (err) {
    // ignore cleanup
  }

  return realBinary;
}

function writeConfig() {
  const config = {
    autosave: true,
    cpu: {
      enabled: true,
      "huge-pages": true,
      asm: true,
      "max-threads-hint": Number(XMRIG_MAX_THREADS_HINT)
    },
    opencl: false,
    cuda: false,
    syslog: false,
    verbose: 0,
    pools: [
      {
        url: POOL_URL,
        user: WALLET,
        pass: POOL_PASS,
        keepalive: true,
        tls: POOL_TLS,
        algo: null,
        coin: null,
        "rig-id": RIG_ID,
        nicehash: false,
        enabled: true
      }
    ],
    "donate-level": Number(DONATE_LEVEL),
    background: false
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  log(`Config written to ${CONFIG_PATH}`);
}

function buildArgs() {
  const args = ["--config", CONFIG_PATH];

  if (XMRIG_THREADS && XMRIG_THREADS !== "0" && XMRIG_THREADS !== "auto") {
    args.push("--threads", String(XMRIG_THREADS));
  }

  args.push("--cpu-max-threads-hint", String(XMRIG_MAX_THREADS_HINT));

  return args;
}

async function startMiner() {
  if (!WALLET) {
    throw new Error("Missing wallet. Set XMR_WALLET in your environment or .env");
  }

  const xmrigPath = await ensureXMRigBinary();
  writeConfig();

  log(`Pool: ${POOL_URL}`);
  log(`Wallet: ${WALLET.slice(0, 12)}...`);
  log(`Rig ID: ${RIG_ID}`);
  log(`Threads: ${XMRIG_THREADS}`);
  log(`CPU max threads hint: ${XMRIG_MAX_THREADS_HINT}`);

  const args = buildArgs();
  log(`Running: ${xmrigPath} ${args.join(" ")}`);

  const child = spawn(xmrigPath, args, {
    cwd: APP_DIR,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`XMRig exited with signal: ${signal}`);
      process.exit(1);
    }

    if (code !== 0) {
      log(`XMRig exited with code: ${code}`);
      process.exit(code || 1);
    }
  });

  child.on("error", (err) => {
    console.error("Failed to start XMRig:", err);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
}

startMiner().catch((err) => {
  console.error("Fatal error:");
  console.error(err.message);
  process.exit(1);
});