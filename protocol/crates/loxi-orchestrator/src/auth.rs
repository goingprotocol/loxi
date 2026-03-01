//! RS256 ticket signing and verification for lease assignments.
//!
//! When the orchestrator assigns a task to a worker it signs a JWT with the
//! worker's ID and the auction ID as claims. The logistics data plane calls
//! [`KeyManager::verify_ticket`] before handing over any problem payload,
//! ensuring only the worker that won the auction can fetch it.
//!
//! Keys are loaded from environment variables (`RSA_PRIVATE_KEY`,
//! `RSA_PUBLIC_KEY`) with literal `\n` sequences replaced by real newlines —
//! the format produced by storing a PEM in a `.env` file on one line.
//! If `RSA_PUBLIC_KEY` is absent, signing still works but verification will
//! always fail; a warning is printed at startup.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Serialize, Deserialize)]
pub struct TicketClaims {
    pub sub: String, // Worker ID
    pub aud: String, // Architect Address (or Auction ID)
    pub exp: usize,  // Expiration
    pub iat: usize,  // Issued At
    pub iss: String, // Issuer (Orchestrator)
}

pub struct KeyManager {
    pub encoding_key: EncodingKey,
    #[allow(dead_code)]
    pub public_key_pem: String, // To expose to Architects
}

impl Default for KeyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyManager {
    pub fn new() -> Self {
        // Load key from Env — replace literal \n sequences with real newlines
        let priv_pem = env::var("RSA_PRIVATE_KEY")
            .unwrap_or_else(|_| {
                panic!("🔥 FATAL: RSA_PRIVATE_KEY not set in .env! Run 'openssl genrsa...'");
            })
            .replace("\\n", "\n");

        let pub_pem = env::var("RSA_PUBLIC_KEY")
            .unwrap_or_else(|_| {
                println!("⚠️ RSA_PUBLIC_KEY not set. Architects won't be able to verify.");
                "".to_string()
            })
            .replace("\\n", "\n");

        if !pub_pem.is_empty() {
            println!("🔑 KeyManager: RSA Public Key ready.");
        }

        let encoding_key = EncodingKey::from_rsa_pem(priv_pem.as_bytes())
            .expect("❌ Failed to parse RSA Private Key");

        Self { encoding_key, public_key_pem: pub_pem }
    }

    pub fn sign_ticket(&self, worker_id: &str, auction_id: &str) -> String {
        let now = chrono::Utc::now();
        let expiration = now + chrono::Duration::hours(1); // 1 Hour Validity

        let claims = TicketClaims {
            sub: worker_id.to_string(),
            aud: auction_id.to_string(),
            exp: expiration.timestamp() as usize,
            iat: now.timestamp() as usize,
            iss: "loxi-orchestrator-v1".to_string(),
        };

        // RS256 is the standard for Asymmetric Signing
        encode(&Header::new(Algorithm::RS256), &claims, &self.encoding_key)
            .expect("Failed to sign ticket")
    }

    pub fn verify_ticket(&self, token: &str) -> Result<TicketClaims, String> {
        if self.public_key_pem.is_empty() {
            return Err("No public key configured".to_string());
        }
        let decoding_key =
            DecodingKey::from_rsa_pem(self.public_key_pem.as_bytes()).map_err(|e| e.to_string())?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false; // aud carries auction_id, not a fixed audience
        decode::<TicketClaims>(token, &decoding_key, &validation)
            .map(|d| d.claims)
            .map_err(|e| e.to_string())
    }
}
