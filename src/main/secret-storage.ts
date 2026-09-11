import { safeStorage } from 'electron';

export interface SecretStorage {
  available(): Promise<boolean>;
  decrypt(value: string): Promise<string>;
  encrypt(value: string): Promise<string>;
}

export class ElectronSecretStorage implements SecretStorage {
  async available(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }

  async encrypt(value: string): Promise<string> {
    const encrypted = await safeStorage.encryptStringAsync(value);
    return encrypted.toString('base64');
  }

  async decrypt(value: string): Promise<string> {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'));
    return decrypted.result;
  }
}
