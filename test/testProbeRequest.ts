/*
 * Device detection of the template library (ioBroker.modbus): the adapter reads registers of many device types
 * over the connection of the running master. A device that does not answer such an address must not cost the
 * full timeout and must not close the connection (without `keepConnectionOnTimeout` every timeout does).
 * A request with `{ probe: true, timeout }` fails only itself.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};
const logger = { debug: noop, info: noop, silly: noop, warn: noop, error: noop, level: 'info' } as unknown as ioBroker.Logger;

/** Fake device: answers FC3 and FC4 with the address as values, but not for the addresses in `silent` */
function startDevice(silent: number[]): Promise<{ server: Server; port: number; connections: () => number }> {
    let connections = 0;
    return new Promise(resolve => {
        const server = createServer((socket: Socket) => {
            connections++;
            let buf = Buffer.alloc(0);
            socket.on('error', noop);
            socket.on('data', d => {
                buf = Buffer.concat([buf, d]);
                while (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
                    const frame = buf.subarray(0, 6 + buf.readUInt16BE(4));
                    buf = buf.subarray(frame.length);
                    const fc = frame.readUInt8(7);
                    const address = frame.readUInt16BE(8);
                    const quantity = frame.readUInt16BE(10);
                    if (silent.includes(address)) {
                        continue;
                    }
                    const pdu = Buffer.alloc(2 + quantity * 2);
                    pdu.writeUInt8(fc, 0);
                    pdu.writeUInt8(quantity * 2, 1);
                    for (let i = 0; i < quantity; i++) {
                        pdu.writeUInt16BE(address + i, 2 + i * 2);
                    }
                    const header = Buffer.alloc(7);
                    frame.copy(header, 0, 0, 4);
                    header.writeUInt16BE(pdu.length + 1, 4);
                    header.writeUInt8(frame.readUInt8(6), 6);
                    socket.write(Buffer.concat([header, pdu]));
                }
            });
        });
        server.listen(0, HOST, () =>
            resolve({ server, port: (server.address() as { port: number }).port, connections: () => connections }),
        );
    });
}

describe('probe requests (device detection)', function () {
    this.timeout(10000);

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

    it('an unanswered probe fails only itself, after its own timeout, and keeps the connection', async () => {
        const device = await startDevice([8016, 35011]);
        server = device.server;
        // the configured timeout is long and a timeout normally closes the connection
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: device.port }, logger, timeout: 5000 });
        client = tcp;
        tcp.on('error', noop);
        const events: string[] = [];
        tcp.on('close', () => events.push('close'));
        tcp.on('trashCurrentRequest', () => events.push('trashCurrentRequest'));
        tcp.on('requestTimeout', () => events.push('requestTimeout'));
        await new Promise<void>(resolve => {
            tcp.once('connect', () => resolve());
            tcp.connect();
        });

        const started = Date.now();
        await assert.rejects(
            tcp.readHoldingRegisters(1, 8016, 16, { probe: true, timeout: 200 }),
            (err: { timeout?: number }) => err.timeout === 200,
        );
        await assert.rejects(
            tcp.readInputRegisters(1, 35011, 5, { probe: true, timeout: 200 }),
            (err: { timeout?: number }) => err.timeout === 200,
        );
        assert.ok(Date.now() - started < 1500, `two probes must take about 400 ms, took ${Date.now() - started} ms`);

        // the next requests use the same connection
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 64514, 1, { probe: true, timeout: 200 })).register, [
            64514,
        ]);
        assert.deepStrictEqual((await tcp.readInputRegisters(1, 9000, 2)).register, [9000, 9001]);

        assert.deepStrictEqual(events, []);
        assert.strictEqual(device.connections(), 1);
    });
});
