/*
 * Regression test for issue #594 — the TCP master could not recover after a
 * communication loss and required an adapter restart.
 *
 * It drives the real `ModbusClientTCP` transport against a tiny TCP server over a
 * real socket. The server drops the first connection in the middle of a response
 * frame (leaving a partial frame behind), then serves a full, valid FC3 response on
 * the reconnected connection.
 *
 * Before the fix the leftover bytes stayed in the client's receive buffer across the
 * reconnect and desynced the MBAP parser (TCP has no checksum to resync on), so every
 * subsequent read timed out forever. The fix clears the buffer and rebuilds the socket
 * on every reconnect, so the read below must succeed.
 *
 * Assertions use node:assert only (no chai). No js-controller / real device involved.
 */
import assert from 'node:assert';
import { createServer, connect, type Server, type Socket } from 'node:net';
import ModbusClientTCP from '../src/lib/modbus/transports/modbus-client-tcp';

const HOST = '127.0.0.1';
const UNIT = 11;
const REGS = [1234, 5678];

const noop = (): void => {
    /* silent logger */
};
const logger = { debug: noop, info: noop, warn: noop, error: noop, silly: noop, level: 'info' } as unknown as ioBroker.Logger;

/** Build a valid FC3 (read holding registers) response frame for the given registers. */
function buildFc3Response(txnId: number, unitId: number, regs: number[]): Buffer {
    const byteCount = regs.length * 2;
    const buf = Buffer.alloc(9 + byteCount);
    buf.writeUInt16BE(txnId, 0); // transaction id
    buf.writeUInt16BE(0, 2); // protocol id
    buf.writeUInt16BE(3 + byteCount, 4); // length = unitId + fc + byteCount + data
    buf.writeUInt8(unitId, 6); // unit id
    buf.writeUInt8(3, 7); // FC3
    buf.writeUInt8(byteCount, 8); // byte count
    for (let i = 0; i < regs.length; i++) {
        buf.writeUInt16BE(regs[i] & 0xffff, 9 + i * 2);
    }
    return buf;
}

describe('ModbusClientTCP reconnect (issue #594)', function () {
    // real TCP server + socket, one deliberate drop and a reconnect
    this.timeout(15000);

    it('clears the receive buffer on reconnect so polling recovers after a mid-frame drop', async () => {
        let connectionCount = 0;

        const server: Server = createServer((socket: Socket) => {
            connectionCount++;
            const conn = connectionCount;
            socket.on('error', noop);
            socket.on('data', (req: Buffer) => {
                const txnId = req.readUInt16BE(0);
                const unitId = req.readUInt8(6);
                if (conn === 1) {
                    // First connection: reply with a truncated frame, then kill the link
                    // mid-response so a partial frame is left in the client's buffer.
                    socket.write(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]));
                    socket.destroy();
                } else {
                    // After the reconnect: a full, valid response.
                    socket.write(buildFc3Response(txnId, unitId, REGS));
                }
            });
        });

        await new Promise<void>(resolve => server.listen(0, HOST, resolve));
        const port = (server.address() as { port: number }).port;

        const client = new ModbusClientTCP({
            tcp: { host: HOST, port, autoReconnect: false },
            unitId: UNIT,
            logger,
            timeout: 400,
        });
        client.on('error', noop);

        // Simulate the adapter's reconnect handling: rebuild the connection once, after
        // the server dropped it. (The Master does the same via its own reconnect timer.)
        let reconnected = false;
        client.on('close', () => {
            if (!reconnected) {
                reconnected = true;
                setTimeout(() => client.connect(), 30);
            }
        });

        try {
            // Establish the first connection.
            const firstConnect = new Promise<void>(resolve => client.once('connect', resolve));
            client.connect();
            await firstConnect;

            // Arm the reconnect wait BEFORE we trigger the drop.
            const reconnectDone = new Promise<void>(resolve => client.once('connect', resolve));

            // Fire-and-forget the poll that the server cuts off mid-frame.
            client.readHoldingRegisters(UNIT, 0, REGS.length).catch(noop);

            // Wait for the fresh connection to be established.
            await reconnectDone;

            // This read runs on the reconnected socket. With a stale buffer it would time
            // out; with the fix it parses the full response correctly.
            const resp = await client.readHoldingRegisters(UNIT, 0, REGS.length);
            assert.deepStrictEqual(resp.register, REGS);
            assert.ok(connectionCount >= 2, 'expected the client to actually reconnect');
        } finally {
            client.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
