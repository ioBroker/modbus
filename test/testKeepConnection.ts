/*
 * ioBroker.modbus issue #832: a gateway (SolarEdge SE3680, unit 1) with a second inverter behind it
 * (unit 3). Unit 3 does not answer for a minute twice a day, and every timeout closed the whole TCP
 * connection - also for unit 1, which answered fine. With `keepConnectionOnTimeout` a timeout fails
 * only its request, a late answer is dropped by its transaction ID, and the connection stays open.
 *
 * ioBroker.modbus issue #831: an exception in a response handler left the request without an
 * answer, so the poll waited forever and the master stopped polling.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';
import type { TrashedRequestInfo } from '../src/lib/modbus/modbus-client-core';
import { Master } from '../src/lib/Master';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};
const logger = { debug: noop, info: noop, silly: noop, warn: noop, error: noop, level: 'info' } as unknown as ioBroker.Logger;

function fc3Pdu(registers: number[]): Buffer {
    const pdu = Buffer.alloc(2 + registers.length * 2);
    pdu.writeUInt8(3, 0);
    pdu.writeUInt8(registers.length * 2, 1);
    registers.forEach((r, i) => pdu.writeUInt16BE(r, 2 + i * 2));
    return pdu;
}

function mbap(transactionId: number, unitId: number, pdu: Buffer): Buffer {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transactionId, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

/**
 * Fake gateway: unit 1 answers at once with the address as register values, the units in `silent`
 * do not answer - or, with `lateMs`, only after that time (a late answer to a timed out request).
 */
function startGateway(options: {
    silent: number[];
    lateMs?: number;
    /** the other units answer after this time */
    answerMs?: number;
}): Promise<{ server: Server; port: number; connections: () => number }> {
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
                    const transactionId = frame.readUInt16BE(0);
                    const unitId = frame.readUInt8(6);
                    const address = frame.readUInt16BE(8);
                    const quantity = frame.readUInt16BE(10);
                    // a unit that is silent answers with registers 0xEEEE, so a late answer taken for
                    // another request would be visible
                    const silent = options.silent.includes(unitId);
                    const values = Array.from({ length: quantity }, (_, i) => (silent ? 0xeeee : address + i));
                    const answer = mbap(transactionId, unitId, fc3Pdu(values));
                    if (!silent) {
                        if (options.answerMs) {
                            setTimeout(() => !socket.destroyed && socket.write(answer), options.answerMs);
                        } else {
                            socket.write(answer);
                        }
                    } else if (options.lateMs) {
                        setTimeout(() => !socket.destroyed && socket.write(answer), options.lateMs);
                    }
                }
            });
        });
        server.listen(0, HOST, () =>
            resolve({ server, port: (server.address() as { port: number }).port, connections: () => connections }),
        );
    });
}

function connected(client: ModbusClientTCP): Promise<void> {
    return new Promise(resolve => {
        client.once('connect', resolve);
        client.connect();
    });
}

describe('keepConnectionOnTimeout (issue #832)', function () {
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

    it('keeps the connection when one unit behind a gateway does not answer', async () => {
        const gateway = await startGateway({ silent: [3] });
        server = gateway.server;
        const tcp = new ModbusClientTCP({
            tcp: { host: HOST, port: gateway.port },
            logger,
            timeout: 300,
            keepConnectionOnTimeout: true,
        });
        client = tcp;
        tcp.on('error', noop);
        let closed = 0;
        tcp.on('close', () => closed++);
        const timeouts: TrashedRequestInfo[] = [];
        tcp.on('requestTimeout', (info: TrashedRequestInfo) => timeouts.push(info));
        let trashed = 0;
        tcp.on('trashCurrentRequest', () => trashed++);
        await connected(tcp);

        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 83, 2)).register, [83, 84]);
        await assert.rejects(tcp.readHoldingRegisters(3, 83, 2), (err: { timeout?: number }) => err.timeout === 300);
        // the same connection still serves unit 1
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 100, 3)).register, [100, 101, 102]);
        await assert.rejects(tcp.readHoldingRegisters(3, 83, 2));

        assert.strictEqual(closed, 0, 'the connection must stay open');
        assert.strictEqual(trashed, 0, 'no reconnect must be requested');
        assert.strictEqual(gateway.connections(), 1);
        // unit 1 answered in between: only unit 3 is silent
        assert.deepStrictEqual(
            timeouts.map(t => t.silentUnits),
            [[3], [3]],
        );
    });

    it('drops the late answer of the timed out unit instead of taking it for the next request', async () => {
        // unit 3 times out after 300 ms and answers after 450 ms - while the request of unit 1, sent at
        // 300 ms, waits for its own answer (at 550 ms)
        const gateway = await startGateway({ silent: [3], lateMs: 450, answerMs: 250 });
        server = gateway.server;
        const dropped: string[] = [];
        const tcp = new ModbusClientTCP({
            tcp: { host: HOST, port: gateway.port },
            logger: { ...logger, warn: (msg: string) => dropped.push(msg) } as unknown as ioBroker.Logger,
            timeout: 300,
            keepConnectionOnTimeout: true,
        });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        await assert.rejects(tcp.readHoldingRegisters(3, 83, 2));
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 200, 2)).register, [200, 201]);
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 300, 1)).register, [300]);
        assert.ok(
            dropped.some(w => /Dropped a response with transaction ID/.test(w)),
            `the late answer must be dropped, got ${JSON.stringify(dropped)}`,
        );
    });

    it('reports every unit as silent, when no unit answers anymore', async () => {
        const gateway = await startGateway({ silent: [1, 3] });
        server = gateway.server;
        const tcp = new ModbusClientTCP({
            tcp: { host: HOST, port: gateway.port },
            logger,
            timeout: 200,
            keepConnectionOnTimeout: true,
        });
        client = tcp;
        tcp.on('error', noop);
        const timeouts: TrashedRequestInfo[] = [];
        tcp.on('requestTimeout', (info: TrashedRequestInfo) => timeouts.push(info));
        await connected(tcp);

        await assert.rejects(tcp.readHoldingRegisters(1, 1, 1));
        await assert.rejects(tcp.readHoldingRegisters(3, 1, 1));
        assert.deepStrictEqual(timeouts.at(-1)?.silentUnits?.sort(), [1, 3]);
    });

    it('still closes the connection on a timeout without the option', async () => {
        const gateway = await startGateway({ silent: [3] });
        server = gateway.server;
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: gateway.port }, logger, timeout: 200 });
        client = tcp;
        tcp.on('error', noop);
        let trashed = 0;
        tcp.on('trashCurrentRequest', () => trashed++);
        const closed = new Promise<void>(resolve => tcp.once('close', () => resolve()));
        await connected(tcp);

        await assert.rejects(tcp.readHoldingRegisters(3, 83, 2));
        await closed;
        assert.strictEqual(trashed, 1);
    });
});

/** Adapter stand-in, like in testPollingReconnect.ts */
function makeFakeAdapter(warnings: string[]): ioBroker.Adapter {
    return {
        namespace: 'modbus.0',
        common: { loglevel: 'info' },
        log: { level: 'info', debug: noop, silly: noop, info: noop, warn: (m: string) => warnings.push(m), error: noop },
        setTimeout: (cb: (...args: unknown[]) => void, ms: number, ...args: unknown[]): NodeJS.Timeout =>
            setTimeout(cb, ms, ...args),
        clearTimeout: (timer: NodeJS.Timeout): void => clearTimeout(timer),
        setState: noop,
        getStatesAsync: (): Promise<Record<string, ioBroker.State>> => Promise.resolve({}),
        delForeignObjectAsync: (): Promise<void> => Promise.resolve(),
        getStateAsync: (): Promise<ioBroker.State | null> => Promise.resolve(null),
        terminate: noop,
    } as unknown as ioBroker.Adapter;
}

/** One holding register block (FC3, 1 register) per device */
function makeDevice(deviceId: number): unknown {
    const empty = { deviceId, blocks: [], config: [] };
    const id = `holdingRegisters.${deviceId}.83`;
    return {
        disInputs: empty,
        coils: empty,
        inputRegs: empty,
        holdingRegs: {
            deviceId,
            blocks: [{ start: 83, count: 1, startIndex: 0, endIndex: 1 }],
            config: [
                {
                    deviceId,
                    address: 83,
                    _address: 83,
                    len: 1,
                    type: 'uint16be',
                    id,
                    fullId: `modbus.0.${id}`,
                    factor: 1,
                    offset: 0,
                    poll: true,
                    formula: '',
                },
            ],
            cyclicWrite: [],
        },
    };
}

function makeOptions(port: number, deviceIds: number[], keepConnectionOnTimeout: boolean): Options {
    return {
        config: {
            type: 'tcp',
            tcp: { ip: HOST, port },
            timeout: 150,
            defaultDeviceId: deviceIds[0],
            multiDeviceId: deviceIds.length > 1,
            disableLogging: true,
            poll: 100,
            readInterval: 0,
            waitTime: 0,
            writeInterval: 0,
            round: 1,
            maxBlock: 100,
            maxBoolBlock: 128,
            recon: 50,
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
            keepConnectionOnTimeout,
        },
        devices: Object.fromEntries(deviceIds.map(id => [id, makeDevice(id)])),
        objects: {},
    } as unknown as Options;
}

describe('Master with keepConnectionOnTimeout (issue #832)', function () {
    this.timeout(10000);

    let server: Server | undefined;
    let master: Master | undefined;

    afterEach(done => {
        master?.close();
        master = undefined;
        if (server) {
            server.close(() => done());
            server = undefined;
        } else {
            done();
        }
    });

    it('polls the answering unit on the same connection while another unit is silent', async () => {
        const gateway = await startGateway({ silent: [3] });
        server = gateway.server;
        const warnings: string[] = [];
        master = new Master(makeOptions(gateway.port, [1, 3], true), makeFakeAdapter(warnings));
        master.start();

        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.strictEqual(gateway.connections(), 1, `no reconnect expected, log: ${JSON.stringify(warnings)}`);
        assert.ok(!warnings.some(w => /reconnecting/.test(w)));
        assert.ok(warnings.filter(w => /\[DevID_3\/holdingRegs\]/.test(w)).length >= 2, 'unit 3 is polled again');
    });

    it('reconnects when no unit answers anymore', async () => {
        const gateway = await startGateway({ silent: [1, 3] });
        server = gateway.server;
        const warnings: string[] = [];
        master = new Master(makeOptions(gateway.port, [1, 3], true), makeFakeAdapter(warnings));
        master.start();

        const deadline = Date.now() + 4000;
        while (gateway.connections() < 2 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(gateway.connections() >= 2, 'expected a reconnect');
        assert.ok(warnings.some(w => /No device answers anymore, reconnecting/.test(w)));
    });
});

describe('error in a response handler (issue #831)', function () {
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

    it('rejects the request instead of leaving it pending, and the next request works', async () => {
        const gateway = await startGateway({ silent: [] });
        server = gateway.server;
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: gateway.port }, logger, timeout: 2000 });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        // a handler that fails while decoding, like `The value of "offset" is out of range` in the issue
        const handlers = (tcp as unknown as { responseHandler: Record<number, (...args: unknown[]) => void> })
            .responseHandler;
        const original = handlers[3];
        handlers[3] = () => {
            throw new RangeError('The value of "offset" is out of range. It must be >= 0 and <= 3. Received 4');
        };
        const started = Date.now();
        await assert.rejects(tcp.readHoldingRegisters(1, 40004, 2), /invalid response: The value of "offset"/);
        assert.ok(Date.now() - started < 1000, 'must not wait for the timeout');

        handlers[3] = original;
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 10, 2)).register, [10, 11]);
    });
});
