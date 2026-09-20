/*
 * Regression test for issue #813: the proxy/slave server must route a request by its Modbus
 * unit ID when several device IDs are served.
 *
 * Before the fix the built-in server kept the buffers of the FIRST device only, so
 *   - every unit ID answered with the data of device 1 (identical register maps of identical
 *     meters collapsed onto one another), and
 *   - a client write for unit 2 was applied to the state of device 1.
 *
 * The test drives a real TCP socket with a minimal Modbus-TCP client. Both devices expose a
 * holding register at the SAME address 0, which is the normal case for identical devices.
 */
import assert from 'node:assert';
import net from 'node:net';
import Slave from '../src/lib/Slave';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const NS = 'modbus.0';

const ID_DEV1 = `${NS}.1.holdingRegisters.40001`;
const ID_DEV2 = `${NS}.2.holdingRegisters.40001`;
const ID_SINGLE = `${NS}.holdingRegisters.40001`;

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SetStateCall {
    id: string;
    val: ioBroker.StateValue;
    ack: unknown;
}

function makeFakeAdapter(): { adapter: ioBroker.Adapter; setStateCalls: SetStateCall[] } {
    const setStateCalls: SetStateCall[] = [];
    const noop = (): void => {
        /* silent logger */
    };
    const fake = {
        namespace: NS,
        log: { debug: noop, info: noop, warn: noop, error: noop, silly: noop, level: 'info' },
        setState(id: string, val: ioBroker.StateValue, ack: unknown, cb?: (err?: Error | null) => void): void {
            setStateCalls.push({ id, val, ack });
            if (typeof ack === 'function') {
                (ack as (err?: Error | null) => void)(null);
            } else if (typeof cb === 'function') {
                cb(null);
            }
        },
        setStateAsync(id: string, val: ioBroker.StateValue, ack: unknown): Promise<void> {
            setStateCalls.push({ id, val, ack });
            return Promise.resolve();
        },
        setObjectAsync(): Promise<void> {
            return Promise.resolve();
        },
        getForeignStatesAsync(): Promise<Record<string, ioBroker.State>> {
            return Promise.resolve({});
        },
        getStatesAsync(): Promise<Record<string, ioBroker.State>> {
            return Promise.resolve({});
        },
    };
    return { adapter: fake as unknown as ioBroker.Adapter, setStateCalls };
}

/** Register block without any register */
const emptyRegs = (deviceId: number, offset: number): unknown => ({
    fullIds: [],
    deviceId,
    addressLow: 0,
    addressHigh: 0,
    length: 0,
    config: [],
    blocks: [],
    offset,
    changed: true,
    values: [],
    mapping: {},
});

/** One holding register at address 0 — the same address on every device, as identical devices have */
const holdingRegs = (deviceId: number, fullId: string): unknown => ({
    fullIds: [fullId],
    deviceId,
    addressLow: 0,
    addressHigh: 2,
    length: 2,
    config: [],
    blocks: [],
    offset: 40001,
    changed: true,
    values: [] as number[],
    mapping: { 0: fullId } as { [address: number]: string },
});

const device = (deviceId: number, fullId: string): unknown => ({
    disInputs: emptyRegs(deviceId, 10001),
    coils: emptyRegs(deviceId, 1),
    inputRegs: emptyRegs(deviceId, 30001),
    holdingRegs: holdingRegs(deviceId, fullId),
});

const stateObject = (deviceId: number): unknown => ({
    native: { regType: 'holdingRegs', address: 0, type: 'uint16be', len: 1, offset: 0, factor: 1, deviceId },
});

/** Proxy options serving the given device IDs, each with one holding register at address 0 */
function makeProxyOptions(port: number, deviceIds: { [deviceId: number]: string }): Options {
    const devices: { [deviceId: number]: unknown } = {};
    const objects: { [id: string]: unknown } = {};
    for (const key of Object.keys(deviceIds)) {
        const deviceId = parseInt(key, 10);
        devices[deviceId] = device(deviceId, deviceIds[deviceId]);
        objects[deviceIds[deviceId]] = stateObject(deviceId);
    }

    return {
        config: {
            type: 'tcp',
            slave: false,
            proxy: true,
            proxyTcp: { port, ip: HOST },
            round: 1,
            timeout: 5000,
            defaultDeviceId: parseInt(Object.keys(deviceIds)[0], 10),
            multiDeviceId: Object.keys(deviceIds).length > 1,
            disableLogging: true,
            alwaysUpdate: false,
            doNotIncludeAdrInId: false,
            preserveDotsInId: false,
            writeInterval: 0,
            doNotUseWriteMultipleRegisters: false,
            onlyUseWriteMultipleRegisters: false,
        },
        devices,
        objects,
    } as unknown as Options;
}

/** Send one Modbus-TCP frame and resolve with the full response frame */
function sendModbus(port: number, req: Buffer, timeoutMs = 3000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host: HOST });
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (err?: Error, res?: Buffer): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (err) {
                reject(err);
            } else {
                resolve(res!);
            }
        };
        const timer = setTimeout(() => finish(new Error('Modbus response timeout')), timeoutMs);
        socket.on('connect', () => socket.write(req));
        socket.on('data', d => {
            chunks.push(d);
            const buf = Buffer.concat(chunks);
            // MBAP length field (bytes 4-5) counts unitId + PDU; total frame = 6 + length
            if (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
                finish(undefined, buf);
            }
        });
        socket.on('error', err => finish(err));
    });
}

function mbap(txId: number, pdu: Buffer, unitId: number): Buffer {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(txId, 0); // transaction id
    header.writeUInt16BE(0, 2); // protocol id
    header.writeUInt16BE(pdu.length + 1, 4); // length = unitId + PDU
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

/** FC3 read holding registers from one unit; returns the register values */
async function readHolding(port: number, unitId: number, addr: number, qty: number): Promise<number[]> {
    const pdu = Buffer.from([0x03, (addr >> 8) & 0xff, addr & 0xff, (qty >> 8) & 0xff, qty & 0xff]);
    const res = await sendModbus(port, mbap(1, pdu, unitId));
    const fc = res.readUInt8(7);
    assert.strictEqual(
        fc,
        0x03,
        `expected FC3, got 0x${fc.toString(16)} (exception 0x${res.readUInt8(8).toString(16)})`,
    );
    assert.strictEqual(res.readUInt8(6), unitId, 'the response must echo the requested unit ID');
    const byteCount = res.readUInt8(8);
    const out: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
        out.push(res.readUInt16BE(9 + i));
    }
    return out;
}

/** FC3 that is expected to fail; returns the Modbus exception code */
async function readHoldingException(port: number, unitId: number): Promise<number> {
    const pdu = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x01]);
    const res = await sendModbus(port, mbap(1, pdu, unitId));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x83, `expected an FC3 exception response, got 0x${fc.toString(16)}`);
    return res.readUInt8(8);
}

/** FC6 write single register to one unit */
async function writeSingle(port: number, unitId: number, addr: number, value: number): Promise<void> {
    const pdu = Buffer.from([0x06, (addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff]);
    const res = await sendModbus(port, mbap(2, pdu, unitId));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x06, `expected FC6 echo, got 0x${fc.toString(16)}`);
}

async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const up = await new Promise<boolean>(resolve => {
            const s = net.connect({ port, host: HOST });
            s.on('connect', () => {
                s.destroy();
                resolve(true);
            });
            s.on('error', () => resolve(false));
        });
        if (up) {
            return;
        }
        await wait(100);
    }
    throw new Error(`Slave server did not come up on ${HOST}:${port}`);
}

describe('proxy mode - several device IDs behind one TCP server (issue #813)', function () {
    this.timeout(15000);

    const PORT = 15503;
    let slave: Slave;
    let setStateCalls: SetStateCall[];

    before(async () => {
        const fake = makeFakeAdapter();
        setStateCalls = fake.setStateCalls;
        slave = new Slave(makeProxyOptions(PORT, { 1: ID_DEV1, 2: ID_DEV2 }), fake.adapter);
        await waitForServer(PORT);

        // The proxy bridge pushes every polled value into the served buffers
        await slave.write(ID_DEV1, { val: 1111 });
        await slave.write(ID_DEV2, { val: 2222 });
    });

    after(done => {
        if (slave) {
            slave.close(() => done());
        } else {
            done();
        }
    });

    it('serves each unit ID from its own register space', async () => {
        assert.deepStrictEqual(await readHolding(PORT, 1, 0, 1), [1111]);
        assert.deepStrictEqual(await readHolding(PORT, 2, 0, 1), [2222], 'unit 2 must not answer with device 1 data');
    });

    it('keeps the values of the devices apart when they are polled again', async () => {
        // Polling device 1 after device 2 must not overwrite the value served for unit 2
        await slave.write(ID_DEV1, { val: 3333 });

        assert.deepStrictEqual(await readHolding(PORT, 1, 0, 1), [3333]);
        assert.deepStrictEqual(await readHolding(PORT, 2, 0, 1), [2222]);
    });

    it('answers a neutral unit ID (0 / 255) from the default device', async () => {
        assert.deepStrictEqual(await readHolding(PORT, 0, 0, 1), [3333]);
        assert.deepStrictEqual(await readHolding(PORT, 255, 0, 1), [3333]);
    });

    it('answers an unknown unit ID with exception 0x0B instead of foreign data', async () => {
        const exception = await readHoldingException(PORT, 7);
        assert.strictEqual(exception, 0x0b, 'expected "gateway target device failed to respond"');
    });

    it('forwards a client write to the state of the addressed device', async () => {
        setStateCalls.length = 0;

        await writeSingle(PORT, 2, 0, 4242);

        const write = setStateCalls.find(c => c.id === ID_DEV2);
        assert.ok(write, 'expected a setState for the register of device 2');
        assert.strictEqual(write.val, 4242);
        assert.strictEqual(write.ack, false, 'proxy client writes must be forwarded as a command');
        assert.ok(
            !setStateCalls.some(c => c.id === ID_DEV1),
            'the write for unit 2 must not touch the state of device 1',
        );

        // ... and only the buffer of unit 2 changed
        assert.deepStrictEqual(await readHolding(PORT, 2, 0, 1), [4242]);
        assert.deepStrictEqual(await readHolding(PORT, 1, 0, 1), [3333]);
    });
});

describe('proxy mode - a single device answers every unit ID (backwards compatibility)', function () {
    this.timeout(15000);

    const PORT = 15504;
    let slave: Slave;

    before(async () => {
        const fake = makeFakeAdapter();
        slave = new Slave(makeProxyOptions(PORT, { 1: ID_SINGLE }), fake.adapter);
        await waitForServer(PORT);
        await slave.write(ID_SINGLE, { val: 777 });
    });

    after(done => {
        if (slave) {
            slave.close(() => done());
        } else {
            done();
        }
    });

    it('answers unit IDs that are not the configured one', async () => {
        // Many Modbus TCP clients send 0, 255 or an arbitrary unit ID - with one device that must work
        assert.deepStrictEqual(await readHolding(PORT, 1, 0, 1), [777]);
        assert.deepStrictEqual(await readHolding(PORT, 9, 0, 1), [777]);
        assert.deepStrictEqual(await readHolding(PORT, 255, 0, 1), [777]);
    });
});
