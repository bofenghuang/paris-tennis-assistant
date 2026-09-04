import { chmod, stat } from 'node:fs/promises';
import { chromium } from 'playwright';
import { AUTH_PATH, LOGIN_STATUS_PATH } from './paths.js';
import { isAuthenticated, SEARCH_URL, startLogin } from './site.js';
import { writeStatus } from './status.js';

async function authExists() {
  try {
    await stat(AUTH_PATH);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function authenticatedPage(context) {
  for (const page of context.pages()) {
    if (await isAuthenticated(page).catch(() => false)) return page;
  }
  return null;
}

async function main() {
  await writeStatus(LOGIN_STATUS_PATH, {
    code: 'OPENING',
    message: '正在打开安全登录窗口…',
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext((await authExists()) ? { storageState: AUTH_PATH } : {});
    const page = await context.newPage();
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (!(await authenticatedPage(context))) {
      await writeStatus(LOGIN_STATUS_PATH, {
        code: 'WAITING_FOR_USER',
        message: '请在弹出的 Paris 登录窗口中手动完成登录。应用不会读取或保存密码。',
      });
      await startLogin(page);
    }

    const deadline = Date.now() + 10 * 60_000;
    while (context.pages().some((candidate) => !candidate.isClosed()) && Date.now() < deadline) {
      const authenticated = await authenticatedPage(context);
      if (authenticated) {
        await context.storageState({ path: AUTH_PATH });
        await chmod(AUTH_PATH, 0o600);
        await writeStatus(LOGIN_STATUS_PATH, {
          code: 'AUTHENTICATED',
          message: '登录会话已保存，仅当前用户可读取。',
        });
        await authenticated.waitForTimeout(1_500);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    await writeStatus(LOGIN_STATUS_PATH, {
      code: context.pages().every((candidate) => candidate.isClosed()) ? 'CLOSED' : 'TIMEOUT',
      message: context.pages().every((candidate) => candidate.isClosed())
        ? '登录窗口已关闭，未保存新会话。'
        : '登录等待已超时，请重新尝试。',
    });
  } catch (error) {
    await writeStatus(LOGIN_STATUS_PATH, {
      code: 'ERROR',
      message: `登录流程失败：${String(error.message).split('\n')[0]}`,
    });
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}

await main();
