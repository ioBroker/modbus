/*
 * Tests for the diagnostics of a failed request (ioBroker.modbus issue #811).
 *
 * A device that simply does not answer used to produce a log that named neither the register nor
 * the function code nor the device:
 *
 *   warn:  Error: undefined          <- `trashCurrentRequest` was emitted without a payload
 *   error: Request timed out.        <- which request?
 *   warn:  Cannot write value 80: Error: timeout
 *
 * Every function code rejected with `new Error(err.message)`, so the exception code, the timeout
 * value and the request itself were thrown away before the adapter could log them.
 *
 * The tests drive the real UDP transport against a tiny dgram server (no js-controller, no device):
 * one that never answers (timeout) and one that answers with a Modbus exception.
 */
import assert from 'node:assert';
import { createSocket, type Socket } from 'node:dgram';
import ModbusClientUDP from '../src/lib/modbus/transports/modbus-client-udp';
import { describeRequest, type TrashedRequestInfo } from '../src/lib/modbus/modbus-client-core';
import { formatError } from '../src/lib/common';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};

/** Logger that records what would have been written to the ioBroker log */
function recordingLogger(): { logger: ioBroker.Logger; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const logger = {
        debug: noop,
        info: noop,
        silly: noop,
        level: 'info',
        warn: (msg: string) => warnings.push(msg),
        error: (msg: string) => errors.push(msg),
    } as unknown as ioBroker.Logger;
    return { logger, errors, warnings };
}

function bind(server: Socket): Promise<number> {
    return new Promise(resolve => server.bind(0, HOST, () => resolve((server.address() as { port: number }).port)));
}

/** MBAP header for a response that echoes the transaction and unit id of `request` */
function respond(server: Socket, request: Buffer, pdu: Buffer, port: number, address: string): void {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(request.readUInt16BE(0), 0);
    header.writeUInt16BE(0, 2);
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(request.readUInt8(6), 6);
    server.send(Buffer.concat([header, pdu]), port, address);
}

describe('request diagnostics (issue #811)', function () {
    this.timeout(15000);

    describe('describeRequest', () => {
        it('names function code, address and quantity of a read', () => {
            const pdu = Buffer.from([0x03, 0x19, 0xd1, 0x00, 0x02]); // FC3, address 6609, quantity 2
            assert.strictEqual(
                describeRequest({ fc: 3, unitId: 1, pdu }),
                'FC3 read holding registers, address 6609, quantity 2, unit 1',
            );
        });

        it('names the written value instead of a quantity for FC6', () => {
            const pdu = Buffer.from([0x06, 0x19, 0xd1, 0x00, 0x50]); // FC6, address 6609, value 80
            assert.strictEqual(
                describeRequest({ fc: 6, unitId: 7, pdu }),
                'FC6 write single register, address 6609, value 0x0050, unit 7',
            );
        });

        it('keeps the quantity for FC16 and survives an unknown function code', () => {
            const fc16 = Buffer.from([0x10, 0x19, 0xd1, 0x00, 0x01, 0x02, 0x00, 0x50]);
            assert.strictEqual(
                describeRequest({ fc: 16, unitId: 2, pdu: fc16 }),
                'FC16 write multiple registers, address 6609, quantity 1, unit 2',
            );
            assert.strictEqual(describeRequest({ fc: 99, unitId: 2, pdu: Buffer.from([99]) }), 'FC99, unit 2');
        });
    });

    describe('formatError', () => {
        it('renders an Error instead of the empty object of JSON.stringify', () => {
            assert.strictEqual(JSON.stringify(new Error('boom')), '{}', 'precondition of the old log output');
            assert.strictEqual(formatError(new Error('boom')), 'boom');
        });

        it('renders a socket error with its code and endpoint', () => {
            const err = Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
                address: '10.0.0.5',
                port: 502,
            });
            assert.strictEqual(formatError(err), 'connect ECONNREFUSED - 10.0.0.5:502');
        });

        it('never renders undefined for a missing error', () => {
            assert.strictEqual(formatError(undefined), 'unknown error');
        });
    });

    it('reports the unanswered request in the rejection, the event and the log', async () => {
        const server = createSocket('udp4');
        server.on('error', noop);
        server.on('message', noop); // receive, but never answer
        const port = await bind(server);

        const { logger, errors } = recordingLogger();
        const client = new ModbusClientUDP({
            udp: { host: HOST, port, autoReconnect: false },
            unitId: 7,
            logger,
            timeout: 250,
        });
        client.on('error', noop);

        const trashed: TrashedRequestInfo[] = [];
        client.on('trashCurrentRequest', (info: TrashedRequestInfo) => trashed.push(info));

        try {
            await new Promise<void>(resolve => {
                client.once('connect', resolve);
                client.connect();
            });

            let rejected: Error | undefined;
            try {
                await client.writeSingleRegister(7, 6609, 80);
            } catch (e) {
                rejected = e as Error;
            }

            assert.ok(rejected, 'an unanswered request must reject');
            // The message alone must answer: what, where, which device, how long did we wait
            assert.match(rejected!.message, /timeout after 250 ms/, rejected!.message);
            assert.match(rejected!.message, /FC6 write single register/, rejected!.message);
            assert.match(rejected!.message, /address 6609/, rejected!.message);
            assert.match(rejected!.message, /value 0x0050/, rejected!.message);
            assert.match(rejected!.message, /unit 7/, rejected!.message);

            assert.strictEqual(trashed.length, 1, 'the trashed request must be reported exactly once');
            assert.strictEqual(trashed[0].reason, 'timeout after 250 ms');
            assert.strictEqual(trashed[0].fc, 6);
            assert.strictEqual(trashed[0].unitId, 7);
            assert.match(trashed[0].request, /FC6 write single register, address 6609/);

            const timeoutLog = errors.find(e => e.includes('Request timed out'));
            assert.ok(timeoutLog, `expected a timeout error in the log, got: ${errors.join(' | ')}`);
            assert.match(timeoutLog!, /FC6 write single register, address 6609, value 0x0050, unit 7/);
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('reports the rejected request when the device answers with an exception', async () => {
        const server = createSocket('udp4');
        server.on('error', noop);
        // Answer every request with "illegal data address" for the requested function code
        server.on('message', (msg, rinfo) => {
            const fc = msg.readUInt8(7);
            respond(server, msg, Buffer.from([fc + 0x80, 0x02]), rinfo.port, rinfo.address);
        });
        const port = await bind(server);

        const { logger } = recordingLogger();
        const client = new ModbusClientUDP({
            udp: { host: HOST, port, autoReconnect: false },
            unitId: 3,
            logger,
            timeout: 2000,
        });
        client.on('error', noop);

        try {
            await new Promise<void>(resolve => {
                client.once('connect', resolve);
                client.connect();
            });

            let rejected: Error | undefined;
            try {
                await client.readHoldingRegisters(3, 6609, 2);
            } catch (e) {
                rejected = e as Error;
            }

            assert.ok(rejected, 'an exception response must reject');
            assert.match(rejected!.message, /ILLEGAL DATA ADDRESS/, rejected!.message);
            assert.match(rejected!.message, /exception 0x02/, rejected!.message);
            assert.match(
                rejected!.message,
                /FC3 read holding registers, address 6609, quantity 2, unit 3/,
                rejected!.message,
            );
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
