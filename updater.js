import fs from "fs";
import path from "path";
import https from "https";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";
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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// Download a single file, updating an existing bar by `sizeMB` increments
function downloadFilePart(url, destPath, bar, totalDownloadedMB) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { "User-Agent": "5etools-updater/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return follow(res.headers.location);
        }
        let partBytes = 0;
        const file = createWriteStream(destPath);
        res.on("data", (chunk) => {
          partBytes += chunk.length;
          bar.update(
            Math.round((totalDownloadedMB + partBytes / 1024 / 1024) * 10) / 10
          );
        });
        res.pipe(file);
        file.on("finish", () => resolve(partBytes));
        file.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

// Download one or more assets, showing a single combined progress bar.
// Returns the path to the final file to extract (combined if split).
async function downloadAssets(assets, destDir, baseName) {
  // Sort split parts: z01, z02, …, zNN, .zip last
  const isSplit = assets.some((a) => /\.z\d+$/.test(a.name));

  if (!isSplit) {
    // Single file download
    const asset = assets[0];
    const destPath = path.join(destDir, asset.name);
    const bar = new cliProgress.SingleBar(
      {
        format:
          "  Downloading |" + chalk.cyan("{bar}") + "| {percentage}% | {value}/{total} MB",
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );
    bar.start(asset.sizeMB || 100, 0);
    await downloadFilePart(asset.url, destPath, bar, 0);
    bar.stop();
    return destPath;
  }

  // Split archive: sort parts z01…zNN then .zip
  const sorted = [...assets].sort((a, b) => {
    const extA = a.name.match(/\.(z(\d+)|zip)$/)?.[0] ?? "";
    const extB = b.name.match(/\.(z(\d+)|zip)$/)?.[0] ?? "";
    if (extA === ".zip") return 1;
    if (extB === ".zip") return -1;
    return extA.localeCompare(extB, undefined, { numeric: true });
  });

  const totalMB = Math.round(sorted.reduce((s, a) => s + a.sizeMB, 0) * 10) / 10;
  console.log(
    chalk.yellow(
      `  Split archive detected: ${sorted.length} parts, ~${totalMB} MB total`
    )
  );

  const bar = new cliProgress.SingleBar(
    {
      format:
        "  Downloading |" +
        chalk.cyan("{bar}") +
        "| {percentage}% | {value}/{total} MB | {filename}",
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(totalMB, 0, { filename: "" });

  const partPaths = [];
  let downloadedMB = 0;
  for (const asset of sorted) {
    bar.update(downloadedMB, { filename: asset.name });
    const partPath = path.join(destDir, asset.name);
    partPaths.push(partPath);
    const bytes = await downloadFilePart(asset.url, partPath, bar, downloadedMB);
    downloadedMB += bytes / 1024 / 1024;
  }
  bar.update(totalMB, { filename: "done" });
  bar.stop();

  // Concatenate all parts into one .zip
  console.log(chalk.cyan("\n  Concatenating split parts..."));
  const combinedPath = path.join(destDir, `${baseName}-combined.zip`);
  const out = createWriteStream(combinedPath);
  for (const partPath of partPaths) {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(partPath);
      input.pipe(out, { end: false });
      input.on("end", resolve);
      input.on("error", reject);
    });
  }
  await new Promise((resolve) => out.end(resolve));
  console.log(chalk.green("  Parts combined."));

  // Clean up individual parts
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

  cfg.sftp = answers;
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

  const results = {};
  for (const [key, info] of Object.entries(REPOS)) {
    process.stdout.write(`  Checking ${info.label}... `);
    try {
      const release = await getLatestRelease(info.owner, info.repo);
      const installed = cfg.installedVersions[key];
      const isNew = !installed || installed !== release.tag;
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
    await pause();
    return;
  }

  const { toUpdate } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "toUpdate",
      message: "Select packages to update:",
      choices: updateChoices,
    },
  ]);

  if (toUpdate.length === 0) {
    console.log(chalk.yellow("  No packages selected."));
    await pause();
    return;
  }

  for (const key of toUpdate) {
    await runUpdate(key, results[key].release, cfg);
  }
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

  try {
    console.log(chalk.cyan(`\n  Downloading...`));
    zipPath = await downloadAssets(assetsToDownload, TEMP_DIR, `${key}-${release.tag}`);

    console.log(chalk.cyan("\n  Extracting..."));
    if (existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

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
      if (existsSync(zipPath)) fs.unlinkSync(zipPath);
      if (existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
      console.log(chalk.gray("  Temp files removed."));
    }
  }

  await pause();
}

async function showStatus() {
  header();
  const cfg = loadConfig();
  console.log(chalk.bold("  Current Configuration\n"));
  console.log(chalk.gray("  SFTP Host:   ") + chalk.white(cfg.sftp.host));
  console.log(chalk.gray("  SFTP Port:   ") + chalk.white(cfg.sftp.port));
  console.log(chalk.gray("  SFTP User:   ") + chalk.white(cfg.sftp.user));
  console.log(chalk.gray("  Remote Path: ") + chalk.white(cfg.sftp.remotePath));
  console.log();
  console.log(chalk.bold("  Installed Versions\n"));
  for (const [key, info] of Object.entries(REPOS)) {
    const v = cfg.installedVersions[key];
    console.log(
      chalk.gray(`  ${info.label.padEnd(30)}`),
      v ? chalk.green(v) : chalk.red("not installed")
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

    console.log(
      chalk.gray("  src: ") +
        (src ? chalk.green(src) : chalk.red("not installed")) +
        chalk.gray("   img: ") +
        (img ? chalk.green(img) : chalk.red("not installed")) +
        chalk.gray("   host: ") +
        chalk.cyan(cfg.sftp.host) +
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
  }
}

main().catch((err) => {
  console.error(chalk.red("\n  Fatal error: " + err.message));
  process.exit(1);
});
