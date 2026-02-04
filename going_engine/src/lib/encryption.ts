import crypto from 'crypto';
import { Address, EncryptedData } from '../interfaces';
import dotenv from 'dotenv';

dotenv.config();

const algorithm = 'aes-256-gcm';
const keyHex = process.env.ENCRYPTION_KEY;

if (!keyHex) {
    throw new Error('ENCRYPTION_KEY no está definida en el archivo .env');
}

const key = Buffer.from(keyHex, 'hex');

export function encryptObject(obj: Address): EncryptedData {
    const text = JSON.stringify(obj);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        iv: iv.toString('hex'),
        content: encrypted.toString('hex'),
        tag: authTag.toString('hex'),
    };
}

export function decryptObject(encryptedData: EncryptedData): Address {
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const tag = Buffer.from(encryptedData.tag, 'hex');
    const encryptedText = Buffer.from(encryptedData.content, 'hex');

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as Address;
}
