/**
 * Tests for resolveOAuthTokenRateLimit() in src/commands/serve-http.ts.
 *
 * The /token client_credentials limiter defaults to the busy-host profile
 * while still letting operators tune it without patching source.
 */

import { describe, test, expect } from 'bun:test';
import { resolveOAuthTokenRateLimit } from '../src/commands/serve-http.ts';

describe('resolveOAuthTokenRateLimit', () => {
  test('unset env uses the busy-host 200 requests per minute default', () => {
    expect(resolveOAuthTokenRateLimit({})).toEqual({
      windowMs: 60_000,
      max: 200,
    });
  });

  test('env overrides allow a busy host to use 200 requests per minute', () => {
    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '60000',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: '200',
    })).toEqual({
      windowMs: 60_000,
      max: 200,
    });
  });

  test('blank, non-numeric, zero, and negative values fall back safely', () => {
    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: 'nope',
    })).toEqual({
      windowMs: 60_000,
      max: 200,
    });

    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '0',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: '-10',
    })).toEqual({
      windowMs: 60_000,
      max: 200,
    });
  });
});
