/*
 * Unit test for issue #525 — "Disable Logging for the adapter".
 *
 * When a Modbus device goes offline (e.g. a solar inverter's WiFi stick shutting down at night),
 * the transport otherwise floods the log with `Socket Error` / `Client in error state.` /
 * `Request timed out.` on every reconnect attempt. The `disableLogging` option wraps the logger so
 * exactly those connection-noise errors are dropped, while every other message still gets through.
 *
 * This locks that behaviour down. Assertions use node:assert only (no chai).
 */
import assert from 'node:assert';
import { createLoggingWrapper } from '../src/lib/loggingUtils';

interface RecordedCalls {
    error: string[];
    warn: string[];
    info: string[];
    debug: string[];
    silly: string[];
}

function makeRecordingLogger(): { logger: ioBroker.Logger; calls: RecordedCalls } {
    const calls: RecordedCalls = { error: [], warn: [], info: [], debug: [], silly: [] };
    const logger = {
        level: 'info',
        error: (m: string): void => {
            calls.error.push(m);
        },
        warn: (m: string): void => {
            calls.warn.push(m);
        },
        info: (m: string): void => {
            calls.info.push(m);
        },
        debug: (m: string): void => {
            calls.debug.push(m);
        },
        silly: (m: string): void => {
            calls.silly.push(m);
        },
    } as unknown as ioBroker.Logger;
    return { logger, calls };
}

describe('createLoggingWrapper — disableLogging (issue #525)', function () {
    it('returns the original logger untouched when disableLogging is off', () => {
        const { logger } = makeRecordingLogger();
        assert.strictEqual(createLoggingWrapper(logger), logger, 'undefined must be a no-op');
        assert.strictEqual(createLoggingWrapper(logger, false), logger, 'false must be a no-op');
    });

    it('suppresses exactly the noisy connection errors when enabled', () => {
        const { logger, calls } = makeRecordingLogger();
        const wrapped = createLoggingWrapper(logger, true);
        wrapped.error('Socket Error ECONNREFUSED 192.168.1.50:502');
        wrapped.error('Client in error state.');
        wrapped.error('Request timed out.');
        assert.deepStrictEqual(calls.error, [], 'the reported night-time flood must be dropped');
    });

    it('matches the SSL/TLS and RTU variants via substring', () => {
        const { logger, calls } = makeRecordingLogger();
        const wrapped = createLoggingWrapper(logger, true);
        wrapped.error('SSL/TLS Socket Error boom');
        wrapped.error('SSL/TLS Client in error state.');
        assert.deepStrictEqual(calls.error, [], 'prefixed transport variants must also be dropped');
    });

    it('lets unrelated error messages through', () => {
        const { logger, calls } = makeRecordingLogger();
        const wrapped = createLoggingWrapper(logger, true);
        wrapped.error('Can not set state modbus.0.x: permission denied');
        assert.deepStrictEqual(calls.error, ['Can not set state modbus.0.x: permission denied']);
    });

    it('appends extra args to passed-through error messages', () => {
        const { logger, calls } = makeRecordingLogger();
        const wrapped = createLoggingWrapper(logger, true);
        (wrapped.error as (msg: string, ...args: unknown[]) => void)('boom', 'a', 'b');
        assert.deepStrictEqual(calls.error, ['boom a, b']);
    });

    it('never suppresses warn/info/debug — only error is filtered', () => {
        const { logger, calls } = makeRecordingLogger();
        const wrapped = createLoggingWrapper(logger, true);
        wrapped.warn('Socket Error as a warning stays visible');
        wrapped.info('Client in error state. as info stays visible');
        wrapped.debug('Request timed out. as debug stays visible');
        assert.deepStrictEqual(calls.warn, ['Socket Error as a warning stays visible']);
        assert.deepStrictEqual(calls.info, ['Client in error state. as info stays visible']);
        assert.deepStrictEqual(calls.debug, ['Request timed out. as debug stays visible']);
    });

    it('preserves the log level property', () => {
        const { logger } = makeRecordingLogger();
        assert.strictEqual(createLoggingWrapper(logger, true).level, 'info');
    });
});
