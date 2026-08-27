/*
 * Regression test for a Modbus exception response on a single block.
 *
 * A device that answers one block with an exception PDU (illegal data address,
 * illegal function, device busy, ...) leaves the socket intact - no timeout, no
 * trashed request FIFO, no reconnect. The remaining blocks of that register type
 * must therefore still be polled. Aborting the whole register type would hide
 * every block behind the rejected one for good, because the block order is fixed.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { Master } from '../src/lib/Master';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const NS = 'modbus.0';

/** Address the fake device answers with "illegal data address" */
const REJECTED_ADDRESS = 72;

interface RequestInfo {
    connection: number;
    unitId: number;
    address: number;
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function makeFakeAdapter(warnings: string[]): ioBroker.Adapter {
    const noop = (): void => {
        /* silent */
    };
    const fake = {
        namespace: NS,
        common: { loglevel: 'info' },
        log: {
            level: 'info',
            debug: noop,
            silly: noop,
            info: noop,
            warn: (msg: string): void => {
                warnings.push(msg);
            },
            error: noop,
        },
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
            timeout: 500,
            defaultDeviceId: 1,
            multiDeviceId: true,
            disableLogging: true,
            poll: 60_000,
            readInterval: 10,
            waitTime: 10,
            writeInterval: 0,
            round: 1,
            maxBlock: 2,
            maxBoolBlock: 2,
            recon: 1_000,
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
        },
        devices: {
            1: makeDevice(1, [52, REJECTED_ADDRESS, 74]),
            2: makeDevice(2, [52, 72]),
        },
        objects: {},
    } as unknown as Options;
}

function buildMbap(transactionId: number, unitId: number, pdu: Buffer): Buffer {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(transactionId, 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

/** Regular FC4 answer with `count` zeroed registers */
function buildFc4Response(transactionId: number, unitId: number, count: number): Buffer {
    const data = Buffer.alloc(count * 2);
    return buildMbap(transactionId, unitId, Buffer.concat([Buffer.from([0x04, data.length]), data]));
}

/** FC4 exception answer: function code + 0x80, exception code 0x02 = illegal data address */
function buildFc4Exception(transactionId: number, unitId: number): Buffer {
    return buildMbap(transactionId, unitId, Buffer.from([0x04 | 0x80, 0x02]));
}

describe('Master block exception response', function () {
    this.timeout(6_000);

    let server: Server;
    let master: Master;

    afterEach(async () => {
        master?.close();
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('keeps polling the remaining blocks after a device rejects one of them', async () => {
        const requests: RequestInfo[] = [];
        const warnings: string[] = [];
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
                    requests.push({ connection, unitId, address });

                    if (unitId === 1 && address === REJECTED_ADDRESS) {
                        socket.write(buildFc4Exception(transactionId, unitId));
                    } else {
                        socket.write(buildFc4Response(transactionId, unitId, count));
                    }
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        master = new Master(makeOptions(port), makeFakeAdapter(warnings));
        master.start();

        const deadline = Date.now() + 4_000;
        while (requests.length < 5 && Date.now() < deadline) {
            await wait(25);
        }
        await wait(200);

        assert.deepStrictEqual(
            requests.map(request => [request.unitId, request.address]),
            [
                [1, 52],
                [1, REJECTED_ADDRESS],
                [1, 74],
                [2, 52],
                [2, 72],
            ],
            'the rejected block must not hide the blocks behind it',
        );
        assert.strictEqual(connectionCount, 1, 'an exception response must not trigger a reconnect');
        assert.ok(
            warnings.some(msg => msg.includes(`Block ${REJECTED_ADDRESS}-`)),
            `the rejected block should be logged as a warning, got: ${JSON.stringify(warnings)}`,
        );
    });
});
