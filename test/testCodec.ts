/*
 * Regression tests for the register codec (`src/lib/common.ts`).
 *
 * These lock in the fixes and the new register types that came with the read-notify PR:
 *   - 64-bit integers were encoded with `value >> 32`, but JS masks the shift count mod 32, so
 *     `x >> 32 === x >> 0`: the high word got a copy of the low word (12000 -> 00002ee000002ee0)
 *     and any negative or >= 2^31 value threw a RangeError inside writeUInt32BE. Decoding used
 *     `i1 * 0x100000000 - i2` for negatives, which is simply not two's complement.
 *   - int8be/int8le masked the value to 0..255 and then called writeInt8, which rejects that
 *     range -> negative int8 values threw and the register was silently left unwritten.
 *   - the new signExtendedInt8be/le types sign-extend into the pad byte so a foreign master
 *     reading the whole 16-bit register as int16 sees the signed value.
 *   - the new int64*str/uint64*str types carry the exact 64-bit value as a decimal string,
 *     beyond the 2^53 exactness limit of a JS number.
 *
 * Assertions use node:assert only (no chai). Nothing here touches the network or js-controller.
 */
import assert from 'node:assert';
import { extractValue, writeValue, stringRegisterTypes, variableLengthStringTypes } from '../src/lib/common';
import type { RegisterEntryType } from '../src/types';

/** writeValue -> hex, for byte-exact assertions on the wire format. */
const hex = (type: RegisterEntryType, value: number | string, len?: number): string =>
    writeValue(type, value, len).toString('hex');

/** writeValue -> extractValue round trip (offset 0, whole buffer). */
const roundTrip = (type: RegisterEntryType, value: number | string, len = 4): string | number =>
    extractValue(type, len, writeValue(type, value, len), 0);

describe('codec: 64-bit integers', () => {
    it('encodes a value whose high word is zero without duplicating the low word', () => {
        // Was 00002ee000002ee0 (read back as 51539607564000) because of `value >> 32`.
        assert.strictEqual(hex('uint64be', 12000), '0000000000002ee0');
        assert.strictEqual(hex('uint64le', 12000), 'e02e000000000000');
        assert.strictEqual(roundTrip('uint64be', 12000), 12000);
        assert.strictEqual(roundTrip('uint64le', 12000), 12000);
    });

    it('encodes values at and above 2^31 (previously a RangeError in writeUInt32BE)', () => {
        assert.strictEqual(hex('uint64be', 0x80000000), '0000000080000000');
        assert.strictEqual(roundTrip('uint64be', 0x80000000), 0x80000000);
        assert.strictEqual(roundTrip('uint64le', 0x80000000), 0x80000000);
    });

    it('encodes negative int64 values in two’s complement', () => {
        assert.strictEqual(hex('int64be', -5), 'fffffffffffffffb');
        assert.strictEqual(hex('int64le', -5), 'fbffffffffffffff');
        assert.strictEqual(roundTrip('int64be', -5), -5);
        assert.strictEqual(roundTrip('int64le', -5), -5);
        assert.strictEqual(roundTrip('int64be', -1234567890123), -1234567890123);
    });

    it('decodes a negative int64 bit pattern correctly', () => {
        // The old `i1 * 0x100000000 - i2` branch returned -8589934587 for this pattern.
        const be = Buffer.alloc(8);
        be.writeBigInt64BE(-5n);
        assert.strictEqual(extractValue('int64be', 4, be, 0), -5);

        const le = Buffer.alloc(8);
        le.writeBigInt64LE(-5n);
        assert.strictEqual(extractValue('int64le', 4, le, 0), -5);
    });

    it('truncates a fractional value instead of throwing in BigInt()', () => {
        assert.strictEqual(roundTrip('uint64be', 1.5), 1);
        assert.strictEqual(roundTrip('int64be', -1.5), -1);
    });

    it('reads at a register offset, not a byte offset', () => {
        const buf = Buffer.alloc(16);
        buf.writeBigUInt64BE(7n, 8); // second 64-bit slot = register offset 4
        assert.strictEqual(extractValue('uint64be', 4, buf, 4), 7);
    });
});

describe('codec: exact 64-bit as decimal string', () => {
    it('round-trips the full unsigned range', () => {
        assert.strictEqual(hex('uint64bestr', '18446744073709551615'), 'ffffffffffffffff');
        assert.strictEqual(roundTrip('uint64bestr', '18446744073709551615'), '18446744073709551615');
        assert.strictEqual(roundTrip('uint64lestr', '18446744073709551615'), '18446744073709551615');
    });

    it('round-trips the full signed range', () => {
        assert.strictEqual(hex('int64bestr', '-9223372036854775808'), '8000000000000000');
        assert.strictEqual(roundTrip('int64bestr', '-9223372036854775808'), '-9223372036854775808');
        assert.strictEqual(roundTrip('int64bestr', '9223372036854775807'), '9223372036854775807');
        assert.strictEqual(roundTrip('int64lestr', '-1'), '-1');
    });

    it('keeps precision that the numeric types lose above 2^53', () => {
        const value = '9007199254740993'; // 2^53 + 1, not representable as a JS number
        assert.strictEqual(roundTrip('uint64bestr', value), value);
        // The numeric type has to collapse it to the nearest representable double.
        assert.notStrictEqual(String(roundTrip('uint64be', Number(value))), value);
    });

    it('accepts a number defensively and rejects non-integer text', () => {
        assert.strictEqual(roundTrip('int64bestr', 12345), '12345');
        // Rejected by BigInt() -> SyntaxError, caught by the callers in Slave/Master as
        // "Can not write value", leaving the register unchanged.
        assert.throws(() => writeValue('uint64bestr', 'abc'), SyntaxError);
        assert.throws(() => writeValue('uint64bestr', '1.5'), SyntaxError);
    });
});

describe('codec: signed int8 in a 16-bit register', () => {
    it('writes a negative int8 instead of throwing a RangeError', () => {
        // `writeInt8(value & 0xff)` threw "The value of 'value' is out of range ... Received 251".
        assert.strictEqual(hex('int8be', -5), '00fb');
        assert.strictEqual(hex('int8le', -5), 'fb00');
        assert.strictEqual(extractValue('int8be', 1, writeValue('int8be', -5), 0), -5);
        assert.strictEqual(extractValue('int8le', 1, writeValue('int8le', -5), 0), -5);
    });

    it('leaves the pad byte at zero for int8be/int8le', () => {
        assert.strictEqual(writeValue('int8be', -5)[0], 0x00);
        assert.strictEqual(writeValue('int8le', -5)[1], 0x00);
    });

    it('sign-extends into the pad byte for the signExtended types', () => {
        assert.strictEqual(hex('signExtendedInt8be', -5), 'fffb');
        assert.strictEqual(hex('signExtendedInt8le', -5), 'fbff');
        // A foreign master reading the whole register as int16 gets the signed value.
        assert.strictEqual(writeValue('signExtendedInt8be', -5).readInt16BE(0), -5);
        assert.strictEqual(writeValue('signExtendedInt8le', -5).readInt16LE(0), -5);
        assert.strictEqual(extractValue('signExtendedInt8be', 1, writeValue('signExtendedInt8be', -5), 0), -5);
        assert.strictEqual(extractValue('signExtendedInt8le', 1, writeValue('signExtendedInt8le', -5), 0), -5);
    });

    it('is byte-identical to int8be/int8le for non-negative values', () => {
        for (const value of [0, 1, 127]) {
            assert.strictEqual(hex('signExtendedInt8be', value), hex('int8be', value), `value ${value}`);
            assert.strictEqual(hex('signExtendedInt8le', value), hex('int8le', value), `value ${value}`);
        }
    });

    it('rejects out-of-range values for the signExtended types but wraps for int8be/int8le', () => {
        assert.throws(() => writeValue('signExtendedInt8be', 200), RangeError);
        assert.throws(() => writeValue('signExtendedInt8le', -129), RangeError);
        // Documented difference: the plain types mask to 8 bits (200 -> 0xc8 -> -56).
        assert.strictEqual(hex('int8be', 200), '00c8');
        assert.strictEqual(extractValue('int8be', 1, writeValue('int8be', 200), 0), -56);
    });

    it('ignores garbage in the pad byte when reading', () => {
        assert.strictEqual(extractValue('signExtendedInt8be', 1, Buffer.from([0xa5, 0xfb]), 0), -5);
        assert.strictEqual(extractValue('signExtendedInt8le', 1, Buffer.from([0xfb, 0xa5]), 0), -5);
    });
});

describe('codec: register type tables', () => {
    it('treats every variable-length string type as a string type', () => {
        for (const type of variableLengthStringTypes) {
            assert.ok(stringRegisterTypes.includes(type), `${type} missing from stringRegisterTypes`);
        }
    });

    it('classifies the *str 64-bit types as string but not as variable length', () => {
        for (const type of ['int64bestr', 'int64lestr', 'uint64bestr', 'uint64lestr'] as RegisterEntryType[]) {
            assert.ok(stringRegisterTypes.includes(type), `${type} must be excluded from factor/offset scaling`);
            assert.ok(
                !variableLengthStringTypes.includes(type),
                `${type} has a fixed length of 4 registers and must not take a user-defined len`,
            );
        }
    });

    it('decodes every string type to a string', () => {
        const buf = Buffer.alloc(16);
        for (const type of stringRegisterTypes) {
            assert.strictEqual(typeof extractValue(type, 4, buf, 0), 'string', `${type} must decode to a string`);
        }
    });
});
