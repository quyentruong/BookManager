const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

const WIN_CODE_SIGN_VERSION = '2.6.0';
const WIN_CODE_SIGN_DIR = `winCodeSign-${WIN_CODE_SIGN_VERSION}`;
const WIN_CODE_SIGN_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${WIN_CODE_SIGN_DIR}/${WIN_CODE_SIGN_DIR}.7z`;

const rawArgs = process.argv.slice(2);
const prepareDefaultWinCodeSignCache = rawArgs.includes('--prepare-default-win-code-sign-cache');
const prepareProjectWinCodeSignCache = rawArgs.includes('--prepare-win-code-sign-cache');
const prepareOnly = prepareDefaultWinCodeSignCache || prepareProjectWinCodeSignCache;
const args = rawArgs.filter(arg => (
    arg !== '--prepare-default-win-code-sign-cache'
    && arg !== '--prepare-win-code-sign-cache'
));
const originalElectronBuilderCache = process.env.ELECTRON_BUILDER_CACHE;
const hasWindowsTarget = args.includes('--win') || args.includes('-w');
const hasMacTarget = args.includes('--mac') || args.includes('-m');
const hasLinuxTarget = args.includes('--linux') || args.includes('-l');
const hasExplicitTarget = hasWindowsTarget
    || hasMacTarget
    || hasLinuxTarget;
const isWindowsBuild = hasWindowsTarget || (!hasExplicitTarget && process.platform === 'win32');
const isMacBuild = hasMacTarget || (!hasExplicitTarget && process.platform === 'darwin');
const isLinuxBuild = hasLinuxTarget || (!hasExplicitTarget && process.platform === 'linux');
const env = { ...process.env };

if (isWindowsBuild && env.CSC_IDENTITY_AUTO_DISCOVERY === undefined) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

function defaultElectronBuilderCache() {
    if (originalElectronBuilderCache) {
        return path.resolve(originalElectronBuilderCache);
    }
    if (process.platform === 'win32') {
        return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
    }
    return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-builder');
}

function findExistingWinCodeSignArchive() {
    const candidates = [
        path.join(defaultElectronBuilderCache(), 'winCodeSign'),
        path.join(process.cwd(), '.electron-builder-cache', 'winCodeSign'),
    ];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const archive = fs.readdirSync(candidate)
            .filter(name => name.toLowerCase().endsWith('.7z'))
            .map(name => path.join(candidate, name))
            .find(filePath => fs.statSync(filePath).size > 0);
        if (archive) return archive;
    }
    return null;
}

function downloadFile(url, outputPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                if (redirectCount >= 5) {
                    reject(new Error('Too many redirects while downloading winCodeSign.'));
                    return;
                }
                downloadFile(response.headers.location, outputPath, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`winCodeSign download failed with HTTP ${response.statusCode}.`));
                return;
            }
            const file = fs.createWriteStream(outputPath);
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
            file.on('error', reject);
        });
        request.on('error', reject);
    });
}

function runProcess(command, commandArgs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${command} exited by signal ${signal}.`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`${command} exited with code ${code}.`));
                return;
            }
            resolve();
        });
    });
}

function projectElectronBuilderCache() {
    return path.join(process.cwd(), '.electron-builder-cache');
}

function isPathInside(parentPath, childPath) {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function removeCachePath(cacheDir, targetPath) {
    if (!isPathInside(cacheDir, targetPath)) {
        throw new Error(`Refusing to remove a path outside the electron-builder cache: ${targetPath}`);
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
}

async function ensureWinCodeSignCache(cacheRoot = projectElectronBuilderCache()) {
    cacheRoot = path.resolve(cacheRoot);
    env.ELECTRON_BUILDER_CACHE = cacheRoot;

    const cacheDir = path.join(cacheRoot, 'winCodeSign');
    const targetDir = path.join(cacheDir, WIN_CODE_SIGN_DIR);
    const markerFile = path.join(targetDir, 'rcedit-x64.exe');
    if (fs.existsSync(markerFile)) return;

    fs.mkdirSync(cacheDir, { recursive: true });
    const archivePath = path.join(cacheDir, `${WIN_CODE_SIGN_DIR}.7z`);
    if (!fs.existsSync(archivePath)) {
        const existingArchive = findExistingWinCodeSignArchive();
        if (existingArchive) {
            fs.copyFileSync(existingArchive, archivePath);
        } else {
            await downloadFile(WIN_CODE_SIGN_URL, archivePath);
        }
    }

    const tempDir = path.join(cacheDir, `${WIN_CODE_SIGN_DIR}-${process.pid}-${Date.now()}`);
    try {
        await runProcess(path7za, ['x', '-bd', archivePath, `-o${tempDir}`, '-snl-']);
        removeCachePath(cacheDir, targetDir);
        fs.renameSync(tempDir, targetDir);
    } catch (error) {
        removeCachePath(cacheDir, tempDir);
        throw error;
    }
}

function hasConfigArg(cliArgs) {
    return cliArgs.some(arg => (
        arg === '--config'
        || arg === '-c'
        || arg.startsWith('--config=')
        || arg.startsWith('-c.')
    ));
}

function createLinuxBuilderConfig() {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    // electron-builder 24 AppImage target passes array ext values directly to app-builder,
    // which expects a single string per entry and fails JSON decoding.
    const buildConfig = {
        ...(packageJson.build || {}),
        fileAssociations: [],
    };
    const tempConfigPath = path.join(
        os.tmpdir(),
        `bookmanager-linux-builder-${process.pid}-${Date.now()}.json`,
    );
    fs.writeFileSync(tempConfigPath, JSON.stringify(buildConfig, null, 2));
    return tempConfigPath;
}

function removeFileQuietly(filePath) {
    if (!filePath) return;
    try {
        fs.rmSync(filePath, { force: true });
    } catch {
        // Ignore cleanup failure for temporary builder config.
    }
}

async function main() {
    if (prepareOnly) {
        if (process.platform === 'win32') {
            await ensureWinCodeSignCache(
                prepareDefaultWinCodeSignCache
                    ? defaultElectronBuilderCache()
                    : projectElectronBuilderCache(),
            );
        }
        return;
    }

    if (isWindowsBuild) {
        await ensureWinCodeSignCache(projectElectronBuilderCache());
    }
    if (isMacBuild) {
        const { buildFileAssociationHelper } = require('./buildFileAssociationHelper.cjs');
        const result = buildFileAssociationHelper();
        if (result.skipped) throw new Error(result.reason);
    }

    const cliArgs = [...args];
    let tempLinuxConfigPath = null;
    if (isLinuxBuild && !hasConfigArg(cliArgs)) {
        tempLinuxConfigPath = createLinuxBuilderConfig();
        cliArgs.push('--config', tempLinuxConfigPath);
    }

    const cliPath = require.resolve('electron-builder/out/cli/cli.js');
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
        stdio: 'inherit',
        env,
    });

    child.on('error', error => {
        removeFileQuietly(tempLinuxConfigPath);
        console.error(error);
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        removeFileQuietly(tempLinuxConfigPath);
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
