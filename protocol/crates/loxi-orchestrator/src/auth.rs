use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
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

impl KeyManager {
    pub fn new() -> Self {
        // Load key from Env — replace literal \n sequences with real newlines
        let priv_pem = env::var("RSA_PRIVATE_KEY").unwrap_or_else(|_| {
            panic!("🔥 FATAL: RSA_PRIVATE_KEY not set in .env! Run 'openssl genrsa...'");
        }).replace("\\n", "\n");

        let pub_pem = env::var("RSA_PUBLIC_KEY").unwrap_or_else(|_| {
            println!("⚠️ RSA_PUBLIC_KEY not set. Architects won't be able to verify.");
            "".to_string()
        }).replace("\\n", "\n");

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
}
