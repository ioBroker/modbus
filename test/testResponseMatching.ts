/*
 * Regression tests for ioBroker.modbus issue #829 - a response taken for the wrong request.
 *
 * In the first poll cycle on a fresh connection the device (or a gateway in front of it) delivered
 * one answer too many. The client took every response for the request that was pending at that
 * moment, so the whole cycle was shifted by one request: the block 63242 (8 registers) got the
 * 1-register answer of block 63236, and the 2-register float blocks got the data of other blocks,
 * e.g. Battery Power = -4.1e27 and Battery % = 1139.
 *
 * Now the client
 *   - drops an MBAP frame whose transaction ID is not the one of the pending request,
 *   - drops a frame of another unit (RTU, where there is no transaction ID) or function code,
 *   - rejects a read that does not return exactly the requested quantity.
 *
 * The tests drive the real TCP and TCP-RTU transports against tiny fake servers.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';
import ModbusClientTcpRtu from '../src/lib/modbus/transports/modbus-client-tcp-rtu';
import type ModbusClientCore from '../src/lib/modbus/modbus-client-core';
import crc16modbus from '../src/lib/crc16modbus';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};

function recordingLogger(): { logger: ioBroker.Logger; warnings: string[] } {
    const warnings: string[] = [];
    const logger = {
        debug: noop,
        info: noop,
        silly: noop,
        error: noop,
        level: 'info',
        warn: (msg: string) => warnings.push(msg),
    } as unknown as ioBroker.Logger;
    return { logger, warnings };
}

/** PDU of an FC3 answer with the given registers */
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

function rtu(unitId: number, pdu: Buffer): Buffer {
    const frame = Buffer.concat([Buffer.from([unitId]), pdu]);
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc16modbus(frame), 0);
    return Buffer.concat([frame, crc]);
}

/** One request as the fake server sees it */
interface Request {
    transactionId: number;
    unitId: number;
    address: number;
    quantity: number;
}

/**
 * Fake Modbus-TCP server. `answer` returns the bytes written for each FC3 request (MBAP frames),
 * so a test can send stale, duplicated or foreign frames in front of the real answer.
 */
function startTcpServer(answer: (req: Request, index: number) => Buffer): Promise<{ server: Server; port: number }> {
    return new Promise(resolve => {
        let index = 0;
        const server = createServer((socket: Socket) => {
            let buf = Buffer.alloc(0);
            socket.on('error', noop);
            socket.on('data', d => {
                buf = Buffer.concat([buf, d]);
                while (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
                    const frame = buf.subarray(0, 6 + buf.readUInt16BE(4));
                    buf = buf.subarray(frame.length);
                    socket.write(
                        answer(
                            {
                                transactionId: frame.readUInt16BE(0),
                                unitId: frame.readUInt8(6),
                                address: frame.readUInt16BE(8),
                                quantity: frame.readUInt16BE(10),
                            },
                            index++,
                        ),
                    );
                }
            });
        });
        server.listen(0, HOST, () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
}

/** Fake Modbus-RTU-over-TCP server, same idea: requests are fixed 8-byte frames */
function startRtuServer(answer: (req: Request) => Buffer): Promise<{ server: Server; port: number }> {
    return new Promise(resolve => {
        const server = createServer((socket: Socket) => {
            let buf = Buffer.alloc(0);
            socket.on('error', noop);
            socket.on('data', d => {
                buf = Buffer.concat([buf, d]);
                while (buf.length >= 8) {
                    const frame = buf.subarray(0, 8);
                    buf = buf.subarray(8);
                    socket.write(
                        answer({
                            transactionId: 0,
                            unitId: frame.readUInt8(0),
                            address: frame.readUInt16BE(2),
                            quantity: frame.readUInt16BE(4),
                        }),
                    );
                }
            });
        });
        server.listen(0, HOST, () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
}

function connected(client: ModbusClientCore): Promise<void> {
    return new Promise(resolve => {
        client.once('connect', resolve);
        client.connect();
    });
}

/** Register values the fake device holds: the address itself, so every block is recognizable */
function registersOf(req: Request): number[] {
    return Array.from({ length: req.quantity }, (_, i) => req.address + i);
}

describe('response matching (issue #829)', function () {
    this.timeout(10000);

    let server: Server | undefined;
    let client: ModbusClientCore | undefined;

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

    it('drops a stale frame with a foreign transaction ID on a fresh connection', async () => {
        const started = await startTcpServer((req, index) => {
            const own = mbap(req.transactionId, req.unitId, fc3Pdu(registersOf(req)));
            // first request: a stale 1-register answer to some earlier request comes first
            return index === 0
                ? Buffer.concat([mbap((req.transactionId + 1000) & 0xffff, req.unitId, fc3Pdu([0xffff])), own])
                : own;
        });
        server = started.server;
        const { logger, warnings } = recordingLogger();
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: started.port }, logger, timeout: 1000 });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        const first = await tcp.readHoldingRegisters(1, 206, 5);
        assert.deepStrictEqual(first.register, [206, 207, 208, 209, 210]);
        const second = await tcp.readHoldingRegisters(1, 62836, 2);
        assert.deepStrictEqual(second.register, [62836, 62837]);

        assert.ok(
            warnings.some(w => /Dropped a response with transaction ID/.test(w)),
            `expected the dropped frame in the log, got ${JSON.stringify(warnings)}`,
        );
    });

    it('does not shift the following responses when the device answers one request twice', async () => {
        let previous: Buffer | undefined;
        const started = await startTcpServer(req => {
            const own = mbap(req.transactionId, req.unitId, fc3Pdu(registersOf(req)));
            // the duplicated answer of the previous request arrives in front of the own one
            const out = previous ? Buffer.concat([previous, own]) : own;
            previous = own;
            return out;
        });
        server = started.server;
        const { logger } = recordingLogger();
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: started.port }, logger, timeout: 1000 });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        for (const [address, quantity] of [
            [206, 5],
            [62836, 2],
            [62852, 2],
            [63236, 1],
            [63242, 8],
        ]) {
            const resp = await tcp.readHoldingRegisters(1, address, quantity);
            assert.deepStrictEqual(
                resp.register,
                registersOf({ transactionId: 0, unitId: 1, address, quantity }),
                `block ${address} got the data of another block`,
            );
        }
    });

    it('accepts any transaction ID with ignoreTransactionId, for devices that do not echo it', async () => {
        // the device always answers with transaction ID 0
        const started = await startTcpServer(req => mbap(0, req.unitId, fc3Pdu(registersOf(req))));
        server = started.server;
        const { logger, warnings } = recordingLogger();
        const tcp = new ModbusClientTCP({
            tcp: { host: HOST, port: started.port },
            logger,
            timeout: 1000,
            ignoreTransactionId: true,
        });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 206, 5)).register, [206, 207, 208, 209, 210]);
        assert.deepStrictEqual((await tcp.readHoldingRegisters(1, 62836, 2)).register, [62836, 62837]);
        assert.deepStrictEqual(warnings, []);
    });

    it('rejects a read that returns fewer registers than requested', async () => {
        const started = await startTcpServer(req => mbap(req.transactionId, req.unitId, fc3Pdu([req.address])));
        server = started.server;
        const { logger } = recordingLogger();
        const tcp = new ModbusClientTCP({ tcp: { host: HOST, port: started.port }, logger, timeout: 1000 });
        client = tcp;
        tcp.on('error', noop);
        await connected(tcp);

        await assert.rejects(tcp.readHoldingRegisters(1, 63242, 8), (err: Error & { incomplete?: boolean }) => {
            assert.match(err.message, /device returned 1 of 8 requested registers/);
            assert.match(err.message, /address 63242, quantity 8, unit 1/);
            assert.strictEqual(err.incomplete, true);
            return true;
        });

        // the connection is still usable
        const resp = await tcp.readHoldingRegisters(1, 63236, 1);
        assert.deepStrictEqual(resp.register, [63236]);
    });

    it('drops an RTU frame from another unit or with another function code', async () => {
        const started = await startRtuServer(req =>
            Buffer.concat([
                rtu(req.unitId + 1, fc3Pdu(registersOf(req))), // another device on the bus
                rtu(req.unitId, Buffer.from([4, 2, 0xff, 0xff])), // FC4 instead of FC3
                rtu(req.unitId, fc3Pdu(registersOf(req))),
            ]),
        );
        server = started.server;
        const { logger, warnings } = recordingLogger();
        const rtuClient = new ModbusClientTcpRtu({ tcp: { host: HOST, port: started.port }, logger, timeout: 1000 });
        client = rtuClient;
        rtuClient.on('error', noop);
        await connected(rtuClient);

        const resp = await rtuClient.readHoldingRegisters(3, 83, 2);
        assert.deepStrictEqual(resp.register, [83, 84]);
        assert.ok(
            warnings.some(w => /unit 4 instead of 3/.test(w)),
            JSON.stringify(warnings),
        );
        assert.ok(
            warnings.some(w => /function code 4 instead of 3/.test(w)),
            JSON.stringify(warnings),
        );
    });
});
