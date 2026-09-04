import { chmod, mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, validateConfig } from './config.js';
import { computeTargetDate } from './domain.js';
import {
  AUTH_PATH,
  RUN_LOCK_PATH,
  RUNNER_STATUS_PATH,
  RUNS_DIR,
} from './paths.js';
import {
  assessReservationPage,
  clickCandidate,
  confirmFinalReservationReview,
  continueAfterHumanVerification,
  continueToNextReservationStep,
  fillConfiguredPartner,
  isLoggedOut,
  isTransientNavigationError,
  openSearchPage,
  searchAndRank,
  useExistingPassOnly,
  waitForStableDocument,
  waitForReleasedDate,
} from './site.js';
import {
  assessSearchReliability,
  searchAttemptLimit,
  summarizeSearchAttempt,
} from './search-reliability.js';
import { appendHistory, countConfirmedThisWeek, writeStatus } from './status.js';

const dryRun = process.argv.includes('--dry-run');
const forceHeaded = process.argv.includes('--headed');
const manualLive = process.argv.includes('--manual-live');

function safeRunName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireLock() {
  await mkdir(path.dirname(RUN_LOCK_PATH), { recursive: true, mode: 0o700 });
  try {
    return await open(RUN_LOCK_PATH, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lockStat = await stat(RUN_LOCK_PATH);
    if (Date.now() - lockStat.mtimeMs < 45 * 60 * 1_000) return null;
    await unlink(RUN_LOCK_PATH);
    return open(RUN_LOCK_PATH, 'wx', 0o600);
  }
}

async function releaseLock(handle) {
  await handle?.close().catch(() => {});
  await unlink(RUN_LOCK_PATH).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function update(code, message, extra = {}) {
  return writeStatus(RUNNER_STATUS_PATH, {
    code,
    message,
    dryRun,
    manualLive,
    ...extra,
  });
}

async function capture(page, runDirectory, name) {
  const filePath = path.join(runDirectory, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  await chmod(filePath, 0o600).catch(() => {});
  return filePath;
}

function verificationMessage(assessment, nextAttempt, totalAttempts, targetIso) {
  const venues = assessment.affectedVenues.length > 0
    ? `（${assessment.affectedVenues.join('、')}）`
    : '';
  if (assessment.reason === 'missing-venue') {
    return `${targetIso} 的官网球场列表不完整${venues}，正在刷新复核 ${nextAttempt}/${totalAttempts}…`;
  }
  if (assessment.reason === 'higher-priority-empty') {
    return `${targetIso} 的较高优先级球场暂时显示无可用场次${venues}，正在刷新复核 ${nextAttempt}/${totalAttempts}…`;
  }
  return `${targetIso} 暂时没有合适场次，正在刷新复核 ${nextAttempt}/${totalAttempts}…`;
}

async function searchDateWithReliability(page, config, targetIso, statusExtra = {}) {
  let searchResult = { candidates: [], ranked: [], noResult: false, venueStates: [] };
  let assessment = assessSearchReliability(searchResult, config);
  const attempts = [];
  const maximumPossibleAttempts = Math.max(
    config.release.searchAttempts,
    config.release.noAvailabilityAttempts,
  );
  let totalAttempts = config.release.searchAttempts;

  for (let attempt = 1; attempt <= maximumPossibleAttempts; attempt += 1) {
    if (attempt > 1) {
      const retryDelayMs = attempt === 2
        ? Math.min(1_000, config.release.retryIntervalSeconds * 1_000)
        : config.release.retryIntervalSeconds * 1_000;
      await page.waitForTimeout(retryDelayMs);
      await openSearchPage(page, { fresh: true });
    }

    searchResult = await searchAndRank(page, config, targetIso);
    assessment = assessSearchReliability(searchResult, config);
    const attemptLimit = searchAttemptLimit(assessment, config.release);
    totalAttempts = Math.max(totalAttempts, attemptLimit);
    attempts.push({
      dateIso: targetIso,
      ...summarizeSearchAttempt(searchResult, assessment, attempt),
    });
    if (!assessment.shouldRetry || attempt >= attemptLimit) break;

    await update(
      'VERIFYING_AVAILABILITY',
      verificationMessage(assessment, attempt + 1, attemptLimit, targetIso),
      {
        targetDate: targetIso,
        ...statusExtra,
        verification: { attempts, totalAttempts: attemptLimit },
      },
    );
  }

  return {
    searchResult,
    assessment,
    verification: {
      attempts,
      refreshed: attempts.length > 1,
      totalAttempts,
    },
  };
}

function selectReservationPage(context, currentPage) {
  const openPages = context.pages().filter((candidatePage) => !candidatePage.isClosed());
  if (openPages.length === 0) return null;
  const relevantPages = openPages.filter((candidatePage) =>
    /tennis\.paris\.fr|v70-auth\.paris\.fr/.test(candidatePage.url()),
  );
  const newestRelevantPage = relevantPages.at(-1);
  if (newestRelevantPage && newestRelevantPage !== currentPage) return newestRelevantPage;
  if (currentPage && !currentPage.isClosed()) return currentPage;
  return newestRelevantPage ?? openPages.at(-1);
}

async function recoverReservationPage(context, currentPage) {
  let nextPage = selectReservationPage(context, currentPage);
  if (!nextPage) {
    nextPage = await context.waitForEvent('page', { timeout: 3_000 }).catch(() => null);
  }
  if (!nextPage) return null;
  await waitForStableDocument(nextPage, 350);
  const newestPage = selectReservationPage(context, nextPage) ?? nextPage;
  if (newestPage !== nextPage) await waitForStableDocument(newestPage, 350);
  return newestPage.isClosed() ? null : newestPage;
}

async function runReservationFlow(initialPage, minutes, candidate, runDirectory, config) {
  const deadline = Date.now() + minutes * 60_000;
  const context = initialPage.context();
  let page = initialPage;
  let previousStage = null;
  let paymentAttempts = 0;
  let partnerAttempted = false;
  let existingPassSelected = false;
  let finalConfirmationAttempted = false;
  while (Date.now() < deadline) {
    page = await recoverReservationPage(context, page);
    if (!page) return 'closed';
    let assessment = null;
    try {
      assessment = await assessReservationPage(page);
      if (assessment.stage === 'confirmed') {
        await capture(page, runDirectory, 'confirmed');
        await appendHistory({ type: 'booking-confirmed', candidate });
        await update('BOOKING_CONFIRMED', assessment.message, { candidate });
        return 'confirmed';
      }
      if (assessment.stage === 'closed') {
        const replacementPage = await recoverReservationPage(context, page);
        if (!replacementPage) return 'closed';
        page = replacementPage;
        previousStage = null;
        continue;
      }
      if (assessment.stage === 'auth-required') return assessment.stage;
      if (assessment.stage === 'transitioning') {
        await update('RESERVATION_CONTINUING', assessment.message, {
          candidate,
          stage: assessment.stage,
        });
        previousStage = null;
        await waitForStableDocument(page, 500);
        continue;
      }
      if (assessment.stage !== 'guest') partnerAttempted = false;

      if (assessment.stage === 'captcha') {
        if (previousStage !== assessment.stage) {
          previousStage = assessment.stage;
          await update('ACTION_REQUIRED', assessment.message, { candidate, stage: assessment.stage });
          await page.bringToFront().catch(() => {});
        }
        const continuation = await continueAfterHumanVerification(page);
        if (continuation.status === 'progressed') {
          await update('RESERVATION_CONTINUING', continuation.message, { candidate, stage: assessment.stage });
          previousStage = null;
        }
        await page.waitForTimeout(1_000);
        continue;
      }

      if (assessment.stage === 'guest') {
        if (!partnerAttempted) {
          partnerAttempted = true;
          await update('PARTNER_PROCESSING', '正在填写并添加默认同行者…', {
            candidate,
            stage: assessment.stage,
          });
          const partner = await fillConfiguredPartner(page, config.partner);
          if (partner.status === 'blocked') {
            previousStage = assessment.stage;
            await capture(page, runDirectory, 'partner-action-required');
            await update('ACTION_REQUIRED', partner.message, {
              candidate,
              stage: assessment.stage,
              partnerReason: partner.reason,
            });
            await page.bringToFront().catch(() => {});
          } else {
            previousStage = null;
            await update('PARTNER_SUBMITTED', partner.message, {
              candidate,
              stage: assessment.stage,
            });
          }
        }
        await page.waitForTimeout(1_200);
        continue;
      }

      if (assessment.stage === 'rules') {
        await update('RESERVATION_CONTINUING', assessment.message, {
          candidate,
          stage: assessment.stage,
        });
        const continuation = await continueToNextReservationStep(page);
        if (continuation.status === 'waiting') {
          previousStage = assessment.stage;
          await update('ACTION_REQUIRED', continuation.message, {
            candidate,
            stage: assessment.stage,
          });
          await page.bringToFront().catch(() => {});
        } else {
          previousStage = null;
          await update('RESERVATION_CONTINUING', continuation.message, {
            candidate,
            stage: assessment.stage,
          });
        }
        await page.waitForTimeout(1_000);
        continue;
      }

      if (assessment.stage === 'final-review') {
        if (finalConfirmationAttempted) {
          await page.waitForTimeout(1_000);
          continue;
        }
        finalConfirmationAttempted = true;
        await update('FINAL_CONFIRMATION_PROCESSING', assessment.message, {
          candidate,
          stage: assessment.stage,
        });
        const finalConfirmation = await confirmFinalReservationReview(page, { existingPassSelected });
        if (finalConfirmation.status === 'blocked') {
          finalConfirmationAttempted = false;
          await capture(page, runDirectory, 'final-confirmation-required');
          await update('ACTION_REQUIRED', finalConfirmation.message, {
            candidate,
            stage: assessment.stage,
            finalConfirmationReason: finalConfirmation.reason,
          });
          await page.bringToFront().catch(() => {});
        } else {
          previousStage = null;
          await update('FINAL_CONFIRMATION_SUBMITTED', finalConfirmation.message, {
            candidate,
            stage: assessment.stage,
          });
        }
        await page.waitForTimeout(1_000);
        continue;
      }

      if (assessment.stage === 'payment') {
        paymentAttempts += 1;
        if (paymentAttempts > 3) {
          await capture(page, runDirectory, 'payment-blocked');
          await update('PAYMENT_BLOCKED', '付款页连续出现且未能确认结果；已停止，未改用其他付款方式。', {
            candidate,
            stage: assessment.stage,
          });
          return 'payment-blocked';
        }

        await update('PAYMENT_PROCESSING', '正在仅使用已有 Abonnement 10h 余额确认预约…', {
          candidate,
          stage: assessment.stage,
        });
        const payment = await useExistingPassOnly(page, { maxPriceEuros: config.maxPriceEuros });
        if (payment.status === 'blocked') {
          await capture(page, runDirectory, 'payment-blocked');
          await update('PAYMENT_BLOCKED', payment.message, {
            candidate,
            stage: assessment.stage,
            paymentReason: payment.reason,
          });
          return 'payment-blocked';
        }

        existingPassSelected = payment.existingPassSelected !== false;

        await update(
          payment.status === 'submitted' ? 'PAYMENT_SUBMITTED' : 'PAYMENT_PROCESSING',
          payment.message,
          { candidate, stage: assessment.stage, passLabel: payment.passLabel },
        );
        previousStage = null;
        await page.waitForTimeout(1_200);
        continue;
      }

      if (assessment.stage !== previousStage) {
        previousStage = assessment.stage;
        await update('ACTION_REQUIRED', assessment.message, { candidate, stage: assessment.stage });
        await page.bringToFront().catch(() => {});
      }
      await page.waitForTimeout(2_000);
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      if (assessment?.stage === 'payment') paymentAttempts = Math.max(0, paymentAttempts - 1);
      partnerAttempted = false;
      previousStage = null;
      await update('RESERVATION_CONTINUING', '官网正在切换预约步骤；助手已等待跳转并继续跟随后续页面。', {
        candidate,
        stage: assessment?.stage ?? 'transitioning',
      });
      page = await recoverReservationPage(context, page);
      if (!page) return 'closed';
    }
  }
  return page.isClosed() ? 'closed' : 'timeout';
}

async function main() {
  const lock = await acquireLock();
  if (!lock) {
    await update('ALREADY_RUNNING', '已有一次搜索正在运行，本次已安全跳过。');
    return;
  }

  let browser;
  try {
    const config = await loadConfig();
    const bookingEnabled = !dryRun && (manualLive || config.mode === 'assist');
    if (!dryRun && !manualLive && !config.armed) {
      await update('NOT_ARMED', '任务尚未启用；没有访问预约页面。');
      return;
    }

    const errors = validateConfig(config, { requireRunnable: true });
    if (errors.length > 0) {
      await update('CONFIG_REQUIRED', errors.join(' '));
      process.exitCode = 2;
      return;
    }

    const target = computeTargetDate(new Date(), config.release.targetOffsetDays);
    if (!config.targetWeekdays.includes(target.weekday)) {
      await update('DAY_SKIPPED', `最新开放日期 ${target.iso} 不在所选星期内，本次跳过。`, {
        targetDate: target.iso,
      });
      return;
    }

    if (!dryRun && (await countConfirmedThisWeek()) >= config.safety.maxBookingsPerWeek) {
      await update('WEEKLY_LIMIT', '本地记录显示本周已确认 2 场，本次不再尝试。', {
        targetDate: target.iso,
      });
      return;
    }

    const hasAuth = await fileExists(AUTH_PATH);
    if (bookingEnabled && !hasAuth) {
      await update('AUTH_REQUIRED', '尚未保存登录会话；请先在应用里点击“登录 Paris Tennis”。');
      return;
    }

    const runDirectory = path.join(RUNS_DIR, safeRunName());
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await update('STARTING', `正在搜索最新开放日期 ${target.iso} 的场次…`, {
      targetDate: target.iso,
    });

    browser = await chromium.launch({
      headless: dryRun ? true : forceHeaded ? false : config.browser.headless,
    });
    const context = await browser.newContext(hasAuth ? { storageState: AUTH_PATH } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    await openSearchPage(page);
    const loggedOut = await isLoggedOut(page);
    if (bookingEnabled && loggedOut) {
      await capture(page, runDirectory, 'auth-required');
      await update('AUTH_REQUIRED', '登录会话已过期；请重新登录后再试。', {
        targetDate: target.iso,
      });
      return;
    }

    const release = await waitForReleasedDate(
      page,
      target.iso,
      config.release.waitSeconds,
      config.release.retryIntervalSeconds,
    );
    if (!release.released) {
      await capture(page, runDirectory, 'release-not-ready');
      await update('RELEASE_NOT_READY', `等待后仍未看到最新开放日期 ${target.iso}，没有提交预约。`, {
        targetDate: target.iso,
        releasedDates: release.dates,
      });
      return;
    }

    const { assessment, verification } = await searchDateWithReliability(page, config, target.iso);
    const usableCandidates = assessment.usableCandidates;
    const summarizedCandidates = usableCandidates.slice(0, 10).map(({ bookingKey, ...candidate }) => candidate);
    await capture(page, runDirectory, 'availability');

    if (assessment.reason === 'missing-venue' && assessment.shouldRetry) {
      await update(
        'SITE_UNSTABLE',
        `连续复核 ${verification.attempts.length} 次后，官网结果仍缺少 ${assessment.affectedVenues.join('、')}；没有基于不完整结果预约。`,
        {
          targetDate: target.iso,
          candidates: [],
          verification,
        },
      );
      return;
    }

    if (usableCandidates.length === 0) {
      const verificationSuffix = verification.refreshed
        ? ` 已自动刷新复核 ${verification.attempts.length} 次。`
        : '';
      await update('NO_AVAILABILITY', `没有找到符合价格与时段偏好的 ${target.iso} 场次。${verificationSuffix}`, {
        targetDate: target.iso,
        candidates: [],
        verification,
      });
      return;
    }

    const bestVisible = usableCandidates[0];
    if (!bookingEnabled) {
      const verificationSuffix = verification.refreshed
        ? ` 已自动刷新复核 ${verification.attempts.length} 次。`
        : '';
      await update('AVAILABLE', `找到 ${usableCandidates.length} 个符合条件的场次；未点击预约。${verificationSuffix}`, {
        targetDate: target.iso,
        candidate: { ...bestVisible, bookingKey: undefined },
        candidates: summarizedCandidates,
        verification,
      });
      return;
    }

    const bestBookable = usableCandidates.find((candidate) => candidate.availability === 'bookable');
    if (!bestBookable) {
      const accountLimited = usableCandidates.some((candidate) => candidate.availability === 'account-limit');
      await update(
        accountLimited ? 'ACCOUNT_LIMIT' : 'AUTH_REQUIRED',
        accountLimited ? '网站提示账户已有预约或达到限制，本次未继续。' : '看到了场次，但登录状态不可用于预约。',
        { targetDate: target.iso, candidates: summarizedCandidates, verification },
      );
      return;
    }

    const clickResult = await clickCandidate(page, bestBookable);
    if (!clickResult.clicked) {
      await update('SITE_CHANGED', '场次仍可见，但预约按钮结构已变化；没有猜测点击。', {
        targetDate: target.iso,
        candidate: { ...bestBookable, bookingKey: undefined },
      });
      return;
    }

    const candidateForStatus = { ...bestBookable, bookingKey: undefined };
    await capture(page, runDirectory, 'reservation-flow');
    const outcome = await runReservationFlow(
      page,
      config.browser.takeoverMinutes,
      candidateForStatus,
      runDirectory,
      config,
    );
    if (outcome === 'timeout') {
      await update('TAKEOVER_TIMEOUT', '预约流程等待时间已结束；请查看 Paris Tennis 账户确认是否完成。', {
        candidate: candidateForStatus,
      });
    } else if (outcome === 'closed') {
      await update('TAKEOVER_CLOSED', '预约窗口已关闭，未检测到确认页面。', { candidate: candidateForStatus });
    } else if (outcome === 'auth-required') {
      await update('AUTH_REQUIRED', '预约过程中登录失效，请重新登录。', { candidate: candidateForStatus });
    }
  } catch (error) {
    await update('ERROR', `运行失败：${String(error.message).split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await releaseLock(lock);
  }
}

await main();
