# @iobroker/modbus

This is a library that allows you to implement ioBroker Adapter that communicates via ModBus with devices.

It could accept a TSV file as a configuration. TSV files could be created as export in `ioBroker.modbus` adapter.

## Usage

You can find an example [here](https://github.com/ioBroker/ioBroker.modbus-solaredge).

### With constant TSV file (TypeScript)

```typescript
import ModbusTemplate, { tsv2registers } from '@iobroker/modbus';
import type { AdapterOptions } from '@iobroker/adapter-core';
import { readFileSync } from 'node:fs';
const adapterName = JSON.parse(readFileSync(`${__dirname}/../io-package.json`, 'utf8')).common.name;

export class ModbusAdapter extends ModbusTemplate {
    public constructor(adapterOptions: Partial<AdapterOptions> = {}) {
        const holdingRegs = tsv2registers('holdingRegs', `${__dirname}/../data/holdingRegs.tsv`);

        super(
            adapterName,
            adapterOptions,
            {
                params: {
                    // Do not show addresses in the object IDs
                    doNotIncludeAdrInId: true,
                        // Remove the leading "_" in the names
                        removeUnderscorePrefix: true,
                    // Do not show aliases, because we don't want to see addresses
                    showAliases: false,
                    // Replace holdingRegister (and so on) with "data" in the object names
                    registerTypeInName: 'data',
                },
                holdingRegs,
            },
        );
    }
}

// If started as allInOne mode => return function to create instance
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new ModbusAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new ModbusAdapter())();
}
```

### With constant TSV file (JavaScript)

```javascript
const IoBrokerModbus = require ('@iobroker/modbus');
const { readFileSync } = require('node:fs');
const adapterName = JSON.parse(readFileSync(`${__dirname}/../io-package.json`, 'utf8')).common.name;

export class ModbusAdapter extends ModbusTemplate {
    public constructor(options) {
        const holdingRegs = tsv2registers('holdingRegs', `${__dirname}/../data/holdingRegs.tsv`);

        super(adapterName, options, { holdingRegs });
    }
}

// If started as allInOne mode => return function to create instance
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = options => new ModbusAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new ModbusAdapter())();
}
```

### With a dynamic TSV file

```typescript
import ModbusTemplate, { tsv2registers } from '@iobroker/modbus';
import type { AdapterOptions } from '@iobroker/adapter-core';
import { readFileSync } from 'node:fs';
const adapterName = JSON.parse(readFileSync(`${__dirname}/../io-package.json`, 'utf8')).common.name;

export class ModbusAdapter extends ModbusTemplate {
    public constructor(options: Partial<AdapterOptions> = {}) {
        super(
            adapterName,
            options,
            {
                params: {
                    port: 520, // you can override all parameters here
                },
                parameterNameForFile: 'deviceType', // name of the attribute in config to read files from
                adapterRootDirectory: `${__dirname}/..`, // adapter diractory
            }
        );
    }
}

// If started as allInOne mode => return function to create instance
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new ModbusAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new ModbusAdapter())();
}
```

In the second example the adapter will read from its configuration attribute `deviceType` the type of the device and tries to find a file:

- `<adapterDirectory>/<valueOfDeviceType>` - holding registers
- or `<adapterDirectory>/<valueOfDeviceType without '.tsv'>inputRegs.tsv` - for input registers

If the value of `deviceType` is `data/holdingRegs.tsv` or `data/holdingRegs` the adapter will search for file `<adapterDirectory>/data/holdingRegs.tsv`.

If the value of `deviceType` is `data/m100.tsv` or `data/m100` the adapter will search for files `<adapterDirectory>/data/m100coils.tsv`, `<adapterDirectory>/data/m100disInputs.tsv`, `<adapterDirectory>/data/m100inputRegs.tsv`, `<adapterDirectory>/data/m100holdingRegs.tsv`

## Serial port

If you want to use serial port, you have to include `serialport` package into 'package.json' of your adapter, because `@iobroker/modbus` does not have this dependency by default.

## Test

There are some programs in folder `test` to test the TCP communication:

- Ananas32/64 is a slave simulator (only holding registers and inputs, no coils and digital inputs)
- RMMS is a master simulator
- mod_RSsim.exe is a slave simulator. It can be that you need [Microsoft Visual C++ 2008 SP1 Redistributable Package](https://www.microsoft.com/en-us/download/details.aspx?id=5582) to start it (because of a Side-By-Side error).

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- (@GermanBluefox) Added Modbus/UDP master support (issue #222): a new `'udp'` connection type served by a UDP datagram transport that reuses the Modbus/TCP MBAP framing (one datagram per request/response)

### 7.5.3 (2026-07-03)
- (@GermanBluefox) Fixed a log flood when a device answers a combined read block with fewer registers than requested (issue #502): the short response is now reported with a single clear warning and the registers that were actually returned are still stored, instead of throwing `The value of "offset" is out of range` once per register

### 7.5.2 (2026-07-03)
- (@GermanBluefox) Added a configurable address-gap tolerance for read blocks (issue #581): the new `maxGap` parameter controls how large an address gap may be bridged when combining registers into one read request; set it to 0 to read only contiguous configured registers, so devices that reject non-existent addresses in a gap no longer fail the whole block

### 7.5.1 (2026-07-03)
- (@GermanBluefox) Added per-device timeout and wait time (issue #605): a master with `multiDeviceId` can define an individual request timeout and inter-request wait time per Modbus device/unit ID (`deviceTimeouts`), overriding the global values for slow devices
- (@GermanBluefox) Fixed the TCP/SSL master not recovering after a communication loss (issue #594): the receive buffer is now cleared and the socket recreated on every reconnect, so a frame that was cut off by the disconnect can no longer desync the parser and permanently break polling. SSL reconnect (which never recreated its socket) now works at all
- (@GermanBluefox) Fixed cyclic write of non-polled holding registers in immediate-write mode (`maxBlock < 2`): CW-only registers are now written every poll cycle instead of being silently skipped (follow-up to issue #771)

### 7.5.0 (2026-07-02)
- (@GermanBluefox) Added a proxy mode (issue #775): a master instance can additionally serve its polled data as a Modbus TCP slave and forward client writes back to the device (`proxy`/`proxyBind`/`proxyPort`)

### 7.4.2 (2026-07-02)
- (@GermanBluefox) Fixed `Put.floatle()` to write a valid IEEE-754 little-endian float and to stop dropping data written after it
- (@GermanBluefox) Added unit tests for the Modbus packet builder (`Put`) and the CRC-16/MODBUS checksum

### 7.4.1 (2026-07-01)
- (@johannes-lode) Fixed FC1 coil reads returning stale data: the slave now refreshes the coil buffer before responding (event name matched the listener)
- (@johannes-lode) Fixed the TCP slave crashing on server listen errors (e.g. address already in use or privileged port without permission); such errors are now logged instead
- (@johannes-lode) Fixed coil/discrete-input reads being written to the wrong buffer bit for start addresses other than 0
- (@johannes-lode) Fixed the coil/discrete-input buffer size when the highest address is a multiple of 8 (`ceil(addressHigh / 8)`)

### 7.4.0 (2026-06-27)
- (@GermanBluefox) Allowed distinguishing two identical USB chips (same vendor/product, no serial number) by their physical USB port: device IDs now fall back to `/dev/serial/by-path` on Linux and to the pnpId/location elsewhere, and the dropdown label shows that location. Legacy `vendor:product:serial` IDs keep working.

### 7.3.0 (2026-05-29)
- (@GermanBluefox) Added selection of the serial device by its stable USB ID (vendor/product/serial) via the new `listUartDevices` message and `selectBy`/`comDeviceId` parameters

### 7.2.6 (2026-04-13)
- (@GermanBluefox) Corrected room definition for the first register

### 7.2.5 (2026-04-13)
- (@GermanBluefox) Added "ttyADM***" to the list of possible serial ports
- (@GermanBluefox) Write cyclic values even if they are not polled

### 7.2.1 (2026-04-12)
- (@GermanBluefox) Corrected potential errors
- (@GermanBluefox) Added sanity check for the configuration

### 7.0.25 (2026-02-16)
- (@GermanBluefox) Disable logging of request timeout if `disableLogging` parameter is set to true

### 7.0.24 (2026-02-15)
- (@GermanBluefox) Corrected the reading of registers
- (@GermanBluefox) Corrected the type of `info.connection`

### 7.0.23 (2025-12-02)
- (@GermanBluefox) Corrected parsing of TSV files

### 7.0.22 (2025-11-23)

- (@GermanBluefox) Updated packages

### 7.0.20 (2025-10-08)

- (@GermanBluefox) Corrected serial communication

### 7.0.19 (2025-10-08)

- (@GermanBluefox) Added `onBeforeReady` method to do something before adapter starts

### 7.0.17 (2025-10-07)

- (@GermanBluefox) Added `host` parameter for master connection

### 7.0.13 (2025-10-07)

- (@GermanBluefox) Added `removeUnderscorePrefix` parameter
- (@GermanBluefox) Added `noRegisterTypeInName` parameter
- (@GermanBluefox) Allowed to set a custom channel name

### 7.0.5 (2025-10-06)

- (bluefox) initial commit

## License

The MIT License (MIT)

Copyright (c) 2015-2026 Bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
