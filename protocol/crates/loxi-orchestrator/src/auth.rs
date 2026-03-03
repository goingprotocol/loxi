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

    #[cfg(test)]
    pub fn from_pem(priv_pem: &str, pub_pem: &str) -> Self {
        let encoding_key = EncodingKey::from_rsa_pem(priv_pem.as_bytes())
            .expect("test: bad private key PEM");
        Self { encoding_key, public_key_pem: pub_pem.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal 2048-bit RSA keypair generated for tests only — never used in production.
    const TEST_PRIV_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCJKO6IxN1AC4m3
BeGQyFSSBIcU3NAUXw6s7iYdn7iZPFMI57oTgajYV1jiC9EiUrwyfr/KdeAtOGa6
TSMuX6Z/IqHbheuGXANo+67Vx7PkzGdCsFcPPAWFuxweBSlfmJcTZ91PTdJubjuk
VWzrxbtoop9G/absjGC1INRcy/vdkWBrr2zzBGuwA6VXMhmnUaSRdn7E+3pQAsBT
2J2vq8vuw76oiPnWkhRyw5crXGAvaUcRf6kZIJ2pKGm0ZGvkAsH/lJqdXdNDjfF+
MA4efpD5UhWCWtnVDx49Zmyosu3FdBX17grCtajTGMAKLkAOe/QDmyyTp19Ypya2
ShE+Jz/VAgMBAAECggEADFFsgMR7YVPX8aO50wymyblV31oIZvf1g7Lcofb093Ab
Pfa/t55CqXFIxn5MsTIwfDF1bIujDzScRzmDwhethof39NTlZtrvJHfMBx+JCLCR
yoO3QeNAVLcN6qVIhrEXylKe5c8lqazFNvhEELWgo+BNAS1pFx/xVHsHD3FzZH3W
96/Vug1C8gdr0nTeF2IAnkpmSujSAbgEXetKt9DpBg7X5BpkPLj+zLjAdstL9p6N
cnei7yDOZ+YRAG8SFJAKbbLqB4qAn2QRdFJ3edGPWVc/GrjSQORaZgc0NFH7eWwP
05hF9jNkb01DJwZsxAl/+X29j2Qf4+3VzXRohyQyQQKBgQDBpkMG5Hr5cCO+GZmS
x5MuP4QTvvViSbM+qVT8J/Oc3cH2seRhN9YMExjARBbdxCHwFClKTad2YgG13mYv
20DWY85YDed+fruzubCoScAvtjaDw+29mwz/8eWziBMLTOPxif03jOKFhFJMGkcd
IOiTpnG4urag2J3byd100VocwQKBgQC1UnbUj3pdU6NSRqU24wunmRI4VqtVpPI9
J04SaprdSVxAr5ImgZrE3v8R8hntYGpGMFellQShEMimLbKH8t/SzlVOAysIzH1j
tfO5Bjp5cxmi3EceWTujeHYRUrj36D7W6vaTJLdDPwsRa2oCwRzD71mIrP3eCt9+
sQtpXufkFQKBgQCiQGtCmCeNXe8ktZBeUke4ZVGFtecl/jhoFTr2t4a/dXKx/2Uq
K711in6fga1jDJWe8VWTQzM/1mg2eOxHxr4xo5hdYPEIpKkiskAZEQotL8/HYV+O
ER64SHa8kRPb0QXf+E0owSt+0VqfFxlkh5E3PStlq1Ofuz+wyxd5bHvDQQKBgHEb
JLcJXSo0Tw+2s76eOJnuWTg9kBkXkGfnScMhLsNUzLApFQDiHdoqxG+8VsIFP6XS
6AmJAF88af2HSfOV5FrKjNniDgkqDhmR2ZuUMAusadR2lgJvZU1eij/aGznBbNmB
rhgxcgQHom7WU0WukrQCbRZd2uqUW7/azqSHKB3VAoGANgZ9qgTgGOMy6ZBDYHHH
JBwlYhYpsdnhI5Fu8JdY3VCHMRukkG2x5qlAruR4xdYBOCXH6oLL2gZVqv6f5TEj
GlLZzeXEBxcKQT5NtC/JS1EoqVJKpj+iVXH6Kt+lLJzqBb246wzq20lW8VIyf+K/
hlJgIofy3pjrUmnIWpjKoaE=
-----END PRIVATE KEY-----";

    const TEST_PUB_PEM: &str = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiSjuiMTdQAuJtwXhkMhU
kgSHFNzQFF8OrO4mHZ+4mTxTCOe6E4Go2FdY4gvRIlK8Mn6/ynXgLThmuk0jLl+m
fyKh24XrhlwDaPuu1cez5MxnQrBXDzwFhbscHgUpX5iXE2fdT03Sbm47pFVs68W7
aKKfRv2m7IxgtSDUXMv73ZFga69s8wRrsAOlVzIZp1GkkXZ+xPt6UALAU9idr6vL
7sO+qIj51pIUcsOXK1xgL2lHEX+pGSCdqShptGRr5ALB/5SanV3TQ43xfjAOHn6Q
+VIVglrZ1Q8ePWZsqLLtxXQV9e4KwrWo0xjACi5ADnv0A5ssk6dfWKcmtkoRPic/
1QIDAQAB
-----END PUBLIC KEY-----";

    fn km() -> KeyManager {
        KeyManager::from_pem(TEST_PRIV_PEM, TEST_PUB_PEM)
    }

    // Happy path: sign then verify returns correct sub and aud claims
    #[test]
    fn sign_verify_round_trip() {
        let km = km();
        let token = km.sign_ticket("worker-1", "auction-abc");
        let claims = km.verify_ticket(&token).expect("verify failed");
        assert_eq!(claims.sub, "worker-1");
        assert_eq!(claims.aud, "auction-abc");
    }

    // aud claim exactly matches the auction_id passed to sign_ticket
    #[test]
    fn aud_claim_matches_auction_id() {
        let km = km();
        let token = km.sign_ticket("w", "auction-xyz");
        let claims = km.verify_ticket(&token).unwrap();
        assert_eq!(claims.aud, "auction-xyz");
    }

    // A garbage token must be rejected
    #[test]
    fn invalid_token_rejected() {
        let km = km();
        assert!(km.verify_ticket("not.a.jwt").is_err());
    }

    // verify_ticket must fail when no public key is configured
    #[test]
    fn no_public_key_blocks_verify() {
        let km = KeyManager::from_pem(TEST_PRIV_PEM, "");
        let token = km.sign_ticket("w", "a");
        assert!(km.verify_ticket(&token).is_err());
    }

    // Token signed with one key must not verify against a different public key
    #[test]
    fn wrong_public_key_rejected() {
        let km_signer = km();
        let token = km_signer.sign_ticket("w", "a");

        // Use the first generated key as a mismatched public key
        let wrong_pub = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx1BOPjm16L+YS9jdHFDk
kqZAdSN/wfAwDVr+eNqoxMZVMN5yHxHbOJNQ/lipsxmf61HmqkW3B4ENLZIh7xMd
SeJcnGHPVhe7wBuCWhe8lMio2UuBBV0XecB4145LZ6rs+2HqkhS0UTptMy6utdNp
uJYoG9jseLTQg2Bxa2L04rneG5M+P2KSEKWxDR2wxnbwvfmNPFJL8gymSeoGpHVv
BjUhgwKLXfPSbhocieqVzMACUgYqVQ2ZuXa1XHWGOXpzfveK+vO1QzM5oJ2lBFZH
sPFLjKqjr99I+wHFRCG+jN86X3tiQEe5iL8K1wXAZelsPs0eeEPKPokOvNZF6TkE
JwIDAQAB
-----END PUBLIC KEY-----";
        let km_verifier = KeyManager::from_pem(TEST_PRIV_PEM, wrong_pub);
        assert!(km_verifier.verify_ticket(&token).is_err());
    }
}
