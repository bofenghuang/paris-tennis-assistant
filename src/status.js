import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_PATH, STATUS_DIR } from './paths.js';

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}-${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function writeStatus(filePath, status) {
  const value = {
    ...status,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(filePath, value);
  return value;
}

export async function readStatus(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function appendHistory(event) {
  await mkdir(STATUS_DIR, { recursive: true, mode: 0o700 });
  await appendFile(HISTORY_PATH, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
}

export async function countConfirmedThisWeek(now = new Date()) {
  let lines;
  try {
    lines = (await readFile(HISTORY_PATH, 'utf8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  const day = now.getUTCDay() || 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day + 1);
  monday.setUTCHours(0, 0, 0, 0);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.type === 'booking-confirmed' && new Date(event.at) >= monday).length;
}
