/*
 * Tests for configurable read/write retries (see Plan.md).
 *
 * When a register-block read fails with a timeout / connection loss, the master re-attempts it up to
 * `readRetryCount` times; when a write fails the same way it is re-sent up to `writeRetryCount` times.
 * Each attempt is logged as `[retry/k/N]...`, re-establishes the connection and re-sends the same request
 * spaced by ~one polling interval. Once all attempts fail, a final error is raised for that operation.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { Master } from '../src/lib/Master';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const NS = 'modbus.0';

interface RequestInfo {
    connection: number;
    unitId: number;
    address: number;
    count: number;
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function makeFakeAdapter(capture?: { warns: string[]; infos: string[]; states: Array<{ id: string; val: unknown }> }) {
    const noop = (): void => {
        /* silent */
    };
    const fake = {
        namespace: NS,
        common: { loglevel: 'debug' },
        log: {
            level: 'debug',
            debug: noop,
            silly: noop,
            info: (msg: string): void => {
                capture?.infos.push(msg);
            },
            warn: (msg: string): void => {
                capture?.warns.push(msg);
            },
            error: noop,
        },
        setTimeout: (cb: (...args: unknown[]) => void, ms: number, ...args: unknown[]): NodeJS.Timeout =>
            setTimeout(cb, ms, ...args),
        clearTimeout: (timer: NodeJS.Timeout): void => clearTimeout(timer),
        setState(id: string, val: unknown, _ack: unknown, cb?: unknown): void {
            capture?.states.push({ id, val });
            if (typeof cb === 'function') {
                (cb as (err: Error | null) => void)(null);
            }
        },
        getStatesAsync: (): Promise<Record<string, ioBroker.State>> => Promise.resolve({}),
        delForeignObjectAsync: (): Promise<void> => Promise.resolve(),
        getStateAsync: (): Promise<ioBroker.State | null> => Promise.resolve(null),
        terminate: noop,
    };
    return fake as unknown as ioBroker.Adapter;
}

function makeReg(deviceId: number, address: number): unknown {
    const id = `inputRegisters.${deviceId}.${address}`;
    return {
        deviceId,
        address,
        _address: address,
        len: 2,
        type: 'floatbe',
        id,
        fullId: `${NS}.${id}`,
        factor: 1,
        offset: 0,
        poll: true,
        isScale: false,
        formula: '',
        cw: false,
        sanitize: false,
    };
}

function makeDevice(deviceId: number, addresses: number[]): unknown {
    const empty = { deviceId, blocks: [], config: [] };
    return {
        disInputs: empty,
        coils: empty,
        inputRegs: {
            deviceId,
            blocks: addresses.map((address, index) => ({
                start: address,
                count: 2,
                startIndex: index,
                endIndex: index + 1,
            })),
            config: addresses.map(address => makeReg(deviceId, address)),
        },
        holdingRegs: { deviceId, blocks: [], config: [], cyclicWrite: [] },
    };
}

function makeOptions(port: number, readRetryCount = 0, writeRetryCount = 0): Options {
    return {
        config: {
            type: 'tcp',
            tcp: { ip: HOST, port },
            timeout: 100,
            defaultDeviceId: 1,
            multiDeviceId: true,
            disableLogging: true,
            poll: 60_000, // only one polling cycle should run during the test
            readInterval: 20,
            waitTime: 30,
            writeInterval: 0,
            round: 1,
            maxBlock: 2,
            maxBoolBlock: 2,
            recon: 60_000, // after giving up on a cycle, do not immediately start another one
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
            readRetryCount,
            writeRetryCount,
        },
        devices: {
            1: makeDevice(1, [72]),
        },
        objects: {},
    } as unknown as Options;
}

function buildFc4Response(transactionId: number, unitId: number, count: number): Buffer {
    const data = Buffer.alloc(count * 2); // zeros -> decodes to a float of 0.0
    const pdu = Buffer.concat([Buffer.from([0x04, data.length]), data]);
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transactionId, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

function buildFc5Response(transactionId: number, unitId: number, address: number, value: boolean): Buffer {
    // FC05 (write single coil) echoes the request PDU back.
    const pdu = Buffer.from([0x05, address >> 8, address & 0xff, value ? 0xff : 0x00, 0x00]);
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transactionId, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

/** Options for a master with one writable coil (no polled blocks) at `coils.1.5`. */
function makeWriteTestOptions(port: number, writeRetryCount: number): Options {
    const options = makeOptions(port, 0, writeRetryCount);
    options.config.poll = 200; // keep the ack wait inside master.write() short
    (options as unknown as { devices: Record<number, unknown> }).devices[1] = makeDevice(1, []);
    (options as unknown as { objects: Record<string, unknown> }).objects['modbus.0.coils.1.5'] = {
        native: { regType: 'coils', deviceId: 1, address: 5 },
    };
    return options;
}

describe('Master block-read retries', function () {
    this.timeout(30_000);

    let server: Server;
    let master: Master;

    afterEach(async () => {
        master?.close();
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('logs each retry and gives up after exhausting all attempts', async () => {
        const capture = { warns: [] as string[], infos: [] as string[], states: [] as Array<{ id: string; val: unknown }> };
        const requests: RequestInfo[] = [];
        let connectionCount = 0;

        // A device that never answers -> every attempt (initial + retries) times out.
        server = createServer((socket: Socket) => {
            const connection = ++connectionCount;
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                while (data.length >= 12) {
                    const transactionId = data.readUInt16BE(0);
                    const unitId = data.readUInt8(6);
                    const address = data.readUInt16BE(8);
                    const count = data.readUInt16BE(10);
                    requests.push({ connection, unitId, address, count });
                    // Deliberately never respond.
                    break;
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeOptions(port, 3), makeFakeAdapter(capture));
        master.start();

        // Wait until all three retry attempts have been logged AND the final re-send has reached the
        // server (retry logs are emitted before each reconnect + re-send, so wait for the requests too).
        const deadline = Date.now() + 20_000;
        while (
            (capture.infos.filter(w => w.includes('[retry/')).length < 3 ||
                requests.filter(r => r.address === 72).length < 4) &&
            Date.now() < deadline
        ) {
            await wait(25);
        }
        await wait(100);

        const retryLogs = capture.infos.filter(w => /^\[retry\/\d+\/3\]/.test(w));
        assert.ok(retryLogs.some(w => w.includes('[retry/1/3]')), 'expected a [retry/1/3] log');
        assert.ok(retryLogs.some(w => w.includes('[retry/2/3]')), 'expected a [retry/2/3] log');
        assert.ok(retryLogs.some(w => w.includes('[retry/3/3]')), 'expected a [retry/3/3] log');
        // Each retry line carries the device/register-type and block range.
        for (const n of [1, 2, 3]) {
            const line = capture.infos.find(w => w.includes(`[retry/${n}/3]`));
            assert.ok(line, `missing retry log ${n}`);
            assert.ok(line!.includes('[DevID_1/inputRegs]'), 'retry log should name the device/register type');
            assert.ok(line!.includes('Block 72-73'), 'retry log should name the block range');
        }

        // The failed request must have been re-sent: initial + 3 retries = at least 4 requests.
        const addrRequests = requests.filter(r => r.address === 72);
        assert.ok(
            addrRequests.length >= 4,
            `expected >=4 attempts for address 72, got ${JSON.stringify(requests)}`,
        );
    });

    it('recovers and stores the value when a retry succeeds', async () => {
        const capture = { warns: [] as string[], infos: [] as string[], states: [] as Array<{ id: string; val: unknown }> };
        const requests: RequestInfo[] = [];
        let connectionCount = 0;
        let addr72Requests = 0;

        // Drop the first two requests for address 72, answer the third -> recovery on retry/2.
        server = createServer((socket: Socket) => {
            const connection = ++connectionCount;
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                while (data.length >= 12) {
                    const transactionId = data.readUInt16BE(0);
                    const unitId = data.readUInt8(6);
                    const address = data.readUInt16BE(8);
                    const count = data.readUInt16BE(10);
                    requests.push({ connection, unitId, address, count });
                    if (address === 72) {
                        addr72Requests += 1;
                        if (addr72Requests >= 3) {
                            socket.write(buildFc4Response(transactionId, unitId, count));
                        }
                    }
                    break;
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeOptions(port, 3), makeFakeAdapter(capture));
        master.start();

        // Wait until the recovered value is stored (setState uses the short id).
        const deadline = Date.now() + 20_000;
        while (!capture.states.some(s => s.id === 'inputRegisters.1.72') && Date.now() < deadline) {
            await wait(25);
        }
        await wait(100);

        const regState = capture.states.find(s => s.id === 'inputRegisters.1.72');
        assert.ok(
            regState,
            `expected the recovered value to be stored, states=${JSON.stringify(capture.states)} requests=${JSON.stringify(requests)}`,
        );
        // Two retries were needed before the successful one; the third retry must NOT have been logged.
        assert.ok(capture.infos.some(w => w.includes('[retry/1/3]')), 'expected a [retry/1/3] log');
        assert.ok(capture.infos.some(w => w.includes('[retry/2/3]')), 'expected a [retry/2/3] log');
        assert.ok(!capture.infos.some(w => w.includes('[retry/3/3]')), 'no [retry/3/3] expected on recovery');
    });

    it('recovers via cheap resend without reconnecting when the device is merely slow', async () => {
        const capture = { warns: [] as string[], infos: [] as string[], states: [] as Array<{ id: string; val: unknown }> };
        const requests: RequestInfo[] = [];
        let connectionCount = 0;
        let addr72Requests = 0;

        // A device that is slow but alive: it keeps the socket open, drops the first request for address 72,
        // then answers the second. The retry must resend on the SAME TCP connection (cheap resend) rather than
        // tearing it down and reconnecting - so every request arrives over a single connection.
        server = createServer((socket: Socket) => {
            const connection = ++connectionCount;
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                while (data.length >= 12) {
                    const transactionId = data.readUInt16BE(0);
                    const unitId = data.readUInt8(6);
                    const address = data.readUInt16BE(8);
                    const count = data.readUInt16BE(10);
                    requests.push({ connection, unitId, address, count });
                    if (address === 72) {
                        addr72Requests += 1;
                        if (addr72Requests >= 2) {
                            socket.write(buildFc4Response(transactionId, unitId, count));
                        }
                    }
                    break;
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeOptions(port, 3), makeFakeAdapter(capture));
        master.start();

        // Wait until the recovered value is stored.
        const deadline = Date.now() + 20_000;
        while (!capture.states.some(s => s.id === 'inputRegisters.1.72') && Date.now() < deadline) {
            await wait(25);
        }
        await wait(100);

        const regState = capture.states.find(s => s.id === 'inputRegisters.1.72');
        assert.ok(
            regState,
            `expected the recovered value to be stored, states=${JSON.stringify(capture.states)} requests=${JSON.stringify(requests)}`,
        );
        // One retry was needed before the successful one; no further retries were logged.
        assert.ok(capture.infos.some(w => w.includes('[retry/1/3]')), 'expected a [retry/1/3] log');
        assert.ok(!capture.infos.some(w => w.includes('[retry/2/3]')), 'no [retry/2/3] expected on recovery');

        // Cheap resend: every attempt for address 72 went over a single TCP connection (no reconnect).
        const addrRequests = requests.filter(r => r.address === 72);
        assert.ok(addrRequests.length >= 2, `expected >=2 attempts for address 72, got ${JSON.stringify(requests)}`);
        const connections = new Set(addrRequests.map(r => r.connection));
        assert.strictEqual(
            connections.size,
            1,
            `expected all retries on one connection, got ${JSON.stringify([...connections])}`,
        );
    });

    it('re-sends a failed write and gives up after exhausting all attempts', async () => {
        const capture = { warns: [] as string[], infos: [] as string[], states: [] as Array<{ id: string; val: unknown }> };
        const requests: RequestInfo[] = [];

        // A device that never answers the FC05 write -> every attempt (initial + retries) times out.
        server = createServer((socket: Socket) => {
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                while (data.length >= 12) {
                    const transactionId = data.readUInt16BE(0);
                    const unitId = data.readUInt8(6);
                    const fc = data.readUInt8(7);
                    if (fc !== 0x05) {
                        break; // not a write - ignore
                    }
                    const address = data.readUInt16BE(8);
                    requests.push({ connection: transactionId, unitId, address, count: 0 });
                    // Deliberately never respond.
                    break;
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeWriteTestOptions(port, 2), makeFakeAdapter(capture));
        master.start();
        void master.write('modbus.0.coils.1.5', { val: true } as ioBroker.State);

        // Wait until all two retry attempts have been logged AND the final re-send has reached the server.
        const deadline = Date.now() + 20_000;
        while (
            (capture.infos.filter(w => w.includes('[retry/')).length < 2 || requests.length < 3) &&
            Date.now() < deadline
        ) {
            await wait(25);
        }
        await wait(100);

        const retryLogs = capture.infos.filter(w => /^\[retry\/\d+\/2\]/.test(w));
        assert.ok(retryLogs.some(w => w.includes('[retry/1/2]')), 'expected a [retry/1/2] log');
        assert.ok(retryLogs.some(w => w.includes('[retry/2/2]')), 'expected a [retry/2/2] log');
        // Each retry line names the target of the failed write.
        for (const n of [1, 2]) {
            const line = capture.infos.find(w => w.includes(`[retry/${n}/2]`));
            assert.ok(line, `missing retry log ${n}`);
            assert.ok(line!.includes('coils address 5'), 'retry log should name the coil target');
        }

        // The failed write must have been re-sent: initial + 2 retries = at least 3 requests.
        assert.ok(requests.length >= 3, `expected >=3 attempts for the coil write, got ${JSON.stringify(requests)}`);

        // Giving up logs a final warning naming the target.
        assert.ok(
            capture.warns.some(w => w.startsWith('Cannot write value') && w.includes('coils address 5')),
            `expected a final "Cannot write value" warning, warns=${JSON.stringify(capture.warns)}`,
        );
    });

    it('recovers when a retried write succeeds', async () => {
        const capture = { warns: [] as string[], infos: [] as string[], states: [] as Array<{ id: string; val: unknown }> };
        const requests: RequestInfo[] = [];
        let coilWrites = 0;

        // Drop the first FC05 write, answer the second -> recovery on retry/1.
        server = createServer((socket: Socket) => {
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                while (data.length >= 12) {
                    const transactionId = data.readUInt16BE(0);
                    const unitId = data.readUInt8(6);
                    const fc = data.readUInt8(7);
                    if (fc !== 0x05) {
                        break; // not a write - ignore
                    }
                    const address = data.readUInt16BE(8);
                    requests.push({ connection: transactionId, unitId, address, count: 0 });
                    coilWrites += 1;
                    if (coilWrites >= 2) {
                        socket.write(buildFc5Response(transactionId, unitId, address, true));
                    }
                    break;
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeWriteTestOptions(port, 2), makeFakeAdapter(capture));
        master.start();
        void master.write('modbus.0.coils.1.5', { val: true } as ioBroker.State);

        // Wait until the retried write has reached the server and been answered.
        const deadline = Date.now() + 20_000;
        while (requests.length < 2 && Date.now() < deadline) {
            await wait(25);
        }
        await wait(100);

        assert.strictEqual(requests.length, 2, `expected exactly 2 write attempts, got ${JSON.stringify(requests)}`);
        // One retry was needed before the successful one; no further retries were logged.
        assert.ok(capture.infos.some(w => w.includes('[retry/1/2]')), 'expected a [retry/1/2] log');
        assert.ok(!capture.infos.some(w => w.includes('[retry/2/2]')), 'no [retry/2/2] expected on recovery');
        // A successful write must not end in the failure warning.
        assert.ok(
            !capture.warns.some(w => w.startsWith('Cannot write value')),
            `expected no "Cannot write value" warning, warns=${JSON.stringify(capture.warns)}`,
        );
    });
});
