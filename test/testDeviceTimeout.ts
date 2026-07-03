/*
 * Regression test for issue #605 — per-device request timeout.
 *
 * A master with `multiDeviceId` can define a dedicated timeout per Modbus device/unit ID.
 * This drives the real `ModbusClientTCP` transport against a TCP server that never answers,
 * and asserts that a request to a device with a short per-device timeout fails after that
 * short timeout — not after the (much longer) global timeout.
 *
 * Assertions use node:assert only (no chai). No js-controller / real device involved.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};
const logger = { debug: noop, info: noop, warn: noop, error: noop, silly: noop, level: 'info' } as unknown as ioBroker.Logger;

describe('ModbusClientTCP per-device timeout (issue #605)', function () {
    this.timeout(15000);

    it('uses the per-device timeout instead of the global one', async () => {
        // The server accepts the connection and consumes the request but never answers,
        // forcing a timeout. (The `data` listener also puts the socket into flowing mode.)
        const server: Server = createServer((socket: Socket) => {
            socket.on('data', noop);
            socket.on('error', noop);
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        const client = new ModbusClientTCP({
            tcp: { host: HOST, port, autoReconnect: false },
            unitId: 11,
            logger,
            timeout: 5000, // the global timeout would take 5 s
            deviceTimeouts: { 11: { timeout: 150 } }, // device 11 must time out after ~150 ms
        });
        client.on('error', noop);

        try {
            const firstConnect = new Promise<void>(resolve => client.once('connect', resolve));
            client.connect();
            await firstConnect;

            const start = Date.now();
            let rejected: Error | undefined;
            try {
                await client.readHoldingRegisters(11, 0, 1);
            } catch (e) {
                rejected = e as Error;
            }
            const elapsed = Date.now() - start;

            assert.ok(rejected, 'the request should time out');
            assert.match(rejected!.message, /timeout/, `unexpected error: ${rejected!.message}`);
            assert.ok(
                elapsed < 1500,
                `expected the per-device 150 ms timeout, but it took ${elapsed} ms (global is 5000 ms)`,
            );
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
