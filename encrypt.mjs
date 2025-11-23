import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // 256 Bit
const IV_LEN = 12; // GCM suggest 12 Byte

function generatePassword32() {
    // 32 Bytes = 256 Bit
    return randomBytes(32); // oder 'hex' für hexadezimale Darstellung
}

console.log(generatePassword32());

/**
 * Encrypts plainText with the given password.
 *
 * @param plainText {string}
 * @param password {string} 32 bytes password
 * @returns {string} Base64 encoded encrypted text
 */
export function encrypt(plainText, password) {
    const salt = randomBytes(16);
    const iv = randomBytes(IV_LEN);
    const key = scryptSync(password, salt, KEY_LEN);

    const cipher = createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Alles zusammenpacken: salt | iv | tag | ciphertext (Base64 für Speicherung/Transport)
    return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
}

if (process.argv.length === 3 || process.argv.length === 4) {
    let password = process.argv[3] || generatePassword32();
    if (password.length !== 32) {
        console.warn('Warning: It is recommended to use a 32 bytes long password for encryption!');
    } else {
        // Encrypt file with password
        // argv[1]: file name
        // argv[2]: password
        const text = readFileSync(process.argv[2], 'utf8');
        writeFileSync(`${process.argv[2]}.enc`, encrypt(text, password));
        if (typeof password !== 'string') {
            console.log(`Password encrypted: ${password.toString('base64')}`);
        }
    }
} else {
    console.log('Usage: node @iobroker/modbus/encrypt.mjs <file> <password>');
}
