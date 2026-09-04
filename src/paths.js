import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(sourceDirectory, '..');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const STATUS_DIR = path.join(DATA_DIR, 'status');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
export const RUNNER_STATUS_PATH = path.join(STATUS_DIR, 'runner.json');
export const LOGIN_STATUS_PATH = path.join(STATUS_DIR, 'login.json');
export const RUN_LOCK_PATH = path.join(DATA_DIR, 'runner.lock');
export const HISTORY_PATH = path.join(DATA_DIR, 'history.jsonl');
