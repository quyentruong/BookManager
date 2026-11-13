import fs from 'fs';
import path from 'path';
import os from 'os';
import { migrateMacAppDataDir } from './macDataMigration.js';

export const APP_DATA_DIR_NAME = 'BookManagerData';
export const LEGACY_APP_DATA_DIR_NAME = 'data';

function isDirectoryWritable(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) return true;
    try {
        fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function isPathInside(parentPath, childPath) {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveLinuxUserDataBaseDir(env = process.env) {
    const dataHome = env?.XDG_DATA_HOME || path.join(env?.HOME || os.homedir(), '.local', 'share');
    return path.join(dataHome, 'BookManager');
}

export function resolvePortableBaseDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    if (platform === 'win32' && env?.PORTABLE_EXECUTABLE_DIR) {
        return env.PORTABLE_EXECUTABLE_DIR;
    }

    const baseDir = executableDir || process.cwd();
    if (platform === 'linux') {
        if (env?.APPIMAGE) {
            const appImageDir = path.dirname(env.APPIMAGE);
            const appImageDataDir = path.join(appImageDir, APP_DATA_DIR_NAME);
            const writableTarget = fs.existsSync(appImageDataDir) ? appImageDataDir : appImageDir;
            return isDirectoryWritable(writableTarget) ? appImageDir : resolveLinuxUserDataBaseDir(env);
        }
        if (env?.APPDIR && isPathInside(env.APPDIR, baseDir)) {
            return resolveLinuxUserDataBaseDir(env);
        }
        return baseDir;
    }

    if (platform !== 'darwin') return baseDir;

    const normalized = path.normalize(baseDir);
    const macOsDir = path.join('Contents', 'MacOS');
    if (!normalized.endsWith(`${path.sep}${macOsDir}`)) return baseDir;

    const appBundleDir = path.dirname(path.dirname(normalized));
    if (path.extname(appBundleDir).toLowerCase() !== '.app') return baseDir;
    return path.dirname(appBundleDir);
}

export function resolveAppDataDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    if (platform === 'darwin') {
        return path.join(env?.HOME || os.homedir(), 'Library', 'Application Support', 'BookManager', APP_DATA_DIR_NAME);
    }
    return path.join(resolvePortableBaseDir(executableDir, platform, env), APP_DATA_DIR_NAME);
}

export function resolveLegacyAppDataDirs(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    const legacyDirs = [
        path.join(resolvePortableBaseDir(executableDir, platform, env), LEGACY_APP_DATA_DIR_NAME),
    ];

    if (platform === 'darwin') {
        const userDataDir = path.dirname(resolveAppDataDir(executableDir, platform, env));
        legacyDirs.unshift(
            path.join(resolvePortableBaseDir(executableDir, platform, env), APP_DATA_DIR_NAME),
            path.join(path.dirname(userDataDir), APP_DATA_DIR_NAME),
        );
        legacyDirs.push(path.join(executableDir || process.cwd(), APP_DATA_DIR_NAME));
        legacyDirs.push(path.join(executableDir || process.cwd(), LEGACY_APP_DATA_DIR_NAME));
        legacyDirs.push(path.join(userDataDir, LEGACY_APP_DATA_DIR_NAME));
    }

    const currentDir = path.resolve(resolveAppDataDir(executableDir, platform, env));
    return legacyDirs
        .filter(Boolean)
        .filter((legacyDir, index, dirs) => (
            path.resolve(legacyDir) !== currentDir
            && dirs.findIndex(candidate => path.resolve(candidate) === path.resolve(legacyDir)) === index
        ));
}

export function migrateLegacyAppDataDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    const appDataDir = resolveAppDataDir(executableDir, platform, env);
    if (platform === 'darwin') {
        return migrateMacAppDataDir(appDataDir, resolveLegacyAppDataDirs(executableDir, platform, env), {
            portableDataDir: path.join(resolvePortableBaseDir(executableDir, platform, env), APP_DATA_DIR_NAME),
        });
    }
    if (fs.existsSync(appDataDir)) return appDataDir;

    for (const legacyDir of resolveLegacyAppDataDirs(executableDir, platform, env)) {
        if (!fs.existsSync(legacyDir)) continue;

        fs.mkdirSync(path.dirname(appDataDir), { recursive: true });
        try {
            fs.renameSync(legacyDir, appDataDir);
            return appDataDir;
        } catch {
            fs.cpSync(legacyDir, appDataDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
            return appDataDir;
        }
    }

    return appDataDir;
}

export function resolveLibraryDbPath(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'library.db');
}

export function resolveContentIndexDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'content_index');
}

export function resolveContentIndexDbPath(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveContentIndexDir(executableDir, platform, env), 'content.db');
}

export function resolveApiCacheDbPath(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), '.api_cache.db');
}

export function resolveApiCoverCacheDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'api_cover_cache');
}

export function resolveConfigPath(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'config.json');
}

export function resolveRenameHistoryPath(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'rename_history.json');
}

export function resolveThumbnailDir(executableDir = process.cwd(), platform = process.platform, env = process.env) {
    return path.join(resolveAppDataDir(executableDir, platform, env), 'thumbnails');
}
