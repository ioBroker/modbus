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

type Reg = { deviceId: number; _address?: number; address?: number; name: string; id?: string };

const DEFAULTS = {
    showAliases: false,
    doNotRoundAddressToWord: false,
    directAddresses: false,
    doNotIncludeAdrInId: false,
    removeUnderscorePrefix: false,
    preserveDotsInId: false,
    registerTypeInName: false as boolean | string,
    padAddressInId: true,
};

function assign(
    regs: Reg[],
    options: Partial<typeof DEFAULTS> & { multiDeviceId?: boolean } = {},
    regName = 'holdingRegisters',
    regType = 'holdingRegs',
    offset = 0,
    deviceId = 1,
): string[] {
    const adapter = Object.create(ModbusAdapter.prototype);
    adapter.assignIds(deviceId, regs, { offset }, regName, regType, { ...DEFAULTS, ...options });
    return regs.map(reg => reg.id as string);
}

const registers = (...addresses: number[]): Reg[] =>
    addresses.map(address => ({ deviceId: 1, _address: address, name: `R${address}` }));

describe('padAddressInId', () => {
    it('keeps the IDs unchanged when disabled', () => {
        assert.deepStrictEqual(assign(registers(0, 11, 268), { padAddressInId: false }), [
            'holdingRegisters.0_R0',
            'holdingRegisters.11_R11',
            'holdingRegisters.268_R268',
        ]);
    });

    it('pads the addresses to 5 digits, so the IDs sort numerically', () => {
        const ids = assign(registers(268, 5, 30001, 0, 11));
        assert.deepStrictEqual(ids, [
            'holdingRegisters.00268_R268',
            'holdingRegisters.00005_R5',
            'holdingRegisters.30001_R30001',
            'holdingRegisters.00000_R0',
            'holdingRegisters.00011_R11',
        ]);
        assert.deepStrictEqual([...ids].sort(), [
            'holdingRegisters.00000_R0',
            'holdingRegisters.00005_R5',
            'holdingRegisters.00011_R11',
            'holdingRegisters.00268_R268',
            'holdingRegisters.30001_R30001',
        ]);
    });

    it('does not change existing IDs when a longer address is added', () => {
        const [before] = assign(registers(11, 999));
        const [after] = assign(registers(11, 999, 1000));
        assert.strictEqual(after, before);
    });

    it('does not cut off an address with more than 5 digits', () => {
        assert.deepStrictEqual(assign(registers(100000)), ['holdingRegisters.100000_R100000']);
    });

    it('uses the same width for all register types sharing a channel', () => {
        const coil = assign([{ deviceId: 1, _address: 5, name: 'a' }], { registerTypeInName: 'data' }, 'coils', 'coils');
        const holding = assign([{ deviceId: 1, _address: 999, name: 'b' }], { registerTypeInName: 'data' });
        assert.deepStrictEqual([coil[0], holding[0]], ['data.00005_a', 'data.00999_b']);
    });

    it('works with preserveDotsInId', () => {
        const regs = [{ deviceId: 1, _address: 5, name: 'a.b' }];
        assert.deepStrictEqual(assign(regs, { preserveDotsInId: true }), ['holdingRegisters.00005_a.b']);
    });

    it('pads only the address of unnamed registers with doNotIncludeAdrInId', () => {
        const regs = [
            { deviceId: 1, _address: 5, name: 'named' },
            { deviceId: 1, _address: 6, name: '' },
        ];
        assert.deepStrictEqual(assign(regs, { doNotIncludeAdrInId: true }), [
            'holdingRegisters._named',
            'holdingRegisters.00006',
        ]);
    });

    it('works with multiDeviceId', () => {
        const regs = [{ deviceId: 7, _address: 5, name: 'a' }];
        assert.deepStrictEqual(assign(regs, { multiDeviceId: true }, undefined, undefined, 0, 7), [
            'holdingRegisters.7.00005_a',
        ]);
    });

    it('pads the coil aliases with showAliases', () => {
        // Bit 15 of the first word is alias 1, because the coil aliases are mirrored within a word
        const regs = [{ deviceId: 1, address: 15, name: 'c' }];
        assert.deepStrictEqual(assign(regs, { showAliases: true }, 'coils', 'coils', 1), ['coils.00001_c']);
    });

    it('does not change aliases that already have 5 digits', () => {
        const regs = [{ deviceId: 1, _address: 40011, name: 'h' }];
        assert.deepStrictEqual(assign(regs, { showAliases: true }, undefined, undefined, 40001), [
            'holdingRegisters.40011_h',
        ]);
    });
});

describe('forbidden characters in the name (modbus-templates issue #58)', () => {
    it('replaces them in the ID, so the object and the state have the same ID', () => {
        const regs: Reg[] = [
            { deviceId: 1, _address: 40620, name: 'Out-of-grid –total power' },
            { deviceId: 1, _address: 40587, name: 'Temperatur °C' },
        ];
        assert.deepStrictEqual(assign(regs, { padAddressInId: false }), [
            'holdingRegisters.40620_Out-of-grid__total_power',
            'holdingRegisters.40587_Temperatur__C',
        ]);
        // the name itself (shown as the name of the object) is not changed
        assert.strictEqual(regs[0].name, 'Out-of-grid –total power');
    });

    it('keeps umlauts and the allowed special characters', () => {
        const regs: Reg[] = [{ deviceId: 1, _address: 1, name: 'Größe (L1+L2)' }];
        assert.deepStrictEqual(assign(regs, { padAddressInId: false }), ['holdingRegisters.1_Größe_(L1+L2)']);
    });
});
