// ARCHIVED / DEAD TEST — moved out of ioBroker.modbus.
//
// This test was written when the jsmodbus implementation lived inside the adapter
// repo under `../lib/jsmodbus/...`. That code now lives in THIS repository under
// `src/lib/modbus/...` (e.g. src/lib/modbus/transports/modbus-server-serial.ts),
// so the require() paths below no longer resolve. It is kept here for reference and
// is intentionally excluded from the mocha run (see ../.mocharc.json spec/extension).
//
// To revive it, rewrite it as a TypeScript test importing from
// `../../src/lib/modbus/transports/modbus-server-serial` and the modbus server core.
const assert = require('node:assert');
const path = require('node:path');

// Test that serial transport can be loaded
describe('Test serial slave transport', function () {
    it('Serial transport should be loadable', function () {
        // Test that the transport file exists and can be required
        const transportPath = path.join(__dirname, '../lib/jsmodbus/transports/modbus-server-serial.js');
        assert.doesNotThrow(() => {
            require(transportPath);
        });
    });

    it('Jsmodbus should support serial server transport', function () {
        const Modbus = require('../lib/jsmodbus/index.js');

        // Test that the jsmodbus library can load the serial server transport
        assert.doesNotThrow(() => {
            Modbus('server', 'serial');
        });
    });

    it('Serial transport should have required methods', function () {
        const SerialTransport = require('../lib/jsmodbus/transports/modbus-server-serial.js');

        // Test that the transport has the required structure
        assert.strictEqual(typeof SerialTransport, 'function');

        // Test that the transport has the stampit structure
        assert.strictEqual(typeof SerialTransport.compose, 'function');
        assert.strictEqual(typeof SerialTransport.init, 'function');
    });
});
