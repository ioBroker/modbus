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

## Signed int8 in 16-bit registers

A Modbus register is 16 bits wide, so an 8-bit value occupies one register and one byte stays unused. Which byte carries the value depends on the endianness suffix:

| Type suffix  | Value byte                     | Unused (pad) byte  |
|--------------|--------------------------------|--------------------|
| `…8be`       | low byte (register bits 7:0)   | high byte          |
| `…8le`       | high byte (register bits 15:8) | low byte           |

> Note: the naming is counter-intuitive — `be` puts the 8 bits into the **lower** half of the register, `le` into the **upper** half.

For the signed types `int8be`/`int8le` the pad byte is set to `0x00` (zero extension). Reading the value back through this library is always correct (it reads only the value byte via `readInt8`). The difference is only visible to a **foreign master** that reads the whole register as int16:

- `int8be` `-5` → bytes `00 FB` → int16 = **+251** (the sign is lost unless the master reads just the low byte as int8).

If you need a foreign master to read the value correctly as int16, use the sign-extended variants:

- `signExtendedInt8be` `-5` → bytes `FF FB` → **big-endian** int16 = `-5`
- `signExtendedInt8le` `-5` → bytes `FB FF` → **little-endian** int16 = `-5`

They sign-extend the value into the pad byte instead of zeroing it. Reading through the library still returns the signed value (it reads only the value byte, which is robust against counterparts that leave garbage in the pad byte).

**Out-of-range values differ between the two families.** `int8be`/`int8le` mask the value to 8 bits (a value outside −128…127 wraps silently). The `signExtended…` types instead **reject** an out-of-range value: they emit the standard `Can not write value …` warning and leave the register unchanged — consistent with the other numeric register types.

To convert an existing TSV from the zero-padded to the sign-extended types (know your tools):

```bash
sed -i -E 's/\tint8be\t/\tsignExtendedInt8be\t/g; s/\tint8le\t/\tsignExtendedInt8le\t/g' holdingRegs.tsv
```

(The surrounding tabs anchor the match to the whole `type` column, so `uint8be` is not touched.) Keep the out-of-range difference above in mind: after the conversion, values outside −128…127 are no longer wrapped but warned about and dropped.

## Exact 64-bit values

A JavaScript number is a double: it represents integers exactly only up to 2^53. The numeric types `int64be`/`int64le`/`uint64be`/`uint64le` therefore silently round anything larger — an energy counter or a device serial number can come out wrong in the last digits.

If you need the full 64-bit range, use the string variants `int64bestr`/`int64lestr`/`uint64bestr`/`uint64lestr`. They occupy the same 4 registers and the same byte order, but the state is a `string` holding the exact decimal value:

| Type          | State value for bytes `FF FF FF FF FF FF FF FF`   |
|---------------|---------------------------------------------------|
| `uint64be`    | `18446744073709552000` (rounded)                  |
| `uint64bestr` | `"18446744073709551615"` (exact)                  |

Like the other string types they are **not** scaled: `factor`, `offset` and `round` are ignored. A value that is not a valid integer string is rejected with the standard `Can not write value …` warning and leaves the register unchanged.

## Read notifications (slave mode)

In slave mode the adapter is the server, so a read by the connected master is normally invisible — only writes reach the adapter. The read notifications make it visible: for every mapped register a counter state is created in a parallel tree under `readNotify.`, and it is incremented whenever a master reads that register.

```
modbus.0.holdingRegisters.40001_Temperature            ← the value
modbus.0.readNotify.holdingRegisters.40001_Temperature ← how often it was read
```

Configured per register type:

| Parameter | Effect |
|-----------|--------|
| `notifyOnReadCoils`       | notifications for coils (FC1) |
| `notifyOnReadDisInputs`   | notifications for discrete inputs (FC2) |
| `notifyOnReadInputRegs`   | notifications for input registers (FC4) |
| `notifyOnReadHoldingRegs` | notifications for holding registers (FC3) |
| `notifyOnReadExpire`      | seconds after which a notification state expires (`0` = never) |

Notes:

- The states are written with `ack: true`, so they never re-enter the adapter's own `stateChange` handler.
- With `notifyOnReadExpire` a state disappears if the register is not read for that many seconds. That turns the counter into a watchdog on the master: *state present = the master is still polling*.
- The counter lives in memory and restarts at 1 after an adapter restart. `info.adapterStarts` counts the restarts, so a script can tell that reset from an anomaly.
- Every read produces one state write **per covered register**. With a fast master and many mapped registers this is a noticeable amount of state traffic — enable the notifications only for the register types you actually evaluate.
- Switching a flag off removes the corresponding part of the `readNotify` tree on the next adapter start.

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
### 7.7.3 (2026-09-20)
- (@GermanBluefox) A failed request now names itself in the log (ioBroker.modbus issue #811). A device that did not answer produced `Error: undefined` / `Request timed out.` / `Cannot write value 80: Error: timeout` - neither the register, nor the function code, nor the device ID, nor the expired timeout was visible anywhere
- (@GermanBluefox) The timeout message is now `Request timed out after 5000 ms: FC16 write multiple registers, address 6609, quantity 1, unit 1`, and the `trashCurrentRequest` event carries that description instead of being emitted without a payload
- (@GermanBluefox) Every function code rejected its promise with `new Error(err.message)`, which threw the exception code, the timeout and the request away. The rejection now reads `timeout after 5000 ms - FC6 write single register, address 6609, value 0x0050, unit 7` or `ILLEGAL DATA ADDRESS - exception 0x02 - FC3 read holding registers, ...`, so the adapter log shows what failed
- (@GermanBluefox) The write error of the master names the state, the device ID, the register type and the address; the socket and poll errors no longer print `{}`, which is what `JSON.stringify` returns for an `Error`
- (@GermanBluefox) `Client in error state` names the endpoint of the connection
- (@GermanBluefox) Added tests for the request description, the error formatting and the diagnostics of a timeout and an exception response

### 7.7.2 (2026-09-20)
- (@GermanBluefox) Fixed the proxy/slave server ignoring the Modbus unit ID of a request (ioBroker.modbus issue #813): the built-in server served the register buffers of the FIRST device only, so with "Multi device IDs" every unit ID answered with the data of that device. Identical devices share their register map, so the polled values of all device IDs overwrote each other and a client write for unit 2 was applied to the state of device 1
- (@GermanBluefox) The server now keeps one register space per device ID and routes every request by its unit ID. A single configured device still answers every unit ID, because many Modbus TCP clients send 0 or 255; with several devices 0 and 255 address the default device ID and an unknown unit ID is answered with exception 0x0B (gateway target device failed to respond) instead of foreign data
- (@GermanBluefox) The RTU slave answers all configured device IDs, not only the default one
- (@GermanBluefox) Added regression tests for the unit ID routing of reads, writes and unknown units

### 7.7.1 (2026-08-27)
- (@nobl) Fixed stale and overlapping polling cycles after a reconnect (ioBroker.modbus issue #595): a block read error was logged and swallowed, so the polling loop kept running after the request timeout had already trashed the socket and cleared the request FIFO. The next register request was queued after that cleanup and was therefore sent on the reconnected socket, before the fresh cycle started by the `connect` handler — two polling cycles then ran in parallel. A pending reconnect, a lost connection or a stopping master now aborts the remaining blocks, register types and device IDs of the running cycle
- (@GermanBluefox) Limited that abort to connection failures: a plain Modbus exception response (illegal data address, illegal function, device busy) leaves the socket intact, so the remaining blocks of that register type are read as before. Otherwise a single register the device rejects would have permanently hidden every block behind it, because the block order is fixed
- (@GermanBluefox) Fixed a second source of stale requests: the block loops only checked `connected`, which is still `true` while a reconnect is pending. A connection that died during the wait between two blocks therefore queued the next request into the already cleared FIFO
- (@GermanBluefox) A pending reconnect timer is now cancelled when the client reports `connect`, so the timer of the deliberately dropped socket cannot tear the fresh connection down again
- (@GermanBluefox) Added a regression test for the polling of the remaining blocks after a device rejects one of them with an exception response

### 7.7.0 (2026-08-14)
- (@johannes-lode) **Changed values for 64-bit registers:** fixed the encoding and decoding of `int64be`/`int64le`/`uint64be`/`uint64le`. Writing built the high word with `value >> 32`, but JavaScript masks the shift count modulo 32, so both 32-bit words received the low word (12000 was written as `00002ee000002ee0` and read back as 51539607564000) and every negative value or value `>= 2^31` threw a `RangeError`, leaving the register unwritten. Decoding negatives used `high * 2^32 - low`, which is not two's complement. Both directions now go through `readBigInt64…`/`writeBigInt64…`. Setups that use a 64-bit register with negative values or a non-zero high word will read different — now correct — values after the update
- (@johannes-lode) Added the register types `int64bestr`/`int64lestr`/`uint64bestr`/`uint64lestr`, which carry the exact 64-bit value as a decimal string and keep the precision that a JavaScript number loses above 2^53. They occupy 4 registers like their numeric counterparts and are not scaled with factor/offset (see "Exact 64-bit values")
- (@johannes-lode) Fixed writing negative values to `int8be`/`int8le` registers: the codec masked the value to 0…255 and then called `writeInt8`, which rejects that range and threw a `RangeError` (caught by the slave, so the register was silently left unwritten). Negative int8 values are now written correctly
- (@johannes-lode) Added the register types `signExtendedInt8be`/`signExtendedInt8le`, which sign-extend a signed int8 into the full 16-bit register so a foreign master that reads it as int16 gets the signed value directly (see "Signed int8 in 16-bit registers")
- (@johannes-lode) Fixed the slave write-back of a single register (FC6): the internal value array is byte-indexed, but the register index was used unscaled, so a client write to register N overwrote the bytes of register N/2 — the written register kept its old value and a neighbouring one was corrupted. Both only became visible once the served buffer was refreshed from the internal array
- (@johannes-lode) Fixed the slave write-back of multiple registers (FC16): the source bytes were taken from the start of the written block instead of each register's own position, so every mapped register of a multi-register write received a copy of the first register's bytes
- (@johannes-lode) Removed the artificial 100 ms `responseDelay` of the TCP slave server: it was applied per request and, together with the shared request queue, serialized all connections to roughly 10 requests per second in total, which caused head-of-line blocking and master timeouts as soon as more than one master polled. The serial slave keeps its delay (it needs the line turnaround)
- (@johannes-lode) Fixed the list of connected clients in slave mode: `socket.address()` returns the LOCAL address of an accepted socket, so `info.connection` reported the server's own bind address instead of the connected masters — the peer address is now used and duplicates are removed. Sockets are also removed on `close` instead of `end`, so a connection that dies without a clean FIN (RST, cable or VPN drop) no longer stays in the list forever, and the list no longer contains the client that is currently disconnecting
- (@johannes-lode) Added read notifications for slave mode (`notifyOnReadCoils`, `notifyOnReadDisInputs`, `notifyOnReadInputRegs`, `notifyOnReadHoldingRegs`, `notifyOnReadExpire`): a counter state under `readNotify.<register id>` is incremented whenever a master reads that register, so an adapter can react to read access — watchdog on the master, access analysis, read-triggered logic. With `notifyOnReadExpire` the states expire after N seconds without a read. The counter is held in memory and restarts at 1 after an adapter restart (see "Read notifications")
- (@johannes-lode) Added `info.adapterStarts` in slave mode: a counter incremented on every adapter start, so a script can distinguish the in-memory reset of the read-notification counters from an anomaly
- (@GermanBluefox) Added the missing `signExtendedInt8be`/`signExtendedInt8le` entries to the register length table (one register each)
- (@GermanBluefox) Added tests for the register codec (64-bit, the `…str` types and signed int8) and a loopback test for the slave write-back and read-notification paths

### 7.6.0 (2026-07-03)
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
