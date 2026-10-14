// Studio Caillou: setting the custom thumbnail of a YouTube video, with the raw
// Google error kept and a few retries.
//
// Why: the official provider turns any thumbnails.set failure whose body holds
// `youtube.thumbnail` into "Your account is not verified", throws a BadBody and
// the post ends in ERROR without releaseURL, while the video is already live
// (a repost then duplicates it). The raw Google answer was lost.
//
// No imports on purpose: this module is tested with the Node test runner
// (youtube.thumbnail.spec.ts) without the monorepo dependencies.

export interface ThumbnailErrorInfo {
  status?: number;
  reason?: string;
  domain?: string;
  message: string;
}

// 30 s, 2 min, 5 min: covers a video that YouTube is still processing right
// after the last byte of the upload.
export const THUMBNAIL_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

// Time kept free after a wait for the try itself (download the image, send it).
export const THUMBNAIL_TRY_MARGIN_MS = 30_000;

const MAX_MESSAGE = 500;

const clip = (value: unknown): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_MESSAGE
    ? `${oneLine.slice(0, MAX_MESSAGE)}...`
    : oneLine;
};

const asStatus = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 600
    ? n
    : undefined;
};

// Reads only the fields we need from a GaxiosError (or any thrown value).
// Never touches err.config / err.response.config / headers: they carry the
// bearer token.
export const describeThumbnailError = (err: any): ThumbnailErrorInfo => {
  const data = err?.response?.data;
  const googleError = data && typeof data === 'object' ? data.error : undefined;
  const first =
    googleError && Array.isArray(googleError.errors)
      ? googleError.errors[0]
      : Array.isArray(err?.errors)
      ? err.errors[0]
      : undefined;

  const status =
    asStatus(err?.response?.status) ??
    asStatus(err?.status) ??
    asStatus(googleError?.code) ??
    asStatus(err?.code);

  const networkCode =
    status === undefined && typeof err?.code === 'string' ? err.code : undefined;

  const message = clip(
    first?.message ||
      (typeof googleError === 'object' ? googleError?.message : googleError) ||
      (typeof data === 'string' ? data : '') ||
      err?.message ||
      err
  );

  return {
    status,
    reason: first?.reason || networkCode || undefined,
    domain: first?.domain || undefined,
    message,
  };
};

export const formatThumbnailError = (info: ThumbnailErrorInfo): string =>
  [
    `status=${info.status ?? 'none'}`,
    `reason=${info.reason ?? 'none'}`,
    `domain=${info.domain ?? 'none'}`,
    `message=${JSON.stringify(info.message)}`,
  ].join(' ');

// Retry only what can pass later. A clear refusal (no permission, bad image,
// bad token) is final: retrying it only burns quota.
export const isRetryableThumbnailError = (info: ThumbnailErrorInfo): boolean => {
  const { status } = info;
  if (status === undefined) {
    return true; // network error, no answer from Google
  }
  if (status === 404 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  if (status === 403) {
    if (info.reason && info.reason !== 'forbidden') {
      return false; // insufficientPermissions and the like
    }
    // "The thumbnail can't be set for the specified video": may be a video
    // still processing. "doesn't have permissions": a clear refusal.
    return /can't be set for the specified video|cannot be set for the specified video/i.test(
      info.message
    );
  }
  return false;
};

export interface ThumbnailResult {
  ok: boolean;
  attempts: number;
  last?: ThumbnailErrorInfo;
}

export const setThumbnailWithRetry = async (options: {
  videoId: string;
  attempt: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  diagnose?: () => Promise<string>;
  delays?: number[];
  // epoch ms after which the activity would time out: no wait goes past it
  deadline?: number;
  now?: () => number;
}): Promise<ThumbnailResult> => {
  const delays = options.delays ?? THUMBNAIL_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const tag = `[caillou] youtube thumbnail videoId=${options.videoId}`;
  let last: ThumbnailErrorInfo | undefined;

  for (let i = 0; i <= delays.length; i++) {
    const attempts = i + 1;
    try {
      await options.attempt();
      options.log(`${tag} set on attempt ${attempts}`);
      return { ok: true, attempts, last };
    } catch (err) {
      last = describeThumbnailError(err);
      let state = '';
      if (options.diagnose) {
        try {
          state = ` ${await options.diagnose()}`;
        } catch (diagErr) {
          state = ' video-state=unreadable';
        }
      }
      const retryable = isRetryableThumbnailError(last) && i < delays.length;
      const inTime =
        !retryable ||
        options.deadline === undefined ||
        now() + delays[i] + THUMBNAIL_TRY_MARGIN_MS <= options.deadline;
      const retry = retryable && inTime;
      options.log(
        `${tag} attempt ${attempts} failed: ${formatThumbnailError(last)}${state}${
          retry ? ` - retry in ${Math.round(delays[i] / 1000)}s` : ''
        }${retryable && !inTime ? ' - no retry, the activity deadline is too close' : ''}`
      );
      if (!retry) {
        options.log(
          `${tag} gave up after ${attempts} attempt(s), the video is published without the custom thumbnail`
        );
        return { ok: false, attempts, last };
      }
      await options.sleep(delays[i]);
    }
  }

  // not reached: the loop always returns
  return { ok: false, attempts: delays.length + 1, last };
};
