import assert from 'node:assert';

// @iobroker/adapter-core needs a js-controller installation on load; stub it for this pure-logic test
const corePath = require.resolve('@iobroker/adapter-core');
require.cache[corePath] = {
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: class {}, EXIT_CODES: {} },
} as unknown as NodeJS.Module;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ModbusAdapter = require('../src/index').default;


type Reg = { deviceId: number; _address: number; address?: number; name: string; id?: string };

function ids(padAddressInId: boolean, regs: Reg[]): string[] {
    const adapter = Object.create(ModbusAdapter.prototype) as any;
    adapter.assignIds(1, regs, { offset: 0 }, 'holdingRegisters', 'holdingRegs', {
        showAliases: false,
        doNotRoundAddressToWord: false,
        directAddresses: false,
        doNotIncludeAdrInId: false,
        removeUnderscorePrefix: false,
        preserveDotsInId: false,
        registerTypeInName: false,
        padAddressInId,
    });
    return regs.map(r => r.id as string).sort();
}

const mk = (): Reg[] =>
    [5, 11, 119, 122, 268].map(a => ({ deviceId: 1, _address: a, name: `R${a}` }));

describe('padAddressInId', () => {
    it('keeps IDs unchanged when disabled', () => {
        assert.ok(ids(false, mk()).includes('holdingRegisters.11_R11'));
    });
    it('pads to the width of the highest address so IDs sort numerically', () => {
        assert.deepStrictEqual(ids(true, mk()), [
            'holdingRegisters.005_R5',
            'holdingRegisters.011_R11',
            'holdingRegisters.119_R119',
            'holdingRegisters.122_R122',
            'holdingRegisters.268_R268',
        ]);
    });
    it('uses 5 digits for high addresses', () => {
        const regs = [5, 30001].map(a => ({ deviceId: 1, _address: a, name: 'x' }));
        assert.deepStrictEqual(ids(true, regs), ['holdingRegisters.00005_x', 'holdingRegisters.30001_x']);
    });
});
