// Studio Caillou: tests of the YouTube thumbnail helper.
// The repository has no jest project for the providers, so this file runs with
// the Node test runner (type stripping, Node 23.6 or later):
//   node --test libraries/nestjs-libraries/src/integrations/social/youtube.thumbnail.spec.ts
// It is excluded from every build by the `**/*spec.ts` pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeThumbnailError,
  formatThumbnailError,
  isRetryableThumbnailError,
  setThumbnailWithRetry,
  THUMBNAIL_RETRY_DELAYS_MS,
} from './youtube.thumbnail.ts';

// Shape of a GaxiosError thrown by googleapis on thumbnails.set, including
// the request config that carries the bearer token.
const gaxiosError = (status: number, reason: string, message: string) => {
  const err: any = new Error(message);
  err.code = String(status);
  err.config = {
    url: 'https://youtube.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=abc',
    headers: { Authorization: 'Bearer FAKE-SECRET-ACCESS-TOKEN' },
  };
  err.response = {
    status,
    headers: { 'x-guploader-uploadid': 'xyz' },
    config: err.config,
    data: {
      error: {
        code: status,
        message,
        errors: [{ message, domain: 'youtube.thumbnail', reason }],
      },
    },
  };
  return err;
};

test('extracts status, reason, domain and message of a Google error', () => {
  const info = describeThumbnailError(
    gaxiosError(
      403,
      'forbidden',
      "The authenticated user doesn't have permissions to upload and set custom video thumbnails."
    )
  );
  assert.equal(info.status, 403);
  assert.equal(info.reason, 'forbidden');
  assert.equal(info.domain, 'youtube.thumbnail');
  assert.match(info.message, /doesn't have permissions/);
});

test('never leaks the access token or the request config', () => {
  const err = gaxiosError(429, 'uploadRateLimitExceeded', 'Too many thumbnails');
  const text = formatThumbnailError(describeThumbnailError(err));
  assert.doesNotMatch(text, /SECRET-ACCESS-TOKEN/);
  assert.doesNotMatch(text, /Bearer/);
  assert.doesNotMatch(text, /Authorization/i);
  assert.match(text, /status=429/);
  assert.match(text, /reason=uploadRateLimitExceeded/);
});

test('reads the status from err.status (gaxios 7) and from a numeric code', () => {
  assert.equal(describeThumbnailError({ status: 404, message: 'x' }).status, 404);
  assert.equal(describeThumbnailError({ code: 500, message: 'x' }).status, 500);
});

test('a network error has no status and keeps its code', () => {
  const info = describeThumbnailError(
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  );
  assert.equal(info.status, undefined);
  assert.equal(info.reason, 'ECONNRESET');
  assert.match(info.message, /socket hang up/);
});

test('truncates a very long message', () => {
  const info = describeThumbnailError({ status: 400, message: 'a'.repeat(5000) });
  assert.ok(info.message.length <= 520);
});

test('retries what can pass later', () => {
  assert.equal(isRetryableThumbnailError({ status: 404, reason: 'videoNotFound', message: '' }), true);
  assert.equal(isRetryableThumbnailError({ status: 409, message: '' }), true);
  assert.equal(isRetryableThumbnailError({ status: 429, reason: 'uploadRateLimitExceeded', message: '' }), true);
  assert.equal(isRetryableThumbnailError({ status: 500, message: '' }), true);
  assert.equal(isRetryableThumbnailError({ status: 503, message: '' }), true);
  assert.equal(isRetryableThumbnailError({ reason: 'ECONNRESET', message: 'socket hang up' }), true);
  // ambiguous 403 of the documentation: may be a video still processing
  assert.equal(
    isRetryableThumbnailError({
      status: 403,
      reason: 'forbidden',
      message: "The thumbnail can't be set for the specified video. The request might not be properly authorized.",
    }),
    true
  );
});

test('never retries a clear refusal', () => {
  assert.equal(
    isRetryableThumbnailError({
      status: 403,
      reason: 'forbidden',
      message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
    }),
    false
  );
  assert.equal(isRetryableThumbnailError({ status: 403, reason: 'insufficientPermissions', message: '' }), false);
  assert.equal(isRetryableThumbnailError({ status: 401, message: '' }), false);
  assert.equal(isRetryableThumbnailError({ status: 400, reason: 'invalidImage', message: '' }), false);
  assert.equal(isRetryableThumbnailError({ status: 400, reason: 'mediaBodyRequired', message: '' }), false);
});

test('the default waits are 30 s, 2 min and 5 min', () => {
  assert.deepEqual(THUMBNAIL_RETRY_DELAYS_MS, [30_000, 120_000, 300_000]);
});

const recorder = () => {
  const slept: number[] = [];
  const logs: string[] = [];
  return {
    slept,
    logs,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    log: (line: string) => {
      logs.push(line);
    },
  };
};

test('first try succeeds: no wait, success', async () => {
  const r = recorder();
  let calls = 0;
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      calls++;
    },
    sleep: r.sleep,
    log: r.log,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(r.slept, []);
});

test('video not ready yet: retries with the waits, then succeeds', async () => {
  const r = recorder();
  let calls = 0;
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      calls++;
      if (calls < 3) {
        throw gaxiosError(404, 'videoNotFound', 'Video not found');
      }
    },
    sleep: r.sleep,
    log: r.log,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(r.slept, [30_000, 120_000]);
  // every failure is logged, with the raw Google reason
  assert.equal(r.logs.filter((l) => /reason=videoNotFound/.test(l)).length, 2);
});

test('clear refusal: one try, no wait, the raw error is logged', async () => {
  const r = recorder();
  let calls = 0;
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      calls++;
      throw gaxiosError(
        403,
        'forbidden',
        "The authenticated user doesn't have permissions to upload and set custom video thumbnails."
      );
    },
    sleep: r.sleep,
    log: r.log,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(r.slept, []);
  assert.equal(result.last?.status, 403);
  assert.ok(r.logs.some((l) => /videoId=abc/.test(l) && /status=403/.test(l) && /doesn't have permissions/.test(l)));
  assert.ok(r.logs.every((l) => !/SECRET-ACCESS-TOKEN/.test(l)));
});

test('always failing: 4 tries, 3 waits, never throws', async () => {
  const r = recorder();
  let calls = 0;
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      calls++;
      throw gaxiosError(503, 'backendError', 'Backend Error');
    },
    sleep: r.sleep,
    log: r.log,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4);
  assert.equal(calls, 4);
  assert.deepEqual(r.slept, [30_000, 120_000, 300_000]);
  assert.ok(r.logs.some((l) => /gave up/.test(l)));
});

test('a failing diagnostic hook never breaks the retry', async () => {
  const r = recorder();
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      throw gaxiosError(400, 'invalidImage', 'bad image');
    },
    diagnose: async () => {
      throw new Error('videos.list failed');
    },
    sleep: r.sleep,
    log: r.log,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
});

test('never waits past the deadline of the activity', async () => {
  const r = recorder();
  let clock = 0;
  let calls = 0;
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      calls++;
      throw gaxiosError(404, 'videoNotFound', 'Video not found');
    },
    sleep: async (ms: number) => {
      r.slept.push(ms);
      clock += ms;
    },
    log: r.log,
    now: () => clock,
    // room for the 30 s and 2 min waits only (plus the margin of each try)
    deadline: 3 * 60_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(r.slept, [30_000, 120_000]);
  assert.equal(calls, 3);
  assert.ok(r.logs.some((l) => /deadline/.test(l)));
});

test('a deadline already too close: one try only', async () => {
  const r = recorder();
  const result = await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      throw gaxiosError(404, 'videoNotFound', 'Video not found');
    },
    sleep: r.sleep,
    log: r.log,
    now: () => 0,
    deadline: 10_000,
  });
  assert.equal(result.attempts, 1);
  assert.deepEqual(r.slept, []);
});

test('the diagnostic line is logged after a failure', async () => {
  const r = recorder();
  await setThumbnailWithRetry({
    videoId: 'abc',
    attempt: async () => {
      throw gaxiosError(400, 'invalidImage', 'bad image');
    },
    diagnose: async () => 'uploadStatus=uploaded',
    sleep: r.sleep,
    log: r.log,
  });
  assert.ok(r.logs.some((l) => /uploadStatus=uploaded/.test(l)));
});
