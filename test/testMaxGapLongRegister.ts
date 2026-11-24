/*
 * "Max address gap to combine" (maxGap) must split the read blocks also before a long register (string, len >= 10).
 * The gap was bridged then, so a block read registers that are not configured, and a device that does not have them
 * rejected the whole block ("Illegal data address", issues #502/#581 of ioBroker.modbus).
 */
import assert from 'node:assert';

// @iobroker/adapter-core needs a js-controller installation on load, so stub it just while loading the adapter class
const corePath = require.resolve('@iobroker/adapter-core');
const indexPath = require.resolve('../src/index');
require.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: class {}, EXIT_CODES: {} },
} as unknown as NodeJS.Module;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ModbusAdapter = require(indexPath).default;
delete require.cache[corePath];
delete require.cache[indexPath];

type Reg = { deviceId: number; address: number; type: string; len?: number; poll: boolean };

/** Blocks as [start, count] built for the given holding registers */
function blocks(regs: Reg[], maxGap: number): [number, number][] {
    const adapter = Object.create(ModbusAdapter.prototype);
    adapter.log = { debug: (): void => {}, error: (): void => {} };
    adapter.namespace = 'modbus.0';
    const result = { config: regs, blocks: [], addressLow: 0, addressHigh: 0, length: 0, offset: 0 };
    adapter.iterateAddresses(false, 1, result, 'holdingRegisters', 'holdingRegs', {
        showAliases: false,
        doNotRoundAddressToWord: false,
        directAddresses: false,
        doNotIncludeAdrInId: false,
        preserveDotsInId: false,
        maxBlock: 100,
        maxBoolBlock: 128,
        maxGap,
    });
    return result.blocks.map((b: { start: number; count: number }) => [b.start, b.count]);
}

const uint16 = (address: number): Reg => ({ deviceId: 1, address, type: 'uint16be', poll: true });
const string = (address: number, len: number): Reg => ({ deviceId: 1, address, type: 'string', len, poll: true });

describe('maxGap before long registers', () => {
    it('splits before a string after a gap larger than maxGap', () => {
        assert.deepStrictEqual(blocks([uint16(100), string(180, 10)], 10), [
            [100, 1],
            [180, 10],
        ]);
    });

    it('still combines a string after a gap within maxGap', () => {
        assert.deepStrictEqual(blocks([uint16(100), string(105, 10)], 10), [[100, 15]]);
    });

    it('splits short registers as before', () => {
        assert.deepStrictEqual(blocks([uint16(100), uint16(180)], 10), [
            [100, 1],
            [180, 1],
        ]);
    });
});
