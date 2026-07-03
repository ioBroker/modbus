/*
 * Loopback test for the Modbus/UDP master transport (issue #222 — "Modbus UDP Unterstützung").
 *
 * It drives the real `ModbusClientUDP` against a tiny self-contained Modbus/UDP server built on
 * node:dgram:
 *   - read path : an FC3 (read holding registers) request is answered with fixed register values,
 *                 and the client must decode them.
 *   - offline   : a server that never answers must make the request time out (UDP is fire-and-forget,
 *                 so an offline device produces a timeout, not a socket error).
 *
 * Assertions use node:assert only (no chai). No js-controller / real device involved.
 */
import assert from 'node:assert';
import { createSocket, type Socket } from 'node:dgram';
import ModbusClientUDP from '../src/lib/modbus/transports/modbus-client-udp';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};
const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    silly: noop,
    level: 'info',
} as unknown as ioBroker.Logger;

/** Bind a dgram socket to a random port and resolve with the chosen port. */
function bind(server: Socket): Promise<number> {
    return new Promise(resolve => server.bind(0, HOST, () => resolve((server.address() as { port: number }).port)));
}

describe('ModbusClientUDP master transport (issue #222)', function () {
    this.timeout(15000);

    it('reads holding registers over UDP (FC3 round-trip)', async () => {
        const registers = [111, 222, 333];
        const server = createSocket('udp4');
        server.on('error', noop);
        // Answer every FC3 with the fixed register values, echoing the request's MBAP id + unit id.
        server.on('message', (msg, rinfo) => {
            if (msg.readUInt8(7) !== 0x03) {
                return;
            }
            const txId = msg.readUInt16BE(0);
            const unitId = msg.readUInt8(6);
            const qty = msg.readUInt16BE(10);
            const data = Buffer.alloc(qty * 2);
            for (let i = 0; i < qty; i++) {
                data.writeUInt16BE(registers[i] ?? 0, i * 2);
            }
            const pdu = Buffer.concat([Buffer.from([0x03, qty * 2]), data]);
            const header = Buffer.alloc(7);
            header.writeUInt16BE(txId, 0);
            header.writeUInt16BE(0, 2);
            header.writeUInt16BE(pdu.length + 1, 4); // unit id + PDU
            header.writeUInt8(unitId, 6);
            server.send(Buffer.concat([header, pdu]), rinfo.port, rinfo.address);
        });
        const port = await bind(server);

        const client = new ModbusClientUDP({
            udp: { host: HOST, port, autoReconnect: false },
            unitId: 1,
            logger,
            timeout: 3000,
        });
        client.on('error', noop);

        try {
            const firstConnect = new Promise<void>(resolve => client.once('connect', resolve));
            client.connect();
            await firstConnect;

            const res = await client.readHoldingRegisters(1, 0, registers.length);
            assert.deepStrictEqual(res.register, registers, 'registers must decode from the UDP response');
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('times out when the device does not answer (offline behaviour)', async () => {
        const server = createSocket('udp4');
        server.on('error', noop);
        server.on('message', noop); // receive but never reply
        const port = await bind(server);

        const client = new ModbusClientUDP({
            udp: { host: HOST, port, autoReconnect: false },
            unitId: 1,
            logger,
            timeout: 250,
        });
        client.on('error', noop);

        try {
            const firstConnect = new Promise<void>(resolve => client.once('connect', resolve));
            client.connect();
            await firstConnect;

            let rejected: Error | undefined;
            try {
                await client.readHoldingRegisters(1, 0, 2);
            } catch (e) {
                rejected = e as Error;
            }
            assert.ok(rejected, 'an unanswered request must reject');
            assert.match(rejected!.message, /timeout/, `expected a timeout, got: ${rejected?.message}`);
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
