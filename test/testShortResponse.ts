/*
 * Regression test for issue #502 — a device that answers with fewer registers than requested.
 *
 * When registers are combined into one read block, some devices (or noisy RS485 links) return a
 * SHORT but self-consistent response: e.g. the master asks for 49 input registers but the device
 * replies with only 2. Before the fix, the master then tried to slice every configured register out
 * of the short payload, and `Buffer.readUInt16BE(offset * 2)` threw
 *   "The value of 'offset' is out of range. It must be >= 0 and <= 2. Received 96"
 * once per register (logged as "Can not set value: ...").
 *
 * This drives the REAL `Master` (over the real ModbusClientTCP transport) against a tiny fake
 * Modbus-TCP server that always answers FC4 with just 2 registers, and asserts that:
 *   - the registers that DO fit the response are still stored,
 *   - registers beyond the returned data are skipped (not stored, no crash),
 *   - exactly one clear warning is logged, and no "offset out of range" / "Can not set value" error.
 *
 * Assertions use node:assert only (no chai). No js-controller / real device involved.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { Master } from '../src/lib/Master';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const NS = 'modbus.0';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface SetStateCall {
    id: string;
    val: unknown;
    ack: unknown;
}

function makeFakeAdapter(): {
    adapter: ioBroker.Adapter;
    setStateCalls: SetStateCall[];
    warnings: string[];
    errors: string[];
} {
    const setStateCalls: SetStateCall[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
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
            warn: (m: string): number => warnings.push(m),
            error: (m: string): number => errors.push(m),
        },
        setTimeout: (cb: (...args: unknown[]) => void, ms: number, ...args: unknown[]): NodeJS.Timeout =>
            setTimeout(cb, ms, ...args),
        clearTimeout: (t: NodeJS.Timeout): void => clearTimeout(t),
        setState(id: string, val: unknown, ack: unknown, cb?: unknown): void {
            setStateCalls.push({ id, val, ack });
            if (typeof cb === 'function') {
                (cb as (err: Error | null) => void)(null);
            }
        },
        getStatesAsync: (): Promise<Record<string, ioBroker.State>> => Promise.resolve({}),
        delForeignObjectAsync: (): Promise<void> => Promise.resolve(),
        getStateAsync: (): Promise<ioBroker.State | null> => Promise.resolve(null),
        terminate: noop,
    };
    return { adapter: fake as unknown as ioBroker.Adapter, setStateCalls, warnings, errors };
}

/** One input register (uint16be, factor 1, offset 0). */
function makeReg(address: number, id: string): unknown {
    return {
        deviceId: 1,
        address,
        _address: address,
        len: 1,
        type: 'uint16be',
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

/**
 * One input-register block spanning addresses 0..48 (49 registers requested), plus two empty
 * binary reg types and an empty holding-reg type so the poll cycle only issues the FC4 read.
 */
function makeOptions(port: number): Options {
    const emptyRegs = { deviceId: 1, blocks: [], config: [] };
    const inputRegs = {
        deviceId: 1,
        blocks: [{ start: 0, count: 49, startIndex: 0, endIndex: 3 }],
        config: [
            makeReg(0, 'inputRegisters.30001'),
            makeReg(1, 'inputRegisters.30002'),
            makeReg(48, 'inputRegisters.30049'),
        ],
    };

    const options = {
        config: {
            type: 'tcp',
            tcp: { ip: HOST, port },
            timeout: 2000,
            defaultDeviceId: 1,
            disableLogging: true,
            poll: 60000,
            readInterval: 0,
            waitTime: 0,
            writeInterval: 0,
            round: 1,
            maxBlock: 100,
            maxBoolBlock: 100,
            recon: 60000,
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
        },
        devices: {
            1: {
                disInputs: emptyRegs,
                coils: emptyRegs,
                inputRegs,
                holdingRegs: { deviceId: 1, blocks: [], config: [], cyclicWrite: [] },
            },
        },
        objects: {},
    };

    return options as unknown as Options;
}

/** Fake Modbus-TCP server that answers every FC4 with only 2 registers (10, 20) — a short response. */
function startShortServer(): Promise<{ server: Server; port: number }> {
    return new Promise(resolve => {
        const server = createServer((socket: Socket) => {
            let buf = Buffer.alloc(0);
            socket.on('error', () => {
                /* ignore */
            });
            socket.on('data', d => {
                buf = Buffer.concat([buf, d]);
                // MBAP length field (bytes 4-5) counts unitId + PDU; total frame = 6 + length
                while (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
                    const total = 6 + buf.readUInt16BE(4);
                    const frame = buf.subarray(0, total);
                    buf = buf.subarray(total);
                    const txId = frame.readUInt16BE(0);
                    const unitId = frame.readUInt8(6);
                    const fc = frame.readUInt8(7);
                    if (fc === 0x04) {
                        // Only 2 registers of data, regardless of the requested quantity.
                        const data = Buffer.from([0x00, 0x0a, 0x00, 0x14]); // 10, 20
                        const pdu = Buffer.concat([Buffer.from([0x04, data.length]), data]);
                        const header = Buffer.alloc(7);
                        header.writeUInt16BE(txId, 0);
                        header.writeUInt16BE(0, 2);
                        header.writeUInt16BE(pdu.length + 1, 4); // unitId + PDU
                        header.writeUInt8(unitId, 6);
                        socket.write(Buffer.concat([header, pdu]));
                    }
                }
            });
        });
        server.listen(0, HOST, () => {
            const port = (server.address() as { port: number }).port;
            resolve({ server, port });
        });
    });
}

describe('Master short/truncated device response (issue #502)', function () {
    this.timeout(15000);

    let server: Server;
    let master: Master;

    after(done => {
        try {
            master?.close();
        } catch {
            /* ignore */
        }
        if (server) {
            server.close(() => done());
        } else {
            done();
        }
    });

    it('warns and skips registers beyond a short response instead of throwing "offset out of range"', async () => {
        const started = await startShortServer();
        server = started.server;

        const fake = makeFakeAdapter();
        master = new Master(makeOptions(started.port), fake.adapter);
        master.start();

        // allow the transport to connect and run one poll cycle
        await wait(800);

        const seen = fake.setStateCalls.filter(c => c.id.startsWith('inputRegisters.')).map(c => `${c.id}=${c.val}`);

        // The two registers that fit the (short) response are still stored.
        assert.ok(
            fake.setStateCalls.some(c => c.id === 'inputRegisters.30001' && c.val === 10),
            `expected inputRegisters.30001=10, saw ${JSON.stringify(seen)}`,
        );
        assert.ok(
            fake.setStateCalls.some(c => c.id === 'inputRegisters.30002' && c.val === 20),
            `expected inputRegisters.30002=20, saw ${JSON.stringify(seen)}`,
        );

        // The register that lies beyond the returned data is skipped — not stored, and no crash.
        assert.ok(
            !fake.setStateCalls.some(c => c.id === 'inputRegisters.30049'),
            'register beyond the short response must be skipped',
        );

        // Exactly the informative short-response warning, and NO cryptic buffer error.
        assert.ok(
            fake.warnings.some(w => /returned only \d+ of \d+ requested registers/.test(w)),
            `expected a short-response warning, got: ${JSON.stringify(fake.warnings)}`,
        );
        assert.ok(
            !fake.errors.some(e => /Can not set value/.test(e) || /out of range/.test(e)),
            `must not throw a buffer overflow, got errors: ${JSON.stringify(fake.errors)}`,
        );
    });
});
