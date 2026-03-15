
import fs from "fs";
import path from "path";
import https from "https";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import unzipper from "unzipper";
import SftpClient from "ssh2-sftp-client";
import chalk from "chalk";
import cliProgress from "cli-progress";
import inquirer from "inquirer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const TEMP_DIR = path.join(__dirname, ".tmp");

const REPOS = {
  src: {
    label: "5etools Source (src)",
    owner: "5etools-mirror-3",
    repo: "5etools-src",
  },
  img: {
    label: "5etools Images (img)",
    owner: "5etools-mirror-3",
    repo: "5etools-img",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function find7z() {
  const candidates = process.platform === "win32"
    ? ["7z", "C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
    : ["7z", "7za", "7zz"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["i"], { stdio: "pipe" });
    if (!r.error) return cmd;
  }
  return null;
}

// Fetch the live version from the running 5etools instance via /package.json
async function fetchLiveVersion(serverUrl) {
  const url = serverUrl.replace(/\/$/, "") + "/package.json";
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    return { reachable: false, version: null };
  }
  if (!res.ok) return { reachable: true, version: null };
  try {
    const pkg = await res.json();
    return { reachable: true, version: pkg.version ?? null };
  } catch {
    return { reachable: true, version: null };
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function header() {
  console.clear();
  console.log(chalk.bold.red("  ╔══════════════════════════════════╗"));
  console.log(chalk.bold.red("  ║   5etools Unraid Updater  v1.0   ║"));
  console.log(chalk.bold.red("  ╚══════════════════════════════════╝"));
  console.log();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "5etools-updater/1.0",
        Accept: "application/vnd.github.v3+json",
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse JSON: " + data.slice(0, 200)));
        }
      });
    }).on("error", reject);
  });
}

const PARALLEL_DOWNLOADS = 3;

// Download a single file into destPath, updating its own bar row.
function downloadFilePart(url, destPath, bar) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let startTime = Date.now();
    let lastBytes = 0;
    let lastTime = startTime;

    const follow = (u) => {
      https.get(u, { headers: { "User-Agent": "5etools-updater/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return follow(res.headers.location);
        }
        const totalMB = Math.round((parseInt(res.headers["content-length"] || 0) / 1024 / 1024) * 10) / 10;
        if (totalMB) bar.setTotal(totalMB);

        const file = createWriteStream(destPath);
        res.on("data", (chunk) => {
          bytes += chunk.length;
          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.25) {
            const speedMBs = ((bytes - lastBytes) / 1024 / 1024 / elapsed).toFixed(1);
            lastBytes = bytes;
            lastTime = now;
            bar.update(Math.round((bytes / 1024 / 1024) * 10) / 10, { speed: speedMBs });
          }
        });
        res.pipe(file);
        file.on("finish", () => resolve(bytes));
        file.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

// Download one or more assets with parallel workers and per-file speed bars.
// Returns the path to the final file to extract (combined if split).
async function downloadAssets(assets, destDir, baseName, { skipConcat = false } = {}) {
  const isSplit = assets.some((a) => /\.z\d+$/.test(a.name));

  // Sort split parts: z01…zNN then .zip
  const sorted = isSplit
    ? [...assets].sort((a, b) => {
        const extA = a.name.match(/\.(z\d+|zip)$/)?.[0] ?? "";
        const extB = b.name.match(/\.(z\d+|zip)$/)?.[0] ?? "";
        if (extA === ".zip") return 1;
        if (extB === ".zip") return -1;
        return extA.localeCompare(extB, undefined, { numeric: true });
      })
    : assets;

  const totalMB = Math.round(sorted.reduce((s, a) => s + a.sizeMB, 0) * 10) / 10;
  if (isSplit) {
    console.log(chalk.yellow(`\n  Split archive: ${sorted.length} parts, ~${totalMB} MB total`));
  }

  const multiBar = new cliProgress.MultiBar(
    {
      format:
        "  {name} |" +
        chalk.cyan("{bar}") +
        "| {percentage}% {value}/{total} MB  " +
        chalk.yellow("{speed} MB/s"),
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  // Map asset → { destPath, bar }
  const partPaths = sorted.map((a) => path.join(destDir, a.name));
  const bars = sorted.map((a) =>
    multiBar.create(a.sizeMB || 100, 0, { name: a.name.slice(-12).padStart(12), speed: "0.0" })
  );

  // Run downloads PARALLEL_DOWNLOADS at a time
  const queue = sorted.map((asset, i) => ({ asset, index: i }));
  const workers = Array.from({ length: Math.min(PARALLEL_DOWNLOADS, queue.length) }, async () => {
    while (queue.length) {
      const { asset, index } = queue.shift();
      await downloadFilePart(asset.url, partPaths[index], bars[index]);
      bars[index].update(bars[index].getTotal(), { speed: "done" });
    }
  });

  await Promise.all(workers);
  multiBar.stop();

  if (!isSplit) return partPaths[0];

  if (skipConcat) {
    console.log(chalk.green("  All parts downloaded."));
    return partPaths[partPaths.length - 1]; // last sorted = .zip anchor for 7z
  }

  // Concatenate parts in order
  console.log(chalk.cyan("\n  Concatenating parts..."));
  const combinedPath = path.join(destDir, `${baseName}-combined.zip`);
  const out = createWriteStream(combinedPath);
  for (const p of partPaths) {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(p);
      input.pipe(out, { end: false });
      input.on("end", resolve);
      input.on("error", reject);
    });
  }
  await new Promise((resolve) => out.end(resolve));
  console.log(chalk.green("  Parts combined."));

  for (const p of partPaths) fs.unlinkSync(p);
  return combinedPath;
}

async function getLatestRelease(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const data = await fetchJson(url);
  if (data.message) throw new Error(`GitHub API: ${data.message}`);
  return {
    tag: data.tag_name,
    name: data.name,
    publishedAt: data.published_at?.slice(0, 10),
    assets: data.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      sizeMB: Math.round((a.size / 1024 / 1024) * 10) / 10,
    })),
    zipball: data.zipball_url,
  };
}

async function getReleases(owner, repo, perPage = 20) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error(`GitHub API: ${data.message ?? "unexpected response"}`);
  return data.map((r) => ({
    tag: r.tag_name,
    name: r.name,
    publishedAt: r.published_at?.slice(0, 10),
    assets: r.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      sizeMB: Math.round((a.size / 1024 / 1024) * 10) / 10,
    })),
    zipball: r.zipball_url,
  }));
}

// ─── SFTP Upload ─────────────────────────────────────────────────────────────

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count++;
  }
  return count;
}

async function uploadDirSftp(sftp, localDir, remoteDir, bar) {
  await sftp.mkdir(remoteDir, true).catch(() => {});
  const entries = fs.readdirSync(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = remoteDir.replace(/\\/g, "/") + "/" + entry.name;
    if (entry.isDirectory()) {
      await uploadDirSftp(sftp, localPath, remotePath, bar);
    } else {
      await sftp.put(localPath, remotePath);
      bar.increment(1, { file: entry.name });
    }
  }
}

async function uploadViaSftp(localDir, cfg) {
  const sftp = new SftpClient();

  const bar = new cliProgress.SingleBar(
    {
      format:
        "  Uploading  |" +
        chalk.green("{bar}") +
        "| {percentage}% | {value}/{total} files | {file}",
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );

  try {
    console.log(chalk.cyan(`\n  Connecting via SFTP to ${cfg.host}:${cfg.port}...`));
    await sftp.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: cfg.password,
      // Accept any host key (useful for home servers without strict known_hosts)
      algorithms: { serverHostKey: ["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"] },
    });
    console.log(chalk.green("  Connected!\n"));

    const total = countFiles(localDir);
    bar.start(total, 0, { file: "" });

    await uploadDirSftp(sftp, localDir, cfg.remotePath, bar);

    bar.stop();
    console.log(chalk.green(`\n  Upload complete! ${total} files uploaded.`));
  } finally {
    await sftp.end().catch(() => {});
  }
}

// ─── Flows ──────────────────────────────────────────────────────────────────

async function configureServer() {
  header();
  console.log(chalk.yellow("  Configure SFTP Connection\n"));
  const cfg = loadConfig();

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "serverUrl",
      message: "5etools server URL (for live version check):",
      default: cfg.serverUrl,
    },
    {
      type: "input",
      name: "host",
      message: "SFTP Host (IP or hostname):",
      default: cfg.sftp.host,
    },
    {
      type: "number",
      name: "port",
      message: "SFTP Port:",
      default: cfg.sftp.port,
    },
    {
      type: "input",
      name: "user",
      message: "SFTP Username:",
      default: cfg.sftp.user,
    },
    {
      type: "password",
      name: "password",
      message: "SFTP Password:",
      mask: "*",
      default: cfg.sftp.password,
    },
    {
      type: "input",
      name: "remotePath",
      message: "Remote path on Unraid:",
      default: cfg.sftp.remotePath,
    },
  ]);

  cfg.serverUrl = answers.serverUrl;
  cfg.sftp = { host: answers.host, port: answers.port, user: answers.user, password: answers.password, remotePath: answers.remotePath };
  saveConfig(cfg);
  console.log(chalk.green("\n  Configuration saved!"));
  await pause();
}

async function testConnection() {
  header();
  const cfg = loadConfig();
  const sftp = new SftpClient();
  console.log(chalk.cyan(`  Testing SFTP connection to ${cfg.sftp.host}:${cfg.sftp.port}...`));
  try {
    await sftp.connect({
      host: cfg.sftp.host,
      port: cfg.sftp.port,
      username: cfg.sftp.user,
      password: cfg.sftp.password,
    });
    const list = await sftp.list(cfg.sftp.remotePath).catch(() => []);
    console.log(chalk.green("  Connection successful!"));
    console.log(chalk.gray(`  Remote path has ${list.length} items.`));
  } catch (err) {
    console.log(chalk.red(`  Connection failed: ${err.message}`));
  } finally {
    await sftp.end().catch(() => {});
  }
  await pause();
}

async function checkUpdates() {
  header();
  const cfg = loadConfig();
  console.log(chalk.cyan("  Fetching latest releases from GitHub...\n"));

  // Fetch live server state once so we can detect a wiped www dir
  const live = await fetchLiveVersion(cfg.serverUrl);
  const serverEmpty = live.reachable && !live.version;

  const results = {};
  for (const [key, info] of Object.entries(REPOS)) {
    process.stdout.write(`  Checking ${info.label}... `);
    try {
      const release = await getLatestRelease(info.owner, info.repo);
      const installed = cfg.installedVersions[key];
      // Also mark as new if server is up but has no version file (www was wiped)
      const isNew = !installed || installed !== release.tag || serverEmpty;
      results[key] = { release, installed, isNew };
      if (isNew) {
        console.log(
          chalk.yellow(`${release.tag}`) +
            chalk.gray(` (installed: ${installed || "none"})`) +
            chalk.green(" [UPDATE AVAILABLE]")
        );
      } else {
        console.log(chalk.green(`${release.tag}`) + chalk.gray(" [up to date]"));
      }
    } catch (err) {
      results[key] = { error: err.message };
      console.log(chalk.red(`Error: ${err.message}`));
    }
  }

  console.log();
  const hasUpdates = Object.values(results).some((r) => r.isNew);
  if (!hasUpdates) {
    console.log(chalk.green("  Everything is up to date!"));
    await pause();
    return;
  }

  const updateChoices = Object.entries(results)
    .filter(([, r]) => r.isNew && !r.error)
    .map(([key, r]) => ({
      name: `${REPOS[key].label} — ${r.release.tag} (${r.release.publishedAt})`,
      value: key,
      checked: true,
    }));

  if (updateChoices.length === 0) {
    return;
  }

  const { toUpdate } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "toUpdate",
      message: "Select packages to update (uncheck all + Enter to cancel):",
      choices: updateChoices,
    },
  ]);

  if (toUpdate.length === 0) {
    return;
  }

  for (const key of toUpdate) {
    await runUpdate(key, results[key].release, cfg);
  }
}

async function installSpecificVersion() {
  header();
  console.log(chalk.yellow("  Install Specific Version\n"));

  const { repoKey } = await inquirer.prompt([{
    type: "list",
    name: "repoKey",
    message: "Which repository?",
    choices: Object.entries(REPOS).map(([k, v]) => ({ name: v.label, value: k })),
  }]);

  const { owner, repo } = REPOS[repoKey];
  console.log(chalk.cyan(`\n  Fetching releases for ${REPOS[repoKey].label}...`));

  let releases;
  try {
    releases = await getReleases(owner, repo);
  } catch (err) {
    console.log(chalk.red(`  Error: ${err.message}`));
    await pause();
    return;
  }

  const cfg = loadConfig();

  const { selectedTag } = await inquirer.prompt([{
    type: "list",
    name: "selectedTag",
    message: "Select a version to install:",
    choices: releases.map((r) => ({
      name: `${r.tag.padEnd(20)} ${chalk.gray(r.publishedAt ?? "")}`,
      value: r.tag,
    })),
  }]);

  const release = releases.find((r) => r.tag === selectedTag);
  await runUpdate(repoKey, release, cfg);
}

async function runUpdate(key, release, cfg) {
  header();
  console.log(chalk.cyan(`  Updating ${REPOS[key].label} to ${release.tag}\n`));

  // Detect split archive (.z01, .z02, … + .zip) vs single asset
  const isSplit = release.assets.some((a) => /\.z\d+$/.test(a.name));
  let assetsToDownload;

  if (isSplit) {
    // Use all split parts automatically
    assetsToDownload = release.assets;
    const totalMB = Math.round(assetsToDownload.reduce((s, a) => s + a.sizeMB, 0) * 10) / 10;
    console.log(
      chalk.gray(`  ${assetsToDownload.length} parts — ${totalMB} MB total\n`)
    );
  } else if (release.assets.length > 0) {
    const choices = release.assets.map((a) => ({
      name: `${a.name} (${a.sizeMB} MB)`,
      value: [a],
    }));
    choices.push({ name: "Use source zipball from GitHub", value: null });

    const { selected } = await inquirer.prompt([
      {
        type: "list",
        name: "selected",
        message: "Select file to download:",
        choices,
      },
    ]);
    assetsToDownload = selected ?? [{ name: `${key}-${release.tag}.zip`, url: release.zipball, sizeMB: 0 }];
  } else {
    assetsToDownload = [{ name: `${key}-${release.tag}.zip`, url: release.zipball, sizeMB: 0 }];
  }

  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  const extractDir = path.join(TEMP_DIR, `${key}-${release.tag}`);
  let zipPath;

  const sevenZip = find7z();

  // Pre-sort for reuse check (same sort order as downloadAssets)
  const sortedParts = isSplit
    ? [...assetsToDownload].sort((a, b) => {
        const extA = a.name.match(/\.(z\d+|zip)$/)?.[0] ?? "";
        const extB = b.name.match(/\.(z\d+|zip)$/)?.[0] ?? "";
        if (extA === ".zip") return 1;
        if (extB === ".zip") return -1;
        return extA.localeCompare(extB, undefined, { numeric: true });
      })
    : [];
  const allPartPaths = sortedParts.map((a) => path.join(TEMP_DIR, a.name));

  // Track files to clean up
  const filesToClean = new Set();

  // If 7z + split → prefer individual parts (no concat needed)
  // Otherwise → combined.zip or single file
  const allPartsPresent = isSplit && sevenZip && allPartPaths.every((p) => existsSync(p));
  const combinedZipPath = path.join(TEMP_DIR, `${key}-${release.tag}-combined.zip`);
  const singleFilePath = !isSplit ? path.join(TEMP_DIR, assetsToDownload[0].name) : null;

  if (allPartsPresent) {
    const totalMB = Math.round(allPartPaths.reduce((s, p) => s + fs.statSync(p).size, 0) / 1024 / 1024 * 10) / 10;
    console.log(chalk.yellow(`\n  Found ${allPartPaths.length} existing parts (${totalMB} MB)`));
    const { reuse } = await inquirer.prompt([{ type: "confirm", name: "reuse", message: "Use existing parts and skip download?", default: true }]);
    if (reuse) {
      zipPath = allPartPaths[allPartPaths.length - 1];
      for (const p of allPartPaths) filesToClean.add(p);
    }
  } else {
    const checkPath = isSplit ? combinedZipPath : singleFilePath;
    if (existsSync(checkPath)) {
      const sizeMB = Math.round(fs.statSync(checkPath).size / 1024 / 1024 * 10) / 10;
      console.log(chalk.yellow(`\n  Found existing download: ${path.basename(checkPath)} (${sizeMB} MB)`));
      const { reuse } = await inquirer.prompt([{ type: "confirm", name: "reuse", message: "Use existing file and skip download?", default: true }]);
      if (reuse) { zipPath = checkPath; filesToClean.add(checkPath); }
    }
  }

  try {
    if (!zipPath) {
      console.log(chalk.cyan(`\n  Downloading...`));
      zipPath = await downloadAssets(assetsToDownload, TEMP_DIR, `${key}-${release.tag}`, { skipConcat: isSplit && !!sevenZip });
      if (isSplit && sevenZip) {
        for (const p of allPartPaths) filesToClean.add(p);
      } else {
        filesToClean.add(zipPath);
      }
    }

    console.log(chalk.cyan("\n  Extracting..."));
    if (existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    mkdirSync(extractDir, { recursive: true });
    if (sevenZip) {
      console.log(chalk.gray(`  Using 7-Zip...`));
      const result = spawnSync(sevenZip, ["x", zipPath, `-o${extractDir}`, "-y"], { stdio: "inherit" });
      if (result.status !== 0) throw new Error("7-Zip extraction failed");
    } else {
      const directory = await unzipper.Open.file(zipPath);
      await directory.extract({ path: extractDir, concurrency: 4 });
    }

    // Unwrap single root folder if GitHub wraps the zip
    const entries = fs.readdirSync(extractDir);
    const uploadFrom =
      entries.length === 1 &&
      fs.statSync(path.join(extractDir, entries[0])).isDirectory()
        ? path.join(extractDir, entries[0])
        : extractDir;

    const fileCount = countFiles(uploadFrom);
    console.log(chalk.green(`  Extracted ${fileCount} files.`));

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Upload ${fileCount} files to ${cfg.sftp.host}:${cfg.sftp.remotePath}?`,
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("  Upload skipped."));
      return;
    }

    await uploadViaSftp(uploadFrom, cfg.sftp);

    cfg.installedVersions[key] = release.tag;
    saveConfig(cfg);
    console.log(chalk.green(`\n  ${REPOS[key].label} updated to ${release.tag}!`));
  } catch (err) {
    console.log(chalk.red(`\n  Error during update: ${err.message}`));
  } finally {
    const { cleanup } = await inquirer.prompt([
      {
        type: "confirm",
        name: "cleanup",
        message: "Delete downloaded/extracted temp files?",
        default: true,
      },
    ]);
    if (cleanup) {
      for (const f of filesToClean) if (existsSync(f)) fs.unlinkSync(f);
      if (existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
      console.log(chalk.gray("  Temp files removed."));
    }
  }

  await pause();
}

async function showStatus() {
  header();
  const cfg = loadConfig();

  process.stdout.write(chalk.cyan("  Checking live server... "));
  const live = await fetchLiveVersion(cfg.serverUrl);
  const liveStatusLabel = !live.reachable
    ? chalk.red("unreachable")
    : live.version
      ? chalk.green(`v${live.version}`)
      : chalk.yellow("no version file");
  console.log(liveStatusLabel);
  console.log();

  console.log(chalk.bold("  Configuration\n"));
  console.log(chalk.gray("  Server URL:  ") + chalk.white(cfg.serverUrl));
  console.log(chalk.gray("  SFTP Host:   ") + chalk.white(cfg.sftp.host));
  console.log(chalk.gray("  SFTP Port:   ") + chalk.white(cfg.sftp.port));
  console.log(chalk.gray("  SFTP User:   ") + chalk.white(cfg.sftp.user));
  console.log(chalk.gray("  Remote Path: ") + chalk.white(cfg.sftp.remotePath));
  console.log();

  console.log(chalk.bold("  Versions\n"));
  console.log(
    chalk.gray("  Live (server)".padEnd(32)),
    liveStatusLabel
  );
  for (const [key, info] of Object.entries(REPOS)) {
    const v = cfg.installedVersions[key];
    const match = live.version && (v === `v${live.version}` || (v && v.replace(/^v/, "") === live.version));
    console.log(
      chalk.gray(`  ${info.label.padEnd(30)}`),
      v
        ? (match ? chalk.green(v) : chalk.yellow(v))
        : chalk.red("not installed")
    );
  }
  await pause();
}

function pause() {
  return inquirer.prompt([{ type: "input", name: "_", message: "Press Enter to continue..." }]);
}

// ─── Main Menu ───────────────────────────────────────────────────────────────

async function main() {
  while (true) {
    header();
    const cfg = loadConfig();
    const src = cfg.installedVersions.src;
    const img = cfg.installedVersions.img;
    const live = await fetchLiveVersion(cfg.serverUrl);

    const liveLabel = !live.reachable
      ? chalk.red("unreachable")
      : live.version
        ? chalk.green(`v${live.version}`)
        : chalk.yellow("no version file");

    console.log(
      chalk.gray("  live: ") + liveLabel +
        chalk.gray("   src: ") +
        (src ? chalk.cyan(src) : chalk.red("none")) +
        chalk.gray("   img: ") +
        (img ? chalk.cyan(img) : chalk.red("none")) +
        chalk.gray("   host: ") +
        chalk.white(cfg.sftp.host) +
        "\n"
    );

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "  Check for updates & update", value: "update" },
          { name: "  Test SFTP connection", value: "test" },
          { name: "  Configure SFTP server", value: "config" },
          { name: "  Show status", value: "status" },
          { name: "  Install specific version", value: "specific" },
          new inquirer.Separator(),
          { name: "  Exit", value: "exit" },
        ],
      },
    ]);

    if (action === "exit") {
      console.log(chalk.gray("\n  Goodbye!\n"));
      process.exit(0);
    }
    if (action === "update") await checkUpdates();
    if (action === "test") await testConnection();
    if (action === "config") await configureServer();
    if (action === "status") await showStatus();
    if (action === "specific") await installSpecificVersion();
  }
}

main().catch((err) => {
  console.error(chalk.red("\n  Fatal error: " + err.message));
  process.exit(1);
});
