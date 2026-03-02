//! Thin persistence layer for in-flight auctions.
//!
//! On every state transition the orchestrator calls [`AuctionStore::persist`].
//! On every successful completion it calls [`AuctionStore::remove`].
//! On startup [`AuctionStore::load_all`] returns any auctions that survived a
//! crash so they can be re-queued immediately.

use crate::{AuctionCompletionStatus, AuctionMetadata};

pub struct AuctionStore {
    db: sled::Db,
}

impl AuctionStore {
    /// Open (or create) the sled database at `path`.
    pub fn open(path: &str) -> Result<Self, sled::Error> {
        std::fs::create_dir_all(path).ok();
        Ok(Self { db: sled::open(path)? })
    }

    /// Serialise `meta` to JSON and upsert it under `id`.
    pub fn persist(&self, id: &str, meta: &AuctionMetadata) {
        match serde_json::to_vec(meta) {
            Ok(bytes) => {
                if let Err(e) = self.db.insert(id, bytes).and_then(|_| self.db.flush().map(|_| ()))
                {
                    eprintln!("⚠️ AuctionStore: persist failed for {}: {}", id, e);
                }
            }
            Err(e) => eprintln!("⚠️ AuctionStore: serialise failed for {}: {}", id, e),
        }
    }

    /// Remove a completed auction from the store.
    pub fn remove(&self, id: &str) {
        if let Err(e) = self.db.remove(id).and_then(|_| self.db.flush().map(|_| ())) {
            eprintln!("⚠️ AuctionStore: remove failed for {}: {}", id, e);
        }
    }

    /// Return all non-completed auctions. Called once on startup.
    pub fn load_all(&self) -> Vec<(String, AuctionMetadata)> {
        self.db
            .iter()
            .filter_map(|r| r.ok())
            .filter_map(|(k, v)| {
                let id = String::from_utf8(k.to_vec()).ok()?;
                let meta: AuctionMetadata = serde_json::from_slice(&v).ok()?;
                Some((id, meta))
            })
            .filter(|(_, meta)| meta.status != AuctionCompletionStatus::Completed)
            .collect()
    }
}
