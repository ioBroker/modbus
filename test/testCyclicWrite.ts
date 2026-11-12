/*
 * ioBroker.modbus issue #771: cyclic write (cw) of holding registers. A device like the Vestel EVC04 needs a
 * heartbeat register written every few seconds. The register may be polled or not ("Poll" off, "Cyclic write" on).
 *
 * `this.objects` is keyed by the full ID (`modbus.0.holdingRegisters.6000_Heartbeat`), the values read by the poll
 * (`ackObjects`) and `getStateAsync` use the ID without namespace. Mixing both made the cyclic write silently do
 * nothing.
 */
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { Master } from '../src/lib/Master';
import type { Options } from '../src/types';

const HOST = '127.0.0.1';
const noop = (): void => {
    /* silent logger */
};

/** Fake device: answers FC3 with the address as value, records FC6 writes as "address=value" */
function startDevice(): Promise<{ server: Server; port: number; writes: string[] }> {
    const writes: string[] = [];
    return new Promise(resolve => {
        const server = createServer((socket: Socket) => {
            let buf = Buffer.alloc(0);
            socket.on('error', noop);
            socket.on('data', d => {
                buf = Buffer.concat([buf, d]);
                while (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
                    const frame = buf.subarray(0, 6 + buf.readUInt16BE(4));
                    buf = buf.subarray(frame.length);
                    const fc = frame.readUInt8(7);
                    const address = frame.readUInt16BE(8);
                    let pdu: Buffer;
                    if (fc === 3) {
                        const quantity = frame.readUInt16BE(10);
                        pdu = Buffer.alloc(2 + quantity * 2);
                        pdu.writeUInt8(3, 0);
                        pdu.writeUInt8(quantity * 2, 1);
                        for (let i = 0; i < quantity; i++) {
                            pdu.writeUInt16BE(address + i, 2 + i * 2);
                        }
                    } else if (fc === 6) {
                        writes.push(`${address}=${frame.readUInt16BE(10)}`);
                        pdu = frame.subarray(7, 12);
                    } else {
                        pdu = Buffer.from([fc | 0x80, 1]);
                    }
                    const header = Buffer.alloc(7);
                    frame.copy(header, 0, 0, 4);
                    header.writeUInt16BE(pdu.length + 1, 4);
                    header.writeUInt8(frame.readUInt8(6), 6);
                    socket.write(Buffer.concat([header, pdu]));
                }
            });
        });
        server.listen(0, HOST, () => resolve({ server, port: (server.address() as { port: number }).port, writes }));
    });
}

function register(address: number, name: string, poll: boolean): Record<string, unknown> {
    const id = `holdingRegisters.${address}_${name}`;
    return {
        deviceId: 1,
        address,
        _address: address,
        len: 1,
        type: 'uint16be',
        id,
        fullId: `modbus.0.${id}`,
        factor: 1,
        offset: 0,
        poll,
        cw: true,
        formula: '',
    };
}

function makeOptions(port: number, maxBlock: number, states: Record<string, ioBroker.State>): {
    options: Options;
    adapter: ioBroker.Adapter;
    warnings: string[];
} {
    // 83: polled and cyclic, 6000: cyclic only (heartbeat)
    const polled = register(83, 'Setpoint', true);
    const heartbeat = register(6000, 'Heartbeat', false);
    const config = [polled, heartbeat];
    const objects: Record<string, unknown> = {};
    for (const reg of config) {
        // as in ModbusTemplate.initObjects: keyed by the full ID, `_id` without namespace
        objects[reg.fullId as string] = {
            _id: reg.id,
            type: 'state',
            common: {},
            native: { ...reg, regType: 'holdingRegs' },
        };
    }
    const empty = { deviceId: 1, blocks: [], config: [] };
    const warnings: string[] = [];
    const adapter = {
        namespace: 'modbus.0',
        common: { loglevel: 'info' },
        log: { level: 'info', debug: noop, silly: noop, info: noop, warn: (m: string) => warnings.push(m), error: noop },
        setTimeout: (cb: (...args: unknown[]) => void, ms: number, ...args: unknown[]): NodeJS.Timeout =>
            setTimeout(cb, ms, ...args),
        clearTimeout: (timer: NodeJS.Timeout): void => clearTimeout(timer),
        setState: noop,
        getStatesAsync: (): Promise<Record<string, ioBroker.State>> => Promise.resolve({}),
        delForeignObjectAsync: (): Promise<void> => Promise.resolve(),
        getStateAsync: (id: string): Promise<ioBroker.State | null> => Promise.resolve(states[id] || null),
        terminate: noop,
    } as unknown as ioBroker.Adapter;
    const options = {
        config: {
            type: 'tcp',
            tcp: { ip: HOST, port },
            timeout: 500,
            defaultDeviceId: 1,
            multiDeviceId: false,
            disableLogging: true,
            poll: 100,
            readInterval: 0,
            waitTime: 0,
            writeInterval: 0,
            round: 1,
            maxBlock,
            maxBoolBlock: 128,
            recon: 50,
            keepAliveInterval: 0,
            alwaysUpdate: false,
            enableSanitization: false,
        },
        devices: {
            1: {
                disInputs: empty,
                coils: empty,
                inputRegs: empty,
                holdingRegs: {
                    deviceId: 1,
                    blocks: [{ start: 83, count: 1, startIndex: 0, endIndex: 1 }],
                    config,
                    cyclicWrite: config.map(reg => reg.fullId),
                },
            },
        },
        objects,
    } as unknown as Options;
    return { options, adapter, warnings };
}

describe('cyclic write of holding registers (issue #771)', function () {
    this.timeout(10000);

    let server: Server | undefined;
    let master: Master | undefined;

    afterEach(done => {
        master?.close();
        master = undefined;
        if (server) {
            server.close(() => done());
            server = undefined;
        } else {
            done();
        }
    });

    for (const maxBlock of [100, 1]) {
        it(`writes polled and not polled registers every cycle (maxBlock ${maxBlock})`, async () => {
            const device = await startDevice();
            server = device.server;
            const heartbeat = { val: 1, ack: true } as ioBroker.State;
            const { options, adapter, warnings } = makeOptions(device.port, maxBlock, {
                'holdingRegisters.6000_Heartbeat': heartbeat,
            });
            master = new Master(options, adapter);
            master.start();

            await new Promise(resolve => setTimeout(resolve, 800));
            const count = (w: string): number => device.writes.filter(x => x === w).length;
            // the polled register writes back the value read from the device (83)
            assert.ok(count('83=83') >= 2, `polled register: ${JSON.stringify(device.writes)} ${JSON.stringify(warnings)}`);
            // the heartbeat writes the value of the ioBroker state
            assert.ok(count('6000=1') >= 2, `heartbeat: ${JSON.stringify(device.writes)} ${JSON.stringify(warnings)}`);
        });
    }
});
