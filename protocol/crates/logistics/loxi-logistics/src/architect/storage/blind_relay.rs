use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Result};
use rand::RngCore;

pub struct BlindStorageRelay {
    key: [u8; 32],
}

impl BlindStorageRelay {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// Cifra un shard binario usando AES-256-GCM.
    /// Retorna (datos_cifrados, nonce).
    pub fn encrypt_shard(&self, clear_data: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let cipher = Aes256Gcm::new(&self.key.into());
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext =
            cipher.encrypt(nonce, clear_data).map_err(|e| anyhow!("Encryption failed: {}", e))?;

        Ok((ciphertext, nonce_bytes.to_vec()))
    }

    /// Descifra un shard binario.
    pub fn decrypt_shard(&self, encrypted_data: &[u8], nonce_bytes: &[u8]) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new(&self.key.into());
        let nonce = Nonce::from_slice(nonce_bytes);

        let clear_data = cipher
            .decrypt(nonce, encrypted_data)
            .map_err(|e| anyhow!("Decryption failed: {}", e))?;

        Ok(clear_data)
    }
}
