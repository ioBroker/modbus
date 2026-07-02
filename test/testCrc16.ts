/*
 * Unit tests for the CRC-16/MODBUS checksum used to seal Modbus RTU frames.
 * Assertions use node:assert only (no chai).
 *
 * Run: npm test   (mocha + ts-node, see ../.mocharc.json)
 */
import assert from 'node:assert';
import crc16modbus from '../src/lib/crc16modbus';

/** Split a 16-bit CRC into the two bytes as they travel on a Modbus RTU wire (low byte first). */
function crcWireBytes(crc: number): [lo: number, hi: number] {
    return [crc & 0xff, (crc >> 8) & 0xff];
}

describe('CRC-16/MODBUS (crc16modbus)', () => {
    it('matches the canonical check value for "123456789" (0x4B37)', () => {
        // 0x4B37 is the standard check value for CRC-16/MODBUS and anchors correctness.
        assert.strictEqual(crc16modbus(Buffer.from('123456789', 'ascii')), 0x4b37);
    });

    it('returns the seed 0xFFFF for an empty buffer', () => {
        assert.strictEqual(crc16modbus(Buffer.alloc(0)), 0xffff);
    });

    it('is deterministic / pure (same bytes -> same CRC)', () => {
        const frame = Buffer.from([0x11, 0x03, 0x00, 0x6b, 0x00, 0x03]);
        assert.strictEqual(crc16modbus(frame), crc16modbus(Buffer.from(frame)));
    });

    it('supports incremental computation via the "previous" seed', () => {
        // Feeding the running CRC of the first chunk as the seed for the second chunk
        // must equal computing the CRC over the concatenation in one shot.
        const a = Buffer.from([0x11, 0x03, 0x00]);
        const b = Buffer.from([0x6b, 0x00, 0x03]);
        const oneShot = crc16modbus(Buffer.concat([a, b]));
        const incremental = crc16modbus(b, crc16modbus(a));
        assert.strictEqual(incremental, oneShot);
    });

    it('always returns an integer within the 16-bit range', () => {
        for (const buf of [Buffer.from([0x00]), Buffer.from([0xff, 0xff]), Buffer.from('hello world')]) {
            const crc = crc16modbus(buf);
            assert.ok(Number.isInteger(crc), `CRC ${crc} is not an integer`);
            assert.ok(crc >= 0 && crc <= 0xffff, `CRC ${crc} out of 16-bit range`);
        }
    });

    it('a frame with its CRC appended (low byte first) checksums back to 0', () => {
        // This is the classic receiver-side validation: running the CRC over the whole
        // ADU including the two trailing CRC bytes yields 0 for a valid frame. It is
        // independent of the exact CRC value, so it validates both the algorithm and
        // the on-the-wire byte order at once.
        const frame = Buffer.from([0x11, 0x03, 0x00, 0x6b, 0x00, 0x03]);
        const [lo, hi] = crcWireBytes(crc16modbus(frame));
        const adu = Buffer.concat([frame, Buffer.from([lo, hi])]);
        assert.strictEqual(crc16modbus(adu), 0);
    });

    it('detects single-bit corruption of the frame', () => {
        const frame = Buffer.from([0x11, 0x03, 0x00, 0x6b, 0x00, 0x03]);
        const good = crc16modbus(frame);

        const corrupted = Buffer.from(frame);
        corrupted[3] ^= 0x01; // flip one bit
        assert.notStrictEqual(crc16modbus(corrupted), good);
    });
});
