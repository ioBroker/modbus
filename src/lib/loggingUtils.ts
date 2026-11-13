/**
 * Utility functions for logging management
 */

/**
 * Create a logging wrapper that can filter connection error messages
 *
 * @param originalLog - The original logger object
 * @param disableLogging - Whether to disable connection error logging
 * @returns The wrapped logger or original logger
 */
export function createLoggingWrapper(originalLog: ioBroker.Logger, disableLogging?: boolean): ioBroker.Logger {
    if (!disableLogging) {
        return originalLog;
    }

    // Connection-related messages to suppress when logging is disabled. These are handled, expected conditions
    // logged at info level (kept quiet by default), so both the info and error wrappers filter them.
    const suppressedMessages = ['Socket Error', 'Client in error state', 'Request timed out'];

    const isSuppressed = (msg: string | Error): boolean =>
        typeof msg === 'string' && suppressedMessages.some(pattern => msg.includes(pattern));

    return {
        silly: originalLog.silly.bind(originalLog),
        level: originalLog.level,
        debug: originalLog.debug.bind(originalLog),
        info: (msg: string | Error, ...args: any[]): void => {
            if (isSuppressed(msg)) {
                return;
            }
            originalLog.info(msg.toString() + (args.length > 0 ? ` ${args.join(', ')}` : ''));
        },
        warn: originalLog.warn.bind(originalLog),
        error: (msg: string | Error, ...args: any[]): void => {
            if (isSuppressed(msg)) {
                return;
            }
            originalLog.error(msg.toString() + (args.length > 0 ? ` ${args.join(', ')}` : ''));
        },
    };
}
