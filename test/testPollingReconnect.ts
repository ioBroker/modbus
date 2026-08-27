/*
 * Regression test for a polling cycle that continued after a request timeout.
 *
 * Before the fix, the block helper logged and swallowed the timeout. The active
 * polling loop then queued the following register while the TCP socket was
 * already closed. On reconnect that stale request was sent before the fresh
 * polling cycle and both cycles could run in parallel.
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

function makeFakeAdapter(): ioBroker.Adapter {
    const noop = (): void => {
        /* silent */
    };
    const fake = {
        namespace: NS,
        common: { loglevel: 'debug' },
        log: { level: 'debug', debug: noop, silly: noop, info: noop, warn: noop, error: noop },
        setTimeout: (cb: (...args: unknown[]) => void, ms: number, ...args: unknown[]): NodeJS.Timeout =>
            setTimeout(cb, ms, ...args),
        clearTimeout: (timer: NodeJS.Timeout): void => clearTimeout(timer),
        setState(_id: string, _val: unknown, _ack: unknown, cb?: unknown): void {
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

function makeOptions(port: number): Options {
    return {
        config: {
            type: 'tcp',
            tcp: { ip: HOST, port },
            timeout: 100,
            defaultDeviceId: 1,
            multiDeviceId: true,
            disableLogging: true,
            poll: 60_000,
            readInterval: 20,
            waitTime: 30,
            writeInterval: 0,
            round: 1,
            maxBlock: 2,
            maxBoolBlock: 2,
            recon: 50,
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
        },
        devices: {
            1: makeDevice(1, [52, 72, 74]),
            2: makeDevice(2, [52, 72]),
        },
        objects: {},
    } as unknown as Options;
}

function buildFc4Response(transactionId: number, unitId: number, count: number): Buffer {
    const data = Buffer.alloc(count * 2);
    const pdu = Buffer.concat([Buffer.from([0x04, data.length]), data]);
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transactionId, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

describe('Master polling reconnect', function () {
    this.timeout(6_000);

    let server: Server;
    let master: Master;

    afterEach(async () => {
        master?.close();
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('does not carry a stale polling request into the reconnected socket', async () => {
        const requests: RequestInfo[] = [];
        let connectionCount = 0;

        server = createServer((socket: Socket) => {
            const connection = ++connectionCount;
            let buffer = Buffer.alloc(0);
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', data => {
                buffer = Buffer.concat([buffer, data]);
                while (buffer.length >= 6 && buffer.length >= 6 + buffer.readUInt16BE(4)) {
                    const total = 6 + buffer.readUInt16BE(4);
                    const frame = buffer.subarray(0, total);
                    buffer = buffer.subarray(total);

                    const transactionId = frame.readUInt16BE(0);
                    const unitId = frame.readUInt8(6);
                    const address = frame.readUInt16BE(8);
                    const count = frame.readUInt16BE(10);
                    requests.push({ connection, unitId, address, count });

                    // Deliberately drop the first connection's ID 1 / address 72 response.
                    if (connection === 1 && unitId === 1 && address === 72) {
                        continue;
                    }
                    socket.write(buildFc4Response(transactionId, unitId, count));
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeOptions(port), makeFakeAdapter());
        master.start();

        const deadline = Date.now() + 4_000;
        while (requests.filter(request => request.connection === 2).length < 5 && Date.now() < deadline) {
            await wait(25);
        }
        await wait(100);

        assert.deepStrictEqual(
            requests.filter(request => request.connection === 1).map(request => [request.unitId, request.address]),
            [
                [1, 52],
                [1, 72],
            ],
            'the timed-out connection must not receive or queue address 74',
        );
        assert.deepStrictEqual(
            requests.filter(request => request.connection === 2).map(request => [request.unitId, request.address]),
            [
                [1, 52],
                [1, 72],
                [1, 74],
                [2, 52],
                [2, 72],
            ],
            'the reconnected socket must start exactly one fresh polling cycle',
        );
    });
});
