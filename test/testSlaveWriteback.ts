/*
 * Integration (loopback) test for the slave write-back path and the read notifications.
 *
 * `regs.values` is BYTE-indexed for inputRegs/holdingRegs (see Slave.write(), which writes
 * `(address - addressLow) * 2 + b`), while `regs.mapping` is REGISTER-indexed. Two handlers got
 * that wrong:
 *   - FC6  wrote `regs.values[a]` / `[a + 1]` for register index `a`, so a single-register write
 *     landed on the bytes of register floor(a/2) and corrupted a neighbouring register.
 *   - FC16 copied the source bytes from `data.readUInt8(start * 2 + k)` — the block start —
 *     instead of the register's own position `(i + start) * 2 + k`, so every mapped register of a
 *     multi-register write got a copy of the FIRST register's bytes.
 * Both stay invisible as long as the server's own buffer is served back unchanged; they surface
 * as soon as the block is marked dirty and refreshed from `regs.values` (which is what a state
 * change from ioBroker does). The tests below force exactly that refresh.
 *
 * The read notifications are covered too, including the byte/bit asymmetry of the events:
 * modbus-server-core emits a BYTE start for FC3/FC4 but a raw BIT address for FC1/FC2, so only the
 * register handlers may shift it back with `>> 1`.
 *
 * A tiny fake adapter backs the Slave; no js-controller and no real Modbus device are involved.
 * Assertions use node:assert only (no chai).
 */
import assert from 'node:assert';
import net from 'node:net';
import Slave from '../src/lib/Slave';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const PORT = 15503;
const NS = 'modbus.0';

/** Holding registers 0..4 are mapped; 5..7 exist in the block but stay unmapped. */
const HR = (address: number): string => `${NS}.holdingRegisters.4000${address + 1}`;
const COIL = `${NS}.coils.3`;

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SetStateCall {
    id: string;
    val: unknown;
    ack: unknown;
}

function makeFakeAdapter(): { adapter: ioBroker.Adapter; setStateCalls: SetStateCall[]; errors: string[] } {
    const setStateCalls: SetStateCall[] = [];
    const errors: string[] = [];
    const noop = (): void => {
        /* silent logger */
    };
    /** readNotify uses the object form setState(id, {val, ack, expire}, cb) — normalize both. */
    const record = (id: string, val: unknown, ack: unknown): void => {
        if (val && typeof val === 'object' && 'val' in (val as Record<string, unknown>)) {
            const state = val as { val: unknown; ack: unknown };
            setStateCalls.push({ id, val: state.val, ack: state.ack });
        } else {
            setStateCalls.push({ id, val, ack });
        }
    };
    const fake = {
        namespace: NS,
        log: {
            debug: noop,
            info: noop,
            warn: noop,
            error: (m: string): number => errors.push(m),
            silly: noop,
            level: 'info',
        },
        setState(id: string, val: unknown, ack: unknown, cb?: (err?: Error | null) => void): void {
            record(id, val, ack);
            if (typeof ack === 'function') {
                (ack as (err?: Error | null) => void)(null);
            } else if (typeof cb === 'function') {
                cb(null);
            }
        },
        setStateAsync(id: string, val: unknown, ack: unknown): Promise<void> {
            record(id, val, ack);
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
    return { adapter: fake as unknown as ioBroker.Adapter, setStateCalls, errors };
}

/** Holding-register block 0..7 with five mapped uint16be registers; coil block 0..7 with one mapped coil. */
function makeSlaveOptions(): { options: Options; holdingRegs: { changed: boolean; values: number[] } } {
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

    const mappedHolding: { [address: number]: string } = { 0: HR(0), 1: HR(1), 2: HR(2), 3: HR(3), 4: HR(4) };

    const holdingRegs = {
        fullIds: Object.values(mappedHolding),
        deviceId: 1,
        addressLow: 0,
        addressHigh: 8,
        length: 8,
        config: [],
        blocks: [],
        offset: 40001,
        changed: true,
        values: new Array(16).fill(0) as number[],
        mapping: mappedHolding,
    };

    const coils = {
        fullIds: [COIL],
        deviceId: 1,
        addressLow: 0,
        addressHigh: 8,
        length: 8,
        config: [],
        blocks: [],
        offset: 1,
        changed: true,
        values: new Array(8).fill(0) as number[],
        mapping: { 3: COIL } as { [address: number]: string },
    };

    const objects: Record<string, unknown> = {
        [COIL]: { native: { regType: 'coils', address: 3, poll: true } },
    };
    for (const [address, id] of Object.entries(mappedHolding)) {
        objects[id] = {
            native: {
                regType: 'holdingRegs',
                address: parseInt(address, 10),
                type: 'uint16be',
                len: 1,
                offset: 0,
                factor: 1,
            },
        };
    }

    const options = {
        config: {
            type: 'tcp',
            slave: true,
            tcp: { port: PORT, ip: HOST },
            round: 1,
            timeout: 5000,
            defaultDeviceId: 1,
            disableLogging: true,
            alwaysUpdate: false,
            notifyOnReadHoldingRegs: true,
            notifyOnReadCoils: true,
        },
        devices: {
            1: {
                disInputs: emptyRegs(10001),
                coils,
                inputRegs: emptyRegs(30001),
                holdingRegs,
            },
        },
        objects,
    };

    return { options: options as unknown as Options, holdingRegs };
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

const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];

/** FC3 read holding registers */
async function readHolding(addr: number, qty: number): Promise<number[]> {
    const res = await sendModbus(mbap(1, Buffer.from([0x03, ...be16(addr), ...be16(qty)])));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x03, `expected FC3, got 0x${fc.toString(16)}`);
    const byteCount = res.readUInt8(8);
    const out: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
        out.push(res.readUInt16BE(9 + i));
    }
    return out;
}

/** FC1 read coils */
async function readCoils(addr: number, qty: number): Promise<void> {
    const res = await sendModbus(mbap(4, Buffer.from([0x01, ...be16(addr), ...be16(qty)])));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x01, `expected FC1, got 0x${fc.toString(16)}`);
}

/** FC6 write single register */
async function writeSingle(addr: number, value: number): Promise<void> {
    const res = await sendModbus(mbap(2, Buffer.from([0x06, ...be16(addr), ...be16(value)])));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x06, `expected FC6 echo, got 0x${fc.toString(16)}`);
}

/** FC16 write multiple registers */
async function writeMultiple(addr: number, values: number[]): Promise<void> {
    const data: number[] = [];
    for (const value of values) {
        data.push(...be16(value));
    }
    const pdu = Buffer.from([0x10, ...be16(addr), ...be16(values.length), data.length, ...data]);
    const res = await sendModbus(mbap(3, pdu));
    const fc = res.readUInt8(7);
    assert.strictEqual(fc, 0x10, `expected FC16 echo, got 0x${fc.toString(16)}`);
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
    throw new Error(`Slave server did not come up on ${HOST}:${PORT}`);
}

describe('slave mode - Modbus TCP loopback', function () {
    this.timeout(20000);

    let slave: Slave;
    let setStateCalls: SetStateCall[];
    let errors: string[];
    let holdingRegs: { changed: boolean; values: number[] };

    const notifies = (): string[] => setStateCalls.filter(c => c.id.startsWith(`${NS}.readNotify.`)).map(c => c.id);

    before(async () => {
        const fake = makeFakeAdapter();
        setStateCalls = fake.setStateCalls;
        errors = fake.errors;
        const built = makeSlaveOptions();
        holdingRegs = built.holdingRegs;
        // The Slave constructor initializes the served buffer and then starts the TCP server
        slave = new Slave(built.options, fake.adapter);
        await waitForServer();
    });

    after(done => {
        if (slave) {
            slave.close(() => done());
        } else {
            done();
        }
    });

    beforeEach(() => {
        setStateCalls.length = 0;
        errors.length = 0;
        holdingRegs.values.fill(0);
    });

    describe('write-back into the byte-indexed value array', () => {
        it('FC6 writes a single register to its own two bytes', async () => {
            // Register 4 -> bytes 8/9. The old code wrote bytes 4/5, i.e. register 2.
            await writeSingle(4, 0xbeef);

            assert.strictEqual(holdingRegs.values[8], 0xbe, 'high byte of register 4');
            assert.strictEqual(holdingRegs.values[9], 0xef, 'low byte of register 4');
            assert.strictEqual(holdingRegs.values[4], 0, 'register 2 must not be touched by a write to register 4');
            assert.strictEqual(holdingRegs.values[5], 0, 'register 2 must not be touched by a write to register 4');

            const write = setStateCalls.find(c => c.id === HR(4));
            assert.ok(write, `expected a setState for ${HR(4)}, saw ${JSON.stringify(setStateCalls.map(c => c.id))}`);
            assert.strictEqual(write.val, 0xbeef);
            assert.strictEqual(write.ack, true, 'in slave mode the slave is authoritative -> ack=true');
        });

        it('FC6 survives a refresh of the served buffer from the value array', async () => {
            await writeSingle(4, 0x1234);

            // A state change marks the block dirty; the next read then refreshes the served buffer
            // from regs.values — which is where the wrong index used to surface.
            holdingRegs.changed = true;
            const regs = await readHolding(0, 8);

            assert.strictEqual(regs[4], 0x1234, 'register 4 must read back what FC6 wrote');
            assert.strictEqual(regs[2], 0, 'register 2 must still be zero');
        });

        it('FC16 copies each register from its own position, not from the block start', async () => {
            await writeMultiple(0, [0x1111, 0x2222, 0x3333]);

            // The old code read `start * 2 + k` for every register -> 11 11 11 11 11 11.
            assert.deepStrictEqual(
                holdingRegs.values.slice(0, 6),
                [0x11, 0x11, 0x22, 0x22, 0x33, 0x33],
                'each register must carry its own bytes',
            );

            const expected: [number, number][] = [
                [0, 0x1111],
                [1, 0x2222],
                [2, 0x3333],
            ];
            for (const [address, value] of expected) {
                const write = setStateCalls.find(c => c.id === HR(address));
                assert.ok(write, `expected a setState for ${HR(address)}`);
                assert.strictEqual(write.val, value, `${HR(address)} value`);
            }
        });

        it('FC16 survives a refresh of the served buffer from the value array', async () => {
            await writeMultiple(0, [0xaaaa, 0xbbbb, 0xcccc]);

            holdingRegs.changed = true;
            const regs = await readHolding(0, 4);

            assert.deepStrictEqual(regs.slice(0, 3), [0xaaaa, 0xbbbb, 0xcccc]);
        });

        it('writes without an error in the log', async () => {
            await writeSingle(4, 0x0001);
            await writeMultiple(0, [1, 2, 3]);

            assert.deepStrictEqual(errors, [], `no errors expected, got ${JSON.stringify(errors)}`);
        });
    });

    describe('read notifications', () => {
        it('notifies exactly the mapped registers covered by an FC3 read', async () => {
            // FC3 emits a BYTE start (address * 2) and the handler shifts it back with >> 1.
            // Reading registers 2..3 must notify 40003/40004 — without the shift it would hit 40005.
            await readHolding(2, 2);

            assert.deepStrictEqual(notifies().sort(), [
                `${NS}.readNotify.holdingRegisters.40003`,
                `${NS}.readNotify.holdingRegisters.40004`,
            ]);
        });

        it('mirrors the value state id under readNotify and writes it acknowledged', async () => {
            await readHolding(0, 1);

            const notify = setStateCalls.find(c => c.id.startsWith(`${NS}.readNotify.`));
            assert.ok(notify, 'expected a read notification');
            assert.strictEqual(notify.id, `${NS}.readNotify.holdingRegisters.40001`);
            assert.strictEqual(notify.ack, true, 'ack=true keeps the adapter out of its own stateChange handler');
        });

        it('counts up by one per read', async () => {
            await readHolding(0, 1);
            await readHolding(0, 1);
            await readHolding(0, 1);

            const values = setStateCalls
                .filter(c => c.id === `${NS}.readNotify.holdingRegisters.40001`)
                .map(c => c.val as number);
            assert.strictEqual(values.length, 3, `expected three notifications, got ${JSON.stringify(values)}`);
            assert.deepStrictEqual(values, [values[0], values[0] + 1, values[0] + 2]);
        });

        it('skips unmapped addresses inside the read range', async () => {
            await readHolding(4, 4); // registers 4..7, only 4 is mapped

            assert.deepStrictEqual(notifies(), [`${NS}.readNotify.holdingRegisters.40005`]);
        });

        it('uses the raw bit address for FC1 (no byte/word shift)', async () => {
            // FC1 emits the coil address unshifted. Reading coils 3..4 must notify coil 3.
            await readCoils(3, 2);

            assert.deepStrictEqual(notifies(), [`${NS}.readNotify.coils.3`]);
        });
    });
});
