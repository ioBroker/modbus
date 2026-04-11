# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@iobroker/modbus` is a library for building ioBroker adapters that communicate via Modbus protocol. It is **not** a standalone adapter — consumers extend the `ModbusAdapter` class and provide register definitions (via code or TSV files). Reference implementation: [ioBroker.modbus-solaredge](https://github.com/ioBroker/ioBroker.modbus-solaredge).

## Commands

- **Build:** `npm run build` (runs `tsc -p tsconfig.build.json && node tasks` — the tasks script copies `src/types.d.ts` to `build/`)
- **Lint:** `npm run lint` (ESLint with `@iobroker/eslint-config`, Prettier with `@iobroker/eslint-config/prettier.config.mjs`)
- **Release:** `npm run release-patch`, `npm run release-minor`, `npm run release-major` (uses `@alcalzone/release-script`)

There are no unit tests in this library. CI runs lint only. Integration testing is expected at the adapter level.

## Architecture

### Entry Point & Exports (`src/index.ts`)

Exports `ModbusAdapter` (default), `tsv2registers`, and the `Modbus` type namespace. `ModbusAdapter` extends `@iobroker/adapter-core`'s `Adapter` class.

Constructor accepts: adapter name, adapter options, and an options object containing `params` (connection overrides), register arrays (`disInputs`, `coils`, `inputRegs`, `holdingRegs`), or `parameterNameForFile` + `adapterRootDirectory` for dynamic TSV loading.

Configuration merging order: `defaultParams` (hardcoded in index.ts) → `options.params` → `config.params` (from ioBroker instance config).

### Master/Slave Pattern

- **`src/lib/Master.ts`** — Modbus client. Polls remote devices, handles reconnection, read/write of coils and registers with configurable block sizes, scale factors, and pulse timing.
- **`src/lib/Slave.ts`** — Modbus server. Accepts incoming connections, serves register values from memory, syncs with ioBroker states.

The adapter instantiates either Master or Slave based on `config.params.slave`.

### Transport Layer (`src/lib/modbus/`)

- `modbus-client-core.ts` / `modbus-server-core.ts` — Protocol-level Modbus function codes
- `transports/` — TCP, TCP-RTU, TCP-SSL, Serial client/server implementations

Serial transport requires the consumer adapter to include `serialport` as its own dependency.

### Register Handling

- **`src/convert.ts`** — `tsv2registers()` parses TSV files (optionally AES-256-GCM encrypted) into register arrays. Four register types: `coils`, `disInputs`, `inputRegs`, `holdingRegs`.
- **`src/lib/common.ts`** — `extractValue()` / `writeValue()` handle reading from and writing to buffers across 16+ data type variants (uint8/16/32/64, int8/16/32/64, float, double — each with be/le/sw/sb endianness).
- **`src/types.d.ts`** — All TypeScript types for registers, device options, and config. Manually copied to `build/` by `tasks.js` since it's a `.d.ts` file.

### Utilities

- `src/lib/Put.ts` — Buffer builder for constructing binary payloads
- `src/lib/crc16modbus.ts` — CRC16 checksum for Modbus frames
- `src/lib/loggingUtils.ts` — Wrapper that suppresses connection error logging when `disableLogging` is true

## TypeScript Configuration

- Target: ES2022, Module: Node16, strict mode enabled
- Build uses `tsconfig.build.json` (extends `tsconfig.json`, enables declaration emit)
- Types sourced from `@iobroker/types`
