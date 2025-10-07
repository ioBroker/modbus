# @iobroker/modbus

This is a library that allows you to implement ioBroker Adapter that communicates via modbus with some device.

It could accept TSV file as a configuration.

## Usage

### With constant TSV file

```typescript
import ModbusTemplate, { tsv2registers } from '@iobroker/modbus';
import type { AdapterOptions } from '@iobroker/adapter-core';

export class ModbusAdapter extends ModbusTemplate {
    public constructor(options: Partial<AdapterOptions> = {}) {
        const holdingRegs = tsv2registers('holdingRegs', `${__dirname}/../data/holdingRegs.tsv`);

        super('modbus-solaredge', options, undefined, { holdingRegs });
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

### With dynamic TSV file

```typescript
import ModbusTemplate, { tsv2registers } from '@iobroker/modbus';
import type { AdapterOptions } from '@iobroker/adapter-core';

export class ModbusAdapter extends ModbusTemplate {
    public constructor(options: Partial<AdapterOptions> = {}) {
        super(
            'modbus-solaredge',
            options,
            {
                port: 520, // you can override all parameters here
            },
            'deviceType', // name of the attribute in config to read files from
            `${__dirname}/..`, // adapter diractory
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

In the second example the adapter will read from its configuration attribute `deviceType` the type of the device and tries to find file:

- `<adapterDirectory>/<valueOfDeviceType>` - holding registers
- or `<adapterDirectory>/<valueOfDeviceType without '.tsv'>inputRegs.tsv` - for input registers

If the value of `deviceType` is `data/holdingRegs.tsv` the adapter will search for file `<adapterDirectory>/data/holdingRegs.tsv`.

If the value of `deviceType` is `data/m100.tsv` the adapter will search for files `<adapterDirectory>/data/m100coils.tsv`, `<adapterDirectory>/data/m100disInputs.tsv`, `<adapterDirectory>/data/m100inputRegs.tsv`, `<adapterDirectory>/data/m100holdingRegs.tsv`

## Test

There are some programs in folder `test` to test the TCP communication:

- Ananas32/64 is a slave simulator (only holding registers and inputs, no coils and digital inputs)
- RMMS is master simulator
- mod_RSsim.exe is a slave simulator. It can be that you need [Microsoft Visual C++ 2008 SP1 Redistributable Package](https://www.microsoft.com/en-us/download/details.aspx?id=5582) to start it (because of Side-By-Side error).

<!--
	### **WORK IN PROGRESS**
-->

## Changelog

### **WORK IN PROGRESS**
- (@GermanBluefox) Added `removeUnderscorePrefix` parameter

### 7.0.5 (2025-10-06)

- (bluefox) initial commit

## License

The MIT License (MIT)

Copyright (c) 2015-2025 Bluefox <dogafox@gmail.com>

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
