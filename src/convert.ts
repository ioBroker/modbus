import type { Register, RegisterType } from './types';
import { tsv2json } from 'tsv-json';
import { readFileSync, existsSync } from 'node:fs';

type RegisterField = {
    name: string;
    type?: 'checkbox';
};

const coils: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'poll', type: 'checkbox' },
    { name: 'wp', type: 'checkbox' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const disInputs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const holdingRegs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'unit' },
    { name: 'type' },
    { name: 'len' },
    { name: 'factor' },
    { name: 'offset' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'poll', type: 'checkbox' },
    { name: 'wp', type: 'checkbox' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

const inputRegs: RegisterField[] = [
    { name: '_address' },
    { name: 'name' },
    { name: 'description' },
    { name: 'unit' },
    { name: 'type' },
    { name: 'len' },
    { name: 'factor' },
    { name: 'offset' },
    { name: 'formula' },
    { name: 'role' },
    { name: 'room' },
    { name: 'cw', type: 'checkbox' },
    { name: 'isScale', type: 'checkbox' },
];

export default function tsv2registers(type: RegisterType, fileNameOrText: string): Register[] {
    if (fileNameOrText.toLowerCase().endsWith('.tsv')) {
        if (existsSync(fileNameOrText)) {
            fileNameOrText = readFileSync(fileNameOrText).toString();
        } else {
            throw new Error(`File name ${fileNameOrText} not found`);
        }
    }
    let propsFields: RegisterField[] | undefined;

    if (type === 'coils') {
        propsFields = coils;
    } else if (type === 'inputRegs') {
        propsFields = inputRegs;
    } else if (type === 'holdingRegs') {
        propsFields = holdingRegs;
    } else if (type === 'disInputs') {
        propsFields = disInputs;
    }

    if (!propsFields) {
        throw new Error('Unknown register type');
    }

    const data: (string | boolean)[][] = tsv2json(
        fileNameOrText.endsWith('\n') ? fileNameOrText : `${fileNameOrText}\n`,
    );
    const fields = data.shift();
    if (fields) {
        for (const index in propsFields) {
            if (propsFields[index].name !== fields[index]) {
                throw new Error(`Unexpected field ${index} for ${fields[index]}`);
            }
        }
    }

    return data.map(itemValues => {
        const item: Register = {} as Register;
        for (const index in propsFields) {
            if (propsFields[index].type === 'checkbox') {
                itemValues[index] = itemValues[index] === 'true';
            }
            (item as unknown as Record<string, string | boolean | number>)[propsFields[index].name] = itemValues[index];
        }
        return item;
    });
}
