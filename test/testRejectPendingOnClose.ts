/*
 * When the connection drops while requests are in flight (or queued), their promises must be rejected
 * promptly with "connection closed" instead of staying open until each request's own timeout fires. A
 * block-read retry relies on this to react immediately, and a caller that awaits a read/write should not
 * hang for the full timeout after the socket is gone.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};
const logger = { debug: noop, info: noop, silly: noop, warn: noop, error: noop, level: 'info' } as unknown as ioBroker.Logger;

function connected(client: ModbusClientTCP): Promise<void> {
    return new Promise(resolve => {
        client.once('connect', resolve);
        client.connect();
    });
}

describe('reject pending requests when the connection closes', function () {
    this.timeout(10_000);

    let server: Server | undefined;
    let client: ModbusClientTCP | undefined;

    afterEach(done => {
        client?.close();
        client = undefined;
        if (server) {
            server.close(() => done());
            server = undefined;
        } else {
            done();
        }
    });

    it('rejects the pending request with "connection closed" instead of leaving it open', async () => {
        // A server that accepts one connection and never answers, so a fired request stays in flight.
        let socket: Socket | undefined;
        const srv = createServer((s: Socket) => {
            socket = s;
            s.on('error', noop);
        });
        server = srv;
        await new Promise<void>(resolve => srv.listen(0, HOST, resolve));
        const port = (srv.address() as { port: number }).port;

        client = new ModbusClientTCP({ tcp: { host: HOST, port }, logger, timeout: 5_000 });
        client.on('error', noop);
        await connected(client);

        // Fire a request that will never be answered.
        const started = Date.now();
        let rejectedWith: string | undefined;
        const pending = client.readHoldingRegisters(1, 0, 2).then(
            () => {
                throw new Error('expected the pending request to be rejected');
            },
            err => {
                rejectedWith = (err as Error).message;
            },
        );

        // Give the request time to go out, then drop the connection while it is still in flight.
        await new Promise(resolve => setTimeout(resolve, 50));
        socket?.destroy();

        await pending;
        assert.ok(rejectedWith, 'expected the pending request to be rejected');
        assert.match(rejectedWith!, /connection closed/);
        // It must be rejected by the close, not left open until the (5 s) timeout fires.
        assert.ok(Date.now() - started < 2_000, `must reject promptly on close, took ${Date.now() - started} ms`);
    });
});
