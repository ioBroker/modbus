/*
 * Integration (loopback) test for the proxy mode.
 *
 * It drives the built-in `Slave` server (as used by the proxy) over a REAL TCP
 * socket with a minimal, self-contained Modbus-TCP client:
 *   - read path : a value pushed into the served buffer (as the bridge does via
 *                 slave.write) is returned to a TCP client that reads the register.
 *   - write path: a TCP client write is applied and, because proxy mode uses
 *                 ack=false, is handed to the adapter as a command (setState ack=false)
 *                 so the master can forward it to the real device.
 *
 * No js-controller and no real Modbus device are involved: a tiny fake adapter
 * backs the Slave, and the "device" is the in-memory served buffer.
 *
 * Assertions use node:assert only (no chai).
 */
import assert from 'node:assert';
import net from 'node:net';
import Slave from '../src/lib/Slave';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const PORT = 15502;
const NS = 'modbus.0';
const FULL_ID = `${NS}.holdingRegisters.40001`;

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Records of every setState call so the write-back (ack=false) can be asserted. */
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

/** Build a minimal proxy `Options` object serving a single holding register at address 0. */
function makeProxyOptions(): Options {
    const emptyRegs = (offset: number): unknown => ({
        fullIds: [],
        deviceId: 1,
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

    const holdingRegs = {
        fullIds: [FULL_ID],
        deviceId: 1,
        addressLow: 0,
        addressHigh: 2,
        length: 2,
        config: [],
        blocks: [],
        offset: 40001,
        changed: true,
        values: [] as number[],
        mapping: { 0: FULL_ID } as { [address: number]: string },
    };

    const options = {
        config: {
            type: 'tcp',
            slave: false,
            proxy: true,
            proxyTcp: { port: PORT, ip: HOST },
            round: 1,
            timeout: 5000,
            defaultDeviceId: 1,
            disableLogging: true,
            alwaysUpdate: false,
            doNotIncludeAdrInId: false,
            preserveDotsInId: false,
            writeInterval: 0,
            doNotUseWriteMultipleRegisters: false,
            onlyUseWriteMultipleRegisters: false,
        },
        devices: {
            1: {
                disInputs: emptyRegs(10001),
                coils: emptyRegs(1),
                inputRegs: emptyRegs(30001),
                holdingRegs,
            },
        },
        objects: {
            [FULL_ID]: {
                native: { regType: 'holdingRegs', address: 0, type: 'uint16be', len: 1, offset: 0, factor: 1 },
            },
        },
    };

    return options as unknown as Options;
}

/** Send one Modbus-TCP frame and resolve with the full response frame. */
function sendModbus(req: Buffer, timeoutMs = 3000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port: PORT, host: HOST });
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

/** MBAP header + PDU. `unitId` defaults to 1 (the configured defaultDeviceId). */
function mbap(txId: number, pdu: Buffer, unitId = 1): Buffer {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(txId, 0); // transaction id
    header.writeUInt16BE(0, 2); // protocol id
    header.writeUInt16BE(pdu.length + 1, 4); // length = unitId + PDU
    header.writeUInt8(unitId, 6);
    return Buffer.concat([header, pdu]);
}

/** FC3 read holding registers */
async function readHolding(addr: number, qty: number): Promise<number[]> {
    const pdu = Buffer.from([0x03, (addr >> 8) & 0xff, addr & 0xff, (qty >> 8) & 0xff, qty & 0xff]);
    const res = await sendModbus(mbap(1, pdu));
    // response: MBAP(7) + FC(1) + byteCount(1) + data
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x03, `expected FC3, got 0x${fc.toString(16)}`);
    const byteCount = res.readUInt8(8);
    const out: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
        out.push(res.readUInt16BE(9 + i));
    }
    return out;
}

/** FC6 write single register */
async function writeSingle(addr: number, value: number): Promise<void> {
    const pdu = Buffer.from([0x06, (addr >> 8) & 0xff, addr & 0xff, (value >> 8) & 0xff, value & 0xff]);
    const res = await sendModbus(mbap(2, pdu));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x06, `expected FC6 echo, got 0x${fc.toString(16)}`);
}

async function waitForServer(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const up = await new Promise<boolean>(resolve => {
            const s = net.connect({ port: PORT, host: HOST });
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
    throw new Error(`Proxy slave server did not come up on ${HOST}:${PORT}`);
}

describe('proxy mode - Modbus TCP loopback', function () {
    // Opening a real TCP server + socket round-trips (server responseDelay is 100ms)
    this.timeout(15000);

    let slave: Slave;
    let setStateCalls: SetStateCall[];

    before(async () => {
        const fake = makeFakeAdapter();
        setStateCalls = fake.setStateCalls;
        // The Slave constructor initializes the served buffer and then starts the TCP server
        slave = new Slave(makeProxyOptions(), fake.adapter);
        await waitForServer();
    });

    after(done => {
        if (slave) {
            slave.close(() => done());
        } else {
            done();
        }
    });

    it('serves a value pushed into the buffer (bridge read path)', async () => {
        // The proxy bridge feeds polled values via slave.write(); simulate one here.
        await slave.write(FULL_ID, { val: 1234 });

        const regs = await readHolding(0, 1);
        assert.deepStrictEqual(regs, [1234]);
    });

    it('applies a client write and forwards it as a command (ack=false)', async () => {
        setStateCalls.length = 0;

        await writeSingle(0, 5678);

        // The written value is served back to clients ...
        const regs = await readHolding(0, 1);
        assert.deepStrictEqual(regs, [5678]);

        // ... and handed to the adapter as a command so the master can write it to the device.
        const write = setStateCalls.find(c => c.id === FULL_ID);
        assert.ok(write, 'expected a setState for the written register');
        assert.strictEqual(write.val, 5678);
        assert.strictEqual(write.ack, false, 'proxy client writes must be ack=false (forwarded to the device)');
    });
});
