/*
 * Unit tests for the low-level Modbus packet builder `Put` (src/lib/Put.ts) and the
 * assembly of a complete Modbus RTU frame together with the CRC-16/MODBUS checksum.
 * Assertions use node:assert only (no chai).
 *
 * Run: npm test   (mocha + ts-node, see ../.mocharc.json)
 */
import assert from 'node:assert';
import Put from '../src/lib/Put';
import crc16modbus from '../src/lib/crc16modbus';

describe('Modbus packet builder (Put)', () => {
    describe('integer words - byte order', () => {
        it('word8 writes exactly one byte', () => {
            assert.strictEqual(new Put().word8(0x41).buffer().toString('hex'), '41');
            assert.strictEqual(new Put().word8(0x41).length(), 1);
        });

        it('word16 big-endian vs little-endian', () => {
            assert.strictEqual(new Put().word16be(0x1234).buffer().toString('hex'), '1234');
            assert.strictEqual(new Put().word16le(0x1234).buffer().toString('hex'), '3412');
        });

        it('word32 big-endian vs little-endian', () => {
            assert.strictEqual(new Put().word32be(0xdeadbeef).buffer().toString('hex'), 'deadbeef');
            assert.strictEqual(new Put().word32le(0xdeadbeef).buffer().toString('hex'), 'efbeadde');
        });

        it('word64 big-endian vs little-endian (values below 2^53 are exact)', () => {
            // 0x0102030405 is exactly representable as a JS number.
            assert.strictEqual(new Put().word64be(0x0102030405).buffer().toString('hex'), '0000000102030405');
            assert.strictEqual(new Put().word64le(0x0102030405).buffer().toString('hex'), '0504030201000000');
        });
    });

    describe('composition', () => {
        it('is fluent - every writer returns the same Put instance', () => {
            const p = new Put();
            assert.strictEqual(p.word8(1), p);
            assert.strictEqual(p.word16be(1), p);
            assert.strictEqual(p.put(Buffer.from([0])), p);
            assert.strictEqual(p.pad(1), p);
        });

        it('put() appends a raw buffer verbatim and keeps order', () => {
            const buf = new Put().word8(0x11).put(Buffer.from([0xaa, 0xbb])).word8(0x22).buffer();
            assert.strictEqual(buf.toString('hex'), '11aabb22');
            assert.strictEqual(buf.length, 4);
        });

        it('pad(n) appends n zero bytes', () => {
            assert.strictEqual(new Put().pad(3).buffer().toString('hex'), '000000');
            assert.strictEqual(new Put().word8(0xff).pad(2).length(), 3);
        });

        it('length() equals the produced buffer length', () => {
            const p = new Put().word8(1).word16be(2).word32le(3).pad(2);
            assert.strictEqual(p.length(), p.buffer().length);
            assert.strictEqual(p.length(), 1 + 2 + 4 + 2);
        });

        it('buffer() is repeatable and does not consume the builder', () => {
            const p = new Put().word16be(0xabcd);
            const first = p.buffer().toString('hex');
            const second = p.buffer().toString('hex');
            assert.strictEqual(first, second);
            assert.strictEqual(first, 'abcd');
        });
    });

    describe('realistic Modbus RTU frame', () => {
        it('builds a Read-Holding-Registers ADU and seals it with a valid CRC', () => {
            // PDU: unit 0x11, function 0x03 (read holding registers),
            //      start address 0x006B, quantity 0x0003
            const pdu = new Put().word8(0x11).word8(0x03).word16be(0x006b).word16be(0x0003).buffer();
            assert.strictEqual(pdu.toString('hex'), '1103006b0003');

            const crc = crc16modbus(pdu);
            // RTU appends the CRC low byte first.
            const adu = new Put().put(pdu).word8(crc & 0xff).word8((crc >> 8) & 0xff).buffer();

            assert.strictEqual(adu.length, pdu.length + 2);
            // Receiver-side validation: CRC over the whole ADU (incl. CRC bytes) must be 0.
            assert.strictEqual(crc16modbus(adu), 0);
        });
    });

    describe('floatle() - IEEE-754 little-endian float', () => {
        it('encodes 1.0 as 00 00 80 3f', () => {
            assert.strictEqual(new Put().floatle(1.0).buffer().toString('hex'), '0000803f');
        });

        it('matches Buffer.writeFloatLE for a range of values', () => {
            for (const value of [0, 1, -1, 3.5, -3.5, 3.14159, 1e20, -1e-20]) {
                const expected = Buffer.alloc(4);
                expected.writeFloatLE(value, 0);
                assert.strictEqual(
                    new Put().floatle(value).buffer().toString('hex'),
                    expected.toString('hex'),
                    `floatle(${value}) mismatch`,
                );
            }
        });

        it('advances the offset by exactly 4 and keeps following data', () => {
            // Regression guard for the former offset-over-advance bug (data after the
            // float used to be silently dropped).
            const buf = new Put().floatle(1.0).word8(0x99).buffer();
            assert.strictEqual(buf.length, 5);
            assert.strictEqual(buf.toString('hex'), '0000803f99');
        });

        it('round-trips through Buffer.readFloatLE', () => {
            const buf = new Put().floatle(3.5).buffer();
            assert.strictEqual(buf.readFloatLE(0), 3.5);
        });
    });
});
